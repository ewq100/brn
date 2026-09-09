# Capability A: Service and Terminal Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an independently started, authenticated foreground BRN process and a small terminal conversation client, with isolated Pi sessions, recoverable operations, and no model-accessible filesystem capabilities.

**Architecture:** A process-ownership module acquires a kernel-backed SQLite lock before opening mutable application state. A single-operation coordinator combines an authoritative SQLite operation ledger with a controlled Pi adapter; native Pi sessions remain the only conversation store. Both interactive and one-shot terminal commands use the same bounded HTTP/SSE interface, with snapshot-first reconnection rather than durable event replay.

**Tech Stack:** Node `24.20.0`, npm `11.19.0`, TypeScript `7.0.2`, strict ESM, Pi `0.85.1`, TypeBox `1.3.7`, `node:http`, `node:sqlite`, Pi's main-screen terminal primitives, Vitest, and Biome. Install the remaining exact dependencies selected in #40 without creating unused browser entry points.

**Spec:** [docs/brn-plan.md](../../brn-plan.md), especially Capability A, D1/D2/D8/D10, and delivery milestone 1; [#41](https://github.com/EvoKessler_ericcp/brn/issues/41) governs A where older issues conflict; [#40](https://github.com/EvoKessler_ericcp/brn/issues/40) supplies exact pins. Read all three before executing. The A-specific decisions below were explicitly approved during this planning conversation.

## Global Constraints

The following requirements are copied from the governing specification:

- "One private strict-ESM TypeScript package."
- "Retain the exact Node, npm, Pi and dependency pins in #40 and commit a lockfile."
- "Start and stop the foreground service explicitly."
- "Clients attach but do not implicitly spawn or inherit service ownership."
- "Bind to `127.0.0.1` on a dynamic port."
- "Authenticate every HTTP and SSE endpoint, require the exact Host, reject inappropriate Origins, and emit no CORS grants."
- "Tokens stay out of URLs and logs."
- "Acquire single-writer protection before opening writable Pi sessions or BRN state."
- "Use public SDK APIs; clients never open session files or submit session-file paths."
- "No competing Pi JSONL parser or conversation store."
- "One accepted agent operation at a time."
- "Reject busy work visibly rather than queuing it."
- "Same ID and same payload identifies the original operation; changed payload fails without mutation."
- "Client disconnect does not cancel accepted work."
- "Restart reports interrupted operations and does not automatically replay provider requests."
- "Authoritative BRN SQLite state is not disposable."
- "Register no future stub tools."
- "Operational logs must not contain prompts, responses or secrets."
- "Keep fake-based tests, real-SDK offline checks and the separately authorized provider evidence distinct."
- Runtime files: Node `24.20.0`, npm `11.19.0`, TypeScript `7.0.2`; `engines.node: ">=24.20 <25"`; `packageManager: "npm@11.19.0"`.
- No Pi fork, private-method access, `InteractiveMode`, RPC passthrough, raw database tool, shell tool, filesystem tool, canonical operation, Worker, browser entry point, or daemon.

---

## Execution authorization and current checkout

This is a documentation deliverable, not permission to start implementation or make a provider request. The user approved this written design as the basis for an A-only plan, reuse of existing Pi credentials, the provider policy below, the main-screen editor, and recording these details here without another design document.

The inspected checkout has no package manifest, lockfile, production source, or test runner. It has a one-line `README.md`, specifications, and HTML prototypes. The inspected HEAD is `c66e9da`. Existing edits to `CONTEXT.md` and `docs/product-spec.md`, and untracked instructions/research files, belong to other work: preserve them.

#41 already amends the affected GitHub scope. Local governing-document alignment must be reconciled before coding: the inspected product specification and glossary still contain older scope. Do not silently rewrite them or treat this plan as their replacement. Ask for authorization if alignment is still outstanding. Do not create GitHub child issues, change labels, commit existing user edits, push, merge, or migrate data as a side effect of executing a plan step. #41 requires implementation children before coding; publish the task decomposition only when that GitHub action is authorized.

At execution time, use the `using-git-worktrees` skill to obtain an isolated checkout. Record which approved specification revision it contains. Carry the approved plan into that checkout without copying unrelated dirty files. Do not install dependencies or open a provider connection merely to review this document.

## Approved A decisions

| Concern | Decision |
|---|---|
| Credentials | Reuse Pi's normal `auth.json` through Pi's credential implementation. Do not read, copy, serialize, print, or maintain it in BRN code. |
| Isolation | A dedicated BRN state root owns sessions and an empty working directory. Use in-memory settings, `modelsPath: null`, and an explicit BRN resource loader. Ambient `models.json`, extensions, instructions, skills, packages, and settings are not loaded. |
| Model choice | Require an explicit authenticated provider/model for the first new conversation. Persist the last successfully selected default in BRN configuration; never silently fall back from an unavailable saved model. |
| Input | Maximum prompt is `16 * 1024` UTF-8 bytes. Validate bytes, not JavaScript string length. Images/attachments are not accepted in A. |
| Output | Request at most `4096` output tokens, further bounded by the selected model's declared maximum. Treat a `length` stop as completed-but-truncated, not a complete answer. |
| Deadline | At `120_000` ms, request cancellation and keep the operation occupied until Pi settles. This is a cancellation deadline, not a claim that an uncooperative provider has stopped billing. |
| Retries | Disable ordinary Pi retries and provider retries. Retain Pi's documented single context-overflow compact-and-retry path within the same deadline. Restart never retries a provider operation. |
| Compaction | Keep automatic Pi compaction. Show its events and unknown context honestly. Do not add a context estimator or forced handover. |
| Terminal | Use `TuiMainScreen`, `Editor`, `Text`, and `ProcessTerminal`; preserve ordinary scrollback. No alternate-screen panels or native Pi terminal bridge. |
| Ownership | Hold an exclusive transaction on a dedicated, never-replaced SQLite lock file for the process lifetime. Never reclaim ownership by deleting a lock/discovery file or assuming a PID is stale. |
| Operation state | Persist request identity, payload digest, state, outcome, usage, and native result references; do not duplicate conversation bodies in SQLite. |
| Reconnect | Every SSE connection begins with a current snapshot. Live events are instance-scoped and ephemeral. A reconnect never submits the prompt again. |

### Provider limits: what they mean

Pi's high-level `prompt()` has no caller-supplied token cap or abort signal. Configure bounded model metadata before each prompt, set retry settings explicitly, and own a timer that calls `session.abort()`. Confirm the production adapter passes the bounded model to `ModelRuntime.streamSimple`; the live proof verifies the selected provider actually respects the requested output size.

The `16 KiB` guard bounds newly submitted text, not the whole native conversation. Pi retains responsibility for its model context window and automatic compaction. This plan does **not** claim an exact serialized-input token limit, a hard monetary ceiling, or universal provider enforcement. Do not add a misleading estimate to the context display. Compaction can itself make paid calls; explain that before the live proof. Set compaction `reserveTokens: 5120` and `keepRecentTokens: 8192`, retaining the SDK's summary-generation logic rather than implementing another summarizer.

`retry.enabled: false` does not disable Pi's overflow-recovery retry. Throwing in `before_provider_request` is not a dispatch-denial mechanism: the extension runner can catch the exception and continue. Do not use that hook as a security or spending gate. If the selected provider cannot satisfy the agreed operating controls through supported interfaces, stop that provider proof and report the concrete incompatibility; do not patch Pi internals.

## File structure and module responsibilities

Use #40's source areas. Paths below are exact; all source/test files are new in the inspected checkout. Do not create empty files for later capabilities.

| Paths | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `.node-version`, `.gitignore`, `tsconfig.json`, `tsconfig.test.json`, `biome.json` | One-package toolchain, exact dependencies, compilation and existing selected runners |
| `src/protocol/contracts.ts` | Browser-safe TypeBox request/response/event schemas and inferred types |
| `src/core/errors.ts`, `src/core/conversation.ts` | Safe error codes, engine and ledger interfaces; no Node, Pi, transport, or storage imports |
| `src/core/operations.ts` | Single-operation admission, idempotency, cancellation, completion, shutdown policy |
| `src/service/ownership.ts`, `src/service/sqlite.ts` | Owner-only roots, kernel-held process lock, pinned SQLite configuration and FTS5 probe |
| `src/service/operation-store.ts` | Versioned authoritative operation/control metadata; no transcript bodies |
| `src/service/pi/resources.ts` | Explicit controlled instructions and empty tool/resource discovery |
| `src/service/pi/runtime.ts` | Shared model runtime, native session lifecycle and metadata, subscription replacement |
| `src/service/pi/conversation.ts` | BRN/Pi translation, prompt outcomes, usage, limits, native-result durability |
| `src/service/http.ts`, `src/service/events.ts`, `src/service/log.ts` | Authenticated route dispatch, snapshot-first SSE, safe operational logging |
| `src/service/start.ts`, `src/service/main.ts` | Ordered process composition and foreground lifetime |
| `src/cli/client.ts`, `src/cli/sse.ts` | Discovery validation, bounded HTTP, streaming decode and reconnection |
| `src/cli/commands.ts`, `src/cli/terminal.ts`, `src/cli/main.ts` | Shared command parsing, main-screen interaction, one-shot entry point |
| `test/support/fake-engine.ts` | Deterministic engine adapter; never loaded by the production entry point |
| `test/support/pi.ts` | Shared real-SDK fixture after Task 4 extracts the initially local fixture |
| `test/support/process.ts`, `test/support/service-child.ts` | Isolated spawned-process harness and test-only composition |
| `test/ownership.test.ts`, `test/operations.test.ts`, `test/operation-store.test.ts` | Ownership and durable operation tests |
| `test/pi-runtime.test.ts`, `test/pi-conversation.test.ts` | Real SDK plus official in-process faux provider |
| `test/http.test.ts`, `test/events.test.ts`, `test/cli.test.ts`, `test/terminal.test.ts` | Real route/client behavior and terminal mapping |
| `test/acceptance/service-terminal.test.ts` | Shared process lifetime, crash/reconnect and stopped-copy restoration journeys |
| `test/live/provider-chat.test.ts` | Explicitly gated synthetic provider proof, excluded from default runs |
| `README.md`, `docs/capability-a-operations.md` | Source-run commands, policy, state layout, limits, recovery and evidence instructions |

The engine seam is real: the deterministic fake and the Pi adapter both implement it. The ledger seam has a SQLite implementation; tests use that implementation in temporary roots instead of inventing a second repository framework. The HTTP and terminal callers never acquire locks or call Pi directly.

### State-root layout

```text
<state-dir>/                 0700, real owner-controlled path
  writer.sqlite             0600, never unlinked/replaced while in use
  operations.sqlite         0600, authoritative
  sessions/                 0700, native Pi files, 0600
  work/                     0700, empty BRN working directory
  runtime/                  0700
    discovery.json          0600, atomically replaced per service instance
  logs/                     0700, metadata-only files, 0600
```

Require `--state-dir` to be an absolute, explicitly selected path in A. Validate ownership, permissions, symlink components, and regular-file/single-link identity before opening managed files. Use `process.umask(0o077)` before Pi or SQLite creates files. Existing permissive files cause a clear startup error; do not silently broaden or rewrite permissions. Tests resolve macOS's temporary directory to its real path before creating roots.

Only the lock connection may be opened before ownership is acquired. Keep it alive until Pi, the operation database, and all accepted work have stopped. Its transaction never contains application data.

## Cross-task interfaces

Implement these names consistently. A task may add private helpers, but may not change this interface unilaterally.

```ts
// src/core/errors.ts
export class BrnError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "BrnError";
    this.code = code;
  }
}
```

The code is an internal discriminant, not an arbitrary public message. The HTTP mapper uses an explicit allowlist of codes/statuses from the HTTP contract; an unrecognized code becomes the fixed `INTERNAL_ERROR` response. Do not populate it with raw exception messages.

```ts
// src/core/conversation.ts
export type ModelId = { provider: string; id: string };
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};
export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
} | null;
export type SessionInfo = { id: string; model: ModelId | null };
export type PromptCommand = {
  requestId: string;
  sessionId: string;
  model: ModelId;
  text: string;
};
export type RunResult =
  | { kind: "completed"; entryIds: string[]; truncated: boolean; usage: Usage }
  | { kind: "cancelled"; entryIds: string[] }
  | { kind: "failed"; code: "PROVIDER_ERROR" | "NO_MODEL" | "AUTH_REQUIRED";
      entryIds: string[] };
export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "status"; status: "working" | "compacting" | "cancelling" }
  | { type: "context"; context: ContextUsage };
export type ConversationSnapshot = {
  session: SessionInfo | null;
  context: ContextUsage;
  usage: Usage;
};
export interface ConversationEngine {
  snapshot(): ConversationSnapshot;
  models(): Promise<ModelId[]>;
  sessions(): Promise<SessionInfo[]>;
  create(model: ModelId): Promise<SessionInfo>;
  resume(sessionId: string): Promise<SessionInfo>;
  selectModel(model: ModelId): Promise<void>;
  run(command: PromptCommand, emit: (event: EngineEvent) => void): Promise<RunResult>;
  cancel(): Promise<void>;
  readResult(sessionId: string, entryIds: string[]): Promise<string>;
  close(): Promise<void>;
}
export type OperationState =
  | "accepted" | "running" | "cancelling"
  | "succeeded" | "failed" | "cancelled" | "interrupted";
export type Operation = {
  id: string;
  sessionId: string;
  requestHash: string;
  state: OperationState;
  result: RunResult | null;
  failureCode: string | null;
};
export interface OperationStore {
  find(id: string): Operation | null;
  insert(command: PromptCommand, requestHash: string): Operation;
  transition(id: string, from: OperationState[], to: OperationState): Operation;
  finish(id: string, result: RunResult, failureCode?: string): Operation;
  interruptUnfinished(): number;
  latest(): Operation | null;
  close(): void;
}
export type OperationView = {
  operation: Operation | null;
  liveText: string;
  accepting: boolean;
  controlling: boolean;
};
export interface Operations {
  submit(command: PromptCommand, requestHash: string): Operation;
  cancel(id: string): Promise<Operation>;
  control<T>(action: () => Promise<T>): Promise<T>;
  view(): OperationView;
  waitForIdle(): Promise<void>;
  stop(): Promise<void>;
}
```

`readResult` resolves only entry IDs associated with the requested operation/session. It never accepts a path, parses JSONL, or returns arbitrary session entries. Usage starts with zeroes; unknown context is `null`, not a guessed zero-percent value. A completed-but-truncated response remains distinguishable at every interface.

### HTTP contract

All endpoints, including health, require bearer authentication. A rejects **any** `Origin` header, including `"null"`: it has no browser client. H must explicitly extend this policy. Reject duplicate authorization/Host headers, mismatched Host, userinfo, query-string credentials, unsupported content types and oversized JSON before dispatch. Send no CORS headers.

| Method/path | Request | Response and semantics |
|---|---|---|
| `GET /v1/health` | none | `{ready:true,instanceId}`; no state paths |
| `GET /v1/snapshot` | none | `Snapshot` defined in Task 5 |
| `GET /v1/events` | none | authenticated SSE; initial `snapshot`, then `update` |
| `GET /v1/models` | none | `{models:ModelId[]}` |
| `GET /v1/sessions` | none | `{sessions:SessionInfo[]}` |
| `POST /v1/sessions` | `{model:ModelId}` | `201 SessionInfo`; busy rejection, not queued |
| `POST /v1/sessions/resume` | `{sessionId:string}` | `SessionInfo`; busy rejection |
| `POST /v1/model` | `{model:ModelId}` | selected `SessionInfo`; busy rejection |
| `POST /v1/operations` | `PromptCommand` | `202 Operation` for new work; `200` for exact duplicate |
| `GET /v1/operations/:id` | none | `Operation` |
| `GET /v1/operations/:id/result` | none | `{text:string,truncated:boolean}` from native Pi entries |
| `POST /v1/operations/:id/cancel` | `{confirmed:true}` | original operation after settlement; repeat is harmless |

Use `{error:{code:string,message:string}}` with fixed, reviewed public messages. Map malformed input to `400`, unauthenticated requests to `401`, Origin/Host denial to `403`, unknown IDs to `404`, busy/stale/model mismatch/reused ID to `409`, too-large input to `413`, corrupt/unavailable state to `503`. Never send raw provider, SQLite, or filesystem exception messages to an unauthenticated caller or operational log.

Read-only requests can reconnect automatically. Do not automatically repeat session/model mutations after a lost response. For prompt submission uncertainty, query the preselected request ID: repeat only the **identical** prompt request with that same ID if the user explicitly chooses recovery after a `404`. A new request ID is a new paid operation.

## Task 1: Start one authenticated foreground process

**Files:** Create toolchain files; `src/service/{sqlite,ownership,http,log,start,main}.ts`; `src/cli/{client,main}.ts`; `src/core/errors.ts`; `test/ownership.test.ts`; `test/http.test.ts`; `test/support/{process,service-child}.ts`. Modify `README.md:1`.

**Interfaces:**
- Consumes: Node platform interfaces only; no Pi session or application database is opened yet.
- Produces: `acquireOwnership(root: string): Promise<{root:string; release():void}>`, `openDatabase(path:string): DatabaseSync`, `startService({stateDir}: {stateDir:string}): Promise<{close():Promise<void>}>`, and authenticated `GET /v1/health`.
- Produces: `connect(stateDir:string): Promise<Client>`. Its low-level method is `request<S extends TSchema>(method:string,path:string,schema:S,body?:unknown): Promise<Static<S>>`, importing `TSchema` and `Static` from TypeBox. Validate the parsed response with the supplied schema before returning; callers cannot select an unchecked arbitrary return type.
- Task 5 adds typed `Client.submit(command:PromptCommand):Promise<Operation>`, `operation(id:string):Promise<Operation>`, `result(id:string):Promise<{text:string;truncated:boolean}>`, and `disconnect():Promise<void>`. `disconnect` closes client subscriptions, not the service or operation. Task 1 needs only the health response schema, colocated with its client until Task 5 moves shared contracts.

- [ ] **Step 1: Add the exact package/toolchain configuration.**

Create this manifest. The browser packages are compatibility inputs, not a browser deliverable.

```json
{
  "name": "brn",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.20 <25" },
  "packageManager": "npm@11.19.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json",
    "test": "vitest run --exclude 'test/live/**'",
    "test:live": "vitest run test/live/provider-chat.test.ts",
    "lint": "biome check src test",
    "service": "node dist/service/main.js",
    "brn": "node dist/cli/main.js"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.85.1",
    "@earendil-works/pi-ai": "0.85.1",
    "@earendil-works/pi-tui": "0.85.1",
    "typebox": "1.3.7",
    "yaml": "2.9.0",
    "mdast-util-from-markdown": "2.0.3",
    "micromark-extension-gfm": "3.0.0",
    "mdast-util-gfm": "3.1.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-markdown": "10.1.0",
    "remark-gfm": "4.0.1"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "@types/node": "24.13.3",
    "vitest": "5.0.0",
    "@playwright/test": "1.63.0",
    "@axe-core/playwright": "4.13.0",
    "@biomejs/biome": "2.5.12",
    "vite": "8.2.2",
    "@vitejs/plugin-react": "6.1.1",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.7"
  }
}
```

`.node-version` contains `24.20.0` and a newline. `.gitignore` contains `node_modules/`, `dist/`, `coverage/`, `*.tsbuildinfo`, and `.DS_Store`; never ignore the lockfile. Configuration:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": false,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

`tsconfig.test.json` extends this configuration, sets `rootDir: "."` and `noEmit: true`, and includes `src/**/*.ts` and `test/**/*.ts`. `biome.json` contains:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.12/schema.json",
  "formatter": { "enabled": true },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

Run `node --version && npm --version`, then `npm install`. Expected versions are exactly the selected pins. Commit the generated lockfile. Do not suppress peer/type errors with `--force`, `--legacy-peer-deps`, `skipLibCheck`, or casts. A demonstrated incompatibility requires a recorded, narrowly scoped pin amendment.

- [ ] **Step 2: Write ownership/authentication tests before the implementation.**

The process helper exports `spawnService(root, options?)`, returning `{pid, request, exit, signal, output, close}`. It waits for readiness through an IPC message or a bounded discovery/authenticated-health loop, not sleep-based guessing. `close()` signals only its recorded child PID, awaits exit, and preserves captured output on failure. `request` reads the test root's discovery token internally and never prints it.

```ts
import { expect, test } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnService } from "./support/process.ts";

test("a live but stopped owner prevents a second writer", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "brn-owner-"));
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

test("health is not an unauthenticated information endpoint", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "brn-auth-"));
  const service = await spawnService(root);
  try {
    expect((await service.request("/v1/health")).status).toBe(200);
    expect((await service.request("/v1/health", { auth: false })).status).toBe(401);
    expect((await service.request("/v1/health", {
      headers: { Origin: "https://hostile.example" },
    })).status).toBe(403);
  } finally {
    await service.close();
  }
});
```

Add table-driven cases for wrong Host, duplicate Host/Authorization, absent/expired/wrong token, `Origin: null`, token in query, no CORS grant, symlink root/file, wrong ownership, permissive state files, hard-linked managed files, stale discovery after process death, and two simultaneous starts. Use a raw `node:net` request for duplicate-header tests.

- [ ] **Step 3: Run the red tests.**

Run `npm test -- test/ownership.test.ts test/http.test.ts`.
Expected: missing production ownership/HTTP exports, then concrete failed assertions as files are added. A compiler/configuration failure is not proof of the targeted behavior; fix the harness before counting the red result.

- [ ] **Step 4: Implement the ownership and SQLite primitives.**

Keep security configuration explicit:

```ts
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowUnknownNamedParameters: false,
    defensive: true,
    timeout: 0,
  });
}

export function proveFts5(): void {
  const db = openDatabase(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
    db.prepare("INSERT INTO probe(body) VALUES (?)").run("brn");
    const row = db.prepare("SELECT count(*) AS n FROM probe WHERE probe MATCH ?")
      .get("brn");
    if (row?.n !== 1) throw new Error("SQLITE_FTS5_UNAVAILABLE");
  } finally {
    db.close();
  }
}
```

After guarded exclusive file creation (`open` with `wx`, mode `0600`; an existing file is accepted only after identity checks), open `writer.sqlite`, execute `PRAGMA journal_mode=DELETE`, then `BEGIN EXCLUSIVE`. Hold that connection/transaction until shutdown. Map only a positively identified SQLite busy/locked result to `ALREADY_RUNNING`; propagate permission, corruption and I/O failures distinctly. On acquisition failure, close this connection. Do not unlink the database on release.

Set process umask before any generated files. Validate each managed path using `lstat`, UID, mode and link count. Directory creation uses mode `0700`; sync new parent-directory entries. Never descend through a symlink. The application-state database opens only after this lock has succeeded.

- [ ] **Step 5: Implement authenticated startup, discovery and status.**

Use `createServer()` and `listen(0, "127.0.0.1")`. Generate an instance UUID and 32 random token bytes. Discovery contains `{version:1,instanceId,pid,host,token}`; `host` must be `127.0.0.1:<assigned-port>`. Write a same-directory `0600` temporary file, sync it, rename and sync the directory. Publish discovery only after initialization succeeds.

Compare a presented token with the expected token using equal-length buffers and `timingSafeEqual`. Validate raw duplicate headers before Node's normalized headers. Fixed error text for failed authentication is `Unauthorized`; it contains no path or PID. The CLI reads discovery with `O_NOFOLLOW`, checks owner/mode/regular-file/single-link identity, validates the complete object, and only connects to its literal loopback host. Set `redirect: "error"` on authenticated fetches.

The central authentication check in `http.ts` is:

```ts
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BrnError } from "../core/errors.ts";

export function authenticate(
  request: IncomingMessage,
  expected: { host: string; token: string },
): void {
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.get("authorization") !== 1 || counts.get("host") !== 1) {
    throw new BrnError("UNAUTHORIZED");
  }
  if (request.headers.host !== expected.host || counts.has("origin")) {
    throw new BrnError("ORIGIN_OR_HOST_DENIED");
  }
  const header = request.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = Buffer.from(supplied, "utf8");
  const wanted = Buffer.from(expected.token, "utf8");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    throw new BrnError("UNAUTHORIZED");
  }
}

export function sendJson(
  response: ServerResponse, status: number, body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
```

The route function calls `authenticate` before reading domain state; its fixed error mapper also uses `sendJson`. Reject absolute-form targets and any unexpected query string rather than interpreting a token there. HTTP headers have their own size limit, so this token comparison never allocates an unbounded attacker-controlled buffer.

Set HTTP header/request deadlines and a bounded keepalive. On SIGINT/SIGTERM, mark unready, reject new work, close listeners/connections, close mutable resources, remove only this instance's discovery file, then release ownership last. Cleanup uses `finally` but does not swallow failures. No client promotes itself to owner.

At this stage `npm run service -- --state-dir <absolute-path>` serves authenticated health; `npm run brn -- --state-dir <absolute-path> status` attaches. All other commands return a clear unsupported-command error, not success-shaped stubs.

- [ ] **Step 6: Run the targeted green checks.**

Run `npm run build && npm run typecheck && npm test -- test/ownership.test.ts test/http.test.ts && npm run lint`.
Expected: exact dependency set type-checks without suppressing declarations; ownership tests use real processes; FTS5 probe succeeds on the target Node binary. README now documents the two independent commands.

- [ ] **Step 7: Commit the foreground-process deliverable.**

```bash
git add package.json package-lock.json .node-version .gitignore tsconfig.json tsconfig.test.json biome.json src/core/errors.ts src/service src/cli test/support test/ownership.test.ts test/http.test.ts README.md
git commit -m "feat: launch one authenticated foreground BRN process" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Make accepted operations durable and idempotent

**Files:** Create `src/core/{conversation,operations}.ts`, `src/service/operation-store.ts`, `test/{operations,operation-store}.test.ts`, `test/support/fake-engine.ts`. Modify `src/service/start.ts` to initialize/recover/close the ledger after ownership.

**Interfaces:**
- Consumes: `openDatabase`, fixed public errors, the cross-task engine/ledger types.
- Produces: `openOperationStore(path:string): OperationStore` and `createOperations({store,engine,onChange,deadlineMs?}): Operations`.
- `onChange: () => void` announces that a coherent synchronous snapshot is available. Default deadline is `120_000`; shorter values are test-only constructor inputs, not a public product bypass.

- [ ] **Step 1: Write an exact-duplicate/restart test using real SQLite.**

The fake exports `FakeEngine implements ConversationEngine`, `calls: PromptCommand[]`, `complete(text:string):void`, `fail():void`, and `abortSettles: boolean`. It starts with session `session-1`, model `{provider:"test",id:"offline"}`. `run()` records the command and returns a promise settled only by these controls; results live in the fake's native-result map. Its session/model methods update the same snapshot. No HTTP/provider network is involved.

```ts
import { expect, test } from "vitest";
import { openOperationStore } from "../src/service/operation-store.ts";
import { createOperations } from "../src/core/operations.ts";
import { FakeEngine } from "./support/fake-engine.ts";

test("duplicate admission never repeats provider work", async () => {
  const store = openOperationStore(":memory:");
  const engine = new FakeEngine();
  const operations = createOperations({ store, engine, onChange: () => {} });
  const command = {
    requestId: "953ac32b-26e2-4a2b-9d99-8e77a087e780",
    sessionId: "session-1",
    model: { provider: "test", id: "offline" },
    text: "synthetic prompt",
  };
  const first = operations.submit(command, "digest-a");
  expect(operations.submit(command, "digest-a").id).toBe(first.id);
  expect(() => operations.submit({ ...command, text: "changed" }, "digest-b"))
    .toThrow("REQUEST_ID_REUSED");
  expect(engine.calls).toHaveLength(1);
  engine.complete("synthetic result");
  await operations.waitForIdle();
  expect(store.find(first.id)?.state).toBe("succeeded");
  await operations.stop();
  store.close();
});
```

For restart, use a temporary file-backed store: insert an accepted operation, close/reopen, call `interruptUnfinished()`, assert state `interrupted`, and assert that constructing the coordinator never calls `engine.run()`. Repeat with `running` and `cancelling`.

- [ ] **Step 2: Run the red operation tests.**

Run `npm test -- test/operations.test.ts test/operation-store.test.ts`.
Expected: missing ledger/coordinator implementation, followed by assertion failures for idempotency and restart classification.

- [ ] **Step 3: Implement the versioned ledger schema and guarded row decoding.**

Use `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`, `PRAGMA foreign_keys=ON`, and `PRAGMA user_version`. Run integrity checks before mutation; an invalid authoritative database produces `STATE_CORRUPT`, not deletion/rebuild. Reject a schema version greater than the supported version. The initial migration is one transaction:

```sql
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('accepted','running','cancelling','succeeded','failed','cancelled','interrupted')),
  result_json TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_unfinished_operation ON operations ((1))
  WHERE state IN ('accepted','running','cancelling');
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  model_json TEXT NOT NULL,
  materialized INTEGER NOT NULL CHECK (materialized IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;
PRAGMA user_version=1;
```

`settings` stores only active session ID and BRN's selected default model. `sessions` distinguishes a deliberately empty native session from a previously materialized session whose file is now missing; `model_json` preserves the selected model for empty sessions that have no native model entry on disk. For materialized sessions, the native session's saved model is authoritative. This is not a transcript or a replacement for `SessionManager.list()`. These A-only tables must not include draft/publication/comment columns.

SQL bindings are positional or explicitly named; reject unknown parameters. Decode every selected row and `result_json` with runtime schemas rather than asserting `as Operation`. Use TypeBox for the public shapes and persisted result union. Store the exact request digest but **not** prompt text. `transition` requires an allowed prior state and exactly one changed row; failure is a conflict, not an ignored update.

`interruptUnfinished()` performs one transaction setting all unfinished operations to `interrupted` with `failure_code='SERVICE_INTERRUPTED'`. Its caller must own the process lock.

- [ ] **Step 4: Implement admission and the occupied-operation lifecycle.**

Use the following order for `submit`; exact duplicates must resolve even when another conversation is now active:

```ts
const previous = store.find(command.requestId);
if (previous) {
  if (previous.requestHash !== requestHash) {
    throw new BrnError("REQUEST_ID_REUSED");
  }
  return previous;
}
if (!accepting) throw new BrnError("SERVICE_STOPPING");
if (active !== null || controlling) throw new BrnError("BUSY");
const current = engine.snapshot().session;
if (!current || current.id !== command.sessionId) {
  throw new BrnError("SESSION_MISMATCH");
}
if (current.model?.provider !== command.model.provider ||
    current.model.id !== command.model.id) {
  throw new BrnError("MODEL_MISMATCH");
}
const admitted = store.insert(command, requestHash);
active = admitted.id;
liveText = "";
const running = store.transition(active, ["accepted"], "running");
```

After this synchronous section, start exactly one owned promise for `engine.run(command, emit)`, return `running`, and retain that promise for `waitForIdle()` and shutdown. Never tie its cancellation to the incoming request's socket. Classify the returned `RunResult`; do not assume resolution means success. Call `store.finish()` only after the engine's native results are durable.

The lifecycle owns its rejection handler: convert recognized engine failures to fixed codes; mark unknown engine exceptions as `INTERNAL_ERROR` without logging their text. A store write failure blocks new mutations and remains visible as `STATE_UNAVAILABLE`; do not release admission and pretend the result was saved. Preserve the original failure for the process-level error handler.

Append emitted text to the active in-memory preview and notify `onChange`. If the preview exceeds `1024 * 1024` UTF-8 bytes, stop accumulating, request cancellation, and report `OUTPUT_LIMIT`; never grow an unbounded reconnect snapshot. This defensive transport ceiling does not replace the requested token cap.

- [ ] **Step 5: Implement cancellation, control exclusion and shutdown tests.**

`control(action)` synchronously sets `controlling=true` before its first await; it rejects when an operation/control is occupied and clears the flag in `finally`. Prompts reject while a session/model change is in progress. Reads remain available.

`cancel(id)` validates the target; completed/interrupted targets return their recorded state. For active work, persist `cancelling` before calling `engine.cancel()`, then await the original run's settlement. Repeated cancellation waits for the same promise. A naturally completed result that wins the race remains successful; it is not relabeled cancelled. An aborted result after the deadline carries `failureCode='DEADLINE_EXCEEDED'`.

```ts
test("an unsettled cancellation cannot admit a switch", async () => {
  const store = openOperationStore(":memory:");
  const engine = new FakeEngine();
  engine.abortSettles = false;
  const operations = createOperations({ store, engine, onChange: () => {} });
  operations.submit({
    requestId: "147fb03a-4494-4a91-abbd-420d859f5787",
    sessionId: "session-1",
    model: { provider: "test", id: "offline" },
    text: "wait",
  }, "digest-wait");
  const cancellation = operations.cancel("147fb03a-4494-4a91-abbd-420d859f5787");
  await expect(operations.control(() => engine.create({
    provider: "test", id: "offline",
  }))).rejects.toThrow("BUSY");
  engine.complete("completed before cancellation settled");
  await cancellation;
  expect(store.latest()?.state).toBe("succeeded");
  await operations.stop();
  store.close();
});
```

Add cases for deadline cancellation, partial-result failure, admission commit failure before `run`, completion commit failure, duplicate completion, model mismatch, wrong-session cancellation, concurrent controls, and shutdown during control. `stop()` first disables admission, then waits for a pending control, cancels/settles provider work, and leaves database closure to the process owner. If settlement hangs, the process stays stopping and retains ownership; no second writer is enabled.

- [ ] **Step 6: Run the green operation tests.**

Run `npm run typecheck && npm test -- test/operations.test.ts test/operation-store.test.ts`.
Expected: all state transitions are durable/idempotent; no restart path calls the engine.

- [ ] **Step 7: Commit durable admission and recovery.**

```bash
git add src/core/conversation.ts src/core/operations.ts src/core/errors.ts src/service/operation-store.ts src/service/start.ts test/operations.test.ts test/operation-store.test.ts test/support/fake-engine.ts
git commit -m "feat: persist single-operation admission and recovery" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Host isolated native Pi sessions through public interfaces

**Files:** Create `src/service/pi/{resources,runtime}.ts` and `test/pi-runtime.test.ts`. Modify `src/service/operation-store.ts` for narrowly scoped session/default metadata accessors and `src/service/start.ts` for shared model-runtime lifetime.

**Interfaces:**
- Consumes: process ownership; session metadata methods `rememberSession(id:string,model:ModelId,materialized:boolean):void`, `sessionMetadata(id:string):{model:ModelId;materialized:boolean}|null`, `setActiveSession(id:string|null):void`, `getActiveSession():string|null`, `setDefaultModel(model:ModelId):void`, `getDefaultModel():ModelId|null`. Expose these on a service-local `SessionMetadataStore` type; keep them out of the core `OperationStore` interface.
- Produces: `openPiRuntime(options): Promise<PiHost>` with `snapshot`, `models`, `sessions`, `create`, `resume`, `selectModel`, `current`, `close`.
- `current(): AgentSession` stays private to `src/service/pi/`; Pi types must not escape through `ConversationEngine`.
- `PiHost.snapshot/models/sessions/create/resume/selectModel/close` use the identical signatures from `ConversationEngine`. Its additional service-local methods are `subscribe(listener:(event:AgentSessionEvent)=>void):()=>void` and `syncCurrentSession():Promise<void>`. `syncCurrentSession` syncs existing native bytes and their directory, then records materialization; it leaves a genuinely empty, unmaterialized session represented by its SQLite metadata.
- Production `options` includes guarded `root` and the metadata store. A constructor-only `modelRuntime` injection allows the real-SDK faux tests; it is not an HTTP flag or production environment bypass.

- [ ] **Step 1: Write a real-SDK offline construction/reopen test.**

Use the official faux provider, not a mock of `createAgentSession`. The helper `openPiRuntime` is production code. In this test, `openPiTestRoot()` creates a guarded temporary root, opens the real metadata store, and returns `{root,store,close}`; put that helper in `test/pi-runtime.test.ts` until another test needs it.

```ts
import { expect, test } from "vitest";
import {
  fauxAssistantMessage, fauxProvider, InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openPiRuntime } from "../src/service/pi/runtime.ts";

test("real SDK keeps tools empty and reopens its own native result", async () => {
  const fixture = await openPiTestRoot();
  const faux = fauxProvider({
    provider: "brn-test",
    api: "brn-test",
    models: [{ id: "offline", name: "Offline", reasoning: false,
      contextWindow: 32768, maxTokens: 4096 }],
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
    root: fixture.root, store: fixture.store, modelRuntime: models,
  });
  try {
    const info = await host.create({ provider: "brn-test", id: "offline" });
    expect(host.current().getAllTools()).toEqual([]);
    expect(host.current().getActiveToolNames()).toEqual([]);
    await host.current().prompt("synthetic only");
    await host.syncCurrentSession();
    await host.resume(info.id);
    expect(host.current().messages.some((message) =>
      message.role === "assistant" &&
      message.content.some((part) =>
        part.type === "text" && part.text === "offline native result"),
    )).toBe(true);
    expect(host.current().getAllTools()).toEqual([]);
  } finally {
    await host.close();
    await fixture.close();
  }
});
```

The test-only direct prompt uses `syncCurrentSession()` just as the production adapter will in Task 4. Add an ambient-resource trap: write synthetic `AGENTS.md`, settings, prompt, skill and extension sentinels in the test home/work roots; assert none appears in loaded resources or executes. Do not read the real home directory.

- [ ] **Step 2: Run the real-SDK red test with network disabled.**

Run `npm test -- test/pi-runtime.test.ts`.
Expected: missing BRN host, then actual SDK-construction/reopen failures as implementation is added. Use in-memory credentials, no inherited provider keys, and no model-catalog refresh. The fixture rejects accidental `fetch`/HTTP/HTTPS/net connections except explicitly allowed loopback process tests; a test that silently contacts a provider is a failure.

- [ ] **Step 3: Construct the shared model runtime and controlled loader.**

Production configuration:

```ts
import { join } from "node:path";
import {
  getAgentDir, ModelRuntime, SettingsManager, createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
  authPath: join(getAgentDir(), "auth.json"),
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});

const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: true, reserveTokens: 5120, keepRecentTokens: 8192 },
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
});

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({
    extensions: [], errors: [], runtime: createExtensionRuntime(),
  }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () =>
    "You are BRN's conversational assistant. No vault or filesystem tools " +
    "are available. Do not claim to read, save, approve, or publish files.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
```

The loader's empty methods deliberately implement the SDK contract; they are not future BRN tool stubs. Never use `DefaultResourceLoader`, file-backed settings, or automatic resource scanning.

- [ ] **Step 4: Implement native lifecycle with a controlled runtime factory.**

Keep runtime construction lazy: starting the service constructs shared facilities but does not create a conversation or choose a model. The following factory is used only by an explicit `create`/`resume` control. Use the documented `CreateAgentSessionRuntimeFactory` and `createAgentSessionRuntime`:

```ts
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, createAgentSessionRuntime, SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

async function resolveExactModel(manager: SessionManager): Promise<Model<Api>> {
  const saved = manager.buildSessionContext().model;
  const metadata = store.sessionMetadata(manager.getSessionId());
  const identity = saved
    ? { provider: saved.provider, id: saved.modelId }
    : metadata?.model;
  if (!identity) throw new BrnError("NO_MODEL");
  const available = await modelRuntime.getAvailable(undefined, {
    signal: AbortSignal.timeout(15_000),
  });
  const selected = available.find((model) =>
    model.provider === identity.provider && model.id === identity.id);
  if (!selected) throw new BrnError("MODEL_UNAVAILABLE");
  return { ...selected, maxTokens: Math.min(selected.maxTokens, 4096) };
}

const factory: CreateAgentSessionRuntimeFactory = async ({
  cwd, agentDir, sessionManager, sessionStartEvent,
}) => {
  const model = await resolveExactModel(sessionManager);
  const result = await createAgentSession({
    cwd, agentDir, sessionManager,
    ...(sessionStartEvent ? { sessionStartEvent } : {}),
    model, modelRuntime, settingsManager, resourceLoader,
    tools: [],
    noTools: "all",
  });
  return {
    ...result,
    services: {
      cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
      diagnostics: [],
    },
    diagnostics: [],
  };
};

// This block runs only inside an explicit, idle create control.
const manager = SessionManager.create(join(root, "work"), join(root, "sessions"));
store.rememberSession(manager.getSessionId(), requestedModel, false);
const runtime = await createAgentSessionRuntime(factory, {
  cwd: join(root, "work"),
  agentDir: root,
  sessionManager: manager,
});
```

`requestedModel:ModelId` is the argument to `create`; validate its availability before recording the empty session. The factory resolves the model afresh for **each** replacement rather than capturing the preceding session's model. Pi's `SessionContext.model` uses `modelId`; the BRN `ModelId` uses `id`, as mapped above. After factory construction, require the exact requested/saved identity. Missing credentials/model is a visible error, not permission to choose another provider.

`SessionManager.list(workDir,sessionsDir)` yields server-side IDs and paths. Validate the selected path against the guarded sessions root, then use `SessionManager.open(path,sessionsDir,workDir)` or `runtime.switchSession(path)`. Caller values are IDs only. Check all duplicate native IDs before selection and report `SESSION_CONFLICT` rather than selecting the first. Require the opened manager's ID to match the selected ID; an SDK fallback/reset is not a successful resume.

Pi initially assigns a session ID/path without necessarily creating a file. Persist that ID and selected model with `materialized=0` so a restart can recreate the same **empty** native session using `SessionManager.create(...,{id})`. For replacement with an unmaterialized session, settle/dispose the old runtime and construct through the same controlled factory with the recreated manager; there is no native path to pass to `switchSession`. Once an assistant entry is durable, set `materialized=1`. A missing file for such a session is `SESSION_UNAVAILABLE`; never replace it with an empty conversation.

`setActiveSession()` and default-model persistence occur only after a successful controlled replacement. Sync any materialized native session changes before acknowledging model-selection success; for empty sessions persist their selected-model metadata instead. A failed destructive replacement must not leave a stale old `AgentSession` pointer advertised as active: expose no active conversation and a fixed error until an explicit resume succeeds.

- [ ] **Step 5: Rebind subscriptions and exercise replacements.**

Use one unsubscribe handle and install a runtime rebind callback. Each callback captures the active session identity; late events from an obsolete binding must not enter the new operation:

```ts
let unsubscribe: (() => void) | undefined;
const rebind = async (session: typeof runtime.session): Promise<void> => {
  unsubscribe?.();
  await session.bindExtensions({});
  unsubscribe = session.subscribe((event) => {
    if (session !== runtime.session) return;
    forwardPiEvent(event);
  });
};
runtime.setRebindSession(rebind);
await rebind(runtime.session);
```

`forwardPiEvent(event: AgentSessionEvent): void` is the private listener fanout in `runtime.ts`; Task 4 installs its translation listener. An obsolete event is deliberately discarded because its subscription no longer owns the current conversation.

Add real-SDK tests for two session replacements, failed/unavailable model selection, empty-session restart, materialized-session disappearance, duplicate session IDs, preserved unknown context, and disposal. Verify no personal resources load after **every** replacement, not only construction. Host closure awaits `session.abort()` before `runtime.dispose()` and tears down subscriptions.

- [ ] **Step 6: Run the green SDK tests.**

Run `npm run typecheck && npm test -- test/pi-runtime.test.ts`.
Expected: real SDK factories, native create/reopen, zero tool registry and replacement subscriptions work offline. Do not describe this as a live-provider result.

- [ ] **Step 7: Commit isolated native conversation hosting.**

```bash
git add src/service/pi/resources.ts src/service/pi/runtime.ts src/service/operation-store.ts src/service/start.ts test/pi-runtime.test.ts
git commit -m "feat: host isolated native Pi conversations" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Translate real Pi execution into bounded, durable outcomes

**Files:** Create `src/service/pi/conversation.ts`, `test/pi-conversation.test.ts`. Modify `src/service/pi/runtime.ts`, `test/pi-runtime.test.ts`, and `src/service/start.ts`.

**Interfaces:**
- Consumes: `PiHost` from Task 3 and the exact `ConversationEngine` interface.
- Produces: `createPiConversation(host:PiHost): ConversationEngine`.
- The engine's `run()` resolves only after Pi has settled and referenced native results are synced. Unexpected persistence errors reject; they are not a provider-success result.

- [ ] **Step 1: Write outcome and output-limit tests against the real SDK.**

Reuse the isolated real-SDK fixture, extracting it to `test/support/pi.ts` now that it has two consumers. Export `createPiFixture(): Promise<{engine,host,modelRuntime,faux,close}>`. The fixture creates a new `brn-test/offline` session. `faux` is the actual return type of `fauxProvider`, not a custom fake interface.

```ts
import { expect, test, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createPiFixture } from "./support/pi.ts";

test("the real SDK receives the bounded model on each prompt", async () => {
  const fixture = await createPiFixture();
  const stream = vi.spyOn(fixture.modelRuntime, "streamSimple");
  fixture.faux.setResponses([fauxAssistantMessage("bounded response")]);
  try {
    const session = fixture.engine.snapshot().session;
    if (!session?.model) throw new Error("fixture has no active model");
    const result = await fixture.engine.run({
      requestId: "670742ce-591b-4dd3-99db-052a49e1c4ec",
      sessionId: session.id,
      model: session.model,
      text: "synthetic only",
    }, () => {});
    expect(result.kind).toBe("completed");
    expect(stream).toHaveBeenCalled();
    for (const call of stream.mock.calls) {
      expect(call[0].maxTokens).toBeLessThanOrEqual(4096);
    }
  } finally {
    await fixture.close();
  }
});
```

Add tests with faux terminal messages whose `stopReason` is `"error"`, `"aborted"`, and `"length"`. Construct them by spreading `fauxAssistantMessage("synthetic")` and setting the typed stop reason. Assert error/abort does not become success merely because `session.prompt()` resolves. Add multibyte input at/beyond the `16384`-byte boundary.

- [ ] **Step 2: Run the red adapter tests.**

Run `npm test -- test/pi-conversation.test.ts`.
Expected: missing engine translation or incorrect failure/cap handling. Do not mock away the actual SDK lifecycle.

- [ ] **Step 3: Translate events without exposing hidden reasoning or raw errors.**

Listen for `message_update` with `assistantMessageEvent.type === "text_delta"`; forward only the text. Do not publish thinking deltas, raw provider payloads, auth objects or compaction summaries into operational logs.

Map `compaction_start` to `status: "compacting"` and the matching end to `"working"`, recording any sanitized failure state. Read context through `getContextUsage()` and usage through `getSessionStats()`; preserve their unknown values. `agent_end` can have `willRetry=true`; it is not the final operation-completion signal. Wait for prompt settlement and any documented `agent_settled` lifecycle before releasing the operation.

```ts
if (event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta") {
  emit({ type: "text", text: event.assistantMessageEvent.delta });
}
if (event.type === "compaction_start") {
  emit({ type: "status", status: "compacting" });
}
```

At operation start, record the native entry IDs already present. After settlement, obtain new entries through `session.sessionManager.getEntries()`, filter entries with `type === "message"` and `message.role === "assistant"`, and classify the last new assistant. The visible result references that last assistant only; failed overflow attempts stay inspectable in Pi's native history rather than being concatenated into a successful answer. Never accidentally use a preceding operation's last assistant when preflight failed before adding a new one.

- [ ] **Step 4: Apply limits and synchronize native results before completion.**

Before each prompt and after every model replacement:

```ts
const bytes = Buffer.byteLength(command.text, "utf8");
if (bytes === 0 || command.text.trim().length === 0) {
  throw new BrnError("EMPTY_PROMPT");
}
if (bytes > 16 * 1024) throw new BrnError("INPUT_TOO_LARGE");
const selected = host.current().model;
if (!selected) throw new BrnError("NO_MODEL");
await host.current().setModel({
  ...selected,
  maxTokens: Math.min(selected.maxTokens, 4096),
}, { persist: false });
await host.current().prompt(command.text, { expandPromptTemplates: false });
```

Do not pass `streamingBehavior`: BRN rejects busy input instead of entering Pi's steering/follow-up queues. Model selection is excluded by the coordinator while this operation runs.

Maintain an operation-local cancellation latch. `cancel()` sets it synchronously before awaiting `session.abort()`. Check the latch after model/auth preflight and immediately before `prompt()`: cancellation during an awaited `setModel()` must not later start a fresh provider request. The coordinator waits for this run promise even if `abort()` returns before preflight settles. Add a deferred-preflight test that requests cancellation, releases preflight, and asserts no prompt was dispatched.

After settlement, call `host.syncCurrentSession()`: use the native session's service-validated `sessionFile` path to open and sync the file and then its parent directory. Do not read/parse its bytes. Mark session materialization only after this succeeds. Native Pi writes alone are not evidence that BRN's durable-result acknowledgment is satisfied.

Preflight failures with no new native entry return an explicit failed result with no result IDs. An unreadable/disappeared native result or failed fsync is a persistence error: preserve operation identity, disable mutation if necessary, and do not record success. `readResult` traverses the native manager's typed entries and joins text parts for exactly the stored assistant-entry IDs; a missing entry yields `RESULT_UNAVAILABLE`, not empty successful text.

Cancellation calls `await session.abort()` and waits for the run promise. The coordinator, not this adapter, owns the overall deadline so automatic compaction and overflow recovery cannot reset it. The adapter keeps no independent retry loop.

- [ ] **Step 5: Exercise native failure and recovery distinctions.**

Add actual SDK cases for cancellation, compaction-event translation, repeated runtime replacement, preflight failure without an assistant entry, result-reference lookup after reopen, native-file sync failure, and saved-model cap reapplication. Add one fixture that produces an overflow error and captures subsequent calls: ordinary/provider retry settings remain disabled while the documented overflow-recovery path remains observable.

The faux SDK test proves the model/options passed to Pi's runtime, not every provider's final HTTP payload. Keep this distinction in the runbook and live proof. No hand-written provider payload hook may silently substitute for the supported API.

- [ ] **Step 6: Run the green adapter tests.**

Run `npm run typecheck && npm test -- test/pi-runtime.test.ts test/pi-conversation.test.ts test/operations.test.ts`.
Expected: error/abort/truncation are distinct; native results reopen; resource restrictions survive replacement; ordinary retries are disabled; operation deadlines include compaction.

- [ ] **Step 7: Commit bounded native execution.**

```bash
git add src/service/pi src/service/start.ts test/support/pi.ts test/pi-runtime.test.ts test/pi-conversation.test.ts
git commit -m "feat: translate Pi runs into bounded durable outcomes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Expose coordinated commands and race-free snapshot streaming

**Files:** Create `src/protocol/contracts.ts`, `src/service/events.ts`, `src/cli/sse.ts`, `test/events.test.ts`. Modify `src/service/{http,start,log}.ts`, `src/cli/client.ts`, `test/http.test.ts`, `test/support/service-child.ts`.

**Interfaces:**
- Consumes: `ConversationEngine`, `Operations`, `OperationStore`, authenticated Task 1 host.
- Produces: the complete HTTP table above, `Snapshot`, `StreamEvent`, `openEventStream()`, and the client SSE decoder.
- `Snapshot = {instanceId:string, sequence:number, conversation:ConversationSnapshot, work:OperationView}`. Build it synchronously from in-memory Pi/coordinator state plus committed ledger data.
- The decoder is `decodeSse(chunks:AsyncIterable<Uint8Array>):AsyncGenerator<StreamEvent>`. `openEventStream(client:Client,onSnapshot:(value:Snapshot)=>void):{close():Promise<void>}` owns read-only reconnects and decoder lifetime.

- [ ] **Step 1: Add runtime request/event schemas and failing route tests.**

Use explicit field schemas, `additionalProperties:false`, UUID-shaped request IDs, bounded IDs, and bounded text. Byte limits are checked after schema validation because JSON Schema `maxLength` is not a UTF-8 byte limit.

```ts
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const ModelIdSchema = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 128 }),
  id: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });
export const PromptSchema = Type.Object({
  requestId: Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  }),
  sessionId: Type.String({ minLength: 1, maxLength: 256 }),
  model: ModelIdSchema,
  text: Type.String({ minLength: 1, maxLength: 16384 }),
}, { additionalProperties: false });
export type PromptRequest = Static<typeof PromptSchema>;
export function isPrompt(value: unknown): value is PromptRequest {
  return Value.Check(PromptSchema, value);
}
```

Define equally explicit schemas for all rows in the HTTP table and both event variants; do not use `Type.Any` for a public response. Core-only interfaces are structurally matched using typed assignments in a contract test, keeping Node/Pi imports out of `protocol`.

```ts
test("a disconnected submitter does not cancel accepted work", async () => {
  const service = await spawnServiceWithFake();
  try {
    const accepted = await service.client.submit(service.prompt("slow synthetic"));
    await service.client.disconnect();
    await service.completeFake("saved once");
    const reconnected = await service.reconnect();
    expect((await reconnected.operation(accepted.id)).state).toBe("succeeded");
    expect(await reconnected.result(accepted.id)).toEqual({
      text: "saved once", truncated: false,
    });
    expect(await service.fakeCallCount()).toBe(1);
  } finally {
    await service.close();
  }
});
```

`spawnServiceWithFake()` extends the process helper using the **test-only** composition entry and IPC controls; no fake-control endpoint, secret environment shortcut, or fake tool is added to production.

- [ ] **Step 2: Run red HTTP/event tests.**

Run `npm test -- test/http.test.ts test/events.test.ts`.
Expected: missing routes/event behavior; changing state during connection must expose any snapshot/live gap.

- [ ] **Step 3: Wire routes to the coordinator and fixed request digest.**

For validated prompts, compute a digest over this fixed tuple; no metadata sorting or whitespace normalization is needed:

```ts
import { createHash } from "node:crypto";

const requestHash = createHash("sha256").update(JSON.stringify([
  1, command.sessionId, command.model.provider, command.model.id, command.text,
])).digest("hex");
const existed = store.find(command.requestId) !== null;
const operation = operations.submit(command, requestHash);
sendJson(response, existed ? 200 : 202, operation);
```

Wrap session/model changes in `operations.control(...)`. Persist selected-session/default-model metadata only after the native operation succeeds. Model listing is bounded and does not automatically prompt. Session IDs are validated as opaque bounded strings; they are never concatenated into a filesystem path.

Read JSON incrementally with a `128 * 1024`-byte HTTP-body ceiling, rejecting both oversized declared lengths and oversized chunked bodies. Decode UTF-8 strictly, reject malformed JSON and extra fields, and check prompt bytes before admission. Use fixed route/error mappings; on unknown internal exceptions log only a generated diagnostic ID, operation ID, fixed code and timing, then return a fixed public message.

GET result uses stored entry references and `engine.readResult` under `operations.control` if accessing an inactive session requires native-manager work; it must never replace the active runtime as a side effect. During active work, a result for the same current session uses typed in-memory native entries; a result requiring unsafe file access returns a visible busy response.

- [ ] **Step 4: Implement snapshot-first SSE without a replay journal.**

One monotonically increasing in-memory sequence belongs to each service instance. All state mutations and text/status changes update the authoritative in-memory snapshot before announcing their event. An event has:

```ts
export type StreamEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "update"; snapshot: Snapshot };
```

For A, publish complete bounded snapshots rather than introducing a text-delta reconciliation protocol. This is intentionally simpler: the terminal replaces its current live-response text rather than appending replayed tokens. Coalesce text-only updates to at most one per `50` ms; flush state transitions immediately. The final snapshot points to the durable result before live preview is cleared.

The hub exposes `subscribe(listener): () => void`, `snapshot():Snapshot`, `changed():void`, and `close():void`. Registration, synchronous snapshot capture and first-frame enqueue must happen in the same event-loop turn with **no await**:

```ts
const unsubscribe = hub.subscribe((snapshot) => writer.send({
  type: "update", snapshot,
}));
writer.send({ type: "snapshot", snapshot: hub.snapshot() });
response.once("close", unsubscribe);
```

Use `Content-Type: text/event-stream`, `Cache-Control: no-store`, and no proxy buffering. Frame data with `JSON.stringify`, not interpolated multiline model text. A writer monitors `response.writableLength`; once its queued data exceeds `2 * 1024 * 1024` bytes, unsubscribe and close that connection. It does not cancel the operation. Bound active previews at the Task 2 ceiling and avoid including whole transcripts in snapshots.

Heartbeat comments every `15_000` ms detect dead connections without touching operation state. Clear heartbeat/coalescing timers on connection/host closure. Every reconnect begins with a new snapshot; ignore `Last-Event-ID` for replay. An instance change discards the previous sequence.

- [ ] **Step 5: Implement the client decoder and resynchronization tests.**

The incremental decoder uses `TextDecoder("utf-8",{fatal:true})` with `{stream:true}`, handles LF and CRLF, joins multiple `data:` lines with `"\n"`, ignores comment frames, and validates parsed events before emitting. Bound pending frame bytes at `2 MiB` and reject invalid JSON/UTF-8/unknown event shapes. Tests split multibyte characters, `\r\n`, and JSON at every byte boundary.

Use this byte-split test with the real decoder:

```ts
test("snapshot frames survive every UTF-8 chunk boundary", async () => {
  const event: StreamEvent = {
    type: "snapshot",
    snapshot: {
      instanceId: "instance-test", sequence: 1,
      conversation: {
        session: null, context: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      },
      work: { operation: null, liveText: "\u00f5", accepting: true, controlling: false },
    },
  };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
  for (let split = 1; split < bytes.length; split += 1) {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield bytes.slice(0, split);
      yield bytes.slice(split);
    }
    const received: StreamEvent[] = [];
    for await (const item of decodeSse(chunks())) received.push(item);
    expect(received).toEqual([event]);
  }
});
```

The client accepts only increasing sequence values within the current instance. On disconnect it reconnects read-only, with delays `250`, `500`, `1000`, then at most `2000` ms between attempts; it shows persistent disconnected status. It refreshes discovery after transport failure and validates a changed instance before connecting. It never retries a POST as part of this loop.

Write tests for a state change during initial subscription, completion during disconnect, duplicate frames, old-instance events, slow readers, bounded frames, UTF-8 fragmentation, lost POST response, and clean client shutdown. Verify SSE authentication independently of JSON routes.

- [ ] **Step 6: Run the green protocol/process tests.**

Run `npm run build && npm run typecheck && npm test -- test/http.test.ts test/events.test.ts test/operations.test.ts test/ownership.test.ts`.
Expected: real HTTP/SSE requests preserve admission and state across disconnects, with no automatic paid resubmission.

- [ ] **Step 7: Commit coordinated HTTP/SSE behavior.**

```bash
git add src/protocol/contracts.ts src/service/events.ts src/service/http.ts src/service/start.ts src/service/log.ts src/cli/client.ts src/cli/sse.ts test/http.test.ts test/events.test.ts test/support
git commit -m "feat: expose coordinated commands and snapshot-first SSE" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 6: Deliver the main-screen terminal conversation client

**Files:** Create `src/cli/{commands,terminal}.ts`, `test/{cli,terminal}.test.ts`. Modify `src/cli/{main,client}.ts` and `README.md`.

**Interfaces:**
- Consumes: only the BRN client and protocol types. `terminal.ts` may import Pi TUI primitives, never coding-agent/session/runtime code.
- Produces: `runCommand(args:string[],client:Client):Promise<void>`, `runTerminal(client:Client):Promise<void>`, and `safeTerminalText(text:string):string`.
- Command syntax is fixed below; interactive slash commands call the same command implementation as standalone commands.

| Standalone command | Interactive equivalent | Meaning |
|---|---|---|
| `status` | `/status` | readiness, active session, operation, context and usage |
| `models` | `/models` | authenticated model identities |
| `sessions` | `/sessions` | native BRN session identities |
| `new --model PROVIDER/MODEL` | `/new PROVIDER/MODEL` | explicit new active session |
| `resume SESSION_ID` | `/resume SESSION_ID` | explicit switch, rejected while busy |
| `model PROVIDER/MODEL` | `/model PROVIDER/MODEL` | change model when idle |
| `chat` | ordinary text | attach to active session and compose prompts |
| `prompt --request-id UUID --text TEXT` | ordinary text allocates one UUID | scriptable synthetic input path |
| `operation OPERATION_ID` | `/operation OPERATION_ID` | current/recorded status and native result |
| `cancel OPERATION_ID --confirm` | Ctrl+C on the displayed active operation | request cancellation, await settlement |
| none | `/quit` or idle Ctrl+C | disconnect client only |

Global syntax is `npm run brn -- --state-dir /absolute/path COMMAND`. Split model IDs at the first `/`; a model ID may itself contain slashes. A session must already exist for `chat`/`prompt`. Missing service/session/model produces a concrete corrective command, not an implicit start or fallback.

- [ ] **Step 1: Write shared command and terminal-state tests.**

```ts
import { expect, test } from "vitest";
import { safeTerminalText } from "../src/cli/terminal.ts";

test("model text cannot emit terminal control sequences", () => {
  const attack = "\x1b]52;c;Y29weQ==\x07hello\rchanged\x1b[2J";
  const rendered = safeTerminalText(attack);
  expect(rendered).not.toContain("\x1b");
  expect(rendered).not.toContain("\x07");
  expect(rendered).not.toContain("\r");
  expect(rendered).toContain("hello");
});
```

Add tests for UTF-8 multiline text preserved exactly, one UUID per submission, input kept on busy/error, changed session while composing, empty input, `/quit` during active work, cancellation against the exact displayed operation, unknown context, truncated output, and external terminal escape sequences in error/model/session labels. Test command-to-route behavior through the actual loopback service, not a mock that cannot detect a wrong endpoint.

- [ ] **Step 2: Run red CLI/terminal tests.**

Run `npm test -- test/cli.test.ts test/terminal.test.ts`.
Expected: missing command/TUI behavior and the terminal sanitization assertion fails until implemented.

- [ ] **Step 3: Implement safe terminal rendering and shared command parsing.**

Use `node:util.parseArgs` for standalone commands. Interactive commands have explicit argument counts and never execute a shell. Parse `/model` and `/new` provider/model pairs as described above. Unknown commands fail with the short supported-command list.

Sanitize **all** server-controlled content before handing it to `Text`; preserve newline/tab but replace other C0/C1 controls visibly. Work on the accumulated string so an escape sequence split over SSE frames cannot escape filtering:

```ts
export function safeTerminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
```

Do not render remote images, raw ANSI, OSC links or thinking content. App-owned TUI formatting remains under BRN control. Operational diagnostics use fixed codes and safe text, never arbitrary stack traces or provider responses.

- [ ] **Step 4: Compose the main-screen editor and status display.**

Use public TUI primitives only:

```ts
import {
  Editor, ProcessTerminal, Text, TuiMainScreen, matchesKey,
  type EditorTheme,
} from "@earendil-works/pi-tui";

const theme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};
const tui = new TuiMainScreen(new ProcessTerminal());
const status = new Text("Connecting to BRN");
const response = new Text("");
const editor = new Editor(tui, theme);
tui.addChild(status);
tui.addChild(response);
tui.addChild(editor);
tui.setFocus(editor);
```

Enter submits; the editor's newline binding/Shift+Enter inserts a line. Keep bracketed paste and multiline editing from the existing TUI implementation. Do not install filesystem autocomplete or extensions.

Maintain a client-side submission record `{requestId,sessionId,model,text}` before POST. Clear the editor only after acknowledgment. If submission status is uncertain, retain that exact record and display its request ID; query it before allowing a new paid submission. Show busy/session-changed errors without dropping typed text.

Snapshot updates replace the active response `Text` content and status; when an operation completes, display its native result once and start a new active response area. Track completed operation IDs in the client instance to avoid printing duplicates on reconnect. Do not grow the snapshot with historical transcripts.

Show `Tools: none (Capability A)` alongside operation/compaction status. No successful tool invocation is possible in A; do not register a dummy tool merely to demonstrate a tool-status widget.

Raw-mode Ctrl+C is handled with `tui.addInputListener` and `matchesKey(data,"ctrl+c")`. If work is active, show cancellation pending and call the exact operation's confirmed cancellation endpoint; do not stop the owner process. If idle, stop the TUI and detach. `/quit` detaches even when work is active, with a visible message that the operation continues. Dispose all subscriptions, fetch abort controllers, input listeners and TUI resources in `finally`.

- [ ] **Step 5: Exercise the actual terminal/client journey.**

Run process-level CLI cases using the compiled entry point and test-only service composition. Feed multiline scripted input via the one-shot `prompt` route and test the editor state mapping separately. For public TUI rendering, use an in-memory implementation of Pi's public terminal interface based on its exported type, then confirm real keyboard/paste/Ctrl+C behavior in a normal macOS terminal. Do not claim pipes or snapshots prove raw-mode keyboard behavior.

For the manual offline terminal journey, start `test/support/service-child.ts` in real-SDK faux mode with the process harness, then attach the compiled client to its disposable root:

```bash
npm run brn -- --state-dir /absolute/path/from-test-harness chat
```

Paste two lines, add a third with the editor's newline binding, submit once, request cancellation during a delayed faux response, and detach while another delayed response is active. The harness asserts exact submitted text and one provider dispatch through its IPC observations; it is not a live-provider run.

Assert no service process exits when either the one-shot command or interactive client exits. Assert two clients see the same active operation and busy rejection. A session switch must not reinterpret the text already composed against the old session as input to the new one.

- [ ] **Step 6: Run the green CLI tests.**

Run `npm run build && npm run typecheck && npm test -- test/cli.test.ts test/terminal.test.ts test/events.test.ts`.
Expected: main-screen controls use only HTTP/SSE; multiline input and repeated snapshots do not duplicate work or output.

- [ ] **Step 7: Commit the terminal client.**

```bash
git add src/cli test/cli.test.ts test/terminal.test.ts README.md
git commit -m "feat: add the main-screen BRN conversation client" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 7: Close process-recovery gaps and record the authorized provider proof

