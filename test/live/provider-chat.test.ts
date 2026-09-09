/**
 * The authorized live provider proof.
 *
 * It is the only test in this repository that may reach a real model provider,
 * and it refuses to run unless a human has explicitly authorized this exact
 * thing: the authorization phrase, a disposable state directory chosen for the
 * proof, and the provider-qualified model to use. There is no default for any of
 * them and no inference from anything else.
 *
 * It is excluded from `npm test` and is run only through `npm run test:live`,
 * separately and deliberately. Nothing here reads a vault, imports a file,
 * enables a tool or copies a credential: the service uses whatever Pi already
 * has, in Pi's own location, and this file never opens it.
 *
 * A passing offline suite is not evidence for anything this test asserts, and
 * this test is not evidence that the interactive terminal works: that needs a
 * human at a real terminal.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { type Client, connect, HealthResponse } from "../../src/cli/client.ts";
import type { Usage } from "../../src/core/conversation.ts";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The production entry points, as an operator runs them. Nothing is composed. */
const serviceEntry = join(projectRoot, "dist", "service", "main.js");
const cliEntry = join(projectRoot, "dist", "cli", "main.js");

const READY_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 120_000;
const POLL_MS = 200;

/** The states that still occupy the single-operation slot. */
const UNFINISHED = new Set(["accepted", "running", "cancelling"]);

interface ProofResult {
	readonly id: string;
	readonly state: string;
	readonly usage: Usage;
	readonly text: string;
}

interface ProductionProof {
	prompt(submission: { requestId: string; text: string }): Promise<ProofResult>;
	disconnectAndReconnect(): Promise<void>;
	resultText(id: string): Promise<string>;
	close(): Promise<void>;
}

test("authorized synthetic conversation through the production CLI", async () => {
	if (process.env.BRN_LIVE_PROOF !== "I_AUTHORIZE_SYNTHETIC_CHAT") {
		throw new Error("LIVE_PROVIDER_AUTHORIZATION_REQUIRED");
	}
	const root = process.env.BRN_LIVE_STATE_DIR;
	const model = process.env.BRN_LIVE_MODEL;
	if (!root || !model) throw new Error("LIVE_PROOF_CONFIGURATION_REQUIRED");
	const proof = await startProductionProof(root, model);
	try {
		const result = await proof.prompt({
			requestId: randomUUID(),
			text: "Reply with a short greeting. This is synthetic BRN integration data.",
		});
		expect(result.state).toBe("succeeded");
		expect(result.usage.output).toBeLessThanOrEqual(4096);
		expect(result.text.trim().length).toBeGreaterThan(0);
		await proof.disconnectAndReconnect();
		expect(await proof.resultText(result.id)).toBe(result.text);
	} finally {
		await proof.close();
	}
}, 150_000);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs the compiled CLI exactly as an operator would, and reports its output. */
async function runCli(
	root: string,
	args: readonly string[],
): Promise<{ code: number | null; output: string }> {
	const child = spawn(
		process.execPath,
		[cliEntry, "--state-dir", root, ...args],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const chunks: string[] = [];
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
	child.stderr?.on("data", (chunk: string) => chunks.push(chunk));
	const code = await new Promise<number | null>((resolve) => {
		child.once("close", resolve);
	});
	return { code, output: chunks.join("") };
}

/**
 * Starts the production service and the production CLI against a disposable
 * proof directory.
 *
 * The directory must be empty or absent: this never runs against a state root
 * that already holds someone's conversations. Nothing in here removes it either
 * — a directory a human chose is theirs to delete.
 */
async function startProductionProof(
	root: string,
	model: string,
): Promise<ProductionProof> {
	if (!existsSync(serviceEntry) || !existsSync(cliEntry)) {
		throw new Error("LIVE_PROOF_BUILD_REQUIRED");
	}
	if (existsSync(root)) {
		const entries = await readdir(root);
		if (entries.length > 0) throw new Error("LIVE_PROOF_ROOT_NOT_EMPTY");
	} else {
		// Only the final directory, owner-only, exactly as the service would.
		await mkdir(root, { mode: 0o700 });
	}

	const service = spawn(process.execPath, [serviceEntry, "--state-dir", root], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log: string[] = [];
	service.stdout?.setEncoding("utf8");
	service.stderr?.setEncoding("utf8");
	service.stdout?.on("data", (chunk: string) => log.push(chunk));
	service.stderr?.on("data", (chunk: string) => log.push(chunk));
	let exited = false;
	const exit = new Promise<void>((resolve) => {
		service.once("close", () => {
			exited = true;
			resolve();
		});
	});

	/** Ends the service and waits for it, so nothing is left holding the root. */
	async function stopService(): Promise<void> {
		if (!exited && service.pid !== undefined) {
			process.kill(service.pid, "SIGTERM");
		}
		await exit;
	}

	let client: Client;
	try {
		client = await attach(
			root,
			() => exited,
			() => log.join(""),
		);
		// The concrete identity is chosen by the operator and is displayed by the
		// production commands themselves; both runs are the real CLI.
		const created = await runCli(root, ["new", "--model", model]);
		if (created.code !== 0) {
			throw new Error(`LIVE_PROOF_SESSION_FAILED: ${created.output}`);
		}
		const status = await runCli(root, ["status"]);
		if (status.code !== 0) {
			throw new Error(`LIVE_PROOF_STATUS_FAILED: ${status.output}`);
		}
	} catch (error) {
		await stopService();
		throw error;
	}

	return {
		async prompt(submission) {
			// Submitted through the standalone command, so the transport under test is
			// the one an operator uses.
			const submitted = await runCli(root, [
				"prompt",
				"--request-id",
				submission.requestId,
				"--text",
				submission.text,
			]);
			if (submitted.code !== 0) {
				throw new Error(`LIVE_PROOF_SUBMIT_FAILED: ${submitted.output}`);
			}
			const deadline = Date.now() + SETTLE_TIMEOUT_MS;
			for (;;) {
				const operation = await client.operation(submission.requestId);
				if (!UNFINISHED.has(operation.state)) {
					const result = operation.result;
					const usage =
						result !== null && result.kind === "completed"
							? result.usage
							: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
								};
					const text =
						operation.state === "succeeded" || operation.state === "cancelled"
							? (await client.result(operation.id)).text
							: "";
					return { id: operation.id, state: operation.state, usage, text };
				}
				if (Date.now() > deadline) throw new Error("LIVE_PROOF_TIMEOUT");
				await sleep(POLL_MS);
			}
		},
		async disconnectAndReconnect() {
			// This client's own sockets close; the service and its conversation do not.
			await client.disconnect();
			client = await connect(root);
		},
		async resultText(id) {
			return (await client.result(id)).text;
		},
		async close() {
			await client.disconnect();
			await stopService();
		},
	};
}

/** Waits for the service to publish discovery and answer, then attaches. */
async function attach(
	root: string,
	exited: () => boolean,
	log: () => string,
): Promise<Client> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	for (;;) {
		if (exited()) throw new Error(`LIVE_PROOF_SERVICE_EXITED: ${log()}`);
		try {
			const client = await connect(root);
			await client.request("GET", "/v1/health", HealthResponse);
			return client;
		} catch (error) {
			if (Date.now() > deadline) {
				throw new Error(`LIVE_PROOF_SERVICE_UNREADY: ${String(error)}`);
			}
			await sleep(POLL_MS);
		}
	}
}
