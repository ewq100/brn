// Test-only composition entry for the BRN service.
//
// It runs the same startup path as `src/service/main.ts` in a child process so
// tests exercise real ownership locking, real sockets and the real filesystem.
// The single substitution it may make is the conversation engine: with
// `--fake-engine` it composes the deterministic engine and drives it over IPC.
// That switch exists only here. No production argument, environment variable or
// endpoint can reach it, and the fake is never imported by `src/`.
import { runService } from "../../src/service/main.ts";
import { FakeEngine } from "./fake-engine.ts";

const RUNNING_POLL_MS = 5;
const RUNNING_TIMEOUT_MS = 5_000;

const argv = process.argv.slice(2);
const FAKE_FLAG = "--fake-engine";

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
			engine.fail(text);
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
		};
		void apply(engine, command.action, command.text).then(
			(value) => {
				process.send?.({ type: "fake-reply", id: command.id, value });
			},
			() => {
				process.send?.({ type: "fake-reply", id: command.id, value: null });
			},
		);
	});
}

if (argv.includes(FAKE_FLAG)) {
	const engine = new FakeEngine();
	registerControls(engine);
	process.exitCode = await runService(argv, {
		engine: async () => ({ engine, close: async () => undefined }),
	});
} else {
	process.exitCode = await runService(argv);
}

// The control listener above keeps the IPC channel referenced, which would keep
// this child alive after the service has shut down.
process.disconnect?.();
