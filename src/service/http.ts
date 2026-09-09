import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ConversationEngine,
	Operation,
	OperationStore,
	Operations,
	PromptCommand,
} from "../core/conversation.ts";
import { BrnError, type BrnErrorCode, isBrnError } from "../core/errors.ts";
import {
	isCancelRequest,
	isModelRequest,
	isPrompt,
	isResumeRequest,
	MAX_BODY_BYTES,
	MAX_LIST_ITEMS,
	MAX_PROMPT_BYTES,
	promptBytes,
} from "../protocol/contracts.ts";
import { attachEventStream, type SnapshotHub } from "./events.ts";
import { logError, newDiagnosticId } from "./log.ts";

/** The one media type a BRN request body may use. */
const JSON_CONTENT_TYPE = "application/json";

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

/** The fixed public text for each status BRN answers with. */
const STATUS_MESSAGES: ReadonlyMap<number, string> = new Map([
	[400, "Bad Request"],
	[401, "Unauthorized"],
	[403, "Forbidden"],
	[404, "Not Found"],
	[409, "Conflict"],
	[413, "Payload Too Large"],
	[500, "Internal Server Error"],
	[503, "Service Unavailable"],
]);

/**
 * The complete, fixed mapping from failure code to wire response. A code absent
 * from this allowlist is reported as an opaque internal error, so a new code can
 * never leak an unreviewed status or message.
 */
const WIRE_FAILURES: ReadonlyMap<BrnErrorCode, number> = new Map([
	["INVALID_REQUEST", 400],
	["UNSUPPORTED_CONTENT_TYPE", 400],
	["EMPTY_PROMPT", 400],
	["UNAUTHORIZED", 401],
	["ORIGIN_OR_HOST_DENIED", 403],
	["NOT_FOUND", 404],
	["UNKNOWN_OPERATION", 404],
	["BUSY", 409],
	["SESSION_MISMATCH", 409],
	["MODEL_MISMATCH", 409],
	["REQUEST_ID_REUSED", 409],
	["OPERATION_CONFLICT", 409],
	["MODEL_UNAVAILABLE", 409],
	["SESSION_CONFLICT", 409],
	["NO_MODEL", 409],
	["NO_ACTIVE_SESSION", 409],
	["INPUT_TOO_LARGE", 413],
	["NOT_READY", 503],
	["SERVICE_STOPPING", 503],
	["SESSION_UNAVAILABLE", 503],
	["RESULT_UNAVAILABLE", 503],
	["STATE_CORRUPT", 503],
	// A ledger written by a newer BRN is unavailable state, not an internal fault.
	["STATE_VERSION_UNSUPPORTED", 503],
	["STATE_UNAVAILABLE", 503],
]);

/**
 * The status for a recorded operation failure.
 *
 * This vocabulary is wider than `RunResult.failed.code`: `NO_MODEL` and
 * `AUTH_REQUIRED` arrive as failed run results, while the precise reasons BRN
 * records itself arrive as `Operation.failureCode`. Both are read.
 */
const FAILURE_STATUSES: ReadonlyMap<string, number> = new Map([
	["EMPTY_PROMPT", 400],
	["NO_MODEL", 409],
	["MODEL_UNAVAILABLE", 409],
	["OUTPUT_LIMIT", 409],
	// Absent provider credentials are a precondition the operator must satisfy,
	// not corrupt or unavailable state.
	["AUTH_REQUIRED", 409],
	["INPUT_TOO_LARGE", 413],
	["PROVIDER_ERROR", 503],
	["DEADLINE_EXCEEDED", 503],
	["SESSION_UNAVAILABLE", 503],
	["RESULT_UNAVAILABLE", 503],
	["STATE_UNAVAILABLE", 503],
	["STATE_CORRUPT", 503],
	["STATE_VERSION_UNSUPPORTED", 503],
	["SERVICE_INTERRUPTED", 503],
	["INTERNAL_ERROR", 500],
]);

