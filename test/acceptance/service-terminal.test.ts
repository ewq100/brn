/**
 * Capability A's process-lifetime acceptance journeys.
 *
 * Every test here drives real spawned processes, real signals — including
 * `SIGKILL` and `SIGSTOP` — real loopback sockets and the real filesystem. The
 * only substitutions are the ones the test composition entry may make: the
 * deterministic engine, for admission and scheduling races that must not depend
 * on timing, and the real Pi adapter over the SDK's own faux provider, for every
 * journey whose subject is whether native results survive the death of a
 * process. The in-memory fake cannot prove that, so it is never used for it.
 *
 * Nothing here contacts a model provider. The authorized live proof lives in
 * `test/live/provider-chat.test.ts` and is excluded from this suite.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { type Client, connect } from "../../src/cli/client.ts";
import { failureCode, failureStatus } from "../../src/cli/commands.ts";
import { decodeSse } from "../../src/cli/sse.ts";
import type { ModelId, PromptCommand } from "../../src/core/conversation.ts";
import {
	MAX_PROMPT_BYTES,
	ModelsResponseSchema,
	OperationSchema,
	SessionInfoSchema,
	SnapshotSchema,
	type StreamEvent,
} from "../../src/protocol/contracts.ts";
import { MAX_RESPONSE_TOKENS } from "../../src/service/pi/runtime.ts";
import { openDatabase } from "../../src/service/sqlite.ts";
import { FAKE_MODEL, FAKE_SESSION_ID } from "../support/fake-engine.ts";
import {
	extensionMarker,
	isolatedChildEnvironment,
	OFFLINE_MODEL,
	plantAmbientResources,
	SENTINEL,
} from "../support/pi.ts";
import {
	type ChildNotice,
	type Failpoint,
	type ProviderRequestSummary,
	readDiscovery,
	runCli,
	type ServiceHandle,
	spawnService,
} from "../support/process.ts";

const run = promisify(execFile);

/** How long a journey waits for a state it expects to arrive. */
const SETTLE_TIMEOUT_MS = 20_000;
const POLL_MS = 10;

/** The states that still occupy the single-operation slot. */
const UNFINISHED = new Set(["accepted", "running", "cancelling"]);

async function makeBase(): Promise<string> {
	return await mkdtemp(join(await realpath(tmpdir()), "brn-acceptance-"));
}

/** A digest of every file under `root`, so "nothing was touched" is checkable. */
async function hashTree(root: string): Promise<Record<string, string>> {
	const digests: Record<string, string> = {};
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			digests[relative(root, path)] = createHash("sha256")
				.update(await readFile(path))
				.digest("hex");
		}
	}
	await walk(root);
	return digests;
}

/** The one native session file a journey's state root holds. */
async function readSessionFile(root: string): Promise<string> {
	const sessions = join(root, "sessions");
	const files = (await readdir(sessions)).filter((name) =>
		name.endsWith(".jsonl"),
	);
	expect(files).toHaveLength(1);
	return await readFile(join(sessions, files[0] ?? ""), "utf8");
}

/**
 * The status and fixed code a refused request carried, read back through the
 * client's own helpers, or a description of what the call did instead.
 */
async function refusedAs(action: () => Promise<unknown>): Promise<string> {
	try {
		await action();
	} catch (error) {
		const status = failureStatus(error);
		if (status === null) return `unexpected: ${String(error)}`;
		return `${status} ${failureCode(error) ?? "no_code"}`;
	}
	return "resolved";
}

function timeout<T>(ms: number, value: T): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function until(
	condition: () => Promise<boolean>,
	description: string,
): Promise<void> {
	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	while (!(await condition())) {
		if (Date.now() > deadline)
			throw new Error(`timed out waiting: ${description}`);
		await timeout(POLL_MS, undefined);
	}
}

/** Which engine a journey's service is composed with. */
type EngineKind = "fake" | "pi-faux";

