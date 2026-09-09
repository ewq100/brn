import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createRequestHandler } from "./http.ts";
import { logInfo } from "./log.ts";
import {
	acquireOwnership,
	MANAGED_FILE_MODE,
	type Ownership,
	requireSafeManagedFile,
} from "./ownership.ts";
import { proveFts5 } from "./sqlite.ts";

/** BRN binds loopback only; it is never reachable from another host. */
const BIND_ADDRESS = "127.0.0.1";
const DISCOVERY_FILE = "discovery.json";
const DISCOVERY_TEMP_FILE = "discovery.json.tmp";
const TOKEN_BYTES = 32;

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

/** The document an attaching client reads to find and authenticate this instance. */
export interface DiscoveryDocument {
	readonly version: 1;
	readonly instanceId: string;
	readonly pid: number;
	readonly host: string;
	readonly token: string;
}

export interface RunningService {
	/** The bound loopback authority, `127.0.0.1:<port>`. */
	readonly host: string;
	close(): Promise<void>;
}

async function listen(server: Server): Promise<AddressInfo> {
	return await new Promise<AddressInfo>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(0, BIND_ADDRESS, () => {
			server.removeListener("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("server did not bind a TCP address"));
				return;
			}
			resolve(address);
		});
	});
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Publishes discovery atomically: an owner-only temporary file in the same
 * directory, flushed, renamed over the target, then the directory flushed. A
 * reader therefore sees either the previous instance's document or this one, and
 * never a half-written file.
 */
async function publishDiscovery(
	root: string,
	document: DiscoveryDocument,
): Promise<void> {
	const target = join(root, DISCOVERY_FILE);
	const temporary = join(root, DISCOVERY_TEMP_FILE);
	await requireSafeManagedFile(target);
	await rm(temporary, { force: true });
	const handle = await open(
		temporary,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		MANAGED_FILE_MODE,
	);
	try {
		await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, target);
	await syncDirectory(root);
}

/**
 * Removes the discovery document only if it is still this instance's. Ownership
 * is never reclaimed by deleting another instance's discovery file.
 */
async function withdrawDiscovery(
	root: string,
	instanceId: string,
): Promise<void> {
	const target = join(root, DISCOVERY_FILE);
	let published: unknown;
	try {
		const handle = await open(
			target,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			published = JSON.parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
	} catch {
		return;
	}
	const owner =
		typeof published === "object" &&
		published !== null &&
		"instanceId" in published
			? (published as { instanceId: unknown }).instanceId
			: undefined;
	if (owner !== instanceId) return;
	await unlink(target);
	await syncDirectory(root);
}

/**
 * Starts the foreground service: one owner, one loopback listener, one published
 * discovery document.
 *
 * The order is deliberate. The umask is tightened before any file exists,
 * ownership is acquired before any writable resource is opened, and discovery is
 * published last so a client can never attach to a half-initialised instance.
 */
export async function startService(options: {
	stateDir: string;
}): Promise<RunningService> {
	process.umask(0o077);
	proveFts5();

	const ownership: Ownership = await acquireOwnership(options.stateDir);
	const instanceId = randomUUID();
	const token = randomBytes(TOKEN_BYTES).toString("base64url");
	let expected = { host: "", token };
	let ready = false;

	const server = createServer(
		createRequestHandler({
			instanceId,
			pid: process.pid,
			expected: () => expected,
			ready: () => ready,
		}),
	);
	server.headersTimeout = HEADERS_TIMEOUT_MS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

	let host: string;
	try {
		const address = await listen(server);
		host = `${BIND_ADDRESS}:${address.port}`;
		expected = { host, token };
		ready = true;
		await publishDiscovery(ownership.root, {
			version: 1,
			instanceId,
			pid: process.pid,
			host,
			token,
		});
	} catch (error) {
		ready = false;
		server.close();
		server.closeAllConnections();
		ownership.release();
		throw error;
	}

	logInfo("service.listening", { host, instanceId, pid: process.pid });

	return {
		host,
		async close() {
			ready = false;
			try {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) reject(error);
						else resolve();
					});
					server.closeAllConnections();
				});
				await withdrawDiscovery(ownership.root, instanceId);
			} finally {
				ownership.release();
			}
		},
	};
}
