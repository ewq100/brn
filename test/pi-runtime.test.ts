/**
 * Real-SDK tests for BRN's isolated conversation host.
 *
 * Nothing here mocks `createAgentSession` or any other Pi function: the host
 * builds genuine `AgentSession`s against the official faux provider, so the
 * assertions are about what the shipped SDK actually does. The shared fixture in
 * `test/support/pi.ts` keeps that honest by refusing network access and by
 * planting personal Pi resources the host must never load.
 */

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { openPiRuntime, type PiHost } from "../src/service/pi/runtime.ts";
import {
	extensionMarker,
	failureCode,
	OFFLINE_MODEL,
	offlineModels,
	openPiTestRoot,
	SENTINEL,
} from "./support/pi.ts";

const SECOND_MODEL = { provider: "brn-test", id: "second" };

/**
 * Proves the hosted conversation still sees no personal resources.
 *
 * Asserted after every replacement, not only after construction: a session swap
 * builds a fresh `AgentSession`, and that is exactly where a default loader would
 * creep back in.
 */
function expectNoAmbientResources(host: PiHost, home: string): void {
	const session = host.current();
	const loader = session.resourceLoader;
	expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
	expect(loader.getSkills().skills).toEqual([]);
	expect(loader.getPrompts().prompts).toEqual([]);
	expect(loader.getThemes().themes).toEqual([]);
	expect(loader.getExtensions().extensions).toEqual([]);
	expect(session.promptTemplates).toEqual([]);
	expect(session.systemPrompt).not.toContain(SENTINEL);
	expect(session.getAllTools()).toEqual([]);
	expect(session.getActiveToolNames()).toEqual([]);
	expect(session.settingsManager.getDefaultProvider()).toBeUndefined();
	expect(session.settingsManager.getCompactionSettings()).toEqual({
		enabled: true,
		reserveTokens: 5120,
		keepRecentTokens: 8192,
	});
	expect(existsSync(extensionMarker(home))).toBe(false);
}

