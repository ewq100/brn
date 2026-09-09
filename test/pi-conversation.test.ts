/**
 * Real-SDK tests for the Pi conversation adapter.
 *
 * Every outcome here is produced by the shipped SDK driving the official faux
 * provider: nothing mocks `createAgentSession`, `session.prompt` or the session
 * lifecycle, and the shared fixture refuses outbound network access. The faux
 * provider proves which model and options BRN hands to Pi's runtime; it does not
 * stand in for any real provider's HTTP payload.
 */

import { randomUUID } from "node:crypto";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import type { PromptCommand } from "../src/core/conversation.ts";
import { createPiConversation } from "../src/service/pi/conversation.ts";
import type { PiHost } from "../src/service/pi/runtime.ts";
import {
	createPiFixture,
	failureCode,
	OFFLINE_MODEL,
	type PiFixture,
} from "./support/pi.ts";

/** The largest prompt BRN accepts, in UTF-8 bytes. */
const MAX_PROMPT_BYTES = 16384;

/** A prompt for the conversation the fixture is hosting right now. */
function promptFor(fixture: PiFixture, text: string): PromptCommand {
	const session = fixture.engine.snapshot().session;
	if (!session?.model) throw new Error("fixture has no active model");
	return {
		requestId: randomUUID(),
		sessionId: session.id,
		model: session.model,
		text,
	};
}

/** A terminal message the provider ended for a specific reason. */
function terminal(
	text: string,
	stopReason: "error" | "aborted" | "length",
	errorMessage?: string,
) {
	return {
		...fauxAssistantMessage("synthetic"),
		content: [{ type: "text" as const, text }],
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
}

test("the real SDK receives the bounded model on each prompt", async () => {
	const fixture = await createPiFixture();
	const stream = vi.spyOn(fixture.modelRuntime, "streamSimple");
	fixture.faux.setResponses([fauxAssistantMessage("bounded response")]);
	try {
		const session = fixture.engine.snapshot().session;
		if (!session?.model) throw new Error("fixture has no active model");
		const result = await fixture.engine.run(
			{
				requestId: "670742ce-591b-4dd3-99db-052a49e1c4ec",
				sessionId: session.id,
				model: session.model,
				text: "synthetic only",
			},
			() => {},
		);
		expect(result.kind).toBe("completed");
		expect(stream).toHaveBeenCalled();
		for (const call of stream.mock.calls) {
			expect(call[0].maxTokens).toBeLessThanOrEqual(4096);
		}
	} finally {
		await fixture.close();
	}
});

test("a completed answer is durable, referenced and streamed as text only", async () => {
	const fixture = await createPiFixture();
	fixture.faux.setResponses([
		fauxAssistantMessage("the whole synthetic answer"),
	]);
	const events: string[] = [];
	let streamed = "";
	try {
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			(event) => {
				events.push(event.type);
				if (event.type === "text") streamed += event.text;
			},
		);
		expect(result).toMatchObject({ kind: "completed", truncated: false });
		if (result.kind !== "completed") throw new Error("expected completion");
		expect(result.entryIds).toHaveLength(1);
		expect(streamed).toBe("the whole synthetic answer");
		expect(events).toContain("status");
		expect(events).toContain("context");
		expect(
			await fixture.engine.readResult(fixture.session.id, result.entryIds),
		).toBe("the whole synthetic answer");
		// The answer is only acknowledged once its native bytes are durable.
		expect(fixture.store.sessionMetadata(fixture.session.id)).toEqual({
			model: OFFLINE_MODEL,
			materialized: true,
		});
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	} finally {
		await fixture.close();
	}
});

test("hidden reasoning is never forwarded as answer text", async () => {
	const fixture = await createPiFixture();
	fixture.faux.setResponses([
		fauxAssistantMessage([
			fauxThinking("the hidden reasoning"),
			fauxText("the visible answer"),
		]),
	]);
	let streamed = "";
	try {
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			(event) => {
				if (event.type === "text") streamed += event.text;
			},
		);
		expect(result.kind).toBe("completed");
		expect(streamed).toBe("the visible answer");
		if (result.kind !== "completed") throw new Error("expected completion");
		expect(
			await fixture.engine.readResult(fixture.session.id, result.entryIds),
		).toBe("the visible answer");
	} finally {
		await fixture.close();
	}
});

