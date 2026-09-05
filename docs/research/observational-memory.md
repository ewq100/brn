# Observational memory and a Markdown-first BRN Agent vault

## Summary

Do not use `pi-observational-memory` as BRN's persistence layer or as a replacement for Pi raw-session storage. The package is a useful reference implementation, and potentially a reusable in-process summarization engine, but its V3 contract makes the Pi branch ledger, including raw messages and tool results, the source of truth. Its Markdown output is a derived view, not an independently recoverable vault.

BRN should own an app-level ingestion and persistence boundary: process Pi events transiently, write authoritative typed Markdown records atomically into the Agent vault, retain explicit provenance that does not depend on raw transcripts, and rebuild all SQLite indexes from those files. Raw Pi session logs should be disabled or deleted only after each durable checkpoint succeeds.

## Findings

1. **`pi-observational-memory` cannot replace Pi raw-session persistence unchanged.**  
   V3 explicitly defines the "branch-local V3 ledger" as its source of truth. The extension obtains that ledger through `ctx.sessionManager.getBranch()` and writes observations, reflections, and drop tombstones back into the same Pi session with `pi.appendEntry()`. It defines no independent storage adapter, database, file format, or export/import layer. Deleting the Pi session therefore deletes both the raw source and the package's authoritative memory ledger. [V3 technical reference](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/how-it-works.md) · [Consolidation trigger source](https://github.com/elpapi42/pi-observational-memory/blob/master/src/hooks/consolidation-trigger.ts) · [Extension entry point](https://github.com/elpapi42/pi-observational-memory/blob/master/src/index.ts)

2. **The package's persistence format is structured Pi ledger data, not Markdown-first storage.**  
   V3 appends three custom entry types:

   - `om.observations.recorded`: observations plus a `coversUpToId` watermark
   - `om.reflections.recorded`: reflections plus a watermark
   - `om.observations.dropped`: observation-ID tombstones plus a watermark

   Observations include content, timestamp, relevance, source Pi-entry IDs, and token count. Reflections contain content, supporting observation IDs, and token count. Compactions additionally store structured `om.folded` details. The user-facing Markdown shown by `/om:view` and injected during compaction is rendered deterministically from these objects; it is not the package's primary persistence artifact. [Ledger type definitions](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/types.ts) · [Concepts](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/concepts.md)