function sendFailure(
	response: ServerResponse,
	status: number,
	code: string,
): void {
	sendJson(response, status, {
		error: {
			code,
			message: STATUS_MESSAGES.get(status) ?? "Internal Server Error",
		},
	});
}

/** Answers a failure with fixed text only: never a message, path or PID. */
export function sendError(
	response: ServerResponse,
	error: unknown,
	context: { operationId?: string; startedAt?: number } = {},
): void {
	const status = isBrnError(error) ? WIRE_FAILURES.get(error.code) : undefined;
	if (status === undefined) {
		// An unmapped exception is a genuine internal fault. The response stays
		// opaque, but it must not be invisible in operational logs; the fields are a
		// generated identifier, a fixed code and timing, and carry no prompt, path,
		// token or PID.
		logError("http.internal_error", {
			diagnosticId: newDiagnosticId(),
			code: isBrnError(error) ? error.code : "UNMAPPED_EXCEPTION",
			operationId: context.operationId,
			elapsedMs:
				context.startedAt === undefined
					? undefined
					: Date.now() - context.startedAt,
		});
		sendFailure(response, 500, "INTERNAL_ERROR");
		return;
	}
	sendFailure(
		response,
		status,
		isBrnError(error) ? error.code : "INTERNAL_ERROR",
	);
}

/** Reports a recorded operation failure using its own recorded reason. */
function sendOperationFailure(response: ServerResponse, code: string): void {
	sendFailure(response, FAILURE_STATUSES.get(code) ?? 500, code);
}

/** The coordinated state one request may act on. */
export interface ServiceDomain {
	readonly engine: ConversationEngine;
	readonly operations: Operations;
	readonly store: OperationStore;
	readonly hub: SnapshotHub;
}

/** What the request handler needs to know about the running instance. */
export interface ServiceView {
	readonly instanceId: string;
	readonly pid: number;
	/** The bound loopback authority and bearer token the handler must see right now. */
	expected(): { host: string; token: string };
	/** False while starting up or shutting down. */
	ready(): boolean;
	/**
	 * A constructor-only override of the event stream's queued-byte ceiling, used
	 * by the test composition entry. Production leaves it undefined, and no
	 * request, header or environment variable can reach it.
	 */
	readonly maxBufferedBytes?: number;
	readonly domain: ServiceDomain;
}

function isJsonContentType(value: string | undefined): boolean {
	if (value === undefined) return false;
	const [type = "", ...parameters] = value
		.split(";")
		.map((part) => part.trim());
	if (type.toLowerCase() !== JSON_CONTENT_TYPE) return false;
	return parameters.every((parameter) => {
		const lowered = parameter.toLowerCase();
		return lowered === "" || lowered === "charset=utf-8";
	});
}

