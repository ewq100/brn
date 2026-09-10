/**
 * Filesystem facts every BRN layer needs.
 *
 * Both the service, which creates managed files, and the client, which proves a
 * managed file is safe to read, depend on these. They live in `core` so a single
 * definition serves both without the client importing service internals.
 */

/** Every file BRN creates inside a state directory is owner read/write only. */
export const MANAGED_FILE_MODE = 0o600;

/** The `errno` string of a Node system error, or undefined for anything else. */
export function errnoOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code: unknown }).code;
		if (typeof code === "string") return code;
	}
	return undefined;
}
