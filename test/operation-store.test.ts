import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type {
	OperationState,
	PromptCommand,
	RunResult,
} from "../src/core/conversation.ts";
import { openOperationStore } from "../src/service/operation-store.ts";
import { openDatabase } from "../src/service/sqlite.ts";

const UNFINISHED: readonly OperationState[] = [
	"accepted",
	"running",
	"cancelling",
];

async function storePath(prefix: string): Promise<string> {
	const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
	return join(root, "operations.sqlite");
}

function prompt(overrides: Partial<PromptCommand> = {}): PromptCommand {
	return {
		requestId: "11111111-1111-4111-8111-111111111111",
		sessionId: "session-1",
		model: { provider: "test", id: "offline" },
		text: "synthetic prompt",
		...overrides,
	};
}

const completed: RunResult = {
	kind: "completed",
	entryIds: ["entry-1"],
	truncated: false,
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
};

test("an inserted operation records identity and digest, never prompt text", async () => {
	const path = await storePath("brn-store-insert-");
	const store = openOperationStore(path);
	try {
		const admitted = store.insert(prompt(), "digest-a");
		expect(admitted).toEqual({
			id: "11111111-1111-4111-8111-111111111111",
			sessionId: "session-1",
			requestHash: "digest-a",
			state: "accepted",
			result: null,
			failureCode: null,
		});
	} finally {
		store.close();
	}
	// The ledger is not a transcript: the submitted text is nowhere on disk.
	const bytes = await readFile(path);
	expect(bytes.includes(Buffer.from("synthetic prompt", "utf8"))).toBe(false);
});

test("a reopened ledger keeps its schema and its rows", async () => {
	const path = await storePath("brn-store-reopen-");
	const first = openOperationStore(path);
	first.insert(prompt(), "digest-a");
	first.finish("11111111-1111-4111-8111-111111111111", completed);
	first.close();

	const second = openOperationStore(path);
	try {
		const found = second.find("11111111-1111-4111-8111-111111111111");
		expect(found?.state).toBe("succeeded");
		expect(found?.result).toEqual(completed);
	} finally {
		second.close();
	}
});

for (const state of UNFINISHED) {
	test(`a restart interrupts an operation left ${state}`, async () => {
		const path = await storePath(`brn-store-restart-${state}-`);
		const before = openOperationStore(path);
		const admitted = before.insert(prompt(), "digest-a");
		if (state !== "accepted") {
			before.transition(admitted.id, ["accepted"], state);
		}
		before.close();

		const after = openOperationStore(path);
		try {
			// Reopening reports nothing by itself: recovery is an explicit decision of
			// the process that owns the writer lock.
			expect(after.find(admitted.id)?.state).toBe(state);
			expect(after.interruptUnfinished()).toBe(1);
			const recovered = after.find(admitted.id);
			expect(recovered?.state).toBe("interrupted");
			expect(recovered?.failureCode).toBe("SERVICE_INTERRUPTED");
			expect(recovered?.result).toBeNull();
			// Recovery is idempotent and never touches a finished row.
			expect(after.interruptUnfinished()).toBe(0);
		} finally {
			after.close();
		}
	});
}

test("recovery leaves finished operations alone", async () => {
	const store = openOperationStore(":memory:");
	try {
		const admitted = store.insert(prompt(), "digest-a");
		store.finish(admitted.id, completed);
		expect(store.interruptUnfinished()).toBe(0);
		expect(store.find(admitted.id)?.state).toBe("succeeded");
	} finally {
		store.close();
	}
});

test("only one unfinished operation may exist at a time", async () => {
	const store = openOperationStore(":memory:");
	try {
		store.insert(prompt(), "digest-a");
		expect(() =>
			store.insert(
				prompt({ requestId: "22222222-2222-4222-8222-222222222222" }),
				"digest-b",
			),
		).toThrow("BUSY");
		// Finishing the first one frees admission again, and finished rows accumulate.
		store.finish("11111111-1111-4111-8111-111111111111", completed);
		for (let index = 0; index < 3; index += 1) {
			const id = `3333333${index}-3333-4333-8333-333333333333`;
			store.insert(prompt({ requestId: id }), `digest-${index}`);
			store.finish(id, { kind: "cancelled", entryIds: [] });
		}
		expect(store.latest()?.id).toBe("33333332-3333-4333-8333-333333333333");
	} finally {
		store.close();
	}
});

test("a reused request ID is refused rather than overwritten", async () => {
	const store = openOperationStore(":memory:");
	try {
		const admitted = store.insert(prompt(), "digest-a");
		store.finish(admitted.id, completed);
		expect(() => store.insert(prompt(), "digest-b")).toThrow(
			"REQUEST_ID_REUSED",
		);
		expect(store.find(admitted.id)?.requestHash).toBe("digest-a");
	} finally {
		store.close();
	}
});

