# AI Knowledge Vault — Product Specification

## Product intent

Build a local-first AI knowledge system: a personal or shared second brain where users can capture material, create documents with AI, connect knowledge, manage tasks, and retrieve relevant information without surrendering control of their durable knowledge.

The system has a fully functional TypeScript CLI and a local web application. Both interfaces use the same domain and workflow services.

## Canonical knowledge model

The product has two connected vaults.

| Vault | Purpose | Agent permissions |
|---|---|---|
| Human vault | Durable, user-owned knowledge: approved notes, source records, projects, and reference material | Read; writes are staged for user approval |
| Agent vault | Operational context: agent memory, tasks, plans, workflow state, and pending proposals | Read and write independently |

The agent can use both vaults as context. It may independently update its own vault, but it may not silently alter the human vault.

### Conflicts

The human vault is the primary reference. If the two vaults disagree, the system notifies the user, shows the relevant differences, and lets the user decide which version is correct. It does not silently overwrite either version.

## Human-vault organization

The default structure is PARA:

| Area | Meaning |
|---|---|
| Projects | Time-bound work with a defined outcome |
| Areas | Ongoing responsibilities or domains |
| Resources | Reference material and topics |
| Archives | Inactive or completed material |

Users can create additional folders as needed.

### Archive policy

Archives are excluded from normal agent search and retrieval. They are included only when the user explicitly asks to search or use archived material.

### Knowledge graph

Tags and wiki-style links are core from the first release. Approved records form a browsable, retrievable knowledge graph. The exact typed-link taxonomy remains open for testing.

## Approval and validation

No content reaches the human vault without explicit user approval.

Each proposed record must include complete front matter before it can be approved. The initial required fields are:

- Title
- Type
- PARA location
- Source
- Ingestion date
- Tags
- Related links

The precise schema remains open, but all required fields must be present and valid.

Before a write is allowed, a deterministic validator—not the AI alone—checks that the front matter is correctly formatted and usable. It validates schema, allowed locations, paths, tags, and link syntax. Safe formatting problems may be repaired automatically, after which validation runs again. Human approval is still required for the canonical write.

## Entry paths into the human vault

There are two ways to create canonical knowledge:

1. **Local Inbox ingestion:** Files placed in a local Inbox folder are automatically processed when the application runs.
2. **Agent-initiated creation:** A user asks the agent to create something—for example, a note, document, or email. The agent opens an AI writing session rather than a blank-note form.

Both paths produce the same kind of proposed record, pass validation, and enter the same human approval flow.

## Inbox ingestion workflow

1. The user places a source file in the local Inbox folder.
2. The app discovers and processes the file automatically.
3. The system preserves source provenance and creates a Markdown-based working representation.
4. The agent analyzes the content in the agent vault.
5. The agent proposes front matter, related records, and a PARA destination.
6. The proposal enters the approval queue.
7. The user approves, edits, or rejects it.
8. Approval writes the validated record to the human vault and moves the original Inbox file to the operating system Trash.

The Inbox therefore stays clear while the original remains recoverable through Trash.

### Day-one source support

Start with simple text-only sources. Rich image, table, and layout handling is deferred.

The long-term extraction model is format-specific but consistent:

```text
Original source
→ format-specific extractor
→ Markdown representation plus assets and warnings
→ agent classification and proposed metadata
→ user review
→ validated canonical write
```

Later processors may support Word images and tables, PDFs and OCR, PowerPoint slides and notes, emails and attachments, and image OCR or descriptions.

## Placement policy

The agent proposes a PARA destination based on content, existing related records, and vault patterns.

- For high-confidence placement—such as a source strongly resembling several existing records in one project—the agent shows one recommended destination in the front matter. The user sees and approves it with the note.
- For low-confidence placement, the agent presents its recommendation alongside plausible alternatives and asks the user to choose.

The confidence threshold is a placeholder to tune through real-file testing.

## Approval queue and writing workflow

A pending proposal has three user actions:

