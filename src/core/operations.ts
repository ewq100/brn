import type {
	ConversationEngine,
	EngineEvent,
	Operation,
	OperationStore,
	Operations,
	OperationView,
	PromptCommand,
	RunResult,
} from "./conversation.ts";
import { BrnError, isBrnError } from "./errors.ts";

/**
 * How long an accepted operation may run before BRN requests cancellation. This
 * is a cancellation deadline, not a claim that an uncooperative provider stopped
 * charging: the operation stays occupied until the engine settles.
 */
export const DEFAULT_DEADLINE_MS = 120_000;

/**
 * The live-preview ceiling, in UTF-8 bytes. It bounds the snapshot a reconnecting
 * client receives; it is a defensive transport limit and does not replace the
 * requested output-token cap.
 */
export const LIVE_PREVIEW_LIMIT_BYTES = 1024 * 1024;

/** Recorded when an unknown exception escaped the engine. Its text is never kept. */
const INTERNAL_FAILURE_CODE = "INTERNAL_ERROR";
const DEADLINE_FAILURE_CODE = "DEADLINE_EXCEEDED";
const OUTPUT_LIMIT_FAILURE_CODE = "OUTPUT_LIMIT";

/**
 * The coarse class reported in `RunResult.failed.code` when an engine raised an
 * exception instead of returning an outcome. The precise reason travels in
 * `Operation.failureCode`, whose vocabulary is wider than this union.
 */
function thrownFailureResult(): RunResult {
	return { kind: "failed", code: "PROVIDER_ERROR", entryIds: [] };
}

const encoder = new TextEncoder();

export interface OperationsOptions {
	readonly store: OperationStore;
	readonly engine: ConversationEngine;
	/** Announces that a coherent synchronous snapshot is available. */
	readonly onChange: () => void;
	/** Test-only shortening of the cancellation deadline, not a product bypass. */
	readonly deadlineMs?: number;
}

/**
 * The single-operation coordinator.
 *
 * It owns one seat: at most one accepted operation, or one session/model change,
 * at a time. Busy work is refused visibly instead of queued, an exact duplicate
 * resolves to the original operation without paying for it twice, and the run
 * promise belongs to the coordinator rather than to whichever socket submitted
 * it — a client that disconnects does not cancel accepted work.
 */
class Coordinator implements Operations {
	private readonly store: OperationStore;
	private readonly engine: ConversationEngine;
	private readonly onChange: () => void;
	private readonly deadlineMs: number;

	private accepting = true;
	private controlling = false;
	private activeId: string | null = null;
	private liveText = "";
	private liveBytes = 0;
	private previewFull = false;
	private pendingFailureCode: string | null = null;
	private settlement: Promise<Operation> | null = null;
	private cancellation: { id: string; promise: Promise<Operation> } | null =
		null;
	private pendingControl: Promise<void> | null = null;

	constructor(options: OperationsOptions) {
		this.store = options.store;
		this.engine = options.engine;
		this.onChange = options.onChange;
		this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	}

	submit(command: PromptCommand, requestHash: string): Operation {
		const previous = this.store.find(command.requestId);
		if (previous) {
			// An exact duplicate resolves even when the conversation has moved on, so a
			// client that lost a response never has to guess whether it paid already.
			if (previous.requestHash !== requestHash) {
				throw new BrnError("REQUEST_ID_REUSED");
			}
			return previous;
		}
		if (!this.accepting) throw new BrnError("SERVICE_STOPPING");
		if (this.activeId !== null || this.controlling) throw new BrnError("BUSY");
		const current = this.engine.snapshot().session;
		if (!current || current.id !== command.sessionId) {
			throw new BrnError("SESSION_MISMATCH");
		}
		const model = current.model;
		if (
			model === null ||
			model.provider !== command.model.provider ||
			model.id !== command.model.id
		) {
			throw new BrnError("MODEL_MISMATCH");
		}
		const admitted = this.store.insert(command, requestHash);
		this.activeId = admitted.id;
		this.liveText = "";
		this.liveBytes = 0;
		this.previewFull = false;
		this.pendingFailureCode = null;
		this.cancellation = null;
		let running: Operation;
		try {
			running = this.store.transition(admitted.id, ["accepted"], "running");
		} catch (error) {
			// No run was started and no settlement exists, so keeping the seat would
			// hold it until the process restarts and make every later refusal read
			// `BUSY` instead of the real reason. The durably accepted row still holds
			// the ledger's own seat and is recovered as `interrupted` on restart.
			this.activeId = null;
			this.onChange();
			throw error;
		}

		const settlement = this.lifecycle(command, admitted.id);
		// The failure is retained on the promise and reported through waitForIdle,
		// cancel and stop; this handler only keeps it from becoming an unhandled
		// rejection when no caller is waiting.
		settlement.catch(() => {});
		// An engine that refuses the run synchronously has already settled the
		// operation inside the call above, so only a still-active operation owns the
		// settlement promise, and the returned record is the one that was committed.
		const settledEarly = this.activeId !== admitted.id;
		if (!settledEarly) this.settlement = settlement;
		this.onChange();
		return settledEarly ? (this.store.find(admitted.id) ?? running) : running;
	}

