# Pi runtime integration boundary

Status: resolved for BRN v1

Pi version examined: `@earendil-works/pi-coding-agent` 0.84.4, released 2026-08-28

Research date: 2026-09-05

## Decision

BRN should run one app-owned local service and embed Pi through its TypeScript SDK. The CLI and web app should both connect to that service. They must not each start Pi or open session files themselves.

Pi supplies the agent loop, provider authentication, model catalog, persisted session format, session replacement, event stream, model switching, compaction, context accounting, and tool registration. Pi does not supply a multi-client daemon, HTTP or WebSocket transport, session ownership, a durable workflow engine, built-in subagents, or a security boundary around local files. BRN must build those parts.

For each open conversation, the service should own exactly one `AgentSessionRuntime`. It should share one process-wide `ModelRuntime` and one configured session directory across all conversations. BRN must serialize commands per session and fan the resulting Pi events out to every attached CLI or web client. `SessionManager.list()` provides the common session index and `AgentSessionRuntime.switchSession()` resumes a selected session. Do not open one JSONL session in two Pi runtimes at once.

The human-vault rule cannot rest on a prompt or Pi's project-trust feature. Start sessions without built-in mutation or shell tools, expose only BRN-owned read/query and proposal tools, and keep the deterministic human-vault commit operation outside the model's tool registry. Do not load arbitrary extensions. If "Pi never receives write access" means an operating-system security boundary, Pi must run in a separate process whose account or sandbox sees the human vault read-only. Pi explicitly has no built-in sandbox.

## What Pi supports

