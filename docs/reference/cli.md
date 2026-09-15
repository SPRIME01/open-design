# Reference: CLI Commands (`od`)

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Source Map:** [`docs/source-map.md`](file:///home/sprime01/projects/open-design/docs/source-map.md) · **Implementation:** [`apps/daemon/src/cli.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/cli.ts)

This document provides the exhaustive command-line reference for the `od` binary. All commands talk to the daemon HTTP layer and support `--json` for machine readability.

---

## 1. Application Compiler (`od app`)

### `od app init`
Scaffolds a starter Application IR bundle and projection configuration.
```bash
od app init --project <dir> [--template crud|marketing]
```
- `--project <dir>` *(required)*: Target workspace directory.
- `--template <name>`: Starter template (`crud` or `marketing`). Default: `crud`.

### `od app validate`
Validates an Application IR bundle without modifying any files on disk.
```bash
od app validate --project <dir> [--json]
```
- `--project <dir>` *(required)*: Project directory containing `application.ir.json`.
- `--json`: Emit structured diagnostic errors and warnings as JSON.

### `od app plan`
Generates a reviewable compile plan, computing file changes, conflict classifications, and the cryptographic plan hash.
```bash
od app plan --project <dir> [--target <id>] [--json]
```
- `--project <dir>` *(required)*: Project root.
- `--target <id>`: Target adapter (e.g. `react-vite`, `nextjs-app`, `sqlite-better-sqlite3`). If omitted, plans all configured targets.

### `od app compile`
Executes the full 9-pass compilation pipeline, writes files to `generated/<target>/`, updates manifests, and runs build verification.
```bash
od app compile --project <dir> [--target <id>] [--follow] [--conflict-resolution force|block|plan-only] [--json]
```
- `--target <id>`: Target adapter to compile.
- `--follow`: Stream live compilation progress events to stdout.
- `--conflict-resolution`: Override target conflict policy:
  - `block` (default): Abort if manual edits are detected.
  - `plan-only`: Write only non-conflicting files.
  - `force`: Overwrite manual edits and reclaim compiler ownership.

### `od app verify`
Compiles the application and executes automated verification checks, capturing output in `compiler/evidence/`.
```bash
od app verify --project <dir> [--target <id>] [--follow] [--json]
```

### `od app targets list`
Lists all available target adapters registered in the compiler.
```bash
od app targets list [--json]
```

---

## 2. Agent Management (`od agent`)

### `od agent list`
Probes and lists all supported external coding agent CLIs.
```bash
od agent list [--json]
```
Output includes detection availability, resolved binary paths, version strings, and auth status.

### `od agent probe`
Executes a deep diagnostic probe on a specific agent runtime.
```bash
od agent probe <agentId> [--json]
```

---

## 3. Conversational Studio (`od chat`)

### `od chat send`
Dispatches a generation prompt to an active project.
```bash
od chat send --project <id> --message "Create a landing page" [--agent <id>] [--design-system <id>] [--follow] [--prompt-file <path>]
```
- `--prompt-file <path>`: Read prompt text from a file or stdin (`-`).

---

## 4. MCP Server Management (`od mcp`)

### `od mcp install`
Configures local coding agent harnesses (Claude Code, Codex, Cursor) to connect to Open Design's live artifact MCP server.
```bash
od mcp install <claude|codex|cursor>
```

### `od mcp status`
Inspects active MCP server tool registrations and connection status.
```bash
od mcp status [--json]
```

---

## 5. Development Control Plane (`od tools-dev`)

Convenience alias delegating to `pnpm tools-dev`:
```bash
od tools-dev start [daemon|web|desktop|all] [--daemon-port <port>] [--web-port <port>] [--namespace <name>]
od tools-dev status [--json]
od tools-dev logs [--json]
od tools-dev stop
```
