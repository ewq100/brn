import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "vitest";
import type { Client } from "../src/cli/client.ts";
import { decodeSse, openEventStream } from "../src/cli/sse.ts";
import type {
	ConversationSnapshot,
	Operation,
	OperationView,
	PromptCommand,
} from "../src/core/conversation.ts";
import {
	isPrompt,
	type Snapshot,
	type StreamEvent,
} from "../src/protocol/contracts.ts";
import {
	attachEventStream,
	createSnapshotHub,
	MAX_BUFFERED_BYTES,
} from "../src/service/events.ts";
import { spawnServiceWithFake } from "./support/process.ts";

// The protocol module is browser-safe and imports nothing from core, so these
// typed assignments are what keeps the two descriptions of the same value from
// drifting apart. A structural mismatch is a compile error, not a runtime
// surprise.
const conversationContract: ConversationSnapshot = {
	session: { id: "session-1", model: { provider: "test", id: "offline" } },
	context: null,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
};
const workContract: OperationView = {
	operation: null,
	liveText: "",
	accepting: true,
	controlling: false,
};
const wireSnapshot: Snapshot = {
	instanceId: "instance-test",
	sequence: 1,
	conversation: conversationContract,
	work: workContract,
};
const promptContract: PromptCommand = {
	requestId: "00000000-0000-4000-8000-000000000000",
	sessionId: "session-1",
	model: { provider: "test", id: "offline" },
	text: "hello",
};

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function* streamOf(
	...chunks: readonly (string | Uint8Array)[]
): AsyncGenerator<Uint8Array> {
	for (const chunk of chunks) {
		yield typeof chunk === "string" ? encode(chunk) : chunk;
	}
}

async function collect(
	chunks: AsyncIterable<Uint8Array>,
): Promise<StreamEvent[]> {
	const received: StreamEvent[] = [];
	for await (const event of decodeSse(chunks)) received.push(event);
	return received;
}

function snapshotEvent(overrides: Partial<Snapshot> = {}): StreamEvent {
	return { type: "snapshot", snapshot: { ...wireSnapshot, ...overrides } };
}

function frame(event: StreamEvent, terminator = "\n\n"): string {
	return `data: ${JSON.stringify(event)}${terminator}`;
}

test("the wire contract and the core interfaces describe the same values", () => {
	// Assignments in both directions: neither description may add or drop a field.
	const backToCore: ConversationSnapshot = wireSnapshot.conversation;
	const workBackToCore: OperationView = wireSnapshot.work;
	expect(backToCore).toEqual(conversationContract);
	expect(workBackToCore).toEqual(workContract);
	expect(isPrompt(promptContract)).toBe(true);
	expect(isPrompt({ ...promptContract, requestId: "not-a-uuid" })).toBe(false);
	expect(isPrompt({ ...promptContract, extra: 1 })).toBe(false);
});

test("snapshot frames survive every UTF-8 chunk boundary", async () => {
	const event: StreamEvent = {
		type: "snapshot",
		snapshot: {
			instanceId: "instance-test",
			sequence: 1,
			conversation: {
				session: null,
				context: null,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				},
			},
			work: {
				operation: null,
				liveText: "\u00f5",
				accepting: true,
				controlling: false,
			},
		},
	};
	const bytes = new TextEncoder().encode(
		`data: ${JSON.stringify(event)}\r\n\r\n`,
	);
	for (let split = 1; split < bytes.length; split += 1) {
		async function* chunks(): AsyncGenerator<Uint8Array> {
			yield bytes.slice(0, split);
			yield bytes.slice(split);
		}
		const received: StreamEvent[] = [];
		for await (const item of decodeSse(chunks())) received.push(item);
		expect(received).toEqual([event]);
	}
});

test("the decoder ignores comments and joins multi-line data with newlines", async () => {
	const event = snapshotEvent();
	const serialized = JSON.stringify(event);
	// Split immediately after the opening brace, where a rejoining newline is
	// insignificant JSON whitespace. The point is that the decoder joins the lines
	// with "\n" instead of dropping one of them.
	const multiline = `data: ${serialized.slice(0, 1)}\ndata: ${serialized.slice(1)}\n\n`;
	const received = await collect(
		streamOf(": heartbeat\n\n", "event: update\n", multiline),
	);
	expect(received).toEqual([JSON.parse(serialized)]);
});

test("the decoder accepts CRLF frames and ignores unknown fields", async () => {
	const first = snapshotEvent();
	const second: StreamEvent = {
		type: "update",
		snapshot: { ...wireSnapshot, sequence: 2 },
	};
	const received = await collect(
		streamOf(`id: 7\r\n${frame(first, "\r\n\r\n")}`, frame(second, "\r\n\r\n")),
	);
	expect(received).toEqual([first, second]);
});

test("the decoder rejects malformed frames rather than guessing", async () => {
	await expect(collect(streamOf("data: {not json}\n\n"))).rejects.toThrow();
	await expect(
		collect(streamOf('data: {"type":"bogus"}\n\n')),
	).rejects.toThrow();
	await expect(
		collect(streamOf('data: {"type":"snapshot"}\n\n')),
	).rejects.toThrow();
	// A lone continuation byte is not valid UTF-8 and must not be replaced with a
	// substitution character.
	await expect(
		collect(streamOf(new Uint8Array([0x41, 0x80]))),
	).rejects.toThrow();
});