/**
 * Reads one bounded JSON request body.
 *
 * An oversized declared length is refused before a byte is read, and a chunked
 * body is refused the moment it passes the same ceiling. Decoding is strict, so
 * malformed UTF-8 is a rejection rather than a string full of replacement
 * characters.
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	if (!isJsonContentType(request.headers["content-type"])) {
		throw new BrnError("UNSUPPORTED_CONTENT_TYPE");
	}
	const declared = request.headers["content-length"];
	if (declared !== undefined) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new BrnError("INVALID_REQUEST", "content_length");
		}
		if (length > MAX_BODY_BYTES) {
			throw new BrnError("INPUT_TOO_LARGE", "declared_length");
		}
	}
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "";
	let received = 0;
	for await (const chunk of request) {
		const bytes = chunk as Buffer;
		received += bytes.byteLength;
		if (received > MAX_BODY_BYTES) {
			throw new BrnError("INPUT_TOO_LARGE", "body");
		}
		try {
			text += decoder.decode(bytes, { stream: true });
		} catch {
			throw new BrnError("INVALID_REQUEST", "utf8");
		}
	}
	try {
		text += decoder.decode();
	} catch {
		throw new BrnError("INVALID_REQUEST", "utf8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new BrnError("INVALID_REQUEST", "json");
	}
}

/**
 * The digest that decides whether a repeated request ID is the same request.
 *
 * The tuple is fixed and versioned. It is a digest of the submission, never a
 * copy of the prompt, and it needs no sorting or whitespace normalisation
 * because every field is named here explicitly.
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

/** Matches the operation routes and captures a syntactically valid identifier. */
const OPERATION_ROUTE = /^\/v1\/operations\/([^/?#]+)(?:\/(result|cancel))?$/;
const OPERATION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function submitPrompt(
	view: ServiceView,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readJsonBody(request);
	if (!isPrompt(body)) throw new BrnError("INVALID_REQUEST", "schema");
	// The schema bounds characters; this bounds UTF-8 bytes, which is the limit
	// BRN actually promises.
	if (promptBytes(body.text) > MAX_PROMPT_BYTES) {
		throw new BrnError("INPUT_TOO_LARGE", "prompt");
	}
	if (body.text.trim().length === 0) throw new BrnError("EMPTY_PROMPT");
	const command: PromptCommand = {
		requestId: body.requestId,
		sessionId: body.sessionId,
		model: { provider: body.model.provider, id: body.model.id },
		text: body.text,
	};
	const { operations, store } = view.domain;
	const requestHash = requestDigest(command);
	const existed = store.find(command.requestId) !== null;
	// The committed record is what is reported, which may already be a failure: an
	// engine that refuses synchronously settles inside this call.
	const operation = operations.submit(command, requestHash);
	sendJson(response, existed ? 200 : 202, operation);
}

/**
 * Answers with the durable text of a settled operation.
 *
 * Unfinished work is refused visibly instead of returning a half answer. The
 * current conversation's entries are read directly from the live native session;
 * anything else needs the control seat, so it is refused while the seat is busy
 * rather than displacing the running conversation.
 */
async function sendResult(
	view: ServiceView,
	id: string,
	response: ServerResponse,
): Promise<void> {
	const { engine, operations, store } = view.domain;
	const record = store.find(id);
	if (record === null) throw new BrnError("UNKNOWN_OPERATION");
	if (
		record.state === "accepted" ||
		record.state === "running" ||
		record.state === "cancelling"
	) {
		throw new BrnError("BUSY");
	}
	if (record.state === "interrupted") {
		sendOperationFailure(response, "SERVICE_INTERRUPTED");
		return;
	}
	const result = record.result;
	if (result === null) throw new BrnError("RESULT_UNAVAILABLE");
	if (result.kind === "failed") {
		sendOperationFailure(response, record.failureCode ?? result.code);
		return;
	}
	const active = engine.snapshot().session;
	const read = () => engine.readResult(record.sessionId, result.entryIds);
	const text =
		active !== null && active.id === record.sessionId
			? await read()
			: await operations.control(read);
	sendJson(response, 200, {
		text,
		// A cancelled answer is a partial one, and stays distinguishable as such.
		truncated: result.kind === "completed" ? result.truncated : true,
	});
}

async function cancelOperation(
	view: ServiceView,
	id: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readJsonBody(request);
	if (!isCancelRequest(body)) throw new BrnError("INVALID_REQUEST", "schema");
	const cancelled: Operation = await view.domain.operations.cancel(id);
	sendJson(response, 200, cancelled);
}

/** Dispatches one authenticated request to exactly one route. */
async function dispatch(
	view: ServiceView,
	request: IncomingMessage,
	response: ServerResponse,
	context: { operationId?: string },
): Promise<void> {
	const target = request.url ?? "";
	const method = request.method ?? "GET";
	const { engine, operations, hub, store } = view.domain;

	if (method === "GET") {
		switch (target) {
			case "/v1/health":
				sendJson(response, 200, {
					status: "ok",
					ready: true,
					version: 1,
					instanceId: view.instanceId,
					pid: view.pid,
				});
				return;
			case "/v1/snapshot":
				sendJson(response, 200, hub.snapshot());
				return;
			case "/v1/events":
				attachEventStream(
					hub,
					request,
					response,
					view.maxBufferedBytes === undefined
						? {}
						: { maxBufferedBytes: view.maxBufferedBytes },
				);
				return;
			case "/v1/models":
				sendJson(response, 200, {
					models: (await engine.models()).slice(0, MAX_LIST_ITEMS),
				});
				return;
			case "/v1/sessions":
				sendJson(response, 200, {
					sessions: (await engine.sessions()).slice(0, MAX_LIST_ITEMS),
				});
				return;
			default:
				break;
		}
	}

	if (method === "POST") {
		switch (target) {
			case "/v1/sessions": {
				const body = await readJsonBody(request);
				if (!isModelRequest(body))
					throw new BrnError("INVALID_REQUEST", "schema");
				// Selected-session and default-model metadata is persisted by the
				// conversation host, and only after the native operation succeeds.
				const session = await operations.control(() =>
					engine.create({ ...body.model }),
				);
				sendJson(response, 201, session);
				return;
			}
			case "/v1/sessions/resume": {
				const body = await readJsonBody(request);
				if (!isResumeRequest(body))
					throw new BrnError("INVALID_REQUEST", "schema");
				// The identifier is an opaque bounded string. It is handed to the
				// conversation host as data and never joined onto a filesystem path here.
				const session = await operations.control(() =>
					engine.resume(body.sessionId),
				);
				sendJson(response, 200, session);
				return;
			}
			case "/v1/model": {
				const body = await readJsonBody(request);
				if (!isModelRequest(body))
					throw new BrnError("INVALID_REQUEST", "schema");
				const session = await operations.control(async () => {
					await engine.selectModel({ ...body.model });
					const seated = engine.snapshot().session;
					if (seated === null) throw new BrnError("NO_ACTIVE_SESSION");
					return seated;
				});
				sendJson(response, 200, session);
				return;
			}
			case "/v1/operations":
				await submitPrompt(view, request, response);
				return;
			default:
				break;
		}
	}

	const operationRoute = OPERATION_ROUTE.exec(target);
	if (operationRoute !== null) {
		const id = operationRoute[1] ?? "";
		const suffix = operationRoute[2];
		if (!OPERATION_ID.test(id)) {
			throw new BrnError("INVALID_REQUEST", "operation_id");
		}
		// From here an unexplained fault can name the operation it concerned, which
		// is an identifier BRN generated and not content.
		context.operationId = id;
		if (method === "GET" && suffix === undefined) {
			const record = store.find(id);
			if (record === null) throw new BrnError("UNKNOWN_OPERATION");
			sendJson(response, 200, record);
			return;
		}
		if (method === "GET" && suffix === "result") {
			await sendResult(view, id, response);
			return;
		}
		if (method === "POST" && suffix === "cancel") {
			await cancelOperation(view, id, request, response);
			return;
		}
	}

	throw new BrnError("NOT_FOUND");
}

/**
 * Builds the request handler.
 *
 * Authentication runs before anything reads the request target or domain state,
 * so an unauthenticated caller learns nothing beyond "unauthorised". A target
 * must match a route exactly, which rejects absolute-form targets and any query
 * string rather than looking for credentials there.
 */
export function createRequestHandler(
	view: ServiceView,
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		const startedAt = Date.now();
		const context: { operationId?: string } = {};
		const settle = (error: unknown) => {
			if (response.headersSent) {
				// A stream or a body already began: there is no status left to change, so
				// the connection ends rather than appending an error to valid output.
				response.destroy();
				return;
			}
			sendError(response, error, { ...context, startedAt });
		};
		try {
			authenticate(request, view.expected());
			if (!view.ready()) throw new BrnError("NOT_READY");
			const dispatched = dispatch(view, request, response, context);
			dispatched.catch(settle);
		} catch (error) {
			settle(error);
		}
	};
}