3. **Its recovery model is replay of the retained Pi branch.**  
   On restart or continuation, V3 folds valid custom entries from branch root to the selected boundary. It applies first-valid-record-wins semantics to observations and reflections and treats drops as permanent tombstones. Unknown entries, malformed V3 entries, V2 entries, and dangling coverage markers are ignored. This is deterministic and reasonably tolerant of partial history, but it is only recovery from the Pi ledger; there is no recovery from rendered Markdown alone. V2 state is not migrated, and the documented upgrade path is a clean session. [Ledger fold implementation](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/fold.ts) · [Projection implementation](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/projection.ts) · [V2 behavior and invariants](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/how-it-works.md#v2-behavior)

4. **Crash behavior is resumable but not transactional across raw input and generated memory.**  
   Background observer work appends a ledger entry only after a model call succeeds and produces accepted observations. Empty or failed runs do not advance `coversUpToId`, so retained source entries remain eligible for a later attempt. Compaction intentionally does not wait for background workers and folds only already-appended state. Thus a crash before append loses that worker result but permits retry from raw history; a crash after append can recover by replay. This recovery property disappears if BRN discards the raw entries before committing an equivalent app-owned checkpoint. [Observer flow and error handling](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/how-it-works.md#observer-flow) · [Consolidation implementation](https://github.com/elpapi42/pi-observational-memory/blob/master/src/hooks/consolidation-trigger.ts)

5. **Raw source retention is fundamental to the package's recall and pruning semantics.**  
   Every observation cites `sourceEntryIds`. The `recall` tool resolves those IDs back to raw `message`, `custom_message`, or `branch_summary` entries and can return exact user text, assistant reasoning/text, tool calls, and tool results. A missing source produces a partial-result diagnostic rather than reconstructed evidence. "Dropping" an observation only removes it from active projections; both the observation and its raw evidence remain in ledger history. Consequently, enabling the package does not satisfy a requirement to avoid retaining raw sessions. [Recall implementation](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/recall.ts) · [Raw serialization and recall rendering](https://github.com/elpapi42/pi-observational-memory/blob/master/src/serialize.ts) · [Drop semantics](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/concepts.md#drops)

6. **The package provides an inspectable Markdown view, but not an Agent vault.**  
   `/om:view` renders visible compaction memory, while `/om:view full` renders the full branch-tip projection. The model sees observations and reflections as Markdown sections with stable IDs. This is useful for inspection, but the view omits the append history, tombstones, watermarks, source records, branch topology, and full provenance needed to reconstruct package state. It also represents conversational memory only; it does not define authoritative task, plan, workflow, proposal, approval, or artifact lifecycles. [Commands and summary rendering](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/how-it-works.md#commands) · [Projection model](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/concepts.md#visible-full-and-drift)

7. **Mastra's design has the same conceptual compression loop but a materially different storage contract.**  
   Both systems use recent messages to generate observations, then reflections. Mastra's official design says raw history is compressed into an observation log as context grows, and reflection rewrites that log to remain bounded. However, Mastra persists conversation messages and a separate observational-memory record through supported database adapters. Its documentation explicitly warns that OM "still relies on stored conversation history"; retrieval mode links observation groups to raw message-ID ranges and pages the raw messages when recalled. [Mastra OM documentation](https://mastra.ai/docs/memory/observational-memory) · [Mastra research description](https://mastra.ai/research/observational-memory) · [Observation-group source](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/processors/observational-memory/observation-groups.ts)

8. **Mastra stores operational state, not a Markdown vault.**  
   Mastra's `ObservationalMemoryRecord` persists identity and scope, active observation text, buffered chunks, source message IDs, reflection buffers, token counters, generation count, progress timestamps, worker flags, config, and metadata. Its storage API includes initialization, active and buffer updates, atomic buffered activation, reflection-generation creation, history queries, and clearing. The LibSQL adapter stores these in `mastra_observational_memory`, alongside separately stored message and thread tables. This is stronger database-backed operational recovery than the Pi extension, but the database remains authoritative and raw messages remain part of the design. [Mastra storage types](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/types.ts) · [Memory storage contract](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/memory/base.ts) · [LibSQL implementation](https://github.com/mastra-ai/mastra/blob/main/stores/libsql/src/storage/domains/memory/index.ts) · [OM table schema](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/constants.ts)

9. **Neither implementation directly meets BRN's authority and retention requirements.**

   | Requirement | `pi-observational-memory` V3 | Mastra OM | BRN requirement |
   |---|---|---|---|
   | Authoritative store | Pi branch/session ledger | Database records plus message store | Agent-vault Markdown |
   | Raw conversation retained | Yes | Yes | No, after durable extraction |
   | Human-inspectable memory | Derived Markdown view | Studio/database-backed observation text | Canonical files |
   | Recovery | Fold retained Pi branch | Reload database generations, buffers, and messages | Parse Markdown; rebuild indexes |
   | Exact recall | Raw Pi source entries | Raw stored messages and ranges | Explicitly unavailable unless promoted into a durable record |
   | Domain records | Observations and reflections | Observations, reflections, and extractors | Sessions, tasks, plans, workflows, and proposals |
   | SQLite role | None owned by extension | Authoritative store | Rebuildable index only |

10. **BRN must own the source-data boundary.**  
    The embedded Pi service should expose an ordered transient event stream containing at least:

    - session, run, parent, and branch identity;
    - user inputs and assistant outcomes;
    - tool invocation and result metadata needed to establish what changed;
    - decisions, constraints, corrections, approvals, and rejections;
    - task and workflow transitions;
    - produced or modified artifact references;
    - timestamps, stable event IDs, and a processing watermark.

    Raw prompts, model reasoning, large tool outputs, file dumps, and credentials should remain ephemeral. Before disposal, BRN must promote any fact needed for audit or continuation into a durable record. A citation such as `sourceEntryIds` is not useful after source deletion; durable provenance must instead point to another retained Agent-vault record, a Human-vault document, a repository path and commit, or an external artifact reference.

11. **BRN should own a small, explicit Markdown record model.**  
    Recommended authoritative records are:

    - `agents/sessions/<session-id>.md`: purpose, status, timestamps, continuation summary, linked work items, model or provider metadata where appropriate, last durable checkpoint, and terminal outcome, but not a transcript.
    - `agents/tasks/<task-id>.md`: desired outcome, constraints, status, owner or agent, dependencies, evidence, decisions, and result.
    - `agents/plans/<plan-id>.md`: ordered steps with stable IDs and per-step state.
    - `agents/workflows/<workflow-id>.md`: workflow definition or run state, transitions, retries, checkpoints, and linked tasks.
    - `agents/proposals/<proposal-id>.md`: proposed change, rationale, alternatives, impact, approval state, and decision.
    - Optionally, `agents/memory/<memory-id>.md`: durable observation or decision records when facts do not naturally belong to one of the records above.

    Each file should use versioned YAML front matter for machine-owned identity and state, followed by app-written Markdown sections for human inspection. Relationships should use stable BRN IDs, never filesystem position or Pi entry IDs as the sole key.

12. **Persistence should be checkpointed, idempotent, and atomic.**  
    For each processing batch, BRN should:

    1. receive Pi events in memory;
    2. derive candidate record mutations, optionally using observer or reflector prompts;
    3. validate them against typed schemas and allowed state transitions;
    4. write affected Markdown files through temp-file, `fsync`, and atomic rename;
    5. write the session's durable watermark into its Markdown record in the same logical checkpoint;
    6. update SQLite only after the files commit;
    7. acknowledge that raw Pi data may be discarded.

    Deterministic mutation IDs should make retries idempotent. If the process crashes before step 4, the transient turn may need to be rerun or explicitly reported as uncommitted. If it crashes after step 4 but before indexing, startup reparses Markdown and rebuilds SQLite. If parsing or validation fails, BRN should preserve the last valid files, quarantine the invalid candidate, and surface a visible recovery state rather than silently regenerating authority from model output.

13. **Product-visible records must distinguish facts from generated interpretation.**  
    BRN's local web app and CLI should expose:

    - session state and continuation summary;
    - active, completed, and blocked tasks;
    - plan steps and workflow checkpoints;
    - pending, accepted, and rejected proposals;
    - decisions, constraints, and linked evidence;
    - record revision time and schema version;
    - provenance links to retained records and artifacts;
    - extraction status such as `pending`, `committed`, `failed`, or `needs-review`;
    - an explicit notice that the original transcript is not retained and exact conversational recall is unavailable.

    Observational-memory output should be labeled generated unless it has been validated and promoted into the relevant authoritative record. "Reflection" should not itself imply user approval.

14. **Adopt the pattern, not the package's persistence contract.**  
    Use one of these approaches, in priority order:

    **Recommended:** implement a BRN-owned reducer and checkpointer inspired by observational memory. Feed it transient Pi events, use observer-style extraction for candidate facts and reflector-style consolidation for summaries, and persist typed Markdown mutations through BRN's application service.

    **Acceptable prototype:** fork or wrap the package's observer and reflector prompt and validation code, replacing `sessionManager.getBranch()` and `pi.appendEntry()` with BRN event input and Markdown record commands. Disable its `recall` promise or redefine recall over retained BRN records only.

    **Not recommended:** install the extension unchanged and treat `/om:view` output as the vault. That output cannot reconstruct watermarks, drops, provenance, or branch state, and the extension still requires the raw Pi session that BRN intends not to retain.

## Sources

- [pi-observational-memory: How it works](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/how-it-works.md)
- [pi-observational-memory: Concepts](https://github.com/elpapi42/pi-observational-memory/blob/master/docs/concepts.md)
- [Session-ledger types](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/types.ts)
- [Consolidation trigger](https://github.com/elpapi42/pi-observational-memory/blob/master/src/hooks/consolidation-trigger.ts)
- [Ledger fold](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/fold.ts)
- [Recall implementation](https://github.com/elpapi42/pi-observational-memory/blob/master/src/session-ledger/recall.ts)
- [Mastra Observational Memory documentation](https://mastra.ai/docs/memory/observational-memory)
- [Mastra OM research report](https://mastra.ai/research/observational-memory)
- [Mastra memory storage contract](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/memory/base.ts)
- [Mastra storage types](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/types.ts)
- [Mastra LibSQL memory adapter](https://github.com/mastra-ai/mastra/blob/main/stores/libsql/src/storage/domains/memory/index.ts)

## Gaps

- The package sources establish extension-level semantics but do not promise filesystem durability or atomicity for Pi's underlying `appendEntry()` implementation. BRN should not infer a crash guarantee beyond "unwatermarked retained input can be retried."
- Without BRN's final schemas, naming rules, and approval model, the proposed Markdown paths and front matter remain architectural guidance rather than a wire-format specification.
- A prototype should test forced termination at each checkpoint boundary, malformed model output, concurrent web and CLI updates, branch creation, and deletion of Pi session files. Acceptance criteria should require successful startup and complete SQLite reconstruction from Agent-vault Markdown alone.
