import type { DatabaseSync } from "node:sqlite";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type {
	ModelId,
	Operation,
	OperationState,
	OperationStore,
	PromptCommand,
	RunResult,
} from "../core/conversation.ts";
import { BrnError, isBrnError } from "../core/errors.ts";
import { openDatabase } from "./sqlite.ts";

/** The schema version this build understands. A newer file is refused, never downgraded. */
const SCHEMA_VERSION = 1;

/** The states that occupy the single-operation slot. */
const UNFINISHED_STATES = "'accepted','running','cancelling'";

/** Recorded against every operation a restart found unfinished. */
const INTERRUPTED_FAILURE_CODE = "SERVICE_INTERRUPTED";

/** SQLite primary result codes we classify rather than propagate. */
const SQLITE_CONSTRAINT = 19;

/**
 * The whole schema, applied in one transaction so a partially migrated database
 * cannot exist. `operations` is the authoritative operation ledger and holds no
 * conversation bodies: `request_hash` is a digest of the submitted payload, and
 * results are references to native session entries.
 *
 * `one_unfinished_operation` is a partial unique index over a constant, which is
 * how "at most one unfinished operation" becomes a database invariant rather than
 * a convention the application has to remember.
 *
 * `settings` and `sessions` carry only the selected-session and selected-model
 * metadata Task 3 needs; they are not a transcript and not a replacement for the
 * native session manager's listing.
 */
const MIGRATION = `
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('accepted','running','cancelling','succeeded','failed','cancelled','interrupted')),
  result_json TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_unfinished_operation ON operations ((1))
  WHERE state IN ('accepted','running','cancelling');
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  model_json TEXT NOT NULL,
  materialized INTEGER NOT NULL CHECK (materialized IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;
PRAGMA user_version=1;
`;

const UsageSchema = Type.Object(
	{
		input: Type.Integer(),
		output: Type.Integer(),
		cacheRead: Type.Integer(),
		cacheWrite: Type.Integer(),
		totalTokens: Type.Integer(),
	},
	{ additionalProperties: false },
);

/**
 * The persisted outcome union. Stored JSON is decoded through this schema, so a
 * hand-edited or truncated `result_json` is a reported failure rather than a
 * value the rest of the service quietly trusts.
 */
const RunResultSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("completed"),
			entryIds: Type.Array(Type.String()),
			truncated: Type.Boolean(),
			usage: UsageSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("cancelled"),
			entryIds: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("failed"),
			code: Type.Union([
				Type.Literal("PROVIDER_ERROR"),
				Type.Literal("NO_MODEL"),
				Type.Literal("AUTH_REQUIRED"),
			]),
			entryIds: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	),
]);

const OperationStateSchema = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("running"),
	Type.Literal("cancelling"),
	Type.Literal("succeeded"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("interrupted"),
]);

const OperationRowSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		session_id: Type.String({ minLength: 1 }),
		request_hash: Type.String({ minLength: 1 }),
		state: OperationStateSchema,
		result_json: Type.Union([Type.String(), Type.Null()]),
		failure_code: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false },
);

// The persisted schemas and the core types must stay the same shape in both
// directions; a drift in either file is a compile error rather than a decode
// failure discovered at runtime.
type Assignable<_A extends B, B> = B;
type _PersistedResultIsRunResult = Assignable<
	Static<typeof RunResultSchema>,
	RunResult
>;
type _RunResultIsPersistable = Assignable<
	RunResult,
	Static<typeof RunResultSchema>
>;
type _PersistedStateIsOperationState = Assignable<
	Static<typeof OperationStateSchema>,
	OperationState
>;

const SELECT_COLUMNS =
	"id, session_id, request_hash, state, result_json, failure_code";

/** The keys the `settings` table holds. Both are single-valued. */
const ACTIVE_SESSION_KEY = "active_session";
const DEFAULT_MODEL_KEY = "default_model";

const ModelIdSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		id: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const SessionRowSchema = Type.Object(
	{
		model_json: Type.String({ minLength: 1 }),
		materialized: Type.Integer({ minimum: 0, maximum: 1 }),
	},
	{ additionalProperties: false },
);

const SettingRowSchema = Type.Object(
	{ value_json: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

type _PersistedModelIsModelId = Assignable<
	Static<typeof ModelIdSchema>,
	ModelId
>;
type _ModelIdIsPersistable = Assignable<ModelId, Static<typeof ModelIdSchema>>;

/** What BRN remembers about one native session, beside the session file itself. */
export type SessionMetadata = {
	model: ModelId;
	/**
	 * True once the native session has durable bytes. Pi assigns a session ID and
	 * path before it writes anything, so an unmaterialized session exists only as
	 * this row and is recreated by ID rather than opened from a file.
	 */
	materialized: boolean;
};

/**
 * The service-local session and default-model metadata.
 *
 * These accessors stay out of the core `OperationStore` interface: the operation
 * coordinator has no business knowing which session BRN last hosted, and `core`
 * stays free of storage concerns.
 */
export interface SessionMetadataStore {
	rememberSession(id: string, model: ModelId, materialized: boolean): void;
	sessionMetadata(id: string): SessionMetadata | null;
	setActiveSession(id: string | null): void;
	getActiveSession(): string | null;
	setDefaultModel(model: ModelId): void;
	getDefaultModel(): ModelId | null;
}

/** Everything one BRN service process reads and writes in `operations.sqlite`. */
export type ServiceStore = OperationStore & SessionMetadataStore;

function corrupt(reason: string): BrnError {
	return new BrnError("STATE_CORRUPT", reason);
}

/** Decodes one selected row, refusing anything that is not a BRN operation. */
function decodeOperation(row: unknown): Operation {
	if (!Check(OperationRowSchema, row)) throw corrupt("operation_row");
	return {
		id: row.id,
		sessionId: row.session_id,
		requestHash: row.request_hash,
		state: row.state,
		result: row.result_json === null ? null : decodeResult(row.result_json),
		failureCode: row.failure_code,
	};
}

function decodeResult(json: string): RunResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw corrupt("result_not_json");
	}
	if (!Check(RunResultSchema, parsed)) throw corrupt("result_schema");
	return parsed;
}

/** Decodes a stored model identity, refusing anything that is not one. */
function decodeModel(json: string): ModelId {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw corrupt("model_not_json");
	}
	if (!Check(ModelIdSchema, parsed)) throw corrupt("model_schema");
	return parsed;
}

/** Decodes a stored session identifier, refusing anything that is not one. */
function decodeSessionId(json: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw corrupt("session_id_not_json");
	}
	if (typeof parsed !== "string" || parsed.length === 0) {
		throw corrupt("session_id_schema");
	}
	return parsed;
}

/** True only for a positively identified SQLite constraint violation. */
function isConstraintViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("errcode" in error))
		return false;
	const errcode = (error as { errcode: unknown }).errcode;
	return typeof errcode === "number" && (errcode & 0xff) === SQLITE_CONSTRAINT;
}

function changedRows(result: { changes: number | bigint }): number {
	return Number(result.changes);
}

/**
 * Proves the file is a readable SQLite database whose pages are internally
 * consistent, before anything writes to it. A failure is reported, never
 * repaired: authoritative BRN state is not disposable.
 */
function requireIntact(db: DatabaseSync): void {
	let rows: unknown[];
	try {
		rows = db.prepare("PRAGMA integrity_check").all();
	} catch {
		throw corrupt("unreadable");
	}
	const first = rows[0];
	const value =
		typeof first === "object" && first !== null && "integrity_check" in first
			? (first as { integrity_check: unknown }).integrity_check
			: undefined;
	if (rows.length !== 1 || value !== "ok") throw corrupt("integrity_check");
}

