/**
 * The one definition of a state-directory path BRN will accept.
 *
 * Both the service, which creates and locks the directory, and the client, which
 * is pointed at one on the command line, apply the same rule, so a client can
 * never be aimed at a path the service would refuse. It lives in `core` for that
 * reason: the client must not import a service internal to ask the question, and
 * asking it must not drag the SQLite binding or the lock-acquisition code into a
 * process that must never call them.
 *
 * The check is written against the path text rather than `node:path`, so this
 * module keeps `core`'s rule of no Node, Pi, transport or storage imports. It is
 * a POSIX rule on every platform, and it accepts exactly the paths POSIX
 * `normalize` leaves unchanged: rooted at `/`, no empty, `.` or `..` segment, at
 * most one trailing separator. A Windows-style path is rejected rather than
 * reinterpreted. `test/ownership.test.ts` pins the equivalence.
 */

import { BrnError } from "./errors.ts";

/**
 * An `INVALID_STATE_DIR` failure, whose detail names one reason from BRN's own
 * fixed vocabulary and never carries the path.
 */
export function invalidStateDir(reason: string): BrnError {
	return new BrnError("INVALID_STATE_DIR", reason);
}

/** Rejects a path that is not an already-normalised absolute path. */
export function requireAbsoluteStateDir(path: string): string {
	if (!path.startsWith("/")) throw invalidStateDir("not_absolute");
	// One trailing separator is accepted, exactly as POSIX `normalize` keeps it.
	const body = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
	if (body === "/") {
		if (path !== "/") throw invalidStateDir("not_absolute");
		return path;
	}
	for (const segment of body.slice(1).split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw invalidStateDir("not_absolute");
		}
	}
	return path;
}