**Files:** Create `test/acceptance/service-terminal.test.ts`, `test/live/provider-chat.test.ts`, `docs/capability-a-operations.md`. Modify the existing service/client/support files only where these journeys expose a missing A guarantee; update `README.md`.

**Interfaces:**
- Consumes: the actual compiled terminal/service, actual SQLite ledger, actual Pi adapter and the explicit evidence gates below.
- Produces: repeatable A acceptance journeys and an honest operational runbook. This task is not permission to contact a provider or use private data.

- [ ] **Step 1: Add crash/interruption/restoration process tests.**

Use the existing process helper and test-only engine IPC controls. For native-result crash/reopen and stopped-copy restoration scenarios, select the **real Pi adapter with its official faux provider**, not the in-memory `FakeEngine`: that fake cannot prove native results survive process death. Keep the simpler fake for admission-only and scheduling tests. Add test-only failpoints in the composition harness at `after-admission-before-run`, `after-native-result-before-ledger-finish`, and `after-ledger-finish-before-http-response`. No production environment variable enables them.

```ts
test("restart never replays an interrupted accepted prompt", async () => {
  const scenario = await startAcceptanceScenario({
    pauseAt: "after-admission-before-run",
  });
  const id = "1534b4d4-8c6f-4f78-9424-eb05051d6a59";
  try {
    await scenario.submitWithoutWaiting(id, "synthetic crash case");
    await scenario.waitForFailpoint();
    scenario.service.signal("SIGKILL");
    await scenario.service.exit;
    await scenario.restart();
    expect((await scenario.client.operation(id)).state).toBe("interrupted");
    expect(await scenario.fakeCallCount()).toBe(0);
  } finally {
    await scenario.close();
  }
});
```

