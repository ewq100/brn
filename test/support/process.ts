import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, connect } from "../../src/cli/client.ts";
import type { PromptCommand } from "../../src/core/conversation.ts";
import { FAKE_MODEL, FAKE_SESSION_ID } from "./fake-engine.ts";

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const serviceChild = join(supportDirectory, "service-child.ts");
const cliEntry = join(supportDirectory, "..", "..", "src", "cli", "main.ts");
const nodeBinary = process.execPath;

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface Discovery {
	version: number;
	instanceId: string;
	pid: number;
	host: string;
	token: string;
}

/** Reads the discovery document a service published into `root`. */
export async function readDiscovery(root: string): Promise<Discovery> {
	const text = await readFile(join(root, "discovery.json"), "utf8");
	return JSON.parse(text) as Discovery;
}

export interface RequestOptions {
	/** Send no `Authorization` header at all. */
	auth?: boolean;
	/** Request body, sent as `application/json; charset=utf-8` unless overridden. */
	body?: string | Uint8Array;
	/** Content type for `body`; `null` sends no `Content-Type` header at all. */
	contentType?: string | null;
	/** Send the body without a declared length, as a chunked request. */
	chunked?: boolean;
	/** Override the bearer token that would otherwise come from discovery. */
	token?: string;
	method?: string;
	/** Override the `Host` header without changing the connected address. */
	host?: string;
	/** Extra headers, merged last so a case may override defaults. */
	headers?: Record<string, string>;
	/** Raw query string, including its leading `?`. */
	query?: string;
}

export interface ServiceResponse {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	text: string;
}

export interface RawResponse {
	status: number;
	raw: string;
}

export interface SpawnServiceOptions {
	/** Wait for the child to report readiness before resolving. */
	expectReady?: boolean;
	/** Value passed to `--state-dir`; defaults to `root`. */
	stateDir?: string;
	/**
	 * Compose the test-only deterministic engine instead of the Pi adapter. The
	 * switch lives in the test composition entry's own arguments: no production
	 * argument, environment variable or endpoint can select it.
	 */
	fakeEngine?: boolean;
}

/** One control message for the test-only engine, answered over IPC. */
export interface FakeCommand {
	readonly action:
		| "callCount"
		| "complete"
		| "fail"
		| "emit"
		| "running"
		| "awaitRunning";
	readonly text?: string;
}

export interface ServiceHandle {
	readonly pid: number;
	/** Resolves when the child reports it has published discovery and is serving. */
	readonly ready: Promise<void>;
	/** Resolves with the child's exit code, or `null` when a signal killed it. */
	readonly exit: Promise<number | null>;
	signal(signal: NodeJS.Signals): void;
	/** Everything the child wrote to stdout and stderr so far. */
	output(): string;
	request(path: string, options?: RequestOptions): Promise<ServiceResponse>;
	/** Sends a byte-exact request so duplicate headers survive to the server. */
	rawRequest(lines: readonly string[]): Promise<RawResponse>;
	/** Drives the test-only engine over IPC. Only valid with `fakeEngine`. */
	fake(command: FakeCommand): Promise<unknown>;
	close(): Promise<void>;
}

function toExitPromise(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code));
	});
}

