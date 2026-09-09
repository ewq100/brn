/**
 * The main-screen conversation client.
 *
 * It renders into the terminal's ordinary scrollback with Pi's public TUI
 * primitives and speaks to the service only over authenticated HTTP and SSE. It
 * starts no service, stops no service, and holds no lock: detaching leaves every
 * accepted operation running.
 *
 * This is the only BRN module that imports a Pi package, and it imports only the
 * terminal primitives. No coding-agent, session or runtime type reaches the
 * protocol or the rest of the client.
 */

import { randomUUID } from "node:crypto";
import {
	Editor,
	type EditorTheme,
	matchesKey,
	ProcessTerminal,
	type Terminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { ModelId, Operation } from "../core/conversation.ts";
import { isBrnError } from "../core/errors.ts";
import type { Snapshot } from "../protocol/contracts.ts";
import type { Client } from "./client.ts";
import {
	type CommandIo,
	describeFailure,
	describeOutcome,
	failureStatus,
	formatResult,
	formatStatus,
	INTERACTIVE_COMMANDS,
	runCommand,
	safeTerminalText,
} from "./commands.ts";
import { openEventStream } from "./sse.ts";

// Sanitizing is a property of everything BRN prints, not of the TUI alone, so it
// lives with the shared command layer and is re-exported here for the callers who
// think of it as a terminal concern.
export { safeTerminalText } from "./commands.ts";

/**
 * How much transcript the client keeps in its own buffer.
 *
 * The main screen renders the whole component tree, so the retained transcript is
 * bounded rather than unlimited. What has already scrolled past stays in the
 * terminal's own scrollback; only this client's redraw buffer is capped.
 */
const MAX_TRANSCRIPT_LINES = 2_000;

/** The states in which an operation is still occupying the service. */
const UNFINISHED = new Set(["accepted", "running", "cancelling"]);

export interface TerminalOptions {
	/**
	 * The terminal device to render on. Production uses Pi's `ProcessTerminal`;
	 * tests supply an in-memory implementation of the same public interface so the
	 * client under test is the real one.
	 */
	readonly terminal?: Terminal;
}

/**
 * One paid submission, recorded before the request leaves.
 *
 * It exists so an unanswered submission can be resolved by querying the exact
 * request identifier that was used, rather than by allocating a new one — a new
 * identifier is a new paid operation.
 */
interface SubmissionRecord {
	readonly requestId: string;
	readonly sessionId: string;
	readonly model: ModelId;
	readonly text: string;
}

/**
 * A submission whose outcome the client does not know.
 *
 * `query` means the recorded identifier has not been looked up yet; `retry` means
 * the lookup proved the service never admitted it, so repeating the identical
 * request under the identical identifier is safe.
 */
interface Recovery {
	readonly record: SubmissionRecord;
	readonly stage: "query" | "retry";
}

/** A failed request whose outcome is genuinely unknown, as opposed to refused. */
function isUncertain(error: unknown): boolean {
	if (!isBrnError(error)) return true;
	if (error.code === "SERVICE_UNREACHABLE") return true;
	// A body that could not be read or parsed leaves the outcome unknown too.
	if (error.code === "INVALID_RESPONSE") return true;
	return failureStatus(error) === 500;
}

/**
 * Attaches an interactive client and returns when it detaches.
 *
 * Detaching is the only thing this function ever does to the service's work: it
 * closes its own stream and connections. The operation the user was watching goes
 * on running.
 */
export async function runTerminal(
	client: Client,
	options: TerminalOptions = {},
): Promise<void> {
	const theme: EditorTheme = {
		borderColor: (text) => text,
		selectList: {
			selectedPrefix: (text) => text,
			selectedText: (text) => text,
			description: (text) => text,
			scrollInfo: (text) => text,
			noMatch: (text) => text,
		},
	};
	const tui = new TuiMainScreen(options.terminal ?? new ProcessTerminal());
	const transcript = new Text("");
	const status = new Text("Connecting to BRN");
	const response = new Text("");
	const editor = new Editor(tui, theme);
	// The transcript and each settled answer sit at the top, the active response
	// area below them, then the status, and the editor at the bottom. No
	// autocomplete provider and no extension is installed, so nothing offers
	// filesystem completions.
	tui.addChild(transcript);
	tui.addChild(response);
	tui.addChild(status);
	tui.addChild(editor);
	tui.setFocus(editor);

	const lines: string[] = [];
	let snapshot: Snapshot | null = null;
	let connection: "connected" | "disconnected" = "disconnected";
	/** Operations whose settled outcome has already been shown once. */
	const shown = new Set<string>();
	/** The session the text now in the editor was composed against. */
	let composedSessionId: string | null = null;
	let recovery: Recovery | null = null;
	let cancelling: string | null = null;
	let stopped = false;
	let resolveFinished: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});

	/** Adds one block to the transcript, bounding what this client redraws. */
	function append(text: string): void {
		lines.push(...text.split("\n"));
		if (lines.length > MAX_TRANSCRIPT_LINES) {
			lines.splice(0, lines.length - MAX_TRANSCRIPT_LINES + 1);
			lines.unshift("[earlier output left this client's redraw buffer]");
		}
		transcript.setText(lines.join("\n"));
		tui.requestRender();
	}

	const io: CommandIo = {
		write(text: string) {
			append(text);
		},
	};

	function sessionId(): string | null {
		return snapshot?.conversation.session?.id ?? null;
	}

	/** The operation currently displayed as occupying the service, if any. */
	function activeOperation(): Operation | null {
		const operation = snapshot?.work.operation ?? null;
		if (operation === null) return null;
		return UNFINISHED.has(operation.state) ? operation : null;
	}

	function refresh(): void {
		const parts: string[] = [
			connection === "connected"
				? "Stream: connected"
				: "Stream: disconnected, reconnecting",
		];
		parts.push(
			snapshot === null
				? "Waiting for the first snapshot"
				: formatStatus(snapshot),
		);
		if (cancelling !== null) {
			parts.push(
				`Cancellation requested for ${safeTerminalText(cancelling)}; awaiting settlement.`,
			);
		}
		if (recovery !== null) {
			parts.push(
				recovery.stage === "query"
					? `A submission's outcome is unknown. Request ${recovery.record.requestId} is retained; press Enter to look it up before any new submission.`
					: `Request ${recovery.record.requestId} was never accepted. Press Enter to send the identical text under that same request ID.`,
			);
		}
		status.setText(parts.join("\n"));
		tui.requestRender();
	}

	/** Puts the text Pi's editor cleared on submission back where the user left it. */
	function restore(text: string): void {
		editor.setText(text);
		tui.requestRender();
	}

	function detach(reason: string): void {
		if (stopped) return;
		stopped = true;
		append(reason);
		resolveFinished();
	}

	/** Shows a settled operation's outcome exactly once. */
	async function present(operation: Operation): Promise<void> {
		// Recorded before the first await, so a burst of snapshots cannot show the
		// same answer twice or read its durable text twice.
		shown.add(operation.id);
		if (cancelling === operation.id) cancelling = null;
		response.setText("");
		append(
			`--- ${safeTerminalText(operation.id)} ---\n${describeOutcome(operation)}`,
		);
		if (operation.state !== "succeeded" && operation.state !== "cancelled") {
			refresh();
			return;
		}
		try {
			append(formatResult(await client.result(operation.id)));
		} catch (error) {
			append(describeFailure(error, client.stateDir));
		}
		refresh();
	}

	function onSnapshot(next: Snapshot): void {
		snapshot = next;
		// The whole accumulated preview is sanitized, so an escape sequence split
		// across stream frames cannot survive being rejoined.
		response.setText(safeTerminalText(next.work.liveText));
		const operation = next.work.operation;
		if (
			operation !== null &&
			!UNFINISHED.has(operation.state) &&
			!shown.has(operation.id)
		) {
			void present(operation);
		}
		refresh();
	}

	async function submit(record: SubmissionRecord): Promise<void> {
		const accepted = await client.submit(record);
		editor.addToHistory(record.text);
		composedSessionId = null;
		append(
			`Submitted ${safeTerminalText(accepted.id)} to ${safeTerminalText(record.sessionId)}.`,
		);
	}

	/** Composes and sends one prompt, keeping the typed text unless it is accepted. */
	async function submitTyped(text: string): Promise<void> {
		const current = snapshot;
		if (current === null) {
			restore(text);
			append("No snapshot has arrived yet, so there is no session to prompt.");
			return;
		}
		const session = current.conversation.session;
		if (session === null) {
			restore(text);
			append(
				"No active session. Create one with: /new PROVIDER/MODEL — the client never creates one implicitly.",
			);
			return;
		}
		if (session.model === null) {
			restore(text);
			append("No model is selected. Select one with: /model PROVIDER/MODEL");
			return;
		}
		if (composedSessionId !== null && composedSessionId !== session.id) {
			// The conversation moved while this text was being written. It is not
			// reinterpreted as input to the new session; the user decides.
			const previous = composedSessionId;
			composedSessionId = session.id;
			restore(text);
			append(
				`The active session changed from ${safeTerminalText(previous)} to ${safeTerminalText(session.id)} while this text was being composed, so it was not submitted. The text is unchanged: press Enter again to send it to the new session, or edit it first.`,
			);
			return;
		}
		const record: SubmissionRecord = {
			requestId: randomUUID(),
			sessionId: session.id,
			model: { ...session.model },
			text,
		};
		try {
			await submit(record);
		} catch (error) {
			restore(text);
			if (isUncertain(error)) {
				recovery = { record, stage: "query" };
				append(
					`The submission's outcome is unknown. Request ${record.requestId} is retained with its exact text and will be looked up before anything new is sent.`,
				);
			} else {
				append(describeFailure(error, client.stateDir));
			}
		}
	}

	/**
	 * Resolves an unanswered submission.
	 *
	 * The recorded request identifier is queried first; only a proven absence
	 * allows the identical request to be repeated under that same identifier.
	 */
	async function resolveRecovery(
		typed: string,
		current: Recovery,
	): Promise<void> {
		if (current.stage === "retry") {
			try {
				// The identical text under the identical identifier: proven safe by the
				// lookup that found nothing.
				await submit(current.record);
				recovery = null;
			} catch (error) {
				restore(typed);
				append(describeFailure(error, client.stateDir));
			}
			return;
		}
		// A lookup consumes nothing, so the typed text goes back where it was.
		restore(typed);
		try {
			const existing = await client.operation(current.record.requestId);
			recovery = null;
			append(
				`Request ${current.record.requestId} was accepted after all: ${existing.state}. It is not sent again.`,
			);
		} catch (error) {
			if (isBrnError(error) && failureStatus(error) === 404) {
				recovery = { record: current.record, stage: "retry" };
				append(
					`Request ${current.record.requestId} was never accepted by the service. Press Enter to send the identical text under that same request ID; a new request ID would be a new paid operation.`,
				);
			} else {
				append(describeFailure(error, client.stateDir));
			}
		}
	}

	/** Maps one slash command onto the standalone command of the same name. */
	function toCommandArgs(words: readonly string[]): readonly string[] | null {
		const [name, ...rest] = words;
		switch (name) {
			case "status":
			case "models":
			case "sessions":
				return rest.length === 0 ? [name] : null;
			case "new":
				return rest.length === 1 && rest[0] !== undefined
					? ["new", "--model", rest[0]]
					: null;
			case "resume":
			case "operation":
				return rest.length === 1 && rest[0] !== undefined
					? [name, rest[0]]
					: null;
			case "model":
				return rest.length === 1 && rest[0] !== undefined
					? ["model", rest[0]]
					: null;
			default:
				return null;
		}
	}

	async function runSlashCommand(raw: string): Promise<void> {
		// Split on whitespace with explicit argument counts. Nothing here builds a
		// shell command line, and no argument is ever interpreted.
		const words = raw
			.slice(1)
			.split(/\s+/)
			.filter((word) => word.length > 0);
		if (words[0] === "quit") {
			const active = activeOperation();
			detach(
				active === null
					? "Detaching. The service and its state keep running."
					: `Detaching while ${safeTerminalText(active.id)} is still running. It continues on the service; read it later with: npm run brn -- --state-dir ${safeTerminalText(client.stateDir)} operation ${safeTerminalText(active.id)}`,
			);
			return;
		}
		const args = toCommandArgs(words);
		if (args === null) {
			// The rejected text is echoed rather than left in the editor: stale text
			// there would silently become part of the next prompt.
			append(
				`Unsupported command: ${safeTerminalText(raw)}\nSupported: ${INTERACTIVE_COMMANDS.join(", ")}`,
			);
			composedSessionId = null;
			return;
		}
		try {
			// The same implementation the standalone command runs.
			await runCommand(args, client, io);
			composedSessionId = null;
		} catch (error) {
			append(describeFailure(error, client.stateDir));
		}
	}

	async function handleSubmit(text: string): Promise<void> {
		if (text.length === 0) {
			append("Nothing to submit.");
			return;
		}
		if (text.startsWith("/")) {
			await runSlashCommand(text);
			refresh();
			return;
		}
		const current = recovery;
		if (current !== null) await resolveRecovery(text, current);
		else await submitTyped(text);
		refresh();
	}

	async function requestCancellation(id: string): Promise<void> {
		try {
			// The exact operation shown on screen, through its confirmed endpoint. No
			// signal is ever sent to the service process.
			await runCommand(["cancel", id, "--confirm"], client, io);
		} catch (error) {
			append(describeFailure(error, client.stateDir));
		} finally {
			if (cancelling === id) cancelling = null;
			refresh();
		}
	}

	const removeInputListener = tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			const active = activeOperation();
			if (active === null) {
				// Idle: this stops the client, and only the client.
				detach("Detaching on Ctrl+C. The service keeps running.");
				return { consume: true };
			}
			if (cancelling === null) {
				cancelling = active.id;
				append(`Cancellation requested for ${safeTerminalText(active.id)}.`);
				refresh();
				void requestCancellation(active.id);
			}
			return { consume: true };
		}
		// A keystroke that starts a fresh composition records which session the text
		// belongs to, before the editor has consumed it.
		if (editor.getText().length === 0) composedSessionId = sessionId();
		return undefined;
	});

	editor.onSubmit = (text: string) => {
		// A submission cannot be started after detaching; the TUI is stopped by then,
		// but the guard makes that explicit rather than incidental.
		if (stopped) return;
		void handleSubmit(text).catch((error: unknown) => {
			append(describeFailure(error, client.stateDir));
		});
	};

	const stream = openEventStream(client, onSnapshot, {
		onStatus: (next) => {
			connection = next;
			refresh();
		},
	});

	try {
		tui.start();
		refresh();
		await finished;
	} finally {
		// Everything this client opened is released here, in the order that keeps a
		// late snapshot from reaching a stopped renderer.
		removeInputListener();
		await stream.close();
		tui.renderNow();
		tui.stop();
	}
}