	async cancel(id: string): Promise<Operation> {
		const record = this.store.find(id);
		if (record === null) throw new BrnError("UNKNOWN_OPERATION");
		// A finished, interrupted or superseded operation reports what was recorded
		// instead of disturbing whatever is running now.
		if (this.activeId !== id) return record;
		const existing = this.cancellation;
		if (existing !== null && existing.id === id) return await existing.promise;
		const promise = this.performCancellation(id);
		this.cancellation = { id, promise };
		return await promise;
	}

	async control<T>(action: () => Promise<T>): Promise<T> {
		// These guards run before the first await, so two controls started in the
		// same turn cannot both believe they hold the seat.
		if (!this.accepting) throw new BrnError("SERVICE_STOPPING");
		if (this.activeId !== null || this.controlling) throw new BrnError("BUSY");
		this.controlling = true;
		this.onChange();
		const running = (async () => {
			try {
				return await action();
			} finally {
				this.controlling = false;
				this.onChange();
			}
		})();
		const pending = running.then(
			() => undefined,
			() => undefined,
		);
		this.pendingControl = pending;
		try {
			return await running;
		} finally {
			if (this.pendingControl === pending) this.pendingControl = null;
		}
	}

	view(): OperationView {
		return {
			operation:
				this.activeId === null
					? this.store.latest()
					: this.store.find(this.activeId),
			liveText: this.liveText,
			accepting: this.accepting,
			controlling: this.controlling,
		};
	}

	async waitForIdle(): Promise<void> {
		for (;;) {
			const control = this.pendingControl;
			const settlement = this.settlement;
			if (control === null && settlement === null) return;
			if (control !== null) {
				await control;
				if (this.pendingControl === control) this.pendingControl = null;
			}
			if (settlement !== null) {
				// A retained failure keeps rejecting: the operation is still occupied and
				// its lost write must not become invisible after one report.
				await settlement;
				if (this.settlement === settlement) this.settlement = null;
			}
		}
	}

	async stop(): Promise<void> {
		this.accepting = false;
		this.onChange();
		const control = this.pendingControl;
		if (control !== null) await control;
		const active = this.activeId;
		if (active !== null) {
			// Swallowed only so shutdown still reaches the settlement below, which is
			// where a lost write is reported.
			await this.cancel(active).catch(() => undefined);
		}
		const settlement = this.settlement;
		// Nothing swallows this. When the authoritative write is what was lost, the
		// ledger holds no record of it, so discarding the rejection here would erase
		// the only report; the process owner's error handler is that report.
		if (settlement !== null) await settlement;
	}

