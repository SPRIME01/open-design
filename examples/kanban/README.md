# Kanban — application-compiler demo app

A minimal but complete `ApplicationIR` bundle (all five modules: domain,
capabilities, boundary, persistence, frontend) for a three-column Kanban
board, modeled on `examples/guestbook/`. It exercises the Open Design
application compiler end-to-end through the two targets the root `justfile`
recipes build.

The app: one board route (`/`) with a heading, three column lists (todo /
doing / done) bound to the `cards.list` query, an add-card form bound to the
`cards.create` command, and a move affordance per card bound to
`cards.move` — over a `card` aggregate persisted through SQLite.

## Shape

- Domain: entity `card` (identity `card.id`; title, column, position,
  created-at), enum `card-column` (`todo`/`doing`/`done`), one invariant
  (`card.title-not-empty`).
- Capabilities: query `cards.list`; commands `cards.create` and `cards.move`.
- Persistence: aggregate `card`, repository `card-repository`
  (`get`/`list`/`insert`/`update`), index `card-column-position` on
  `[column, position]`, hard deletion.
- Frontend: 14 nodes — screen → component (columns, add-card form, card) →
  atomic (heading/text/input/button), with design-token references.

## Build

```bash
just demo-build
```

This boots an isolated daemon (namespace `kanban-demo`, port 17520, data root
`.tmp/kanban-demo-data`), then compiles the demo through the real
CLI → daemon HTTP → 9-pass pipeline path for both configured targets.
Equivalent manual steps:

```bash
OD_DATA_DIR="$PWD/.tmp/kanban-demo-data" \
  pnpm tools-dev --namespace kanban-demo start daemon --daemon-port 17520
OD_DAEMON_URL=http://127.0.0.1:17520 node apps/daemon/bin/od.mjs app compile \
  --project examples/kanban --target html-static
OD_DAEMON_URL=http://127.0.0.1:17520 node apps/daemon/bin/od.mjs app compile \
  --project examples/kanban --target sqlite-better-sqlite3
```

Output lands in `generated/html-static/` (a static preview page rendering the
board) and `generated/sqlite-better-sqlite3/` (better-sqlite3 package.json,
initial migration, db client + migration runner, generated card repository),
each with a `manifest.json` and `plan.json`. Nothing under `generated/` or
`compiler/` is committed.

## Remove

```bash
just demo-remove
```

Deletes the generated output, compiler diagnostics, and the isolated data
root, and stops the namespace daemon.

Requires a bootstrapped repository (`pnpm install` and built daemon dist);
`just` must be installed for the recipes.
