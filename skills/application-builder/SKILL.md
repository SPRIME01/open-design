---
name: application-builder
description: |
  Turn an approved design or app intent into a structured, runnable application
  by authoring an ApplicationIR bundle and driving the Open Design application
  compiler through `od app` (init → edit IR → validate → plan → compile →
  verify). Use when the request needs real domain data, capabilities,
  persistence, or multiple screens wired to operations — not for single-page
  prototypes or one-off HTML artifacts.
  Trigger keywords: "build an app", "application ir", "od app",
  "application compiler", "compile an app", "runnable app".
triggers:
  - "build an app"
  - "application ir"
  - "od app"
  - "application compiler"
  - "compile an app"
  - "runnable app"
od:
  mode: prototype
  surface: web
  scenario: engineering
  category: web-artifacts
  design_system:
    requires: true
  craft:
    requires: [state-coverage, form-validation, accessibility-baseline]
---

# application-builder

Author an ApplicationIR bundle and let the compiler project it into a runnable
target. You write intent — entities, capabilities, screens; the compiler writes
all target source code, deterministically, behind a reviewable plan.

## When to use

Use this skill when the user wants an **application**: a data-backed,
multi-screen, runnable web app built from an approved design or product
intent, projected onto a real target (static HTML, React/Vite, Next.js,
SvelteKit, mock transport, SQLite persistence).

Do NOT use it for single-page prototypes, marketing one-pagers, decks, or
throwaway HTML artifacts — those follow the standard prototype flows. No
entities and no queries/commands means it is a prototype, not an application.

## The hard rule

**Never hand-write files under `generated/`.** That tree is compiler-owned.
Every emitted file is hash-tracked in the target's manifest; a manual edit is
detected on the next plan, classified as a conflict, and the run fails instead
of silently overwriting your work. To change generated output, change the IR
or `projection.config.json` and recompile. If generated code is wrong, the fix
belongs in the IR or the target adapter — never in the generated file.

## Golden path

1. **Scaffold** — `od app init --project <dir> [--template crud|marketing]`
   Writes `application.ir.json`, the five `ir/*.ir.json` modules, and
   `projection.config.json`: a valid, immediately compilable starter bundle.
   Refuses to overwrite an existing bundle. The printed `Next:` line is your
   compile command.
2. **Author the IR** — edit the five modules until they express the app
   (roles below). Base edits on the starter bundle or the guestbook example,
   not on guesswork.
3. **Validate** — `od app validate --project <dir>`
   Read-only. Each diagnostic carries severity, code, and a JSON pointer into
   the offending module. Iterate here until valid before planning.
4. **Plan** — `od app plan --project <dir> [--target <id>]`
   Read-only dry run of the compile. **Review the counts before compiling**:
   `creates`, `modifies`, `deletes`, `conflicts`, `unresolved`. A first
   compile into an empty output root should show creates only. Anything under
   conflicts or unresolved must be resolved first (see below).
5. **Compile** — `od app compile --project <dir> [--target <id>] --follow`
   Runs the full pipeline and writes the target tree under the configured
   outputRoot. `--follow` streams run events to the terminal state.
6. **Verify** — `od app verify --project <dir> [--target <id>]`
   Compiles, then executes the target's planned verification commands and
   reports evidence: plan path, manifest path, verification logs.

Notes that keep the loop cheap:

- `--target` may be omitted exactly when `projection.config.json` declares one
  target; with several it is required and the error lists the valid IDs.
- `od app targets` lists every adapter (`html-static`, `react-vite`,
  `nextjs-app`, `sveltekit`, `mock-local`, `next-server-actions`,
  `sqlite-better-sqlite3`) with features and limitations.
- `--json` on any subcommand gives stable machine-readable output; prefer it
  when parsing. Exit codes: 0 success, 1 run/validation failure, 2 usage
  error, 3 daemon unreachable.
