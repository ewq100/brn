/**
 * BRN's isolated native conversation host.
 *
 * One process hosts at most one Pi conversation. This module owns the shared
 * model runtime, the controlled resource loader and the native session
 * lifecycle, all through the SDK's public interfaces: conversations are created,
 * resumed and replaced by `createAgentSessionRuntime`, `SessionManager` and
 * `AgentSessionRuntime.switchSession`, never by reading or writing session files
 * behind the SDK's back.
 *
 * Pi types stop here. Everything the rest of BRN sees is a `ModelId`,
 * a `SessionInfo` or a `ConversationSnapshot`.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSession,
	createAgentSessionRuntime,
	getAgentDir,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ContextUsage,
	ConversationSnapshot,
	ModelId,
	SessionInfo,
	Usage,
} from "../../core/conversation.ts";
import { BrnError } from "../../core/errors.ts";
import { errnoOf } from "../../core/fs.ts";
import { syncDirectory } from "../fs.ts";
import type { SessionMetadataStore } from "../operation-store.ts";
import { prepareStateDirectory } from "../ownership.ts";
import { createControlledResourceLoader } from "./resources.ts";

/** Model-catalog work is bounded: an unreachable provider must not hang a control. */
const CATALOG_TIMEOUT_MS = 15_000;

/** No BRN conversation asks a provider for more than this in one response. */
export const MAX_RESPONSE_TOKENS = 4096;

/** Compaction stays on, with the reserve BRN's conversations are sized for. */
const COMPACTION = {
	enabled: true,
	reserveTokens: 5120,
	keepRecentTokens: 8192,
} as const;

/**
 * Retries are off. BRN owns one operation at a time and reports a provider
 * failure to the client, rather than silently spending a second attempt on it.
 */
const RETRY = {
	enabled: false,
	maxRetries: 0,
	provider: { maxRetries: 0 },
} as const;

/** Every counter of a conversation that has not spent a token yet. */
function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/** The provider-qualified identity of a Pi model, or nothing if none is selected. */
function modelIdentity(model: Model<Api> | undefined): ModelId | null {
	return model === undefined
		? null
		: { provider: model.provider, id: model.id };
}

/**
 * The native conversation host.
 *
 * `current()` is service-local on purpose: an `AgentSession` must never travel
 * out through the `ConversationEngine` seam.
 */
export interface PiHost {
	snapshot(): ConversationSnapshot;
	models(): Promise<ModelId[]>;
	sessions(): Promise<SessionInfo[]>;
	create(model: ModelId): Promise<SessionInfo>;
	resume(sessionId: string): Promise<SessionInfo>;
	selectModel(model: ModelId): Promise<void>;
	current(): AgentSession;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	/** Makes the current conversation's native bytes durable and records that. */
	syncCurrentSession(): Promise<void>;
	close(): Promise<void>;
}

export interface PiHostOptions {
	/** The already-guarded state root this process owns. */
	readonly root: string;
	readonly store: SessionMetadataStore;
	/**
	 * Constructor-only injection, so the real-SDK tests can drive a faux provider.
	 * It is not an HTTP parameter and not a production environment switch.
	 */
	readonly modelRuntime?: ModelRuntime;
}

/**
 * Opens the host.
 *
 * This constructs the shared facilities only: the model runtime, the in-memory
 * settings and the controlled loader. No conversation exists and no model is
 * chosen until an explicit `create` or `resume`, so starting the service never
 * contacts a provider.
 */