interface ScenarioOptions {
	readonly engine?: EngineKind;
	/** Arms a test-only failpoint in the composition harness. */
	readonly pauseAt?: Failpoint;
	/** The answer the faux provider returns, for a `pi-faux` journey. */
	readonly answer?: string;
	readonly maxBufferedBytes?: number;
	/** Plants the personal Pi installation BRN must never load. */
	readonly poisonAmbient?: boolean;
}

/**
 * One acceptance journey: a real service process, a real attached client, and the
 * counters the journey asserts on.
 *
 * The counters live here, in the test process, and are accumulated from what the
 * child reports as it happens. A count kept inside the service, or in BRN's own
 * state, would reset to zero when the process is killed and could satisfy a
 * "nothing was replayed" assertion by having forgotten the replay.
 */
interface Scenario {
	readonly root: string;
	readonly home: string;
	/** The live service process. Replaced by `restart()`. */
	readonly service: ServiceHandle;
	/** The attached client. Replaced by `restart()` and `reconnect()`. */
	readonly client: Client;
	readonly sessionId: string;
	readonly model: ModelId;
	prompt(requestId: string, text: string): PromptCommand;
	/** Submits without waiting for the submission's own response. */
	submitWithoutWaiting(requestId: string, text: string): Promise<void>;
	waitForFailpoint(): Promise<Failpoint>;
	/** Waits for an operation to reach a settled state and reports it. */
	settled(id: string): Promise<string>;
	waitForState(id: string, state: string): Promise<void>;
	/** Waits for the deterministic engine to be running. */
	awaitRunning(): Promise<void>;
	completeFake(text: string): Promise<void>;
	emitFake(text: string): Promise<void>;
	/** Leaves a cancellation unsettled, as an uncooperative provider would. */
	stallCancel(): Promise<void>;
	/** Rescripts the faux provider, optionally as a provider error. */
	script(text: string, failed?: boolean): Promise<void>;
	/** Starts a fresh service process on the same state directory. */
	restart(options?: { readonly pauseAt?: Failpoint }): Promise<void>;
	reconnect(): Promise<Client>;
	/** Re-hosts the conversation this journey created. */
	resume(): Promise<void>;
	/**
	 * How many prompt runs the composed engine was actually asked to start, across
	 * every process this journey has run.
	 */
	fakeCallCount(): Promise<number>;
	/** Every request the real SDK made to the faux provider, in order. */
	providerRequests(): readonly ProviderRequestSummary[];
	close(): Promise<void>;
}

