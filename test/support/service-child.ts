// Test-only composition entry for the BRN service.
//
// It runs the same startup path as `src/service/main.ts` in a child process so
// tests exercise real ownership locking, real sockets and the real filesystem.
// The single substitution it may make is the conversation engine: with
// `--fake-engine` it composes the deterministic engine and drives it over IPC,
// and with `--pi-faux-provider` it composes the real Pi adapter over the SDK's
// own in-process faux provider. It may also arm one `--failpoint`, which pauses
// an operation at a named point so a real signal can arrive between two steps.
//
// All of that exists only here. No production argument, environment variable or
// endpoint can reach it, and neither the fake engine nor the faux provider is
// ever imported by `src/`.
import type {
	Api,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	ConversationEngine,
	EngineEvent,
	PromptCommand,
	RunResult,
} from "../../src/core/conversation.ts";
import { runService } from "../../src/service/main.ts";
import type { ServiceStore } from "../../src/service/operation-store.ts";
import { createPiConversation } from "../../src/service/pi/conversation.ts";
import { openPiRuntime } from "../../src/service/pi/runtime.ts";
import type { ComposedEngine } from "../../src/service/start.ts";
import { type FailedCode, FakeEngine } from "./fake-engine.ts";
import { offlineModels, SENTINEL } from "./pi.ts";
import type {
	ChildNotice,
	Failpoint,
	ProviderRequestSummary,
} from "./process.ts";

/** The statuses an engine may report about a run in flight. */
type EngineStatus = Extract<EngineEvent, { type: "status" }>["status"];

const RUNNING_POLL_MS = 5;
const RUNNING_TIMEOUT_MS = 5_000;

/** How many scripted faux responses are queued, so a replay would be recorded too. */
const SCRIPTED_RESPONSES = 8;

const argv = process.argv.slice(2);
const FAKE_FLAG = "--fake-engine";
const FAUX_FLAG = "--pi-faux-provider";
const BUFFER_FLAG = "--max-buffered-bytes";
const FAILPOINT_FLAG = "--failpoint";
const ANSWER_FLAG = "--answer";

const FAILPOINTS: readonly Failpoint[] = [
	"after-admission-before-run",
	"after-native-result-before-ledger-finish",
	"after-ledger-finish-before-http-response",
];

/** One control message, answered over IPC. */
interface Command {
	readonly id: number;
	readonly action: string;
	readonly text?: string;
	readonly code?: FailedCode;
	readonly status?: EngineStatus;
	readonly failed?: boolean;
}

/** Answers one control message. */
type Controller = (command: Command) => Promise<unknown>;

function argumentValue(flag: string): string | undefined {
	const at = argv.indexOf(flag);
	return at === -1 ? undefined : argv[at + 1];
}

/**
 * Reads the test-only stream ceiling from this entry's own arguments. It is
 * passed to `runService` as a composition argument, exactly like the fake
 * engine: production's entry point passes no composition, so no argument,
 * environment variable or request can reach it there.
 */
function bufferCeiling(): number | undefined {
	const value = argumentValue(BUFFER_FLAG);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
	return parsed;
}

/** The armed failpoint, if this child was started with one this entry knows. */
function armedFailpoint(): Failpoint | undefined {
	const value = argumentValue(FAILPOINT_FLAG);
	return FAILPOINTS.find((failpoint) => failpoint === value);
}

/** Reports one thing as it happens, so the parent's record outlives this process. */
function notify(notice: ChildNotice): void {
	process.send?.(notice);
}

async function awaitRunning(engine: FakeEngine): Promise<boolean> {
	const deadline = Date.now() + RUNNING_TIMEOUT_MS;
	while (!engine.running) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, RUNNING_POLL_MS));
	}
	return true;
}

