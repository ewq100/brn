# Capability A design: BRN service and terminal conversation client

**Status:** Draft, awaiting technical-plan user review. No implementation exists.
**Date:** 2026-09-09.
**Scope owner:** Capability A only (see [brn-plan.md](../../brn-plan.md), section "Implementation capabilities").
**Supersedes for A:** the shared background-service wording in [product-spec.md](../../product-spec.md) (already aligned) and the full-screen-terminal assumption in #40 (see Open reconciliations).

## Goal

Start an independent foreground BRN service that hosts the pinned Pi SDK in-process, connect a small terminal conversation client over authenticated loopback HTTP and SSE, and complete a real conversation. Prove service construction, terminal streaming, tool and resource restrictions, session replacement, cancellation, reconnect, and single-writer protection. No model route to canonical mutation exists in A.

## Non-goals

Custom full-screen terminal panels, the browser document client, Workers, canonical search/read tools, retrieval, import, publication, and an always-on daemon. Those belong to later capabilities (B–K). A registers no canonical tools; it registers one trivial no-op tool solely to prove the restriction seam works.

## What the SDK actually gives us (verified 2026-09-09)

Read from the installed `@earendil-works/pi-coding-agent@0.85.1` docs and `dist/` type declarations, not assumed:

- `createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions, ... })` builds cwd-bound services and returns `AgentSessionServices { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics }`. Confirmed in `dist/core/agent-session-services.d.ts`.
- `createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel, scopedModels, tools, excludeTools, noTools, customTools })` builds the `AgentSession`. **`noTools` and `customTools` are accepted here**, so all built-in tools can be disabled while a single BRN tool is registered. Confirmed in the same declaration file.
- `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })` owns session replacement: `newSession()`, `switchSession(file)`, `fork(entryId)`, `importFromJsonl()`. `runtime.session` changes after each; **event subscriptions and `session.bindExtensions(...)` must be re-bound after replacement** (docs "createAgentSessionRuntime", example `examples/sdk/13-session-runtime.ts`).
- `AgentSession` exposes `prompt(text, options)`, `steer(text)`, `followUp(text)`, `abort()`, `subscribe(listener) => unsubscribe`, `setModel(model)`, `cycleModel()`, `setThinkingLevel(level)`, `messages`, `isStreaming`, `sessionId`, `sessionFile`, `dispose()`.
- Events include `message_update` (with `assistantMessageEvent.type` of `text_delta` / `thinking_delta`), `tool_execution_start|update|end`, `turn_start|turn_end`, `agent_start|agent_end`, `queue_update`, `compaction_start|end`, `auto_retry_start|end`.
- `ModelRuntime.create({ authPath, modelsPath, credentials, allowModelNetwork, modelRefreshTimeoutMs, signal })`. `getAvailable()` returns only authenticated models. `PI_OFFLINE` disables network. Public model/auth ops are unbounded unless an `AbortSignal` is passed; the SDK application owns deadline policy.
- `SessionManager.create(cwd)`, `.inMemory(cwd)`, `.open(path)`, `.continueRecent(cwd)`, `.list(cwd)`, `.listAll()`. Sessions are JSONL trees (v3), auto-migrated on load; the loader **skips malformed lines** (session-format.md), so BRN must keep a recoverable pre-change snapshot rather than rely on a passive strict-validation API.
- A fully controlled `ResourceLoader` (see `examples/sdk/12-full-control.ts`) returns empty extensions/skills/prompts/themes/agentsFiles and supplies `getSystemPrompt()`. This is how ambient discovery is suppressed. BRN can build `AgentSessionServices` with this loader directly instead of `DefaultResourceLoader`.
- Pi has **no OS sandbox** (security.md). Project trust is only an input-loading guard. Restrictions in A bound the model's exposed capabilities, not a same-user process. Non-interactive modes never show a trust prompt.
- Pi RPC is a headless subprocess protocol, not a BRN client/service contract (#40 forbids Pi RPC and JSONL parsing). BRN hosts the SDK directly and defines its own HTTP/SSE contract.

**No integration code, real-SDK check, or live-provider call was run during this design.** These facts come from docs and type declarations only. Task 1 and Task 3 of the plan turn them into executable evidence.

### One open SDK question for Task 3

The runtime factory (`createAgentSessionRuntime`) shown in the docs calls `createAgentSessionServices` + `createAgentSessionFromServices` but the documented factory example does not pass `noTools`/`customTools`/a custom `resourceLoader` through. The declarations show those options exist on `createAgentSessionFromServices` and that `AgentSessionServices.resourceLoader` is a plain field. The plan's Task 3 must verify, against the real SDK offline, that a BRN factory can (a) construct services with a BRN-controlled `resourceLoader`, (b) pass `noTools: "all"` + `customTools: [pingTool]`, and (c) preserve both across `runtime.newSession()` / `switchSession()`. If a supported seam cannot carry all three through the replacement path, record the exact limitation and prefer `createAgentSession()` directly with a thin BRN-owned replacement wrapper rather than a private-method bridge.

## Architecture

```text
Terminal conversation client ──┐
                               ├── authenticated loopback HTTP + SSE (127.0.0.1:random)
(browser document client, B–K) ┘                 │
                                        Foreground BRN service (one process)
                                          ├── single-instance lock + runtime discovery file
                                          ├── node:http router (JSON + SSE + static)
                                          ├── Pi adapter: ModelRuntime, AgentSessionRuntime
                                          │     controlled ResourceLoader, noTools:"all" + 1 BRN tool
                                          ├── operation registry (one active op, durable ids)
                                          └── node:sqlite DatabaseSync (single writer)
```

Folder seams follow #40: `core/` (no client/transport/Pi/SQLite imports), `protocol/` (browser-safe TypeBox contracts), `service/` (process, HTTP/SSE, Pi adapter, SQLite), `cli/` (terminal client). One package, strict ESM, erasable TypeScript only (no enums, namespaces, decorators).

### Transport and single-instance ownership (from #21, #40)

- First launcher acquires the single-instance lock atomically, binds `127.0.0.1` on a random port, and owns the service lifetime. Later launchers attach to the healthy instance.
- Runtime discovery file (owner-only permissions) holds port, pid, random instance id, and a random CLI bearer token. Distinguish pid reuse from the same process.
- Reclaim a stale lock only after proving the previous process is gone. If a lock exists but the service does not answer, refuse a second writer. Provide a confirmed force-stop that verifies exit before recovery.
- Authenticate every request: terminal client uses an `Authorization: Bearer <token>`. (Browser one-use fragment token exchanged for an HttpOnly `SameSite=Strict` cookie is specified but implemented in H, not A.)
- Require the exact service `Host`. Emit no CORS headers. JSON error envelopes reveal no vault, credential, or process detail. Health and readiness endpoints. SSE reconnect with a race-free snapshot-to-live handoff (bounded in-memory buffer or resynchronize; no durable replay log).
- Owner-only structured logs carry operational metadata only: never credentials, tokens, prompts, or provider responses.

### Pi adapter and restrictions (from #27, #33, #40)

- One shared `ModelRuntime` using Pi's normal `auth.json` credential store (isolated config/session roots in tests). Provider secrets are never persisted by BRN or sent to a client.
- One `AgentSessionRuntime` for the single active conversation. Re-bind subscriptions after any session replacement.
- Controlled `ResourceLoader` loads only BRN system instructions. `noTools: "all"` disables every built-in; A registers exactly one TypeBox-defined no-op tool (`brn_ping`) to prove custom-tool registration and that built-ins stay absent. No canonical search/read, no shell, no filesystem tool, no Pi RPC passthrough.
- Approval and publication do not exist as tools in A (and never become model-callable in later capabilities).

### Durable BRN operations (from D10, #27, #21)

A **BRN operation** is one agent run, from an accepted prompt to its terminal result. The operation registry, backed by SQLite, is the durable record; native Pi JSONL stays authoritative for conversation content.

- One active operation at a time. A new prompt while an operation runs is rejected visibly (HTTP 409 with a typed envelope), not queued. `steer`, `followUp`, and `abort` against the active operation are allowed.
- Each operation row: `id` (BRN-owned uuid), `session_id`, `status` (`accepted` \| `streaming` \| `succeeded` \| `failed` \| `cancelled` \| `interrupted`), `created_at`, `ended_at`, `result_summary`, `usage_json`.
- Client disconnection is not cancellation. Reconnect fetches the operation's current status and saved result by id; it never resubmits. Duplicate submit of the same client-supplied idempotency key returns the existing operation.
- Service shutdown cancels provider work and marks any in-flight operation `interrupted`. Restart reports interrupted operations and never auto-replays paid work.

### Storage (from #40)

- One BRN `node:sqlite` `DatabaseSync`, single writer. Open with extension loading disabled, foreign keys enabled, unknown named parameters rejected, and defensive mode enabled.
- Startup verifies FTS5 support (`node:sqlite` is release-candidate in Node 24; the pinned Node build must expose FTS5) and fails with a useful error otherwise, even though A itself does not query FTS5.
- A's schema is the operation registry plus a schema-version table. Retrieval indexes are out of scope for A.

### Terminal client (from plan "Ownership and client responsibilities")

A small line-oriented client over the BRN client interface, not Pi's native terminal:

- Multiline input, streamed assistant text, readable tool status lines, cancellation, `new`/`resume` session commands, model selection, and context/usage display.
- Reads SSE through `fetch()` response streams (no SSE library, per #40). Uses LF-only record framing.
- Stays a thin client: it holds no authoritative state and never opens Pi session files directly.

## Provider budgets, retries, and credentials (D8)

Explicit numeric defaults for A, tunable later:

- Per-operation wall-clock deadline: **180 s**. On expiry, `abort()` the run and mark the operation `failed` with a `deadline_exceeded` reason.
- Provider retries: **max 2**, via `SettingsManager` `retry: { enabled: true, maxRetries: 2 }`. No automatic paid replay after service restart.
- Model catalog refresh: bounded by an `AbortSignal.timeout(15_000)`; on timeout, use cached models and warn. `PI_OFFLINE` respected.
- Credentials: use Pi's `auth.json` via `ModelRuntime`. Live-provider use is opt-in and explicit; the hermetic gate never calls a provider. Document the one-time credential setup (`ANTHROPIC_API_KEY`/OAuth) in the service README section.

## Acceptance (mirrors brn-plan.md capability A)

- [ ] The pinned package set installs, builds, and type-checks; target SQLite exposes FTS5.
- [ ] Isolated real-SDK checks construct the service runtime, reopen native sessions, and verify tool/resource restrictions offline.
- [ ] One explicitly authorized live-provider chat succeeds through the terminal client.
- [ ] Session replacement, cancellation, and shutdown leave no stale bindings or orphaned writer.
- [ ] Client disconnection leaves accepted work running; reconnect retrieves current status and saved results without duplicate submission.
- [ ] Busy agent work and session switches follow the explicit single-operation policy.
- [ ] The service and client use supported interfaces without a Pi fork or native-terminal remote bridge.

## Test strategy (three separated layers)

1. **Deterministic fake tests (hermetic gate, Vitest).** A Pi adapter fake implements the BRN adapter seam without contacting Pi or a provider. Covers transport, auth, single-instance, operation policy, reconnect, and terminal rendering.
2. **Real-SDK offline checks (Vitest, tagged, no provider).** Construct the real `AgentSessionRuntime` with isolated config/session roots and `PI_OFFLINE`. Verify runtime construction, native session create/reopen, event wiring, `noTools: "all"` + `brn_ping` registration, and that built-ins are absent. No network.
3. **Opt-in live smoke (explicit env flag).** One authorized real-provider chat through the terminal client end to end. Skipped by default.

## Open reconciliations (parent owns GitHub writes)

- **#40 full-screen terminal vs. A's small client.** #40 selects `@earendil-works/pi-tui@0.85.1` for a full-screen terminal and forbids embedding `InteractiveMode`. The approved plan defers the full-screen product and ships a small line client. A does not need pi-tui; plain readline plus ANSI output suffices. Reconcile #40's CLI/TUI section with the small-client scope.
- **#33 tool catalog vs. A's empty catalog.** #33 registers `search_records`, `read_record`, `delegate_worker`, etc. A registers none of these (they belong to B/F and Workers are deferred); A registers only `brn_ping`. Reconcile #33 so A is not expected to expose canonical tools.
- **#27 per-session command queue vs. A's single-operation policy.** #27 describes ordered command admission with steer/abort passthrough. A adopts the plan's simpler one-active-operation-with-visible-rejection policy while keeping steer/abort reaching the active run. Reconcile the queue wording with the single-operation scope.
- **#21 browser cookie auth.** Fully specified in #21 but implemented in H. A implements bearer auth and Host checks; the browser fragment-token/cookie exchange is designed but deferred.

## References

Installed Pi 0.85.1: `docs/sdk.md`, `docs/security.md`, `docs/session-format.md`, `docs/rpc.md`, `examples/sdk/12-full-control.ts`, `examples/sdk/13-session-runtime.ts`, `dist/core/agent-session-services.d.ts`. GitHub: #21, #27, #33, #40. Plan: [brn-plan.md](../../brn-plan.md) (capability A, D8, D10, stack baseline). Evidence log: [brn-a-planning-evidence.md](../../research/brn-a-planning-evidence.md).
