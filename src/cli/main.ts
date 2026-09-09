import { BrnError } from "../core/errors.ts";
// The absolute-state-directory rule has one definition, shared with the service
// so a client cannot be pointed at a directory the service would refuse.
import { requireAbsoluteStateDir } from "../service/ownership.ts";
import { type Client, connect } from "./client.ts";
import { describeFailure, runCommand } from "./commands.ts";
import { runTerminal } from "./terminal.ts";

const STATE_DIR_FLAG = "--state-dir";

interface Invocation {
	readonly stateDir: string;
	/** Everything after the global flag, passed through to the shared command layer. */
	readonly args: readonly string[];
}

/**
 * Reads the one global flag and leaves the rest alone.
 *
 * The command and its own options are parsed by the shared command layer, so a
 * command's arguments have exactly one definition.
 */
function parse(argv: readonly string[]): Invocation {
	const flag = argv.indexOf(STATE_DIR_FLAG);
	const stateDir = flag === -1 ? undefined : argv[flag + 1];
	if (stateDir === undefined || stateDir.length === 0) {
		throw new BrnError("INVALID_STATE_DIR", "missing");
	}
	requireAbsoluteStateDir(stateDir);
	const args = argv.filter(
		(_argument, index) => index !== flag && index !== flag + 1,
	);
	if (args.length === 0) throw new BrnError("UNSUPPORTED_COMMAND", "empty");
	return { stateDir, args };
}

function fail(error: unknown, stateDir: string): number {
	process.stderr.write(`${describeFailure(error, stateDir)}\n`);
	return 1;
}

/**
 * Attaches to a running service and runs one command.
 *
 * It never starts a service: a missing one is reported with the command that
 * would start it. Exiting closes this client's own connections and nothing else.
 */
async function run(argv: readonly string[]): Promise<number> {
	const flag = argv.indexOf(STATE_DIR_FLAG);
	// Only for the failure message, before the path has been validated.
	const requested = (flag === -1 ? undefined : argv[flag + 1]) ?? "";
	let invocation: Invocation;
	try {
		invocation = parse(argv);
	} catch (error) {
		return fail(error, requested);
	}
	let client: Client;
	try {
		client = await connect(invocation.stateDir);
	} catch (error) {
		return fail(error, invocation.stateDir);
	}
	try {
		await runCommand(invocation.args, client, {
			write(text: string) {
				process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
			},
			chat: async () => {
				await runTerminal(client);
			},
		});
		return 0;
	} catch (error) {
		return fail(error, invocation.stateDir);
	} finally {
		// Closes this client's sockets. It stops no operation and no service.
		await client.disconnect();
	}
}

process.exitCode = await run(process.argv.slice(2));