test("the decoder refuses an unbounded frame", async () => {
	const oversized = `data: ${"a".repeat(3 * 1024 * 1024)}`;
	await expect(collect(streamOf(oversized))).rejects.toThrow();
});

/** A scripted client, so reconnection can be observed without a paid submission. */
function scriptedClient(options: {
	readonly streams: readonly (readonly string[] | "fail")[];
	readonly instanceId?: string;
	readonly onSubmit?: () => void;
}): { client: Client; attempts: () => number; reattachments: () => number } {
	let attempt = 0;
	let reattachments = 0;
	const client: Client = {
		host: "127.0.0.1:1",
		stateDir: "/nonexistent",
		instanceId: options.instanceId ?? "instance-test",
		async request() {
			throw new Error("scripted client makes no requests");
		},
		async submit(): Promise<Operation> {
			options.onSubmit?.();
			throw new Error("a reconnect must never submit a prompt");
		},
		async operation(): Promise<Operation> {
			throw new Error("scripted client makes no requests");
		},
		async result() {
			throw new Error("scripted client makes no requests");
		},
		async events() {
			const script = options.streams[attempt] ?? "fail";
			attempt += 1;
			if (script === "fail") throw new Error("transport failure");
			return streamOf(...script);
		},
		async reattach() {
			reattachments += 1;
			return client;
		},
		async disconnect() {},
	};
	return {
		client,
		attempts: () => attempt,
		reattachments: () => reattachments,
	};
}

test("a reconnecting stream accepts only newer sequences and never resubmits", async () => {
	const first = snapshotEvent({ sequence: 4 });
	const stale: StreamEvent = {
		type: "update",
		snapshot: { ...wireSnapshot, sequence: 3 },
	};
	const duplicate: StreamEvent = { type: "update", snapshot: first.snapshot };
	const newer: StreamEvent = {
		type: "update",
		snapshot: { ...wireSnapshot, sequence: 5 },
	};
	let submissions = 0;
	const scripted = scriptedClient({
		streams: [[frame(first), frame(stale), frame(duplicate), frame(newer)]],
		onSubmit: () => {
			submissions += 1;
		},
	});
	const seen: number[] = [];
	const stream = openEventStream(scripted.client, (snapshot) => {
		seen.push(snapshot.sequence);
	});
	// The scripted stream ends, so the loop would reconnect; close as soon as the
	// events have been delivered.
	await new Promise((resolve) => setTimeout(resolve, 100));
	await stream.close();
	expect(seen).toEqual([4, 5]);
	expect(submissions).toBe(0);
});

test("an instance change discards the previous sequence", async () => {
	const old = snapshotEvent({ sequence: 9 });
	const fresh = snapshotEvent({ instanceId: "instance-second", sequence: 1 });
	const scripted = scriptedClient({
		streams: [[frame(old)], [frame(fresh)]],
	});
	const seen: Snapshot[] = [];
	const stream = openEventStream(scripted.client, (snapshot) => {
		seen.push(snapshot);
	});
	await new Promise((resolve) => setTimeout(resolve, 600));
	await stream.close();
	expect(seen.map((snapshot) => snapshot.instanceId)).toEqual([
		"instance-test",
		"instance-second",
	]);
	expect(seen.map((snapshot) => snapshot.sequence)).toEqual([9, 1]);
	expect(scripted.reattachments()).toBeGreaterThan(0);
});

test("reconnection backs off and reports a persistent disconnected status", async () => {
	const scripted = scriptedClient({
		streams: ["fail", "fail", [frame(snapshotEvent())]],
	});
	const statuses: string[] = [];
	const started = Date.now();
	const stream = openEventStream(scripted.client, () => undefined, {
		onStatus: (status) => {
			statuses.push(status);
		},
	});
	await new Promise((resolve) => setTimeout(resolve, 900));
	await stream.close();
	// 250 ms then 500 ms: the third attempt cannot have happened sooner.
	expect(Date.now() - started).toBeGreaterThanOrEqual(750);
	expect(scripted.attempts()).toBe(3);
	// Disconnected is reported for as long as it is true, and the third attempt
	// connects. That scripted stream then ends, which is a disconnect again.
	expect(statuses.slice(0, 3)).toEqual([
		"disconnected",
		"disconnected",
		"connected",
	]);
});

