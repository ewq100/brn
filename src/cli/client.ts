import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";
import { BrnError } from "../core/errors.ts";

const DISCOVERY_FILE = "discovery.json";
const MANAGED_FILE_MODE = 0o600;

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

/** The `GET /v1/health` contract. Shared response contracts move out at Task 5. */
export const HealthResponse = Type.Object({
	status: Type.Literal("ok"),
	version: Type.Literal(1),
	instanceId: Type.String({ minLength: 1 }),
	pid: Type.Integer(),
});

export type Health = Static<typeof HealthResponse>;

/**
 * An attached client. It reads a running service's discovery document and calls
 * it; it never starts a service and never takes ownership of its state.
 */
export interface Client {
	/** The loopback authority this client is attached to. */
	readonly host: string;
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
}

function errnoOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
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

	return {
		host: authority,
		async request<S extends TSchema>(
			method: string,
			path: string,
			schema: S,
			body?: unknown,
		): Promise<Static<S>> {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${discovery.token}`,
				Accept: "application/json",
			};
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
			if (response.status !== 200) {
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
		},
	};
}
