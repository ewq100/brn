/**
 * The vocabulary of BRN failures that cross a process or protocol boundary.
 *
 * Codes are the only failure text BRN ever exposes: they are fixed, contain no
 * caller data, and are safe to log or return in a response body. Later
 * capabilities extend this union; only codes in use are listed.
 */
export type BrnErrorCode =
	/** Another live process already holds single-writer ownership of the state directory. */
	| "ALREADY_RUNNING"
	/** The state directory, or a managed file inside it, failed a safety check. */
	| "INVALID_STATE_DIR"
	/** Authentication was absent, malformed, or wrong. */
	| "UNAUTHORIZED"
	/** The request carried an Origin, or a Host other than the bound loopback authority. */
	| "ORIGIN_OR_HOST_DENIED"
	/** No route matches the request method and target. */
	| "NOT_FOUND"
	/** The service is starting up or shutting down and accepts no work. */
	| "NOT_READY"
	/** No discovery document exists, so no service is running in this state directory. */
	| "NO_SERVICE"
	/** The discovery document exists but is not an owner-only, single-link regular file. */
	| "INSECURE_DISCOVERY"
	/** The discovery document is not a well-formed loopback service description. */
	| "INVALID_DISCOVERY"
	/** The described loopback address refused or dropped the connection. */
	| "SERVICE_UNREACHABLE"
	/** The service answered with a status the client cannot use. */
	| "REQUEST_FAILED"
	/** The service answered with a body that does not match the expected schema. */
	| "INVALID_RESPONSE"
	/** The CLI does not implement the requested command. */
	| "UNSUPPORTED_COMMAND";

/**
 * A failure identified by a fixed code.
 *
 * `detail` narrows the code to one of a fixed set of reasons chosen in BRN's own
 * source. It never carries a path, a token, a prompt, or an upstream exception
 * message, so it is safe to log — but it is still never sent to a client.
 */
export class BrnError extends Error {
	readonly code: BrnErrorCode;
	readonly detail: string | undefined;

	constructor(code: BrnErrorCode, detail?: string) {
		super(detail === undefined ? code : `${code}: ${detail}`);
		this.name = "BrnError";
		this.code = code;
		this.detail = detail;
	}
}

/** Narrows an unknown thrown value to a BRN failure. */
export function isBrnError(error: unknown): error is BrnError {
	return error instanceof BrnError;
}