async function startAcceptanceScenario(
	options: ScenarioOptions = {},
): Promise<Scenario> {
	const engine = options.engine ?? "fake";
	const base = await makeBase();
	const root = join(base, "state");
	const home = join(base, "home");
	await mkdir(root, { mode: 0o700 });
	await mkdir(home, { mode: 0o700 });
	if (engine === "pi-faux") {
		// Created before the host validates it, so anything planted in the
		// conversation's working directory is already there when it starts.
		await mkdir(join(root, "work"), { mode: 0o700 });
		if (options.poisonAmbient === true) {
			await plantAmbientResources(home, join(root, "work"));
		}
	}

	let runs = 0;
	const providerRequests: ProviderRequestSummary[] = [];
	const failpoints: Failpoint[] = [];
	const onNotice = (notice: ChildNotice) => {
		if (notice.type === "engine-run") runs += 1;
		else if (notice.type === "failpoint") failpoints.push(notice.name);
		else providerRequests.push(notice.request);
	};

	const answer = options.answer ?? "synthetic faux answer";
	async function spawn(pauseAt: Failpoint | undefined): Promise<ServiceHandle> {
		return await spawnService(root, {
			...(engine === "fake"
				? { fakeEngine: true }
				: {
						piFauxProvider: true,
						answer,
						// The child sees no inherited provider credential and no personal
						// Pi installation: only the planted tree.
						env: isolatedChildEnvironment(home),
					}),
			...(pauseAt === undefined ? {} : { failpoint: pauseAt }),
			...(options.maxBufferedBytes === undefined
				? {}
				: { maxBufferedBytes: options.maxBufferedBytes }),
			onNotice,
		});
	}

	let service = await spawn(options.pauseAt);
	/** True while the live process holds a failpoint that could refuse to settle. */
	let armed = options.pauseAt !== undefined;
	let client = await connect(root);
	const clients: Client[] = [client];
	let sessionId = FAKE_SESSION_ID;
	let model: ModelId = { ...FAKE_MODEL };

	if (engine === "pi-faux") {
		const created = await client.request(
			"POST",
			"/v1/sessions",
			SessionInfoSchema,
			{ model: OFFLINE_MODEL },
			{ accept: [201] },
		);
		sessionId = created.id;
		model = { ...OFFLINE_MODEL };
	}

	async function control(command: {
		action:
			| "ping"
			| "awaitRunning"
			| "complete"
			| "emit"
			| "stallCancel"
			| "script";
		text?: string;
		failed?: boolean;
	}): Promise<unknown> {
		return await service.fake(command);
	}

	const scenario: Scenario = {
		root,
		home,
		get service() {
			return service;
		},
		get client() {
			return client;
		},
		get sessionId() {
			return sessionId;
		},
		get model() {
			return model;
		},
		prompt(requestId, text) {
			return { requestId, sessionId, model: { ...model }, text };
		},
		async submitWithoutWaiting(requestId, text) {
			// The submission's own response is not awaited: the journey's subject is
			// what the service does after it admitted the work.
			void client.submit(this.prompt(requestId, text)).catch(() => undefined);
			await timeout(0, undefined);
		},
		async waitForFailpoint() {
			await until(
				async () => failpoints.length > 0,
				"the armed failpoint to be reached",
			);
			const reached = failpoints.at(-1);
			if (reached === undefined) throw new Error("no failpoint was reported");
			return reached;
		},
		async settled(id) {
			let state = "";
			await until(async () => {
				state = (await client.operation(id)).state;
				return !UNFINISHED.has(state);
			}, `operation ${id} to settle`);
			return state;
		},
		async waitForState(id, state) {
			await until(
				async () => (await client.operation(id)).state === state,
				`operation ${id} to be ${state}`,
			);
		},
		async awaitRunning() {
			expect(await control({ action: "awaitRunning" })).toBe(true);
		},
		async completeFake(text) {
			await this.awaitRunning();
			await control({ action: "complete", text });
		},
		async emitFake(text) {
			await this.awaitRunning();
			await control({ action: "emit", text });
		},
		async stallCancel() {
			await control({ action: "stallCancel" });
		},
		async script(text, failed = false) {
			await control({ action: "script", text, failed });
		},
		async restart(restartOptions = {}) {
			// A process still holding a failpoint would never settle its accepted work,
			// so it is killed rather than asked. One that has already gone is only
			// waited for.
			if (armed && !service.exited()) service.signal("SIGKILL");
			await service.close();
			for (const attached of clients) await attached.disconnect();
			clients.length = 0;
			service = await spawn(restartOptions.pauseAt);
			armed = restartOptions.pauseAt !== undefined;
			client = await connect(root);
			clients.push(client);
		},
		async reconnect() {
			client = await connect(root);
			clients.push(client);
			return client;
		},
		async resume() {
			await client.request("POST", "/v1/sessions/resume", SessionInfoSchema, {
				sessionId,
			});
		},
		async fakeCallCount() {
			// A reply on the same channel proves every notice the child sent before it
			// has already been delivered, so the count is not read early.
			await control({ action: "ping" });
			return runs;
		},
		providerRequests() {
			return providerRequests;
		},
		async close() {
			for (const attached of clients) await attached.disconnect();
			// A failpoint may be holding a run that will never settle, and a graceful
			// shutdown waits for accepted work. This is a test process, so it goes.
			if (armed && !service.exited()) service.signal("SIGKILL");
			await service.close();
			await rm(base, { recursive: true, force: true });
		},
	};
	return scenario;
}