`startAcceptanceScenario` is a thin test helper over the existing process harness, exporting the methods used above plus `close`. Its call count persists in the **test harness**, not BRN state, so restart cannot reset the assertion to zero accidentally.

Cover the acceptance matrix below with named tests and one explicit expected outcome per fault:

| Scenario | Required outcome |
|---|---|
| Second start while owner is running or SIGSTOP'd | no writable Pi/operation store opens in the second process |
| Owner SIGKILL | OS releases lock; next launch preserves ledger and marks unfinished work interrupted |
| Client exits during streaming | provider continues; reconnect gets same operation/result |
| Lost success response | repeat same prompt ID returns original saved outcome |
| Changed payload for saved ID | `REQUEST_ID_REUSED`, including after restart |
| Native result durable, ledger not finished | interrupted with inspectable native evidence, never automatic replay |
| Ledger completion durable, client not informed | saved success recovered by operation ID |
| Abort requested but unsettled | all session/model/new-prompt writes still busy |
| Startup SQLite corruption/version mismatch | visible mutation failure; no deletion/rebuild of authoritative bytes |
| Snapshot during state change or slow reader | current state restored after reconnect, no provider duplication |
| Poisoned ambient configuration/resources | no tool/resource escape through the actual SDK |
| Sensitive marker in prompt/response/provider error | absent from operational logs, present only where intentionally stored/displayed |
| Stopped-service copy restored to a new root | operation status and native result references resolve; old root unchanged |

