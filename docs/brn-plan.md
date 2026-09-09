# BRN product and implementation plan

Updated: 2026-09-09.

Status: design directions approved in the 2026-09-09 brainstorming discussion; this consolidated written revision awaits review. Vault replacement, exact-byte approval, an independent foreground BRN service, terminal chat, database-backed writing state, and the delivery milestones below are approved directions. No implementation capabilities are complete. GitHub issues, the product specification, and the glossary have not been aligned with this design.

## How to use this document

This is the single editable plan for the smaller BRN direction. It combines product intent, front matter, Pi integration, migration, retrieval evaluation, proposed implementation capabilities, and future growth.

Distinguish four kinds of statement:

- **User-stated requirements:** the problems and preferences explicitly described during the discussion.
- **Approved design:** choices accepted in the brainstorming discussion, summarized under Open decisions and next steps. Approval of the design is not implementation evidence.
- **Recommended baseline:** supporting details still proposed unless explicitly identified as approved. Recording them here does not mean every detail has been settled.
- **Open decisions:** choices that still need a concrete resolution or integration evidence.

The existing [product specification](product-spec.md), [CONTEXT.md](../CONTEXT.md), and resolved GitHub decisions still describe the earlier design. This document does not silently amend them. Before implementing conflicting requirements, approve the relevant change and update the governing issue specifications and glossary together. Documentation work does not authorize implementation, migration, or GitHub changes.