test("real SDK keeps tools empty and reopens its own native result", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	faux.setResponses([fauxAssistantMessage("offline native result")]);
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		const info = await host.create({ provider: "brn-test", id: "offline" });
		expect(host.current().getAllTools()).toEqual([]);
		expect(host.current().getActiveToolNames()).toEqual([]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		await host.resume(info.id);
		expect(
			host
				.current()
				.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.content.some(
							(part) =>
								part.type === "text" && part.text === "offline native result",
						),
				),
		).toBe(true);
		expect(host.current().getAllTools()).toEqual([]);
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("no personal resource loads, at construction or after a replacement", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	const home = join(fixture.root, "..", "home");
	try {
		await host.create(OFFLINE_MODEL);
		expectNoAmbientResources(host, home);
		faux.setResponses([fauxAssistantMessage("first")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		expectNoAmbientResources(host, home);
		await host.create(OFFLINE_MODEL);
		expectNoAmbientResources(host, home);
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("two replacements keep only the newest conversation active", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	const observed: AgentSessionEvent[] = [];
	const unsubscribe = host.subscribe((event) => observed.push(event));
	try {
		const first = await host.create(OFFLINE_MODEL);
		faux.setResponses([fauxAssistantMessage("first answer")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();

		// Replacement one: a brand new, still unmaterialized conversation.
		const second = await host.create(OFFLINE_MODEL);
		expect(second.id).not.toBe(first.id);
		expect(host.current().sessionId).toBe(second.id);
		expect(host.current().messages).toEqual([]);
		expect(fixture.store.getActiveSession()).toBe(second.id);

		const beforeSecondRun = observed.length;
		faux.setResponses([fauxAssistantMessage("second answer")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		expect(observed.length).toBeGreaterThan(beforeSecondRun);

		// Replacement two: back to the first conversation's own native bytes.
		const resumed = await host.resume(first.id);
		expect(resumed.id).toBe(first.id);
		expect(host.current().sessionId).toBe(first.id);
		expect(
			host
				.current()
				.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.content.some(
							(part) => part.type === "text" && part.text === "first answer",
						),
				),
		).toBe(true);
		expect(
			host
				.current()
				.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.content.some(
							(part) => part.type === "text" && part.text === "second answer",
						),
				),
		).toBe(false);
		expect(fixture.store.getActiveSession()).toBe(first.id);
		expectNoAmbientResources(host, join(fixture.root, "..", "home"));

		const beforeUnsubscribe = observed.length;
		unsubscribe();
		faux.setResponses([fauxAssistantMessage("third answer")]);
		await host.current().prompt("synthetic only");
		expect(observed.length).toBe(beforeUnsubscribe);
	} finally {
		unsubscribe();
		await host.close();
		await fixture.close();
	}
});

test("an unavailable model is refused instead of silently substituted", async () => {
	const fixture = await openPiTestRoot();
	const { models } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		expect(
			await failureCode(() =>
				host.create({ provider: "nowhere", id: "absent" }),
			),
		).toBe("MODEL_UNAVAILABLE");
		expect(fixture.store.getActiveSession()).toBeNull();
		expect(fixture.store.getDefaultModel()).toBeNull();
		expect(await failureCode(() => Promise.resolve(host.current()))).toBe(
			"NO_ACTIVE_SESSION",
		);

		const created = await host.create(OFFLINE_MODEL);
		expect(
			await failureCode(() =>
				host.selectModel({ provider: "nowhere", id: "absent" }),
			),
		).toBe("MODEL_UNAVAILABLE");
		// A refused selection is not a replacement: the conversation is untouched.
		expect(host.current().sessionId).toBe(created.id);
		expect(host.current().model?.id).toBe("offline");
		expect(fixture.store.getDefaultModel()).toEqual(OFFLINE_MODEL);
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("the model a conversation runs is read back, never echoed from the request", async () => {
	const fixture = await openPiTestRoot();
	// Two models, so "the one that was asked for" is a real choice rather than the
	// only thing the catalog could possibly have seated.
	const { models } = await offlineModels({ extraModelIds: ["second"] });
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		const offered = await host.models();
		expect(offered).toContainEqual(OFFLINE_MODEL);
		expect(offered).toContainEqual(SECOND_MODEL);

		// Every identity BRN reports and records comes off the seated session, and
		// the seating gate refuses the construction unless it is the exact one
		// resolved for it.
		const created = await host.create(SECOND_MODEL);
		expect(created.model).toEqual(SECOND_MODEL);
		expect(host.current().model?.id).toBe("second");
		expect(host.snapshot().session).toEqual({
			id: created.id,
			model: SECOND_MODEL,
		});
		expect(fixture.store.sessionMetadata(created.id)).toEqual({
			model: SECOND_MODEL,
			materialized: false,
		});
		expect(fixture.store.getDefaultModel()).toEqual(SECOND_MODEL);

		// The replacement path is gated the same way: a resume that seated the
		// other model would be refused rather than reported as this one.
		const resumed = await host.resume(created.id);
		expect(resumed).toEqual({ id: created.id, model: SECOND_MODEL });
		expect(host.current().model?.id).toBe("second");
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("an empty conversation survives a restart as the same native session", async () => {
	const fixture = await openPiTestRoot();
	const first = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: first.models,
	});
	let created: string;
	try {
		created = (await host.create(OFFLINE_MODEL)).id;
		expect(fixture.store.sessionMetadata(created)).toEqual({
			model: OFFLINE_MODEL,
			materialized: false,
		});
		// Pi assigns the path before it writes: nothing is on disk yet.
		expect(existsSync(host.current().sessionFile ?? "")).toBe(false);
	} finally {
		await host.close();
	}

	const second = await offlineModels();
	const restarted = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: second.models,
	});
	try {
		expect(fixture.store.getActiveSession()).toBe(created);
		const resumed = await restarted.resume(created);
		expect(resumed).toEqual({ id: created, model: OFFLINE_MODEL });
		expect(restarted.current().sessionId).toBe(created);
		expect(restarted.current().messages).toEqual([]);

		second.faux.setResponses([fauxAssistantMessage("after restart")]);
		await restarted.current().prompt("synthetic only");
		await restarted.syncCurrentSession();
		expect(fixture.store.sessionMetadata(created)?.materialized).toBe(true);
	} finally {
		await restarted.close();
		await fixture.close();
	}
});

test("a materialized conversation whose file vanished is reported, not replaced", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		const created = await host.create(OFFLINE_MODEL);
		faux.setResponses([fauxAssistantMessage("durable answer")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		const file = host.current().sessionFile;
		expect(file).toBeDefined();
		expect(fixture.store.sessionMetadata(created.id)?.materialized).toBe(true);

		await rm(file ?? "", { force: true });
		expect(await failureCode(() => host.resume(created.id))).toBe(
			"SESSION_UNAVAILABLE",
		);
		// The conversation BRN was hosting is still the one it reports.
		expect(host.current().sessionId).toBe(created.id);
		expect(host.current().messages.length).toBeGreaterThan(0);
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("duplicate native session IDs are reported rather than picked between", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		const created = await host.create(OFFLINE_MODEL);
		faux.setResponses([fauxAssistantMessage("durable answer")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		const file = host.current().sessionFile;
		expect(file).toBeDefined();
		const bytes = await readFile(file ?? "", "utf8");
		await writeFile(join(fixture.root, "sessions", "duplicate.jsonl"), bytes, {
			mode: 0o600,
		});

		expect(await failureCode(() => host.resume(created.id))).toBe(
			"SESSION_CONFLICT",
		);
		expect(host.current().sessionId).toBe(created.id);
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("a failed replacement leaves no conversation advertised as active", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		const first = await host.create(OFFLINE_MODEL);
		faux.setResponses([fauxAssistantMessage("durable answer")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		const second = await host.create(OFFLINE_MODEL);
		expect(host.current().sessionId).toBe(second.id);

		// The model the stored conversation names stops being available, so the
		// replacement fails after the outgoing conversation has been torn down.
		models.unregisterProvider("brn-test");
		expect(await failureCode(() => host.resume(first.id))).toBe(
			"MODEL_UNAVAILABLE",
		);
		expect(await failureCode(() => Promise.resolve(host.current()))).toBe(
			"NO_ACTIVE_SESSION",
		);
		expect(host.snapshot().session).toBeNull();
		// Only an explicit, successful resume restores a hosted conversation.
		models.registerNativeProvider(faux.provider);
		await models.refresh({ allowNetwork: false });
		expect(await host.resume(first.id)).toEqual({
			id: first.id,
			model: OFFLINE_MODEL,
		});
	} finally {
		await host.close();
		await fixture.close();
	}
});

test("an unknown context stays unknown and usage starts at zero", async () => {
	const fixture = await openPiTestRoot();
	const zeroes = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
	};
	const unknown = await offlineModels({ contextWindow: 0 });
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: unknown.models,
	});
	try {
		expect(host.snapshot()).toEqual({
			session: null,
			context: null,
			usage: zeroes,
		});
		const created = await host.create(OFFLINE_MODEL);
		// The SDK cannot size this model's context, so BRN reports nothing rather
		// than a comfortable zero percent.
		expect(host.snapshot()).toEqual({
			session: { id: created.id, model: OFFLINE_MODEL },
			context: null,
			usage: zeroes,
		});
	} finally {
		await host.close();
		await fixture.close();
	}

	const known = await offlineModels();
	const sized = await openPiTestRoot();
	const host2 = await openPiRuntime({
		root: sized.root,
		store: sized.store,
		modelRuntime: known.models,
	});
	try {
		await host2.create(OFFLINE_MODEL);
		const context = host2.snapshot().context;
		expect(context?.contextWindow).toBe(32768);
		expect(host2.snapshot().usage).toEqual(zeroes);
	} finally {
		await host2.close();
		await sized.close();
	}
});

test("closing the host disposes the conversation and stops its events", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	const observed: AgentSessionEvent[] = [];
	host.subscribe((event) => observed.push(event));
	try {
		await host.create(OFFLINE_MODEL);
		faux.setResponses([fauxAssistantMessage("before close")]);
		await host.current().prompt("synthetic only");
		expect(observed.length).toBeGreaterThan(0);
		const seen = observed.length;

		await host.close();
		expect(observed.length).toBe(seen);
		expect(host.snapshot()).toEqual({
			session: null,
			context: null,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			},
		});
		expect(await failureCode(() => Promise.resolve(host.current()))).toBe(
			"NO_ACTIVE_SESSION",
		);
		expect(await failureCode(() => host.create(OFFLINE_MODEL))).toBe(
			"SERVICE_STOPPING",
		);
		// Closing twice is how shutdown after a failed start behaves.
		await host.close();
	} finally {
		await fixture.close();
	}
});

test("the production model runtime reaches no ambient catalog and no network", async () => {
	const fixture = await openPiTestRoot();
	// Pi resolves its own agent directory from HOME, which the fixture points at
	// its temporary tree: the real credential file is not on any path taken here.
	expect(getAgentDir()).toBe(join(fixture.home, ".pi", "agent"));
	expect(existsSync(join(fixture.home, ".pi", "agent", "models.json"))).toBe(
		true,
	);
	const blocked = globalThis.fetch;
	let attempts = 0;
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
		attempts += 1;
		return blocked(...args);
	}) as typeof globalThis.fetch;
	try {
		// No `modelRuntime`: this is the production construction path, the one that
		// configures `modelsPath: null` and Pi's own `auth.json`.
		const host = await openPiRuntime({
			root: fixture.root,
			store: fixture.store,
		});
		try {
			// The planted personal models.json offers a sentinel model. Nothing does.
			expect(await host.models()).toEqual([]);
			expect(host.snapshot()).toEqual({
				session: null,
				context: null,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
				},
			});
			expect(await host.sessions()).toEqual([]);
			// A models store beside the personal catalog would mean a file-backed
			// catalog was configured after all.
			expect(
				existsSync(join(fixture.home, ".pi", "agent", "models-store.json")),
			).toBe(false);
			expect(attempts).toBe(0);
		} finally {
			await host.close();
		}
	} finally {
		globalThis.fetch = blocked;
		await fixture.close();
	}
});

test("the host lists its own native sessions and the models it can use", async () => {
	const fixture = await openPiTestRoot();
	const { models, faux } = await offlineModels();
	const host = await openPiRuntime({
		root: fixture.root,
		store: fixture.store,
		modelRuntime: models,
	});
	try {
		expect(await host.models()).toEqual([OFFLINE_MODEL]);
		expect(await host.sessions()).toEqual([]);
		const created = await host.create(OFFLINE_MODEL);
		faux.setResponses([fauxAssistantMessage("durable answer")]);
		await host.current().prompt("synthetic only");
		await host.syncCurrentSession();
		expect(await host.sessions()).toEqual([
			{ id: created.id, model: OFFLINE_MODEL },
		]);
	} finally {
		await host.close();
		await fixture.close();
	}
});
