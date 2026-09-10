import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type {
	OperationState,
	OperationStore,
	OperationView,
	PromptCommand,
} from "../src/core/conversation.ts";
import { BrnError } from "../src/core/errors.ts";
import { createOperations } from "../src/core/operations.ts";
import { openOperationStore } from "../src/service/operation-store.ts";
import { FakeEngine } from "./support/fake-engine.ts";

const MODEL = { provider: "test", id: "offline" };

function prompt(overrides: Partial<PromptCommand> = {}): PromptCommand {
	return {
		requestId: "11111111-1111-4111-8111-111111111111",
		sessionId: "session-1",
		model: MODEL,
		text: "synthetic prompt",
		...overrides,
	};
}

const SECOND_ID = "22222222-2222-4222-8222-222222222222";

async function storePath(prefix: string): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
	return join(root, "operations.sqlite");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred {
	readonly promise: Promise<void>;
	release(): void;
}

function deferred(): Deferred {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** Wraps a real ledger so one committed write fails the way a full disk would. */
function storeFailingAt(
	store: OperationStore,
	method: "insert" | "transition" | "finish",
	failure: Error,
): OperationStore {
	return {
		find: (id) => store.find(id),
		insert: (command, requestHash) => {
			if (method === "insert") throw failure;
			return store.insert(command, requestHash);
		},
		transition: (id, from, to) => {
			if (method === "transition") throw failure;
			return store.transition(id, from, to);
		},
		finish: (id, result, failureCode) => {
			if (method === "finish") throw failure;
			return failureCode === undefined
				? store.finish(id, result)
				: store.finish(id, result, failureCode);
		},
		interruptUnfinished: () => store.interruptUnfinished(),
		latest: () => store.latest(),
		close: () => store.close(),
	};
}

/** Wraps a real ledger and counts the outcomes it was asked to commit. */
function storeCountingFinish(
	store: OperationStore,
	count: { finishes: number },
): OperationStore {
	return {
		find: (id) => store.find(id),
		insert: (command, requestHash) => store.insert(command, requestHash),
		transition: (id, from, to) => store.transition(id, from, to),
		finish: (id, result, failureCode) => {
			count.finishes += 1;
			return failureCode === undefined
				? store.finish(id, result)
				: store.finish(id, result, failureCode);
		},
		interruptUnfinished: () => store.interruptUnfinished(),
		latest: () => store.latest(),
		close: () => store.close(),
	};
}

test("duplicate admission never repeats provider work", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const command = {
		requestId: "953ac32b-26e2-4a2b-9d99-8e77a087e780",
		sessionId: "session-1",
		model: { provider: "test", id: "offline" },
		text: "synthetic prompt",
	};
	const first = operations.submit(command, "digest-a");
	expect(operations.submit(command, "digest-a").id).toBe(first.id);
	expect(() =>
		operations.submit({ ...command, text: "changed" }, "digest-b"),
	).toThrow("REQUEST_ID_REUSED");
	expect(engine.calls).toHaveLength(1);
	engine.complete("synthetic result");
	await operations.waitForIdle();
	expect(store.find(first.id)?.state).toBe("succeeded");
	await operations.stop();
	store.close();
});

test("an unsettled cancellation cannot admit a switch", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	engine.abortSettles = false;
	const operations = createOperations({ store, engine, onChange: () => {} });
	operations.submit(
		{
			requestId: "147fb03a-4494-4a91-abbd-420d859f5787",
			sessionId: "session-1",
			model: { provider: "test", id: "offline" },
			text: "wait",
		},
		"digest-wait",
	);
	const cancellation = operations.cancel(
		"147fb03a-4494-4a91-abbd-420d859f5787",
	);
	await expect(
		operations.control(() =>
			engine.create({
				provider: "test",
				id: "offline",
			}),
		),
	).rejects.toThrow("BUSY");
	engine.complete("completed before cancellation settled");
	await cancellation;
	expect(store.latest()?.state).toBe("succeeded");
	await operations.stop();
	store.close();
});

