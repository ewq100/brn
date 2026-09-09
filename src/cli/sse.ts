import { BrnError } from "../core/errors.ts";
import {
	isStreamEvent,
	type Snapshot,
	type StreamEvent,
} from "../protocol/contracts.ts";
import type { Client } from "./client.ts";

/** No single frame may grow past this before it is refused. */
export const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/** Reconnect delays, in order; every later attempt waits the last value. */
export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000] as const;

const encoder = new TextEncoder();

/** Where the current frame ends, and how many characters the terminator takes. */
function frameBoundary(
	pending: string,
): { readonly index: number; readonly length: number } | null {
	const lf = pending.indexOf("\n\n");
	const crlf = pending.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return null;
	if (crlf !== -1 && (lf === -1 || crlf < lf)) {
		return { index: crlf, length: 4 };
	}
	return { index: lf, length: 2 };
}

/**
 * Decodes one frame into an event, or nothing when the frame carries no data.
 *
 * Comments — which is what a heartbeat is — and fields BRN does not use, such as
 * `id` and `event`, are ignored. Several `data:` lines rejoin with a newline, as
 * the event-stream format requires.
 */
function decodeFrame(frame: string): StreamEvent | null {
	const data: string[] = [];
	for (const line of frame.split(/\r\n|\r|\n/)) {
		if (line === "" || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		if (field !== "data") continue;
		const value = separator === -1 ? "" : line.slice(separator + 1);
		data.push(value.startsWith(" ") ? value.slice(1) : value);
	}
	if (data.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data.join("\n"));
	} catch {
		throw new BrnError("INVALID_RESPONSE", "frame_not_json");
	}
	// A frame is validated before it can reach the caller: an unknown event shape
	// is a protocol failure, not something to interpret optimistically.
	if (!isStreamEvent(parsed)) {
		throw new BrnError("INVALID_RESPONSE", "frame_schema");
	}
	return parsed;
}

/**
 * Turns a byte stream into validated events.
 *
 * Decoding is strict and incremental, so a multibyte character, a `\r\n` pair or
 * a JSON document split across chunks is reassembled rather than corrupted, and
 * malformed UTF-8 is refused instead of being replaced.
 */
export async function* decodeSse(
	chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	let pendingBytes = 0;
	for await (const chunk of chunks) {
		pendingBytes += chunk.byteLength;
		if (pendingBytes > MAX_PENDING_BYTES) {
			throw new BrnError("INVALID_RESPONSE", "frame_too_large");
		}
		try {
			pending += decoder.decode(chunk, { stream: true });
		} catch {
			throw new BrnError("INVALID_RESPONSE", "utf8");
		}
		for (;;) {
			const boundary = frameBoundary(pending);
			if (boundary === null) break;
			const frame = pending.slice(0, boundary.index);
			pending = pending.slice(boundary.index + boundary.length);
			pendingBytes = encoder.encode(pending).length;
			const event = decodeFrame(frame);
			if (event !== null) yield event;
		}
	}
}

export interface EventStreamOptions {
	/** Reports the connection state, so a client can show it persistently. */
	readonly onStatus?: (status: "connected" | "disconnected") => void;
}

export interface EventStream {
	close(): Promise<void>;
}

/**
 * Follows the service's snapshots for as long as the caller wants them.
 *
 * Everything this does is read-only. A dropped connection is answered by
 * reconnecting and accepting a fresh snapshot: it never repeats a submission, so
 * a lost stream can never cost a second paid operation. Sequence numbers only
 * ever move forward within one instance, and a changed instance starts over
 * rather than being compared against the previous one's numbering.
 */
export function openEventStream(
	client: Client,
	onSnapshot: (snapshot: Snapshot) => void,
	options: EventStreamOptions = {},
): EventStream {
	let closed = false;
	let controller: AbortController | null = null;
	let wake: (() => void) | null = null;
	let attached = client;
	let instanceId: string | null = null;
	let lastSequence = -1;
	let attempt = 0;

	/** Waits, but not past a close. */
	async function pause(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				wake = null;
				resolve();
			}, ms);
			wake = () => {
				clearTimeout(timer);
				wake = null;
				resolve();
			};
		});
	}

	function accept(event: StreamEvent): void {
		const snapshot = event.snapshot;
		if (snapshot.instanceId !== instanceId) {
			// A different instance publishes its own sequence from the beginning.
			instanceId = snapshot.instanceId;
			lastSequence = -1;
		}
		if (snapshot.sequence <= lastSequence) return;
		lastSequence = snapshot.sequence;
		onSnapshot(snapshot);
	}

	const running = (async () => {
		while (!closed) {
			const current = new AbortController();
			controller = current;
			try {
				const chunks = await attached.events(current.signal);
				attempt = 0;
				options.onStatus?.("connected");
				for await (const event of decodeSse(chunks)) accept(event);
			} catch {
				// A transport or protocol failure is answered by reconnecting, never by
				// resubmitting: the reason is deliberately not inspected here.
			} finally {
				controller = null;
			}
			if (closed) break;
			options.onStatus?.("disconnected");
			const delay =
				RECONNECT_DELAYS_MS[
					Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)
				] ?? 2000;
			attempt += 1;
			await pause(delay);
			if (closed) break;
			try {
				attached = await attached.reattach();
			} catch {
				// Discovery is not readable yet. The previous attachment is kept and the
				// next attempt tries again.
			}
		}
	})();

	return {
		async close() {
			closed = true;
			controller?.abort();
			wake?.();
			await running;
		},
	};
}