export async function spawnService(
	root: string,
	options: SpawnServiceOptions = {},
): Promise<ServiceHandle> {
	const stateDir = options.stateDir ?? root;
	const childArguments = [serviceChild, "--state-dir", stateDir];
	if (options.fakeEngine === true) childArguments.push("--fake-engine");
	const child = spawn(nodeBinary, childArguments, {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});

	const chunks: string[] = [];
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
	child.stderr?.on("data", (chunk: string) => chunks.push(chunk));
	const output = () => chunks.join("");

	const exit = toExitPromise(child);
	let exited = false;
	void exit.then(() => {
		exited = true;
	});

	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					`service did not become ready in ${READY_TIMEOUT_MS}ms: ${output()}`,
				),
			);
		}, READY_TIMEOUT_MS);
		timer.unref();
		child.on("message", (message) => {
			if (
				typeof message === "object" &&
				message !== null &&
				"type" in message
			) {
				if ((message as { type: unknown }).type === "ready") {
					clearTimeout(timer);
					resolve();
				}
			}
		});
		void exit.then((code) => {
			clearTimeout(timer);
			reject(
				new Error(
					`service exited with code ${String(code)} before ready: ${output()}`,
				),
			);
		});
	});

	const pid = child.pid;
	if (pid === undefined)
		throw new Error(`service failed to spawn: ${output()}`);

	// Control messages for the test-only engine are correlated by id so several
	// may be in flight without one reply being mistaken for another.
	let nextCommandId = 0;
	const pendingCommands = new Map<number, (value: unknown) => void>();
	child.on("message", (message) => {
		if (
			typeof message !== "object" ||
			message === null ||
			!("type" in message) ||
			(message as { type: unknown }).type !== "fake-reply"
		) {
			return;
		}
		const reply = message as unknown as { id: number; value: unknown };
		const settle = pendingCommands.get(reply.id);
		pendingCommands.delete(reply.id);
		settle?.(reply.value);
	});

	const handle: ServiceHandle = {
		pid,
		ready,
		exit,
		output,
		signal(signal) {
			process.kill(pid, signal);
		},
		async request(path, requestOptions = {}) {
			const discovery = await readDiscovery(root);
			const headers: Record<string, string> = {};
			if (requestOptions.auth !== false) {
				headers.Authorization = `Bearer ${requestOptions.token ?? discovery.token}`;
			}
			if (requestOptions.host !== undefined) headers.Host = requestOptions.host;
			const payload = requestOptions.body;
			if (payload !== undefined) {
				if (requestOptions.contentType !== null) {
					headers["Content-Type"] =
						requestOptions.contentType ?? "application/json; charset=utf-8";
				}
				if (requestOptions.chunked !== true) {
					headers["Content-Length"] = String(
						typeof payload === "string"
							? Buffer.byteLength(payload, "utf8")
							: payload.byteLength,
					);
				}
			}
			Object.assign(headers, requestOptions.headers ?? {});
			const [hostname = "127.0.0.1", port = "0"] = discovery.host.split(":");
			return await new Promise<ServiceResponse>((resolve, reject) => {
				const clientRequest = httpRequest(
					{
						hostname,
						port: Number(port),
						path: `${path}${requestOptions.query ?? ""}`,
						method:
							requestOptions.method ?? (payload === undefined ? "GET" : "POST"),
						headers,
						timeout: REQUEST_TIMEOUT_MS,
					},
					(response) => {
						const body: string[] = [];
						response.setEncoding("utf8");
						response.on("data", (chunk: string) => body.push(chunk));
						response.on("end", () => {
							resolve({
								status: response.statusCode ?? 0,
								headers: response.headers,
								text: body.join(""),
							});
						});
					},
				);
				clientRequest.on("timeout", () => {
					clientRequest.destroy(new Error("request timed out"));
				});
				clientRequest.on("error", reject);
				if (payload === undefined) clientRequest.end();
				else if (typeof payload === "string")
					clientRequest.end(payload, "utf8");
				else clientRequest.end(Buffer.from(payload));
			});
		},
		async rawRequest(lines) {
			const discovery = await readDiscovery(root);
			const [hostname = "127.0.0.1", port = "0"] = discovery.host.split(":");
			const payload = `${lines.join("\r\n")}\r\n\r\n`;
			return await new Promise<RawResponse>((resolve, reject) => {
				const socket = connectSocket(
					{ host: hostname, port: Number(port) },
					() => {
						socket.end(payload);
					},
				);
				socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
					socket.destroy(new Error("raw request timed out"));
				});
				const received: string[] = [];
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => received.push(chunk));
				socket.on("error", reject);
				socket.on("close", () => {
					const raw = received.join("");
					const match = /^HTTP\/1\.1 (\d{3})/.exec(raw);
					resolve({
						status: match?.[1] === undefined ? 0 : Number(match[1]),
						raw,
					});
				});
			});
		},
		async fake(command) {
			nextCommandId += 1;
			const id = nextCommandId;
			return await new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pendingCommands.delete(id);
					reject(new Error(`fake ${command.action} timed out: ${output()}`));
				}, REQUEST_TIMEOUT_MS);
				timer.unref();
				pendingCommands.set(id, (value) => {
					clearTimeout(timer);
					resolve(value);
				});
				child.send({ type: "fake", id, ...command }, (error) => {
					if (error) {
						clearTimeout(timer);
						pendingCommands.delete(id);
						reject(error);
					}
				});
			});
		},
		async close() {
			if (!exited) {
				process.kill(pid, "SIGTERM");
			}
			await exit;
		},
	};

	if (options.expectReady !== false) {
		await ready;
	} else {
		// Consume the rejection so an expected startup failure is not an unhandled error.
		void ready.catch(() => undefined);
	}
	return handle;
}