test("a repeated cancellation waits for the same settlement", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	engine.abortSettles = false;
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	const first = operations.cancel(accepted.id);
	const second = operations.cancel(accepted.id);
	await delay(1);
	// One cancellation request reaches the engine no matter how often a client asks.
	expect(engine.cancelCount).toBe(1);
	expect(store.find(accepted.id)?.state).toBe("cancelling");
	engine.abortSettles = true;
	await engine.cancel();
	expect(await first).toEqual(await second);
	expect((await first).state).toBe("cancelled");
	expect((await first).failureCode).toBeNull();
	await operations.stop();
	store.close();
});

const unfinished: readonly OperationState[] = [
	"accepted",
	"running",
	"cancelling",
];

for (const state of unfinished) {
	test(`a restart reports a ${state} operation and never replays it`, async () => {
		const path = await storePath(`brn-ops-restart-${state}-`);
		const before = openOperationStore(path);
		const admitted = before.insert(prompt(), "digest-a");
		if (state !== "accepted") {
			before.transition(admitted.id, ["accepted"], state);
		}
		before.close();

		const store = openOperationStore(path);
		const engine = new FakeEngine();
		const operations = createOperations({ store, engine, onChange: () => {} });
		try {
			expect(store.interruptUnfinished()).toBe(1);
			expect(store.find(admitted.id)?.state).toBe("interrupted");
			expect(store.find(admitted.id)?.failureCode).toBe("SERVICE_INTERRUPTED");
			// Constructing the coordinator submits nothing: a restart never repeats a
			// paid provider request.
			expect(engine.calls).toHaveLength(0);
			expect(operations.view().operation?.state).toBe("interrupted");
			// Cancelling a recovered operation reports its recorded state instead of
			// reaching for an engine that never ran it.
			expect((await operations.cancel(admitted.id)).state).toBe("interrupted");
			expect(engine.cancelCount).toBe(0);
		} finally {
			await operations.stop();
			store.close();
		}
	});
}

test("an unknown operation cannot be cancelled", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	try {
		await expect(operations.cancel(SECOND_ID)).rejects.toThrow(
			"UNKNOWN_OPERATION",
		);
	} finally {
		await operations.stop();
		store.close();
	}
});

test("the deadline cancels the run and records why", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({
		store,
		engine,
		onChange: () => {},
		deadlineMs: 10,
	});
	const accepted = operations.submit(prompt(), "digest-a");
	await operations.waitForIdle();
	const record = store.find(accepted.id);
	expect(record?.state).toBe("cancelled");
	expect(record?.failureCode).toBe("DEADLINE_EXCEEDED");
	expect(engine.cancelCount).toBe(1);
	await operations.stop();
	store.close();
});

test("an oversized preview stops growing, cancels and reports the limit", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	const half = "a".repeat(600 * 1024);
	engine.emitText(half);
	engine.emitText(half);
	// The reconnect snapshot never grows past the ceiling, and the discarded chunk
	// is not spliced in half.
	expect(operations.view().liveText).toBe(half);
	await operations.waitForIdle();
	const record = store.find(accepted.id);
	expect(record?.state).toBe("cancelled");
	expect(record?.failureCode).toBe("OUTPUT_LIMIT");
	expect(engine.cancelCount).toBe(1);
	await operations.stop();
	store.close();
});

test("a failed run keeps its partial answer durable", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	engine.emitText("partial ");
	engine.fail("partial answer");
	await operations.waitForIdle();
	const record = store.find(accepted.id);
	expect(record?.state).toBe("failed");
	expect(record?.result).toEqual({
		kind: "failed",
		code: "PROVIDER_ERROR",
		entryIds: ["entry-1"],
	});
	expect(record?.failureCode).toBe("PROVIDER_ERROR");
	expect(await engine.readResult("session-1", ["entry-1"])).toBe(
		"partial answer",
	);
	await operations.stop();
	store.close();
});

test("an unknown engine exception is recorded without its text", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	engine.throwFrom(new Error("provider said something quotable"));
	await operations.waitForIdle();
	const record = store.find(accepted.id);
	expect(record?.state).toBe("failed");
	expect(record?.failureCode).toBe("INTERNAL_ERROR");
	expect(record?.result).toEqual({
		kind: "failed",
		code: "PROVIDER_ERROR",
		entryIds: [],
	});
	expect(JSON.stringify(record)).not.toContain("quotable");
	await operations.stop();
	store.close();
});