- [ ] **Step 2: Run red acceptance tests and fix only coupled defects.**

Run `npm run build && npm test -- test/acceptance/service-terminal.test.ts`.
Expected: any missing crash/reconnect/durability behavior fails at its named invariant. A passing fake does not excuse a failed SDK check. Implement fixes at the shared module that owns the invariant, then rerun its targeted tests together with this file.

- [ ] **Step 3: Write the operational runbook and stopped-copy procedure.**

Document:

```bash
npm ci
npm run build
npm run service -- --state-dir /absolute/path/to/disposable-brn-state
# In another terminal; this does not spawn a service:
npm run brn -- --state-dir /absolute/path/to/disposable-brn-state status
npm run brn -- --state-dir /absolute/path/to/disposable-brn-state models
npm run brn -- --state-dir /absolute/path/to/disposable-brn-state new --model PROVIDER/MODEL
npm run brn -- --state-dir /absolute/path/to/disposable-brn-state chat
```

`PROVIDER/MODEL` is a user-selected authenticated identity from `models`, not a guessed default. The CLI must display the concrete selected identity and the operating limits before first submission.

Explain existing Pi credential reuse without copying secrets; BRN-owned sessions/settings; absent browser/vault tools; one operation; busy/cancellation policy; client-versus-owner exit; interrupted-versus-failed/succeeded results; Pi's permissive native loader limits; and the fact that model context/compaction is not a hard spending cap.