export interface CliResult {
	code: number | null;
	output: string;
}

/** Runs the real CLI entry point as a child process and captures its output. */
export async function runCli(args: readonly string[]): Promise<CliResult> {
	const child = spawn(nodeBinary, [cliEntry, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const chunks: string[] = [];
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
	child.stderr?.on("data", (chunk: string) => chunks.push(chunk));
	const code = await toExitPromise(child);
	return { code, output: chunks.join("") };
}

/** Replaces the bearer token in a discovery document with a same-length value. */
export function differentTokenOfSameLength(token: string): string {
	return [...token]
		.map((character) => (character === "a" ? "b" : "a"))
		.join("");
}

/**
 * A spawned service composed with the deterministic engine, plus an attached
 * real client.
 *
 * Everything here runs over real sockets against a real child process: the only
 * substitution is the conversation engine, and it is selected by the test
 * composition entry's own argument.
 */
export interface FakeServiceHandle {
	readonly root: string;
	/** The raw process handle, for header-level and raw-socket cases. */
	readonly service: ServiceHandle;
	/** The attached client. `reconnect()` replaces it. */
	readonly client: Client;
	/** Builds a prompt for the deterministic engine's seated session and model. */
	prompt(text: string, overrides?: Partial<PromptCommand>): PromptCommand;
	/** Waits for the engine to be running, then completes it with a durable answer. */
	completeFake(text: string): Promise<void>;
	/** Waits for the engine to be running, then fails it, keeping partial text. */
	failFake(partialText?: string): Promise<void>;
	/** Streams live text from the engine without recording a durable entry. */
	emitFake(text: string): Promise<void>;
	/** How many prompts the engine was actually asked to run. */
	fakeCallCount(): Promise<number>;
	/** Attaches a fresh client, re-reading discovery. */
	reconnect(): Promise<Client>;
	close(): Promise<void>;
}

export async function spawnServiceWithFake(
	options: { root?: string } = {},
): Promise<FakeServiceHandle> {
	const root =
		options.root ??
		(await mkdtemp(join(await realpath(tmpdir()), "brn-service-")));
	const service = await spawnService(root, { fakeEngine: true });
	const clients: Client[] = [await connect(root)];

	const handle: FakeServiceHandle = {
		root,
		service,
		get client() {
			const current = clients.at(-1);
			if (current === undefined) throw new Error("no attached client");
			return current;
		},
		prompt(text, overrides = {}) {
			return {
				requestId: randomUUID(),
				sessionId: FAKE_SESSION_ID,
				model: { ...FAKE_MODEL },
				text,
				...overrides,
			};
		},
		async completeFake(text) {
			await service.fake({ action: "awaitRunning" });
			await service.fake({ action: "complete", text });
		},
		async failFake(partialText) {
			await service.fake({ action: "awaitRunning" });
			await service.fake(
				partialText === undefined
					? { action: "fail" }
					: { action: "fail", text: partialText },
			);
		},
		async emitFake(text) {
			await service.fake({ action: "awaitRunning" });
			await service.fake({ action: "emit", text });
		},
		async fakeCallCount() {
			const value = await service.fake({ action: "callCount" });
			if (typeof value !== "number")
				throw new Error("fake did not report a call count");
			return value;
		},
		async reconnect() {
			const client = await connect(root);
			clients.push(client);
			return client;
		},
		async close() {
			for (const client of clients) await client.disconnect();
			await service.close();
		},
	};
	return handle;
}