test("a known engine failure keeps its own code", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	// Task 4's adapter raises a wider vocabulary than `RunResult.failed` can carry;
	// the coordinator keeps the precise code and reports the coarse class alongside.
	engine.throwFrom(new BrnError("SESSION_MISMATCH"));
	await operations.waitForIdle();
	const record = store.find(accepted.id);
	expect(record?.state).toBe("failed");
	expect(record?.failureCode).toBe("SESSION_MISMATCH");
	await operations.stop();
	store.close();
});

test("an engine that refuses the run synchronously settles it once", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	// A guard that rejects the prompt before it reaches a provider may raise
	// synchronously; the operation is durably accepted by then, so it must settle
	// rather than hold the seat forever.
	engine.runThrows = new BrnError("SESSION_MISMATCH");
	const accepted = operations.submit(prompt(), "digest-a");
	expect(accepted.state).toBe("failed");
	expect(store.find(accepted.id)?.failureCode).toBe("SESSION_MISMATCH");
	expect(engine.calls).toHaveLength(0);
	await operations.waitForIdle();
	// The seat is free again.
	expect(
		operations.submit(prompt({ requestId: SECOND_ID }), "digest-b").state,
	).toBe("running");
	engine.complete("answer");
	await operations.waitForIdle();
	await operations.stop();
	store.close();
});

test("an admission that cannot be committed never reaches the engine", async () => {
	const store = openOperationStore(":memory:");
	const failing = storeFailingAt(store, "insert", new Error("commit refused"));
	const engine = new FakeEngine();
	const operations = createOperations({
		store: failing,
		engine,
		onChange: () => {},
	});
	expect(() => operations.submit(prompt(), "digest-a")).toThrow(
		"commit refused",
	);
	expect(engine.calls).toHaveLength(0);
	expect(operations.view().operation).toBeNull();
	// Nothing was admitted, so nothing is occupied: the next attempt reaches the
	// ledger again instead of reporting a phantom busy operation.
	expect(() => operations.submit(prompt(), "digest-a")).toThrow(
		"commit refused",
	);
	await operations.stop();
	store.close();
});

test("an admission that cannot start releases the seat", async () => {
	const store = openOperationStore(":memory:");
	const failing = storeFailingAt(
		store,
		"transition",
		new BrnError("STATE_UNAVAILABLE"),
	);
	const engine = new FakeEngine();
	const operations = createOperations({
		store: failing,
		engine,
		onChange: () => {},
	});
	expect(() => operations.submit(prompt(), "digest-a")).toThrow(
		"STATE_UNAVAILABLE",
	);
	// No run was started, so no settlement will ever release the seat.
	expect(engine.calls).toHaveLength(0);
	// The seat is free: a control does not touch the ledger, so if the coordinator
	// still held the operation this would refuse with a phantom `BUSY` and keep
	// refusing until the process restarts.
	expect(await operations.control(async () => "switched")).toBe("switched");
	// The durably accepted row still holds the ledger's own seat and is recovered
	// as interrupted by the next start.
	expect(store.latest()?.state).toBe("accepted");
	// A retry of the same request resolves to that row rather than reporting busy.
	expect(operations.submit(prompt(), "digest-a").state).toBe("accepted");
	expect(engine.calls).toHaveLength(0);
	await operations.stop();
	store.close();
});

test("a completion that cannot be committed keeps the operation occupied", async () => {
	const store = openOperationStore(":memory:");
	const failing = storeFailingAt(store, "finish", new Error("commit lost"));
	const engine = new FakeEngine();
	const operations = createOperations({
		store: failing,
		engine,
		onChange: () => {},
	});
	const accepted = operations.submit(prompt(), "digest-a");
	engine.complete("answer");
	// The original failure is preserved rather than reported as a saved result.
	await expect(operations.waitForIdle()).rejects.toThrow("commit lost");
	expect(store.find(accepted.id)?.state).toBe("running");
	expect(store.find(accepted.id)?.result).toBeNull();
	expect(() =>
		operations.submit(prompt({ requestId: SECOND_ID }), "b"),
	).toThrow("BUSY");
	// The lost write is recorded nowhere, so shutdown must not be the place it
	// disappears: it reaches the process owner's error handler.
	await expect(operations.stop()).rejects.toThrow("commit lost");
	expect(operations.view().accepting).toBe(false);
	store.close();
});

