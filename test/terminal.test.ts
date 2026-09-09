import { createHash } from "node:crypto";
import type { Terminal } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { Client } from "../src/cli/client.ts";
import {
	formatContext,
	formatOperationRecord,
	formatResult,
	formatStatus,
	runCommand,
} from "../src/cli/commands.ts";
import { runTerminal, safeTerminalText } from "../src/cli/terminal.ts";
import type { PromptCommand, Usage } from "../src/core/conversation.ts";
import { type Snapshot, SnapshotSchema } from "../src/protocol/contracts.ts";
import {
	type FakeServiceHandle,
	spawnServiceWithFake,
} from "./support/process.ts";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_MS = 10;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
};

/**
 * An in-memory implementation of Pi's public `Terminal` interface.
 *
 * It is the interface `ProcessTerminal` implements, so the client under test is
 * the real one: only the device is substituted. It proves input mapping and
 * rendered content, and it proves nothing about a real terminal's raw mode —
 * that remains a manual check.
 */
class MemoryTerminal implements Terminal {
	columns = 120;
	rows = 40;
	readonly kittyProtocolActive = false;
	started = false;
	private readonly chunks: string[] = [];
	private onInput: ((data: string) => void) | null = null;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.onInput = onInput;
		this.started = true;
	}

	stop(): void {
		this.started = false;
		this.onInput = null;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.chunks.push(data);
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	/** Delivers one input sequence, exactly as `ProcessTerminal` would. */
	send(data: string): void {
		const handler = this.onInput;
		if (handler === null) throw new Error("terminal is not started");
		handler(data);
	}

	/** Everything the renderer has written so far. */
	output(): string {
		return this.chunks.join("");
	}
}

async function waitFor(
	label: string,
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`timed out waiting for ${label}`);
}

interface Attached {
	readonly terminal: MemoryTerminal;
	readonly finished: Promise<void>;
	type(text: string): void;
	paste(text: string): void;
	newline(): void;
	enter(): void;
	interrupt(): void;
	settled(): Promise<void>;
}

/** Attaches the real client to an in-memory terminal and waits for its first snapshot. */
async function attach(client: Client): Promise<Attached> {
	const terminal = new MemoryTerminal();
	const finished = runTerminal(client, { terminal });
	// Surface a startup failure here rather than as an unhandled rejection later.
	const guarded = finished.catch((error: unknown) => {
		throw error;
	});
	await waitFor("the terminal to start", () => terminal.started);
	await waitFor("the first snapshot", () =>
		terminal.output().includes("Tools: none (Capability A)"),
	);
	return {
		terminal,
		finished: guarded,
		type(text: string) {
			for (const character of text) terminal.send(character);
		},
		paste(text: string) {
			terminal.send(`\x1b[200~${text}\x1b[201~`);
		},
		newline() {
			terminal.send("\n");
		},
		enter() {
			terminal.send("\r");
		},
		interrupt() {
			terminal.send("\x03");
		},
		async settled() {
			// One macrotask turn is enough for the submit handler to reach the service.
			await new Promise((resolve) => setTimeout(resolve, 50));
		},
	};
}

function requestDigest(command: Omit<PromptCommand, "requestId">): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				1,
				command.sessionId,
				command.model.provider,
				command.model.id,
				command.text,
			]),
		)
		.digest("hex");
}

async function currentSnapshot(client: Client): Promise<Snapshot> {
	return await client.request("GET", "/v1/snapshot", SnapshotSchema);
}

async function activeOperationId(client: Client): Promise<string> {
	let id: string | undefined;
	await waitFor("an accepted operation", async () => {
		id = (await currentSnapshot(client)).work.operation?.id;
		return id !== undefined;
	});
	if (id === undefined) throw new Error("no operation");
	return id;
}

/** A snapshot whose server-controlled labels carry terminal escape sequences. */
function hostileSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		instanceId: "instance-test",
		sequence: 1,
		conversation: {
			session: {
				id: "\x1b]0;stolen\x07session-9",
				model: { provider: "\x1b[2Jprovider", id: "model\rrewritten" },
			},
			context: null,
			usage: ZERO_USAGE,
		},
		work: {
			operation: {
				id: "\x07operation-9",
				sessionId: "session-9",
				requestHash: "hash",
				state: "failed",
				result: { kind: "failed", code: "PROVIDER_ERROR", entryIds: [] },
				failureCode: "DEADLINE\x1b[31mEXCEEDED",
			},
			liveText: "",
			accepting: true,
			controlling: false,
			engineStatus: null,
		},
		...overrides,
	};
}

