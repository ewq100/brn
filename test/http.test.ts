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
	spawnServiceWithFake,
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
			ready: true,
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

		// `chat` is a real command now, so the loud-failure case uses a name that is
		// genuinely not a command.
		const unsupported = await runCli(["--state-dir", root, "teleport"]);
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

test("a disconnected submitter does not cancel accepted work", async () => {
	const service = await spawnServiceWithFake();
	try {
		const accepted = await service.client.submit(
			service.prompt("slow synthetic"),
		);
		await service.client.disconnect();
		await service.completeFake("saved once");
		const reconnected = await service.reconnect();
		expect((await reconnected.operation(accepted.id)).state).toBe("succeeded");
		expect(await reconnected.result(accepted.id)).toEqual({
			text: "saved once",
			truncated: false,
		});
		expect(await service.fakeCallCount()).toBe(1);
	} finally {
		await service.close();
	}
});

test("a lost submission response is recovered by repeating the identical request", async () => {
	const service = await spawnServiceWithFake();
	try {
		const command = service.prompt("only once");
		const body = JSON.stringify(command);
		const first = await service.service.request("/v1/operations", { body });
		expect(first.status).toBe(202);
		// The client never saw that response and repeats the identical request.
		const repeated = await service.service.request("/v1/operations", { body });
		expect(repeated.status).toBe(200);
		expect(JSON.parse(repeated.text).id).toBe(JSON.parse(first.text).id);

		const changed = await service.service.request("/v1/operations", {
			body: JSON.stringify({ ...command, text: "something else" }),
		});
		expect(changed.status).toBe(409);
		expect(JSON.parse(changed.text).error.code).toBe("REQUEST_ID_REUSED");

		await service.completeFake("only once");
		expect(await service.fakeCallCount()).toBe(1);
		// The changed payload mutated nothing: the original record still stands.
		const original = await service.client.operation(command.requestId);
		expect(original.state).toBe("succeeded");
	} finally {
		await service.close();
	}
});

test("submission rejects a malformed, oversized or unsupported body", async () => {
	const service = await spawnServiceWithFake();
	try {
		const command = service.prompt("ok");
		const cases: readonly {
			readonly name: string;
			readonly status: number;
			readonly options: RequestOptions;
		}[] = [
			{
				name: "malformed JSON",
				status: 400,
				options: { body: "{" },
			},
			{
				name: "an extra field",
				status: 400,
				options: { body: JSON.stringify({ ...command, extra: true }) },
			},
			{
				name: "a non-UUID request id",
				status: 400,
				options: { body: JSON.stringify({ ...command, requestId: "1" }) },
			},
			{
				name: "an empty prompt",
				status: 400,
				options: { body: JSON.stringify({ ...command, text: "" }) },
			},
			{
				name: "an unsupported content type",
				status: 400,
				options: { body: JSON.stringify(command), contentType: "text/plain" },
			},
			{
				name: "no content type",
				status: 400,
				options: { body: JSON.stringify(command), contentType: null },
			},
			{
				name: "invalid UTF-8",
				status: 400,
				options: {
					// `{"a":"<0x80>"}`: a lone continuation byte, which strict decoding
					// must refuse instead of substituting.
					body: new Uint8Array([
						0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d,
					]),
				},
			},
			{
				name: "an oversized declared length",
				status: 413,
				options: { body: `{"pad":"${"a".repeat(200 * 1024)}"}` },
			},
			{
				name: "an oversized chunked body",
				status: 413,
				options: {
					body: `{"pad":"${"a".repeat(200 * 1024)}"}`,
					chunked: true,
				},
			},
			{
				name: "a prompt whose bytes exceed the limit",
				status: 413,
				options: {
					// Inside the schema's character limit, over the UTF-8 byte limit.
					body: JSON.stringify({ ...command, text: "\u00e9".repeat(16000) }),
				},
			},
			{
				name: "an oversize ASCII prompt",
				status: 413,
				options: {
					// The common case: one byte per character, well past the prompt
					// limit and well inside the body ceiling. It is too large, not
					// malformed, so the operator is told to shorten it.
					body: JSON.stringify({ ...command, text: "a".repeat(20000) }),
				},
			},
		];
		for (const testCase of cases) {
			const response = await service.service.request(
				"/v1/operations",
				testCase.options,
			);
			expect(
				{ name: testCase.name, status: response.status },
				testCase.name,
			).toEqual({ name: testCase.name, status: testCase.status });
			expect(response.text).not.toContain(service.root);
		}
		expect(await service.fakeCallCount()).toBe(0);
	} finally {
		await service.close();
	}
});