test("a second start opens no writable state while the owner runs or is stopped", async () => {
	const scenario = await startAcceptanceScenario();
	try {
		const whileRunning = await spawnService(scenario.root, {
			expectReady: false,
		});
		expect(await whileRunning.exit).not.toBe(0);
		expect(whileRunning.output()).toContain("ALREADY_RUNNING");
		// The published document still names the owner, and nothing else bound.
		expect((await readDiscovery(scenario.root)).pid).toBe(scenario.service.pid);
		expect(whileRunning.output()).not.toContain("service.listening");

		const before = await hashTree(scenario.root);
		scenario.service.signal("SIGSTOP");
		const whileStopped = await spawnService(scenario.root, {
			expectReady: false,
		});
		expect(await whileStopped.exit).not.toBe(0);
		expect(whileStopped.output()).toContain("ALREADY_RUNNING");
		expect(whileStopped.output()).not.toContain("service.listening");
		// The kernel lock is held by a process that cannot answer for itself, and
		// the second process wrote nothing: no ledger byte, no session file and no
		// discovery document changed.
		expect(await hashTree(scenario.root)).toEqual(before);
	} finally {
		scenario.service.signal("SIGCONT");
		await scenario.close();
	}
});

test("a killed owner releases the lock, keeps its ledger and interrupts unfinished work", async () => {
	const scenario = await startAcceptanceScenario();
	const finished = randomUUID();
	const unfinished = randomUUID();
	try {
		await scenario.client.submit(scenario.prompt(finished, "first prompt"));
		await scenario.completeFake("durable first answer");
		expect(await scenario.settled(finished)).toBe("succeeded");

		await scenario.submitWithoutWaiting(unfinished, "second prompt");
		await scenario.awaitRunning();
		scenario.service.signal("SIGKILL");
		// A killed process reports no exit code, only the signal that ended it.
		expect(await scenario.service.exit).toBeNull();

		await scenario.restart();
		const preserved = await scenario.client.operation(finished);
		expect(preserved.state).toBe("succeeded");
		expect(preserved.result?.kind).toBe("completed");
		const interrupted = await scenario.client.operation(unfinished);
		expect(interrupted.state).toBe("interrupted");
		// `interrupted` is not `failed` and not `cancelled`, and it names why.
		expect(interrupted.failureCode).toBe("SERVICE_INTERRUPTED");
		expect(interrupted.result).toBeNull();
		// Two runs were started before the crash; the restart started none.
		expect(await scenario.fakeCallCount()).toBe(2);
	} finally {
		await scenario.close();
	}
});

test("restart never replays an interrupted accepted prompt", async () => {
	const scenario = await startAcceptanceScenario({
		pauseAt: "after-admission-before-run",
	});
	const id = "1534b4d4-8c6f-4f78-9424-eb05051d6a59";
	try {
		await scenario.submitWithoutWaiting(id, "synthetic crash case");
		await scenario.waitForFailpoint();
		scenario.service.signal("SIGKILL");
		await scenario.service.exit;
		await scenario.restart();
		expect((await scenario.client.operation(id)).state).toBe("interrupted");
		expect(await scenario.fakeCallCount()).toBe(0);
	} finally {
		await scenario.close();
	}
});

test("a client that exits during streaming loses neither the work nor its result", async () => {
	const scenario = await startAcceptanceScenario();
	const id = randomUUID();
	try {
		await scenario.client.submit(scenario.prompt(id, "streaming prompt"));
		await scenario.emitFake("partial ");
		// The client goes away. The accepted operation belongs to the service.
		await scenario.client.disconnect();
		await scenario.completeFake("the whole durable answer");

		const reattached = await scenario.reconnect();
		expect((await reattached.operation(id)).state).toBe("succeeded");
		expect((await reattached.result(id)).text).toBe("the whole durable answer");
		expect(await scenario.fakeCallCount()).toBe(1);
	} finally {
		await scenario.close();
	}
});

test("a lost success response is answered from the ledger, never paid for twice", async () => {
	const scenario = await startAcceptanceScenario();
	const id = randomUUID();
	try {
		await scenario.client.submit(scenario.prompt(id, "the same prompt"));
		await scenario.completeFake("the original answer");
		const original = await scenario.client.operation(id);
		expect(original.state).toBe("succeeded");

		// The client never saw the outcome and submits the identical request again.
		const repeated = await scenario.client.submit(
			scenario.prompt(id, "the same prompt"),
		);
		expect(repeated).toEqual(original);
		expect((await scenario.client.result(id)).text).toBe("the original answer");
		expect(await scenario.fakeCallCount()).toBe(1);
	} finally {
		await scenario.close();
	}
});