- All commands except `init` talk to the Open Design daemon over HTTP; pass
  `--daemon-url <url>` if auto-discovery cannot find it.

## The five IR modules

`application.ir.json` is the bundle root referencing five modules under `ir/`.
Every module repeats the same `schemaVersion` and `applicationId`.

| Module | Role |
|---|---|
| `domain.ir.json` | The nouns: entities with typed fields and invariants, enums, state machines. |
| `capabilities.ir.json` | The verbs: queries and commands over the domain — input/output shapes, authorization, transactionality, idempotency, effects, events, and the error catalog. |
| `boundary.ir.json` | Transport-neutral exposure: which capabilities become operations, their wire schemas, error presentation hints, versioning policy. |
| `persistence.ir.json` | Storage mapping: aggregates, repositories, indexes, uniqueness, deletion policies, concurrency strategy. |
| `frontend.ir.json` | Screens and node trees (semantic → component → atomic) with routes, node states, accessibility, style intent, and actions / operation bindings that reference boundary operations. |

Authoring rules that bite hardest:

- IDs are lowercase, dot/dash-segmented (`entry.created-at`, `entries.sign`);
  error IDs are SCREAMING_SNAKE (`VALIDATION_FAILED`). `camelCase` anywhere
  fails validation with a pointer to the exact field.
- Cross-module references must resolve: frontend actions and operation
  bindings point at boundary operations; boundary operations point at
  capabilities; command effects point at entities and events; every error an
  operation lists must exist in the error catalog.
- Cover node states honestly: loading / empty / ready / error for data views;
  idle / submitting / validation-error / service-error for forms. The craft
  references attached to this skill apply directly to these two shapes.
- Frontend `tokenReferences` should use the active design system's custom
  properties so generated styling composes with the supplied brand context.
- `projection.config.json` selects targets and each target's `outputRoot`
  (convention: `generated/<target-id>`).

## Blocked and conflicted runs

A compile can end in failure with planning diagnostics instead of succeeding.

- **Unresolved references** — an adapter cannot resolve something the IR
  names. Fix the IR (usually a dangling operation or capability reference),
  then re-plan.
- **File conflicts** — files under the output root no longer match the prior
  generated manifest, i.e. manual edits exist in compiler-owned territory.
  Resolve by restoring or deleting the conflicting file and re-expressing the
  intent in IR; do not patch generated files.

Inspect and, where deliberate, approve:

- `od app conflicts list --run <run-id>` — planning conflicts recorded on the
  run (also shows the run's plan hash).
- `od app run get <run-id>` — status, phase, diagnostics, plan hash, and
  evidence paths for one run.
- Deliberate approval is plan-hash bound: POST the run's exact `planHash` to
  `POST /api/compiler/runs/<id>/approve`. A mismatched or missing hash is
  rejected (409), so an approval always names the specific plan it covers.

## MCP alternative

Agent runtimes driving the daemon over MCP have the same loop as seven tools:
`list_application_targets`, `get_application_ir`, `validate_application_ir`,
`plan_application_target`, `compile_application_target`, `get_compiler_run`,
`get_compiler_evidence`. Reach for the CLI when you already have a shell; use
the MCP tools when you only have a tool session.

## Pointers

- **Worked example:** `examples/guestbook/` in the Open Design repository — a
  complete five-module bundle (one entity, one query, one command, one screen,
  SQLite persistence) with `application.ir.json`, `ir/*.ir.json`, and
  `projection.config.json`. Imitate its shape before authoring from scratch.
- **IR grammar source of truth:** `packages/application-ir/src/schemas/*.ts`
  — one Zod schema file per module plus the bundle and projection-config
  schemas. When validation rejects a shape, believe the schema, not memory.
- **Determinism:** recompiling unchanged IR is a no-op — the plan comes back
  empty and the output is byte-identical. If an untouched recompile wants to
  modify files, suspect IR drift on your side, not compiler nondeterminism.