For backup rehearsal: stop and wait for the owning process, verify no writer holds the state root, copy the **complete** A root (including SQLite sidecars if present and native sessions) to a separate owner-only directory, and start only the restored copy. Credentials remain in their existing Pi-managed location and are not copied by this procedure. Confirm operation lookup and native result reopening using synthetic state. Never copy only the main SQLite file while the service is live. This is A's stopped-state rehearsal, not completion of D/K's full future backup requirements.

Document that no lock/discovery deletion, force takeover, prompt replay, JSONL repair, or automatic data pruning is an approved recovery command.

- [ ] **Step 4: Add a fail-closed live-proof entry point.**

The live test must require all of: `BRN_LIVE_PROOF=I_AUTHORIZE_SYNTHETIC_CHAT`, a separately supplied disposable `BRN_LIVE_STATE_DIR`, and an explicit `BRN_LIVE_MODEL`. It never reads a vault, imports files, or enables tools. It is excluded from `npm test`.

```ts
import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";

test("authorized synthetic conversation through the production CLI", async () => {
  if (process.env.BRN_LIVE_PROOF !== "I_AUTHORIZE_SYNTHETIC_CHAT") {
    throw new Error("LIVE_PROVIDER_AUTHORIZATION_REQUIRED");
  }
  const root = process.env.BRN_LIVE_STATE_DIR;
  const model = process.env.BRN_LIVE_MODEL;
  if (!root || !model) throw new Error("LIVE_PROOF_CONFIGURATION_REQUIRED");
  const proof = await startProductionProof(root, model);
  try {
    const result = await proof.prompt({
      requestId: randomUUID(),
      text: "Reply with a short greeting. This is synthetic BRN integration data.",
    });
    expect(result.state).toBe("succeeded");
    expect(result.usage.output).toBeLessThanOrEqual(4096);
    expect(result.text.trim().length).toBeGreaterThan(0);
    await proof.disconnectAndReconnect();
    expect(await proof.resultText(result.id)).toBe(result.text);
  } finally {
    await proof.close();
  }
}, 150_000);
```