test("the coordinated routes report models, sessions and busy work", async () => {
	const service = await spawnServiceWithFake();
	try {
		const models = await service.service.request("/v1/models");
		expect(models.status).toBe(200);
		expect(JSON.parse(models.text)).toEqual({
			models: [{ provider: "test", id: "offline" }],
		});

		const sessions = await service.service.request("/v1/sessions");
		expect(sessions.status).toBe(200);
		expect(JSON.parse(sessions.text).sessions).toEqual([
			{ id: "session-1", model: { provider: "test", id: "offline" } },
		]);

		const accepted = await service.client.submit(service.prompt("occupying"));
		// One accepted operation at a time: everything that needs the seat is
		// refused visibly rather than queued.
		expect(
			(
				await service.service.request("/v1/sessions", {
					body: JSON.stringify({ model: { provider: "test", id: "offline" } }),
				})
			).status,
		).toBe(409);
		expect(
			(
				await service.service.request("/v1/model", {
					body: JSON.stringify({ model: { provider: "test", id: "offline" } }),
				})
			).status,
		).toBe(409);
		expect(
			(
				await service.service.request("/v1/sessions/resume", {
					body: JSON.stringify({ sessionId: "session-1" }),
				})
			).status,
		).toBe(409);
		const second = await service.service.request("/v1/operations", {
			body: JSON.stringify(service.prompt("second")),
		});
		expect(second.status).toBe(409);
		expect(JSON.parse(second.text).error.code).toBe("BUSY");
		// A result is not readable until the work it belongs to settles.
		expect(
			(await service.service.request(`/v1/operations/${accepted.id}/result`))
				.status,
		).toBe(409);

		await service.completeFake("done");
		expect((await service.client.operation(accepted.id)).state).toBe(
			"succeeded",
		);
		expect(await service.client.result(accepted.id)).toEqual({
			text: "done",
			truncated: false,
		});
	} finally {
		await service.close();
	}
});

test("a session or model change takes the control seat and reports the seated session", async () => {
	const service = await spawnServiceWithFake();
	try {
		const created = await service.service.request("/v1/sessions", {
			body: JSON.stringify({ model: { provider: "test", id: "offline" } }),
		});
		expect(created.status).toBe(201);
		expect(JSON.parse(created.text)).toEqual({
			id: "session-2",
			model: { provider: "test", id: "offline" },
		});

		const resumed = await service.service.request("/v1/sessions/resume", {
			body: JSON.stringify({ sessionId: "session-1" }),
		});
		expect(resumed.status).toBe(200);
		expect(JSON.parse(resumed.text).id).toBe("session-1");

		const selected = await service.service.request("/v1/model", {
			body: JSON.stringify({ model: { provider: "test", id: "offline" } }),
		});
		expect(selected.status).toBe(200);
		expect(JSON.parse(selected.text).model).toEqual({
			provider: "test",
			id: "offline",
		});

		// A session identifier is opaque and bounded: BRN passes it to the
		// conversation host as data, and never resolves it as a path here. The
		// deterministic engine echoes it back unchanged, which is the point.
		const traversal = await service.service.request("/v1/sessions/resume", {
			body: JSON.stringify({ sessionId: "../../etc/passwd" }),
		});
		expect(traversal.status).toBe(200);
		expect(JSON.parse(traversal.text).id).toBe("../../etc/passwd");

		// Bounded: an identifier longer than the contract allows is malformed input.
		const oversized = await service.service.request("/v1/sessions/resume", {
			body: JSON.stringify({ sessionId: "s".repeat(257) }),
		});
		expect(oversized.status).toBe(400);
	} finally {
		await service.close();
	}
});