	/**
	 * Owns one engine run from admission to a durable outcome. Nothing outside this
	 * method settles an operation, so a socket closing, a timer firing and a client
	 * cancellation all converge on the same single completion.
	 */
	private async lifecycle(
		command: PromptCommand,
		id: string,
	): Promise<Operation> {
		const deadline = setTimeout(() => {
			void this.requestCancellation(id, DEADLINE_FAILURE_CODE);
		}, this.deadlineMs);
		let result: RunResult | null = null;
		let failure: unknown;
		try {
			result = await this.engine.run(command, (event) =>
				this.observe(id, event),
			);
		} catch (error) {
			failure = error;
		} finally {
			clearTimeout(deadline);
		}
		// `store.finish` runs only now, after the engine reported its native results
		// as durable, and its own failure propagates untouched.
		if (result !== null) return this.settle(id, result);
		const code = isBrnError(failure) ? failure.code : INTERNAL_FAILURE_CODE;
		return this.settle(id, thrownFailureResult(), code);
	}

	private observe(id: string, event: EngineEvent): void {
		// A settled operation cannot grow its preview.
		if (this.activeId !== id) return;
		if (event.type === "text") this.appendPreview(id, event.text);
		this.onChange();
	}

	private appendPreview(id: string, text: string): void {
		if (this.previewFull) return;
		const bytes = encoder.encode(text).length;
		if (this.liveBytes + bytes > LIVE_PREVIEW_LIMIT_BYTES) {
			// Stop accumulating rather than splice a chunk in half, and ask the engine
			// to stop producing what nobody can display.
			this.previewFull = true;
			void this.requestCancellation(id, OUTPUT_LIMIT_FAILURE_CODE);
			return;
		}
		this.liveText += text;
		this.liveBytes += bytes;
	}

	/**
	 * BRN's own decision to stop an operation, for a deadline or an oversized
	 * preview. The recorded reason survives to the outcome; the authoritative write
	 * happens when the engine settles, so a store failure here is reported there.
	 */
	private async requestCancellation(
		id: string,
		failureCode: string,
	): Promise<void> {
		if (this.activeId !== id) return;
		this.pendingFailureCode ??= failureCode;
		try {
			await this.beginCancelling(id);
		} catch {
			// The authoritative record is written when the engine settles, which is
			// where a store failure is reported.
		}
	}

	private async performCancellation(id: string): Promise<Operation> {
		const settlement = this.settlement;
		await this.beginCancelling(id);
		if (settlement !== null) await settlement;
		const settled = this.store.find(id);
		if (settled === null) throw new BrnError("UNKNOWN_OPERATION");
		return settled;
	}

	/**
	 * Persists `cancelling` before asking the engine to stop, so a crash between the
	 * two is recovered as an interrupted operation rather than a silent success. A
	 * run that settled in the meantime keeps its own outcome: winning the race is
	 * not relabelled as a cancellation.
	 */
	private async beginCancelling(id: string): Promise<void> {
		try {
			this.store.transition(id, ["accepted", "running"], "cancelling");
			this.onChange();
		} catch (error) {
			if (!isBrnError(error) || error.code !== "OPERATION_CONFLICT")
				throw error;
		}
		await this.engine.cancel();
	}

	private settle(
		id: string,
		result: RunResult,
		thrownCode?: string,
	): Operation {
		if (this.activeId !== id) {
			// A second settlement signal for an operation that already finished changes
			// nothing. Depth only: an engine cannot reach this branch, because one run
			// is awaited once and a promise resolves once, so a duplicate outcome is
			// absorbed before it arrives here. It guards a future in-process adapter
			// that settles a run by some other route.
			const recorded = this.store.find(id);
			if (recorded === null) throw new BrnError("UNKNOWN_OPERATION");
			return recorded;
		}
		const failureCode =
			result.kind === "completed"
				? undefined
				: (this.pendingFailureCode ??
					thrownCode ??
					(result.kind === "failed" ? result.code : undefined));
		const finished =
			failureCode === undefined
				? this.store.finish(id, result)
				: this.store.finish(id, result, failureCode);
		// Admission is released only once the outcome is committed. If the write
		// failed above, the operation stays occupied and the failure reaches the
		// caller instead of a pretended success.
		this.activeId = null;
		this.pendingFailureCode = null;
		this.cancellation = null;
		this.settlement = null;
		this.onChange();
		return finished;
	}
}

/** Creates the single-operation coordinator over a ledger and a conversation engine. */
export function createOperations(options: OperationsOptions): Operations {
	return new Coordinator(options);
}
