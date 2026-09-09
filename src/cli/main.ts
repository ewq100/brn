import { BrnError, isBrnError } from "../core/errors.ts";
// The absolute-state-directory rule has one definition, shared with the service
// so a client cannot be pointed at a directory the service would refuse.
import { requireAbsoluteStateDir } from "../service/ownership.ts";
import { type Client, connect, HealthResponse } from "./client.ts";

const STATE_DIR_FLAG = "--state-dir";
const SUPPORTED_COMMANDS = ["status"] as const;

interface Invocation {
	readonly stateDir: string;
	readonly command: string;
}

function parse(argv: readonly string[]): Invocation {
	const flag = argv.indexOf(STATE_DIR_FLAG);
	const stateDir = flag === -1 ? undefined : argv[flag + 1];
	if (stateDir === undefined || stateDir.length === 0) {
		throw new BrnError("INVALID_STATE_DIR", "missing");
	}
	requireAbsoluteStateDir(stateDir);
	const positional = argv.filter(
		(argument, index) =>
			index !== flag && index !== flag + 1 && !argument.startsWith("--"),
	);
	const command = positional[0];
	if (command === undefined) throw new BrnError("UNSUPPORTED_COMMAND");
	return { stateDir, command };
}

async function status(client: Client): Promise<void> {
	const health = await client.request("GET", "/v1/health", HealthResponse);
	process.stdout.write(
		`${health.status} host=${client.host} instance=${health.instanceId} pid=${health.pid}\n`,
	);
}

/**
 * Attaches to a running service and runs one command. Unsupported commands fail
 * loudly rather than returning a success-shaped placeholder.
 */
async function run(argv: readonly string[]): Promise<number> {
	try {
		const invocation = parse(argv);
		if (invocation.command !== "status")
			throw new BrnError("UNSUPPORTED_COMMAND");
		await status(await connect(invocation.stateDir));
		return 0;
	} catch (error) {
		const code = isBrnError(error) ? error.code : "INTERNAL_ERROR";
		const reason =
			isBrnError(error) && error.detail !== undefined
				? ` (${error.detail})`
				: "";
		process.stderr.write(`brn: ${code}${reason}\n`);
		if (code === "UNSUPPORTED_COMMAND") {
			process.stderr.write(
				`brn: supported commands: ${SUPPORTED_COMMANDS.join(", ")}\n`,
			);
		}
		return 1;
	}
}

process.exitCode = await run(process.argv.slice(2));
