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

`status` reads the discovery document, attaches over authenticated loopback
HTTP, and prints the running instance. Every request carries the token in an
`Authorization` header — never in a URL — and the service rejects any request
with a wrong `Host`, a duplicated `Host` or `Authorization` header, or any
`Origin` at all. It grants no CORS.

Commands other than `status` are not implemented yet and fail with
`UNSUPPORTED_COMMAND`.

## Development

```bash
npm run typecheck
npm test
npm run lint
```
