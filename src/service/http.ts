import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BrnError, type BrnErrorCode, isBrnError } from "../core/errors.ts";

/** The only request BRN answers at this stage. */
const HEALTH_TARGET = "/v1/health";

/**
 * Rejects a request that is not an authenticated, loopback-addressed call from a
 * local attaching client.
 *
 * Raw headers are counted before Node's normalised view so a smuggled duplicate
 * `Host` or `Authorization` cannot be laundered into a single joined value. Any
 * `Origin` at all is refused: BRN is not a web origin and grants no CORS.
 */
export function authenticate(
	request: IncomingMessage,
	expected: { host: string; token: string },
): void {
	const counts = new Map<string, number>();
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		const name = request.rawHeaders[index]?.toLowerCase();
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	if (counts.get("authorization") !== 1 || counts.get("host") !== 1) {
		throw new BrnError("UNAUTHORIZED");
	}
	if (request.headers.host !== expected.host || counts.has("origin")) {
		throw new BrnError("ORIGIN_OR_HOST_DENIED");
	}
	const header = request.headers.authorization;
	const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
	const actual = Buffer.from(supplied, "utf8");
	const wanted = Buffer.from(expected.token, "utf8");
	if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
		throw new BrnError("UNAUTHORIZED");
	}
}

export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

/**
 * The complete, fixed mapping from failure code to wire response. A code absent
 * from this allowlist is reported as an opaque internal error, so a new code can
 * never leak an unreviewed status or message.
 */
const WIRE_FAILURES: ReadonlyMap<
	BrnErrorCode,
	{ status: number; message: string }
> = new Map([
	["UNAUTHORIZED", { status: 401, message: "Unauthorized" }],
	["ORIGIN_OR_HOST_DENIED", { status: 403, message: "Forbidden" }],
	["NOT_FOUND", { status: 404, message: "Not Found" }],
	["NOT_READY", { status: 503, message: "Service Unavailable" }],
]);

/** Answers a failure with fixed text only: never a message, path or PID. */
export function sendError(response: ServerResponse, error: unknown): void {
	const failure = isBrnError(error) ? WIRE_FAILURES.get(error.code) : undefined;
	if (failure === undefined) {
		sendJson(response, 500, {
			error: { code: "INTERNAL_ERROR", message: "Internal Server Error" },
		});
		return;
	}
	sendJson(response, failure.status, {
		error: {
			code: isBrnError(error) ? error.code : "INTERNAL_ERROR",
			message: failure.message,
		},
	});
}

/** What the request handler needs to know about the running instance. */
export interface ServiceView {
	readonly instanceId: string;
	readonly pid: number;
	/** The bound loopback authority and bearer token the handler must see right now. */
	expected(): { host: string; token: string };
	/** False while starting up or shutting down. */
	ready(): boolean;
}

/**
 * Builds the request handler.
 *
 * Authentication runs before anything reads the request target or domain state,
 * so an unauthenticated caller learns nothing beyond "unauthorised". The target
 * must equal the route exactly, which rejects absolute-form targets and any
 * query string rather than looking for credentials there.
 */
export function createRequestHandler(
	view: ServiceView,
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		try {
			authenticate(request, view.expected());
			if (!view.ready()) throw new BrnError("NOT_READY");
			if (request.method !== "GET" || request.url !== HEALTH_TARGET) {
				throw new BrnError("NOT_FOUND");
			}
			sendJson(response, 200, {
				status: "ok",
				version: 1,
				instanceId: view.instanceId,
				pid: view.pid,
			});
		} catch (error) {
			sendError(response, error);
		}
	};
}
