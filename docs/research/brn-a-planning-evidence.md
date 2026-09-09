# Capability A planning evidence

**Worker:** brna-plan (leaf architecture/docs).
**Date:** 2026-09-09.
**Branch/worktree:** `feature/brn-a` at `/Users/evokessler/.herdr/worktrees/brn/feature-brn-a`.
**Base commit:** `c66e9daa2ebc2b117a5e2b96d3f8cb507e3d9966`.
**Purpose:** Record the evidence, decisions, and unresolved blockers behind the capability A design and implementation plan. This is architecture evidence, not implementation evidence. No code was built, no SDK was executed, no provider was contacted.

## Deliverables produced (worktree writes only)

- `CONTEXT.md`: appended capability-A glossary terms (BRN service, terminal client, browser document client, BRN operation, single-writer lock).
- `docs/product-spec.md`: aligned "Pi runtime integration" and "Runtime trust boundary" with the approved independent foreground service and two-client model.
- `docs/brn-plan.md`: marked capability A design status (spec + plan drafted, awaiting review) and updated the "before coding" checklist; no fabricated approvals.
- `docs/superpowers/specs/2026-09-09-brn-a-design.md`: concrete A design.
- `docs/superpowers/plans/2026-09-09-brn-a.md`: 5-task RED/GREEN implementation plan with real test examples.
- `docs/research/brn-a-planning-evidence.md`: this report.

## Sources read

**Local governing docs (worktree):** `docs/brn-plan.md` (full, 929 lines), `docs/product-spec.md`, `CONTEXT.md`, `README.md`, `prototypes/` listing.

**Source checkout, read-only (never written):** `/Users/evokessler/repos/brn/AGENTS.md`, `docs/agents/{issue-tracker,domain,triage-labels}.md`, and the uncommitted expanded `CONTEXT.md` and `docs/product-spec.md` preface. The source checkout is at the same base commit `c66e...` with uncommitted `M CONTEXT.md`, `M docs/product-spec.md`, and untracked `AGENTS.md`, `docs/agents/`, `docs/frontmatter-recommendation.md`, `docs/research/`.

**Installed Pi 0.85.1 (`@earendil-works/pi-coding-agent`, version confirmed in `package.json`):** `docs/sdk.md`, `docs/security.md`, `docs/session-format.md`, `docs/rpc.md` (head), `examples/sdk/12-full-control.ts`, `examples/sdk/13-session-runtime.ts`, and `dist/core/agent-session-services.d.ts` for exact option signatures.

**GitHub (read-only via `gh`):** #40 (selected stack + review amendment), #21 (local service transport/security), #27 (shared Pi sessions), #33 (tool policy and Worker).

## SDK facts established (from docs + type declarations, not assumptions)