test("a state change during initial subscription is not lost", async () => {
	const service = await spawnServiceWithFake();
	try {
		const seen: Snapshot[] = [];
		const stream = openEventStream(service.client, (snapshot) => {
			seen.push(snapshot);
		});
		// Submitted while the subscription is still being established: the first
		// frame either already shows the operation or an update follows it.
		const accepted = await service.client.submit(service.prompt("live work"));
		await service.emitFake("partial ");
		await service.completeFake("partial answer");
		const deadline = Date.now() + 5_000;
		while (
			Date.now() < deadline &&
			!seen.some((snapshot) => snapshot.work.operation?.state === "succeeded")
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await stream.close();
		const states = seen.map((snapshot) => snapshot.work.operation?.state);
		expect(states).toContain("succeeded");
		const settled = seen.at(-1);
		expect(settled?.work.operation?.id).toBe(accepted.id);
		// The final snapshot points at the durable result, and the live preview is
		// cleared only once it does.
		expect(settled?.work.operation?.result).toEqual({
			kind: "completed",
			entryIds: expect.any(Array),
			truncated: false,
			usage: expect.any(Object),
		});
		const sequences = seen.map((snapshot) => snapshot.sequence);
		expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
	} finally {
		await service.close();
	}
});

test("the event stream authenticates independently of the JSON routes", async () => {
	const service = await spawnServiceWithFake();
	try {
		expect(
			(await service.service.request("/v1/events", { auth: false })).status,
		).toBe(401);
		expect(
			(
				await service.service.request("/v1/events", {
					headers: { Origin: "https://hostile.example" },
				})
			).status,
		).toBe(403);
		expect(
			(await service.service.request("/v1/events", { host: "brn.local" }))
				.status,
		).toBe(403);
	} finally {
		await service.close();
	}
});

test("a client that never reads the stream does not cancel accepted work", async () => {
	const service = await spawnServiceWithFake();
	try {
		// Opened and abandoned: the response is never read from.
		const abandoned = new AbortController();
		void service.client.events(abandoned.signal).catch(() => undefined);
		const accepted = await service.client.submit(service.prompt("slow"));
		await service.emitFake("x".repeat(64 * 1024));
		abandoned.abort();
		await service.completeFake("finished anyway");
		expect((await service.client.operation(accepted.id)).state).toBe(
			"succeeded",
		);
		expect(await service.fakeCallCount()).toBe(1);
	} finally {
		await service.close();
	}
});

test("a snapshot response and a stream frame describe the same instance", async () => {
	const service = await spawnServiceWithFake();
	try {
		const response = await service.service.request("/v1/snapshot");
		expect(response.status).toBe(200);
		expect(response.headers["cache-control"]).toBe("no-store");
		const snapshot = JSON.parse(response.text) as Snapshot;
		expect(snapshot.conversation.session?.id).toBe("session-1");

		const events = await service.client.events();
		const iterator = decodeSse(events)[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.done).toBe(false);
		const event = first.value as StreamEvent;
		expect(event.type).toBe("snapshot");
		expect(event.snapshot.instanceId).toBe(snapshot.instanceId);
		expect(event.snapshot.sequence).toBeGreaterThanOrEqual(snapshot.sequence);
		await iterator.return?.(undefined);
	} finally {
		await service.close();
	}
});

test("closing a stream leaves nothing running", async () => {
	const service = await spawnServiceWithFake();
	let delivered = 0;
	const stream = openEventStream(service.client, () => {
		delivered += 1;
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(delivered).toBeGreaterThan(0);
	await stream.close();
	const afterClose = delivered;
	// A second close is harmless, and nothing arrives after the first.
	await stream.close();
	await service.client.submit(service.prompt("after close"));
	await service.completeFake("done");
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(delivered).toBe(afterClose);
	await service.close();
});

test("a writer whose queue passes the ceiling loses its stream, not its work", () => {
	// A stand-in response, so the ceiling can be reached deterministically rather
	// than by hoping a kernel socket buffer fills at a particular size.
	const written: string[] = [];
	let queued = 0;
	let ended = false;
	const response = {
		writeHead() {
			return response;
		},
		write(chunk: string) {
			written.push(chunk);
			queued += Buffer.byteLength(chunk, "utf8");
			return false;
		},
		end() {
			ended = true;
		},
		once() {
			return response;
		},
		get writableLength() {
			return queued;
		},
	};

	// A big live preview, with a state flag flipped each round so nothing is
	// coalesced away.
	let view: OperationView = {
		...workContract,
		liveText: "z".repeat(700 * 1024),
	};
	const hub = createSnapshotHub({
		instanceId: "instance-test",
		conversation: () => conversationContract,
		work: () => view,
	});
	// Dropping the connection is logged under a fixed code; keep it out of the
	// test's own output.
	const realWrite = process.stderr.write.bind(process.stderr);
	const logged: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		logged.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		attachEventStream(
			hub,
			{} as unknown as IncomingMessage,
			response as unknown as ServerResponse,
		);
		for (let round = 0; round < 8 && !ended; round += 1) {
			view = { ...view, controlling: !view.controlling };
			hub.changed();
		}
	} finally {
		process.stderr.write = realWrite;
	}

	expect(ended).toBe(true);
	expect(queued).toBeGreaterThan(MAX_BUFFERED_BYTES);
	expect(logged.join("")).toContain("events.reader_too_slow");
	// Unsubscribed: a later change reaches this connection no more. Nothing here
	// cancels or even consults the operation.
	const delivered = written.length;
	view = { ...view, controlling: !view.controlling };
	hub.changed();
	expect(written.length).toBe(delivered);
	hub.close();
});
