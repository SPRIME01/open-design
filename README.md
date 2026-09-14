<h1 align="center">Open Design</h1>

<p align="center">
  <strong>Describe the app you want. Get a beautiful, real one back — not a mockup, not a template, an app you can actually run.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat" /></a>
  <a href="QUICKSTART.md"><img alt="quickstart" src="https://img.shields.io/badge/quickstart-3%20commands-green?style=flat" /></a>
</p>

---

## The problem

Turning an idea into real software usually means picking one bad trade:

- **Hire or wait on developers** to rebuild your design as code — slow, expensive, and the design rarely survives the handoff intact.
- **Use a no-code builder** — fast, but you're locked into someone else's platform, and it never looks like something a designer actually touched.
- **Use an AI app builder** — you get working code quickly, but it looks like every other AI app: same layout, same components, same lack of taste.
- **Stop at a prototype** — Figma, click-through mockups, static HTML — beautiful, but nothing actually works. No real buttons, no real data, nothing you can hand to a user.

Open Design skips the trade-off. Describe what you want, and it designs *and* builds the real thing — buttons that work, forms that save data, pages that load real information — with the design quality of something a studio would ship, not an AI default.

## What you get

- **A real, running app** — not a click-through demo.
- **Design quality worth shipping** — drawn from 150+ real, brand-grade design systems, not a generic template.
- **Your own code, your own stack** — Next.js, React, or a plain static site. Nothing proprietary, nothing locked in.
- **One description, several outputs** — the same app can become a static site, a React app, or a full Next.js app backed by a real database, whichever you need.

---

