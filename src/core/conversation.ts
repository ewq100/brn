/**
 * The conversation seam.
 *
 * These are the only types shared between the operation coordinator, the
 * conversation engine that talks to a provider, and the authoritative operation
 * ledger. The module is deliberately free of Node, Pi, transport and storage
 * imports: the deterministic test engine and the real Pi adapter implement the
 * same `ConversationEngine`, and the SQLite ledger implements `OperationStore`
 * without the coordinator learning that SQLite exists.
 */

/** A provider-qualified model selection. */
export type ModelId = { provider: string; id: string };

/** Token accounting for a conversation. Every counter starts at zero. */
export type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

/**
 * Context consumption, where an unknown token count stays `null` rather than
 * being guessed as a comfortable zero percent.
 */
export type ContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
} | null;

export type SessionInfo = { id: string; model: ModelId | null };

/** One prompt submission, identified by a client-chosen request ID. */
export type PromptCommand = {
	requestId: string;
	sessionId: string;
	model: ModelId;
	text: string;
};

/**
 * The outcome of one engine run.
 *
 * `entryIds` names the native conversation entries the engine made durable, so a
 * partial answer survives a cancellation or a provider failure. A completed but
 * truncated response stays distinguishable from a complete one.
 */
export type RunResult =
	| { kind: "completed"; entryIds: string[]; truncated: boolean; usage: Usage }
	| { kind: "cancelled"; entryIds: string[] }
	| {
			kind: "failed";
			code: "PROVIDER_ERROR" | "NO_MODEL" | "AUTH_REQUIRED";
			entryIds: string[];
	  };

export type EngineEvent =
	| { type: "text"; text: string }
	| { type: "status"; status: "working" | "compacting" | "cancelling" }
	| { type: "context"; context: ContextUsage };

export type ConversationSnapshot = {
	session: SessionInfo | null;
	context: ContextUsage;
	usage: Usage;
};

/** The conversation host the coordinator drives. One run may be in flight. */
export interface ConversationEngine {
	snapshot(): ConversationSnapshot;
	models(): Promise<ModelId[]>;
	sessions(): Promise<SessionInfo[]>;
	create(model: ModelId): Promise<SessionInfo>;
	resume(sessionId: string): Promise<SessionInfo>;
	selectModel(model: ModelId): Promise<void>;
	run(
		command: PromptCommand,
		emit: (event: EngineEvent) => void,
	): Promise<RunResult>;
	cancel(): Promise<void>;
	/** Resolves only entry IDs recorded for this operation's session. */
	readResult(sessionId: string, entryIds: string[]): Promise<string>;
	close(): Promise<void>;
}

/**
 * `accepted`, `running` and `cancelling` are the unfinished states: at most one
 * operation may hold one of them at a time, and a restart converts any survivor
 * to `interrupted` rather than replaying it.
 */
export type OperationState =
	| "accepted"
	| "running"
	| "cancelling"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

/**
 * The durable record of one operation.
 *
 * `requestHash` is a digest of the submitted payload, never the prompt text.
 * `failureCode` carries a wider vocabulary than `RunResult.failed.code`: the
 * result names the coarse class the engine reported, while `failureCode` names
 * the precise reason BRN recorded, such as `DEADLINE_EXCEEDED`.
 */
export type Operation = {
	id: string;
	sessionId: string;
	requestHash: string;
	state: OperationState;
	result: RunResult | null;
	failureCode: string | null;
};

/** The authoritative ledger. Every method is synchronous and committed. */
export interface OperationStore {
	find(id: string): Operation | null;
	insert(command: PromptCommand, requestHash: string): Operation;
	transition(id: string, from: OperationState[], to: OperationState): Operation;
	finish(id: string, result: RunResult, failureCode?: string): Operation;
	/** Marks every unfinished operation `interrupted`. The caller owns the process lock. */
	interruptUnfinished(): number;
	latest(): Operation | null;
	close(): void;
}

/** A coherent synchronous view of the coordinator, safe to publish as a snapshot. */
export type OperationView = {
	operation: Operation | null;
	liveText: string;
	accepting: boolean;
	controlling: boolean;
	/**
	 * The latest status the engine reported for the operation now occupying the
	 * service, or `null` when none is occupied or none was reported.
	 *
	 * It is the engine's own word about what it is doing, retained so a client can
	 * tell a run that is producing an answer from one that is compacting its
	 * history and producing nothing. It is cleared when the operation settles: a
	 * stale status is worse than none.
	 */
	engineStatus: "working" | "compacting" | "cancelling" | null;
};

export interface Operations {
	submit(command: PromptCommand, requestHash: string): Operation;
	cancel(id: string): Promise<Operation>;
	control<T>(action: () => Promise<T>): Promise<T>;
	view(): OperationView;
	waitForIdle(): Promise<void>;
	stop(): Promise<void>;
}