test("model text cannot emit terminal control sequences", () => {
	const attack = "\x1b]52;c;Y29weQ==\x07hello\rchanged\x1b[2J";
	const rendered = safeTerminalText(attack);
	expect(rendered).not.toContain("\x1b");
	expect(rendered).not.toContain("\x07");
	expect(rendered).not.toContain("\r");
	expect(rendered).toContain("hello");
});

test("sanitizing preserves newline and tab and survives a split sequence", () => {
	expect(safeTerminalText("a\nb\tc")).toBe("a\nb\tc");
	// An escape split over two stream frames is filtered because the whole
	// accumulated string is sanitized, not each frame.
	const first = "\x1b";
	const second = "[2Jgone";
	expect(safeTerminalText(first + second)).not.toContain("\x1b");
	// A C1 control in its single-byte form is replaced just as a C0 control is.
	expect(safeTerminalText("\u009bx")).not.toContain("\u009b");
});

test("every label an error, model or session can carry is sanitized", () => {
	const rendered = formatStatus(hostileSnapshot());
	for (const control of ["\x1b", "\x07", "\r", "\u009b"]) {
		expect(rendered).not.toContain(control);
	}
	expect(rendered).toContain("session-9");
	expect(rendered).toContain("provider");
	// The precise recorded reason is shown even though it is outside the run
	// result's own narrower vocabulary.
	expect(rendered).toContain("DEADLINE");
});

test("interrupted, failed and cancelled stay distinguishable", () => {
	const base = hostileSnapshot().work.operation;
	if (base === null) throw new Error("no operation");
	const interrupted = formatOperationRecord({
		...base,
		id: "op-1",
		failureCode: null,
		result: null,
		state: "interrupted",
	});
	const failed = formatOperationRecord({
		...base,
		id: "op-1",
		state: "failed",
		failureCode: "SERVICE_INTERRUPTED",
	});
	const cancelled = formatOperationRecord({
		...base,
		id: "op-1",
		state: "cancelled",
		failureCode: null,
		result: { kind: "cancelled", entryIds: [] },
	});
	expect(interrupted).toContain("interrupted");
	expect(interrupted).not.toContain("failed");
	expect(failed).toContain("failed");
	expect(failed).toContain("SERVICE_INTERRUPTED");
	expect(cancelled).toContain("cancelled");
	expect(cancelled).not.toContain("interrupted");
});

test("a failed run reports the code its result carries when nothing narrower exists", () => {
	const rendered = formatOperationRecord({
		id: "op-1",
		sessionId: "session-1",
		requestHash: "hash",
		state: "failed",
		result: { kind: "failed", code: "AUTH_REQUIRED", entryIds: [] },
		failureCode: null,
	});
	expect(rendered).toContain("AUTH_REQUIRED");
});

test("an unknown context is reported as unknown, never as zero", () => {
	expect(formatContext(null)).toContain("unknown");
	expect(formatContext(null)).not.toContain("0%");
	expect(
		formatContext({ tokens: null, contextWindow: 200_000, percent: null }),
	).toContain("unknown");
	const known = formatContext({
		tokens: 1_000,
		contextWindow: 200_000,
		percent: 0.5,
	});
	expect(known).toContain("1000");
	expect(known).toContain("200000");
});

test("a truncated answer is never presented as a complete one", () => {
	const truncated = formatResult({ text: "half an ans", truncated: true });
	expect(truncated).toContain("half an ans");
	expect(truncated.toLowerCase()).toContain("truncat");
	const complete = formatResult({ text: "all of it", truncated: false });
	expect(complete.toLowerCase()).not.toContain("truncat");
	// The operation record says so too, so a truncated run is not read as a plain
	// success anywhere.
	const record = formatOperationRecord({
		id: "op-1",
		sessionId: "session-1",
		requestHash: "hash",
		state: "succeeded",
		result: {
			kind: "completed",
			entryIds: ["entry-1"],
			truncated: true,
			usage: ZERO_USAGE,
		},
		failureCode: null,
	});
	expect(record.toLowerCase()).toContain("truncat");
	expect(record).toContain("not a complete answer");
});