export async function openPiRuntime(options: PiHostOptions): Promise<PiHost> {
	const workDir = await prepareStateDirectory(join(options.root, "work"));
	const sessionsDir = await prepareStateDirectory(
		join(options.root, "sessions"),
	);
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			// Pi's own credential implementation reads its own file. BRN never opens,
			// copies, serialises or logs it.
			authPath: join(getAgentDir(), "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		}));
	const settingsManager = SettingsManager.inMemory({
		compaction: { ...COMPACTION },
		retry: { ...RETRY, provider: { ...RETRY.provider } },
	});
	return new Host({
		root: options.root,
		workDir,
		sessionsDir,
		store: options.store,
		modelRuntime,
		settingsManager,
		resourceLoader: createControlledResourceLoader(),
	});
}

class Host implements PiHost {
	private readonly root: string;
	private readonly workDir: string;
	private readonly sessionsDir: string;
	private readonly store: SessionMetadataStore;
	private readonly modelRuntime: ModelRuntime;
	private readonly settingsManager: SettingsManager;
	private readonly resourceLoader: ResourceLoader;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

	/** The hosted conversation, or nothing: a torn-down one is never held here. */
	private runtime: AgentSessionRuntime | undefined;
	/** The live subscription. Exactly one binding owns the current conversation. */
	private unsubscribe: (() => void) | undefined;
	/** Set when a replacement failed, so the fixed error names the reason. */
	private replacementFailed = false;
	/**
	 * The identity the factory last resolved, so a construction can be checked
	 * against what it asked the SDK to seat rather than against a hope.
	 */
	private resolvedIdentity: ModelId | undefined;
	private closed = false;

	constructor(parts: {
		root: string;
		workDir: string;
		sessionsDir: string;
		store: SessionMetadataStore;
		modelRuntime: ModelRuntime;
		settingsManager: SettingsManager;
		resourceLoader: ResourceLoader;
	}) {
		this.root = parts.root;
		this.workDir = parts.workDir;
		this.sessionsDir = parts.sessionsDir;
		this.store = parts.store;
		this.modelRuntime = parts.modelRuntime;
		this.settingsManager = parts.settingsManager;
		this.resourceLoader = parts.resourceLoader;
	}

	snapshot(): ConversationSnapshot {
		const session = this.runtime?.session;
		if (session === undefined) {
			return { session: null, context: null, usage: zeroUsage() };
		}
		const tokens = session.getSessionStats().tokens;
		return {
			session: { id: session.sessionId, model: modelIdentity(session.model) },
			context: this.contextOf(session),
			usage: {
				input: tokens.input,
				output: tokens.output,
				cacheRead: tokens.cacheRead,
				cacheWrite: tokens.cacheWrite,
				totalTokens: tokens.total,
			},
		};
	}

	async models(): Promise<ModelId[]> {
		return (await this.available()).map((model) => ({
			provider: model.provider,
			id: model.id,
		}));
	}

	/**
	 * The native sessions this state root holds.
	 *
	 * An empty, unmaterialized conversation has no native bytes yet and therefore
	 * does not appear here; it is recreated from its metadata by `resume`.
	 */
	async sessions(): Promise<SessionInfo[]> {
		const listed = await SessionManager.list(this.workDir, this.sessionsDir);
		return listed.map((session) => ({
			id: session.id,
			model: this.store.sessionMetadata(session.id)?.model ?? null,
		}));
	}

	async create(requested: ModelId): Promise<SessionInfo> {
		this.requireOpen();
		// The model is proven available before an empty session is recorded, so a
		// conversation is never left pointing at a model BRN cannot run.
		await this.requireAvailable(requested);
		const manager = SessionManager.create(this.workDir, this.sessionsDir);
		const id = manager.getSessionId();
		this.store.rememberSession(id, requested, false);
		await this.replaceRuntime(manager);
		// The identity BRN records and returns is the one the conversation is
		// actually running, read back off the session, not the one asked for.
		const seated = this.seatedIdentity();
		this.store.rememberSession(id, seated, false);
		this.store.setActiveSession(id);
		this.store.setDefaultModel(seated);
		return { id, model: seated };
	}

	async resume(sessionId: string): Promise<SessionInfo> {
		this.requireOpen();
		const listed = await SessionManager.list(this.workDir, this.sessionsDir);
		const matches = listed.filter((session) => session.id === sessionId);
		// Two files claiming one identity is a conflict to report, not a choice to
		// make on the caller's behalf.
		if (matches.length > 1) throw new BrnError("SESSION_CONFLICT");
		const native = matches[0];
		const materialized = native !== undefined;
		if (native === undefined) {
			this.requireRecreatable(sessionId);
			await this.replaceRuntime(
				SessionManager.create(this.workDir, this.sessionsDir, {
					id: sessionId,
				}),
			);
		} else {
			await this.openNative(sessionId, this.requireInsideSessions(native.path));
		}
		const session = this.current();
		const model = modelIdentity(session.model);
		if (model !== null) {
			this.store.rememberSession(sessionId, model, materialized);
			this.store.setDefaultModel(model);
		}
		this.store.setActiveSession(sessionId);
		return { id: sessionId, model };
	}

	async selectModel(model: ModelId): Promise<void> {
		this.requireOpen();
		const session = this.current();
		const resolved = await this.requireAvailable(model);
		// Pi records the change in the conversation and refuses an unauthenticated
		// provider. A refusal leaves the conversation exactly as it was.
		await session.setModel(resolved);
		const metadata = this.store.sessionMetadata(session.sessionId);
		this.store.rememberSession(
			session.sessionId,
			model,
			metadata?.materialized ?? false,
		);
		// A materialized conversation's new bytes are durable before the change is
		// acknowledged; an empty one is represented by the metadata just written.
		await this.syncCurrentSession();
		this.store.setDefaultModel(model);
	}

	current(): AgentSession {
		const runtime = this.runtime;
		if (runtime === undefined) {
			throw new BrnError(
				"NO_ACTIVE_SESSION",
				this.closed
					? "closed"
					: this.replacementFailed
						? "replacement_failed"
						: "no_conversation",
			);
		}
		return runtime.session;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async syncCurrentSession(): Promise<void> {
		const session = this.current();
		const file = session.sessionFile;
		if (file === undefined) return;
		const handle = await open(
			file,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		).catch((error: unknown) => {
			// Pi assigns a path before it writes anything. No file means the
			// conversation is genuinely empty, and its metadata still represents it.
			if (errnoOf(error) === "ENOENT") return undefined;
			throw error;
		});
		if (handle === undefined) return;
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncDirectory(this.sessionsDir);
		const model =
			this.store.sessionMetadata(session.sessionId)?.model ??
			modelIdentity(session.model);
		if (model !== null) {
			this.store.rememberSession(session.sessionId, model, true);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.listeners.clear();
		const runtime = this.runtime;
		this.discard();
		if (runtime === undefined) return;
		// The turn is settled before disposal, so an aborted response is persisted.
		await runtime.session.abort();
		await runtime.dispose();
	}

	/**
	 * Rebinds the one subscription that owns the current conversation.
	 *
	 * Installed on the runtime as well as called directly, so an SDK-driven
	 * replacement rebinds too. Each binding captures its own session: an event
	 * from a session that is no longer current is discarded, because that
	 * subscription no longer owns the conversation an operation is watching.
	 */
	private readonly rebind = async (session: AgentSession): Promise<void> => {
		this.unsubscribe?.();
		await session.bindExtensions({});
		this.unsubscribe = session.subscribe((event) => {
			if (session !== this.runtime?.session) return;
			this.forwardPiEvent(event);
		});
	};

	/**
	 * The controlled runtime factory.
	 *
	 * It resolves the model afresh for every conversation it builds, rather than
	 * capturing the preceding one's, and registers no tools at all.
	 */
	private readonly factory: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const model = await this.resolveExactModel(sessionManager);
		this.resolvedIdentity = { provider: model.provider, id: model.id };
		const result = await createAgentSession({
			cwd,
			agentDir,
			sessionManager,
			...(sessionStartEvent ? { sessionStartEvent } : {}),
			model,
			modelRuntime: this.modelRuntime,
			settingsManager: this.settingsManager,
			resourceLoader: this.resourceLoader,
			tools: [],
			noTools: "all",
		});
		return {
			...result,
			services: {
				cwd,
				agentDir,
				modelRuntime: this.modelRuntime,
				settingsManager: this.settingsManager,
				resourceLoader: this.resourceLoader,
				diagnostics: [],
			},
			diagnostics: [],
		};
	};

	/**
	 * The exact model a conversation asks for: the one saved in the session, else
	 * the one recorded for it. An unavailable model is a visible failure, never
	 * permission to choose a different provider.
	 */
	private async resolveExactModel(
		manager: SessionManager,
	): Promise<Model<Api>> {
		const saved = manager.buildSessionContext().model;
		const metadata = this.store.sessionMetadata(manager.getSessionId());
		const identity = saved
			? { provider: saved.provider, id: saved.modelId }
			: metadata?.model;
		if (identity === undefined) throw new BrnError("NO_MODEL");
		return await this.requireAvailable(identity);
	}

	private async available(): Promise<readonly Model<Api>[]> {
		return await this.modelRuntime.getAvailable(undefined, {
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
	}

	private async requireAvailable(identity: ModelId): Promise<Model<Api>> {
		const selected = (await this.available()).find(
			(model) =>
				model.provider === identity.provider && model.id === identity.id,
		);
		if (selected === undefined) throw new BrnError("MODEL_UNAVAILABLE");
		return {
			...selected,
			maxTokens: Math.min(selected.maxTokens, MAX_RESPONSE_TOKENS),
		};
	}

	/**
	 * Proves a session with no native bytes may be recreated empty.
	 *
	 * A session BRN recorded as materialized but cannot find is unavailable: it is
	 * never quietly replaced with an empty conversation.
	 */
	private requireRecreatable(sessionId: string): void {
		const metadata = this.store.sessionMetadata(sessionId);
		if (metadata === null) {
			throw new BrnError("SESSION_UNAVAILABLE", "unknown_session");
		}
		if (metadata.materialized) {
			throw new BrnError("SESSION_UNAVAILABLE", "missing_file");
		}
	}

	/** Opens a listed native session, either as the first or as a replacement. */
	private async openNative(sessionId: string, path: string): Promise<void> {
		const runtime = this.runtime;
		if (runtime === undefined) {
			const manager = SessionManager.open(path, this.sessionsDir, this.workDir);
			// A reset or fallback to some other session is not a successful resume.
			if (manager.getSessionId() !== sessionId) {
				throw new BrnError("SESSION_UNAVAILABLE", "identity");
			}
			await this.replaceRuntime(manager);
			return;
		}
		try {
			this.resolvedIdentity = undefined;
			const { cancelled } = await runtime.switchSession(path);
			if (cancelled) throw new BrnError("SESSION_UNAVAILABLE", "cancelled");
		} catch (error) {
			// The outgoing conversation is already torn down, so stop advertising it.
			this.discard();
			this.replacementFailed = true;
			throw error;
		}
		if (runtime.session.sessionId !== sessionId) {
			await this.settle();
			this.replacementFailed = true;
			throw new BrnError("SESSION_UNAVAILABLE", "identity");
		}
		// `switchSession` is factory construction too: the same seating gate applies.
		await this.requireExactSeating(runtime);
	}

	/**
	 * Replaces the hosted conversation with one built from `manager`.
	 *
	 * Used for a new conversation and for an unmaterialized one, neither of which
	 * has a native path `switchSession` could be given. The outgoing conversation
	 * settles and is disposed first, and a failure leaves no conversation active.
	 */
	private async replaceRuntime(manager: SessionManager): Promise<void> {
		await this.settle();
		try {
			this.resolvedIdentity = undefined;
			const next = await createAgentSessionRuntime(this.factory, {
				cwd: this.workDir,
				agentDir: this.root,
				sessionManager: manager,
			});
			this.runtime = next;
			await this.requireExactSeating(next);
			next.setRebindSession(this.rebind);
			await this.rebind(next.session);
			this.replacementFailed = false;
		} catch (error) {
			this.discard();
			this.replacementFailed = true;
			throw error;
		}
	}

	/**
	 * The last gate on "never silently fall back".
	 *
	 * `requireAvailable` proves the model exists before construction; this proves
	 * the conversation the SDK handed back is running that exact model. The SDK
	 * reports its own substitution through `modelFallbackMessage`, so a non-empty
	 * one is a refusal even when the identities happen to agree. A refused seating
	 * is torn down through the same settle-and-dispose path every other failure
	 * uses, so no disposed `AgentSession` is left advertised as active.
	 */
	private async requireExactSeating(next: AgentSessionRuntime): Promise<void> {
		const expected = this.resolvedIdentity;
		const seated = modelIdentity(next.session.model);
		const fallback = next.modelFallbackMessage;
		const reason =
			fallback !== undefined && fallback.length > 0
				? "model_fallback"
				: expected === undefined
					? "unresolved_model"
					: seated === null ||
							seated.provider !== expected.provider ||
							seated.id !== expected.id
						? "model_identity"
						: undefined;
		if (reason === undefined) return;
		await this.settle();
		this.replacementFailed = true;
		throw new BrnError("MODEL_UNAVAILABLE", reason);
	}

	/** The identity the hosted conversation is actually running. */
	private seatedIdentity(): ModelId {
		const seated = modelIdentity(this.current().model);
		if (seated === null) throw new BrnError("MODEL_UNAVAILABLE", "unseated");
		return seated;
	}

	/** Settles and disposes the hosted conversation, if there is one. */
	private async settle(): Promise<void> {
		const runtime = this.runtime;
		this.discard();
		if (runtime === undefined) return;
		await runtime.session.abort();
		await runtime.dispose();
	}

	/** Stops advertising a conversation and drops its subscription. */
	private discard(): void {
		this.runtime = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private forwardPiEvent(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	private contextOf(session: AgentSession): ContextUsage {
		const context = session.getContextUsage();
		// The SDK reporting nothing stays nothing: an unknown context must not
		// become a comfortable zero percent.
		if (context === undefined) return null;
		return {
			tokens: context.tokens,
			contextWindow: context.contextWindow,
			percent: context.percent,
		};
	}

	/** Caller values are session IDs; the path behind one must stay inside the root. */
	private requireInsideSessions(path: string): string {
		const resolved = resolve(path);
		if (!resolved.startsWith(`${this.sessionsDir}${sep}`)) {
			throw new BrnError("SESSION_UNAVAILABLE", "outside_sessions_root");
		}
		return resolved;
	}

	private requireOpen(): void {
		if (this.closed) throw new BrnError("SERVICE_STOPPING");
	}
}
