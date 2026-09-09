import { DatabaseSync } from "node:sqlite";

/**
 * Opens a SQLite connection with BRN's security posture stated explicitly
 * rather than inherited from driver defaults.
 */
export function openDatabase(path: string): DatabaseSync {
	return new DatabaseSync(path, {
		allowExtension: false,
		enableForeignKeyConstraints: true,
		enableDoubleQuotedStringLiterals: false,
		allowUnknownNamedParameters: false,
		defensive: true,
		timeout: 0,
	});
}

/**
 * Fails startup on a SQLite build without FTS5, instead of discovering the gap
 * later when a search query silently has nowhere to run.
 */
export function proveFts5(): void {
	const db = openDatabase(":memory:");
	try {
		db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
		db.prepare("INSERT INTO probe(body) VALUES (?)").run("brn");
		const row = db
			.prepare("SELECT count(*) AS n FROM probe WHERE probe MATCH ?")
			.get("brn");
		if (row?.n !== 1) throw new Error("SQLITE_FTS5_UNAVAILABLE");
	} finally {
		db.close();
	}
}