For later sessions, start with [Open decisions and next steps](#open-decisions-and-next-steps), then the relevant [implementation capability](#implementation-capabilities). Add evidence and decision references here as work progresses. Keep obsolete recommendations marked as superseded instead of leaving two active versions.

### Contents

- [Purpose and user goals](#purpose-and-user-goals)
- [Evidence and current implementation](#evidence-and-current-implementation)
- [Scope](#scope)
- [Everyday experience](#everyday-experience)
- [Pi integration](#pi-integration)
- [Storage and safety](#storage-and-safety)
- [Front matter](#front-matter)
- [Retrieval and evaluation](#retrieval-and-evaluation)
- [Implementation capabilities](#implementation-capabilities)
- [Existing issue map](#existing-issue-map)
- [Pi updates and future growth](#pi-updates-and-future-growth)
- [Open decisions and next steps](#open-decisions-and-next-steps)
- [References](#references)

## Purpose and user goals

Build an AI writing workspace grounded in the user's existing knowledge, with anchored comments, controlled revisions, and approved publication. Start from a useful CLI, then add a focused browser writing workspace.

### User-stated requirements

- The current setup is `/Users/evokessler/repos/second-brain-work`.
- Reviewing a long document and then reconstructing all feedback in a long prompt is unpleasant. Adding comments while reading is substantially easier.
- Inline comments and revision from those comments are central to the new app.
- BRN does not need to become the default note-taking app. Writing `.md` or `.txt` files elsewhere and importing them later is acceptable.
- A smaller initial version is desirable so the app can run and existing knowledge can move over.
- CLI-first development is preferred.
- `second-brain-eval` is an existing, useful synthetic retrieval benchmark. Reuse it rather than inventing a weaker replacement.
- The app should have a credible route to more features later, without a large initial implementation or a fragile Pi fork.

The user approved replacing the existing vault rather than releasing an export-only writing layer. External modifications require reapproval before canonical use. The chosen host is a BRN process independent of its clients, with ordinary conversation in the terminal and document review in the browser. Authoritative SQLite storage for working drafts, comments, checkpoints, and approval evidence is approved. These are design choices, not demonstrated capabilities.

### Product judgment

The strongest case for BRN is a specific improvement over the current writing workflow: read, comment at the relevant passage, revise in a batch, inspect changes, and save trusted results with their evidence.

A simpler editor-plus-AI workflow already supplies Markdown, search, and drafting. BRN earns its maintenance cost by reducing the work of selecting context, explaining edits, comparing revisions, and publishing safely. It does not earn that cost merely by adding another graph, task list, or approval queue.

Protect source fidelity, exact approval, attributable evidence, and recovery. Reduce filing decisions, unnecessary lifecycle records, and duplicate interfaces.

### Earlier recommendations revised by this discussion

| Earlier concern or suggestion | Current direction |
|---|---|
| Defer inline comments | Withdrawn. Comments address the main stated problem and belong in v1. |
| Require dedicated quick capture and blank-note creation | Withdrawn as a release requirement. External text capture is acceptable. |
| Prefer browser-first implementation | Revised. Start CLI-first, without completing a separate full terminal product before browser comments. |
| Exclude legacy migration | Keep generic migration out, but include a bounded import from the known existing vault. |
| Run a separate product-testing program before building | Not required. Use the existing synthetic suite for retrieval and normal writing work to verify the interaction. |
| Prefer FTS5 because it is smaller | Use it as a baseline, not a predetermined winner. A smaller app does not justify an unexplained retrieval regression. |
| Own Pi in the terminal process and reuse its native terminal | Superseded on 2026-09-09. An independent BRN service owns Pi; a small BRN terminal client handles conversation. |
| Keep mutable working drafts as live Markdown files | Superseded on 2026-09-09. Draft text and review state live in authoritative SQLite; external editing uses checked export and submission. |
| Keep every SQLite database disposable | Superseded for BRN writing and approval state. Retrieval indexes alone remain disposable. |

## Evidence and current implementation

### BRN

At consolidation, the repository baseline is commit `41785f2`. It contains specifications and two scripted HTML prototypes, not a production application, package manifest, lockfile, or BRN integration tests.

The prototypes express interaction preferences. Their buttons change in-memory display state; they do not establish working persistence, selection anchoring, authentication, retrieval, or recovery. Their source was inspected, not treated as a production browser test.

The prior product review covered issues #19 through #40 and their comments, the map in #1, originating decisions #2 through #17, linked research, and the [implementation review amendment](https://github.com/EvoKessler_ericcp/brn/issues/16#issuecomment-5572648427). That amendment remains part of the earlier design; new recommendations here are not a claim that its fixes were absent. The issue review and existing-vault inventory were not rerun for this revision.

### Existing work vault

The operating-model document describes a Markdown vault, a Python retrieval and governance layer, and a VS Code/Copilot writing workflow. The current React review implementation has a general revision-instruction input rather than an integrated selection-comment workflow. A separate DOCX-comment extraction script exists, but its existence does not solve integrated reading and revision.

A read-only inventory found:

- 264 Markdown files under `01-Projects` and 124 under `02-Areas`.
- 95 Markdown files under `04-Archive`.
- Existing semantic types, dates, language, tags, links, and domain-specific properties.
- Duplicate basenames within Projects.
- A symlink at `03-Resources`, which was not traversed.

These are directory inventory counts, not an assertion that every file should be imported or considered canonical. The README and some older instructions are stale; use inspected behavior and the operating-model notes rather than assuming every description is current.

### Retrieval evidence

The inspected old indexer puts title, heading, body, and tags into FTS5. Vector input is generally passage text, with `summary_en` prepended for non-English content when available. The inspected search implementation applies an `updated`-based recency adjustment. Its `/search` endpoint exposes query, limit, and mode; storing metadata alone does not provide a functioning metadata filter.

The evaluation repository contains held-out cases, temporal and authority distinctions, multi-record evidence, forbidden results, and source-span judgments. It has an implemented Electron adapter despite stale README wording describing a stub. These are reasons to reuse the benchmark, not proof of a particular BRN retrieval result.

No new retrieval benchmark or BRN integration was run during this design review. Findings from the linked Lobit research remain prior-project evidence, not BRN acceptance results.

## Scope

The first release is personal, single-user, local-first, and run from source on macOS. A foreground BRN service is started and stopped explicitly, independently of the terminal and browser clients. It manages one Human vault and one Agent vault. Client disconnection does not stop accepted work; stopping the service does. An always-on daemon, enterprise use, and multi-user operation remain out of scope.

| Capability | Initial decision | Reason |
|---|---|---|
| Pi-powered CLI | Keep | Useful early operation without rebuilding agent behavior. |
| Import from the existing vault | Keep | Necessary for switching personal use. |
| `.md` and `.txt` ingestion | Keep | Supports the user's external capture workflow. |
| Canonical search and evidence-linked answers | Keep | Supplies trustworthy context for writing. |
| Browser reading and anchored comments | Keep | Main missing interaction. |
| Batched comment revisions, diffs, and history | Keep | Makes feedback actionable and inspectable. |
| Exact approval and safe publication | Keep as the approved safety model | Prevents silent canonical changes. |
| Source preservation and provenance | Keep | Distinguishes captured material from authored interpretation. |
| Backups and conflict recovery | Keep | Personal data still needs protection. |
| PARA destinations | Simplify | Use explicit choices and defaults, not a classification ceremony. |
| Links and backlinks | Keep basic behavior | Useful navigation without a separate graph application. |
| Advanced embeds and archive-triggered rewrites | Defer or remove | Do not transform source content merely to support rendering. |
| Default note-taking and quick capture | Optional | Not a primary use case. |
| Complete browser chat/session application | Defer | The first browser client focuses on documents. |
| Small terminal conversation client | Keep | Connect to the BRN service for chat, session/model controls, cancellation, and BRN commands. |
| Custom full-screen terminal application | Defer | Do not reproduce every Pi command, layout, or extension UI. |
| Tasks and separate Plan records | Defer | Must earn a place rather than duplicate existing tools. |
| Workers | Defer | Context isolation may help later, but extra calls are not automatically better. |
| Automatic learning review | Defer | Creates cost and review work without established benefit. |
| Explicit save-this-takeaway action | Keep through ordinary proposals | Clear user intent needs no separate learning lifecycle. |
| Generic workflow engine | Exclude | Concrete import and rewrite operations are sufficient. |
| Mandatory post-import Trash | Remove from initial scope | Keep originals; cleanup can be a separate later action. |
| Rich extraction, installers, always-on background service, sync | Defer | Not required to prove the initial writing workflow. |

This scope does not require a permanent-delete capability for canonical records. Dismissing a working draft hides it reversibly and does not erase its text, checkpoints, or comments. Initially retain captured originals, checkpoints, and displaced canonical bytes without automatic pruning. A later retention policy must preserve approval and recovery requirements.

## Everyday experience

1. Start the foreground BRN service and connect the terminal conversation client. Pi supplies the underlying model and session behavior.
2. Copy-import selected knowledge from the existing vault. Review mappings and exceptions once as an explicit migration decision, not hundreds of AI-classification requests.
3. Search directly or ask a grounded question. Open the supporting record and passage.
4. Ask Pi to draft or revise a document. BRN saves working Markdown text in its database, outside canonical knowledge.
5. Open that draft in a browser reading workspace. Select text, add comments, and continue without losing position.
6. Submit the accumulated comments. BRN freezes the saved source version and selected comment batch and requests one revision through their originating Pi session in the service.
7. Inspect the diff, supporting evidence, and associated comments. Edit directly or start another review round. If edits occurred during the rewrite, keep both results and choose explicitly rather than overwrite newer work.
8. Approve the exact visible version and destination. BRN publishes it through the controlled write path.
9. If publication fails, see whether anything was saved and retry the same approved operation where safe.
10. Copy or export a working result without being required to make every disposable draft canonical. Closing a client leaves the service and its accepted operations running.

The browser should offer full-width or expandable reading. Content, comments, and changes take priority over hashes, validator versions, and journal details, which remain available through disclosure.

Use persistent save feedback. Acknowledged comments and edits must survive reopening. A successful rewrite means a batch was applied to a new version; it does not mean the user has accepted every change or that every comment was semantically satisfied.

## Pi integration

### What changes from the original design

The approved design retains independent service ownership from the original architecture, but not its two complete clients or its tasks, Plans, Workers, and learning subsystems. The intermediate recommendation to host Pi inside a reused native terminal is superseded.

```text
Small BRN terminal client ─┐
                          ├─ Authenticated loopback HTTP/SSE
Browser document client ──┘              │
                              Foreground BRN service
                                ├─ One active Pi conversation
                                ├─ Scoped knowledge and draft tools
                                ├─ SQLite writing and review state
                                └─ Canonical publication and recovery
```

| Concern | Approved direction |
|---|---|
| Runtime owner | A foreground BRN process independent of either client |
| Terminal | Small conversation client, not Pi's native terminal connected remotely |
| Browser | Document reading, direct edits, comments, revisions, diffs, and approval; no general chat |
| Conversations | One active conversation and one agent operation at a time |
| Draft changes | Database-backed mutable Markdown text and immutable review/revision checkpoints |
| Agent-vault state | Only state required by import, drafts, comments, and publication |
| Model tools | Scoped canonical search/read and revision-checked draft operations |
| Canonical write authority | Deterministic BRN publication after exact human approval |

The working-text/checkpoint distinction changes the earlier Proposal-version contract. Update the governing specifications explicitly; immutable approved content has not become editable. Authoritative SQLite also changes the earlier all-SQLite-is-disposable rule.

### Ownership and client responsibilities

Pi owns agent execution, provider communication, authentication mechanisms, native conversation history, model selection, and compaction. BRN hosts these facilities through the SDK rather than implementing another agent engine.

The service owns canonical identities, metadata, retrieval, working drafts, review snapshots, comments, approval evidence, publication, migration, and recovery. Neither client opens Pi session files or directly writes authoritative BRN state. Provider credentials remain in the service, not the browser.

The terminal supplies multiline input, streamed responses, readable tool status, cancellation, new/resume session commands, model selection, and context/usage display. BRN implements these controls over its client interface. Reproducing every Pi command, settings panel, or extension UI is excluded.

The browser opens drafts, saves edits and comments, requests revisions, displays diffs, and approves publication. It has no general chat or separate session manager. It can continue document work after the terminal disconnects while the service remains running.

### Coordination and lifetime

- One foreground service owns the managed state, with single-writer protection against a second service instance.
- One conversation is active and one agent operation runs at a time. Reading and checked document saves need not wait for model work.
- A browser revision names its originating Pi session, exact source version, and comment batch. A busy runtime rejects new agent work visibly rather than silently queuing it.
- If another session is active, revision requires an explicit return to the originating session. Switching waits for the current operation to finish or for explicit cancellation to settle. Model changes must not silently alter an in-flight request.
- Client disconnection is not cancellation. Accepted work continues; reconnecting retrieves current operation status and saved results rather than submitting the operation again.
- Stopping the service cancels provider work and preserves recoverable BRN state. Restart reports interrupted provider requests; it does not silently repeat paid work. Publication recovery reconciles durable local intent separately from provider retries.

### Tool and resource restrictions

The approved model is service-mediated draft editing, not unrestricted filesystem access:

- The model reads and changes identified drafts through scoped, revision-checked tools. It has no raw database access.
- Canonical reads go through BRN's approval eligibility and scope checks. External modifications require reapproval before canonical use.
- Model tools cannot directly change review snapshots, comments, approval evidence, publication operation state, or backups.
- Approval and publication are authenticated human-origin operations, not model-callable tools.
- No unrestricted shell, filesystem tool, client command, or general Pi RPC passthrough may bypass these controls.
- Only controlled instructions, tools, and extensions load into product sessions.

Setting a working directory is not filesystem confinement. Pi has no built-in OS sandbox. The trusted process still has the user's macOS permissions; the guarantee concerns the capabilities exposed to the model, not a malicious same-user process or compromised dependency. [P2]

### Supported mechanisms and integration evidence

The installed Pi 0.85.1 SDK, RPC, security, and session-format documentation and the SDK full-control and session-runtime examples were read during this design session. The SDK documents direct hosting, resource control, event subscriptions, and runtime replacement. Session-local subscriptions must be rebound after replacement. [P1][P2][P3][P7]

`InteractiveMode` takes a runtime directly. This design does not assume it is a remote terminal client. Pi RPC is a headless subprocess protocol, not a ready-made BRN client/service contract. Use direct SDK hosting inside the Node service and a bounded BRN client interface; no Pi fork or private-method bridge is planned.

No integration code, real-SDK check, or live-provider call was run during this brainstorming. Capability A must prove service construction, terminal streaming, restrictions, session replacement, cancellation, and reconnect behavior. The earlier proposal to amend #40 to permit embedding `InteractiveMode` is superseded; #40 still needs reconciliation with the selected service and client scope.

### Stack baseline

Retain the selected stack unless a concrete incompatibility or product requirement justifies a change:

| Area | Baseline |
|---|---|
| Runtime/build | Node `24.20.0`, npm `11.19.0`, TypeScript `7.0.2`, one package, strict ESM |
| Pi | Exact `0.85.1` packages from #40, with lockfile-controlled transitive dependencies |
| Local transport | Loopback HTTP and SSE using platform facilities initially |
| Authoritative writing/review state | SQLite through `node:sqlite`, separate from the disposable retrieval index |
| Retrieval | SQLite FTS5 through `node:sqlite` as the first evaluated candidate |
| Validation/parsing | TypeBox, YAML, mdast using the selected compatible pins |
| Browser | React, Vite, plain CSS; a document workspace rather than complete client parity |
| Verification | Vitest, Playwright, accessibility checks, and the existing evaluation repository |

The exact versions listed in #40 were available when checked, and principal declared engine/peer ranges fit. That is not proof that the full set installs, type-checks, and runs together.

Node's selected SQLite interface is synchronous and release-candidate; the selected Node source enables FTS5. Verify the actual target binary. Type stripping supports erasable TypeScript, not type-checking or arbitrary `tsconfig` transforms. [P4][P5]

Avoid replacing the stack merely to simplify its dependency list. Conversely, do not prohibit an editor dependency if accurate selections, comments, undo, and document mapping would otherwise require more fragile custom code. Decide that at the writing interface, not as a general framework debate.

## Storage and safety

### Approved persistence direction

| Data | Authoritative storage |
|---|---|
| Canonical records | Human-vault Markdown files |
| Working draft text, immutable checkpoints, comments, revision requests | One BRN SQLite database |
| Approval evidence and publication operation state | The same BRN database |
| Conversation history | Pi's native session files |
| Captured originals and recovery copies | BRN-managed files |
| Search index | Separate, disposable retrieval data |

The database is authoritative, not reconstructible from canonical Markdown alone. BRN must version its schema and include it in backup and recovery. Do not prebuild a generic repository framework or copy Pi conversation history into a competing session store.

Drafts are Markdown text stored in the database, not live filesystem documents. Terminal tools and browser edits use the service. Every save identifies the revision it started from and is acknowledged only after durable persistence. A stale save preserves recoverable submitted text without overwriting newer work.

`$EDITOR` receives a temporary exported copy. Closing the editor submits the result through the same checked save operation. The temporary file is not authoritative, and an editor left open cannot later overwrite a newer draft silently.

A database transaction can save a completed revision, its immutable checkpoint, and its comment-batch outcome together. It cannot atomically commit a canonical Markdown replacement outside the database. Keep the recoverable filesystem publication protocol below.

### Review snapshots and comment batches

Create immutable checkpoints for reviewed content, completed revisions, and publication. Acknowledged ordinary edits remain durable without treating every keystroke as a separate review checkpoint.

Each comment records the immutable reviewed version, selected text, and source position. Anchor mapping follows the editor's document model rather than guessing from repeated phrases. After edits, preserve the original anchor and context. Map it to current content only when supported by that model; otherwise require explicit reattachment. A selected unresolved comment blocks submission of that batch rather than targeting an arbitrary passage.

Submitting freezes the saved source version and selected comments with the originating session identity. Model output belongs to that request, not an unrestricted current-draft write. On successful completion, save one immutable result checkpoint. Make it current only if the draft still matches the submitted source version; otherwise retain both and require an explicit choice.

Failed or cancelled requests preserve source and comments. Duplicate submissions identify the existing operation, not a new rewrite. Interrupted provider requests are reported without automatic paid replay. Comments included in a completed revision remain inspectable and reopenable; included or applied does not mean semantically satisfied or accepted.

### Publication guarantees to protect

- Validate and freeze the exact reviewed content and destination preconditions.
- Keep approval evidence outside the content it authorizes.
- Persist required intent and backups before canonical mutation.
- Use complete writes and the documented filesystem durability operations.
- Acknowledge publication only when the required content and evidence are durable.
- A repeated operation has one recorded effect.
- Preserve external modifications and block only the affected unsafe operation where possible.
- Distinguish conflict before mutation from recovery after partial mutation.
- Preserve a recoverable state after failure; do not claim a multi-file import is atomically visible.
- Keep healthy records readable during localized failure.

Start with create and replace. Removing advanced embeds avoids compound archive operations that rewrite Source records. Restoration of older authored content requires a new reviewed publication; restoring the last approved bytes after an external modification is a distinct recovery operation.

### Import and original files

Persist extraction before optional model work. Provider unavailability must not prevent capture or manual metadata completion.

The captured version is the input to review. If the original later changes or disappears, show that fact and allow explicit publication of the captured version. The original's current identity matters before cleanup, not as an unconditional publication precondition.

Keep source originals untouched and retain captured original bytes in BRN-managed storage initially. A provenance hash alone cannot reconstruct a discarded original. Do not automatically prune retained captures, checkpoints, or displaced canonical bytes. If cleanup is added later, make it separate and identity-checked.

### Privacy, cost, and recovery

Local storage does not imply local inference. Explain when Inbox content, records, and comments are sent to a provider. Automatic AI enrichment must be explicit and pausable. Bound remote operation duration, retries, and model input/output; an extraction byte limit is not a model context or spending limit.

Keep useful usage information without logging prompts, record bodies, credentials, or provider responses into operational logs. Restrict browser rendering, remote embeds, and URL schemes. Authenticate loopback requests, validate Host/Origin as appropriate, and protect discovery/bootstrap credentials.

A Human-vault folder alone does not reconstruct BRN approval state. The backup set includes canonical Markdown, the authoritative database, retained captures and recovery copies, Pi sessions, and necessary configuration. Protect any included credential material as secrets. Retrieval indexes are rebuildable and need not be authoritative backup inputs.

Initially use a documented stopped-service backup procedure: stop and settle the service, copy the complete authoritative set without any BRN writer running, and restore into a separate destination for verification. A live copy of a SQLite main file alone is not a backup protocol. Test restored approval eligibility and a writing/publication journey before cutover. Device loss still needs a user-managed backup such as Time Machine.

Pi reopening a session is not an integrity certificate. The inspected 0.85.1 loader skips malformed JSONL lines and can modify files during opening or migration. Do not build a BRN guarantee around a nonexistent passive strict-validation API, and do not silently introduce a competing session parser. [P3]

Archive authorization limits new retrieval. It cannot make a model forget archived content already retained in the current conversation or a compaction summary. Explain that distinction rather than promising per-command forgetting.

## Front matter

The small core, separate `kind` and semantic `type`, metadata preservation, and honest migration provenance were approved as the schema direction on 2026-09-09. They do not yet replace the governing eight-key schema in GitHub. Supporting field semantics below remain the baseline to make concrete when B and F are decomposed.

### Principle

Use a small required core, preserve useful domain metadata, and specify how each field affects lookup, filtering, interpretation, or integrity. More mandatory fields do not automatically improve answers.

| Purpose | Examples |
|---|---|
| Find content | Title, aliases, topic tags |
| Narrow a search | Semantic type, project, language, event date |
| Interpret evidence | Effective dates, supersession, source attribution |
| Maintain integrity | Stable ID, schema version, provenance |

### Required core

Require these for canonical publication, not initial capture or unfinished working text. BRN supplies bookkeeping; the user should not complete a metadata form for every save.

| Field | Meaning |
|---|---|
| `schema` | Record format version |
| `id` | Stable identity independent of title or path |
| `title` | Human-readable name and searchable text |
| `kind` | `note` or `source`, expressing body-preservation behavior |
| `provenance` | Typed origin facts from capture, writing, or import |

Preserve an existing title. Otherwise use a suitable heading, then the filename as a fallback. This must not require a model call; derived titles remain visible during review.

### Separate kind from type

The earlier BRN `type: note|source` combines a storage distinction with the field the existing vault uses for content classification.

Proposed examples:

```yaml
kind: note
type: decision
```

```yaml
kind: source
type: meeting
```

`kind` controls whether the body is authored/revisable or a preserved extraction. `type` describes a meeting, decision, person, project, or other content and can support filtering.

Preserve useful existing type names. Do not build a lifecycle for every type or infer that `type: decision` proves authorization. Unknown classification remains unknown rather than being guessed to satisfy validation. Importing an authored Note does not automatically make it a Source record.

### Useful optional fields

Optional means absent when unknown or irrelevant, not unimportant.

| Field | Recommended use |
|---|---|
| `type` | Existing semantic classification; strongly recommended when known |
| `lang` | Actual language, including English and Estonian |
| `created` | Original document creation date when known |
| `updated` | Content revision date, not indexing/import/path-only movement |
| `event_date` | Meeting, decision, or event date |
| `tags` | A few useful topic labels; an empty list is valid |
| `aliases` | Actual alternative names, abbreviations, and names in another language |
| `project` | Explicit relationship when folder placement is insufficient |
| `related` | Deliberate associations not already adequately expressed through body links |
| `valid_from`, `valid_to` | Applicability period only when it applies to the record as a whole |
| `supersedes` | Supported replacement relationship |
| Domain properties | Useful fields such as `org`, `role`, `attendees`, and source URLs |

Aliases are particularly useful for abbreviations and bilingual naming; BRN must index them explicitly. A `lang` label does not translate text. Preserve existing `summary_en`, but evaluate multilingual retrieval and derived translation before requiring generated summaries. Query language must not automatically exclude records in another language. [M2]

### Date semantics

A meeting can happen on 4 September, be documented on 5 September, imported on 7 September, and contain a decision effective from 1 October. Preserve those distinctions.

- Preserve known original dates; keep import time in provenance.
- Leave unknown dates absent.
- Use ISO date strings for date-only facts and timestamps with explicit time zones when that precision is known.
- Do not infer event dates from file modification time.
- Do not interpret recently edited as currently authoritative.
- Do not apply one record-level validity period to unrelated historical passages.
- Define date-range endpoints and missing/open-ended bounds before implementing filters.
- Superseded knowledge may still answer historical questions; supersession is not archival exclusion.

Creation, modification, issuance, and validity are distinct in established metadata vocabularies too. BRN need not implement a full vocabulary to preserve the distinction. [M3]

### Provenance and supporting evidence

- Inbox provenance identifies captured input, original-byte hash, extraction time, extractor, and relevant warnings.
- Session provenance identifies the originating Pi conversation. Later writing activity belongs in revision history rather than an ever-growing origin object.
- Proposed import provenance identifies the source collection, old relative path, original-byte hash, and import time. Do not invent historic extraction facts or sessions.
- An original source URL is not interchangeable with a local import path.

Origin is different from support. A session ID explains where a Note was produced, not which source passages justify its claims. Grounded writing should retain supporting canonical identities, observed revisions, and passage references through the citation mechanism. An untyped `related` link is not proof of support.

Approval authorizes retaining exact content. It does not certify factual truth or current applicability.

### Example

Fictional illustration of the proposed format, not a fixture valid under the currently resolved BRN schema. Most records need fewer optional fields.

```markdown
---
schema: 1
id: 7e0b4d88-0e8a-4cd9-8b3b-243b6e9556a4
kind: note
type: decision
title: Atlas rollout decision
lang: en
created: "2026-09-05"
updated: "2026-09-05"
event_date: "2026-09-04"
tags:
  - deployment
  - rollback
aliases:
  - Atlas launch approval
project: "[[atlas-project]]"
related:
  - "[[rollback-plan]]"
provenance:
  kind: session
  session_ids:
    - example-session
  created_at: "2026-09-05T09:00:00Z"
---

# Atlas rollout decision

The rollout will proceed in stages, with rollback criteria recorded separately.
```

### What belongs elsewhere

| Do not make this canonical bookkeeping | Where it belongs or why it is unnecessary |
|---|---|
| `approved: true` or a current approval hash | External durable approval evidence; content cannot authorize itself |
| Proposal state, retries, comment state | Agent-vault review/recovery state |
| Model, prompt version, token usage | Operational history, unless the record is about that experiment |
| Embeddings, ranking scores, passage IDs | Derived retrieval data |
| `location` duplicating the path | Derive physical placement from the path |
| `archived: true` duplicating an archive directory | Derive scope from the chosen archive representation |
| Mandatory AI confidence | Uncalibrated confidence is not truth |
| Mandatory summaries or keyword lists | Add only after a measured benefit |
| Type and lifecycle repeated as tags | Usually redundant |
| Benchmark world IDs, splits, and gold labels | Evaluation bookkeeping, never privileged retrieval assistance |

The original-input hash in provenance remains useful. It identifies captured bytes and is different from a current-record approval hash.

Do not delete historical metadata merely because BRN will not generate that field going forward. Existing `status` values mix workflow, maturity, and archival meanings; review their mapping rather than treating `active` or `approved` as BRN approval.

### Validation and migration rules

- Validate reserved field types, identities, paths, and parseable metadata strictly.
- Preserve additional safe metadata with diagnostics instead of rejecting or silently deleting every unfamiliar key.
- Use bounded JSON-compatible values, not executable YAML types. Reject duplicate keys and unsafe/ambiguous parser constructs.
- Preserve invalid source bytes and report diagnostics; do not reinterpret malformed metadata as approved content.
- Do not invent missing facts to pass validation.
- Normalize proposed metadata before approval, then commit exactly those bytes.
- Keep Source-record bodies intact. Unsupported constructs may render inertly instead of forcing conversion to a Note.
- Quote wiki-link values. Use lists for tags, aliases, and multiple related records.
- Normalize legacy hashtag-prefixed tags through a visible mapping.
- Favor flat user-edited properties. Nested app-managed provenance is reasonable, but Obsidian's property editor does not fully support nested properties. Consistent key order helps readability, not retrieval quality. [M4]
- Preserve unmapped legacy metadata without granting it automatic search or policy authority.

This intentionally changes #5's closed eight-key schema, required `location`, and single `type` axis. Exact-byte adoption of conforming records and transformation of legacy records are different operations.

## Retrieval and evaluation

### Field-to-behavior contract

| Information | Use |
|---|---|
| Title and aliases | Searchable name fields |
| Heading path | Passage context |
| Body | Main evidence text |
| Topic tags | Searchable keywords and optional filters |
| Type, project, language | Structured filters and result context |
| Event/validity dates | Temporal filtering and interpretation |
| Relevant domain properties | Searchable, labeled metadata evidence |
| IDs, hashes, extractor names | Lookup and integrity, not relevance text |

Do not concatenate all YAML into every passage. Keep fields separable so their weights and filters can be measured. Do not silently hard-filter on an uncertain model classification. FTS5 supports searchable and unindexed columns and per-column BM25 weights. [M1]

If a fact exists only in YAML, such as a person's role, it must remain retrievable when useful. A deterministic metadata passage can expose it, but its citation must identify the actual fields rather than pretend the display text was quoted from the body.

For long documents, begin with title and heading context. Research on contextual retrieval supports examining context lost during chunking; it does not establish that BRN needs an LLM-generated summary per passage. Keep generated retrieval aids separate from source evidence. [M5]

### Corpus and citations

Normal canonical retrieval admits approved, valid, current bytes only. It excludes working drafts, raw Inbox material, rejected content, Agent-vault state, and archives without explicit scope.

Human-facing navigation should help distinguish no matching evidence from a pending, excluded, externally modified, or archived item. It must not present those categories as canonical evidence.

Opening an old citation must distinguish its observed revision from the current record. Do not silently substitute new bytes for a historical quote. File conflicts and hashes do not provide automatic factual conflict detection; retain conflicting evidence and identify uncertainty in the answer.

### Use the existing synthetic suite

`second-brain-eval` is the primary retrieval regression and comparison system. Add a BRN adapter to its real retrieval implementation. Do not replace it with a smaller new benchmark merely because BRN is new.

Begin the comparison alongside the first end-to-end writing milestone, before bulk migration and cutover. Fix the fixture conversion, comparator baseline, metrics, and acceptance criteria before scoring candidates. Do not weaken the suite to preserve a preferred implementation.

Compare field use while holding the retrieval method fixed:

1. Body and headings.
2. Add explicit titles and aliases.
3. Add useful tags and selected domain properties.
4. Exercise genuine type/project/date filters.
5. Separately evaluate bilingual aids such as existing `summary_en`.

Measure relevance, complete evidence, wrong-passage results, forbidden results, deterministic rebuilding, latency, and footprint. Preserve held-out discipline and record corpus/profile identities. Keep hard scope-safety checks independent of relevance scores.

Version a BRN-format fixture conversion and compare methods on the same converted corpus. Preserve the meaning of queries and relevance judgments; never revise gold to favor BRN. Make field and passage mappings explicit rather than quietly changing the task.

Keep benchmark-only identifiers, splits, and gold labels out of searchable or model-visible content. The inspected v2 generator includes `world_id` in a filter case. Do not blindly forward that as information a real user supplied. Translate genuine semantic filters and document the evaluation mode.

A fake/oracle result checks test plumbing, not retrieval quality. A synthetic corpus must exercise the real BRN implementation. The stronger the synthetic suite, the less reason to replace it with casual search impressions; it still cannot certify document-comment usability or import fidelity.

No separate user-research program is required before building. Use normal personal writing to check the interaction. Final cutover includes a practical check of imported records and citations, not a competing retrieval leaderboard.

### Performance and provider work

FTS5 is a candidate baseline, not an obligation to ship inadequate retrieval. If it misses important cases, fix measured failures or adopt a proven alternative through the same interface.

Measure time to a usable draft and the effort of review alongside local timings. Heavy synchronous parsing/indexing can delay streaming and cancellation; test mixed workloads before adding worker threads. Track large-input behavior and actual provider calls rather than assuming Pi compaction rescues an oversized import.

The original numerical release budgets and mandatory private-query gate are still recorded in #9/#15/#39. Replacing them with the revised benchmark and cutover policy requires an explicit amendment, not an implicit waiver.

## Implementation capabilities

These are proposed replacements for the 21 existing capability parents. A through K are planning IDs, not GitHub issue numbers or single-session tickets. All are unimplemented. Decompose only the next approved capability against the repository that exists then.

Each capability leaves runnable checks for its behavior. J closes remaining gaps; it is not the first safety or integration test.

### A. Launch the BRN service and terminal conversation client

> **Design status (2026-09-09):** A concrete design and implementation plan for A are drafted at [docs/superpowers/specs/2026-09-09-brn-a-design.md](superpowers/specs/2026-09-09-brn-a-design.md) and [docs/superpowers/plans/2026-09-09-brn-a.md](superpowers/plans/2026-09-09-brn-a.md), with planning evidence in [docs/research/brn-a-planning-evidence.md](research/brn-a-planning-evidence.md). Awaiting technical-plan user review before implementation. Governing GitHub issues (#21, #27, #33, #40) are not yet reconciled; the parent owns those writes.

Outcome: start an independent foreground BRN service, connect the terminal client, and complete a real conversation with the pinned SDK.

Scope: minimal single-package TypeScript setup, documented service/client commands, authenticated loopback HTTP/SSE, direct SDK hosting, controlled resources, Pi credentials/sessions, and single-writer protection. The terminal supplies multiline input, streaming, readable tool status, cancellation, new/resume sessions, model selection, and context/usage display. Start with synthetic/disposable data and no model route to canonical mutation.

Acceptance:

- [ ] The pinned package set installs, builds, and type-checks; target SQLite exposes FTS5.
- [ ] Isolated real-SDK checks construct the service runtime, reopen native sessions, and verify tool/resource restrictions.
- [ ] One explicitly authorized live-provider chat succeeds through the terminal client.
- [ ] Session replacement, cancellation, and shutdown leave no stale bindings or orphaned writer.
- [ ] Client disconnection leaves accepted work running; reconnect retrieves current status and saved results without duplicate submission.
- [ ] Busy agent work and session switches follow the explicit single-operation policy.
- [ ] The service and client use supported interfaces without a Pi fork or native-terminal remote bridge.

Exclude: custom full-screen BRN panels, complete browser, Workers, universal provider certification, and an always-on daemon.

### B. Read and validate canonical records while preserving metadata

Outcome: inspect approved knowledge and represent existing material without discarding useful information.

Scope: stable IDs, the approved front matter direction, archive scope, basic links/backlinks, guarded managed paths, and database-backed durable approval eligibility. Define honest migration provenance. Do not require globally unique legacy basenames.

Acceptance:

- [ ] Representative existing record shapes have explicit mappings.
- [ ] Missing approval evidence or externally changed bytes cannot silently become canonical.
- [ ] Ambiguous links and duplicate identities are diagnosed rather than guessed.
- [ ] Source text is preserved and unsupported constructs render safely.
- [ ] Search-index deletion does not erase approval evidence.

Exclude: executing migration, graph visualization, and semantic relationship inference. Approved fixtures may include test-established approval evidence, never a production enrollment bypass.

### C. Create and revise working drafts from the CLI

Outcome: ask Pi to write, edit the result, leave, and resume later.

Scope: database-backed Markdown working text, service-mediated draft tools, immutable checkpoints for review/completed revisions/publication, `$EDITOR` export with revision-checked submission, source/session references, and simple destination selection. Selected records from B can ground initial writing before search F is complete.

Acceptance:

- [ ] Drafts and saved checkpoints survive restart.
- [ ] Model tools cannot change snapshots, comments, approval evidence, or recovery data directly.
- [ ] Failed or stale writes do not overwrite newer saved work; edited content remains recoverable.
- [ ] History restoration creates a new current version.
- [ ] Explicit destinations need no placement model call.

Exclude: generic Agent-vault families, tasks, Plans, and workflow engine.

### D. Publish an exact approved draft and recover safely

Outcome: approve a create or replacement without silent overwrite or duplicate publication.

Scope: exact preview/diff, frozen snapshot and preconditions, deterministic publication across SQLite and Markdown files, durable backups/evidence/operation state, conflict choices, retry, and restoration. Retain displaced bytes without automatic pruning; document the complete stopped-service backup and restore procedure.

Acceptance:

- [ ] Published bytes match the approved snapshot.
- [ ] Stale commands cannot overwrite newer canonical content; repeated IDs have one recorded effect.
- [ ] Crash and I/O failpoints leave preserved content and recoverable publication evidence.
- [ ] External modifications remain preserved and healthy records remain readable.
- [ ] The result distinguishes not published from successfully published.
- [ ] Restoration is explicit, preserves displaced bytes, and does not bypass approval for arbitrary older authored content.

Exclude: arbitrary compound changes, source rewrites for archive, mandatory Trash. Verify the approved retention and recovery coverage before personal data is written.

### E. Copy-import the existing work vault

Outcome: bring selected existing knowledge into BRN without changing the old setup.

Scope: read-only inventory/dry-run, metadata/path/identity/link mapping, selected archive handling, duplicate/unsupported diagnostics, explicit selection of a Resources source root, and batch approval of an exact migration manifest. Use D's publication/recovery operations.

Acceptance:

- [ ] Every selected file is accounted for as imported, explicitly excluded, or unresolved.
- [ ] The source vault remains untouched; no symlink target is traversed without explicit source authorization.
- [ ] Necessary mechanical content changes are shown separately from preserved prose.
- [ ] Interruption and repeat execution do not duplicate records or lose progress.
- [ ] Approval evidence derives from the explicit migration decision.

Exclude: generic legacy-vault migration, AI rewriting of existing knowledge, and deleting/reorganizing the old vault. Do not claim whole-batch atomic visibility.

### F. Connect canonical retrieval to the existing evaluation system

Outcome: search approved knowledge and measure the real implementation through `second-brain-eval`.

Scope: FTS5 as the first candidate, CLI search, scoped Pi search/read tools, bounded passages, citation revision behavior, a BRN adapter, and versioned schema-compatible fixtures. Start comparison alongside the first writing journey, with acceptance criteria fixed before candidate scoring.

Acceptance:

- [ ] Production retrieval, not a fake ranker, runs against the benchmark.
- [ ] Equal requests use the same logic and deterministic ordering.
- [ ] Eligibility, archive scope, filters, and stale-content suppression work.
- [ ] Rebuilds preserve results for the same approved corpus/profile.
- [ ] Relevant metrics, raw supporting artifacts, environment, and limits are recorded without private data.

Exclude: a replacement benchmark framework or a predetermined winner. Finalize relevance acceptance against the chosen suite before scoring candidates.

### G. Import new Markdown and text material through the CLI

Outcome: continue capturing files outside BRN and bring them in later.

Scope: explicit import/simple Inbox discovery, deterministic extraction and hashing, durable capture before optional enrichment, duplicate handling, manual metadata fallback, and review/publication through C/D.

Acceptance:

- [ ] Capture works without a provider connection.
- [ ] One bad file does not block others.
- [ ] Original changes or disappearance do not destroy saved extraction.
- [ ] A source-change warning permits explicit publication of the captured version.
- [ ] Originals remain untouched by default.

Exclude: rich extraction, automatic deletion, placement tuning, and a general ingestion scheduler.

### H. Read a draft and add anchored comments in the browser

Outcome: open a selected CLI draft in a comfortable browser workspace and comment while reading.

Scope: document endpoints in A's authenticated BRN service, full-width/expandable reading, text selection, database-backed comments/highlights, comment navigation, revision-checked direct edits with save feedback, immutable anchor version identity, reading-position restoration, safe rendering, and keyboard access. The browser remains usable without a connected terminal client while the service runs.

Acceptance:

- [ ] Comments identify the exact reviewed version and source text.
- [ ] Repeated phrases, formatted text, and long documents do not silently misplace anchors.
- [ ] Unresolved anchors are reported rather than guessed.
- [ ] Acknowledged edits and comments survive reload, disconnect, and restart.
- [ ] The browser cannot bypass canonical publication controls.

Exclude: complete web chat, Tasks, collaboration, and another Pi session manager. This is the initial production browser workspace, not a separate acceptance-only shell.

### I. Revise from comments and review the resulting changes

Outcome: submit accumulated comments, inspect one resulting revision, and publish or continue reviewing.

Scope: frozen source version/comment batch, source-grounded request through the originating Pi session in the service, request-specific output, new immutable checkpoint, diff with associated comments, continued edits/review, and D's publication action. A busy runtime rejects new work visibly. A different active session requires an explicit return; switching waits for completion or settled cancellation.

Acceptance:

- [ ] One successful batch creates one revision.
- [ ] Failed, cancelled, duplicated, or interrupted requests preserve the comments and source version; duplicates identify the existing operation and restart does not silently repeat paid work.
- [ ] A delayed result cannot overwrite newer edits; both versions remain available for an explicit choice.
- [ ] Unresolved selected anchors block batch submission rather than guessing a target.
- [ ] Session switches cannot route the request to the wrong conversation, and terminal disconnection does not prevent browser revision.
- [ ] Applied comments remain inspectable and reopenable; applied does not imply accepted or fully satisfied.
- [ ] Browser approval uses the same publication implementation as CLI.

Exclude: another agent engine, general workflow definitions, and automatic promotion.

### J. Verify the reduced product and recovery guarantees

Outcome: repeatable evidence for what the smaller app actually promises.

Scope: accumulated tests, synthetic retrieval, publication fault tests, actual SDK checks, real-browser comments, shared-operation coordination, security, accessibility, provider/input limits, and backup restoration.

Acceptance:

- [ ] Real-SDK checks and deterministic fake-based tests remain distinguishable.
- [ ] Fault tests preserve content and approval evidence.
- [ ] An authorized real-provider draft/comment/revision journey succeeds.
- [ ] Keyboard and critical accessibility journeys work in the target environment.
- [ ] Pi session-recovery limits and the complete stopped-service backup/restore procedure are explicit and tested, including the authoritative database.
- [ ] Measured product delays include provider work, not just local endpoints.

Exclude: complete client parity and a separate user-research program. Exercise exhaustive storage faults at the shared publication interface, with representative client wiring tests rather than duplicating every storage failure through every UI. Do not excuse a failed safety check as scope reduction.

### K. Rehearse migration and switch personal use

Outcome: use BRN with actual knowledge while retaining a safe way back.

Scope: rehearse into a separate destination, review accounting/exceptions, verify representative records/links/archives, complete a real writing-and-comment cycle, restore a backup, and agree how new writes stop in the old system.

Acceptance:

- [ ] Selected knowledge is accounted for and no unresolved data-loss issue remains.
- [ ] The motivating comment/revision/publication journey is usable.
- [ ] Backup restoration includes approval evidence, not just Markdown.
- [ ] The old vault remains available and unchanged.
- [ ] Temporary coexistence and rollback rules are explicit; no accidental dual-writer cutover.

Exclude: automatic shutdown of old services or deletion of the previous system. This is a practical migration/cutover check, not a requirement to re-prove the user's need.

### Dependencies and useful milestones

| Capability | Dependencies |
|---|---|
| A | Governing specification alignment with the approved scope/hosting changes |
| B | A |
| C | A, B |
| D | B, C |
| E | B, D |
| F | B |
| G | C, D |
| H | C |
| I | D, F, H |
| J | E, F, G, I |
| K | J |

These are capability dependencies, not a requirement to finish each letter before starting the next. After C, browser comments can proceed alongside retrieval and migration work. Use approved fixtures where needed to break test setup cycles; no production approval bypass is permitted.

### Approved delivery milestones

1. **Service and terminal conversation.** Complete A's ownership and client integration proof: controlled tools/resources, real-SDK construction, authorized provider chat, cancellation, session replacement, reconnect, and single-writer protection.
2. **One protected writing journey.** In a separate test vault, use the necessary portions of B/C/D/E/F/H/I to import a representative record, retrieve evidence, draft, comment, revise, and publish. Durable saves, stale-write checks, and publication recovery belong here, not only in J. Run the existing retrieval comparison alongside this journey, before bulk migration. Neither a representative import nor one successful search completes E or F.
3. **Broader knowledge coverage.** Complete known-vault migration mappings, ongoing Markdown/text capture, metadata filters, citations, long-document handling, and the remaining capability checks. Exercise representative record shapes rather than adding tasks, Workers, or general browser chat.
4. **Rehearsal and cutover.** J/K require accounting for every selected file, a real writing cycle, a tested complete backup restoration, and explicit old-system write cessation and rollback rules. Keep the old vault unchanged and available.

CLI-first does not mean finishing a comprehensive terminal product before browser comments. The release still replaces the vault; the first end-to-end milestone is not an export-only substitute. Only decompose the next approved capability in detail.

## Existing issue map

Preserve issue history and link replacements. Do not mark superseded scope completed or let removed requirements remain active through old source links.

| Existing issue | Proposed destination |
|---|---|
| #19 Bootstrap | A |
| #20 Managed roots and durability | B/D |
| #21 Local service | Independent foreground service, transport, and client coordination in A; document endpoints in H |
| #22 CLI/browser acceptance shell | Actual CLI in A and actual browser workspace in H |
| #23 Canonical records and graph | B; advanced graph requirements removed |
| #24 Agent-vault families | Reduced working/checkpoint state in C |
| #25 Proposals | C/D/H/I |
| #26 Tasks and Plans | Outside initial scope |
| #27 Shared Pi sessions | A; one service-owned active conversation, terminal controls, and session-bound document revisions |
| #28 Retrieval | F with the existing evaluation system |
| #29 Commit, backup, archive, Trash | D; remove mandatory Trash and compound embed rewriting |
| #30 External modifications and corruption | D/J |
| #31 Inbox ingestion | G |
| #32 Placement recommendations | Simple destination choice in C/G; no standalone tuning subsystem |
| #33 Tool policy and Workers | Restrictions in A/C/F; Workers deferred |
| #34 Workflows and learning | Concrete C/G/I operations; learning and generic run machinery deferred |
| #35 Full-screen CLI product | Small BRN terminal conversation client and bounded commands; native terminal reuse superseded |
| #36 Complete browser product | Focused H workspace |
| #37 Browser writing/review | H/I using D publication |
| #38 Release matrix | J plus capability-local checks |
| #39 Dogfood sign-off | K |
| No equivalent | E for the known existing-vault migration |

The direction is approved in this document. Amending GitHub and the governing documents remains a separate authorized step: reconcile #1, #16, #40, affected originating decisions #4 through #15, their capability bodies, the product specification, and relevant glossary definitions. In particular, align service ownership, authoritative SQLite, draft/checkpoint semantics, and the schema. No GitHub rewrite or glossary/product-spec edit was authorized as part of this plan update. The earlier map is not automatically replaced by writing this document.

## Pi updates and future growth

### Upgrade policy

Concentrating Pi integration in one module limits BRN's upgrade work, not all upstream risk. The approved service design still depends on Pi. Prefer documented SDK and extension interfaces over private imports, monkey-patching, or a fork.

Pi 0.85.1 is pre-1.0; version numbers alone do not promise stable APIs. [P6]

1. Pin all Pi dependencies and the lockfile. Run BRN's own dependency, not whatever global `pi` is on PATH.
2. Keep Pi-specific code concentrated in a small integration module. Do not leak runtime types into canonical storage and publication rules.
3. Keep BRN sessions from being inadvertently reopened by a newer unrelated Pi installation. Decide session storage and shared-credential behavior explicitly.
4. Read upstream changes and test upgrades against copied state first.
5. Run real-SDK construction, resource/tool policy, session replacement, cancellation, and reopening checks.
6. Run one real draft/comment/revision/publication journey, including source grounding and stale-result checks.
7. Keep a recoverable pre-upgrade snapshot. Pi can migrate sessions on load; downgrading the package alone may not restore compatibility. [P3]
8. Update deliberately for provider and security needs. Pinning controls timing; it does not make permanent freezing viable.

The terminal client depends on BRN's bounded client interface, not Pi's native terminal internals. Keep Pi-specific runtime/event translation in the integration module and test session replacement, completion, cancellation, and tool restrictions across upgrades. A successful TypeScript build alone does not establish compatible behavior.

### Growth into a fuller app

Independent service ownership is selected now. It permits later client expansion without promising that those features are already implemented or require no coordination work.

| Later need | Likely response |
|---|---|
| Better writing, import formats, retrieval, metadata | Extend BRN modules without changing Pi ownership |
| Tasks, Plans, repeatable work | Add BRN-owned durable state only when the feature is needed |
| General browser chat and session controls | Extend the browser and client interface; service ownership already exists |
| Multiple concurrent conversations | Replace the explicit single-operation policy with designed coordination and resource limits |
| Always-on background processing | Explicitly change foreground-service lifetime and recovery assumptions |
| Highly customized terminal | Extend the BRN client only for demonstrated needs; do not patch Pi internals |
| Measured blocking from indexing | Isolate that work after measurement, not preemptively |

This borrows the original client/service ownership arrangement without restoring two complete clients or the deferred operational subsystems. A focused browser and small terminal remain the initial scope.

Keep canonical identities, metadata, comments, approval, and recovery independent from Pi from day one. Pi may remain the agent engine indefinitely, but replacing it would still require work around conversations and provenance. Do not build a universal agent framework now.

Warning signs are repeated private-method patches, approvals stored only in conversation entries, a supposedly independent browser requiring a hidden terminal, or prompts standing in for write enforcement.

## Open decisions and next steps

The following design directions were approved in the 2026-09-09 brainstorming discussion. Approval here does not amend governing issues, establish runtime evidence, or authorize implementation. Remaining details are scoped to the capability that needs them.

| ID | Approved direction | Remaining decision or evidence | Needed before |
|---|---|---|---|
| D1 | Service-mediated drafts and exact human-approved publication; external modifications require reapproval | Verify model/client restrictions and publication recovery | A policy proof and D |
| D2 | Independent foreground BRN service with direct Pi SDK hosting, terminal chat, and focused document browser | Exact client commands/transport contract, credential configuration, and real-SDK integration evidence | A |
| D3 | Separate `kind`/semantic `type`, sparse core, preserved safe metadata, honest import provenance | Exact reserved-field validation and representative legacy mappings; amend governing schema | B |
| D4 | Authoritative SQLite for mutable draft text, immutable checkpoints, comments, requests, and approval evidence; `$EDITOR` uses checked export/submission | Database schema, migrations, editor selection/source mapping, and tested save/checkpoint boundaries | B/C/H |
| D5 | Reviewed copy-import through an exact manifest, with per-file accounting and unchanged originals | Actual source selection, Resources-root authorization, and concrete metadata/link mappings | E |
| D6 | Existing synthetic suite with explicit mappings, independent safety gates, and early comparison; FTS5 is a candidate | Choose fixture conversion, comparator, metrics, and preregistered relevance criteria before scoring | F scoring |
| D7 | Preserve known dates and domain metadata; provide genuine supported filters | Date precision, range endpoints, and supported property/filter list | B/F |
| D8 | Offline capture, explicit provider use, optional pausable enrichment, bounded calls and retries | Numeric input/output limits, deadlines, retry budgets, and egress presentation for each operation | A provider use; C/G/I |
| D9 | Retain originals, checkpoints, and displaced bytes without automatic pruning; reversible draft dismissal; complete stopped-service backup | Concrete backup procedure, schema-upgrade recovery, and demonstrated full restoration | D/E/K |
| D10 | One active conversation/agent operation; visible busy rejection; explicit return to the originating session; switch only after completion or settled cancellation | Test duplicate requests, reconnect, stale results, and interruption without automatic paid replay | A/I |

Do not resolve every future feature before starting. Settle only the choices needed by the next capability, while retaining this scope and its safety commitments. The implementation plan should focus first on A, not expand every A-K capability into speculative tickets.

### Before coding under the new direction

- [x] Approve vault replacement, the strict canonical approval model, independent service ownership, terminal chat, database-backed writing state, and the delivery milestones.
- [ ] Review this consolidated written design before writing an implementation plan.
- [~] Decompose A into a concrete design and implementation plan drafted at `docs/superpowers/specs/2026-09-09-brn-a-design.md` and `docs/superpowers/plans/2026-09-09-brn-a.md`; awaiting technical-plan user review, with real-SDK evidence distinguished from fakes.
- [ ] Separately authorize and amend the governing GitHub plan and affected decisions; link superseded issues to replacements.
- [ ] Align the product specification and relevant glossary terms without turning the glossary into an implementation plan.
- [ ] Decompose A against the actual checkout, with real-SDK evidence distinguished from fakes.

### Evidence that could change the plan

- Direct SDK hosting and the small terminal client cannot meet the required controls through supported interfaces.
- Database-backed draft editing or complete backup restoration cannot meet the approved durability and recovery guarantees.
- The current synthetic suite shows unacceptable retrieval regressions from the proposed baseline.
- Migration inspection reveals essential knowledge that cannot survive the proposed schema mapping.
- Comment anchoring or revision comparison is unreliable on long documents.
- Provider latency, input limits, or cost makes normal writing impractical.
- A fuller browser or background workflow becomes necessary in actual use.

Record the result and change the smallest affected decision. Do not reopen the entire architecture for a local problem.

### Plan history

| Date | Change | Status |
|---|---|---|
| 2026-09-08 | Standalone front matter recommendation recorded | Proposed |
| 2026-09-09 | Consolidated product review, user corrections, front matter, Pi integration, A-K capabilities, update policy, and growth path | Original working proposal; hosting and file-based draft recommendations now superseded |
| 2026-09-09 | User retained vault replacement and strict reapproval, chose independent service ownership and terminal chat, and approved SQLite-backed writing state, comment/revision behavior, knowledge migration, retrieval direction, and end-to-end milestones | Approved design directions recorded here; written review and governing-document alignment pending; GitHub unchanged |

When updating this plan, record the decision, its evidence, date, and resulting issue reference. The evidence for this revision is the user's explicit choices and section approvals in the 2026-09-09 brainstorming discussion; no resulting amendment issue exists yet because GitHub changes were excluded from this update. Mark a capability complete only with links to implementation and checks. Do not treat a planned API, prototype button, or fake-based test as proof of a real integration.

## References

### BRN decisions and prototypes

- [#1: original capability map](https://github.com/EvoKessler_ericcp/brn/issues/1)
- [#5: original canonical schema and source amendment](https://github.com/EvoKessler_ericcp/brn/issues/5)
- [#6: proposal and publication lifecycle](https://github.com/EvoKessler_ericcp/brn/issues/6)
- [#9: retrieval baseline](https://github.com/EvoKessler_ericcp/brn/issues/9)
- [#11: Pi tool policy](https://github.com/EvoKessler_ericcp/brn/issues/11)
- [#12: security and recovery](https://github.com/EvoKessler_ericcp/brn/issues/12)
- [#13: review/writing direction](https://github.com/EvoKessler_ericcp/brn/issues/13)
- [#14: chat/navigation direction](https://github.com/EvoKessler_ericcp/brn/issues/14)
- [#15: original verification gates](https://github.com/EvoKessler_ericcp/brn/issues/15)
- [#16: implementation review amendment](https://github.com/EvoKessler_ericcp/brn/issues/16#issuecomment-5572648427)
- [#40: selected stack](https://github.com/EvoKessler_ericcp/brn/issues/40)
- [Review/writing prototype](../prototypes/review-writing.html)
- [Chat/navigation prototype](../prototypes/chat-navigation-tasks.html)

### Local reference material inspected

These paths identify evidence; their contents are not instructions to execute the old system or expose private data.

- `second-brain-work/01-Projects/second-brain/how-the-vault-works-now.md`
- `second-brain-work/.github/copilot-instructions.md`
- `second-brain-work/.github/instructions/vault-conventions.instructions.md`
- `second-brain-work/06-System/Schemas/note-types.md`
- `second-brain-work/06-System/agent-prompts/brain-write.md`
- `second-brain-work/06-System/scripts/brain-ui-react/src/Review.tsx`
- `second-brain-work/06-System/scripts/docx-comments-extract.py`
- `second-brain-work/06-System/scripts/vault-indexer.py`
- `second-brain-work/06-System/scripts/qdrant_fts_provider.py`
- `second-brain-work/06-System/scripts/vault-search-api.py`
- `second-brain-eval/README.md`
- `second-brain-eval/v2_manifest.py`, `r3_manifest.py`, and `v2_metrics.py`
- `second-brain-eval/runners/adapters/python_engine.py` and `electron.py`
- `second-brain-eval/results/registered/README.md`

### Primary technical references

- **P1:** [Pi 0.85.1 SDK](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md), including direct hosting, runtime replacement, custom tools, and resource loading. The installed 0.85.1 SDK docs and `examples/sdk/12-full-control.ts` and `13-session-runtime.ts` were also read for this revision.
- **P2:** [Pi security](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/security.md), including the lack of an OS sandbox.
- **P3:** [Pi session format](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/session-format.md) and [session-manager source](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/session-manager.ts).
- **P4:** [Node 24.20 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html).
- **P5:** [Node 24.20 TypeScript](https://nodejs.org/download/release/v24.20.0/docs/api/typescript.html).
- **P6:** [Semantic Versioning](https://semver.org/spec/v2.0.0.html#spec-item-4), especially pre-1.0 compatibility expectations.
- **P7:** [Pi 0.85.1 RPC](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md), documenting headless subprocess integration, request acceptance versus completion, and client-managed interaction rather than a remote native terminal.
- **M1:** [SQLite FTS5](https://sqlite.org/fts5.html), including UNINDEXED columns and BM25 weights.
- **M2:** [Obsidian aliases](https://github.com/obsidianmd/obsidian-help/blob/master/en/Linking%20notes%20and%20files/Aliases.md).
- **M3:** [DCMI terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/), including created, modified, issued, and valid.
- **M4:** [Obsidian properties](https://github.com/obsidianmd/obsidian-help/blob/master/en/Editing%20and%20formatting/Properties.md).
- **M5:** [Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval). Vendor results are evidence about the evaluated methods and corpora, not BRN's proposed schema.
