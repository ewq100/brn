/**
 * The only resources a BRN conversation is allowed to see.
 *
 * BRN hosts the Pi SDK inside its own service, so nothing about the machine's
 * personal Pi installation may leak into a hosted conversation: no ambient
 * `AGENTS.md`, no user settings, no skills, prompts, themes, extensions or
 * packages. `DefaultResourceLoader` exists to discover exactly those things, so
 * BRN never uses it. This loader answers every discovery question with "nothing",
 * which is the whole point: the empty methods implement the SDK's contract and
 * are not placeholders for future BRN tools.
 */

import {
	createExtensionRuntime,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/**
 * The one instruction BRN supplies. It states the absence of tools so a model
 * cannot describe filesystem or vault work it has no way of performing.
 */
export const BRN_SYSTEM_PROMPT =
	"You are BRN's conversational assistant. No vault or filesystem tools " +
	"are available. Do not claim to read, save, approve, or publish files.";

/** Builds the controlled loader. Every conversation in a process shares one. */
export function createControlledResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		}),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => BRN_SYSTEM_PROMPT,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}