test("an unknown operation is not found and a stale session mismatch is a conflict", async () => {
	const service = await spawnServiceWithFake();
	try {
		const unknown = "00000000-0000-4000-8000-0000000000ff";
		expect(
			(await service.service.request(`/v1/operations/${unknown}`)).status,
		).toBe(404);
		expect(
			(await service.service.request(`/v1/operations/${unknown}/result`))
				.status,
		).toBe(404);
		expect(
			(
				await service.service.request(`/v1/operations/${unknown}/cancel`, {
					body: JSON.stringify({ confirmed: true }),
				})
			).status,
		).toBe(404);
		// An identifier that is not even shaped like one is malformed input.
		expect(
			(await service.service.request("/v1/operations/not-an-id")).status,
		).toBe(400);

		const mismatch = await service.service.request("/v1/operations", {
			body: JSON.stringify(
				service.prompt("wrong session", {
					sessionId: "session-9",
				}),
			),
		});
		expect(mismatch.status).toBe(409);
		expect(JSON.parse(mismatch.text).error.code).toBe("SESSION_MISMATCH");

		const wrongModel = await service.service.request("/v1/operations", {
			body: JSON.stringify(
				service.prompt("wrong model", {
					model: { provider: "test", id: "other" },
				}),
			),
		});
		expect(wrongModel.status).toBe(409);
		expect(JSON.parse(wrongModel.text).error.code).toBe("MODEL_MISMATCH");
	} finally {
		await service.close();
	}
});

test("a run that needs credentials is a precondition the operator must satisfy", async () => {
	const service = await spawnServiceWithFake();
	try {
		const accepted = await service.client.submit(service.prompt("who am i"));
		await service.failFake(undefined, "AUTH_REQUIRED");
		expect((await service.client.operation(accepted.id)).state).toBe("failed");
		const result = await service.service.request(
			`/v1/operations/${accepted.id}/result`,
		);
		// A conflict, like a missing model: absent credentials are not corrupt or
		// unavailable state, and no message beyond the fixed status text is sent.
		expect(result.status).toBe(409);
		expect(JSON.parse(result.text)).toEqual({
			error: { code: "AUTH_REQUIRED", message: "Conflict" },
		});
	} finally {
		await service.close();
	}
});

test("cancellation is explicit and repeating it is harmless", async () => {
	const service = await spawnServiceWithFake();
	try {
		const accepted = await service.client.submit(service.prompt("cancel me"));
		const unconfirmed = await service.service.request(
			`/v1/operations/${accepted.id}/cancel`,
			{ body: JSON.stringify({ confirmed: false }) },
		);
		expect(unconfirmed.status).toBe(400);

		const cancelled = await service.service.request(
			`/v1/operations/${accepted.id}/cancel`,
			{ body: JSON.stringify({ confirmed: true }) },
		);
		expect(cancelled.status).toBe(200);
		expect(JSON.parse(cancelled.text).state).toBe("cancelled");

		const again = await service.service.request(
			`/v1/operations/${accepted.id}/cancel`,
			{ body: JSON.stringify({ confirmed: true }) },
		);
		expect(again.status).toBe(200);
		expect(JSON.parse(again.text).state).toBe("cancelled");
	} finally {
		await service.close();
	}
});

test("shutdown stops accepted work, records it and releases ownership last", async () => {
	const service = await spawnServiceWithFake();
	const accepted = await service.client.submit(service.prompt("still running"));
	await service.service.fake({ action: "awaitRunning" });

	// The whole chain runs here: the coordinator stops accepted work, the engine
	// and its host close, the ledger closes, and only then is ownership released.
	service.service.signal("SIGTERM");
	expect(await service.service.exit).toBe(0);
	await service.client.disconnect();

	// A second owner can only start because the lock was released, and it can only
	// read this outcome because the ledger committed before it closed.
	const restarted = await spawnServiceWithFake({ root: service.root });
	try {
		const settled = await restarted.client.operation(accepted.id);
		expect(settled.state).toBe("cancelled");
		expect(restarted.service.output()).not.toContain("shutdown_failed");
	} finally {
		await restarted.close();
	}
});