| Concern | Supported Pi mechanism | Hard constraint or caveat | BRN responsibility |
|---|---|---|---|
| Embedding | `createAgentSessionRuntime()` and `AgentSessionRuntime` are the supported layer for applications that need new, resume, fork, clone, or import flows. Pi's own interactive, print, and RPC modes use this layer. | A runtime has one active `AgentSession`. Session replacement changes `runtime.session`; subscriptions and extension bindings are session-local and must be rebound. | Own the long-lived local service, keep the runtime registry, rebind event forwarding after replacement, and expose an app API to both clients. |
| Alternative process protocol | `pi --mode rpc` and `runRpcMode()` provide strict LF-delimited JSONL over stdin/stdout. The protocol covers one active session, prompting, events, model changes, compaction, stats, and session switching. | RPC is designed for subprocess or non-TypeScript integration. It has no command to list all sessions and no login/logout command. It is not a network server or a multi-session router. | Prefer the SDK for this TypeScript product. If process isolation is required, BRN must supervise Pi workers and add its own service API, session listing, and auth flow. |
| Session persistence and discovery | `SessionManager.create`, `open`, `continueRecent`, `list`, and `listAll`; JSONL v3 append-only trees; `SessionInfo` includes id, path, cwd, name, dates, message count, and preview text. | Pi groups default session storage by cwd. A custom `sessionDir` can give BRN an app-owned location. `SessionManager` keeps an in-memory entry index and appends directly to its file. It does not document multi-writer coordination. | Choose one fixed BRN cwd/session directory, map public session IDs to files, refresh the shared list after mutations, and ensure only one live owner writes a session file. |
| Resume and history | `AgentSessionRuntime.switchSession(path)` rebuilds cwd-bound services and replaces the active session. `getEntries()`, `getTree()`, and stable entry IDs support incremental history and branch display. | A subscription belongs to the old `AgentSession`; it does not follow replacement. Session files include full tool inputs/results and model output, including compacted and abandoned history. | Reattach listeners, authorize requested session paths, convert Pi events/entries to the product's content-first view, and treat session files as sensitive agent-vault data. |
| Authentication | One shared `ModelRuntime` resolves runtime overrides, `auth.json`, environment variables, then custom-provider keys. It exposes provider discovery, `checkAuth`, `getAvailable`, `login`, `logout`, runtime API-key methods, and injectable credential storage. OAuth refresh is handled by Pi. | The SDK caller supplies the `AuthInteraction` callbacks and owns timeouts for remote operations. File credentials default to `~/.pi/agent/auth.json`; the file is created with mode `0600`. RPC does not expose login/logout. | Build CLI and web login UI around one service-owned `ModelRuntime`. Pick an app-specific auth path or credential store, never send secrets to browser storage, and report `CredentialSynchronizationError` without blindly repeating a credential mutation. |
| Default and available models | `ModelRuntime.getAvailable()` returns models with usable authentication. Cached model catalogs permit startup without a network refresh. `resolveCliModel()` and `resolveModelScopeWithDiagnostics()` reproduce CLI selection rules. | `ModelRuntime.create()` restores cached catalogs but does not refresh remotely unless requested. Refresh and auth calls are unbounded without an `AbortSignal`. | Store the BRN default-model choice, apply a deadline to refresh/login operations, and present only authenticated models. |
| Mid-session model change | `AgentSession.setModel(model)` validates auth and appends a `model_change` entry. Existing messages stay in the same session tree. On resume, Pi reconstructs the selected model from model-change and assistant entries. | A changed model receives the context Pi rebuilds from prior history; Pi does not migrate or rewrite old messages. Model capabilities and context limits can differ. Pi does not document model mutation during an active stream as safe. | Expose the model picker in both clients, resolve models through the shared `ModelRuntime`, require the session to be idle or abort and wait, call `setModel` on the authoritative session, and publish the resulting state change. |
| Compaction | Automatic compaction is enabled by default. It runs near the context limit and on overflow; overflow recovery compacts and retries. `session.compact()` is the manual API. Full history remains in JSONL while the active LLM context uses a summary plus retained recent messages. | Compaction is lossy for model context. Defaults are a 16,384-token response reserve and 20,000 recent tokens. Immediately after compaction, measured context tokens and percentage are `null` until a later model response supplies usage. | Keep Pi's default compaction for v1, forward compaction lifecycle and errors, and do not invent handover behavior. |
| Context display | `AgentSession.getSessionStats()` returns lifetime token/cost totals plus `contextUsage`; `getContextUsage()` returns `{tokens, contextWindow, percent}`. RPC exposes the same data through `get_session_stats`. | Lifetime token totals are not current context usage. Current usage is an estimate based on the latest assistant usage plus trailing messages, and may be unknown. | Show `contextUsage.percent`, explicitly handle unknown values, choose warning colors/thresholds as product UI policy, and update after message and compaction events. |
| Agent tools | `createAgentSession` accepts a tool allowlist, `noTools`, `excludeTools`, and typed `customTools`. Extensions may register tools and intercept or block `tool_call`. Tool calls and results arrive on the session event stream. | Default tools include `read`, `bash`, `edit`, and `write`. Tool-event guards are policy hooks, not isolation. Extensions execute arbitrary TypeScript with the process user's permissions. | Disable built-in mutation and shell tools. Register a small app-owned catalog for scoped read/search, agent-vault state, and proposal creation. Validate every tool input in code. |
| Subagents | Pi's official example implements a `subagent` custom tool by starting separate Pi processes. It supports isolated context, streaming, parallel and chained calls, and usage reporting. | Pi's core intentionally has no built-in subagent feature. The example's child processes inherit whatever files, credentials, tools, and prompts the launcher gives them. | Implement delegation only if required by a v1 workflow. Apply the same restricted tool catalog and filesystem policy to every child, record parent/session linkage, and aggregate events and usage. |
| Workflows | Skills and prompt templates provide reusable instructions. Extensions and custom tools can coordinate code and persist custom session entries. | Pi explicitly has no built-in plan mode or to-do system. Prompt templates are not a durable workflow engine, and arbitrary extension state is not the product's canonical operational state. | Implement ingestion, writing, approval, task, retry, and workflow state machines in shared BRN services backed by the agent vault. Pi may reason or call a transition tool, but it must not own transition validity. |