test("a changed payload under a saved request ID is refused, before and after a restart", async () => {
	const scenario = await startAcceptanceScenario();
	const id = randomUUID();
	try {
		await scenario.client.submit(scenario.prompt(id, "the original text"));
		await scenario.completeFake("the original answer");
		const original = await scenario.client.operation(id);

		expect(
			await refusedAs(() =>
				scenario.client.submit(scenario.prompt(id, "different text")),
			),
		).toBe("409 REQUEST_ID_REUSED");

		await scenario.restart();
		expect(
			await refusedAs(() =>
				scenario.client.submit(scenario.prompt(id, "different text")),
			),
		).toBe("409 REQUEST_ID_REUSED");
		// The identical payload still resolves to the original operation.
		expect(
			await scenario.client.submit(scenario.prompt(id, "the original text")),
		).toEqual(original);
		expect(await scenario.fakeCallCount()).toBe(1);
	} finally {
		await scenario.close();
	}
});

test("a durable native result whose ledger entry never finished is interrupted, not replayed", async () => {
	// The real adapter over the real SDK: the in-memory fake cannot show that a
	// native result outlived the process that produced it.
	const scenario = await startAcceptanceScenario({
		engine: "pi-faux",
		pauseAt: "after-native-result-before-ledger-finish",
		answer: "durable native answer",
	});
	const id = randomUUID();
	try {
		await scenario.submitWithoutWaiting(id, "synthetic prompt");
		await scenario.waitForFailpoint();
		scenario.service.signal("SIGKILL");
		await scenario.service.exit;
		// The adapter makes native bytes durable before it reports an outcome, so
		// the answer is on disk even though the ledger never finished.
		expect(await readSessionFile(scenario.root)).toContain(
			"durable native answer",
		);

		await scenario.restart();
		const record = await scenario.client.operation(id);
		expect(record.state).toBe("interrupted");
		expect(record.failureCode).toBe("SERVICE_INTERRUPTED");
		expect(record.result).toBeNull();
		// Its text is not invented from the native evidence either: the
		// interruption is reported as itself.
		expect(await refusedAs(() => scenario.client.result(id))).toBe(
			"503 SERVICE_INTERRUPTED",
		);

		// Reopening the conversation is not a replay.
		await scenario.resume();
		expect(scenario.providerRequests()).toHaveLength(1);
		const next = randomUUID();
		await scenario.client.submit(
			scenario.prompt(next, "second synthetic prompt"),
		);
		expect(await scenario.settled(next)).toBe("succeeded");
		const requests = scenario.providerRequests();
		expect(requests).toHaveLength(2);
		// The reopened history carries the interrupted operation's own answer.
		expect(requests[1]?.assistantTextCount).toBe(1);
	} finally {
		await scenario.close();
	}
});

test("a committed success no client was told about is recovered by operation ID", async () => {
	const scenario = await startAcceptanceScenario({
		engine: "pi-faux",
		pauseAt: "after-ledger-finish-before-http-response",
		answer: "the committed answer",
	});
	const id = randomUUID();
	try {
		await scenario.client.submit(scenario.prompt(id, "synthetic prompt"));
		await scenario.waitForFailpoint();
		// Even a client that asks cannot be told: the read of the durable answer
		// never returns.
		const asking = scenario.client
			.result(id)
			.then(() => "answered")
			.catch(() => "failed");
		expect(await Promise.race([asking, timeout(500, "pending")])).toBe(
			"pending",
		);
		scenario.service.signal("SIGKILL");
		await scenario.service.exit;

		await scenario.restart();
		// The outcome was committed before the process died, so it is recoverable.
		expect((await scenario.client.operation(id)).state).toBe("succeeded");
		await scenario.resume();
		expect((await scenario.client.result(id)).text).toBe(
			"the committed answer",
		);
		expect(scenario.providerRequests()).toHaveLength(1);
	} finally {
		await scenario.close();
	}
});