function readUserVersion(db: DatabaseSync): number {
	const row = db.prepare("PRAGMA user_version").get();
	const value =
		typeof row === "object" && row !== null && "user_version" in row
			? (row as { user_version: unknown }).user_version
			: undefined;
	if (typeof value !== "number") throw corrupt("user_version");
	return value;
}

function migrate(db: DatabaseSync): void {
	const version = readUserVersion(db);
	if (version === SCHEMA_VERSION) return;
	if (version > SCHEMA_VERSION) {
		throw new BrnError("STATE_VERSION_UNSUPPORTED", "newer_schema");
	}
	if (version !== 0) throw corrupt("unknown_schema_version");
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(MIGRATION);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

class SqliteOperationStore implements ServiceStore {
	private readonly db: DatabaseSync;
	/** Set by the first failed write; every later mutation is refused. */
	private unavailable = false;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	find(id: string): Operation | null {
		const row = this.db
			.prepare(`SELECT ${SELECT_COLUMNS} FROM operations WHERE id = ?`)
			.get(id);
		return row === undefined ? null : decodeOperation(row);
	}

	latest(): Operation | null {
		const row = this.db
			.prepare(
				`SELECT ${SELECT_COLUMNS} FROM operations
				 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
			)
			.get();
		return row === undefined ? null : decodeOperation(row);
	}

	insert(command: PromptCommand, requestHash: string): Operation {
		const now = new Date().toISOString();
		this.write(() => {
			try {
				this.db
					.prepare(
						`INSERT INTO operations
						   (id, session_id, request_hash, state, result_json, failure_code,
						    created_at, updated_at)
						 VALUES (?, ?, ?, 'accepted', NULL, NULL, ?, ?)`,
					)
					.run(command.requestId, command.sessionId, requestHash, now, now);
			} catch (error) {
				if (!isConstraintViolation(error)) throw error;
				// Either the single-unfinished-operation index or the primary key refused
				// the row. Both are conflicts the caller can act on, and neither means
				// the database has stopped working.
				throw this.unfinished() === null
					? new BrnError("REQUEST_ID_REUSED", "duplicate_id")
					: new BrnError("BUSY", "unfinished_operation");
			}
		});
		return this.require(command.requestId);
	}

	transition(
		id: string,
		from: OperationState[],
		to: OperationState,
	): Operation {
		const placeholders = from.map(() => "?").join(", ");
		const changed = this.write(() =>
			changedRows(
				this.db
					.prepare(
						`UPDATE operations SET state = ?, updated_at = ?
						 WHERE id = ? AND state IN (${placeholders === "" ? "NULL" : placeholders})`,
					)
					.run(to, new Date().toISOString(), id, ...from),
			),
		);
		if (changed !== 1) throw new BrnError("OPERATION_CONFLICT", "state");
		return this.require(id);
	}

	finish(id: string, result: RunResult, failureCode?: string): Operation {
		const state: OperationState =
			result.kind === "completed"
				? "succeeded"
				: result.kind === "cancelled"
					? "cancelled"
					: "failed";
		const changed = this.write(() =>
			changedRows(
				this.db
					.prepare(
						`UPDATE operations
						 SET state = ?, result_json = ?, failure_code = ?, updated_at = ?
						 WHERE id = ? AND state IN (${UNFINISHED_STATES})`,
					)
					.run(
						state,
						JSON.stringify(result),
						failureCode ?? null,
						new Date().toISOString(),
						id,
					),
			),
		);
		if (changed !== 1) throw new BrnError("OPERATION_CONFLICT", "finish");
		return this.require(id);
	}

	interruptUnfinished(): number {
		return this.write(() => {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				const changed = changedRows(
					this.db
						.prepare(
							`UPDATE operations
							 SET state = 'interrupted', failure_code = ?, updated_at = ?
							 WHERE state IN (${UNFINISHED_STATES})`,
						)
						.run(INTERRUPTED_FAILURE_CODE, new Date().toISOString()),
				);
				this.db.exec("COMMIT");
				return changed;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		});
	}

	close(): void {
		this.db.close();
	}

	rememberSession(id: string, model: ModelId, materialized: boolean): void {
		this.write(() => {
			this.db
				.prepare(
					`INSERT INTO sessions (id, model_json, materialized, created_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
					   model_json = excluded.model_json,
					   materialized = excluded.materialized`,
				)
				.run(
					id,
					JSON.stringify(model),
					materialized ? 1 : 0,
					new Date().toISOString(),
				);
		});
	}

	sessionMetadata(id: string): SessionMetadata | null {
		const row = this.db
			.prepare("SELECT model_json, materialized FROM sessions WHERE id = ?")
			.get(id);
		if (row === undefined) return null;
		if (!Check(SessionRowSchema, row)) throw corrupt("session_row");
		return {
			model: decodeModel(row.model_json),
			materialized: row.materialized === 1,
		};
	}

	setActiveSession(id: string | null): void {
		if (id === null) {
			this.write(() => {
				this.db
					.prepare("DELETE FROM settings WHERE key = ?")
					.run(ACTIVE_SESSION_KEY);
			});
			return;
		}
		this.putSetting(ACTIVE_SESSION_KEY, id);
	}

	getActiveSession(): string | null {
		const stored = this.getSetting(ACTIVE_SESSION_KEY);
		return stored === null ? null : decodeSessionId(stored);
	}

	setDefaultModel(model: ModelId): void {
		this.putSetting(DEFAULT_MODEL_KEY, model);
	}

	getDefaultModel(): ModelId | null {
		const stored = this.getSetting(DEFAULT_MODEL_KEY);
		return stored === null ? null : decodeModel(stored);
	}

	private putSetting(key: string, value: unknown): void {
		this.write(() => {
			this.db
				.prepare(
					`INSERT INTO settings (key, value_json) VALUES (?, ?)
					 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
				)
				.run(key, JSON.stringify(value));
		});
	}

	private getSetting(key: string): string | null {
		const row = this.db
			.prepare("SELECT value_json FROM settings WHERE key = ?")
			.get(key);
		if (row === undefined) return null;
		if (!Check(SettingRowSchema, row)) throw corrupt("setting_row");
		return row.value_json;
	}

	private unfinished(): Operation | null {
		const row = this.db
			.prepare(
				`SELECT ${SELECT_COLUMNS} FROM operations
				 WHERE state IN (${UNFINISHED_STATES}) LIMIT 1`,
			)
			.get();
		return row === undefined ? null : decodeOperation(row);
	}

	private require(id: string): Operation {
		const found = this.find(id);
		if (found === null) throw corrupt("missing_row");
		return found;
	}

	/**
	 * Runs one mutation. A classified conflict is reported as such, but any other
	 * write failure stops the ledger accepting mutations: a lost write must stay
	 * visible as `STATE_UNAVAILABLE` rather than let the service carry on as if the
	 * row had been saved. Reads keep working so the service can still report what
	 * it committed, and the original failure is preserved as the error's cause.
	 */
	private write<T>(mutation: () => T): T {
		if (this.unavailable) {
			throw new BrnError("STATE_UNAVAILABLE", "write_failed");
		}
		try {
			return mutation();
		} catch (error) {
			if (isBrnError(error)) throw error;
			this.unavailable = true;
			const failure = new BrnError("STATE_UNAVAILABLE", "write_failed");
			failure.cause = error;
			throw failure;
		}
	}
}

/**
 * Opens the authoritative operation ledger.
 *
 * The order matters: the file is proven intact before the first write, and the
 * schema is created in one transaction. Callers must already hold the process's
 * single-writer lock.
 */
export function openOperationStore(path: string): ServiceStore {
	const db = openDatabase(path);
	try {
		requireIntact(db);
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("PRAGMA synchronous=FULL");
		db.exec("PRAGMA foreign_keys=ON");
		migrate(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return new SqliteOperationStore(db);
}
