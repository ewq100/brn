import { chmod, mkdtemp, realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { sendError } from "../src/service/http.ts";
import {
	type Discovery,
	differentTokenOfSameLength,
	type RequestOptions,
	readDiscovery,
	runCli,
	type ServiceHandle,
	spawnService,
} from "./support/process.ts";

async function makeRoot(prefix: string): Promise<string> {
	return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

test("health is not an unauthenticated information endpoint", async () => {
	const root = await makeRoot("brn-auth-");
	const service = await spawnService(root);
	try {
		expect((await service.request("/v1/health")).status).toBe(200);
		expect((await service.request("/v1/health", { auth: false })).status).toBe(
			401,
		);
		expect(
			(
				await service.request("/v1/health", {
					headers: { Origin: "https://hostile.example" },
				})
			).status,
		).toBe(403);
	} finally {
		await service.close();
	}
});

interface HeaderCase {
	readonly name: string;
	readonly status: number;
	readonly options: (discovery: Discovery) => RequestOptions;
}

const headerCases: readonly HeaderCase[] = [
	{ name: "the exact expected Host", status: 200, options: () => ({}) },
	{
		name: "a hostname Host that is not the bound authority",
		status: 403,
		options: () => ({ host: "brn.local" }),
	},
	{
		name: "a Host naming the right port on the wrong interface",
		status: 403,
		options: (discovery) => ({
			host: discovery.host.replace("127.0.0.1", "localhost"),
		}),
	},
	{
		name: "an Origin of null",
		status: 403,
		options: () => ({ headers: { Origin: "null" } }),
	},
	{
		name: "an Origin echoing the loopback authority",
		status: 403,
		options: (discovery) => ({
			headers: { Origin: `http://${discovery.host}` },
		}),
	},
	{
		name: "no Authorization header",
		status: 401,
		options: () => ({ auth: false }),
	},
	{
		name: "a wrong token of the expected length",
		status: 401,
		options: (discovery) => ({
			token: differentTokenOfSameLength(discovery.token),
		}),
	},
	{
		name: "a truncated token",
		status: 401,
		options: (discovery) => ({ token: discovery.token.slice(0, -1) }),
	},
	{
		name: "an empty bearer token",
		status: 401,
		options: () => ({ headers: { Authorization: "Bearer " } }),
	},
	{
		name: "a non-bearer authorization scheme",
		status: 401,
		options: (discovery) => ({
			headers: { Authorization: `Basic ${discovery.token}` },
		}),
	},
	{
		name: "a token supplied in the query string instead of a header",
		status: 401,
		options: (discovery) => ({
			auth: false,
			query: `?token=${discovery.token}`,
		}),
	},
];

for (const headerCase of headerCases) {
	test(`GET /v1/health with ${headerCase.name}`, async () => {
		const root = await makeRoot("brn-headers-");
		const service = await spawnService(root);
		try {
			const discovery = await readDiscovery(root);
			const response = await service.request(
				"/v1/health",
				headerCase.options(discovery),
			);
			expect(response.status).toBe(headerCase.status);
			expect(response.text).not.toContain(discovery.token);
		} finally {
			await service.close();
		}
	});
}

test("duplicate Host and Authorization headers are rejected", async () => {
	const root = await makeRoot("brn-dup-");
	const service = await spawnService(root);
	try {
		const discovery = await readDiscovery(root);
		const duplicateAuthorization = await service.rawRequest([
			"GET /v1/health HTTP/1.1",
			`Host: ${discovery.host}`,
			`Authorization: Bearer ${discovery.token}`,
			`Authorization: Bearer ${discovery.token}`,
			"Connection: close",
		]);
		expect(duplicateAuthorization.status).toBe(401);
		expect(duplicateAuthorization.raw).not.toContain(root);

		const duplicateHost = await service.rawRequest([
			"GET /v1/health HTTP/1.1",
			`Host: ${discovery.host}`,
			"Host: brn.local",
			`Authorization: Bearer ${discovery.token}`,
			"Connection: close",
		]);
		// Node's parser joins duplicated Host headers rather than rejecting them, so
		// the raw-header count is what stops a smuggled second authority.
		expect(duplicateHost.status).toBe(401);
		expect(duplicateHost.raw).not.toContain(discovery.token);
	} finally {
		await service.close();
	}
});

test("an absolute-form request target is not routed", async () => {
	const root = await makeRoot("brn-absform-");
	const service = await spawnService(root);
	try {
		const discovery = await readDiscovery(root);
		const response = await service.rawRequest([
			`GET http://${discovery.host}/v1/health HTTP/1.1`,
			`Host: ${discovery.host}`,
			`Authorization: Bearer ${discovery.token}`,
			"Connection: close",
		]);
		expect(response.status).toBe(404);
	} finally {
		await service.close();
	}
});

test("an authenticated health response is minimal, uncacheable and CORS-free", async () => {
	const root = await makeRoot("brn-headers2-");
	const service = await spawnService(root);
	try {
		const discovery = await readDiscovery(root);
		const response = await service.request("/v1/health");
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe(
			"application/json; charset=utf-8",
		);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		for (const name of Object.keys(response.headers)) {
			expect(name.startsWith("access-control-")).toBe(false);
		}
		expect(JSON.parse(response.text)).toEqual({
			status: "ok",
			version: 1,
			instanceId: discovery.instanceId,
			pid: discovery.pid,
		});
	} finally {
		await service.close();
	}
});

test("unknown routes and methods are not found", async () => {
	const root = await makeRoot("brn-routes-");
	const service = await spawnService(root);
	try {
		expect((await service.request("/v1/nope")).status).toBe(404);
		expect((await service.request("/")).status).toBe(404);
		expect(
			(await service.request("/v1/health", { method: "POST" })).status,
		).toBe(404);
		expect(
			(await service.request("/v1/health", { query: "?verbose=1" })).status,
		).toBe(404);
	} finally {
		await service.close();
	}
});

test("a token from a previous instance no longer authenticates", async () => {
	const root = await makeRoot("brn-rotate-");
	const first = await spawnService(root);
	const stale = (await readDiscovery(root)).token;
	await first.close();

	const second = await spawnService(root);
	try {
		const fresh = await readDiscovery(root);
		expect(fresh.token).not.toBe(stale);
		expect((await second.request("/v1/health", { token: stale })).status).toBe(
			401,
		);
		expect((await second.request("/v1/health")).status).toBe(200);
	} finally {
		await second.close();
	}
});

test("stale discovery fails fast instead of hanging the client", async () => {
	const root = await makeRoot("brn-cli-stale-");
	const service = await spawnService(root);
	service.signal("SIGKILL");
	await service.exit;
	const result = await runCli(["--state-dir", root, "status"]);
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("SERVICE_UNREACHABLE");
});

test("the CLI attaches over authenticated loopback and prints status", async () => {
	const root = await makeRoot("brn-cli-");
	const service: ServiceHandle = await spawnService(root);
	try {
		const status = await runCli(["--state-dir", root, "status"]);
		expect(status.code).toBe(0);
		expect(status.output).toContain("ok");
		expect(status.output).not.toContain((await readDiscovery(root)).token);

		const unsupported = await runCli(["--state-dir", root, "chat"]);
		expect(unsupported.code).not.toBe(0);
		expect(unsupported.output).toContain("UNSUPPORTED_COMMAND");

		const relative = await runCli(["--state-dir", "state", "status"]);
		expect(relative.code).not.toBe(0);
		expect(relative.output).toContain("INVALID_STATE_DIR");
	} finally {
		await service.close();
	}
});

test("the CLI refuses a permissive discovery document", async () => {
	const root = await makeRoot("brn-cli-perm-");
	const service = await spawnService(root);
	try {
		await chmod(join(root, "discovery.json"), 0o644);
		const result = await runCli(["--state-dir", root, "status"]);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("INSECURE_DISCOVERY");
	} finally {
		await service.close();
	}
});

test("the CLI refuses to attach when no service is running", async () => {
	const root = await makeRoot("brn-cli-none-");
	const result = await runCli(["--state-dir", root, "status"]);
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("NO_SERVICE");
});

test("an unmapped internal fault is opaque on the wire but logged", () => {
	const written: string[] = [];
	const realWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;

	let status = 0;
	let body = "";
	const response = {
		writeHead(code: number) {
			status = code;
			return response;
		},
		end(chunk?: string) {
			body = chunk ?? "";
		},
	};
	try {
		sendError(
			response as unknown as ServerResponse,
			new Error("secret detail /Users/someone/.brn/default"),
		);
	} finally {
		process.stderr.write = realWrite;
	}

	expect(status).toBe(500);
	expect(body).toContain("INTERNAL_ERROR");
	expect(body).not.toContain("secret detail");
	const log = written.join("");
	expect(log).toContain("http.internal_error");
	expect(log).toContain("UNMAPPED_EXCEPTION");
	// The log line carries a fixed code only: no message, path, token or PID.
	expect(log).not.toContain("secret detail");
	expect(log).not.toContain(".brn/default");
});
