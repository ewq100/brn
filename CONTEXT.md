# AI Knowledge Vault

A local-first knowledge system that separates user-approved knowledge from agent working state.

## Language

**Human vault**:
The app-managed Markdown store for durable, user-owned knowledge. Only a validated proposal that the user approved may enter it.

**Agent vault**:
The local store for sessions, tasks, plans, workflow state, and proposals that the agent may update without approval.
_Avoid_: AI vault, AI operational vault, operational vault

**BRN service**:
The single foreground process that owns BRN state, hosts the Pi SDK in-process, and serves the terminal and browser clients over authenticated loopback HTTP and SSE. It is started and stopped explicitly. A client disconnecting does not stop it; stopping the service stops accepted work.
_Avoid_: BRN daemon, background service

**Terminal client**:
The small line-oriented conversation client that connects to the BRN service for chat, tool status, cancellation, session and model control, and context/usage display. It is not Pi's native full-screen terminal reused over a remote link.
_Avoid_: BRN TUI, terminal app

**Browser document client**:
The browser workspace for reading drafts, commenting, revising, and approving. It has no general chat or session manager and stays usable while no terminal client is connected.
_Avoid_: web app, browser chat

**BRN operation**:
One durably tracked agent run (a prompt through its result), identified by a BRN-owned id with a status and result reference stored in the BRN database, separate from the native Pi conversation history it reads and appends to. Reconnecting retrieves an operation's current status and saved result by id; it never resubmits the operation.
_Avoid_: request, job

**Single-writer lock**:
The guarantee that at most one BRN service instance owns the mutable state at a time. A second launcher attaches to the healthy instance or refuses to become a second writer; a stale lock is reclaimed only after proving the previous process is gone.
_Avoid_: mutex, instance guard
