# Reference: REST API & Server-Sent Events (SSE)

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Source Map:** [`docs/source-map.md`](file:///home/sprime01/projects/open-design/docs/source-map.md) · **Contracts:** [`packages/contracts/src/`](file:///home/sprime01/projects/open-design/packages/contracts/src/)

This document specifies the HTTP endpoints, request/response DTOs, and Server-Sent Event (SSE) streaming contracts exposed by the Open Design daemon.

---

## 1. System Endpoints

### `GET /api/health`
Process-level availability probe.
- **Response**: `200 OK`
```json
{
  "ok": true,
  "version": "0.22.1"
}
```

### `GET /api/version`
Detailed build and channel identity metadata.

---

## 2. Application Compiler Endpoints

### `GET /api/compiler/targets`
Lists all registered target adapters.
- **Response**: `200 OK`
```json
[
  { "id": "html-static", "version": "1.0.0", "targetKind": "frontend" },
  { "id": "react-vite", "version": "1.0.0", "targetKind": "frontend" },
  { "id": "nextjs-app", "version": "1.0.0", "targetKind": "frontend" },
  { "id": "sqlite-better-sqlite3", "version": "1.0.0", "targetKind": "persistence" }
]
```

### `POST /api/compiler/validate`
Validates an Application IR bundle (read-only, no file modifications).
- **Request Body**: `{ "projectRoot": "/path/to/project" }`
- **Response**: `200 OK`
```json
{
  "valid": true,
  "diagnostics": []
}
```
*(Note: Invalid IR returns HTTP 200 with `valid: false` and a list of `Diagnostic` objects).*

### `POST /api/compiler/plan`
Generates a reviewable compile plan without writing output.
- **Request Body**: `{ "projectRoot": "/path/to/project", "targetId": "react-vite" }`
- **Response**: `200 OK`
```json
{
  "status": "succeeded",
  "planHash": "9f8a3b2c1d0e...",
  "creates": ["src/App.tsx", "package.json"],
  "conflicts": [],
  "evidenceRefs": {
    "planPath": "compiler/plans/9f8a3b2c1d0e.plan.json"
  }
}
```

### `POST /api/compiler/runs`
Starts an asynchronous compilation run.
- **Request Body**:
```json
{
  "projectRoot": "/path/to/project",
  "targetId": "react-vite",
  "conflictResolution": "block"
}
```
- **Response**: `202 Accepted`
```json
{
  "runId": "run-comp-12345",
  "status": "running"
}
```

### `GET /api/compiler/runs/:runId`
Polls the execution status of an async compile run.
- **Terminal Statuses**: `"succeeded"`, `"failed-validation"`, `"conflicted"`, `"failed-verification"`.

### `POST /api/compiler/runs/:runId/approve`
Approves a pending compile plan using hash-bound verification.
- **Request Body**: `{ "planHash": "9f8a3b2c1d0e..." }`
- **Errors**: `409 Conflict` (`PLAN_HASH_MISMATCH`) if the on-disk state changed since the plan was computed.

### `GET /api/compiler/runs/:runId/events`
SSE stream of real-time compilation progress events (`text/event-stream`).

---

## 3. Conversational Generation Endpoints

### `POST /api/chat`
Initiates an interactive generation turn with an agent.
- **Request Body**:
```json
{
  "projectId": "proj-123",
  "message": "Add an annual discount toggle",
  "skillId": "frontend-dev",
  "designSystemId": "stripe"
}
```
- **Response**: `200 OK` (`Content-Type: text/event-stream`).

### `POST /api/runs/:runId/steer`
Injects a steering user message mid-turn into a running agent (supported on `stream-json` runtimes).
- **Request Body**: `{ "message": "Make the button rounded instead" }`

### `POST /api/runs/:runId/cancel`
Terminates an active run and recursively kills child process trees.

---

## 4. Server-Sent Events (SSE) Protocol

Streaming endpoints emit standard SSE frames (`event: <name>\ndata: <json>\n\n`):

| Event Name | Payload Shape | Description |
|---|---|---|
| `run_started` | `{ "runId": string, "agentId": string }` | Emitted when process spawn succeeds. |
| `text_delta` | `{ "chunk": string }` | Streamed text content from the agent. |
| `tool_use` | `{ "id": string, "name": string, "input": any }` | Agent invoked a local workspace tool. |
| `file_written` | `{ "path": string, "size": number }` | Agent created or modified a workspace file. |
| `turn_end` | `{ "stop_reason": string }` | The agent completed its user turn. |
| `run_finished` | `{ "status": "succeeded" \| "failed", "asked_user_question": boolean }` | Terminal run completion. |

---

## 5. Projects & Workspaces

### `GET /api/projects`
Lists all active projects in SQLite.

### `POST /api/projects`
Creates a managed project workspace in `PROJECTS_DIR`.

### `POST /api/import/folder`
Imports an external workspace folder into Open Design.
- **Request Body**: `{ "folderPath": "/path/to/repo", "token": "hmac-token" }`
- **Security**: Guarded by a short-lived HMAC token minted by the desktop main process after native OS folder picker approval.
