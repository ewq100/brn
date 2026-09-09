import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { BrnError } from "../core/errors.ts";
import { errnoOf, MANAGED_FILE_MODE } from "../core/fs.ts";
import { invalidStateDir, requireAbsoluteStateDir } from "../core/state-dir.ts";
import { syncDirectory } from "./fs.ts";
import { openDatabase } from "./sqlite.ts";

/** A state directory grants nothing to group or other. */
export const STATE_DIR_MODE = 0o700;

const WRITER_DATABASE = "writer.sqlite";
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * Single-writer ownership of a state directory, held by a kernel file lock for
 * as long as this process lives.
 */
export interface Ownership {
	readonly root: string;
	/** Ends the write transaction and closes the lock connection. Never unlinks state. */
	release(): void;
}

/** True only for a positively identified SQLite busy/locked result. */
function isSqliteBusy(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("errcode" in error))
		return false;
	const errcode = (error as { errcode: unknown }).errcode;
	if (typeof errcode !== "number") return false;
	const primary = errcode & 0xff;
	return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

function invalid(reason: string): BrnError {
	return invalidStateDir(reason);
}

/** Every path prefix of `path`, from the filesystem root inwards. */
function pathPrefixes(path: string): string[] {
	const segments = path.split(sep).filter((segment) => segment.length > 0);
	const prefixes: string[] = [sep];
	let current = "";
	for (const segment of segments) {
		current += sep + segment;
		prefixes.push(current);
	}
	return prefixes;
}

/**
 * Creates a managed directory if absent, then proves it is a real directory we
 * own, reachable without traversing a symlink, and closed to group and other.
 *
 * This guards the state directory itself and every directory BRN keeps inside
 * it, so there is one definition of "a directory this process may write to".
 *
 * The path is proven symlink-free before anything is created, so a rejected
 * directory leaves nothing behind. Only the final component is created: an
 * absent intermediate parent is reported as `missing_parent` rather than
 * silently materialising a chain of directories the caller never asked for,
 * each of which would need its own permission decision.
 */
export async function prepareStateDirectory(root: string): Promise<string> {
	requireAbsoluteStateDir(root);

	for (const prefix of pathPrefixes(root)) {
		if (prefix === root) continue;
		const stats = await lstat(prefix).catch((error: unknown) => {
			const errno = errnoOf(error);
			if (errno === "ENOENT") throw invalid("missing_parent");
			if (errno === "EACCES" || errno === "EPERM") {
				throw invalid("unusable_parent");
			}
			throw error;
		});
		if (stats.isSymbolicLink()) throw invalid("symlink");
	}

	try {
		await mkdir(root, { mode: STATE_DIR_MODE });
		await syncDirectory(dirname(root));
	} catch (error) {
		const errno = errnoOf(error);
		if (errno === "EEXIST") {
			// Fall through to the checks below, which decide whether it is usable.
		} else if (errno === "ENOENT") {
			// The parent vanished between the walk above and this mkdir.
			throw invalid("missing_parent");
		} else if (errno === "EACCES" || errno === "EPERM") {
			throw invalid("unusable_parent");
		} else {
			throw error;
		}
	}

	const stats = await lstat(root);
	if (stats.isSymbolicLink()) throw invalid("symlink");
	if (!stats.isDirectory()) throw invalid("not_directory");
	if (stats.uid !== process.getuid?.()) throw invalid("owner");
	if ((stats.mode & 0o077) !== 0) throw invalid("mode");
	return root;
}

/**
 * Proves a managed file is the file BRN wrote: a regular file, owned by us,
 * owner-only, and reachable by exactly one name.
 */
function assertManagedIdentity(stats: Stats): void {
	if (stats.isSymbolicLink()) throw invalid("symlink");
	if (!stats.isFile()) throw invalid("not_regular_file");
	if (stats.uid !== process.getuid?.()) throw invalid("owner");
	if ((stats.mode & 0o777) !== MANAGED_FILE_MODE) throw invalid("mode");
	if (stats.nlink !== 1) throw invalid("hard_link");
}

async function validateManagedFile(path: string): Promise<void> {
	assertManagedIdentity(await lstat(path));
}

/**
 * Applies the managed-file identity checks when the file exists, and accepts its
 * absence. A file that is present but unsafe is a startup error, never quietly
 * repaired.
 */
export async function requireSafeManagedFile(path: string): Promise<void> {
	const stats = await lstat(path).catch((error: unknown) => {
		if (errnoOf(error) === "ENOENT") return undefined;
		throw error;
	});
	if (stats !== undefined) assertManagedIdentity(stats);
}

/**
 * Creates a managed file exclusively, or accepts an existing one only after it
 * passes the identity checks. Never follows a symlink at the final component.
 */
export async function createOrValidateManagedFile(path: string): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(
			path,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			MANAGED_FILE_MODE,
		);
	} catch (error) {
		const errno = errnoOf(error);
		if (errno === "EEXIST" || errno === "ELOOP") {
			await validateManagedFile(path);
			return;
		}
		if (errno === "EACCES" || errno === "EPERM") throw invalid("unwritable");
		throw error;
	}
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(dirname(path));
}

/**
 * Acquires single-writer ownership of `root`.
 *
 * Ownership is an `EXCLUSIVE` transaction on `writer.sqlite` in rollback-journal
 * mode, so the kernel releases it when this process dies and no participant has
 * to guess whether a recorded PID is stale. Nothing writable — no application
 * database, no Pi session — may be opened before this resolves.
 */
export async function acquireOwnership(root: string): Promise<Ownership> {
	const stateDir = await prepareStateDirectory(root);
	const writerPath = join(stateDir, WRITER_DATABASE);
	await createOrValidateManagedFile(writerPath);

	const db = openDatabase(writerPath);
	try {
		db.exec("PRAGMA journal_mode=DELETE");
		db.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		db.close();
		// Only a busy/locked result means another writer holds the lock; permission,
		// corruption and I/O failures must stay distinguishable.
		if (isSqliteBusy(error)) throw new BrnError("ALREADY_RUNNING");
		throw error;
	}

	return {
		root: stateDir,
		release() {
			try {
				db.exec("ROLLBACK");
			} finally {
				db.close();
			}
		},
	};
}