`startProductionProof(root,model)` belongs to this live test/support, spawns the **production** service and compiled CLI, creates a new explicit session, submits through the standalone `prompt` command, and obtains structured operation/native-result data through the authenticated client. It refuses a preexisting nonempty proof root. It waits for service exit on cleanup and never deletes a user-selected root recursively.

Do not run this command until the user separately approves the actual provider/model, limits, shared-credential use and synthetic prompt:

```bash
BRN_LIVE_PROOF=I_AUTHORIZE_SYNTHETIC_CHAT \
BRN_LIVE_STATE_DIR=/absolute/path/to/new-disposable-proof-state \
BRN_LIVE_MODEL=PROVIDER/MODEL \
npm run test:live
```

Also perform a short conversation from the actual main-screen terminal after approval, including multiline composition and Ctrl+C behavior. Scripted CLI success is evidence for the transport/runtime path, not evidence that the editor works on the target terminal. Use synthetic text only.

- [ ] **Step 5: Run the final A evidence gates and record their actual outcomes.**

Run `npm ci && npm run build && npm run typecheck && npm run lint && npm test`. This is the first full default-suite pass after targeted task checks. Real-SDK tests remain offline and default; the live test remains separately gated. Record named failures honestly and do not mark A complete if the authorized provider proof or actual terminal journey is outstanding.

