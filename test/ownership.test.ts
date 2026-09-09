import { existsSync, lstatSync } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	open,
	realpath,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { proveFts5 } from "../src/service/sqlite.ts";
import { spawnService } from "./support/process.ts";

async function makeRoot(prefix: string): Promise<string> {
	return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

test("a live but stopped owner prevents a second writer", async () => {
	const root = await makeRoot("brn-owner-");
	const first = await spawnService(root);
	try {
		first.signal("SIGSTOP");
		const second = await spawnService(root, { expectReady: false });
		expect(await second.exit).not.toBe(0);
		expect(second.output()).toContain("ALREADY_RUNNING");
	} finally {
		first.signal("SIGCONT");
		await first.close();
	}
});

test("two simultaneous starts leave exactly one owner", async () => {
	const root = await makeRoot("brn-race-");
	const [a, b] = await Promise.all([
		spawnService(root, { expectReady: false }),
		spawnService(root, { expectReady: false }),
	]);
	try {
		const loser = await Promise.race([
			a.exit.then(() => a),
			b.exit.then(() => b),
		]);
		const winner = loser === a ? b : a;
		expect(await loser.exit).not.toBe(0);
		expect(loser.output()).toContain("ALREADY_RUNNING");
		await winner.ready;
		expect((await winner.request("/v1/health")).status).toBe(200);
	} finally {
		await Promise.all([a.close(), b.close()]);
	}
});

test("a killed owner leaves ownership reclaimable without deleting state", async () => {
	const root = await makeRoot("brn-stale-");
	const first = await spawnService(root);
	first.signal("SIGKILL");
	await first.exit;
	// The dead owner's discovery document is still on disk and must not be trusted
	// as evidence of a live owner, nor deleted by anyone but its own instance.
	expect(existsSync(join(root, "discovery.json"))).toBe(true);
	expect(existsSync(join(root, "writer.sqlite"))).toBe(true);

	const second = await spawnService(root);
	try {
		expect((await second.request("/v1/health")).status).toBe(200);
	} finally {
		await second.close();
	}
	// Releasing ownership never unlinks the writer database.
	expect(existsSync(join(root, "writer.sqlite"))).toBe(true);
});

test("a clean shutdown exits zero and removes only its own discovery file", async () => {
	const root = await makeRoot("brn-shutdown-");
	const service = await spawnService(root);
	expect(existsSync(join(root, "discovery.json"))).toBe(true);
	service.signal("SIGTERM");
	expect(await service.exit).toBe(0);
	expect(existsSync(join(root, "discovery.json"))).toBe(false);
	expect(existsSync(join(root, "writer.sqlite"))).toBe(true);
});

test("managed files are created with owner-only permissions", async () => {
	const root = await makeRoot("brn-modes-");
	const service = await spawnService(root);
	try {
		for (const name of ["writer.sqlite", "discovery.json"]) {
			const stats = lstatSync(join(root, name));
			expect(stats.isFile()).toBe(true);
			expect(stats.nlink).toBe(1);
			expect(stats.mode & 0o777).toBe(0o600);
		}
	} finally {
		await service.close();
	}
});

interface RejectionCase {
	readonly name: string;
	readonly reason: string;
	readonly prepare: (root: string) => Promise<string>;
}

const rejectionCases: readonly RejectionCase[] = [
	{
		name: "a relative state directory",
		reason: "not_absolute",
		prepare: async () => "relative/state",
	},
	{
		name: "a symlinked state directory",
		reason: "symlink",
		prepare: async (root) => {
			const target = join(root, "real");
			const linkPath = join(root, "link");
			await mkdir(target, { mode: 0o700 });
			await symlink(target, linkPath);
			return linkPath;
		},
	},
	{
		name: "a state directory reached through a symlinked parent",
		reason: "symlink",
		prepare: async (root) => {
			const target = join(root, "real");
			await mkdir(join(target, "state"), { recursive: true, mode: 0o700 });
			await symlink(target, join(root, "link"));
			return join(root, "link", "state");
		},
	},
	{
		name: "a state directory whose parent does not exist",
		reason: "missing_parent",
		prepare: async (root) => join(root, "absent", "child"),
	},
	{
		name: "a group- or world-accessible state directory",
		reason: "mode",
		prepare: async (root) => {
			const target = join(root, "open");
			await mkdir(target, { mode: 0o700 });
			await chmod(target, 0o755);
			return target;
		},
	},
	{
		name: "a state directory that is not a directory",
		reason: "not_directory",
		prepare: async (root) => {
			const target = join(root, "file");
			const handle = await open(target, "wx", 0o600);
			await handle.close();
			return target;
		},
	},
	{
		name: "a permissive managed file",
		reason: "mode",
		prepare: async (root) => {
			const target = join(root, "permissive");
			await mkdir(target, { mode: 0o700 });
			const handle = await open(join(target, "writer.sqlite"), "wx", 0o600);
			await handle.close();
			await chmod(join(target, "writer.sqlite"), 0o644);
			return target;
		},
	},
	{
		name: "a hard-linked managed file",
		reason: "hard_link",
		prepare: async (root) => {
			const target = join(root, "hardlink");
			await mkdir(target, { mode: 0o700 });
			const managed = join(target, "writer.sqlite");
			const handle = await open(managed, "wx", 0o600);
			await handle.close();
			await link(managed, join(root, "shadow.sqlite"));
			return target;
		},
	},
	{
		name: "a symlinked managed file",
		reason: "symlink",
		prepare: async (root) => {
			const target = join(root, "symlinked");
			await mkdir(target, { mode: 0o700 });
			const decoy = join(root, "decoy.sqlite");
			const handle = await open(decoy, "wx", 0o600);
			await handle.close();
			await symlink(decoy, join(target, "writer.sqlite"));
			return target;
		},
	},
];

for (const rejection of rejectionCases) {
	test(`startup refuses ${rejection.name}`, async () => {
		const root = await makeRoot("brn-reject-");
		const stateDir = await rejection.prepare(root);
		const service = await spawnService(root, { expectReady: false, stateDir });
		expect(await service.exit).not.toBe(0);
		expect(service.output()).toContain("INVALID_STATE_DIR");
		expect(service.output()).toContain(rejection.reason);
	});
}

test("a state directory with a missing parent is refused, and no parent is created", async () => {
	const root = await makeRoot("brn-missing-parent-");
	const service = await spawnService(root, {
		expectReady: false,
		stateDir: join(root, "absent", "child"),
	});
	expect(await service.exit).not.toBe(0);
	expect(service.output()).toContain("INVALID_STATE_DIR");
	// A distinct reason from `unusable_parent`: the operator can act on it, and
	// creating the intermediate chain is state they never asked for.
	expect(service.output()).toContain("missing_parent");
	expect(existsSync(join(root, "absent"))).toBe(false);
});

test("a refused state directory is not created", async () => {
	const root = await makeRoot("brn-nocreate-");
	await mkdir(join(root, "real"), { mode: 0o700 });
	await symlink(join(root, "real"), join(root, "link"));
	const service = await spawnService(root, {
		expectReady: false,
		stateDir: join(root, "link", "fresh"),
	});
	expect(await service.exit).not.toBe(0);
	expect(service.output()).toContain("symlink");
	expect(existsSync(join(root, "real", "fresh"))).toBe(false);
});

const foreignRoot = "/private/var/root";
const foreignIsUsable =
	existsSync(foreignRoot) && lstatSync(foreignRoot).uid !== process.getuid?.();

test.skipIf(!foreignIsUsable)(
	"startup refuses a state directory owned by another user",
	async () => {
		const root = await makeRoot("brn-foreign-");
		const service = await spawnService(root, {
			expectReady: false,
			stateDir: foreignRoot,
		});
		expect(await service.exit).not.toBe(0);
		expect(service.output()).toContain("INVALID_STATE_DIR");
		expect(service.output()).toContain("owner");
	},
);

test("the pinned SQLite build provides full-text search", () => {
	expect(() => proveFts5()).not.toThrow();
});
