# Capability A operations

How to run BRN's foreground service and terminal client from source, what the
service guarantees, what it refuses, and what its recorded evidence does and does
not establish.

Capability A is the service, the operation ledger, the native conversation host
and the terminal client. Nothing in it publishes, retrieves, migrates or renders
anything: those are later capabilities, and none of the evidence here is evidence
for them.

## What the offline evidence establishes — and what it does not

The default suite (`npm test`) is two kinds of check, and they are kept apart on
purpose.

- **Deterministic checks** run the service as a real process with a substituted
  in-memory engine. They prove admission, scheduling, cancellation, restart and
  transport behaviour without a provider being involved at all.
- **Real-SDK offline checks** run the shipped Pi SDK against its own official
  faux provider, in-process. They prove what BRN constructs and what it hands to
  Pi's runtime: an empty tool list, no ambient resource, the exact seated model,
  BRN's own output ceiling, and native results that survive the death of the
  process that produced them.

Neither is a live-provider result. The faux-provider checks prove the model and
the options BRN passes into Pi's runtime; they do not prove anything about any
provider's final HTTP payload, its billing, or its behaviour under load. A
passing suite is therefore **not** evidence that a real conversation works.

Two things can only be established by a human:

1. The authorized live provider proof (`npm run test:live`, below), which
   requires explicit authorization of a provider, a model, the limits, use of the
   shared Pi credentials and the synthetic prompt.
2. A short conversation in the actual main-screen terminal, including multiline
   composition and Ctrl+C, on the target terminal emulator. A scripted CLI
   success is evidence for the transport and runtime path, not for the editor.

Do not record Capability A as complete while either is outstanding.

## Run it from source

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

The service runs in the foreground and never daemonises. The client attaches to
whatever service is already published for that state directory: it starts one,
adopts one or inherits ownership from one, never.

`--state-dir` must be an absolute path with no symlinked component, owned by you
and closed to group and other. The service creates only the final directory. On
macOS `/tmp` is a symlink to `/private/tmp`, so use the resolved path.

`PROVIDER/MODEL` is a concrete identity you choose from the `models` listing,
which lists only what an authenticated provider actually offers. It is never a
guessed default: BRN seats the exact model asked for, reads back the identity the
conversation is really running, and refuses rather than substituting another one.
Both `status` and the interactive client display that identity and the operating
limits before anything is submitted.

## Limits and policy

| Bound | Value |
|---|---|
| Prompt | 16384 UTF-8 bytes |
| Response requested of the provider | 4096 output tokens |
| HTTP request body | 131072 bytes |
| Live preview held for reconnecting clients | 1 MiB |
| Event-stream queue per connection | 2 MiB, then that connection loses its stream |
| Cancellation deadline | 120 s after admission |
| Automatic retries | none |

One operation at a time. A second prompt, or a session or model change while
either an operation or another change holds the seat, is refused as `BUSY` — BRN
queues nothing, because a queue would spend money later on something you asked
for earlier and may have forgotten.

Cancellation is explicit and is requested, not asserted: `cancel OPERATION_ID
--confirm` records the request and waits for the engine to settle. Ctrl+C in the
interactive client cancels exactly the operation on screen and never signals the
service process. Until an engine settles, the operation still occupies the
service, so every session, model and prompt write stays `BUSY` — an abort that
has been asked for and has not landed is not an idle service.

**A context window is not a spending cap.** Compaction is enabled with a reserve,
and compaction itself spends tokens: a summarization request an overflow recovery
made is real cost, and it is included in the operation's reported usage. Nothing
in Capability A caps what a conversation may spend in total. The deadline bounds
how long BRN waits before asking a provider to stop; it does not prove an
uncooperative provider stopped charging.

Exiting a client, or detaching the interactive one, stops nothing. Accepted work
belongs to the service. Stopping the **owner** with Ctrl+C or `SIGTERM` closes the
listener, withdraws only its own discovery document, settles work and releases
ownership last. It never deletes state.

## Credentials, and what BRN owns

BRN reuses whatever provider credentials Pi already has, in Pi's own managed
location. It never opens, copies, serialises, logs or backs them up. There is no
BRN credential file, no vault integration and no browser bootstrap in Capability
A, and the backup procedure below deliberately does not copy credentials.

