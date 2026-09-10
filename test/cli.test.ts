import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdtemp,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { connect } from "../src/cli/client.ts";
import {
	type CommandIo,
	describeFailure,
	runCommand,
} from "../src/cli/commands.ts";
import type { PromptCommand } from "../src/core/conversation.ts";
import { BrnError, isBrnError } from "../src/core/errors.ts";
import { HealthSchema } from "../src/protocol/contracts.ts";
import { runCli, spawnServiceWithFake } from "./support/process.ts";

/** Every module the CLI entry point statically reaches, as absolute paths. */
async function staticImportGraph(entry: string): Promise<string[]> {
	const seen = new Set<string>();
	const pending = [resolve(entry)];
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
			pending.push(resolve(dirname(file), match[1] as string));
		}
	}
	return [...seen];
}

/**
 * A `brn` invocation must not load the SQLite binding or the lock-acquisition
 * code it may never call, so no client module may reach into `src/service/`.
 */
test("the CLI's static import graph contains no service module", async () => {
	const graph = await staticImportGraph("src/cli/main.ts");
	expect(graph.filter((file) => file.includes("/src/service/"))).toEqual([]);
	expect(graph.some((file) => file.endsWith("/src/core/state-dir.ts"))).toBe(
		true,
	);
});

/**
 * Collects what a command wrote, so a case can assert on the whole rendered
 * answer rather than on a single line.
 */
function recorder(): CommandIo & { text(): string } {
	const written: string[] = [];
	return {
		write(text: string) {
			written.push(text);
		},
		text() {
			return written.join("");
		},
	};
}

/**
 * The digest the service commits for one submission.
 *
 * The tuple is the one `src/service/http.ts` hashes. Recomputing it here is how a
 * test proves the exact text the service received without asking the engine to
 * echo it back.
 */