test("a provider error is not a successful answer, even though prompt resolves", async () => {
	const fixture = await createPiFixture();
	fixture.faux.setResponses([
		terminal("partial before failure", "error", "synthetic provider failure"),
	]);
	try {
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		expect(result.kind).toBe("failed");
		if (result.kind !== "failed") throw new Error("expected a failure");
		expect(result.code).toBe("PROVIDER_ERROR");
		// The partial text stays inspectable rather than being reported as an answer.
		expect(result.entryIds).toHaveLength(1);
		expect(
			await fixture.engine.readResult(fixture.session.id, result.entryIds),
		).toBe("partial before failure");
		expect(fixture.faux.state.callCount).toBe(1);
	} finally {
		await fixture.close();
	}
});

test("an aborted response is reported as a cancellation, not a completion", async () => {
	const fixture = await createPiFixture();
	fixture.faux.setResponses([terminal("stopped midway", "aborted")]);
	try {
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		expect(result.kind).toBe("cancelled");
		expect(result.entryIds).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("a length stop is completed but truncated", async () => {
	const fixture = await createPiFixture();
	fixture.faux.setResponses([terminal("as much as fitted", "length")]);
	try {
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		expect(result).toMatchObject({ kind: "completed", truncated: true });
		if (result.kind !== "completed") throw new Error("expected completion");
		expect(
			await fixture.engine.readResult(fixture.session.id, result.entryIds),
		).toBe("as much as fitted");
	} finally {
		await fixture.close();
	}
});

test("prompt size is bounded in UTF-8 bytes, not characters", async () => {
	const fixture = await createPiFixture();
	// 5461 three-byte characters plus one ASCII byte is exactly the limit.
	const atLimit = `${"€".repeat(5461)}a`;
	expect(Buffer.byteLength(atLimit, "utf8")).toBe(MAX_PROMPT_BYTES);
	const overLimit = `${atLimit}a`;
	expect(Buffer.byteLength(overLimit, "utf8")).toBe(MAX_PROMPT_BYTES + 1);
	// A string whose character count is under the limit but whose bytes are not.
	const multibyteOnly = "€".repeat(6000);
	expect(multibyteOnly.length).toBeLessThan(MAX_PROMPT_BYTES);
	fixture.faux.setResponses([fauxAssistantMessage("accepted at the limit")]);
	try {
		expect(
			(await fixture.engine.run(promptFor(fixture, atLimit), () => {})).kind,
		).toBe("completed");
		expect(
			await failureCode(() =>
				fixture.engine.run(promptFor(fixture, overLimit), () => {}),
			),
		).toBe("INPUT_TOO_LARGE");
		expect(
			await failureCode(() =>
				fixture.engine.run(promptFor(fixture, multibyteOnly), () => {}),
			),
		).toBe("INPUT_TOO_LARGE");
		expect(
			await failureCode(() =>
				fixture.engine.run(promptFor(fixture, ""), () => {}),
			),
		).toBe("EMPTY_PROMPT");
		expect(
			await failureCode(() =>
				fixture.engine.run(promptFor(fixture, " \n\t "), () => {}),
			),
		).toBe("EMPTY_PROMPT");
		// Exactly one provider request was made: the accepted one.
		expect(fixture.faux.state.callCount).toBe(1);
	} finally {
		await fixture.close();
	}
});

test("cancellation requested during preflight starts no provider request", async () => {
	const fixture = await createPiFixture();
	const runtime = fixture.modelRuntime;
	const original = runtime.checkAuth.bind(runtime);
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	// The model preflight is held open, so cancellation lands while BRN is awaiting
	// it. Nothing about the session lifecycle is replaced.
	const checkAuth = vi
		.spyOn(runtime, "checkAuth")
		.mockImplementation(async (provider, options) => {
			await gate;
			return await original(provider, options);
		});
	const stream = vi.spyOn(runtime, "streamSimple");
	fixture.faux.setResponses([fauxAssistantMessage("never requested")]);
	try {
		const run = fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		await Promise.resolve();
		const cancellation = fixture.engine.cancel();
		release();
		const result = await run;
		await cancellation;
		expect(checkAuth).toHaveBeenCalled();
		expect(result).toEqual({ kind: "cancelled", entryIds: [] });
		expect(stream).not.toHaveBeenCalled();
		expect(fixture.faux.state.callCount).toBe(0);
		expect(fixture.faux.getPendingResponseCount()).toBe(1);
	} finally {
		await fixture.close();
	}
});

test("cancelling a streaming response keeps its partial answer durable", async () => {
	// Paced streaming, so the response is still arriving when cancellation lands.
	const fixture = await createPiFixture({ tokensPerSecond: 40 });
	const answer =
		"a long synthetic answer that is cancelled part way through, with enough words to arrive in several chunks";
	fixture.faux.setResponses([fauxAssistantMessage(answer)]);
	let cancellation: Promise<void> | undefined;
	const statuses: string[] = [];
	try {
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			(event) => {
				if (event.type === "status") statuses.push(event.status);
				// Cancelling from the first delta makes the race deterministic: the
				// latch is set while the provider is still streaming.
				if (event.type === "text" && cancellation === undefined) {
					cancellation = fixture.engine.cancel();
				}
			},
		);
		await cancellation;
		expect(result.kind).toBe("cancelled");
		expect(result.entryIds).toHaveLength(1);
		expect(statuses).toContain("cancelling");
		const partial = await fixture.engine.readResult(
			fixture.session.id,
			result.entryIds,
		);
		expect(answer.startsWith(partial)).toBe(true);
		expect(partial.length).toBeLessThan(answer.length);
	} finally {
		await fixture.close();
	}
});

test("a preflight failure returns no result IDs and borrows no earlier answer", async () => {
	const fixture = await createPiFixture();
	fixture.faux.setResponses([fauxAssistantMessage("the earlier answer")]);
	try {
		const first = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		if (first.kind !== "completed") throw new Error("expected completion");
		expect(first.entryIds).toHaveLength(1);

		// The provider's credentials stop being configured, so the model preflight
		// refuses before any request is dispatched.
		const runtime = fixture.modelRuntime;
		vi.spyOn(runtime, "checkAuth").mockResolvedValue(undefined);
		vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(false);
		const second = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		expect(second).toEqual({
			kind: "failed",
			code: "AUTH_REQUIRED",
			entryIds: [],
		});
		expect(fixture.faux.state.callCount).toBe(1);
	} finally {
		vi.restoreAllMocks();
		await fixture.close();
	}
});

test("each run references only its own answer, across repeated replacement", async () => {
	const fixture = await createPiFixture();
	try {
		fixture.faux.setResponses([fauxAssistantMessage("answer in the first")]);
		const first = fixture.session;
		const firstRun = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		if (firstRun.kind !== "completed") throw new Error("expected completion");

		const second = await fixture.engine.create(OFFLINE_MODEL);
		expect(second.id).not.toBe(first.id);
		fixture.faux.setResponses([fauxAssistantMessage("answer in the second")]);
		const secondRun = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		if (secondRun.kind !== "completed") throw new Error("expected completion");
		expect(secondRun.entryIds).not.toEqual(firstRun.entryIds);
		expect(await fixture.engine.readResult(second.id, secondRun.entryIds)).toBe(
			"answer in the second",
		);

		// Reopening the first conversation resolves its own recorded result, and the
		// other conversation's entry is unavailable rather than silently empty.
		await fixture.engine.resume(first.id);
		expect(await fixture.engine.readResult(first.id, firstRun.entryIds)).toBe(
			"answer in the first",
		);
		expect(
			await failureCode(() =>
				fixture.engine.readResult(first.id, secondRun.entryIds),
			),
		).toBe("RESULT_UNAVAILABLE");
		expect(
			await failureCode(() =>
				fixture.engine.readResult(second.id, firstRun.entryIds),
			),
		).toBe("SESSION_MISMATCH");
	} finally {
		await fixture.close();
	}
});

test("the saved model's request cap is reapplied after a conversation reopens", async () => {
	const fixture = await createPiFixture({ maxTokens: 8192 });
	try {
		fixture.faux.setResponses([fauxAssistantMessage("before the reopen")]);
		await fixture.engine.run(promptFor(fixture, "synthetic only"), () => {});
		await fixture.engine.resume(fixture.session.id);
		// The reopened conversation seats the model saved in its own native bytes.
		expect(fixture.host.current().model?.maxTokens).toBe(4096);
		const stream = vi.spyOn(fixture.modelRuntime, "streamSimple");
		fixture.faux.setResponses([fauxAssistantMessage("after the reopen")]);
		const result = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		expect(result.kind).toBe("completed");
		expect(stream).toHaveBeenCalled();
		for (const call of stream.mock.calls) {
			expect(call[0].maxTokens).toBeLessThanOrEqual(4096);
		}
	} finally {
		vi.restoreAllMocks();
		await fixture.close();
	}
});

test("a native result BRN cannot make durable is not recorded as a success", async () => {
	const fixture = await createPiFixture();
	const host = fixture.host;
	// Only BRN's own durability step fails. The SDK, the session and the provider
	// are the real ones.
	const unsyncable: PiHost = {
		snapshot: () => host.snapshot(),
		models: () => host.models(),
		sessions: () => host.sessions(),
		create: (model) => host.create(model),
		resume: (sessionId) => host.resume(sessionId),
		selectModel: (model) => host.selectModel(model),
		current: () => host.current(),
		subscribe: (listener) => host.subscribe(listener),
		syncCurrentSession: async () => {
			throw new Error("simulated fsync failure");
		},
		close: () => host.close(),
	};
	const engine = createPiConversation(unsyncable);
	fixture.faux.setResponses([fauxAssistantMessage("answered but not durable")]);
	try {
		expect(
			await failureCode(() =>
				engine.run(promptFor(fixture, "synthetic only"), () => {}),
			),
		).toBe("STATE_UNAVAILABLE");
		// Nothing claims the conversation's bytes are durable.
		expect(
			fixture.store.sessionMetadata(fixture.session.id)?.materialized,
		).toBe(false);
	} finally {
		await fixture.close();
	}
});

test("a retryable provider error is reported once, never retried", async () => {
	const fixture = await createPiFixture();
	const observed: AgentSessionEvent[] = [];
	const unsubscribe = fixture.host.subscribe((event) => observed.push(event));
	try {
		fixture.faux.setResponses([
			terminal("", "error", "overloaded: please try again"),
			fauxAssistantMessage("a retry BRN must never spend"),
		]);
		const failed = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			() => {},
		);
		expect(failed).toMatchObject({ kind: "failed", code: "PROVIDER_ERROR" });
		// Pi's ordinary retry path is off, so the second scripted response is left
		// untouched.
		expect(fixture.faux.state.callCount).toBe(1);
		expect(fixture.faux.getPendingResponseCount()).toBe(1);
		expect(observed.some((event) => event.type === "auto_retry_start")).toBe(
			false,
		);
	} finally {
		unsubscribe();
		await fixture.close();
	}
});

test("overflow recovery stays observable inside the one operation", async () => {
	// A large window keeps threshold compaction out of the way, so only the
	// scripted overflow can start a compaction.
	const fixture = await createPiFixture({ contextWindow: 200000 });
	const observed: AgentSessionEvent[] = [];
	const unsubscribe = fixture.host.subscribe((event) => observed.push(event));
	try {
		// Enough history for a compaction cut point to exist at all.
		const filler = "s".repeat(16000);
		for (let turn = 0; turn < 4; turn += 1) {
			fixture.faux.setResponses([fauxAssistantMessage(`turn ${turn}`)]);
			const result = await fixture.engine.run(
				promptFor(fixture, filler),
				() => {},
			);
			expect(result.kind).toBe("completed");
		}

		const before = fixture.faux.state.callCount;
		observed.length = 0;
		const statuses: string[] = [];
		// The documented single compact-and-retry path: the overflow response, the
		// summarization request, then the retried answer.
		fixture.faux.setResponses([
			terminal(
				"",
				"error",
				"prompt is too long: 213462 tokens > 200000 maximum",
			),
			fauxAssistantMessage("a synthetic summary of the earlier turns"),
			fauxAssistantMessage("the recovered answer"),
		]);
		const recovered = await fixture.engine.run(
			promptFor(fixture, "synthetic only"),
			(event) => {
				if (event.type === "status") statuses.push(event.status);
			},
		);
		expect(
			observed.some(
				(event) =>
					event.type === "compaction_start" && event.reason === "overflow",
			),
		).toBe(true);
		expect(statuses).toContain("compacting");
		expect(observed.some((event) => event.type === "auto_retry_start")).toBe(
			false,
		);
		// The overflow response, one summarization and one retried answer. Nothing
		// beyond Pi's single documented recovery attempt.
		expect(fixture.faux.state.callCount).toBe(before + 3);
		expect(recovered.kind).toBe("completed");
		if (recovered.kind !== "completed") throw new Error("expected completion");
		// Only the recovered answer is the result. The failed attempt stays in Pi's
		// native history instead of being concatenated into it.
		expect(recovered.entryIds).toHaveLength(1);
		expect(
			await fixture.engine.readResult(fixture.session.id, recovered.entryIds),
		).toBe("the recovered answer");
	} finally {
		unsubscribe();
		await fixture.close();
	}
});