BRN owns the sessions and settings inside its state directory: an in-memory
settings manager it constructs itself, and native session files under its own
`sessions/` directory. It loads no personal Pi installation — no `AGENTS.md`, no
skills, prompts, themes, extensions or personal model catalog — because the
resource loader and the model runtime are configured explicitly rather than
discovered.

That isolation is BRN's, not Pi's. Pi's native loaders are permissive by design:
they will read ambient project and home configuration and load extension code
when they are allowed to. The guarantee here is that BRN constructs them so they
are not allowed to, and that guarantee is re-established on every session
replacement — which is exactly where a default loader would otherwise creep back
in. **A conversation started through some other Pi entry point has none of these
restrictions.**

Capability A registers no tools at all: no filesystem, shell, browser, vault or
canonical-mutation tool, and no stub for a later one.

Operational logs are single-line JSON on stderr with scalar fields only. They
contain no prompt, no response, no provider error text, no bearer token and no
discovery document. Answers exist in the native session files and in what the
client displays; nowhere else.

## State layout

Inside the state directory:

| Path | What it is |
|---|---|
| `writer.sqlite` | the ownership lock; an exclusive kernel-held transaction for the process's lifetime |
| `operations.sqlite` | the authoritative operation ledger, plus selected-session and default-model metadata |
| `discovery.json` | the running instance's loopback address and bearer token, owner-only |
| `sessions/` | native Pi session files, the durable home of every answer |
| `work/` | the conversation's working directory |

`operations.sqlite` may be accompanied by SQLite sidecars (`-wal`, `-shm`) while a
service is live. The ledger holds no conversation bodies: a submission is recorded
as a digest, and a result as references to native session entries.

Ownership is a kernel file lock, so a process that dies takes the lock with it and
nobody has to guess whether a recorded PID is stale. A second service against the
same directory exits with `ALREADY_RUNNING` before it opens anything writable —
including while the owner is stopped with `SIGSTOP` and cannot answer for itself.

## Reading an outcome

`interrupted`, `failed`, `cancelled` and `succeeded` are four different things and
BRN never blurs them.

- **`succeeded`** — a complete answer, unless it is marked truncated, which means
  the response was cut off at the output limit and is not a complete answer.
- **`cancelled`** — stopped on request; any recorded text is partial.
- **`failed`** — the engine reported a failure, and `failureCode` names the
  precise reason BRN recorded (`PROVIDER_ERROR`, `DEADLINE_EXCEEDED`,
  `OUTPUT_LIMIT`, `AUTH_REQUIRED`, `STATE_UNAVAILABLE`, and so on).
- **`interrupted`** — the service died while this operation was unfinished. On
  the next start every unfinished operation is recorded as `interrupted` with
  `SERVICE_INTERRUPTED`, and **nothing is replayed**: no provider request is
  repeated, ever, on the strength of a restart.

An interrupted operation whose native result had already been made durable keeps
that evidence: the answer is in the session file and the conversation reopens with
it in history. BRN still reports the operation as interrupted rather than
promoting the native evidence to a success it never committed.

Repeating an identical submission under the same request ID returns the original
saved outcome without paying for it again. The same request ID with different
content is refused as `REQUEST_ID_REUSED`, before and after a restart. A new
request ID is a new paid operation.

## Recovery

Authoritative BRN state is not disposable. Startup corruption is reported as
`STATE_CORRUPT` and a ledger written by a newer BRN as
`STATE_VERSION_UNSUPPORTED`; both are visible mutation failures that leave the
bytes exactly as they were. BRN never deletes, rebuilds or downgrades them.

Approved recovery is short:

1. Read the failure code the service printed.
2. Stop any process using that state directory.
3. Inspect the directory yourself, and if the state is unusable, keep it and point
   a new service at a different directory.
4. Restore from a backup you took while the service was stopped.

**None of the following is an approved recovery command.** Each destroys evidence
or spends money, and none of them is something BRN will do for you:

- deleting or truncating `writer.sqlite`, `operations.sqlite` or a session file
- deleting `discovery.json` to make a client attach, or to take ownership
- forcing a takeover of a state directory another process owns
- replaying a prompt, or resubmitting an interrupted operation, to "finish" it
- repairing, rewriting or hand-editing native JSONL session files
- pruning, vacuuming or compacting authoritative state automatically
- setting `PRAGMA user_version` to make a refused ledger load

