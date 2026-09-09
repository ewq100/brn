import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ConversationEngine } from "../core/conversation.ts";
import { isBrnError } from "../core/errors.ts";
import { errnoOf, MANAGED_FILE_MODE } from "../core/fs.ts";
import { createOperations } from "../core/operations.ts";
import { createSnapshotHub, type SnapshotHub } from "./events.ts";
import { syncDirectory } from "./fs.ts";
import { createRequestHandler } from "./http.ts";
import { logError, logInfo } from "./log.ts";
import { openOperationStore, type ServiceStore } from "./operation-store.ts";
import {
	acquireOwnership,
	createOrValidateManagedFile,
	type Ownership,
	requireSafeManagedFile,
} from "./ownership.ts";
import { createPiConversation } from "./pi/conversation.ts";
import { openPiRuntime, type PiHost } from "./pi/runtime.ts";
import { proveFts5 } from "./sqlite.ts";

/** BRN binds loopback only; it is never reachable from another host. */
const BIND_ADDRESS = "127.0.0.1";
const DISCOVERY_FILE = "discovery.json";
const DISCOVERY_TEMP_FILE = "discovery.json.tmp";
const OPERATIONS_DATABASE = "operations.sqlite";
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

/** A composed conversation engine and the facilities it owns. */
export interface ComposedEngine {
	readonly engine: ConversationEngine;
	/** Closes whatever hosts the engine, after the engine itself has closed. */
	close(): Promise<void>;
}

/**
 * Constructor-only composition.
 *
 * `engine` exists so the test composition entry can seat a deterministic engine.
 * It is a function argument, not an HTTP parameter, an environment variable or a
 * command-line flag of the production entry point: no production path can select
 * anything other than the Pi adapter.
 */
export interface ServiceComposition {
	readonly engine?: (context: {
		readonly root: string;
		readonly store: ServiceStore;
	}) => Promise<ComposedEngine>;
	/** Test-only shortening of the operation deadline. */
	readonly deadlineMs?: number;
	/**
	 * Test-only lowering of the event stream's queued-byte ceiling, so a real
	 * non-reading connection can be shown to lose its stream. Like `engine`, it is
	 * a constructor argument of this function: production's entry point passes no
	 * composition at all.
	 */
	readonly maxBufferedBytes?: number;
}

async function composePiEngine(context: {
	root: string;
	store: ServiceStore;
}): Promise<ComposedEngine> {
	// The shared model runtime, settings and resource loader open once and live as
	// long as the process. No conversation exists and no model is chosen yet: that
	// waits for an explicit control.
	const piHost: PiHost = await openPiRuntime({
		root: context.root,
		store: context.store,
	});
	// The conversation seam the operation coordinator drives. It adds no state of
	// its own: the host owns the conversation, and closing the engine only settles
	// a run that is still in flight.
	return { engine: createPiConversation(piHost), close: () => piHost.close() };
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
 * Reads the published discovery document, or reports its absence.
 *
 * Only `ENOENT` is a legitimate absence. Every other failure — a permission
 * error, a symlink swapped in under us, a truncated or malformed document — is
 * logged under a fixed code and rethrown, because a shutdown that cannot read
 * its own document must not silently leave a stale one naming a dead PID.
 */
async function readPublishedDiscovery(target: string): Promise<unknown> {
	let text: string;
	try {
		const handle = await open(
			target,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		const errno = errnoOf(error);
		if (errno === "ENOENT") return undefined;
		logError("service.discovery_unreadable", { reason: errno ?? "unknown" });
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		logError("service.discovery_unreadable", { reason: "not_json" });
		throw error;
	}
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
	const published = await readPublishedDiscovery(target);
	if (published === undefined) return;
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
 *
 * The operation ledger opens only after ownership succeeds, and any operation it
 * finds unfinished is reported as interrupted. A restart never replays a provider
 * request: recovery records what was lost and stops there.
 */
export async function startService(
	options: { stateDir: string } & ServiceComposition,
): Promise<RunningService> {
	process.umask(0o077);
	proveFts5();

	const ownership: Ownership = await acquireOwnership(options.stateDir);
	let store: ServiceStore;
	try {
		const operationsPath = join(ownership.root, OPERATIONS_DATABASE);
		await createOrValidateManagedFile(operationsPath);
		store = openOperationStore(operationsPath);
	} catch (error) {
		ownership.release();
		throw error;
	}
	try {
		const interrupted = store.interruptUnfinished();
		if (interrupted > 0) {
			logInfo("service.operations_interrupted", { count: interrupted });
		}
	} catch (error) {
		store.close();
		ownership.release();
		throw error;
	}

	let composed: ComposedEngine;
	try {
		composed = await (options.engine ?? composePiEngine)({
			root: ownership.root,
			store,
		});
	} catch (error) {
		store.close();
		ownership.release();
		throw error;
	}
	const engine = composed.engine;

	const instanceId = randomUUID();
	const token = randomBytes(TOKEN_BYTES).toString("base64url");
	let expected = { host: "", token };
	let ready = false;

	// The coordinator and the snapshot hub are two halves of one seam: every
	// coordinator mutation announces a change, and the hub rebuilds the
	// authoritative snapshot from live state before publishing it. The hub is
	// created second because it reads the coordinator's view, so the announcement
	// goes through a reference that is filled in by then.
	let hub: SnapshotHub | null = null;
	const operations = createOperations({
		store,
		engine,
		onChange: () => hub?.changed(),
		...(options.deadlineMs === undefined
			? {}
			: { deadlineMs: options.deadlineMs }),
	});
	hub = createSnapshotHub({
		instanceId,
		conversation: () => engine.snapshot(),
		work: () => operations.view(),
	});
	const snapshots = hub;

	/**
	 * Stops accepted work, then closes the conversation, its host and the ledger,
	 * and releases ownership last.
	 *
	 * `operations.stop()` can reject when an authoritative write was lost. That
	 * report must survive, but it must not skip the rest of the teardown, so it
	 * runs inside its own `try` with everything else in the `finally`. The engine
	 * closes strictly before its host, because settling an in-flight run needs the
	 * host's runtime alive.
	 */
	async function shutDown(): Promise<void> {
		try {
			await operations.stop();
		} finally {
			snapshots.close();
			try {
				await engine.close();
			} finally {
				try {
					await composed.close();
				} finally {
					try {
						store.close();
					} finally {
						ownership.release();
					}
				}
			}
		}
	}

	const server = createServer(
		createRequestHandler({
			instanceId,
			pid: process.pid,
			expected: () => expected,
			ready: () => ready,
			...(options.maxBufferedBytes === undefined
				? {}
				: { maxBufferedBytes: options.maxBufferedBytes }),
			domain: { engine, operations, store, hub: snapshots },
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
		await shutDown().catch((failure: unknown) => {
			// The start failure below is the report; a teardown failure on this path
			// must not replace it, but it may not vanish either.
			logError("service.shutdown_failed", {
				code: isBrnError(failure) ? failure.code : "INTERNAL_ERROR",
			});
		});
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
				// Shutdown reverses startup: accepted work stops, the conversation and
				// its host settle and the ledger closes before ownership is released, so
				// no second writer can appear while any of them is still open.
				await shutDown();
			}
		},
	};
}