test("a duplicate completion signal commits no second outcome", async () => {
	const store = openOperationStore(":memory:");
	const count = { finishes: 0 };
	const engine = new FakeEngine();
	const operations = createOperations({
		store: storeCountingFinish(store, count),
		engine,
		onChange: () => {},
	});
	const accepted = operations.submit(prompt(), "digest-a");
	// Held before the run settles, so the second signal below comes from the run's
	// own handle rather than from a control the fake could no-op away.
	const handles = engine.handles();
	engine.complete("one");
	await operations.waitForIdle();
	const settled = store.find(accepted.id);
	expect(settled?.state).toBe("succeeded");
	expect(count.finishes).toBe(1);

	// The engine reports the same run as completed a second time, with a different
	// answer. Nothing about the recorded operation may move.
	handles.settle({
		kind: "completed",
		entryIds: ["entry-99"],
		truncated: true,
		usage: {
			input: 9,
			output: 9,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 18,
		},
	});
	await delay(1);
	expect(store.find(accepted.id)).toEqual(settled);
	expect(store.find(accepted.id)?.result).toEqual({
		kind: "completed",
		entryIds: ["entry-1"],
		truncated: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	});
	// No second outcome was even attempted, so a lost-write latch cannot be tripped
	// by a chatty engine.
	expect(count.finishes).toBe(1);
	// Admission was released exactly once, so the next prompt is admitted.
	const second = operations.submit(
		prompt({ requestId: SECOND_ID }),
		"digest-b",
	);
	expect(second.state).toBe("running");
	expect(operations.view().operation?.id).toBe(second.id);
	engine.complete("three");
	await operations.waitForIdle();
	expect(count.finishes).toBe(2);
	await operations.stop();
	store.close();
});

test("a late stream event cannot disturb settled or current work", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	let announcements = 0;
	const operations = createOperations({
		store,
		engine,
		onChange: () => {
			announcements += 1;
		},
	});
	const accepted = operations.submit(prompt(), "digest-a");
	const stale = engine.handles();
	engine.emitText("hello");
	engine.complete("hello");
	await operations.waitForIdle();
	const settled = store.find(accepted.id);

	const second = operations.submit(
		prompt({ requestId: SECOND_ID }),
		"digest-b",
	);
	const before = announcements;
	// The finished run streams more text, as an adapter with a straggling provider
	// write would. It belongs to neither the settled operation nor the live one.
	stale.emit({ type: "text", text: " and more" });
	expect(operations.view().liveText).toBe("");
	expect(operations.view().operation?.id).toBe(second.id);
	expect(store.find(accepted.id)).toEqual(settled);
	// Nothing changed, so nothing was announced.
	expect(announcements).toBe(before);
	engine.complete("second answer");
	await operations.waitForIdle();
	await operations.stop();
	store.close();
});

test("a prompt for another session or model is refused without mutation", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	try {
		expect(() =>
			operations.submit(prompt({ sessionId: "session-9" }), "digest-a"),
		).toThrow("SESSION_MISMATCH");
		expect(() =>
			operations.submit(
				prompt({ model: { provider: "test", id: "elsewhere" } }),
				"digest-a",
			),
		).toThrow("MODEL_MISMATCH");
		engine.forget();
		expect(() => operations.submit(prompt(), "digest-a")).toThrow(
			"SESSION_MISMATCH",
		);
		expect(store.latest()).toBeNull();
		expect(engine.calls).toHaveLength(0);
	} finally {
		await operations.stop();
		store.close();
	}
});

test("an exact duplicate still resolves after the conversation moved on", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	engine.complete("answer");
	await operations.waitForIdle();
	await operations.control(() => engine.create(MODEL));

	const resolved = operations.submit(prompt(), "digest-a");
	expect(resolved.id).toBe(accepted.id);
	expect(resolved.state).toBe("succeeded");
	expect(engine.calls).toHaveLength(1);
	await operations.stop();
	store.close();
});

