import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ConversationSnapshot,
	OperationView,
} from "../core/conversation.ts";
import type { Snapshot, StreamEvent } from "../protocol/contracts.ts";
import { logInfo } from "./log.ts";

/**
 * Text-only updates are coalesced to at most one per interval. A state
 * transition is never delayed by it.
 */
export const TEXT_COALESCE_MS = 50;

/** Heartbeat comments detect a dead connection without touching operation state. */
export const HEARTBEAT_MS = 15_000;

/**
 * A connection whose queued bytes pass this ceiling is closed. Closing a slow
 * reader's socket is not a reason to cancel the work it was watching.
 */
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/**
 * The authoritative in-memory publication point.
 *
 * There is no replay journal. One sequence belongs to one service instance, the
 * snapshot is rebuilt from live state before any event announces it, and every
 * connection starts from the current snapshot — so a reconnecting client
 * resynchronises by being told the truth rather than by replaying history.
 */
export interface SnapshotHub {
	subscribe(listener: (snapshot: Snapshot) => void): () => void;
	snapshot(): Snapshot;
	changed(): void;
	close(): void;
}

export interface SnapshotHubOptions {
	readonly instanceId: string;
	/** Reads the conversation's current state synchronously. */
	readonly conversation: () => ConversationSnapshot;
	/** Reads the coordinator's current view synchronously. */
	readonly work: () => OperationView;
}

/**
 * Everything in a snapshot except the live preview.
 *
 * A change here is a state transition and is published at once; a change only in
 * the preview text is coalesced. Comparing the serialised form is deliberate: it
 * cannot silently miss a field that a later capability adds.
 */
function stateShape(snapshot: Snapshot): string {
	return JSON.stringify([
		snapshot.conversation,
		snapshot.work.operation,
		snapshot.work.accepting,
		snapshot.work.controlling,
	]);
}

export function createSnapshotHub(options: SnapshotHubOptions): SnapshotHub {
	const listeners = new Set<(snapshot: Snapshot) => void>();
	let sequence = 0;
	let coalescing: NodeJS.Timeout | null = null;
	let lastPublished = 0;
	let closed = false;

	function capture(): Snapshot {
		sequence += 1;
		return {
			instanceId: options.instanceId,
			sequence,
			conversation: options.conversation(),
			work: options.work(),
		};
	}

	let current = capture();

	function publish(): void {
		if (coalescing !== null) {
			clearTimeout(coalescing);
			coalescing = null;
		}
		lastPublished = Date.now();
		const announced = current;
		// A listener that unsubscribes while being notified must not disturb the
		// iteration of the others.
		for (const listener of [...listeners]) listener(announced);
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		snapshot() {
			return current;
		},
		changed() {
			if (closed) return;
			const previous = current;
			// The authoritative snapshot is updated before anything is announced, so a
			// subscription registered in this turn and a frame sent in this turn cannot
			// disagree.
			current = capture();
			if (stateShape(previous) !== stateShape(current)) {
				publish();
				return;
			}
			if (coalescing !== null) return;
			const wait = TEXT_COALESCE_MS - (Date.now() - lastPublished);
			if (wait <= 0) {
				publish();
				return;
			}
			coalescing = setTimeout(() => {
				coalescing = null;
				if (!closed) publish();
			}, wait);
		},
		close() {
			closed = true;
			if (coalescing !== null) {
				clearTimeout(coalescing);
				coalescing = null;
			}
			listeners.clear();
		},
	};
}

/**
 * Serves one authenticated event stream.
 *
 * Registration, the synchronous snapshot capture and the first frame all happen
 * in this one event-loop turn, with no await between them: that is what closes
 * the gap in which a state change could be announced to nobody and then be
 * missing from the snapshot the new connection receives.
 *
 * `Last-Event-ID` is ignored. There is nothing to replay, and every reconnect
 * starts from a fresh snapshot instead.
 */
export function attachEventStream(
	hub: SnapshotHub,
	_request: IncomingMessage,
	response: ServerResponse,
): void {
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		// No proxy may buffer or transform this stream.
		"X-Accel-Buffering": "no",
		Connection: "keep-alive",
	});

	let open = true;
	let unsubscribe: (() => void) | null = null;
	const heartbeat = setInterval(() => {
		if (open) response.write(": heartbeat\n\n");
	}, HEARTBEAT_MS);

	function stop(): void {
		if (!open) return;
		open = false;
		clearInterval(heartbeat);
		unsubscribe?.();
		unsubscribe = null;
	}

	function send(event: StreamEvent): void {
		if (!open) return;
		// Model text is data inside a JSON document, never interpolated into the
		// frame: a newline in an answer cannot end a frame.
		response.write(`data: ${JSON.stringify(event)}\n\n`);
		if (response.writableLength > MAX_BUFFERED_BYTES) {
			// This connection cannot keep up. It loses its stream; the operation it was
			// watching is untouched and keeps running.
			logInfo("events.reader_too_slow", { buffered: response.writableLength });
			stop();
			response.end();
		}
	}

	unsubscribe = hub.subscribe((snapshot) => send({ type: "update", snapshot }));
	send({ type: "snapshot", snapshot: hub.snapshot() });
	response.once("close", stop);
}
