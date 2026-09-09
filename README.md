# brn

BRN is a foreground service you start yourself, plus a terminal client that
attaches to it. They are two independent commands: the client never starts,
adopts, or inherits ownership of a service.

## Requirements

Node `24.20.0` and npm `11.19.0` (see `.node-version`). Then:

```bash
npm install
npm run build
```

## Running the service

The service needs an absolute, explicitly chosen state directory whose parent
already exists: it creates only the final directory, owner-only, if that is
missing. It refuses one whose parent is absent, and refuses a path in which any
component — the directory itself or any ancestor — is a symlink. On macOS that
rules out anything under `/tmp`, which is a symlink to `/private/tmp`; use the
resolved path instead. It also refuses a directory that someone else owns, that
is readable by group or other, or that contains managed files with unexpected
permissions or extra hard links.

```bash
mkdir -p "$HOME/.brn"
npm run service -- --state-dir "$HOME/.brn/default"
```

It acquires single-writer ownership of the state directory, binds `127.0.0.1` on
a port the kernel assigns, and publishes an owner-only `discovery.json` naming
that address and a bearer token. A second service against the same state
directory exits with `ALREADY_RUNNING` rather than competing for the state.

Stop it with Ctrl-C or `SIGTERM`. It closes the listener, removes its own
discovery document, and releases ownership last. It never deletes its state.

## Attaching a client

```bash
npm run brn -- --state-dir "$HOME/.brn/default" status
```

Every command has the same shape: `npm run brn -- --state-dir /absolute/path
COMMAND`. The client reads the discovery document, attaches over authenticated
loopback HTTP, and never starts, adopts, or stops a service. Exiting a command,
or detaching the interactive client, leaves the service and every accepted
operation running.

| Command | Interactive equivalent | What it does |
|---|---|---|
| `status` | `/status` | readiness, active session, current work, context, usage and the operating limits |
| `models` | `/models` | the models an authenticated provider offers |
| `sessions` | `/sessions` | the native BRN sessions that exist |
| `new --model PROVIDER/MODEL` | `/new PROVIDER/MODEL` | create and select a new conversation |
| `resume SESSION_ID` | `/resume SESSION_ID` | select an existing conversation |
| `model PROVIDER/MODEL` | `/model PROVIDER/MODEL` | change the model, when idle |
| `chat` | ordinary text | attach the main-screen client and compose prompts |
| `prompt --request-id UUID --text TEXT` | ordinary text allocates one UUID | one scriptable submission |
| `operation OPERATION_ID` | `/operation OPERATION_ID` | an operation's state and its durable answer |
| `cancel OPERATION_ID --confirm` | Ctrl+C while work is shown | request cancellation and wait for it to settle |
| — | `/quit`, or Ctrl+C while idle | detach the client only |

A model identifier splits at the **first** slash, so the identifier itself may
contain further slashes: `openrouter/vendor/model-1` is the `openrouter`
provider's `vendor/model-1`.

A session must already exist before `chat` or `prompt`. A missing service,
session or model is reported with the command that would create it — the client
never creates one implicitly and never falls back to a different model.

Every request carries the token in an `Authorization` header — never in a URL —
and the service rejects any request with a wrong `Host`, a duplicated `Host` or
`Authorization` header, or any `Origin` at all. It grants no CORS.

### The interactive client

`chat` renders into the terminal's ordinary scrollback: no alternate screen, no
panel, and no filesystem completion. Enter submits; the editor's newline binding
(Shift+Enter, or Ctrl+J) inserts a line, and bracketed paste works as usual.

Typed text is never lost to a refusal. The editor is cleared only once the
service has acknowledged a submission, so a busy rejection, an oversized prompt
or a session that changed underneath you leaves your text where it was. If the
conversation was switched while you were composing, the text is not reinterpreted
as input to the new session: the client says so and waits for you to decide.

If a submission's outcome is unknown — the connection died with the request in
flight — the client keeps that exact submission, shows its request ID, and looks
that ID up before it will send anything new. Only a lookup that proves the
service never admitted it allows the identical text to be sent again under the
same ID. A new request ID would be a new paid operation. If you type something
different while that retry is offered, the retry still sends the retained text
under its retained ID — and what you typed is kept in the editor and repeated in
the transcript rather than discarded.

`chat` needs an interactive terminal. Given a pipe or a redirect it refuses with
`NOT_A_TERMINAL` and names `prompt --request-id UUID --text TEXT`, the scriptable
route, rather than waiting for keystrokes that can never arrive.

While an operation is in flight the status line reports the engine's own status,
and compaction is worded differently from ordinary work: a screen that is silent
because history is being compacted does not look like one that is producing an
answer.

Ctrl+C while work is shown requests cancellation of exactly the operation on
screen and waits for it to settle; it never signals the service process. Ctrl+C
while idle detaches. `/quit` detaches even while work is running, and says so:
the operation continues, and `operation OPERATION_ID` reads its answer later.

Capability A registers no tools, so the client shows `Tools: none (Capability
A)`. Context is reported honestly: when the token count is unknown it says
`unknown` rather than inventing an estimate, and a completed-but-truncated answer
is labelled as partial rather than presented as a complete one. The status display
also names the concrete seated model and the limits you are working under — prompt
bytes, requested output tokens, one operation at a time, no automatic retry, and
the cancellation deadline — before anything is submitted. A context window is not
a spending limit, and the display says so.

Everything the service sends is sanitized before it reaches the terminal.
Newlines and tabs survive; every other control character is shown as a visible
escape, so a model, a provider name or a session identifier cannot address your
terminal.

## Development

```bash
npm run typecheck
npm test
npm run lint
```

`npm test` is the default suite: deterministic checks against a real service
process, plus real-SDK checks that run the shipped Pi SDK against its own faux
provider offline. Neither is a live-provider result. The acceptance journeys in
`test/acceptance/service-terminal.test.ts` cover crash, restart and restoration
with real signals.

One test can reach a real provider, and it is excluded from `npm test` and
fail-closed: it refuses to run without an explicit authorization phrase, a
disposable state directory and an explicit model.

```bash
npm run test:live   # refuses unless separately authorized
```

## Operating it

[`docs/capability-a-operations.md`](docs/capability-a-operations.md) is the
runbook: the commands, the limits and busy/cancellation policy, the state layout,
how to read an interrupted outcome, which recovery actions are approved and which
are explicitly not, the stopped-state backup rehearsal, and what the authorized
live proof requires. Start there before running BRN against anything you care
about.
