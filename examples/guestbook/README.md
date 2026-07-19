# Guestbook — application-compiler evidence app

A minimal but complete `ApplicationIR` bundle (all five modules: domain,
capabilities, boundary, persistence, frontend) that exercises the Open Design
application compiler end-to-end, per
`.agents/specs/OPEN_DESIGN_APPLICATION_COMPILER_SPEC.md`.

The app: a guestbook with one route (`/`), an entry list bound to the
`entries.list` query, and a sign form bound to the `entries.sign` command over
an `entry` aggregate persisted through SQLite.

## Reproduce

```bash
pnpm tools-dev start daemon --daemon-port 17456
for t in html-static react-vite nextjs-app mock-local sqlite-better-sqlite3; do
  OD_PORT=17456 node apps/daemon/bin/od.mjs compiler compile \
    --project "$PWD/examples/guestbook" --target "$t"
done
```

Output lands in `generated/<target>/` with a `manifest.json` and `plan.json`
per target (not committed; the compiler is deterministic — regenerate it).

## Evidence checklist (verified 2026-07-19)

- `od compiler targets` lists all 7 spec-required v0.1 adapters
  (`html-static`, `react-vite`, `nextjs-app`, `sveltekit`, `mock-local`,
  `next-server-actions`, `sqlite-better-sqlite3`).
- Validation works: a field ID violating the spec's ID grammar
  (`entry.createdAt`) was rejected with a JSON-pointer diagnostic at
  `/entities/0/fields/3/id` before any files were written.
- All five configured targets compile to `succeeded` through the full
  CLI → daemon HTTP → 9-pass pipeline path.
- Determinism: recompiling `html-static` with unchanged IR produced
  byte-identical `index.html` and `manifest.json` (sha1-verified).
- Persistence slice: the generated migration
  (`sqlite-better-sqlite3/.../0001_initial.sql`) derives the `entry` table
  from Domain+Persistence IR, applies to an empty better-sqlite3 database,
  and round-trips an insert/select.
- The generated `react-vite` project installs and builds with stock
  `npm install && npm run build`.

## Gaps found and fixed (2026-07-19)

All three were found by this evidence app and fixed in the same session, each
with a regression test:

- `html-static` now renders accessibility labels for buttons and emits
  labeled `<input>`/`<textarea>` controls instead of node-ID placeholders
  (`packages/application-targets/src/frontend/html-static/emitter.ts`;
  test: `tests/emitters.test.ts`).
- SQLite columns are sanitized to snake_case identifiers
  (`entry.created-at` → `created_at`)
  (`packages/application-targets/src/persistence/sqlite-better-sqlite3/emitter.ts`;
  test: `tests/emitters.test.ts`).
- Regeneration no longer false-conflicts: the generated-file manifest hashed
  content with `computeSemanticHash` (JSON-stringified) while conflict
  classification hashed raw content, so any recompile whose output changed was
  misread as a manual edit and blocked. Both now share one content hash
  (`packages/application-compiler/src/conflict.ts` + `compile.ts`;
  test: `tests/noop-recompile.test.ts`). Output generated before the fix
  carries the old hash format — delete `generated/` once and recompile.