test("an unsettled abort keeps every session, model and prompt write busy", async () => {
	const scenario = await startAcceptanceScenario();
	const id = randomUUID();
	try {
		await scenario.client.submit(scenario.prompt(id, "a long running prompt"));
		await scenario.awaitRunning();
		await scenario.stallCancel();
		const cancelling = scenario.client
			.request(
				"POST",
				`/v1/operations/${id}/cancel`,
				OperationSchema,
				{ confirmed: true },
				{ timeoutMs: SETTLE_TIMEOUT_MS },
			)
			.then(() => "settled")
			.catch((error: unknown) => `failed: ${String(error)}`);
		await scenario.waitForState(id, "cancelling");

		// The seat is still occupied: nothing is queued behind an operation that
		// has been asked to stop and has not stopped.
		expect(
			await refusedAs(() =>
				scenario.client.submit(scenario.prompt(randomUUID(), "a new prompt")),
			),
		).toBe("409 BUSY");
		expect(
			await refusedAs(() =>
				scenario.client.request(
					"POST",
					"/v1/sessions",
					SessionInfoSchema,
					{ model: scenario.model },
					{ accept: [201] },
				),
			),
		).toBe("409 BUSY");
		expect(
			await refusedAs(() =>
				scenario.client.request("POST", "/v1/model", SessionInfoSchema, {
					model: scenario.model,
				}),
			),
		).toBe("409 BUSY");
		expect(
			await refusedAs(() =>
				scenario.client.request(
					"POST",
					"/v1/sessions/resume",
					SessionInfoSchema,
					{ sessionId: scenario.sessionId },
				),
			),
		).toBe("409 BUSY");

		// Once the run finally settles, the cancellation request is answered.
		await scenario.completeFake("a late answer");
		expect(await cancelling).toBe("settled");
		expect(await scenario.fakeCallCount()).toBe(1);
	} finally {
		await scenario.close();
	}
});

