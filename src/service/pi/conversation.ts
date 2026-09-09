/**
 * The Pi conversation adapter.
 *
 * It turns the native conversation host into the `ConversationEngine` the
 * operation coordinator drives: one bounded prompt at a time, an outcome that
 * reports what the provider actually did, and a result that is referenced only
 * once its native bytes are durable.
 *
 * Three rules shape everything here.
 *
 * Bounded. A prompt is measured in UTF-8 bytes, and every request re-applies
 * BRN's output ceiling to the seated model, so a conversation reopened from its
 * own saved model cannot inherit a larger one.
 *
 * Honest. `session.prompt()` resolving is not success: the outcome is read back
 * off the assistant entry the SDK appended, so an errored, aborted or truncated
 * response stays distinguishable from a complete answer. Only text deltas leave
 * this module; hidden reasoning, provider payloads and compaction summaries do
 * not.
 *
 * Durable. A result is reported only after the host has made the conversation's
 * native bytes durable. A failure to do that is a persistence error, not a
 * provider success.
 *
 * The coordinator owns the deadline and the live-preview ceiling, so this module
 * holds no timer and no retry loop of its own. Pi's documented single
 * compact-and-retry recovery runs inside one prompt and therefore inside that
 * deadline.
 */

import { Buffer } from "node:buffer";
import type {
	AgentSession,
	AgentSessionEvent,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type {
	ConversationEngine,
	ConversationSnapshot,
	EngineEvent,
	ModelId,
	PromptCommand,
	RunResult,
	SessionInfo,
	Usage,
} from "../../core/conversation.ts";
import { BrnError, isBrnError } from "../../core/errors.ts";
import { logInfo } from "../log.ts";
import { MAX_RESPONSE_TOKENS, type PiHost } from "./runtime.ts";

/** The largest prompt BRN accepts, in UTF-8 bytes rather than characters. */
const MAX_PROMPT_BYTES = 16 * 1024;

/** A native assistant entry: the only kind of entry a result may reference. */
type AssistantEntry = {
	readonly id: string;
	readonly message: Extract<
		SessionMessageEntry["message"],
		{ role: "assistant" }
	>;
};

/**
 * The failure classes the engine seam can name in an outcome. Every other
 * refused prompt is raised as a `BrnError`, whose code the coordinator records
 * verbatim.
 */
type FailedCode = "PROVIDER_ERROR" | "NO_MODEL" | "AUTH_REQUIRED";

/**
 * One run in flight.
 *
 * `cancelled` is the operation-local latch. `cancel()` sets it synchronously,
 * before awaiting the native abort, and the run checks it after preflight and
 * immediately before dispatching, so cancellation during an awaited model
 * preflight can never be followed by a fresh provider request.
 */
type ActiveRun = {
	readonly session: AgentSession;
	readonly emit: (event: EngineEvent) => void;
	cancelled: boolean;
};

/** The conversation's cumulative token counters, as the SDK reports them. */
function totals(session: AgentSession): Usage {
	const tokens = session.getSessionStats().tokens;
	return {
		input: tokens.input,
		output: tokens.output,
		cacheRead: tokens.cacheRead,
		cacheWrite: tokens.cacheWrite,
		totalTokens: tokens.total,
	};
}

/**
 * What this run spent.
 *
 * The SDK reports conversation totals, so a run's own cost is the movement
 * across it. That includes an overflow recovery's summarization request, which
 * this operation genuinely paid for.
 */
function spent(before: Usage, after: Usage): Usage {
	return {
		input: Math.max(0, after.input - before.input),
		output: Math.max(0, after.output - before.output),
		cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
		cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
		totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
	};
}

/** The IDs of every entry the conversation already holds. */
function entryIdsOf(session: AgentSession): Set<string> {
	return new Set(session.sessionManager.getEntries().map((entry) => entry.id));
}

/**
 * The assistant entries this run added, in native order.
 *
 * Filtering against the IDs recorded at admission is what keeps a preceding
 * operation's last answer from being attributed to this one.
 */
function newAssistantEntries(
	session: AgentSession,
	before: ReadonlySet<string>,
): AssistantEntry[] {
	const added: AssistantEntry[] = [];
	for (const entry of session.sessionManager.getEntries()) {
		if (before.has(entry.id)) continue;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		added.push({ id: entry.id, message });
	}
	return added;
}

/** The visible text of an assistant entry. Hidden reasoning is not text. */
function visibleText(entry: AssistantEntry): string {
	return entry.message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

class PiConversation implements ConversationEngine {
	private readonly host: PiHost;
	private active: ActiveRun | undefined;

	constructor(host: PiHost) {
		this.host = host;
	}

	snapshot(): ConversationSnapshot {
		return this.host.snapshot();
	}

	async models(): Promise<ModelId[]> {
		return await this.host.models();
	}

	async sessions(): Promise<SessionInfo[]> {
		return await this.host.sessions();
	}

	async create(model: ModelId): Promise<SessionInfo> {
		return await this.host.create(model);
	}

	async resume(sessionId: string): Promise<SessionInfo> {
		return await this.host.resume(sessionId);
	}

	async selectModel(model: ModelId): Promise<void> {
		await this.host.selectModel(model);
	}

	async run(
		command: PromptCommand,
		emit: (event: EngineEvent) => void,
	): Promise<RunResult> {
		const session = this.requireSession(command);
		const run: ActiveRun = { session, emit, cancelled: false };
		this.active = run;
		const baseline = entryIdsOf(session);
		const before = totals(session);
		const unsubscribe = this.host.subscribe((event) =>
			this.translate(run, event),
		);
		try {
			const refused = await this.preflight(command, session);
			if (refused !== undefined) {
				// Nothing was dispatched, so no native entry belongs to this operation.
				return { kind: "failed", code: refused, entryIds: [] };
			}
			if (run.cancelled) {
				await this.sync();
				return { kind: "cancelled", entryIds: [] };
			}
			emit({ type: "status", status: "working" });
			try {
				await session.prompt(command.text, { expandPromptTemplates: false });
			} catch (error) {
				// A refusal from inside the SDK carries provider text BRN never
				// publishes. The outcome is read off native state below, which reports
				// a failure rather than an answer when nothing was appended.
				if (isBrnError(error)) throw error;
			}
			// `agent_end` can still retry. The prompt call above resolves only once the
			// turn has settled, and this waits out any continuation behind it.
			await session.waitForIdle();
			await this.sync();
			return this.outcome(run, baseline, before);
		} finally {
			unsubscribe();
			if (this.active === run) this.active = undefined;
		}
	}

	async cancel(): Promise<void> {
		const run = this.active;
		if (run === undefined) return;
		// Synchronous, before any await: a cancellation that arrives while preflight
		// is still running must be visible to the check that guards dispatch.
		run.cancelled = true;
		run.emit({ type: "status", status: "cancelling" });
		await run.session.abort();
	}

	/**
	 * The text of the entries an outcome referenced.
	 *
	 * The native manager's typed entries are the only source: no session file is
	 * opened or parsed here. A referenced entry that is absent is reported, never
	 * answered with empty text.
	 */
	async readResult(sessionId: string, entryIds: string[]): Promise<string> {
		const session = this.host.current();
		if (session.sessionId !== sessionId) {
			throw new BrnError("SESSION_MISMATCH");
		}
		const entries = new Map(
			session.sessionManager.getEntries().map((entry) => [entry.id, entry]),
		);
		const parts: string[] = [];
		for (const entryId of entryIds) {
			const entry = entries.get(entryId);
			if (
				entry === undefined ||
				entry.type !== "message" ||
				entry.message.role !== "assistant"
			) {
				throw new BrnError("RESULT_UNAVAILABLE");
			}
			parts.push(visibleText({ id: entry.id, message: entry.message }));
		}
		return parts.join("");
	}

	/**
	 * Stops driving the conversation.
	 *
	 * A run still in flight is asked to stop and waited out, so no provider
	 * response is still arriving when the host is disposed. The host itself is
	 * closed by whoever opened it.
	 */
	async close(): Promise<void> {
		await this.cancel();
	}

	/** The hosted conversation, proven to be the one the command names. */
	private requireSession(command: PromptCommand): AgentSession {
		const session = this.host.current();
		if (session.sessionId !== command.sessionId) {
			throw new BrnError("SESSION_MISMATCH");
		}
		const seated = session.model;
		if (
			seated !== undefined &&
			(seated.provider !== command.model.provider ||
				seated.id !== command.model.id)
		) {
			throw new BrnError("MODEL_MISMATCH");
		}
		return session;
	}

	/**
	 * Bounds the input and re-applies BRN's output ceiling to the seated model.
	 *
	 * Returns the failure class of a refusal the outcome can name, and raises
	 * everything else as a `BrnError`. The model is capped on every prompt rather
	 * than once at seating, because a replacement seats whatever the conversation
	 * saved.
	 */
	private async preflight(
		command: PromptCommand,
		session: AgentSession,
	): Promise<FailedCode | undefined> {
		const bytes = Buffer.byteLength(command.text, "utf8");
		if (bytes === 0 || command.text.trim().length === 0) {
			throw new BrnError("EMPTY_PROMPT");
		}
		if (bytes > MAX_PROMPT_BYTES) throw new BrnError("INPUT_TOO_LARGE");
		const selected = session.model;
		if (!selected) return "NO_MODEL";
		try {
			await session.setModel(
				{
					...selected,
					maxTokens: Math.min(selected.maxTokens, MAX_RESPONSE_TOKENS),
				},
				{ persist: false },
			);
		} catch (error) {
			if (isBrnError(error)) throw error;
			// The SDK validates the provider's credentials here and refuses without
			// touching the conversation. Its message names the provider and is not
			// republished.
			return "AUTH_REQUIRED";
		}
		return undefined;
	}

	/**
	 * Makes the conversation's native bytes durable.
	 *
	 * Until this succeeds BRN has no evidence a result survives a restart, so a
	 * failure is a persistence error under a fixed code rather than a provider
	 * outcome. Native Pi writes alone are not that evidence.
	 */
	private async sync(): Promise<void> {
		try {
			await this.host.syncCurrentSession();
		} catch (error) {
			if (isBrnError(error)) throw error;
			throw new BrnError("STATE_UNAVAILABLE", "session_sync");
		}
	}

	/**
	 * Classifies the run from the last assistant entry it added.
	 *
	 * Only that entry is referenced: an overflow recovery's failed attempt stays
	 * inspectable in Pi's native history instead of being concatenated into the
	 * answer that replaced it.
	 */
	private outcome(
		run: ActiveRun,
		baseline: ReadonlySet<string>,
		before: Usage,
	): RunResult {
		const added = newAssistantEntries(run.session, baseline);
		const last = added.at(-1);
		if (last === undefined) {
			// The provider produced nothing at all. A cancellation that landed before
			// the first message is a cancellation; anything else is a failure.
			return run.cancelled
				? { kind: "cancelled", entryIds: [] }
				: { kind: "failed", code: "PROVIDER_ERROR", entryIds: [] };
		}
		const entryIds = [last.id];
		switch (last.message.stopReason) {
			case "stop":
				return {
					kind: "completed",
					entryIds,
					truncated: false,
					usage: spent(before, totals(run.session)),
				};
			case "length":
				// A response the model was cut off in is complete enough to keep and
				// never a complete answer.
				return {
					kind: "completed",
					entryIds,
					truncated: true,
					usage: spent(before, totals(run.session)),
				};
			case "aborted":
				return { kind: "cancelled", entryIds };
			default:
				// `error`, and the states BRN never asks for: a tool call it registered
				// no tools for, a pending response, a deferred handle it did not
				// request. None of them is an answer.
				return { kind: "failed", code: "PROVIDER_ERROR", entryIds };
		}
	}

	/**
	 * Republishes the native events an operation may show.
	 *
	 * Text deltas only: thinking deltas, raw provider payloads, auth objects and
	 * compaction summaries stop here.
	 */
	private translate(run: ActiveRun, event: AgentSessionEvent): void {
		if (this.active !== run) return;
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					run.emit({ type: "text", text: event.assistantMessageEvent.delta });
				}
				return;
			case "agent_start":
				run.emit({ type: "status", status: "working" });
				return;
			case "compaction_start":
				// Automatic compaction is shown as itself, so a long pause has a reason.
				run.emit({ type: "status", status: "compacting" });
				return;
			case "compaction_end":
				if (event.errorMessage !== undefined || event.aborted) {
					// The reason is a fixed value from the SDK's own vocabulary. The
					// message it came with is not recorded anywhere.
					logInfo("engine.compaction_incomplete", {
						reason: event.reason,
						aborted: event.aborted,
					});
				}
				run.emit({
					type: "status",
					status: run.cancelled ? "cancelling" : "working",
				});
				run.emit({ type: "context", context: this.host.snapshot().context });
				return;
			case "message_end":
				run.emit({ type: "context", context: this.host.snapshot().context });
				return;
			default:
				return;
		}
	}
}

/** Creates the conversation engine over a hosted native Pi conversation. */
export function createPiConversation(host: PiHost): ConversationEngine {
	return new PiConversation(host);
}
