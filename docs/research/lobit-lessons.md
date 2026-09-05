# Applicable lessons from Lobit

## Answer

BRN should preserve Lobit's behavioral boundaries, not its architecture or retrieval choices.

The strongest lessons are these:

1. Give the human vault one deterministic mutation service. It validates paths and content, governs both ends of a move, writes the exact reviewed bytes without overwrite, and records approval and execution separately.
2. Keep proposals, Inbox material, archives, and app-owned history out of default retrieval by construction. Use an allow-list or an equivalent positive eligibility rule. Archive access must still be available when the user explicitly requests it.
3. Make the web app, CLI, and Pi tool call the same search application service. Pi should receive clean, bounded, structured results, not UI markup or whole notes.
4. Treat indexing as recoverable derived state. Incremental scans, deletion pruning, visible degraded status, and retry after parse failures matter more than adding an elaborate ranking strategy.
5. Adopt the evaluation discipline: frozen corpus identity, pre-registered decision rules, paired per-query scoring, hard non-recall guards, and evidence validation. Do not adopt a retrieval strategy because Lobit happened to ship or test it. Its own experiments adopted none of seven Tier 1 variants.

Lobit's one-vault zones, Electron shell, permissive metadata, rich-format ingest, in-vault original copies, and never-readable archive do not fit BRN v1. BRN needs two physically distinct vaults, shared TypeScript application services behind a CLI and local web app, stricter canonical metadata, text-only ingest, and an explicit macOS Trash step after successful approval and commit.

## Sources and limits

This report read these local snapshots. Untracked scratch files were not used.

| Source | Snapshot | Role |
|---|---|---|
| `lobit` | `c2b75269144c754e145e0bd4ad5d02b98c6cdf14`, branch `prototype/agent-work-proposal-review` | Current governed-write and review prototype, ADRs, and focused tests |
| `second-brain-electron` | `ffa85d81d19f06af928f38c2d09b16422335672d`, local `main` | Earlier product source, end-to-end indexing tests, Pi search contract, and retrieval experiment reports |
| `second-brain-eval` | `9b4051dce914711699cce261ecaec7dea0cd6570`, local `main` | Standalone synthetic corpus, metrics, comparator, and hostile-input tests |

The `second-brain-electron` research notes are first-party experiment records, but this checkout does not contain the raw rankings they cite. The `second-brain-eval` checkout also contains no registered result JSON beyond its instructions. The measured numbers below are therefore recorded findings, not independently recomputed results. The executable metric and comparator contracts were inspected and tested locally.

BRN's comparison point is its [product specification](../product-spec.md), especially the two-vault trust boundary, immutable approved proposals, archive opt-in, text-only v1, macOS Trash, shared TypeScript services, and local Pi runtime.

## What BRN should preserve

### One human-vault commit path

Lobit's clearest design decision is that all note mutations pass through one governed write, so policy and audit completeness come from structure rather than caller discipline. The ADR also admits the limit of a source inventory test: it catches accidental direct writes, not deliberate circumvention ([ADR 0001](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/docs/adr/0001-one-governed-write-path.md#L1-L29)).