function requestDigest(command: PromptCommand): string {
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

test("status reports readiness, session, unknown context, usage and no tools", async () => {
	const service = await spawnServiceWithFake();
	try {
		const recorded = recorder();
		await runCommand(["status"], service.client, recorded);
		const text = recorded.text();
		expect(text).toContain("session-1");
		expect(text).toContain("test/offline");
		// The deterministic engine reports no context at all, and an unknown context
		// is never presented as a comfortable zero.
		expect(text).toContain("Context: unknown");
		expect(text).not.toContain("Context: 0/0");
		expect(text).toContain("Tools: none (Capability A)");
		expect(text).toContain("Work: none");
	} finally {
		await service.close();
	}
});

test("models and sessions read their own routes", async () => {
	const service = await spawnServiceWithFake();
	try {
		const models = recorder();
		await runCommand(["models"], service.client, models);
		expect(models.text()).toContain("test/offline");

		const sessions = recorder();
		await runCommand(["sessions"], service.client, sessions);
		expect(sessions.text()).toContain("session-1");
	} finally {
		await service.close();
	}
});

test("new, resume and model reach the routes that change the conversation", async () => {
	const service = await spawnServiceWithFake();
	try {
		// A model identifier splits at the first slash only: the identifier itself may
		// contain further slashes.
		const created = recorder();
		await runCommand(
			["new", "--model", "test/vendor/model-1"],
			service.client,
			created,
		);
		expect(created.text()).toContain("session-2");
		expect(created.text()).toContain("test/vendor/model-1");

		const resumed = recorder();
		await runCommand(["resume", "session-1"], service.client, resumed);
		expect(resumed.text()).toContain("session-1");

		const changed = recorder();
		await runCommand(["model", "test/offline"], service.client, changed);
		expect(changed.text()).toContain("test/offline");
	} finally {
		await service.close();
	}
});

test("prompt submits the exact text once under the caller's request ID", async () => {
	const service = await spawnServiceWithFake();
	try {
		const requestId = randomUUID();
		const text = "one\ntwo";
		const first = recorder();
		await runCommand(
			["prompt", "--request-id", requestId, "--text", text],
			service.client,
			first,
		);
		expect(first.text()).toContain(requestId);
		const accepted = await service.client.operation(requestId);
		expect(accepted.requestHash).toBe(
			requestDigest({
				requestId,
				sessionId: "session-1",
				model: { provider: "test", id: "offline" },
				text,
			}),
		);

		// The identical request under the same ID resolves to the original operation
		// and does not pay for a second run.
		const repeated = recorder();
		await runCommand(
			["prompt", "--request-id", requestId, "--text", text],
			service.client,
			repeated,
		);
		expect(await service.fakeCallCount()).toBe(1);
		await service.completeFake("answer");
	} finally {
		await service.close();
	}
});

test("prompt refuses whitespace-only input with a corrective action", async () => {
	const service = await spawnServiceWithFake();
	try {
		const recorded = recorder();
		await expect(
			runCommand(
				["prompt", "--request-id", randomUUID(), "--text", "   "],
				service.client,
				recorded,
			),
		).rejects.toThrow(/REQUEST_FAILED/);
		expect(await service.fakeCallCount()).toBe(0);
	} finally {
		await service.close();
	}
});

test("operation reports a settled outcome and its durable result", async () => {
	const service = await spawnServiceWithFake();
	try {
		const command = service.prompt("what is the answer");
		const accepted = await service.client.submit(command);
		await service.completeFake("forty two");
		const recorded = recorder();
		await runCommand(["operation", accepted.id], service.client, recorded);
		const text = recorded.text();
		expect(text).toContain("succeeded");
		expect(text).toContain("forty two");
	} finally {
		await service.close();
	}
});

test("cancel requires confirmation and settles the named operation", async () => {
	const service = await spawnServiceWithFake();
	try {
		const accepted = await service.client.submit(service.prompt("slow"));
		await service.service.fake({ action: "awaitRunning" });

		const unconfirmed = recorder();
		await expect(
			runCommand(["cancel", accepted.id], service.client, unconfirmed),
		).rejects.toThrow();

		const recorded = recorder();
		await runCommand(
			["cancel", accepted.id, "--confirm"],
			service.client,
			recorded,
		);
		expect(recorded.text()).toContain("cancelled");
		expect((await service.client.operation(accepted.id)).state).toBe(
			"cancelled",
		);
	} finally {
		await service.close();
	}
});

test("an unknown operation ID answers with a concrete corrective action", async () => {
	const service = await spawnServiceWithFake();
	try {
		const recorded = recorder();
		await expect(
			runCommand(["operation", randomUUID()], service.client, recorded),
		).rejects.toThrow(/REQUEST_FAILED/);
	} finally {
		await service.close();
	}
});

test("chat is delegated to the interactive client, and refused without one", async () => {
	const service = await spawnServiceWithFake();
	try {
		let attached = 0;
		await runCommand(["chat"], service.client, {
			write() {},
			chat: async () => {
				attached += 1;
			},
		});
		expect(attached).toBe(1);
		await expect(
			runCommand(["chat"], service.client, { write() {} }),
		).rejects.toThrow();
	} finally {
		await service.close();
	}
});

test("an unsupported command fails with the supported list", async () => {
	const service = await spawnServiceWithFake();
	try {
		const result = await runCli([
			"--state-dir",
			service.root,
			"teleport",
		]).catch(() => null);
		expect(result?.code).toBe(1);
		expect(result?.output).toContain("UNSUPPORTED_COMMAND");
		expect(result?.output).toContain("status");
		expect(result?.output).toContain("prompt");
		// The one-shot command's failure costs the service nothing.
		expect((await service.service.request("/v1/health")).status).toBe(200);
	} finally {
		await service.close();
	}
});

test("a one-shot command leaves the service running", async () => {
	const service = await spawnServiceWithFake();
	try {
		const result = await runCli(["--state-dir", service.root, "status"]);
		expect(result.code).toBe(0);
		expect(result.output).toContain("Tools: none (Capability A)");
		expect((await service.service.request("/v1/health")).status).toBe(200);
		expect(service.service.output()).not.toContain("service.stopped");
	} finally {
		await service.close();
	}
});

test("two clients see the same active operation and the same busy rejection", async () => {
	const service = await spawnServiceWithFake();
	try {
		const second = await service.reconnect();
		const first = await connect(service.root);
		const accepted = await first.submit(service.prompt("occupier"));
		const recorded = recorder();
		await runCommand(["status"], second, recorded);
		expect(recorded.text()).toContain(accepted.id);

		await expect(
			runCommand(["resume", "session-1"], second, recorder()),
		).rejects.toThrow(/REQUEST_FAILED/);
		await service.completeFake("done");
		await first.disconnect();
	} finally {
		await service.close();
	}
});

/** A server that accepts a connection and then answers nothing at all. */
async function hangingService(): Promise<{
	readonly stateDir: string;
	close(): Promise<void>;
}> {
	const stateDir = await mkdtemp(join(await realpath(tmpdir()), "brn-hang-"));
	const server: Server = createServer(() => {
		// Deliberately never responds.
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const path = join(stateDir, "discovery.json");
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			instanceId: "instance-hanging",
			pid: process.pid,
			host: `127.0.0.1:${port}`,
			token: "token",
		}),
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
	return {
		stateDir,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("a request to a service that never answers is bounded, and the stream is not", async () => {
	const hanging = await hangingService();
	const client = await connect(hanging.stateDir, { requestTimeoutMs: 200 });
	try {
		const outcome = await Promise.race([
			client
				.request("GET", "/v1/health", HealthSchema)
				.then(() => "answered")
				.catch((error: unknown) => `failed:${String(error)}`),
			new Promise<string>((resolve) => {
				setTimeout(() => resolve("hung"), 2_000);
			}),
		]);
		expect(outcome).toMatch(/^failed:.*SERVICE_UNREACHABLE/);

		// The event stream carries a long-lived operation and must not inherit the
		// request bound: this one stays open well past it.
		const stream = await Promise.race([
			client.events().then(() => "opened"),
			new Promise<string>((resolve) => {
				setTimeout(() => resolve("still waiting"), 1_000);
			}),
		]);
		expect(stream).toBe("still waiting");
	} finally {
		await client.disconnect();
		await hanging.close();
	}
});

/**
 * A server that refuses every request with a body a caller chooses.
 *
 * It exists so a refusal body that no BRN service would ever send — one whose
 * `code` carries terminal escapes — can be pushed through the real client and the
 * real failure path.
 */
async function refusingService(body: string): Promise<{
	readonly stateDir: string;
	close(): Promise<void>;
}> {
	const stateDir = await mkdtemp(join(await realpath(tmpdir()), "brn-refuse-"));
	const server: Server = createServer((_request, response) => {
		response.writeHead(409, {
			"Content-Type": "application/json; charset=utf-8",
		});
		response.end(body);
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port =
		typeof address === "object" && address !== null ? address.port : 0;
	const path = join(stateDir, "discovery.json");
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			instanceId: "instance-refusing",
			pid: process.pid,
			host: `127.0.0.1:${port}`,
			token: "token",
		}),
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
	return {
		stateDir,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("a hostile failure code never reaches a failure message", async () => {
	// The error contract bounds this field's length, not its character set, so a
	// body that passes schema validation can still carry ESC, BEL and CR.
	const hostile = "\x1b]52;c;Y29weQ==\x07BU\rSY\u009b2J";
	const refusing = await refusingService(
		JSON.stringify({ error: { code: hostile, message: "refused" } }),
	);
	const client = await connect(refusing.stateDir, { requestTimeoutMs: 2_000 });
	try {
		const failure = await client
			.request("GET", "/v1/snapshot", HealthSchema)
			.then(() => null)
			.catch((error: unknown) => error);
		if (!isBrnError(failure)) throw new Error("expected a BRN failure");
		// The code is not one of BRN's own fixed names, so the client dropped it
		// rather than carrying it: only the status survives.
		expect(failure.code).toBe("REQUEST_FAILED");
		expect(failure.detail).toBe("409");

		// Belt and braces: even a detail that did carry controls is filtered at the
		// sink, so the two defences are independent.
		const rendered = describeFailure(
			new BrnError("REQUEST_FAILED", `409 ${hostile}`),
			"/tmp/state",
		);
		for (const control of ["\x1b", "\x07", "\r", "\u009b"]) {
			expect(rendered).not.toContain(control);
		}
		expect(rendered).toContain("REQUEST_FAILED");
	} finally {
		await client.disconnect();
		await refusing.close();
	}
});

test("chat refuses a non-interactive stdin instead of hanging", async () => {
	const service = await spawnServiceWithFake();
	try {
		// `runCli` gives the child no stdin at all, which is exactly how a script or
		// a pipe invokes it.
		const result = await runCli(["--state-dir", service.root, "chat"]);
		expect(result.code).toBe(1);
		expect(result.output).toContain("NOT_A_TERMINAL");
		// The refusal names the scriptable route rather than leaving the caller stuck.
		expect(result.output).toContain("prompt --request-id");
		expect((await service.service.request("/v1/health")).status).toBe(200);
	} finally {
		await service.close();
	}
});

test("a client reports a missing service as a concrete corrective command", async () => {
	const empty = await mkdtemp(join(await realpath(tmpdir()), "brn-empty-"));
	const result = await runCli(["--state-dir", empty, "status"]);
	expect(result.code).toBe(1);
	expect(result.output).toContain("NO_SERVICE");
	expect(result.output).toContain("npm run service --");
	expect(result.output).toContain(empty);
});

test("a relative state directory is refused before anything connects", async () => {
	const result = await runCli(["--state-dir", "relative/path", "status"]);
	expect(result.code).toBe(1);
	expect(result.output).toContain("INVALID_STATE_DIR");
});
