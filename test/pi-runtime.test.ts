/**
 * Real-SDK tests for BRN's isolated conversation host.
 *
 * Nothing here mocks `createAgentSession` or any other Pi function: the host
 * builds genuine `AgentSession`s against the official faux provider, so the
 * assertions are about what the shipped SDK actually does. The fixture keeps that
 * honest by refusing network access and by planting personal Pi resources the
 * host must never load.
 */

import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { isBrnError } from "../src/core/errors.ts";
import {
	openOperationStore,
	type ServiceStore,
} from "../src/service/operation-store.ts";
import { createOrValidateManagedFile } from "../src/service/ownership.ts";
import { openPiRuntime, type PiHost } from "../src/service/pi/runtime.ts";

/** Appears in every planted personal resource. It must never reach a session. */
const SENTINEL = "BRN_AMBIENT_SENTINEL";

const OFFLINE_MODEL = { provider: "brn-test", id: "offline" };
const SECOND_MODEL = { provider: "brn-test", id: "second" };

type PiTestRoot = {
	root: string;
	/** The fake home the fixture points `HOME` at, so Pi's own agent dir lands here. */
	home: string;
	store: ServiceStore;
	close(): Promise<void>;
};

/**
 * Replaces every outbound HTTP entry point with a refusal.
 *
 * A test that silently reaches a provider is a failed test, not a slow one, so
 * the attempt has to fail loudly. Only the HTTP surfaces a provider would use are
 * blocked; vitest's own worker channel does not go through them.
 */
function blockNetwork(): () => void {
	const refuse = (surface: string) => () => {
		throw new Error(`offline test attempted network access via ${surface}`);
	};
	const original = {
		fetch: globalThis.fetch,
		httpRequest: http.request,
		httpGet: http.get,
		httpsRequest: https.request,
		httpsGet: https.get,
	};
	globalThis.fetch = refuse("fetch") as unknown as typeof globalThis.fetch;
	http.request = refuse("http.request") as unknown as typeof http.request;
	http.get = refuse("http.get") as unknown as typeof http.get;
	https.request = refuse("https.request") as unknown as typeof https.request;
	https.get = refuse("https.get") as unknown as typeof https.get;
	return () => {
		globalThis.fetch = original.fetch;
		http.request = original.httpRequest;
		http.get = original.httpGet;
		https.request = original.httpsRequest;
		https.get = original.httpsGet;
	};
}

/**
 * Hides the real home directory and every inherited provider credential.
 *
 * An inherited `ANTHROPIC_API_KEY` would make a "no model available" assertion
 * pass or fail for reasons that have nothing to do with BRN.
 */
