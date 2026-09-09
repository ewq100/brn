import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	const child = spawn(nodeBinary, [serviceChild, "--state-dir", stateDir], {
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
			Object.assign(headers, requestOptions.headers ?? {});
			const [hostname = "127.0.0.1", port = "0"] = discovery.host.split(":");
			return await new Promise<ServiceResponse>((resolve, reject) => {
				const clientRequest = httpRequest(
					{
						hostname,
						port: Number(port),
						path: `${path}${requestOptions.query ?? ""}`,
						method: requestOptions.method ?? "GET",
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
				clientRequest.end();
			});
		},
		async rawRequest(lines) {
			const discovery = await readDiscovery(root);
			const [hostname = "127.0.0.1", port = "0"] = discovery.host.split(":");
			const payload = `${lines.join("\r\n")}\r\n\r\n`;
			return await new Promise<RawResponse>((resolve, reject) => {
				const socket = connect({ host: hostname, port: Number(port) }, () => {
					socket.end(payload);
				});
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
