/**
 * The one implementation of every BRN command.
 *
 * Standalone invocations and the interactive client's slash commands both run
 * these functions, so a command cannot behave differently depending on how it was
 * typed. Nothing here knows about a TUI: output goes through {@link CommandIo},
 * which the one-shot entry point points at stdout and the interactive client
 * points at its own transcript.
 *
 * Every string that came from the service passes through
 * {@link safeTerminalText} before it is written, because both destinations are a
 * terminal.
 */

import { parseArgs } from "node:util";
import type {
	ContextUsage,
	ModelId,
	Operation,
	OperationView,
	Usage,
} from "../core/conversation.ts";
import { BrnError, isBrnError } from "../core/errors.ts";
import {
	MAX_PROMPT_BYTES,
	ModelsResponseSchema,
	OperationSchema,
	type ResultResponse,
	SessionInfoSchema,
	SessionsResponseSchema,
	type Snapshot,
	SnapshotSchema,
} from "../protocol/contracts.ts";
import { CANCEL_TIMEOUT_MS, type Client, HealthResponse } from "./client.ts";

/** The commands a standalone invocation accepts, in the order help lists them. */
export const SUPPORTED_COMMANDS = [
	"status",
	"models",
	"sessions",
	"new --model PROVIDER/MODEL",
	"resume SESSION_ID",
	"model PROVIDER/MODEL",
	"chat",
	"prompt --request-id UUID --text TEXT",
	"operation OPERATION_ID",
	"cancel OPERATION_ID --confirm",
] as const;

/** The same commands as the interactive client accepts them. */
export const INTERACTIVE_COMMANDS = [
	"/status",
	"/models",
	"/sessions",
	"/new PROVIDER/MODEL",
	"/resume SESSION_ID",
	"/model PROVIDER/MODEL",
	"/operation OPERATION_ID",
	"/quit",
] as const;

/** Where a command's output goes, and how it reaches the interactive client. */
export interface CommandIo {
	write(text: string): void;
	/**
	 * Attaches the interactive client. Absent when a command runs *inside* that
	 * client, which is why `chat` has no interactive equivalent.
	 */
	chat?: () => Promise<void>;
}

const STDOUT_IO: CommandIo = {
	write(text: string) {
		process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	},
};

/**
 * Makes server-controlled text safe to hand to a terminal.
 *
 * Newline and tab are the only controls a message legitimately carries; every
 * other C0 or C1 control becomes a visible escape, so a model, a provider or a
 * session identifier cannot address the terminal itself — no OSC clipboard write,
 * no cursor movement, no screen clear, no hyperlink. It works on a whole string
 * rather than a chunk, so an escape split across two stream frames is filtered
 * once the frames have been joined.
 */
