/**
 * Operational logging.
 *
 * Records are single-line JSON on stderr so stdout stays free for command
 * output. Field values are restricted to scalars, and callers pass only fixed
 * identifiers and counters: prompts, model responses, bearer tokens and
 * discovery documents must never reach this module.
 */

export type LogValue = string | number | boolean;

export type LogFields = Readonly<Record<string, LogValue | undefined>>;

function emit(level: "info" | "error", event: string, fields: LogFields): void {
	const record: Record<string, LogValue> = {
		time: new Date().toISOString(),
		level,
		event,
	};
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) record[key] = value;
	}
	process.stderr.write(`${JSON.stringify(record)}\n`);
}

export function logInfo(event: string, fields: LogFields = {}): void {
	emit("info", event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
	emit("error", event, fields);
}
