// A deterministic `ConversationEngine` for coordinator tests.
//
// It never opens a socket, a provider connection or a session file: a run settles
// only when the test says so, which is what makes the admission, cancellation and
// shutdown races in `test/operations.test.ts` reproducible rather than timing
// dependent. Recorded answers live in a native-result map, standing in for Pi's
// durable session entries.
//
// This module is test support. It is never imported from the production entry
// point; `test/support/service-child.ts` is the only composition entry that may
// substitute a fake for the real adapter.
import type {
	ContextUsage,
	ConversationEngine,
	ConversationSnapshot,
	EngineEvent,
	ModelId,
	PromptCommand,
	RunResult,
	SessionInfo,
	Usage,
} from "../../src/core/conversation.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
};

/** The conversation the engine is seated in before a test changes it. */
export const FAKE_SESSION_ID = "session-1";
export const FAKE_MODEL: ModelId = { provider: "test", id: "offline" };

/** The reasons a run may report as a failed outcome. */
export type FailedCode = Extract<RunResult, { kind: "failed" }>["code"];

interface PendingRun {
	readonly emit: (event: EngineEvent) => void;
	readonly settle: (result: RunResult) => void;
	readonly reject: (failure: unknown) => void;
}

/** A settled run's handles, so a test can deliver a late signal for finished work. */
export type RunHandles = PendingRun;

export class FakeEngine implements ConversationEngine {
	/** Every command `run` has been asked to execute, in order. */
	readonly calls: PromptCommand[] = [];
	/** When false, `cancel()` leaves the run pending, as an uncooperative provider would. */
	abortSettles = true;
	/** How many times the coordinator asked for cancellation. */
	cancelCount = 0;
	/** When set, the next `run` refuses synchronously instead of returning a promise. */
	runThrows: unknown = null;
	closed = false;

	private session: SessionInfo | null = {
		id: FAKE_SESSION_ID,
		model: { ...FAKE_MODEL },
	};
	private context: ContextUsage = null;
	private readonly available: ModelId[] = [{ ...FAKE_MODEL }];
	private readonly results = new Map<string, string>();
	private pending: PendingRun | null = null;
	/**
	 * The most recent run's handles, kept after that run settles. `pending` is
	 * cleared on settlement — that is what makes the cancellation races
	 * deterministic — so this is the only way a test can deliver a late signal for
	 * an operation the coordinator has already finished.
	 */
	private latest: PendingRun | null = null;
	private entryIds: string[] = [];
	private sessionCounter = 1;
	private entryCounter = 0;

	snapshot(): ConversationSnapshot {
		return { session: this.session, context: this.context, usage: ZERO_USAGE };
	}

	async models(): Promise<ModelId[]> {
		return [...this.available];
	}

	async sessions(): Promise<SessionInfo[]> {
		return this.session === null ? [] : [this.session];
	}

	async create(model: ModelId): Promise<SessionInfo> {
		this.sessionCounter += 1;
		this.session = { id: `session-${this.sessionCounter}`, model };
		return this.session;
	}

	async resume(sessionId: string): Promise<SessionInfo> {
		this.session = { id: sessionId, model: this.session?.model ?? null };
		return this.session;
	}

	async selectModel(model: ModelId): Promise<void> {
		this.session =
			this.session === null ? null : { id: this.session.id, model };
	}

	/** Drops the current session, as a host with no conversation yet would report. */
	forget(): void {
		this.session = null;
	}

	run(
		command: PromptCommand,
		emit: (event: EngineEvent) => void,
	): Promise<RunResult> {
		if (this.pending !== null)
			throw new Error("fake engine is already running");
		// A real adapter validates before it records anything, so a refusal raised
		// this way never becomes a recorded call.
		if (this.runThrows !== null) {
			const failure = this.runThrows;
			this.runThrows = null;
			throw failure;
		}
		this.calls.push(command);
		this.entryIds = [];
		return new Promise<RunResult>((resolve, reject) => {
			this.pending = { emit, settle: resolve, reject };
			this.latest = this.pending;
		});
	}

	async cancel(): Promise<void> {
		this.cancelCount += 1;
		if (!this.abortSettles) return;
		const pending = this.pending;
		if (pending === null) return;
		this.pending = null;
		pending.settle({ kind: "cancelled", entryIds: [...this.entryIds] });
	}

	async readResult(sessionId: string, entryIds: string[]): Promise<string> {
		if (this.session?.id !== sessionId) throw new Error("unknown session");
		return entryIds
			.map((entryId) => {
				const text = this.results.get(entryId);
				if (text === undefined) throw new Error("unknown entry");
				return text;
			})
			.join("");
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	/** Streams text to the coordinator without recording a durable entry. */
	emitText(text: string): void {
		this.require().emit({ type: "text", text });
	}

	/** Streams any other engine event. */
	emitEvent(event: EngineEvent): void {
		this.require().emit(event);
	}

	/** Records a durable entry that a later outcome will reference. */
	record(text: string): string {
		this.entryCounter += 1;
		const entryId = `entry-${this.entryCounter}`;
		this.results.set(entryId, text);
		this.entryIds.push(entryId);
		return entryId;
	}

	/**
	 * Completes the run with a durable answer. A call with nothing pending is
	 * ignored, so a test can prove a late completion signal changes nothing.
	 */
	complete(text: string): void {
		const pending = this.pending;
		if (pending === null) return;
		this.record(text);
		this.pending = null;
		pending.settle({
			kind: "completed",
			entryIds: [...this.entryIds],
			truncated: false,
			usage: ZERO_USAGE,
		});
	}

	/** Fails the run, keeping any partial entry durable. */
	fail(partialText?: string, code: FailedCode = "PROVIDER_ERROR"): void {
		const pending = this.pending;
		if (pending === null) return;
		if (partialText !== undefined) this.record(partialText);
		this.pending = null;
		pending.settle({
			kind: "failed",
			code,
			entryIds: [...this.entryIds],
		});
	}

	/** Rejects the run, as an engine raising an exception would. */
	throwFrom(failure: unknown): void {
		const pending = this.pending;
		if (pending === null) return;
		this.pending = null;
		pending.reject(failure);
	}

	get running(): boolean {
		return this.pending !== null;
	}

	/**
	 * The handles of the most recent run, valid after it settled. A test uses these
	 * to replay a completion or a stream event for finished work, which a
	 * well-behaved adapter never does.
	 */
	handles(): RunHandles {
		const run = this.latest;
		if (run === null) throw new Error("fake engine has never run");
		return run;
	}

	private require(): PendingRun {
		const pending = this.pending;
		if (pending === null) throw new Error("fake engine is not running");
		return pending;
	}
}