export function safeTerminalText(text: string): string {
	return text.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the subject here, not an accident — this is the filter that keeps them out of a terminal.
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * Splits `PROVIDER/MODEL` at the first slash only.
 *
 * A model identifier may itself contain slashes, so everything after the first
 * one belongs to the identifier.
 */
export function parseModelId(value: string): ModelId {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new BrnError("INVALID_REQUEST", "model");
	}
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function formatModelId(model: ModelId | null): string {
	if (model === null) return "none";
	return safeTerminalText(`${model.provider}/${model.id}`);
}

/** Reports context honestly: an unknown figure is never rendered as a tidy zero. */
export function formatContext(context: ContextUsage): string {
	if (context === null) return "Context: unknown";
	const tokens = context.tokens === null ? "unknown" : String(context.tokens);
	const percent =
		context.percent === null ? "unknown" : `${context.percent.toFixed(1)}%`;
	return `Context: ${tokens} of ${context.contextWindow} tokens (${percent})`;
}

export function formatUsage(usage: Usage): string {
	return `Usage: input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} total=${usage.totalTokens}`;
}

/**
 * Describes one operation's outcome.
 *
 * Both recorded reasons are read. `failureCode` carries the precise reason BRN
 * recorded — `DEADLINE_EXCEEDED`, `OUTPUT_LIMIT` and the rest — while the run
 * result carries the coarse class, which is where `NO_MODEL` and `AUTH_REQUIRED`
 * arrive. `interrupted`, `failed` and `cancelled` are three different things and
 * are named as three different things.
 *
 * This is the only place that reads an outcome, so the standalone commands and the
 * interactive client cannot describe the same record differently.
 */
export function describeOutcome(operation: Operation): string {
	const result = operation.result;
	switch (operation.state) {
		case "accepted":
			return "accepted; not started yet";
		case "running":
			return "running";
		case "cancelling":
			return "cancellation requested; awaiting settlement";
		case "interrupted":
			return "interrupted by a service restart; it was not replayed and no provider request was repeated";
		case "cancelled":
			return "cancelled; any recorded answer is partial";
		case "failed": {
			const code =
				operation.failureCode ??
				(result !== null && result.kind === "failed" ? result.code : null);
			return `failed (${safeTerminalText(code ?? "reason unrecorded")})`;
		}
		case "succeeded":
			if (result !== null && result.kind === "completed" && result.truncated) {
				return "completed but truncated at the output limit; this is not a complete answer";
			}
			return "completed";
	}
}

export function formatOperationRecord(operation: Operation): string {
	return [
		`Operation: ${safeTerminalText(operation.id)}`,
		`State: ${operation.state} — ${describeOutcome(operation)}`,
		`Session: ${safeTerminalText(operation.sessionId)}`,
	].join("\n");
}

/**
 * The engine's own status, in BRN's words.
 *
 * `compacting` is deliberately not phrased like `working`: during compaction the
 * engine is rewriting conversation history and no answer is being produced, and
 * someone watching a silent screen deserves to know which of the two it is. The
 * vocabulary is closed by the wire contract, so this maps fixed names rather than
 * printing a server-controlled string.
 */
function formatEngineStatus(
	status: OperationView["engineStatus"],
): string | null {
	switch (status) {
		case null:
			return null;
		case "working":
			return "Engine: working (producing an answer)";
		case "compacting":
			return "Engine: compacting the conversation history — no answer is being produced right now";
		case "cancelling":
			return "Engine: cancelling";
	}
}

/** The current work, as the status display and the interactive client show it. */
export function formatWork(view: OperationView): string {
	const lines: string[] = [];
	const operation = view.operation;
	if (operation === null) lines.push("Work: none");
	else {
		lines.push(
			`Work: ${operation.state} ${safeTerminalText(operation.id)} — ${describeOutcome(operation)}`,
		);
	}
	const engine = formatEngineStatus(view.engineStatus);
	if (engine !== null) lines.push(engine);
	if (!view.accepting) {
		lines.push("The service is shutting down and accepts no new work.");
	}
	if (view.controlling) {
		lines.push("A session or model change holds the control seat.");
	}
	return lines.join("\n");
}

/** One complete readable view of a snapshot, shared by `status` and the client. */
export function formatStatus(snapshot: Snapshot): string {
	const session = snapshot.conversation.session;
	const lines = [
		`Instance: ${safeTerminalText(snapshot.instanceId)} (sequence ${snapshot.sequence})`,
		session === null
			? 'Session: none (create one with "new --model PROVIDER/MODEL" or "/new PROVIDER/MODEL")'
			: `Session: ${safeTerminalText(session.id)}  Model: ${formatModelId(session.model)}`,
		formatWork(snapshot.work),
		formatContext(snapshot.conversation.context),
		formatUsage(snapshot.conversation.usage),
		// No tool is registered in Capability A, and none is invented to fill a widget.
		"Tools: none (Capability A)",
	];
	return lines.join("\n");
}

/** Renders a durable answer, keeping a truncated one distinguishable. */
export function formatResult(result: ResultResponse): string {
	const text = safeTerminalText(result.text);
	if (!result.truncated) return text;
	return `${text}\n[the answer above is partial: it was truncated or cancelled before it finished]`;
}

/**
 * The HTTP status a refused request carried.
 *
 * The client records a refusal as the status followed by the service's own fixed
 * code, when the body named one. Reading them back is done here so no caller
 * pulls that string apart itself.
 */
export function failureStatus(error: unknown): number | null {
	if (!isBrnError(error) || error.code !== "REQUEST_FAILED") return null;
	const status = Number.parseInt(error.detail ?? "", 10);
	return Number.isNaN(status) ? null : status;
}

/** The service's own fixed failure code for a refused request, when it named one. */
export function failureCode(error: unknown): string | null {
	if (!isBrnError(error) || error.code !== "REQUEST_FAILED") return null;
	const [, code] = (error.detail ?? "").split(" ");
	return code === undefined || code.length === 0 ? null : code;
}

/**
 * The concrete next step for a failure, or nothing when there is no useful one.
 *
 * Every branch names something the operator can actually do. Nothing here retries
 * or falls back on its own.
 */
export function correctiveAdvice(
	error: unknown,
	stateDir: string,
): string | null {
	if (!isBrnError(error)) return null;
	const dir = safeTerminalText(stateDir);
	const brn = `npm run brn -- --state-dir ${dir}`;
	switch (error.code) {
		case "INVALID_STATE_DIR":
			return "--state-dir must be an explicitly chosen absolute path with no symlinked component. For example: npm run brn -- --state-dir /absolute/path status";
		case "NO_SERVICE":
			return `No service is running in ${dir}. Start one, in its own terminal, with: npm run service -- --state-dir ${dir}`;
		case "INSECURE_DISCOVERY":
		case "INVALID_DISCOVERY":
			return `The discovery document in ${dir} failed its safety check. Stop any service using that directory and inspect ${dir}/discovery.json; BRN never repairs it.`;
		case "SERVICE_UNREACHABLE":
			return `The service published for ${dir} did not answer. Check the process you started with: npm run service -- --state-dir ${dir}`;
		case "INVALID_RESPONSE":
			return `The service answered something this client cannot read. Check that the service and client are the same build, then run: ${brn} status`;
		case "UNSUPPORTED_COMMAND":
			return `Supported commands: ${SUPPORTED_COMMANDS.join(", ")}`;
		case "NOT_A_TERMINAL":
			return `"chat" composes prompts in a terminal and cannot read from a pipe or a redirect. Run it from an interactive terminal, or submit one prompt without a terminal with: ${brn} prompt --request-id UUID --text TEXT`;
		case "NO_ACTIVE_SESSION":
			return `No conversation is hosted. Create one with: ${brn} new --model PROVIDER/MODEL`;
		case "NO_MODEL":
			return `No model is selected for this conversation. Select one with: ${brn} model PROVIDER/MODEL`;
		case "INVALID_REQUEST":
			return `Check the command arguments. Supported commands: ${SUPPORTED_COMMANDS.join(", ")}`;
		case "REQUEST_FAILED":
			return refusalAdvice(error, dir, brn);
		default:
			return null;
	}
}

/** The advice for a refusal, narrowed by the code the service named where it did. */
function refusalAdvice(error: unknown, dir: string, brn: string): string {
	const named = failureCode(error);
	switch (named) {
		case "BUSY":
			return `The service already has one accepted operation or one session or model change in flight; BRN never queues work. Wait for it, or cancel it with: ${brn} cancel OPERATION_ID --confirm`;
		case "SESSION_MISMATCH":
			return `The conversation moved on: this request names a session the service is no longer hosting. See the current one with: ${brn} status`;
		case "MODEL_MISMATCH":
			return `The submitted model is not the one seated for this conversation. See the current one with: ${brn} status`;
		case "REQUEST_ID_REUSED":
			return "That request ID already identifies a different submission. A new request ID is a new paid operation; choose one deliberately.";
		case "MODEL_UNAVAILABLE":
			return `No authenticated provider offers that model. List what is available with: ${brn} models`;
		case "NO_ACTIVE_SESSION":
			return `No conversation is hosted. Create one with: ${brn} new --model PROVIDER/MODEL`;
		case "NO_MODEL":
			return `No model is selected for this conversation. Select one with: ${brn} model PROVIDER/MODEL`;
		case "AUTH_REQUIRED":
			return "The provider has no usable credentials. Authenticate that provider with Pi, then submit again.";
		case "EMPTY_PROMPT":
			return "A prompt must contain something other than whitespace.";
		case "UNKNOWN_OPERATION":
			return `No record with that identifier exists. See what does with: ${brn} status`;
		default:
			break;
	}
	switch (failureStatus(error)) {
		case 400:
			return `The service refused the request as malformed. Supported commands: ${SUPPORTED_COMMANDS.join(", ")}`;
		case 404:
			return `No record with that identifier exists. See what does with: ${brn} status`;
		case 409:
			return `The service refused this as busy, stale, a mismatched session or model, or a reused request ID with different content. See the current state with: ${brn} status`;
		case 413:
			return `The prompt is larger than the ${MAX_PROMPT_BYTES}-byte limit. Shorten it and submit it again.`;
		case 503:
			return `The service reports its state as unavailable or corrupt. Stop it and inspect ${dir}; BRN never deletes or rebuilds authoritative state.`;
		default:
			return `The service answered an unexpected status. See the current state with: ${brn} status`;
	}
}

/** A failure as a user sees it: the fixed code, then something to do about it. */
export function describeFailure(error: unknown, stateDir: string): string {
	const code = isBrnError(error) ? error.code : "INTERNAL_ERROR";
	// `code` is one of BRN's own fixed names, but `detail` is not always: a refused
	// request carries the status and the code the *service's* body named, and a
	// schema that bounds a string's length does not bound its character set. This is
	// a sink, so it is filtered here like every other sink.
	const detail =
		isBrnError(error) && error.detail !== undefined
			? ` (${safeTerminalText(error.detail)})`
			: "";
	const advice = correctiveAdvice(error, stateDir);
	return advice === null
		? `brn: ${code}${detail}`
		: `brn: ${code}${detail}\n${advice}`;
}

/** A parsed invocation: a command name, its positionals and its named values. */
interface Invocation {
	readonly command: string;
	readonly positionals: readonly string[];
	readonly model: string | undefined;
	readonly requestId: string | undefined;
	readonly text: string | undefined;
	readonly confirm: boolean;
}

function parseInvocation(args: readonly string[]): Invocation {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: [...args],
			allowPositionals: true,
			strict: true,
			options: {
				model: { type: "string" },
				"request-id": { type: "string" },
				text: { type: "string" },
				confirm: { type: "boolean" },
			},
		});
	} catch {
		// The reason is deliberately not echoed: the supported list is more useful
		// than a parser message, and it cannot contain caller data.
		throw new BrnError("UNSUPPORTED_COMMAND", "arguments");
	}
	const [command, ...positionals] = parsed.positionals;
	if (command === undefined) throw new BrnError("UNSUPPORTED_COMMAND", "empty");
	const values = parsed.values;
	return {
		command,
		positionals,
		model: typeof values.model === "string" ? values.model : undefined,
		requestId:
			typeof values["request-id"] === "string"
				? values["request-id"]
				: undefined,
		text: typeof values.text === "string" ? values.text : undefined,
		confirm: values.confirm === true,
	};
}

