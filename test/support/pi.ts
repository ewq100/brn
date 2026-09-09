/**
 * The isolated real-SDK fixture.
 *
 * Nothing here mocks `createAgentSession`, `session.prompt` or any other Pi
 * function: tests build genuine `AgentSession`s against the official faux
 * provider, so their assertions are about what the shipped SDK actually does.
 * The fixture keeps that honest by refusing outbound network access, hiding the
 * real home directory and every inherited provider credential, and planting the
 * personal Pi installation BRN must never load.
 *
 * This module is test support and is never imported from production code.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	ConversationEngine,
	SessionInfo,
} from "../../src/core/conversation.ts";
import { isBrnError } from "../../src/core/errors.ts";
import {
	openOperationStore,
	type ServiceStore,
} from "../../src/service/operation-store.ts";
import { createOrValidateManagedFile } from "../../src/service/ownership.ts";
import { createPiConversation } from "../../src/service/pi/conversation.ts";
import { openPiRuntime, type PiHost } from "../../src/service/pi/runtime.ts";

/** Appears in every planted personal resource. It must never reach a session. */
export const SENTINEL = "BRN_AMBIENT_SENTINEL";

/** The only model the offline catalog offers unless a test asks for more. */
export const OFFLINE_MODEL = { provider: "brn-test", id: "offline" };

export type FauxHandle = ReturnType<typeof fauxProvider>;

export type PiTestRoot = {
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
export function extensionMarker(home: string): string {
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
export async function openPiTestRoot(): Promise<PiTestRoot> {
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

export type OfflineModelsOptions = {
	readonly contextWindow?: number;
	/** Extra model IDs, so "the model that was asked for" can be a real choice. */
	readonly extraModelIds?: readonly string[];
	readonly maxTokens?: number;
	/**
	 * Streaming pace. Setting it makes a response arrive over several turns of the
	 * event loop, which is what lets a test cancel one while it is still streaming.
	 */
	readonly tokensPerSecond?: number;
};

/** The offline model runtime every test drives the real SDK with. */
export async function offlineModels(
	options: OfflineModelsOptions = {},
): Promise<{ models: ModelRuntime; faux: FauxHandle }> {
	const faux = fauxProvider({
		provider: "brn-test",
		api: "brn-test",
		...(options.tokensPerSecond === undefined
			? {}
			: { tokensPerSecond: options.tokensPerSecond }),
		models: ["offline", ...(options.extraModelIds ?? [])].map((id) => ({
			id,
			name: id,
			reasoning: false,
			contextWindow: options.contextWindow ?? 32768,
			maxTokens: options.maxTokens ?? 4096,
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
export async function failureCode(
	action: () => Promise<unknown>,
): Promise<string> {
	try {
		await action();
	} catch (error) {
		return isBrnError(error) ? error.code : `unexpected: ${String(error)}`;
	}
	return "resolved";
}

export type PiFixtureOptions = {
	/** The context window the offered model declares. */
	readonly contextWindow?: number;
	/**
	 * The model's own output ceiling. It defaults above BRN's 4096-token request
	 * cap, so a test that watches the runtime proves BRN applied the cap rather
	 * than inheriting it from the catalog.
	 */
	readonly maxTokens?: number;
	/** Streaming pace, for a test that cancels a response while it is arriving. */
	readonly tokensPerSecond?: number;
};

export type PiFixture = {
	readonly engine: ConversationEngine;
	readonly host: PiHost;
	readonly modelRuntime: ModelRuntime;
	readonly faux: FauxHandle;
	readonly store: ServiceStore;
	readonly root: string;
	readonly home: string;
	/** The conversation the fixture created, already hosted and seated. */
	readonly session: SessionInfo;
	close(): Promise<void>;
};

/**
 * A hosted `brn-test/offline` conversation with the real adapter over it.
 *
 * The conversation exists and is seated before the fixture returns, so a test
 * can submit a prompt without first exercising the session controls.
 */
export async function createPiFixture(
	options: PiFixtureOptions = {},
): Promise<PiFixture> {
	const testRoot = await openPiTestRoot();
	const { models, faux } = await offlineModels({
		contextWindow: options.contextWindow ?? 32768,
		maxTokens: options.maxTokens ?? 8192,
		...(options.tokensPerSecond === undefined
			? {}
			: { tokensPerSecond: options.tokensPerSecond }),
	});
	const host = await openPiRuntime({
		root: testRoot.root,
		store: testRoot.store,
		modelRuntime: models,
	});
	const engine = createPiConversation(host);
	try {
		const session = await engine.create(OFFLINE_MODEL);
		return {
			engine,
			host,
			modelRuntime: models,
			faux,
			store: testRoot.store,
			root: testRoot.root,
			home: testRoot.home,
			session,
			async close() {
				await engine.close();
				await host.close();
				await testRoot.close();
			},
		};
	} catch (error) {
		await host.close();
		await testRoot.close();
		throw error;
	}
}