A hung or unresponsive service is stopped with `SIGTERM` and inspected. If it
will not exit, that is a defect to diagnose, not a state directory to clear.

## Backup rehearsal: copying a stopped state directory

This is Capability A's stopped-state rehearsal. It is not the full backup and
restore story a later capability owns, and it establishes nothing about that.

1. Stop the owning service and **wait for the process to exit**. Never copy a
   live state directory: copying only the main SQLite file while a service is
   running produces a file that is not a consistent database.
2. Verify no writer holds the directory. With the service stopped there is no
   `discovery.json`, and a fresh `status` reports `NO_SERVICE`.
3. Copy the **complete** directory to a separate directory only you can read,
   including `sessions/`, `work/` and any SQLite sidecars that are present:

   ```bash
   cp -Rp /absolute/path/to/disposable-brn-state /absolute/path/to/owner-only-copy
   ```

4. Credentials are not copied by this procedure. They stay where Pi keeps them.
5. Start **only** the restored copy — never two services, and never one against
   the original at the same time:

   ```bash
   npm run service -- --state-dir /absolute/path/to/owner-only-copy
   ```

6. Confirm the restore against synthetic state you recognise: look up an
   operation by ID, re-host its conversation, and read its answer back.

   ```bash
   npm run brn -- --state-dir /absolute/path/to/owner-only-copy status
   npm run brn -- --state-dir /absolute/path/to/owner-only-copy sessions
   npm run brn -- --state-dir /absolute/path/to/owner-only-copy resume SESSION_ID
   npm run brn -- --state-dir /absolute/path/to/owner-only-copy operation OPERATION_ID
   ```

   A restored root hosts no conversation until you resume one. Until then an
   operation's state is readable but its durable text is refused with
   `NO_ACTIVE_SESSION` rather than answered, so resume the operation's own
   session before reading it. Reopening a conversation asks nothing of a
   provider.

7. The original directory is untouched by any of this. Nothing in the restore
   path writes to it.

## The authorized live provider proof

The live test is fail-closed. It refuses to run unless all three of these are
supplied, and it has no defaults and infers nothing:

```bash
BRN_LIVE_PROOF=I_AUTHORIZE_SYNTHETIC_CHAT \
BRN_LIVE_STATE_DIR=/absolute/path/to/new-disposable-proof-state \
BRN_LIVE_MODEL=PROVIDER/MODEL \
npm run test:live
```

It is excluded from `npm test`. It refuses a proof directory that already has
anything in it, never deletes a directory you chose, waits for the service to
exit on cleanup, reads no vault, imports no file and enables no tool. It spawns
the production service and the compiled CLI and submits one synthetic prompt.

**Run it only after a human has separately approved the provider, the model, the
limits, the use of the shared Pi credentials and the prompt text.** A provider
rejection or a timeout is not a successful proof.

Then hold a short conversation in the actual terminal, with synthetic text only,
exercising multiline composition and Ctrl+C:

```bash
npm run brn -- --state-dir /absolute/path/to/new-disposable-proof-state chat
```

### What to record

In the authorized implementation issue, record: package and Node versions, the
macOS and terminal versions, the exact commands run, the test names, the
synthetic provider and model, the operation ID, the duration, and the usage
totals.

Do **not** publish credentials or tokens, prompts or responses from personal
work, session files, or local private paths.

## Toolchain facts, honestly

- Node `24.20.0` and npm `11.19.0`, pinned; the engine range is `>=24.20 <25`.
  Node's built-in SQLite is used, and its FTS5 support is proven at startup.
- Pi packages are pinned at `0.85.1`.
- `skipLibCheck` is `true`, by a recorded amendment. `pi-ai` 0.85.1 and
  `@google/genai` ship declaration files that do not compile under NodeNext; all
  40 errors were inside `node_modules`. BRN's own sources remain fully
  type-checked, and `npm run typecheck` covers both the source and the test
  project.
- The test-only failpoints and substituted engines live in
  `test/support/service-child.ts` and are reachable only through that entry
  point's own arguments. No production argument, environment variable, header or
  endpoint can select any of them.