test("a transition requires an allowed prior state", async () => {
	const store = openOperationStore(":memory:");
	try {
		const admitted = store.insert(prompt(), "digest-a");
		expect(store.transition(admitted.id, ["accepted"], "running").state).toBe(
			"running",
		);
		expect(() =>
			store.transition(admitted.id, ["accepted"], "running"),
		).toThrow("OPERATION_CONFLICT");
		expect(() =>
			store.transition(
				"44444444-4444-4444-8444-444444444444",
				["accepted"],
				"running",
			),
		).toThrow("OPERATION_CONFLICT");
		// The refused transition changed nothing.
		expect(store.find(admitted.id)?.state).toBe("running");
	} finally {
		store.close();
	}
});

const outcomes: ReadonlyArray<{
	readonly name: string;
	readonly result: RunResult;
	readonly failureCode?: string;
	readonly state: OperationState;
}> = [
	{ name: "a completed run", result: completed, state: "succeeded" },
	{
		name: "a cancelled run",
		result: { kind: "cancelled", entryIds: ["entry-1"] },
		state: "cancelled",
	},
	{
		name: "a cancelled run past its deadline",
		result: { kind: "cancelled", entryIds: [] },
		failureCode: "DEADLINE_EXCEEDED",
		state: "cancelled",
	},
	{
		name: "a failed run with a partial answer",
		result: { kind: "failed", code: "PROVIDER_ERROR", entryIds: ["entry-1"] },
		failureCode: "PROVIDER_ERROR",
		state: "failed",
	},
];

for (const outcome of outcomes) {
	test(`${outcome.name} round-trips through the ledger`, async () => {
		const store = openOperationStore(":memory:");
		try {
			const admitted = store.insert(prompt(), "digest-a");
			const finished =
				outcome.failureCode === undefined
					? store.finish(admitted.id, outcome.result)
					: store.finish(admitted.id, outcome.result, outcome.failureCode);
			expect(finished.state).toBe(outcome.state);
			expect(finished.result).toEqual(outcome.result);
			expect(finished.failureCode).toBe(outcome.failureCode ?? null);
			expect(store.find(admitted.id)).toEqual(finished);
			// A finished operation is final: a second outcome is a conflict.
			expect(() => store.finish(admitted.id, outcome.result)).toThrow(
				"OPERATION_CONFLICT",
			);
		} finally {
			store.close();
		}
	});
}

test("a newer schema version is refused, not migrated backwards", async () => {
	const path = await storePath("brn-store-newer-");
	openOperationStore(path).close();
	const raw = openDatabase(path);
	raw.exec("PRAGMA user_version=2");
	raw.close();

	expect(() => openOperationStore(path)).toThrow("STATE_VERSION_UNSUPPORTED");
});

test("a database that is not a BRN ledger is refused, never rebuilt", async () => {
	const path = await storePath("brn-store-corrupt-");
	await writeFile(path, "this is not a database", { mode: 0o600 });

	expect(() => openOperationStore(path)).toThrow("STATE_CORRUPT");
	// Authoritative state is not disposable: the bytes are still there.
	expect(await readFile(path, "utf8")).toBe("this is not a database");
});

test("a tampered stored result is refused rather than trusted", async () => {
	const path = await storePath("brn-store-tampered-");
	const store = openOperationStore(path);
	const admitted = store.insert(prompt(), "digest-a");
	store.finish(admitted.id, completed);
	store.close();

	const raw = openDatabase(path);
	raw
		.prepare("UPDATE operations SET result_json = ? WHERE id = ?")
		.run('{"kind":"teleported"}', admitted.id);
	raw.close();

	const reopened = openOperationStore(path);
	try {
		expect(() => reopened.find(admitted.id)).toThrow("STATE_CORRUPT");
	} finally {
		reopened.close();
	}
});

test("a blocked write stays visible and blocks later mutations", async () => {
	const path = await storePath("brn-store-unavailable-");
	const store = openOperationStore(path);
	const blocker = openDatabase(path);
	try {
		blocker.exec("BEGIN EXCLUSIVE");
		expect(() => store.insert(prompt(), "digest-a")).toThrow(
			"STATE_UNAVAILABLE",
		);
		blocker.exec("ROLLBACK");
		// The write failure is not forgotten once the lock clears: the ledger stops
		// accepting mutations instead of pretending the lost write happened.
		expect(() => store.insert(prompt(), "digest-a")).toThrow(
			"STATE_UNAVAILABLE",
		);
		expect(() => store.interruptUnfinished()).toThrow("STATE_UNAVAILABLE");
		// Reads stay available so the service can still report what it knows.
		expect(store.find("11111111-1111-4111-8111-111111111111")).toBeNull();
		expect(store.latest()).toBeNull();
	} finally {
		blocker.close();
		store.close();
	}
});