The implementation resolves every path before policy evaluation, applies the strictest verdict to a multi-path mutation, performs once, and emits one execution audit. Moves write the destination with `wx` before removing the source, which prevents overwrite if a file appears during approval ([governed-write.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/governor/governed-write.ts#L67-L175)). Tests cover every policy tier, both move endpoints, the approval race, and audited filesystem failure ([governed-write.test.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/tests/governed-write.test.ts#L108-L427)).

Apply the lesson more narrowly in BRN:

- Pi gets no filesystem capability for the human vault. It creates proposal records in the agent vault.
- One deterministic human-vault commit service is the only code allowed to create, replace, move, or remove canonical Markdown.
- The service accepts a frozen proposal identifier and content hash, not mutable draft text.
- It revalidates the frozen bytes and target at commit time, refuses overwrite, and records the proposal id, content hash, actor, user decision, paths, and outcome.
- Moving or replacing content governs every affected path as one operation.
- CLI and web handlers call this service. Neither interface owns separate write logic.

Lobit's planned-content test is useful: if the source changes while an approval is open, the destination still receives the bytes that were planned and reviewed ([promote.test.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/tests/promote.test.ts#L184-L219)). BRN should make that durable with an immutable proposal record and hash. Lobit does not prove BRN's required retry behavior after restart, nor does its write-then-unlink move provide a transaction across both files.

### Separate decision audit from mechanical execution

Lobit distinguishes a live human approval, a user gesture carried by the caller, and an app-internal approval source. Its tests make blocked writes unattributed rather than falsely claiming approval ([approval-source.test.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/tests/approval-source.test.ts#L1-L63)). The newer review service records the user's approve or reject decision separately from the later execution record ([review-service.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/review/review-service.ts#L168-L242)).

BRN should keep those as distinct facts. An approval followed by a disk error is still an approval, but it is not a successful canonical write. A retry must reuse the same frozen proposal and add another attempt record rather than synthesizing a second approval.

### Preview the exact deterministic commit

Lobit's review preview calls the same promotion planner as execution and shows path, front matter, content before and after, and destination conflict without writing ([review-service.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/review/review-service.ts#L130-L165)). Its tests verify that an occupied destination does not hide the proposed payload and that preview leaves both files untouched ([review.test.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/tests/review.test.ts#L29-L84)).

BRN should expose the same review model in CLI and web:

- proposed final path and PARA location
- complete normalized front matter
- source provenance
- body diff or complete body for a new record
- links and tags after normalization
- blocking validation and collision errors
- immutable proposal version or hash

Approve must commit exactly that preview. Editing creates a new proposal version and invalidates the old approval.

### Positive retrieval eligibility

Lobit indexes only Projects, Areas, and Resources. Inbox, Staging, Archive, app-owned underscore directories, and unknown top-level folders stay out because they were never admitted ([zones.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/shared/zones.ts#L14-L69), [ADR 0004](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/docs/adr/0004-indexing-is-an-allow-list.md#L1-L8)). Tests pin exact directory boundaries and exclude nested app history so superseded copies cannot appear as near-duplicates ([zones-indexing.test.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/tests/zones-indexing.test.ts#L10-L65)). A real integration test shows an Inbox note is unfindable until filing moves it into an indexed PARA area ([file-into-loop.test.ts](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/tests/file-into-loop.test.ts#L128-L174)).

BRN should use positive eligibility too, but not Lobit's fixed three-folder list. The product specification permits user-created folders. A record is eligible for normal retrieval when all of these hold:

1. It is in the human vault, not the agent vault.
2. It passed canonical validation and was committed through approval.
3. It is not under Archives or any app-owned history area.
4. It is a Markdown record type eligible for retrieval.

Path checks must respect directory boundaries. Every indexing entry point, initial scan, add, change, move, and retry, must call the same predicate. Inbox source files and agent-vault proposals never enter the canonical index.

### Archive as an explicit search scope

Lobit correctly separates indexing policy from direct-read policy, then documents a defect in that separation: its search tool has no invisibility filter, so Archive stays safe only because Archive is unindexed ([ADR 0005](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/docs/adr/0005-invisibility-is-not-indexing.md#L1-L27)). The later source has no archive-search toggle, and its retrieval report says any future scope must apply equally to human and agent search and must not be agent-overridable ([retrieval-35-05](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-05-latency-safety-scope.md#L166-L214)).

BRN differs in one decisive way: archived material must be available when the user explicitly asks for it. Implement archive inclusion as an explicit request scope, not as a second ungoverned tool and not as a persistent agent preference. The same scope object must constrain search, list, and read. Default requests exclude archives. An explicit user request can set `includeArchives: true` for that operation or session. Pi cannot turn it on by itself.

Tests should cover:

- default UI, CLI, and Pi search never return Archive
- a known archive path cannot bypass default scope through read or list
- an explicit user archive search can return Archive
- the same query and scope yield the same ranked ids in UI, CLI, and Pi
- moving a note into Archive removes it from the normal index, and moving it out restores it

### Recoverable, honest indexing

The earlier implementation has useful executable contracts for derived index state. A cold start against an unchanged persisted index does no re-chunking or embedding. One changed file only reindexes that file. A deletion while the app is closed purges stale rows ([vault-watcher-incremental.test.ts](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/tests/vault-watcher-incremental.test.ts#L149-L221)). On parse failure, it retains the last good rows and hash, reports an error, retries the changed bytes on the next scan, and continues indexing other files ([vault-watcher-incremental.test.ts](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/tests/vault-watcher-incremental.test.ts#L271-L388)).

BRN should preserve incremental indexing, deletion pruning, counted errors, continued scans, and retry. Whether a parse-broken file may continue serving last-known-good content is a product decision. If allowed, every result from that file needs a stale-source signal and the app needs a degraded index state. Serving stale content silently would conflict with the human vault being primary.

### One Pi-facing search contract

The Pi tool in the earlier source delegates to the same search function used by the app. It returns path, title, snippet, score, and result count. It strips FTS display markup and caps each snippet at 512 tokens without changing rank order or metadata ([vault-search.ts](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/src/core/agent/tools/vault-search.ts#L11-L63)). Tests pin clean text, bounded payload, unchanged result identity, and honest count ([retrieval-input-fidelity.test.ts](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/tests/retrieval-input-fidelity.test.ts#L279-L313)).

BRN should preserve that contract through a shared TypeScript search service used by CLI commands, local web routes, and the Pi adapter. The Pi tool should accept at least `query`, `limit`, and a user-authorized scope. Results need stable record and passage ids, path, title, clean excerpt, score, and archive status. Keep the default result and excerpt bounds explicit and testable.

If retrieval later uses an LLM at query time, do not run a full agent session. The earlier project isolated model completion from tools, imposed a two-second no-retry timeout, and disabled query-time completion for both parent and subagent searches to avoid invisible cost and query egress ([retrieval-35-05](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-05-latency-safety-scope.md#L7-L25), [retrieval-35-05](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-05-latency-safety-scope.md#L113-L164)). BRN v1 should avoid query-time LLM retrieval unless evaluation proves a gain and the user can see the egress and cost.

## What BRN should reject or replace

### Reject Lobit's zone model as the trust boundary

Lobit keeps canonical notes, staging, Inbox, archive, and app assets under one vault root. BRN's agent vault and human vault have different owners and permissions. Folder policy inside one root is not a substitute for separate roots and separate capabilities. In particular, Pi should not receive a path from which traversal or a misplaced tool can reach canonical files.

Keep PARA organization inside the human vault. Put sessions, tasks, workflows, proposal versions, retries, and review history in the agent vault. Index them separately, if at all. Pi may search both only through distinct read services with clear source labels. Normal canonical retrieval must never mix agent drafts with approved knowledge.

### Reject Lobit's validator as insufficient

Lobit's validator requires only `type` and `status`, checks three optional date fields, warns rather than blocks on missing tags, and does not validate title, PARA location, source, ingestion date, or related links ([content-validator.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/ops/content-validator.ts#L10-L68)). That is weaker than BRN's required metadata and cannot be reused as a behavioral specification.

BRN approval must block unless its full schema is valid. The validator must check allowed types, canonical PARA location and path agreement, source provenance, ingestion date, normalized tags, wiki-link syntax, and related-link targets or declared unresolved links. Safe normalization can create a new proposal version, but it cannot mutate frozen approved bytes.

### Reject rich-format ingestion and in-vault source copies for v1

Lobit's ingest service accepts DOCX, EML, and PDF but not Markdown. It copies the original into `00-Inbox/_originals`, may write attachments or images, and writes the generated note last ([ingest-service.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/ingest/ingest-service.ts#L12-L28), [ingest-service.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/ingest/ingest-service.ts#L154-L211)). It also treats user-initiated ingest as pre-approved. Those choices conflict with BRN v1.

BRN should start with named text-only formats and one extractor contract:

```text
Inbox source bytes
-> supported-format check
-> deterministic text extraction
-> provenance plus warnings
-> proposal in agent vault
-> user review
-> frozen validation and human-vault commit
-> move the original Inbox file to macOS Trash
```

The source remains in Inbox until canonical commit succeeds. Trash failure must not roll back or duplicate the canonical note. It should leave a visible cleanup error and retryable action. Do not store original binaries, attachments, images, OCR output, or layout assets in the human vault in v1. Do not infer approval from the act of dropping a file into Inbox.

The macOS Trash action needs its own platform adapter and integration test. Lobit provides no applicable contract for this requirement.

### Reject Lobit's rejection lifecycle as BRN's default

Lobit moves rejected proposals to `_Staging/_expired`, exposes restore and permanent-delete actions, and requires a fresh critical confirmation for permanent deletion ([review-service.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/review/review-service.ts#L220-L242), [review-service.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/core/review/review-service.ts#L366-L438)). This is a thoughtful recovery model, but BRN's current specification says Reject deletes the pending proposal.

Do not silently add a Rejected tab. Preserve only the decision audit and any workflow history already required in the agent vault. If recoverable rejected content is desired, decide its retention, visibility, and deletion semantics explicitly.

### Reject fixed-folder archive invisibility

Lobit's archive is never readable by agent tools. BRN requires archive inclusion on an explicit user request. A static `AGENT_INVISIBLE_ZONES = ["04-Archive"]` rule ([zones.ts](https://github.com/EvoKessler_ericcp/lobit/blob/c2b75269144c754e145e0bd4ad5d02b98c6cdf14/src/shared/zones.ts#L61-L77)) would make that requirement impossible. Replace it with request-scoped authorization enforced by search, list, and read.

### Reject Electron and product-specific UI wiring

The source applications are Electron products. BRN is a TypeScript CLI plus local web app. Preserve domain contracts and executable tests, not IPC channels, preload APIs, renderer state, or Electron filesystem assumptions. The commit, review, ingest, and search services must have interface-neutral inputs and outputs so CLI and web remain equally functional.

## Retrieval findings worth carrying forward

The previous program's most useful retrieval result is restraint.

The evaluation method pre-registered baselines and decision rules, proved each strategy changed rankings before scoring it, required target lift and fixed no-regression guards, measured cost, and used `KEEP`, `PARKED`, or `INCONCLUSIVE` rather than treating non-significance as success ([retrieval-35-01](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-01-method.md#L6-L55)). The standalone eval repo generates seeded synthetic vaults at multiple scales and keeps a private real-vault set as final arbiter (`second-brain-eval@9b4051d:README.md`, lines 15-28 and 255-263).

### Recorded measurements

| Finding | Evidence | BRN consequence |
|---|---|---|
| On the 180-query v2 split, Electron hybrid measured overall nDCG@10 0.860, MRR 0.857, Recall@10 0.953. It lost significantly to the Python arm on temporal queries: 0 wins, 7 losses, 23 ties, p=0.0156. | [retrieval-35-01](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-01-method.md#L74-L97) | Do not inherit a default algorithm. Include temporal wording and paired comparisons in BRN's gold set. |
| Multi-hop Recall@10 was 0.767, but all-condition hit@10 was 0.567 and only 0.200 at k=5. Complete evidence appeared before a partial-only decoy in 0.133 of k=10 cases and 0.000 at k=5. | [retrieval-35-01](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-01-method.md#L196-L219) | Aggregate recall is insufficient. Score complete evidence groups, partial-only exposure, and the reader's actual result budget. |
| Passage and grounding fidelity produced a recorded +0.235 nDCG@10 overall on v2's rerank path and raised temporal from 0.335 to 0.988. | [retrieval-35-06](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-06-conclusions-and-next.md#L12-L44) | Test parsing, passage text, markup removal, and bounds before adding ranking stages. |
| Query decomposition made one completion call on all 30 multi-hop queries, left all-condition hit@10 unchanged at 0.567, roughly halved hit@5, and lost entity anchors in generated subqueries. | [retrieval-35-04](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-04-tier1-experiments.md#L145-L192) | No query decomposition in BRN v1. |
| HyDE was not built because its pre-registered paraphrase target already scored 1.000 at n=21. | [retrieval-35-04](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-04-tier1-experiments.md#L194-L204) | Do not build a strategy without a target corpus that has headroom and enough power. |
| Seven Tier 1 arms produced zero adoptions. The research identified ceiling strata, weak power, a single rerank-slot conflict, and ranking ties as limits. | [retrieval-35-06](https://github.com/EvoKessler_ericcp/second-brain-electron/blob/ffa85d81d19f06af928f38c2d09b16422335672d/docs/research/retrieval-35-06-conclusions-and-next.md#L1-L42) | Ship a deterministic baseline and experiment behind the same contract. Do not commit graph, rerank, or query-generation work to v1 without BRN evidence. |

The synthetic results verify contracts and compare named snapshots. They do not establish quality on BRN's eventual documents or prove that hybrid retrieval is better than a simpler baseline. BRN should benchmark its baseline after its metadata schema, chunking, archive scope, and source formats are fixed.

### Evaluation contracts to reuse

`second-brain-eval` implements metrics that ordinary nDCG misses: evidence-group coverage, all-condition hit, complete-evidence prefix rank, complete-before-partial, forbidden-hit, deleted-evidence return, and correct-document/wrong-chunk rate (`second-brain-eval@9b4051d:v2_metrics.py`, lines 7-63). Tests pin the conjunctive and deletion cases (`second-brain-eval@9b4051d:tests/test_v2_metrics.py`, lines 6-44).

Its R3 comparator refuses duplicate queries, repeated documents, unknown ids, coverage mismatch, mixed corpus or app provenance, missing guards, and mutable thresholds. It uses paired nDCG values and an exact sign test over non-tied queries (`second-brain-eval@9b4051d:runners/compare_r3.py`, lines 60-62, 140-177, and 432-453). Hostile-input tests reproduce the failures rather than only asserting a happy path (`second-brain-eval@9b4051d:tests/test_compare_r3.py`, lines 1-43 and 181-431).

BRN should begin with a smaller fixture, but keep these properties:

- seeded, synthetic, versioned corpus outside the user's vault
- exact corpus, query, qrel, app commit, index profile, and pipeline identity
- gold lint before scoring
- paired per-query metrics, with ties and effective sample size reported
- hard zero bars for Archive leakage by default, agent-vault proposal leakage, rejected content, and deleted content
- separate diagnostic and decision modes
- a private dogfood set as final confirmation
- mutation checks that deliberately break archive filtering, deletion pruning, passage cleaning, and commit gating

## Proposed acceptance contracts for BRN backlog items

These are behavior contracts, not module or command names.

### Governed write and review

1. Pi cannot open, write, rename, or delete any human-vault path.
2. A proposal without every required field cannot be approved.
3. Preview and commit use the same deterministic plan and content hash.
4. Editing after review creates a new proposal version that needs a new approval.
5. Approval followed by commit failure leaves the frozen proposal retryable and the human vault unchanged.
6. Retry commits the same bytes and never asks for approval again.
7. A destination created after preview is never overwritten.
8. Every attempt records user decision, proposal id, bytes hash, paths, and outcome.
9. CLI and web produce the same decisions and errors for the same proposal.

### Ingestion

1. Unsupported or non-regular files fail before content processing and enter no index.
2. Text extraction records source filename, source hash, ingest time, extractor identity, and warnings.
3. Inbox input creates a proposal only. Dropping a file is not approval.
4. The source remains in Inbox through rejection and commit failure.
5. Only a successful canonical commit triggers the macOS Trash adapter.
6. Trash failure leaves one canonical note, one recoverable source, and a visible retryable cleanup error.
7. Inbox and proposal content never appears in normal search.

### Retrieval and Pi search

1. UI, CLI, and Pi use one search service and produce the same ordered ids for equal query, limit, and scope.
2. Normal scope searches approved human-vault records and excludes Archive, Inbox, agent vault, proposal history, and app history.
3. Only an explicit user scope includes Archive. Pi cannot broaden scope.
4. Search, list, and read enforce the same archive scope.
5. Pi excerpts are clean, bounded, structured, and traceable to stable record and passage ids.
6. Moving, deleting, or archiving a note removes stale results after the index settles.
7. A parse or indexing failure is counted and visible, does not abort the scan, and is retried on launch.
8. Evaluation fails on any default Archive hit, agent-vault hit, or deleted-content hit.

## Decisions and fog exposed

### Recommended decisions

- Use separate filesystem roots for human and agent vaults. Folder zones are organization, not the trust boundary.
- Give the human vault one deterministic commit service shared by CLI and web.
- Use positive canonical-retrieval eligibility and explicit user-authorized archive scope.
- Start with deterministic baseline retrieval. Keep decomposition, HyDE, rerank, graph retrieval, and query-time LLM calls out of v1 until BRN's own evaluation supports them.
- Move an Inbox source to macOS Trash only after the canonical commit succeeds.

### Decisions still needed

1. Which text-only source extensions are day-one formats: plain text and Markdown only, or another text container such as HTML or EML without attachments?
2. Does rejected proposal content disappear immediately, or does the agent vault retain a recoverable version for a stated period?
3. May normal search serve last-known-good indexed text for a canonical file that is currently unreadable or invalid? If yes, how does every interface disclose staleness?
4. Is explicit archive inclusion scoped to one search call or to a user-visible session setting?
5. Which deterministic baseline should BRN evaluate first? The Lobit evidence does not settle FTS versus vector or hybrid retrieval for BRN.
6. What is the smallest representative BRN corpus and query set that can gate archive exclusion, metadata filters, deletion pruning, temporal queries, and evidence assembly?

## Verification performed

- Lobit: 42 focused tests passed across governed writes, approval source, review preview, promotion, rejection lifecycle, and index-zone eligibility.
- `second-brain-eval`: 40 tests passed across v2 metrics and the fail-closed R3 comparator, including hostile evidence inputs.
- `second-brain-electron`: the three selected suites could not run in this checkout because its test script could not find the `electron` executable. Their source and recorded project-level results were inspected, but this report does not claim a fresh run.

## Decision gist for the map

Preserve Lobit's single governed commit path, exact review preview, positive retrieval eligibility, shared bounded Pi search, resilient indexing, and fail-closed evaluation discipline; reject its one-vault zones, permissive metadata, rich ingest, in-vault originals, fixed archive invisibility, and unproven retrieval strategies in favor of BRN's two-vault, text-only, macOS-Trash design.