test("startup refuses a corrupt ledger without deleting or rebuilding it", async () => {
	const base = await makeBase();
	const root = join(base, "state");
	await mkdir(root, { mode: 0o700 });
	try {
		const first = await spawnService(root, { fakeEngine: true });
		await first.close();
		const ledger = join(root, "operations.sqlite");
		const bytes = await readFile(ledger);
		// The header stays, so the file still opens as a database; its first page's
		// interior does not.
		bytes.fill(0x5a, 120, 400);
		await writeFile(ledger, bytes);
		const corrupted = await hashTree(root);

		const refused = await spawnService(root, {
			fakeEngine: true,
			expectReady: false,
		});
		expect(await refused.exit).not.toBe(0);
		expect(refused.output()).toContain("STATE_CORRUPT");
		// Authoritative state is not disposable: the bytes are exactly as they were.
		expect(await hashTree(root)).toEqual(corrupted);
		expect(existsSync(join(root, "discovery.json"))).toBe(false);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("startup refuses a ledger written by a newer BRN without touching its bytes", async () => {
	const base = await makeBase();
	const root = join(base, "state");
	await mkdir(root, { mode: 0o700 });
	try {
		const first = await spawnService(root, { fakeEngine: true });
		await first.close();
		const ledger = join(root, "operations.sqlite");
		const database = openDatabase(ledger);
		database.exec("PRAGMA user_version=999");
		database.close();
		const newer = await hashTree(root);

		const refused = await spawnService(root, {
			fakeEngine: true,
			expectReady: false,
		});
		expect(await refused.exit).not.toBe(0);
		// A version mismatch is its own report, not "corrupt", and never a downgrade.
		expect(refused.output()).toContain("STATE_VERSION_UNSUPPORTED");
		expect(refused.output()).not.toContain("STATE_CORRUPT");
		expect(await hashTree(root)).toEqual(newer);

		// The version it refused is the version still recorded: nothing downgraded
		// the file to a schema this build would have accepted.
		const reopened = openDatabase(ledger);
		try {
			expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
				user_version: 999,
			});
		} finally {
			reopened.close();
		}
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a dropped or unread stream resynchronises from the current snapshot", async () => {
	const scenario = await startAcceptanceScenario({
		maxBufferedBytes: 64 * 1024,
	});
	const id = randomUUID();
	try {
		const unread = await scenario.service.openUnreadStream("/v1/events");
		await scenario.client.submit(scenario.prompt(id, "a streamed prompt"));
		// Each change republishes the whole preview, so a connection nobody reads
		// passes its ceiling and loses its stream while the preview stays inside
		// the coordinator's own limit.
		for (let round = 0; round < 12; round += 1) {
			await scenario.emitFake("x".repeat(64 * 1024));
		}
		await unread.drain();

		const reattached = await scenario.reconnect();
		const snapshot = await reattached.request(
			"GET",
			"/v1/snapshot",
			SnapshotSchema,
		);
		expect(snapshot.work.operation?.id).toBe(id);
		expect(snapshot.work.operation?.state).toBe("running");
		expect(snapshot.work.liveText.length).toBeGreaterThan(0);

		// A fresh stream begins with the current state rather than replaying any.
		const events = await reattached.events();
		const iterator = decodeSse(events)[Symbol.asyncIterator]();
		const first = await iterator.next();
		const event = first.value as StreamEvent;
		expect(event.type).toBe("snapshot");
		expect(event.snapshot.work.operation?.id).toBe(id);
		await iterator.return?.(undefined);

		await scenario.completeFake("finished anyway");
		expect((await reattached.operation(id)).state).toBe("succeeded");
		// The operation a severed reader was watching ran exactly once.
		expect(await scenario.fakeCallCount()).toBe(1);
	} finally {
		await scenario.close();
	}
});

test("poisoned ambient configuration reaches neither the request nor the process", async () => {
	const scenario = await startAcceptanceScenario({
		engine: "pi-faux",
		poisonAmbient: true,
		answer: "a clean answer",
	});
	const id = randomUUID();
	try {
		// The planted personal catalog offers a sentinel model. Nothing offers it.
		expect(
			await scenario.client.request("GET", "/v1/models", ModelsResponseSchema),
		).toEqual({ models: [OFFLINE_MODEL] });

		await scenario.client.submit(scenario.prompt(id, "a synthetic prompt"));
		expect(await scenario.settled(id)).toBe("succeeded");

		const request = scenario.providerRequests().at(0);
		expect(request).toBeDefined();
		// No tool, no personal instruction, and BRN's own output ceiling.
		expect(request?.toolNames).toEqual([]);
		expect(request?.systemPromptHasSentinel).toBe(false);
		expect(request?.messagesHaveSentinel).toBe(false);
		expect(request?.maxTokens).toBeLessThanOrEqual(MAX_RESPONSE_TOKENS);
		// The planted extension writes a file if it is ever loaded and run.
		expect(existsSync(extensionMarker(scenario.home))).toBe(false);
		expect(scenario.service.output()).not.toContain(SENTINEL);
	} finally {
		await scenario.close();
	}
});

test("a sensitive marker stays out of the operational log", async () => {
	const promptMarker = "BRN-SENSITIVE-PROMPT-8f2c";
	const answerMarker = "BRN-SENSITIVE-ANSWER-4a71";
	const errorMarker = "BRN-SENSITIVE-ERROR-19be";
	const scenario = await startAcceptanceScenario({
		engine: "pi-faux",
		answer: `an answer containing ${answerMarker}`,
	});
	const answered = randomUUID();
	const failed = randomUUID();
	try {
		await scenario.client.submit(
			scenario.prompt(
				answered,
				`a synthetic prompt containing ${promptMarker}`,
			),
		);
		expect(await scenario.settled(answered)).toBe("succeeded");
		// Present exactly where it was deliberately stored and displayed.
		expect((await scenario.client.result(answered)).text).toContain(
			answerMarker,
		);

		await scenario.script(`a provider failure mentioning ${errorMarker}`, true);
		await scenario.client.submit(
			scenario.prompt(failed, "a second synthetic prompt"),
		);
		expect(await scenario.settled(failed)).toBe("failed");
		const record = await scenario.client.operation(failed);
		// The record names a class of failure and carries no provider text.
		expect(record.result?.kind).toBe("failed");
		expect(JSON.stringify(record)).not.toContain(errorMarker);

		const log = scenario.service.output();
		// The log is real: it records this instance and its operations.
		expect(log).toContain("service.listening");
		expect(log).not.toContain(promptMarker);
		expect(log).not.toContain(answerMarker);
		expect(log).not.toContain(errorMarker);
	} finally {
		await scenario.close();
	}
});

test("the client discloses the seated identity and the operating limits before any submission", async () => {
	const scenario = await startAcceptanceScenario({ engine: "pi-faux" });
	try {
		// The real CLI, against the real service, with nothing submitted yet.
		const status = await runCli(["--state-dir", scenario.root, "status"]);
		expect(status.code).toBe(0);
		expect(status.output).toContain(scenario.sessionId);
		expect(status.output).toContain(
			`${OFFLINE_MODEL.provider}/${OFFLINE_MODEL.id}`,
		);
		expect(status.output).toContain(`prompt ${MAX_PROMPT_BYTES} bytes`);
		expect(status.output).toContain(`response ${MAX_RESPONSE_TOKENS} tokens`);
		expect(status.output).toContain("one operation at a time");
		expect(status.output).toContain(
			"A context window is not a spending limit.",
		);
		expect(status.output).toContain("Work: none");
		// Nothing was submitted to learn any of it.
		expect(scenario.providerRequests()).toHaveLength(0);
	} finally {
		await scenario.close();
	}
});

test("a stopped-service copy restored to a new root resolves its operations and native results", async () => {
	const scenario = await startAcceptanceScenario({
		engine: "pi-faux",
		answer: "the copied native answer",
	});
	const id = randomUUID();
	const restored = join(
		await realpath(tmpdir()),
		`brn-restored-${randomUUID()}`,
	);
	const restoredRequests: ProviderRequestSummary[] = [];
	try {
		await scenario.client.submit(scenario.prompt(id, "a synthetic prompt"));
		expect(await scenario.settled(id)).toBe("succeeded");
		expect((await scenario.client.result(id)).text).toBe(
			"the copied native answer",
		);

		// Stop the owner and wait for it before a byte is copied.
		await scenario.client.disconnect();
		scenario.service.signal("SIGTERM");
		expect(await scenario.service.exit).toBe(0);
		const original = await hashTree(scenario.root);

		// The complete root, including native sessions and any SQLite sidecar.
		await run("/bin/cp", ["-Rp", scenario.root, restored]);
		expect(await hashTree(restored)).toEqual(original);

		const copy = await spawnService(restored, {
			piFauxProvider: true,
			// A replay would answer differently, so an answer that still reads as the
			// original could not have come from a new provider request.
			answer: "a replayed answer",
			env: isolatedChildEnvironment(scenario.home),
			onNotice: (notice) => {
				if (notice.type === "provider-request") {
					restoredRequests.push(notice.request);
				}
			},
		});
		const copyClient = await connect(restored);
		try {
			expect((await copyClient.operation(id)).state).toBe("succeeded");
			// A restored root hosts no conversation until one is resumed, and an
			// answer is refused rather than invented in the meantime.
			expect(await refusedAs(() => copyClient.result(id))).toBe(
				"409 NO_ACTIVE_SESSION",
			);
			// The operation's own conversation is re-hosted from the copied bytes.
			const resumed = await copyClient.request(
				"POST",
				"/v1/sessions/resume",
				SessionInfoSchema,
				{ sessionId: scenario.sessionId },
			);
			expect(resumed).toEqual({
				id: scenario.sessionId,
				model: OFFLINE_MODEL,
			});
			expect((await copyClient.result(id)).text).toBe(
				"the copied native answer",
			);
			// Restoring and reading resolved references; it asked nothing of a provider.
			expect(restoredRequests).toHaveLength(0);
		} finally {
			await copyClient.disconnect();
			await copy.close();
		}
		// Only the restored copy was started, and the original root is untouched.
		expect(await hashTree(scenario.root)).toEqual(original);
	} finally {
		await rm(restored, { recursive: true, force: true });
		await scenario.close();
	}
});