- **Approve:** Validate and write the note to the human vault.
- **Reject:** Delete the pending proposal; it does not enter the human vault.
- **Edit:** Open the AI writing workspace for user-and-agent revision.

In the writing workspace, the user can make direct edits, use inline comments, or ask the agent for revisions. Version history is retained so the user can undo or restore earlier states.

After editing, the user can:

- **Approve now:** Write the current validated version immediately to the human vault.
- **Save for later:** Replace the existing pending proposal in the approval queue with the current draft, while retaining its edit history.

The writing flow must propose complete front matter and a destination. It asks the user when it cannot determine them confidently. A document lacking valid front matter cannot be approved.

## Agent model

The user normally interacts with a primary agent. That agent can delegate focused work to subagents. Repeatable operations, especially ingestion and writing, are modeled as workflows.

The agent maintains tasks, memory, run state, and operational plans in the agent vault. It can create and update that operational state independently.

## Tasks

The agent can surface actions from conversations, Inbox ingestion, email, and writing work. It maintains its own to-do list in the agent vault and can update it when approved work completes. Tasks should remain visible to the user and retain their source or session context.

## Retrieval

Retrieval is modular. The system will begin with a reliable baseline over approved human-vault content, then support experiments with standard retrieval-augmented generation, hybrid retrieval, and graph-based retrieval.

Detailed integration with the existing retrieval implementation is deferred for a separate technical review.

## Interface direction

The first graphical interface is a minimal, desktop-first local web app.

| Area | Purpose |
|---|---|
| Left panel | Session history, vault navigation, and Inbox access |
| Main panel | Focused chat and task-aware interaction |
| Writing panel | Drafting, inline review, and revision history |
| Review panel | Approval queue with approve, edit, and reject actions |

The UI should keep agent activity and Inbox state visible without overwhelming the user. Opening a writing panel brings editing into focus while retaining relevant conversation context.

## Technology direction

- The core is a fully functional **TypeScript CLI**.
- The local web app is also fully functional; it is not just a display layer.
- Both interfaces expose the same core workflows through shared domain and application services.
- The initial product is a local web app; PWA packaging, Tauri, and Electron are future deployment options.

### Pi runtime integration

Pi is the agent-runtime foundation. It provides chat, authentication, session handling, compaction, and agent tools; the product does not rebuild those facilities.

- A single local Pi runtime service is shared by the CLI and local web app.
- A session created or resumed in either interface appears in the same session list in both interfaces.
- The service runs only while the user has the application open. It does not run in the background; Inbox processing and failed-commit retries resume on the next launch.
- Version one is single-user, single-vault, and local-only. Multi-user sharing and application-level roles are deferred.
- One default model is provided, with a user option to select a different model. A replacement model continues the same session with its existing history.
- Pi's built-in compaction is used. The chat prominently displays context-window usage, with visual warning states as it nears capacity. Version one adds no forced handover or new-session flow.

### Runtime trust boundary

Pi never receives write access to the human vault. It can read canonical knowledge and create proposals in the agent vault.

```text
Pi proposal in agent vault
→ user approval
→ deterministic validation
→ deterministic commit service
→ exact immutable write to human vault
```

Approval freezes the proposal. If anything changes, it becomes a new proposal requiring approval. Failed commits remain frozen in the review panel with a clear error; the system automatically retries the same immutable proposal when the underlying problem is resolved.

### Agent vault

Pi's operational state is stored in a visible local agent vault: sessions, task state, proposals, learnings, and workflow history. It is managed through the review experience rather than by direct user edits.

The agent may derive learnings from sessions and place them in the review panel with rationale and source sessions. Only user-approved learnings are promoted into the human vault. Raw session history is never automatically made canonical.

The user-facing interface is content-first: it shows sessions, proposed documents, and document diffs, rather than technical tool-call traces.

## Intentionally open decisions

- Exact front-matter schema and type taxonomy
- Typed versus untyped graph links
- Confidence threshold for automatic placement recommendations
- Exact day-one source formats
- Baseline retrieval approach and evaluation method
- Exact Pi adapter contract and external-tool catalog