/** Answers one deterministic-engine action. Every one is a call a test could make. */
function fakeController(engine: FakeEngine): Controller {
	return async (command) => {
		switch (command.action) {
			case "ping":
				return true;
			case "callCount":
				return engine.calls.length;
			case "running":
				return engine.running;
			case "awaitRunning":
				return await awaitRunning(engine);
			case "complete":
				engine.complete(command.text ?? "");
				return true;
			case "fail":
				engine.fail(command.text, command.code);
				return true;
			case "emit":
				engine.emitText(command.text ?? "");
				return true;
			case "status":
				if (command.status === undefined) return null;
				engine.emitEvent({ type: "status", status: command.status });
				return true;
			case "stallCancel":
				// An uncooperative provider: cancellation is requested and the run
				// stays in flight until something else settles it.
				engine.abortSettles = false;
				return true;
			default:
				return null;
		}
	};
}

function registerControls(controller: Controller): void {
	process.on("message", (message) => {
		if (
			typeof message !== "object" ||
			message === null ||
			!("type" in message) ||
			(message as { type: unknown }).type !== "fake"
		) {
			return;
		}
		const command = message as unknown as Command;
		void controller(command).then(
			(value) => {
				process.send?.({ type: "fake-reply", id: command.id, value });
			},
			() => {
				process.send?.({ type: "fake-reply", id: command.id, value: null });
			},
		);
	});
}

