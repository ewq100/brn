// Test-only composition entry for the BRN service.
//
// It runs the same startup path as `src/service/main.ts` in a child process so
// tests exercise real ownership locking, real sockets and the real filesystem.
// The single substitution it may make is the conversation engine: with
// `--fake-engine` it composes the deterministic engine and drives it over IPC.
// That switch exists only here. No production argument, environment variable or
// endpoint can reach it, and the fake is never imported by `src/`.
import { runService } from "../../src/service/main.ts";
import { type FailedCode, FakeEngine } from "./fake-engine.ts";

const RUNNING_POLL_MS = 5;
const RUNNING_TIMEOUT_MS = 5_000;

const argv = process.argv.slice(2);
const FAKE_FLAG = "--fake-engine";
const BUFFER_FLAG = "--max-buffered-bytes";

/**
 * Reads the test-only stream ceiling from this entry's own arguments. It is
 * passed to `runService` as a composition argument, exactly like the fake
 * engine: production's entry point passes no composition, so no argument,
 * environment variable or request can reach it there.
 */
function bufferCeiling(): number | undefined {
	const flag = argv.indexOf(BUFFER_FLAG);
	const value = flag === -1 ? undefined : argv[flag + 1];
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

async function awaitRunning(engine: FakeEngine): Promise<boolean> {
	const deadline = Date.now() + RUNNING_TIMEOUT_MS;
	while (!engine.running) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, RUNNING_POLL_MS));
	}
	return true;
}

/** Answers one control message. Every action is a call the test could make in-process. */
async function apply(
	engine: FakeEngine,
	action: string,
	text: string | undefined,
	code: FailedCode | undefined,
): Promise<unknown> {
	switch (action) {
		case "callCount":
			return engine.calls.length;
		case "running":
			return engine.running;
		case "awaitRunning":
			return await awaitRunning(engine);
		case "complete":
			engine.complete(text ?? "");
			return true;
		case "fail":
			engine.fail(text, code);
			return true;
		case "emit":
			engine.emitText(text ?? "");
			return true;
		default:
			return null;
	}
}

function registerControls(engine: FakeEngine): void {
	process.on("message", (message) => {
		if (
			typeof message !== "object" ||
			message === null ||
			!("type" in message) ||
			(message as { type: unknown }).type !== "fake"
		) {
			return;
		}
		const command = message as unknown as {
			id: number;
			action: string;
			text?: string;
			code?: FailedCode;
		};
		void apply(engine, command.action, command.text, command.code).then(
			(value) => {
				process.send?.({ type: "fake-reply", id: command.id, value });
			},
			() => {
				process.send?.({ type: "fake-reply", id: command.id, value: null });
			},
		);
	});
}

const ceiling = bufferCeiling();
const composition = ceiling === undefined ? {} : { maxBufferedBytes: ceiling };

if (argv.includes(FAKE_FLAG)) {
	const engine = new FakeEngine();
	registerControls(engine);
	process.exitCode = await runService(argv, {
		...composition,
		engine: async () => ({ engine, close: async () => undefined }),
	});
} else {
	process.exitCode = await runService(argv, composition);
}

// The control listener above keeps the IPC channel referenced, which would keep
// this child alive after the service has shut down.
process.disconnect?.();