Pi documents the SDK and RPC split in its [SDK guide](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#run-modes) and [RPC guide](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/rpc.md). Session APIs and replacement behavior are documented under [session management](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#session-management) and [`AgentSessionRuntime`](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#createagentsessionruntime-and-agentsessionruntime).

## Runtime shape for v1

The supported boundary is small:

```text
CLI client ─┐
            ├─ BRN local service
Web client ─┘    ├─ client transport, session registry, per-session command queue
                 ├─ one shared Pi ModelRuntime
                 ├─ one AgentSessionRuntime per live session
                 ├─ BRN domain/workflow services and agent vault
                 └─ restricted Pi tools
                       ├─ human-vault read/search
                       ├─ agent-vault operations
                       └─ create/replace proposal

User approval ─> deterministic BRN validator ─> BRN commit service ─> human vault
```

There is no supported Pi API that turns one `AgentSessionRuntime` into a multi-session daemon. The service must keep a registry of active runtimes or evict idle ones and reopen them with `SessionManager.open()` when needed. Both clients should address the BRN service by Pi session ID. The service resolves the path from its own `SessionManager.list()` result instead of accepting arbitrary client paths.

One authoritative owner matters. Pi's [`SessionManager`](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/session-manager.ts) loads a session into memory and persists entries with synchronous file appends. Its public docs promise append-only trees, but they do not promise locking or cross-process reconciliation. Two runtimes opened on the same file could choose stale parents and diverge. BRN should reject or attach a second client to the existing runtime, never create a second writer.

Pi emits streaming and lifecycle events through `AgentSession.subscribe()`. BRN can translate those events once and broadcast the same stream to CLI and web. Incoming prompts need per-session serialization. If a run is active, BRN must deliberately select Pi's `steer` or `followUp` behavior rather than call `prompt()` without a streaming policy. The relevant queue semantics are in the [SDK prompting section](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#prompting-and-message-queueing).

## Session, model, and context details

Pi's [session format](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/session-format.md) is already enough for v1 history. It records named sessions, model changes, thinking-level changes, messages, tool results, compactions, branch summaries, and extension entries. BRN should consume the public `SessionManager` and `AgentSession` APIs instead of parsing or writing JSONL itself. Direct parsing would couple the product to migrations and context-rebuild rules.

Changing models does not create a session. `setModel()` saves the change in the transcript, while the previous messages remain on the active branch. This directly supports the product requirement that a replacement model continue the same conversation. Pi's persisted [`ModelChangeEntry`](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/session-format.md#modelchangeentry) makes the choice survive resume.

Pi's context percentage is the right input for the chat warning. Use `getSessionStats().contextUsage` rather than dividing lifetime token totals by the current model's window. The [RPC stats contract](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/rpc.md#get_session_stats) spells out the difference and the post-compaction `null` state. Warning bands themselves are BRN presentation policy.

Pi's [compaction algorithm](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/compaction.md#compaction) and settings meet the v1 requirement. BRN should preserve automatic compaction, surface `compaction_start` and `compaction_end`, and leave the full transcript available. It should not build a parallel summarizer or force a new session.

## Authentication boundary

Use one service-owned `ModelRuntime`, created with an app-specific credential path or credential store. The documented precedence is runtime override, stored credential, environment, then custom provider fallback. Pi's [SDK auth API](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#api-keys-and-oauth) supports status checks, API-key injection, login, logout, and OAuth. The provider guide documents the [credential file and its permissions](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/providers.md#auth-file).

The service, not either presentation client, owns credentials. A CLI or browser may render an `AuthInteraction`, but secrets and refresh tokens return to `ModelRuntime` and stay out of web storage and session JSONL. BRN still needs to design the local transport's origin checks and authorization. Pi's auth is provider authentication, not authentication between the browser, CLI, and local BRN service.

## Human-vault enforcement

Pi's security documentation is unambiguous: it runs with the launching user's permissions, project trust is only an input-loading guard, extensions run arbitrary code, and Pi has [no built-in sandbox](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/security.md#no-built-in-sandbox). The official protected-path example blocks `write` and `edit` calls in a hook, but a shell tool or extension can bypass that check. It is useful defense in depth, not the product's trust boundary.

For v1, enforce capabilities by construction:

1. Do not expose built-in `write`, `edit`, `bash`, or `powershell` to the model. Pi documents the [`tools`, `noTools`, `excludeTools`, and `customTools` controls](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#tools).
2. Do not use uncontrolled user or project extensions, packages, skills, or prompt discovery in the product runtime. An extension has normal process access regardless of the active model tools.
3. Provide BRN-owned read/search tools that canonicalize paths and limit reads to intended vault roots. Provide proposal tools that write only through the agent-vault repository.
4. Keep approval, immutable proposal freezing, deterministic validation, and exact commit outside all LLM-callable tools. A human action invokes the BRN commit service with a frozen proposal identifier and digest.
5. Test every exposed tool and every delegated child against path traversal and symlink escape. A prompt saying "do not write" is not enforcement.

This removes a model-callable route to the human vault. It does not remove the operating system permission from in-process Pi or from trusted extension code. If the product specification requires literal filesystem denial, follow Pi's [isolation guidance](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/security.md#running-untrusted-or-unmonitored-work): run Pi in a separate process, container, VM, or policy-controlled sandbox; mount the human vault read-only; mount the agent vault read/write; and keep the commit service outside that boundary. BRN would still expose one local service to its clients, but that service would supervise the isolated Pi worker.

## Tools, subagents, and workflows

The supported extension point is a typed custom tool passed to `createAgentSession({ customTools })` or registered by a controlled extension. Pi validates the TypeBox input and records tool results in the session. Tool events support progress and cancellation. The [custom-tools documentation](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md#custom-tools) is sufficient for BRN's read, retrieval, task, and proposal commands.

Subagents are an official example, not a core facility. Pi's own README states ["No sub-agents"](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/README.md#philosophy), while the [subagent example](https://github.com/earendil-works/pi/tree/v0.84.4/packages/coding-agent/examples/extensions/subagent) implements delegation by spawning isolated Pi subprocesses. BRN must decide which product actions merit delegation and own limits, cancellation, parent-child records, tool policy, and result handling. Installing the example unchanged would give its children a coding-agent-oriented tool and prompt configuration that does not match the vault boundary.

Likewise, skills and prompt templates package instructions; they do not make an operation durable or valid. The agent-vault workflow record remains authoritative. A BRN workflow service decides allowed transitions and exposes narrow actions as tools. Pi can execute or advise within a step.

## BRN-owned work

The implementation backlog should include:

- a launch-scoped local service and client transport for CLI and web
- a shared `ModelRuntime`, login interaction adapters, credential location, and timeout/error policy
- a live-session registry with one writer and a per-session command queue
- session-list projection, resume, event replay or reconnect behavior, and client fan-out
- event-to-view-model translation that hides technical traces by default
- context-warning presentation and unknown-usage handling
- a controlled `ResourceLoader` and explicit tool catalog
- canonicalized human-vault read/search tools and agent-vault proposal/task tools
- deterministic approval, validation, immutable commit, and retry services outside Pi tools
- optional process or sandbox isolation if literal filesystem denial is required
- BRN workflow state and, only where justified, restricted subagent orchestration

## Gaps and decisions exposed

1. **Strength of the vault boundary.** A restricted tool catalog prevents model-directed writes, but only process isolation plus read-only filesystem access prevents Pi or extension code from writing. The map must state which guarantee v1 requires.
2. **Live-session policy.** The service needs a limit and eviction rule for loaded runtimes, plus behavior when both clients attach to one session. Pi does not choose this.
3. **Local client transport.** Pi offers SDK events and stdio RPC, not the HTTP/WebSocket endpoint needed by the web app. BRN must choose the local protocol and browser-origin protection.
4. **Resource policy.** Standard Pi discovery loads user and project customization. BRN must decide whether product sessions reject all uncontrolled resources or admit a reviewed allowlist.
5. **Delegation scope.** Subagents and durable workflows are application features, not runtime defaults. Their v1 catalog remains a product decision.

## Primary sources

- Pi 0.84.4 release: <https://github.com/earendil-works/pi/releases/tag/v0.84.4>
- Pi SDK guide: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sdk.md>
- Pi RPC protocol: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/rpc.md>
- Pi session guide and file format: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/sessions.md> and <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/session-format.md>
- Pi compaction internals: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/compaction.md>
- Pi provider authentication: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/providers.md>
- Pi extension and tool API: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/extensions.md>
- Pi security model: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/security.md>
- Pi session-manager source: <https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/session-manager.ts>
- Pi official subagent example: <https://github.com/earendil-works/pi/tree/v0.84.4/packages/coding-agent/examples/extensions/subagent>