*Everything below is how it works. Skip to [Quick start](#quick-start) if you just want to run it.*

## What it does

You describe an application once. Open Design turns that description into a runnable, framework-native project — a complete, installable, buildable app that reflects your data model, your screens, and your data storage. Not a code skeleton, not a boilerplate dump.

One description compiles into:

| Target | What you get |
|---|---|
| `html-static` | A plain HTML/CSS/JS preview — interactive, instantly deployable |
| `react-vite` | A React 18 + Vite 5 project, production-buildable |
| `nextjs-app` | A Next.js 14 App Router project with server components |
| `sveltekit` | A SvelteKit project with Vite integration |
| `next-server-actions` | Next.js with transport bindings via Server Actions |
| `sqlite-better-sqlite3` | SQLite persistence with typed queries, migrations, and schema |
| `mock-local` | A transport-neutral local mock binding for early development |

## Why it's better than regenerating from scratch

Most AI code generators produce code once and leave you holding a maintenance problem: every re-generation overwrites your manual changes, every new framework means starting over, every design update means reconciling two worlds by hand.

Open Design is different:

- 🔁 **Your description is the source of truth.** Change it, recompile. Files you've hand-edited are detected and protected — conflicts are surfaced, never silently overwritten.
- 📐 **One intent, many targets.** The same application definition compiles to React, Next.js, SvelteKit, or static HTML. Retarget without reimplementation.
- 🔒 **No guessing on sensitive behavior.** Authorization, financial logic, retention policies, and data deletion requirements are surfaced as unresolved requirements — it blocks rather than fabricates them.
- ✅ **Verified output.** Generated code is typecheck-clean and production-buildable. Success is never reported over a build that fails.
- 🔄 **Deterministic.** Recompile the same input with the same config and get byte-identical output. Cache-friendly and CI-safe.

---

## Quick start

### Prerequisites

- Node.js `~24`
- pnpm `10.33.x` (or `npm install -g pnpm@10.33.2`)
- A running Open Design daemon (start with `pnpm tools-dev start daemon`)

### Run from source

```bash
git clone https://github.com/nexu-io/open-design.git
cd open-design
npm install -g pnpm@10.33.2
pnpm install
pnpm tools-dev start daemon
```

### Compile your first application

```bash
# Scaffold a starter project (IR bundle + projection config)
od app init --project ./my-project

# Validate the IR, plan the compile, then run it — verify afterwards
od app validate --project ./my-project
od app plan --project ./my-project --target react-vite
od app compile --project ./my-project --target react-vite --follow
od app verify --project ./my-project --target react-vite

# Compile every target at once
for target in html-static react-vite nextjs-app sveltekit; do
  od app compile --project ./my-project --target $target
done
```

### Structure your project

Your project needs an `application.ir.json` file that defines the application:

```
my-project/
├── application.ir.json     ← top-level bundle (required)
├── ir/
│   ├── domain.ir.json      ← domain model: entities, value objects, types
│   ├── capabilities.ir.json ← application operations: commands, queries, events
│   ├── boundary.ir.json    ← API surface: transport bindings, auth requirements
│   ├── persistence.ir.json ← data layer: tables, migrations, indices
│   └── frontend.ir.json    ← UI layer: screens, components, nodes, flows
└── projection.config.json  ← target configuration (optional)
```

After compiling, you'll find the generated output at:

```
my-project/
└── generated/
    ├── html-static/        ← static preview
    ├── react-vite/         ← React/Vite project (cd in, pnpm install, pnpm build)
    ├── nextjs-app/         ← Next.js project (cd in, pnpm install, next build)
    └── sqlite-better-sqlite3/  ← persistence layer
```

A worked example lives in [`examples/guestbook`](examples/guestbook) — a small, complete application you can compile to any of the five configured targets today.

---

## Under the hood

Open Design captures what you described — screens, data, actions, permissions — as a versioned, structured definition, then runs it through validation, framework projection, and build/test verification before calling a compile done.

Full internals → [`docs/architecture.md`](docs/architecture.md) · [`docs/spec.md`](docs/spec.md) · Agent adapter contract → [`docs/agent-adapters.md`](docs/agent-adapters.md)

| Layer | Stack |
|---|---|
| IR packages | `@open-design/application-ir` · `@open-design/application-compiler` · `@open-design/application-targets` |
| Daemon | Node 24 · Express · SSE streaming · `better-sqlite3` |
| CLI | `od app init` · `od app validate` · `od app plan` · `od app compile` · `od app verify` |
| MCP Tools | `list_application_targets` · `get_application_ir` · `validate_application_ir` · `plan_application_target` · `compile_application_target` · `get_compiler_run` · `get_compiler_evidence` |
| Frontend | Next.js 16 App Router + React 18 + TypeScript |

---

## Daemon API

The compiler is also accessible over HTTP when the daemon is running:

```bash
# List supported targets
GET /api/compiler/targets

# Start a compile run
POST /api/compiler/runs
{ "projectRoot": "/path/to/project", "targetId": "react-vite" }

# Poll run status
GET /api/compiler/runs/:runId
```

Runs are async. Poll the run ID until `status` is `"succeeded"` or `"failed"`. Diagnostics are attached to the run result.

---

## Design systems, skills, and plugins

The compiler is built on Open Design's broader platform — the same agent that reads a brief can also work with:

- **150+ brand-grade `DESIGN.md` systems** — Linear, Stripe, Vercel, Airbnb, and more
- **100+ skills** — web prototypes, decks, dashboards, mobile apps
- **261 official plugins** — scenarios, templates, migration tools

These are file-based and agent-readable — no proprietary registry, no locked catalog.

---

## MCP integration

The compiler is exposed as an MCP tool server, so any MCP-compatible coding agent can drive it:

```bash
od mcp install claude     # wire into Claude Code
od mcp install codex      # wire into Codex
od mcp install cursor     # wire into Cursor
```

Then from inside your agent:

```
> Compile the project at ./my-app to react-vite and check if it builds
```

---

## Contributing

```bash
# Clone and install
git clone https://github.com/nexu-io/open-design.git
cd open-design && pnpm install

# Run checks
pnpm guard && pnpm typecheck

# Run compiler package tests
pnpm --filter @open-design/application-ir test
pnpm --filter @open-design/application-compiler test
pnpm --filter @open-design/application-targets test
```

Contribution guide → [`CONTRIBUTING.md`](CONTRIBUTING.md). Agent-specific guidance → [`AGENTS.md`](AGENTS.md).

---

## Roadmap

- [x] IR schema with Zod validation — domain, capabilities, boundary, persistence, frontend
- [x] 9-pass compiler pipeline (validate → resolve → normalize → lower → plan → project → write → verify)
- [x] 7 built-in target adapters: `html-static`, `react-vite`, `nextjs-app`, `sveltekit`, `mock-local`, `next-server-actions`, `sqlite-better-sqlite3`
- [x] Daemon API (`/api/compiler/validate`, `/api/compiler/plan`, `/api/compiler/runs`) with async run tracking and hash-bound approve
- [x] CLI (`od app init`, `validate`, `plan`, `compile`, `verify`) with `--json` and `--follow`
- [x] MCP tools (7 named compiler tools with read/write annotations)
- [x] Deterministic file manifests, compile plans, and verification reports
- [x] Production builds verified: Next.js (`next build`) and React/Vite (`vite build`)
- [ ] Frontend lowering: resolve component slots, flows, and deep node trees correctly
- [ ] Delete detection: compare new file set against prior manifest to surface removed files
- [ ] Custom adapters: load and validate trusted third-party target adapters

---

## License

Apache-2.0. Bundled skills and templates with their own `LICENSE` files retain those licenses.
