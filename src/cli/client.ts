import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import type { Operation, PromptCommand } from "../core/conversation.ts";
import { BrnError } from "../core/errors.ts";
import { errnoOf, MANAGED_FILE_MODE } from "../core/fs.ts";
import type { ResultResponse } from "../protocol/contracts.ts";
import {
	HealthSchema,
	OperationSchema,
	ResultResponseSchema,
} from "../protocol/contracts.ts";

const DISCOVERY_FILE = "discovery.json";

/**
 * A published instance description. `host` is pinned to the loopback interface by
 * pattern, so a tampered document cannot redirect the client off this machine.
 */
const DiscoveryDocument = Type.Object({
	version: Type.Literal(1),
	instanceId: Type.String({ minLength: 1 }),
	pid: Type.Integer(),
	host: Type.String({ pattern: "^127\\.0\\.0\\.1:[0-9]{1,5}$" }),
	token: Type.String({ minLength: 1 }),
});

/** The `GET /v1/health` contract now lives with the other shared contracts. */
export const HealthResponse = HealthSchema;

export type Health = Static<typeof HealthResponse>;

/**
 * An attached client. It reads a running service's discovery document and calls
 * it; it never starts a service and never takes ownership of its state.
 */
export interface Client {
	/** The loopback authority this client is attached to. */
	readonly host: string;
	/** The state directory whose discovery document this client was built from. */
	readonly stateDir: string;
	/** The instance this client validated before connecting. */
	readonly instanceId: string;
	/**
	 * Performs one authenticated request and returns the response only after it
	 * validates against `schema`, so a caller cannot name an unchecked return type.
	 */
	request<S extends TSchema>(
		method: string,
		path: string,
		schema: S,
		body?: unknown,
	): Promise<Static<S>>;
	/** Submits one prompt. `200` identifies an exact duplicate, `202` new work. */
	submit(command: PromptCommand): Promise<Operation>;
	operation(id: string): Promise<Operation>;
	result(id: string): Promise<ResultResponse>;
	/** Opens the authenticated event stream as raw bytes for the decoder. */
	events(signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
	/** Re-reads discovery and returns a client for whatever instance is published. */
	reattach(): Promise<Client>;
	/** Closes this client's subscriptions. It stops no operation and no service. */
	disconnect(): Promise<void>;
}

/**
 * Reads the discovery document without following a symlink and only after it
 * proves to be our own owner-only, single-link regular file.
 */
async function readDiscovery(
	stateDir: string,
): Promise<Static<typeof DiscoveryDocument>> {
	const path = join(stateDir, DISCOVERY_FILE);
	let text: string;
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	).catch((error: unknown) => {
		const errno = errnoOf(error);
		if (errno === "ENOENT") throw new BrnError("NO_SERVICE");
		if (errno === "ELOOP") throw new BrnError("INSECURE_DISCOVERY", "symlink");
		throw error;
	});
	try {
		const stats = await handle.stat();
		if (!stats.isFile())
			throw new BrnError("INSECURE_DISCOVERY", "not_regular_file");
		if (stats.uid !== process.getuid?.())
			throw new BrnError("INSECURE_DISCOVERY", "owner");
		if ((stats.mode & 0o777) !== MANAGED_FILE_MODE) {
			throw new BrnError("INSECURE_DISCOVERY", "mode");
		}
		if (stats.nlink !== 1)
			throw new BrnError("INSECURE_DISCOVERY", "hard_link");
		text = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BrnError("INVALID_DISCOVERY", "not_json");
	}
	if (!Check(DiscoveryDocument, parsed))
		throw new BrnError("INVALID_DISCOVERY", "schema");
	return parsed;
}

/** Attaches to the service already running in `stateDir`. */
export async function connect(stateDir: string): Promise<Client> {
	const discovery = await readDiscovery(stateDir);
	const authority = discovery.host;
	/** Every stream this client opened, so `disconnect` can end all of them. */
	const streams = new Set<AbortController>();

	function authorized(accept: string): Record<string, string> {
		return {
			Authorization: `Bearer ${discovery.token}`,
			Accept: accept,
		};
	}

	/**
	 * One authenticated request, accepted only with an expected status and only
	 * after the body validates. `expected` is explicit because a duplicate
	 * submission answers `200` where new work answers `202`.
	 */
	async function call<S extends TSchema>(
		method: string,
		path: string,
		schema: S,
		body: unknown,
		expected: readonly number[],
	): Promise<Static<S>> {
		const headers = authorized("application/json");
		if (body !== undefined)
			headers["Content-Type"] = "application/json; charset=utf-8";
		let response: Response;
		try {
			response = await fetch(`http://${authority}${path}`, {
				method,
				headers,
				redirect: "error",
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new BrnError("SERVICE_UNREACHABLE");
		}
		if (!expected.includes(response.status)) {
			throw new BrnError("REQUEST_FAILED", String(response.status));
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new BrnError("INVALID_RESPONSE", "not_json");
		}
		if (!Check(schema, payload))
			throw new BrnError("INVALID_RESPONSE", "schema");
		return payload;
	}

	const client: Client = {
		host: authority,
		stateDir,
		instanceId: discovery.instanceId,
		async request<S extends TSchema>(
			method: string,
			path: string,
			schema: S,
			body?: unknown,
		): Promise<Static<S>> {
			return await call(method, path, schema, body, [200]);
		},
		async submit(command: PromptCommand): Promise<Operation> {
			// `200` is an exact duplicate of work already admitted and `202` is new
			// work; both report the record the ledger committed, which may already
			// describe a failure.
			return await call(
				"POST",
				"/v1/operations",
				OperationSchema,
				command,
				[200, 202],
			);
		},
		async operation(id: string): Promise<Operation> {
			return await call(
				"GET",
				`/v1/operations/${encodeURIComponent(id)}`,
				OperationSchema,
				undefined,
				[200],
			);
		},
		async result(id: string): Promise<ResultResponse> {
			return await call(
				"GET",
				`/v1/operations/${encodeURIComponent(id)}/result`,
				ResultResponseSchema,
				undefined,
				[200],
			);
		},
		async events(signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
			const controller = new AbortController();
			streams.add(controller);
			if (signal?.aborted === true) controller.abort();
			signal?.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
			let response: Response;
			try {
				response = await fetch(`http://${authority}/v1/events`, {
					headers: authorized("text/event-stream"),
					redirect: "error",
					signal: controller.signal,
				});
			} catch {
				streams.delete(controller);
				throw new BrnError("SERVICE_UNREACHABLE");
			}
			const body = response.body;
			if (response.status !== 200 || body === null) {
				controller.abort();
				streams.delete(controller);
				throw new BrnError("REQUEST_FAILED", String(response.status));
			}
			return readChunks(body, () => {
				streams.delete(controller);
			});
		},
		async reattach(): Promise<Client> {
			// Discovery is re-read rather than assumed: the published instance may have
			// changed, and it is validated again before anything connects to it.
			return await connect(stateDir);
		},
		async disconnect(): Promise<void> {
			for (const controller of streams) controller.abort();
			streams.clear();
		},
	};
	return client;
}

/** Yields a response body's bytes and always releases the reader. */
async function* readChunks(
	body: ReadableStream<Uint8Array>,
	done: () => void,
): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) return;
			if (next.value !== undefined) yield next.value;
		}
	} finally {
		reader.releaseLock();
		done();
	}
}