function isolateEnvironment(home: string): () => void {
	const saved = new Map<string, string | undefined>();
	const hide = (key: string) => {
		saved.set(key, process.env[key]);
		delete process.env[key];
	};
	for (const key of Object.keys(process.env)) {
		if (
			/API_KEY|_TOKEN|CREDENTIAL|ANTHROPIC|OPENAI|GEMINI|GOOGLE|AZURE|AWS|MISTRAL|GROQ|XAI|DEEPSEEK|OPENROUTER|CEREBRAS|VERTEX|^PI_/i.test(
				key,
			)
		) {
			hide(key);
		}
	}
	for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) {
		saved.set(key, process.env[key]);
		process.env[key] = home;
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/** The file the planted extension writes if it is ever imported and run. */
function extensionMarker(home: string): string {
	return join(home, ".pi", "agent", "extensions", "sentinel.loaded");
}

/**
 * Plants the personal Pi installation BRN must ignore: context files, settings,
 * a skill, a prompt template and an extension, in both the fake home and the
 * conversation's working directory.
 */
async function plantAmbientResources(
	home: string,
	work: string,
): Promise<void> {
	const agentDir = join(home, ".pi", "agent");
	for (const dir of [
		join(agentDir, "skills", "sentinel"),
		join(agentDir, "prompts"),
		join(agentDir, "extensions"),
		join(work, ".pi", "extensions"),
	]) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
	}
	const marker = extensionMarker(home);
	const extension = [
		'import { writeFileSync } from "node:fs";',
		`writeFileSync(${JSON.stringify(marker)}, "loaded");`,
		"export default () => ({});",
		"",
	].join("\n");
	await writeFile(join(home, "AGENTS.md"), `# ${SENTINEL} home instructions\n`);
	await writeFile(
		join(work, "AGENTS.md"),
		`# ${SENTINEL} project instructions\n`,
	);
	await writeFile(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			defaultProvider: SENTINEL,
			defaultModel: SENTINEL,
			extensions: [join(agentDir, "extensions", "sentinel.js")],
			skills: [join(agentDir, "skills")],
			prompts: [join(agentDir, "prompts")],
			compaction: { enabled: false },
		})}\n`,
	);
	await writeFile(
		join(work, ".pi", "settings.json"),
		`${JSON.stringify({ defaultProvider: SENTINEL })}\n`,
	);
	await writeFile(
		join(agentDir, "skills", "sentinel", "SKILL.md"),
		`---\nname: ${SENTINEL}\ndescription: ${SENTINEL}\n---\n\n${SENTINEL}\n`,
	);
	await writeFile(join(agentDir, "prompts", "sentinel.md"), `${SENTINEL}\n`);
	// A personal model catalog. The production model runtime is configured with
	// `modelsPath: null`, so this must never become an offered model.
	await writeFile(
		join(agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				[SENTINEL]: {
					name: SENTINEL,
					api: "openai-completions",
					baseUrl: "https://sentinel.invalid/v1",
					apiKey: SENTINEL,
					models: [
						{
							id: SENTINEL,
							name: SENTINEL,
							reasoning: false,
							contextWindow: 32768,
							maxTokens: 4096,
						},
					],
				},
			},
		})}\n`,
	);
	await writeFile(join(agentDir, "extensions", "sentinel.js"), extension);
	await writeFile(join(work, ".pi", "extensions", "sentinel.js"), extension);
}

/**
 * Opens a guarded state root with the real metadata store, an isolated
 * environment and no network.
 *
 * The work directory is created here, before the host validates it, so the
 * planted project resources are already in place when a conversation starts.
 */
async function openPiTestRoot(): Promise<PiTestRoot> {
	const base = await mkdtemp(join(await realpath(tmpdir()), "brn-pi-"));
	const root = join(base, "state");
	const home = join(base, "home");
	await mkdir(root, { mode: 0o700 });
	await mkdir(join(root, "work"), { mode: 0o700 });
	await plantAmbientResources(home, join(root, "work"));
	const restoreEnvironment = isolateEnvironment(home);
	const restoreNetwork = blockNetwork();
	const databasePath = join(root, "operations.sqlite");
	await createOrValidateManagedFile(databasePath);
	const store = openOperationStore(databasePath);
	return {
		root,
		home,
		store,
		async close() {
			store.close();
			restoreNetwork();
			restoreEnvironment();
			await rm(base, { recursive: true, force: true });
		},
	};
}

/** The offline model runtime every test drives the real SDK with. */
async function offlineModels(
	contextWindow = 32768,
	extraModelIds: readonly string[] = [],
): Promise<{ models: ModelRuntime; faux: ReturnType<typeof fauxProvider> }> {
	const faux = fauxProvider({
		provider: "brn-test",
		api: "brn-test",
		models: ["offline", ...extraModelIds].map((id) => ({
			id,
			name: id,
			reasoning: false,
			contextWindow,
			maxTokens: 4096,
		})),
	});
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(faux.provider);
	await models.refresh({ allowNetwork: false });
	return { models, faux };
}

/** The BRN failure code a control reported, or a description of what it did instead. */
async function failureCode(action: () => Promise<unknown>): Promise<string> {
	try {
		await action();
	} catch (error) {
		return isBrnError(error) ? error.code : `unexpected: ${String(error)}`;
	}
	return "resolved";
}

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
	const faux = fauxProvider({
		provider: "brn-test",
		api: "brn-test",
		models: [
			{
				id: "offline",
				name: "Offline",
				reasoning: false,
				contextWindow: 32768,
				maxTokens: 4096,
			},
		],
	});
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(faux.provider);
	await models.refresh({ allowNetwork: false });
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
	const { models } = await offlineModels(32768, ["second"]);
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
	const unknown = await offlineModels(0);
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