/** The visible text parts of one message the SDK put in a request. */
function messageText(message: Message): string {
	const content: unknown = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			(part as { type: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/**
 * Summarises one request the real SDK built, without copying its content.
 *
 * The tool list, the sentinel flags and the assistant-turn count are the things
 * an acceptance journey asserts on; the prompt and the answer stay in the
 * conversation they belong to.
 */
function summarize(
	context: Context,
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): ProviderRequestSummary {
	const serialized = JSON.stringify(context.messages);
	return {
		provider: model.provider,
		model: model.id,
		maxTokens: options?.maxTokens ?? model.maxTokens,
		toolNames: (context.tools ?? []).map((tool) => tool.name),
		systemPromptHasSentinel: (context.systemPrompt ?? "").includes(SENTINEL),
		messagesHaveSentinel: serialized.includes(SENTINEL),
		messageCount: context.messages.length,
		assistantTextCount: context.messages.filter(
			(message) =>
				message.role === "assistant" && messageText(message).length > 0,
		).length,
	};
}

/**
 * The scripted faux responses.
 *
 * Every step is a factory, so each request the SDK actually makes is reported to
 * the parent as it happens — including one a restart should never have made. The
 * queue is deeper than any journey needs for the same reason.
 */
function scripted(
	text: string,
	failed: boolean,
): ((
	context: Context,
	options: SimpleStreamOptions | undefined,
	state: unknown,
	model: Model<Api>,
) => ReturnType<typeof fauxAssistantMessage>)[] {
	const step = (
		context: Context,
		options: SimpleStreamOptions | undefined,
		_state: unknown,
		model: Model<Api>,
	) => {
		notify({
			type: "provider-request",
			request: summarize(context, model, options),
		});
		return failed
			? fauxAssistantMessage(text, {
					stopReason: "error",
					errorMessage: text,
				})
			: fauxAssistantMessage(text);
	};
	return Array.from({ length: SCRIPTED_RESPONSES }, () => step);
}

/**
 * Composes the real Pi adapter over the SDK's own faux provider.
 *
 * Only the provider is synthetic: the model runtime, the session manager, the
 * resource loader and the conversation are the shipped SDK's, which is what lets
 * a test prove native results survive the death of this process. Nothing here
 * reads a credential file or opens a socket to a provider.
 */
async function composeFaux(
	context: { root: string; store: ServiceStore },
	answer: string,
): Promise<{ composed: ComposedEngine; controller: Controller }> {
	// Above BRN's own output ceiling, so a request the SDK makes proves the cap was
	// applied rather than inherited from the model.
	const { models, faux } = await offlineModels({ maxTokens: 8192 });
	faux.setResponses(scripted(answer, false));
	const host = await openPiRuntime({
		root: context.root,
		store: context.store,
		modelRuntime: models,
	});
	return {
		composed: {
			engine: createPiConversation(host),
			close: () => host.close(),
		},
		controller: async (command) => {
			switch (command.action) {
				case "ping":
					return true;
				case "script":
					faux.setResponses(
						scripted(command.text ?? answer, command.failed === true),
					);
					return true;
				default:
					return null;
			}
		},
	};
}

/**
 * Wraps a composed engine with the armed failpoint.
 *
 * Each failpoint pauses at a point whose ordering is the thing under test:
 *
 * - `after-admission-before-run`: the operation is durably admitted and the
 *   engine has not been asked to run anything, so a restart that replayed the
 *   prompt would be visible as a run the engine was never told to make.
 * - `after-native-result-before-ledger-finish`: the run's native bytes are
 *   durable — the adapter syncs them before it returns — and the ledger has not
 *   recorded the outcome yet.
 * - `after-ledger-finish-before-http-response`: the outcome is allowed through,
 *   which commits it synchronously in the coordinator, and every later read of
 *   its durable text hangs, so no client can be told what was committed. The
 *   notice is deferred by one macrotask for that reason: when the parent sees it,
 *   the ledger has finished.
 *
 * A paused run settles as cancelled if cancellation is requested, so a test that
 * does not kill the process can still shut it down.
 */
function instrumented(
	engine: ConversationEngine,
	failpoint: Failpoint | undefined,
): ConversationEngine {
	let release: ((result: RunResult) => void) | null = null;
	let latched = false;

	function pause(): Promise<RunResult> {
		return new Promise<RunResult>((resolve) => {
			release = resolve;
		});
	}

	return {
		snapshot: () => engine.snapshot(),
		models: () => engine.models(),
		sessions: () => engine.sessions(),
		create: (model) => engine.create(model),
		resume: (sessionId) => engine.resume(sessionId),
		selectModel: (model) => engine.selectModel(model),
		async run(
			command: PromptCommand,
			emit: (event: EngineEvent) => void,
		): Promise<RunResult> {
			if (failpoint === "after-admission-before-run") {
				notify({ type: "failpoint", name: failpoint });
				return await pause();
			}
			// Reported before the engine is asked, so the count is of runs that were
			// actually started rather than of prompts that were merely admitted.
			notify({ type: "engine-run" });
			const result = await engine.run(command, emit);
			if (failpoint === "after-native-result-before-ledger-finish") {
				notify({ type: "failpoint", name: failpoint });
				return await pause();
			}
			if (failpoint === "after-ledger-finish-before-http-response") {
				latched = true;
				setImmediate(() => notify({ type: "failpoint", name: failpoint }));
			}
			return result;
		},
		async cancel(): Promise<void> {
			const paused = release;
			release = null;
			paused?.({ kind: "cancelled", entryIds: [] });
			await engine.cancel();
		},
		async readResult(sessionId: string, entryIds: string[]): Promise<string> {
			// The committed outcome exists and nothing can carry it to a client.
			if (latched) await new Promise<never>(() => undefined);
			return await engine.readResult(sessionId, entryIds);
		},
		close: () => engine.close(),
	};
}

const ceiling = bufferCeiling();
const composition = ceiling === undefined ? {} : { maxBufferedBytes: ceiling };
const failpoint = armedFailpoint();
const answer = argumentValue(ANSWER_FLAG) ?? "synthetic faux answer";

if (argv.includes(FAKE_FLAG)) {
	const engine = new FakeEngine();
	registerControls(fakeController(engine));
	process.exitCode = await runService(argv, {
		...composition,
		engine: async () => ({
			engine: instrumented(engine, failpoint),
			close: async () => undefined,
		}),
	});
} else if (argv.includes(FAUX_FLAG)) {
	process.exitCode = await runService(argv, {
		...composition,
		engine: async (context) => {
			const { composed, controller } = await composeFaux(context, answer);
			registerControls(controller);
			return {
				engine: instrumented(composed.engine, failpoint),
				close: composed.close,
			};
		},
	});
} else {
	process.exitCode = await runService(argv, composition);
}

// The control listener above keeps the IPC channel referenced, which would keep
// this child alive after the service has shut down.
process.disconnect?.();