test("cancelling an operation from another session leaves live work alone", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const finished = operations.submit(prompt(), "digest-a");
	engine.complete("answer");
	await operations.waitForIdle();
	const moved = await operations.control(() => engine.create(MODEL));

	const live = operations.submit(
		prompt({ requestId: SECOND_ID, sessionId: moved.id }),
		"digest-b",
	);
	expect((await operations.cancel(finished.id)).state).toBe("succeeded");
	expect(engine.cancelCount).toBe(0);
	expect(store.find(live.id)?.state).toBe("running");
	engine.complete("second answer");
	await operations.waitForIdle();
	expect(store.find(live.id)?.state).toBe("succeeded");
	await operations.stop();
	store.close();
});

test("a control excludes prompts and other controls while reads stay available", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const gate = deferred();
	const switching = operations.control(async () => {
		await gate.promise;
		return await engine.create(MODEL);
	});
	expect(operations.view().controlling).toBe(true);
	await expect(operations.control(async () => {})).rejects.toThrow("BUSY");
	expect(() => operations.submit(prompt(), "digest-a")).toThrow("BUSY");
	// Reads are unaffected by an in-flight switch.
	expect(operations.view().operation).toBeNull();
	expect(store.latest()).toBeNull();
	gate.release();
	const moved = await switching;
	expect(moved.id).toBe("session-2");
	expect(operations.view().controlling).toBe(false);
	// Admission works again once the switch settles.
	expect(
		operations.submit(prompt({ sessionId: moved.id }), "digest-a").state,
	).toBe("running");
	engine.complete("answer");
	await operations.waitForIdle();
	await operations.stop();
	store.close();
});

test("a failed control releases exclusion", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	await expect(
		operations.control(async () => {
			throw new Error("switch refused");
		}),
	).rejects.toThrow("switch refused");
	expect(operations.view().controlling).toBe(false);
	expect(operations.submit(prompt(), "digest-a").state).toBe("running");
	engine.complete("answer");
	await operations.waitForIdle();
	await operations.stop();
	store.close();
});

test("shutdown waits for a pending control and then refuses new work", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const operations = createOperations({ store, engine, onChange: () => {} });
	const gate = deferred();
	const switching = operations.control(async () => {
		await gate.promise;
	});
	let stopped = false;
	const stopping = operations.stop().then(() => {
		stopped = true;
	});
	await delay(5);
	expect(stopped).toBe(false);
	// Admission closes immediately, before the pending control finishes.
	expect(() => operations.submit(prompt(), "digest-a")).toThrow(
		"SERVICE_STOPPING",
	);
	await expect(operations.control(async () => {})).rejects.toThrow(
		"SERVICE_STOPPING",
	);
	gate.release();
	await switching;
	await stopping;
	expect(stopped).toBe(true);
	expect(operations.view().accepting).toBe(false);
	store.close();
});

test("shutdown stays stopping while the engine has not settled", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	engine.abortSettles = false;
	const operations = createOperations({ store, engine, onChange: () => {} });
	const accepted = operations.submit(prompt(), "digest-a");
	let stopped = false;
	const stopping = operations.stop().then(() => {
		stopped = true;
	});
	await delay(5);
	// No second writer is enabled while provider work is unsettled.
	expect(stopped).toBe(false);
	expect(engine.cancelCount).toBe(1);
	expect(store.find(accepted.id)?.state).toBe("cancelling");
	engine.complete("late answer");
	await stopping;
	expect(stopped).toBe(true);
	expect(store.find(accepted.id)?.state).toBe("succeeded");
	store.close();
});

test("each change announces a coherent snapshot", async () => {
	const store = openOperationStore(":memory:");
	const engine = new FakeEngine();
	const views: OperationView[] = [];
	const operations = createOperations({
		store,
		engine,
		onChange: () => views.push(operations.view()),
	});
	const accepted = operations.submit(prompt(), "digest-a");
	expect(views.at(-1)?.operation?.state).toBe("running");
	engine.emitText("hel");
	engine.emitText("lo");
	expect(views.at(-1)?.liveText).toBe("hello");
	engine.complete("hello");
	await operations.waitForIdle();
	const last = views.at(-1);
	expect(last?.operation).toEqual(store.find(accepted.id));
	expect(last?.operation?.state).toBe("succeeded");
	// The final snapshot still carries the preview alongside the durable result.
	expect(last?.liveText).toBe("hello");
	expect(last?.accepting).toBe(true);
	await operations.stop();
	store.close();
});