/**
 * Every command has an exact argument count, checked before anything is sent.
 *
 * It is only reached once the switch has matched a command, so the detail is one of
 * this module's own fixed names and never arbitrary caller text.
 */
function only(invocation: Invocation, count: number): readonly string[] {
	if (invocation.positionals.length !== count) {
		throw new BrnError("INVALID_REQUEST", `${invocation.command}_arguments`);
	}
	return invocation.positionals;
}

function required(value: string | undefined, detail: string): string {
	if (value === undefined || value.length === 0) {
		throw new BrnError("INVALID_REQUEST", detail);
	}
	return value;
}

async function snapshot(client: Client): Promise<Snapshot> {
	return await client.request("GET", "/v1/snapshot", SnapshotSchema);
}

/** Runs exactly one command against an attached service. */
export async function runCommand(
	args: readonly string[],
	client: Client,
	io: CommandIo = STDOUT_IO,
): Promise<void> {
	const invocation = parseInvocation(args);
	switch (invocation.command) {
		case "status": {
			only(invocation, 0);
			const health = await client.request("GET", "/v1/health", HealthResponse);
			io.write(
				`Service: ${health.status} ready host=${safeTerminalText(client.host)} instance=${safeTerminalText(health.instanceId)} pid=${health.pid}`,
			);
			io.write(formatStatus(await snapshot(client)));
			return;
		}
		case "models": {
			only(invocation, 0);
			const { models } = await client.request(
				"GET",
				"/v1/models",
				ModelsResponseSchema,
			);
			io.write(
				models.length === 0
					? 'No authenticated model is available. Authenticate a provider with Pi, then run "models" again.'
					: models.map((model) => formatModelId(model)).join("\n"),
			);
			return;
		}
		case "sessions": {
			only(invocation, 0);
			const { sessions } = await client.request(
				"GET",
				"/v1/sessions",
				SessionsResponseSchema,
			);
			io.write(
				sessions.length === 0
					? 'No session exists yet. Create one with "new --model PROVIDER/MODEL".'
					: sessions
							.map(
								(session) =>
									`${safeTerminalText(session.id)}  ${formatModelId(session.model)}`,
							)
							.join("\n"),
			);
			return;
		}
		case "new": {
			only(invocation, 0);
			const model = parseModelId(required(invocation.model, "new_model"));
			const session = await client.request(
				"POST",
				"/v1/sessions",
				SessionInfoSchema,
				{ model },
				// A created session answers `201`.
				{ accept: [201] },
			);
			io.write(
				`Session: ${safeTerminalText(session.id)}  Model: ${formatModelId(session.model)}`,
			);
			return;
		}
		case "resume": {
			const [sessionId = ""] = only(invocation, 1);
			const session = await client.request(
				"POST",
				"/v1/sessions/resume",
				SessionInfoSchema,
				{ sessionId },
			);
			io.write(
				`Session: ${safeTerminalText(session.id)}  Model: ${formatModelId(session.model)}`,
			);
			return;
		}
		case "model": {
			const [value = ""] = only(invocation, 1);
			const model = parseModelId(value);
			const session = await client.request(
				"POST",
				"/v1/model",
				SessionInfoSchema,
				{ model },
			);
			io.write(
				`Session: ${safeTerminalText(session.id)}  Model: ${formatModelId(session.model)}`,
			);
			return;
		}
		case "chat": {
			only(invocation, 0);
			const chat = io.chat;
			// There is no `/chat`: inside the interactive client, ordinary text is
			// already the way to compose a prompt.
			if (chat === undefined) throw new BrnError("UNSUPPORTED_COMMAND", "chat");
			await chat();
			return;
		}
		case "prompt": {
			only(invocation, 0);
			const requestId = required(invocation.requestId, "prompt_request_id");
			const text = required(invocation.text, "prompt_text");
			const current = await snapshot(client);
			const session = current.conversation.session;
			// The failure carries its own corrective command, so nothing is printed
			// twice here.
			if (session === null) throw new BrnError("NO_ACTIVE_SESSION");
			if (session.model === null) throw new BrnError("NO_MODEL");
			const operation = await client.submit({
				requestId,
				sessionId: session.id,
				model: { ...session.model },
				text,
			});
			io.write(formatOperationRecord(operation));
			return;
		}
		case "operation": {
			const [id = ""] = only(invocation, 1);
			const operation = await client.operation(id);
			io.write(formatOperationRecord(operation));
			// A settled answer has durable text; an unsettled or failed one has none to
			// read, and asking for it would only produce a second failure.
			if (operation.state === "succeeded" || operation.state === "cancelled") {
				io.write(formatResult(await client.result(id)));
			}
			return;
		}
		case "cancel": {
			const [id = ""] = only(invocation, 1);
			if (!invocation.confirm) {
				throw new BrnError("INVALID_REQUEST", "cancel_confirm");
			}
			// This is the one route that answers only after the operation settles, so
			// it is the one route with a longer bound.
			const settled = await client.request(
				"POST",
				`/v1/operations/${encodeURIComponent(id)}/cancel`,
				OperationSchema,
				{ confirmed: true },
				{ timeoutMs: CANCEL_TIMEOUT_MS },
			);
			io.write(formatOperationRecord(settled));
			return;
		}
		default:
			throw new BrnError("UNSUPPORTED_COMMAND", "name");
	}
}
