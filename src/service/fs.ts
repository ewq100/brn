import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * fsync a directory so a newly created, renamed or removed entry inside it
 * survives a crash.
 *
 * One definition only: two copies of a durability primitive would drift, and
 * durability is the thing that cannot afford to drift.
 */
export async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