In the authorized implementation issue/runbook, record exact package/Node versions, macOS/terminal, commands, test names, synthetic provider/model, operation ID, duration and usage totals. Do not publish credentials, tokens, prompts/responses from personal work, session files, or local private paths. A provider rejection/timeout is not a successful proof.

- [ ] **Step 6: Commit only A's completed deliverable.**

```bash
git add test/acceptance/service-terminal.test.ts test/live/provider-chat.test.ts docs/capability-a-operations.md README.md
git commit -m "test: prove BRN service lifetime and recovery journeys" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If Step 2 changed production files, stage those exact reviewed files in this commit too. Do not `git add -A` in a checkout containing unrelated work. No push/merge follows automatically.

## Acceptance coverage

| Capability A requirement | Implementing tasks and evidence |
|---|---|
| Pinned install/build/type compatibility and FTS5 | Task 1 toolchain/probe; Task 7 clean install |
| Independent foreground ownership, authenticated loopback, zero second writer | Task 1 real-process tests; Task 7 stopped/crashed owner tests |
| Actual SDK construction, isolated resources, native session reopen | Task 3 official faux-provider SDK tests |
| No exposed canonical mutation, filesystem, shell or future stub tools | Task 3 zero-tool/ambient traps; Task 4 replacement tests |
| One active conversation/operation, busy rejection and safe switches | Tasks 2, 3 and 5; two-client Task 6 journey |
| Real streaming, model/context/usage and compaction translation | Tasks 4, 5 and 6 |
| Durable outcomes, duplicates, disconnect, restart without paid replay | Tasks 2, 4 and 5; Task 7 failpoints |
| Cancellation/shutdown without stale bindings or orphaned writer | Tasks 1-4; Task 7 process tests |
| Multiline main-screen terminal, session/model commands | Task 6 plus actual terminal journey in Task 7 |
| Input/output/retry/deadline controls and provider disclosure | Tasks 2 and 4; authorized selected-provider proof in Task 7 |
| One explicitly authorized live conversation through the terminal | Task 7 only; never inferred from offline/fake success |

## Source evidence and implementation cautions

The following pinned primary sources were inspected for this plan. They support the proposed interfaces, not a claim that BRN has already run them.

- [Pi SDK options](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/sdk.ts#L39-L88): no per-prompt hard budget field; explicitly supplied resources/settings avoid default discovery.
- [Public SDK isolation example](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/examples/sdk/12-full-control.ts): explicit resource loader and in-memory settings.
- [Runtime replacement example](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/examples/sdk/13-session-runtime.ts#L38-L67): subscriptions must be rebound after replacement.
- [Model runtime configuration](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/model-runtime.ts#L172-L217): `modelsPath:null`, credential selection and refresh controls.
- [Authenticated model discovery](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/model-runtime.ts#L384-L420): catalog lookup and authenticated availability are distinct.
- [Empty tool allowlist regression](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/test/suite/regressions/2835-tools-allowlist-filters-extension-tools.test.ts#L85-L93): `tools:[]` excludes all registered tool names.
- [Native session persistence](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/session-manager.ts#L1029-L1056): a new empty session is not necessarily materialized on disk.
- [Native session create/open/list](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/session-manager.ts#L1546-L1679): explicit session directories and server-side path mapping.
- [Abort settlement](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts#L1616-L1632): abort also concerns retries and compaction.
- [Pi event union](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts#L143-L185): `agent_end` is not always final settlement.
- [Agent failure conversion](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts#L486-L527): errors can become terminal assistant messages rather than rejected prompt promises.
- [Overflow recovery](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts#L2158-L2201): independent of ordinary retry settings.
- [Unknown context semantics](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts#L3383-L3427): preserve null/unknown after compaction.
- [Official faux provider](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/providers/faux.ts#L685-L707): real SDK can run with an in-process synthetic provider.
- [Pi main-screen TUI](https://github.com/earendil-works/pi/blob/v0.85.1/packages/tui/README.md): supported main-buffer editor and raw-mode input listeners.
- [Pinned Node SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html): synchronous connections, explicit defensive/extension/parameter settings and busy timeout.
- [SQLite file locking](https://www.sqlite.org/lockingv3.html): exclusive-lock semantics underpin the dedicated writer connection; validate with real-process tests on target macOS.
- [TypeBox value exports](https://github.com/sinclairzx81/typebox/blob/1.3.7/src/value/index.ts): `Value.Check` is available through `typebox/value`.

## Deferred work

B-K remain separate future capability plans. Do not add schema/front-matter parsing, approved-record fixtures, draft tables, comment anchors, publication recovery, retrieval adapters, migration tooling, browser bootstrap, Workers or speculative generic extension points while executing A. A's operation state and stopped-copy rehearsal do not establish those later product guarantees.