test("a session identifier from the service reaches the display sanitized", async () => {
	const service = await spawnServiceWithFake();
	try {
		const hostile = "\x1b]0;pwned\x07session-evil";
		await runCommand(["resume", hostile], service.client, { write() {} });
		const snapshot = await currentSnapshot(service.client);
		expect(snapshot.conversation.session?.id).toBe(hostile);
		const rendered = formatStatus(snapshot);
		expect(rendered).not.toContain("\x1b");
		expect(rendered).not.toContain("\x07");
		expect(rendered).toContain("session-evil");
	} finally {
		await service.close();
	}
});

test("multiline UTF-8 input reaches the service byte for byte", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const session = await attach(client);
	try {
		session.paste("первая строка\nsecond ✅ line");
		session.newline();
		session.type("третья");
		session.enter();
		const id = await activeOperationId(client);
		const submitted = await client.operation(id);
		expect(submitted.requestHash).toBe(
			requestDigest({
				sessionId: "session-1",
				model: { provider: "test", id: "offline" },
				text: "первая строка\nsecond ✅ line\nтретья",
			}),
		);
		expect(await service.fakeCallCount()).toBe(1);
		await service.completeFake("ok");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("each submission allocates exactly one request identifier", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const session = await attach(client);
	try {
		session.type("first");
		session.enter();
		const first = await activeOperationId(client);
		await service.completeFake("one");
		await waitFor("the first result", async () => {
			return (await client.operation(first)).state === "succeeded";
		});

		session.type("second");
		session.enter();
		await waitFor("the second operation", async () => {
			const active = (await currentSnapshot(client)).work.operation;
			return active !== null && active.id !== first;
		});
		const second = (await currentSnapshot(client)).work.operation?.id;
		expect(second).not.toBe(first);
		expect(await service.fakeCallCount()).toBe(2);
		await service.completeFake("two");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("empty input costs nothing", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const session = await attach(client);
	try {
		session.enter();
		session.type("   ");
		session.enter();
		await session.settled();
		expect(await service.fakeCallCount()).toBe(0);
		expect((await currentSnapshot(client)).work.operation).toBeNull();
		expect(session.terminal.output()).toContain("Nothing to submit");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("a busy rejection keeps the typed text", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const other = await service.reconnect();
	const session = await attach(client);
	try {
		// Another client occupies the single seat first.
		const occupier = await other.submit(service.prompt("occupier"));
		await service.service.fake({ action: "awaitRunning" });

		session.type("retained text");
		session.enter();
		await waitFor("the busy rejection", () =>
			session.terminal.output().includes("BUSY"),
		);
		expect(await service.fakeCallCount()).toBe(1);

		await service.completeFake("occupier done");
		await waitFor("the seat to free", async () => {
			return (await other.operation(occupier.id)).state === "succeeded";
		});

		// The same text is still in the editor: submitting it now proves it was
		// never dropped.
		session.enter();
		let id: string | undefined;
		await waitFor("the retried submission", async () => {
			const active = (await currentSnapshot(other)).work.operation;
			if (active === null || active.id === occupier.id) return false;
			id = active.id;
			return true;
		});
		if (id === undefined) throw new Error("no second operation");
		expect((await other.operation(id)).requestHash).toBe(
			requestDigest({
				sessionId: "session-1",
				model: { provider: "test", id: "offline" },
				text: "retained text",
			}),
		);
		await service.completeFake("second done");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("a session change while composing does not reinterpret the typed text", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const other = await service.reconnect();
	const session = await attach(client);
	try {
		session.type("composed against the old session");
		// Another client switches the conversation underneath the composer.
		await runCommand(["new", "--model", "test/offline"], other, { write() {} });
		await waitFor("the new session in the terminal", () =>
			session.terminal.output().includes("session-2"),
		);

		session.enter();
		await waitFor("the session-change warning", () =>
			session.terminal.output().includes("session changed"),
		);
		expect(await service.fakeCallCount()).toBe(0);
		expect((await currentSnapshot(other)).work.operation).toBeNull();

		// A second, deliberate submission sends the retained text to the session it
		// is now composed against.
		session.enter();
		const id = await activeOperationId(other);
		expect((await other.operation(id)).requestHash).toBe(
			requestDigest({
				sessionId: "session-2",
				model: { provider: "test", id: "offline" },
				text: "composed against the old session",
			}),
		);
		await service.completeFake("done");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("Ctrl+C cancels the exact displayed operation and reports a partial answer", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const other = await service.reconnect();
	const session = await attach(client);
	try {
		session.type("slow work");
		session.enter();
		const id = await activeOperationId(other);
		await service.service.fake({ action: "awaitRunning" });
		await waitFor("the running operation on screen", () =>
			session.terminal.output().includes(id),
		);

		session.interrupt();
		await waitFor("cancellation to be requested", () =>
			session.terminal.output().includes(`Cancellation requested for ${id}`),
		);
		await waitFor("the operation to settle", async () => {
			return (await other.operation(id)).state === "cancelled";
		});
		// A cancelled answer is partial, and the client says so.
		await waitFor("the partial-answer notice", () =>
			session.terminal.output().toLowerCase().includes("truncat"),
		);
		// Cancellation never stops the owner process.
		expect((await service.service.request("/v1/health")).status).toBe(200);
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("idle Ctrl+C detaches without stopping the service", async () => {
	const service = await spawnServiceWithFake();
	const session = await attach(service.client);
	try {
		session.interrupt();
		await session.finished;
		expect((await service.service.request("/v1/health")).status).toBe(200);
		expect(service.service.output()).not.toContain("service.stopped");
	} finally {
		await service.close();
	}
});

test("/quit detaches during active work and says the work continues", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const other = await service.reconnect();
	const session = await attach(client);
	try {
		session.type("long running");
		session.enter();
		const id = await activeOperationId(other);
		session.type("/quit");
		session.enter();
		await session.finished;
		expect(session.terminal.output()).toContain("continues");
		expect(session.terminal.output()).toContain(id);

		// The detached client left the operation alone: it still settles.
		await service.completeFake("finished after detach");
		await waitFor("the operation to succeed", async () => {
			return (await other.operation(id)).state === "succeeded";
		});
		expect(await other.result(id)).toEqual({
			text: "finished after detach",
			truncated: false,
		});
	} finally {
		await service.close();
	}
});

test("an interactive slash command runs the same implementation as the standalone one", async () => {
	const service: FakeServiceHandle = await spawnServiceWithFake();
	const session = await attach(service.client);
	try {
		session.type("/models");
		session.enter();
		await waitFor("the model listing", () =>
			session.terminal.output().includes("test/offline"),
		);
		session.type("/nonsense");
		session.enter();
		await waitFor("the unsupported-command list", () =>
			session.terminal.output().includes("Unsupported command: /nonsense"),
		);
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("an uncertain submission is queried before any new paid submission", async () => {
	const service = await spawnServiceWithFake();
	const real = service.client;
	// A real client whose first submission fails after the request left: the
	// outcome is genuinely unknown to the caller.
	let attempts = 0;
	const flaky: Client = {
		...real,
		async submit(command) {
			attempts += 1;
			if (attempts === 1) throw new Error("connection reset");
			return await real.submit(command);
		},
	};
	const session = await attach(flaky);
	try {
		session.type("expensive prompt");
		session.enter();
		await waitFor("the uncertainty notice", () =>
			session.terminal.output().includes("outcome is unknown"),
		);
		expect(await service.fakeCallCount()).toBe(0);

		// The retained record is queried, not resubmitted under a new identifier.
		session.enter();
		await waitFor("the query result", () =>
			session.terminal.output().includes("never accepted"),
		);
		expect(await service.fakeCallCount()).toBe(0);

		session.enter();
		const id = await activeOperationId(real);
		expect((await real.operation(id)).requestHash).toBe(
			requestDigest({
				sessionId: "session-1",
				model: { provider: "test", id: "offline" },
				text: "expensive prompt",
			}),
		);
		expect(await service.fakeCallCount()).toBe(1);
		await service.completeFake("done");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("a compacting engine is visibly different from a working one", async () => {
	const service = await spawnServiceWithFake();
	const client = service.client;
	const session = await attach(client);
	try {
		session.type("summarize everything");
		session.enter();
		const id = await activeOperationId(client);

		// A real status event from the engine, through the coordinator, the wire and
		// the client's own status display.
		await service.statusFake("working");
		await waitFor("the working status", () =>
			session.terminal.output().includes("Engine: working"),
		);
		await service.statusFake("compacting");
		await waitFor("the compacting status", () =>
			session.terminal.output().includes("Engine: compacting"),
		);
		expect((await currentSnapshot(client)).work.engineStatus).toBe(
			"compacting",
		);
		// The two are not the same words on screen.
		expect(session.terminal.output()).toContain("no answer is being produced");

		await service.completeFake("compacted, then answered");
		await waitFor("the operation to settle", async () => {
			return (await client.operation(id)).state === "succeeded";
		});
		// A settled operation carries no engine status: a stale one would be a lie.
		expect((await currentSnapshot(client)).work.engineStatus).toBeNull();

		// The `status` command reads the same field through the same formatter.
		const recorded: string[] = [];
		await runCommand(["status"], client, {
			write(text) {
				recorded.push(text);
			},
		});
		expect(recorded.join("\n")).not.toContain("Engine:");

		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("text typed during a retry offer is kept rather than silently discarded", async () => {
	const service = await spawnServiceWithFake();
	const real = service.client;
	let attempts = 0;
	const flaky: Client = {
		...real,
		async submit(command) {
			attempts += 1;
			if (attempts === 1) throw new Error("connection reset");
			return await real.submit(command);
		},
	};
	const session = await attach(flaky);
	try {
		session.type("expensive prompt");
		session.enter();
		await waitFor("the uncertainty notice", () =>
			session.terminal.output().includes("outcome is unknown"),
		);
		session.enter();
		await waitFor("the query result", () =>
			session.terminal.output().includes("never accepted"),
		);

		// The retained text is back in the editor; the user edits it before pressing
		// Enter, which Pi clears before the client sees it.
		session.type(" and then some");
		session.enter();
		// The retry still sends the retained record under its own request ID: a new
		// one would be a new paid operation.
		const first = await activeOperationId(real);
		expect((await real.operation(first)).requestHash).toBe(
			requestDigest({
				sessionId: "session-1",
				model: { provider: "test", id: "offline" },
				text: "expensive prompt",
			}),
		);
		// But the keystrokes are not gone: they are named in the transcript.
		await waitFor("the kept-text notice", () =>
			session.terminal.output().includes("Your text is kept in the editor"),
		);
		expect(session.terminal.output()).toContain(
			"expensive prompt and then some",
		);

		await service.completeFake("first answer");
		await waitFor("the first operation to settle", async () => {
			return (await real.operation(first)).state === "succeeded";
		});

		// It is still in the editor, which submitting it proves: nothing had to echo
		// it back.
		session.enter();
		let second: string | undefined;
		await waitFor("the edited text's own submission", async () => {
			const active = (await currentSnapshot(real)).work.operation;
			if (active === null || active.id === first) return false;
			second = active.id;
			return true;
		});
		if (second === undefined) throw new Error("no second operation");
		expect((await real.operation(second)).requestHash).toBe(
			requestDigest({
				sessionId: "session-1",
				model: { provider: "test", id: "offline" },
				text: "expensive prompt and then some",
			}),
		);
		await service.completeFake("second answer");
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});

test("a reconnect does not read or print a completed result twice", async () => {
	const service = await spawnServiceWithFake();
	const real = service.client;
	const reads: string[] = [];
	// A real client that records every durable-result read and reattaches to
	// itself, so a reconnect is observable rather than inferred.
	const counting: Client = {
		...real,
		async result(id: string) {
			reads.push(id);
			return await real.result(id);
		},
		async reattach() {
			return counting;
		},
	};
	const session = await attach(counting);
	try {
		session.type("once only");
		session.enter();
		const id = await activeOperationId(real);
		await service.completeFake("the one answer");
		await waitFor("the answer", () =>
			session.terminal.output().includes("the one answer"),
		);
		expect(reads).toEqual([id]);

		// Severing this client's sockets drops the stream; it reconnects and receives
		// a fresh snapshot that still names the settled operation.
		await real.disconnect();
		await waitFor("the stream to reconnect", () =>
			session.terminal.output().includes("reconnect"),
		);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(reads).toEqual([id]);
		session.type("/quit");
		session.enter();
		await session.finished;
	} finally {
		await service.close();
	}
});