1. **Controlled tools thread through the from-services API.** `dist/core/agent-session-services.d.ts` shows `createAgentSessionFromServices` accepts `noTools`, `customTools`, `tools`, `excludeTools`, `model`, `scopedModels`. So "all built-ins off, one BRN tool on" is expressible.
2. **`AgentSessionServices` carries a `resourceLoader` field.** A BRN-controlled loader (empty extensions/skills/prompts/themes/agentsFiles, custom system prompt, per `examples/sdk/12-full-control.ts`) suppresses ambient discovery.
3. **Session replacement lives on `AgentSessionRuntime`,** not `AgentSession`: `newSession`, `switchSession`, `fork`, `importFromJsonl`. Subscriptions and `bindExtensions` must be re-bound after each replacement (`examples/sdk/13-session-runtime.ts`).
4. **Model/auth deadlines are the app's responsibility.** `ModelRuntime` public ops are unbounded unless an `AbortSignal` is passed; `PI_OFFLINE` disables model network. This justifies the explicit 15 s catalog-refresh bound and 180 s operation deadline in the design.
5. **Sessions are JSONL trees (v3), auto-migrated on load; the loader skips malformed lines** (`session-format.md`). There is no passive strict-validation API, so the design requires a recoverable pre-change snapshot rather than a nonexistent guarantee.
6. **No OS sandbox** (`security.md`). Restrictions bound the model's exposed capabilities, not a same-user process. Non-interactive modes never prompt for trust. This matches brn-plan.md's [P2] caveat.
7. **Pi RPC is a subprocess protocol, not a BRN client contract** (`rpc.md`, #40). BRN embeds the SDK directly and defines its own HTTP/SSE seam; it does not use Pi RPC or parse Pi JSONL.

## Decisions recorded

- **Durable BRN operation model (D10, #27, #21).** One active operation, visible busy rejection (HTTP 409), durable operation ids/status/result in SQLite kept separate from native Pi JSONL. Reconnect fetches by id and never resubmits; restart marks in-flight operations `interrupted` with no automatic paid replay. Idempotency keys deduplicate submissions.
- **Provider budgets (D8), explicit numbers.** Operation deadline 180 s; provider retries max 2 via `SettingsManager`; catalog refresh bounded 15 s; credentials via Pi `auth.json`; live provider use opt-in only.
- **Empty tool catalog for A.** A registers only a trivial `brn_ping` to prove the restriction seam. Canonical `search_records`/`read_record` and `delegate_worker` (Workers) are out of A's scope.
- **Small line client, not full-screen.** A ships a readline+ANSI terminal client; `pi-tui` full-screen is deferred. Reading SSE via `fetch()` streams with LF-only framing (no SSE library), per #40.
- **Three separated test layers.** Deterministic fakes (hermetic gate) + real-SDK offline checks (`PI_OFFLINE`, isolated roots, no provider) + one opt-in live smoke. Kept distinguishable per J and #27/#33.

## Unresolved blockers and open questions

1. **Governing-issue reconciliation (parent-owned GitHub writes).** Four concrete conflicts, detailed in the design's "Open reconciliations":
   - #40 selects a full-screen `pi-tui` terminal and forbids embedding `InteractiveMode`; A ships a small line client and needs pi-tui only later. Reconcile the CLI/TUI section.
   - #33 registers canonical tools + `delegate_worker`; A registers none of these. Reconcile the tool catalog scope for A.
   - #27 describes a per-session ordered command queue; A adopts the simpler single-operation-with-visible-rejection policy. Reconcile the queue wording.
   - #21 fully specifies the browser cookie/fragment-token exchange; A implements bearer + Host only (browser auth lands in H).
2. **Open SDK question for Task 3 (verification, not assumption).** Whether `noTools` + `customTools` + a BRN-controlled `resourceLoader` thread through the `createAgentSessionRuntime` replacement path is unverified until run offline against the real SDK. The plan's Task 3 offline test proves it and records a fallback (`createAgentSession()` + thin BRN replacement wrapper) if a supported seam cannot carry all three. This is the one finding that could change the A design.
3. **`node:sqlite` FTS5 on the pinned Node build.** `node:sqlite` is release-candidate in Node 24; FTS5 presence must be proven at startup (Task 1). If absent, the stack decision must be revisited rather than the check weakened.
4. **Source-checkout doc divergence (parent-owned integration).** The source checkout has an uncommitted expanded `CONTEXT.md` (fuller glossary: Canonical record, Proposal, Worker, etc.) and a `product-spec.md` preface. This worktree's committed baseline is the shorter version; I appended only capability-A terms to preserve meaning without absorbing the sibling's unrelated uncommitted work. The parent must reconcile my capability-A additions with the expanded glossary and preface during integration.

## Constraints honored

No writes to the source checkout. No AGENTS-file or prototype edits. No live provider, credential access, installs, subagents, push, merge, or GitHub writes. Documentation-only. Real-SDK findings are recorded as facts or explicit open checks, never as fabricated approvals; capability A is not claimed complete, and its design status is "awaiting technical-plan user review."
