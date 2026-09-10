import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BrnError, isBrnError } from "../core/errors.ts";
import { logError, logInfo } from "./log.ts";
import {
	type RunningService,
	type ServiceComposition,
	startService,
} from "./start.ts";

const STATE_DIR_FLAG = "--state-dir";

/** Reads the one required argument. The path itself is validated where it is used. */
function parseStateDir(argv: readonly string[]): string {
	const flag = argv.indexOf(STATE_DIR_FLAG);
	const value = flag === -1 ? undefined : argv[flag + 1];
	if (value === undefined || value.length === 0) {
		throw new BrnError("INVALID_STATE_DIR", "missing");
	}
	return value;
}

/** Resolves once the service has shut down in response to a termination signal. */
async function runUntilSignalled(service: RunningService): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let stopping = false;
		const stop = (signal: NodeJS.Signals) => {
			if (stopping) return;
			stopping = true;
			logInfo("service.stopping", { signal });
			service.close().then(resolve, reject);
		};
		process.once("SIGINT", () => stop("SIGINT"));
		process.once("SIGTERM", () => stop("SIGTERM"));
	});
}

/**
 * Runs the service in the foreground until it is signalled, and resolves with the
 * process exit code. The service is started explicitly and never daemonises; a
 * client attaching to it cannot start or inherit it.
 */
export async function runService(
	argv: readonly string[],
	composition: ServiceComposition = {},
): Promise<number> {
	let service: RunningService;
	try {
		service = await startService({
			stateDir: parseStateDir(argv),
			...composition,
		});
	} catch (error) {
		logError("service.start_failed", {
			code: isBrnError(error) ? error.code : "INTERNAL_ERROR",
			reason: isBrnError(error) ? error.detail : undefined,
		});
		return 1;
	}
	// Readiness is reported only after discovery is published, so a parent that
	// sees this message can attach immediately.
	process.send?.({ type: "ready", host: service.host });
	try {
		await runUntilSignalled(service);
	} catch (error) {
		logError("service.shutdown_failed", {
			code: isBrnError(error) ? error.code : "INTERNAL_ERROR",
		});
		return 1;
	}
	logInfo("service.stopped");
	return 0;
}

// Guarded so test-only composition entries can import `runService` without
// starting a service as a side effect of the import.
const entryPoint = process.argv[1];
if (
	entryPoint !== undefined &&
	realpathSync(entryPoint) === fileURLToPath(import.meta.url)
) {
	process.exitCode = await runService(process.argv.slice(2));
}
