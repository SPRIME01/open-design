# Subsystem Guide: Agent Runtime Engine

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Source Map:** [`docs/source-map.md`](file:///home/sprime01/projects/open-design/docs/source-map.md) · **How-To Guide:** [`docs/how-to/add-agent-adapter.md`](file:///home/sprime01/projects/open-design/docs/how-to/add-agent-adapter.md)

This document specifies the architecture, discovery engine, launch resolver, stream parsers, and process management rules for external AI coding agents.

---

## 1. Purpose

The Agent Runtime Engine enables Open Design to harness whatever AI coding agent the user already has installed on their workstation (Claude Code, Codex, OpenCode, Cursor Agent, DeepSeek, Devin, etc.). Rather than forcing users into a proprietary LLM proxy, Open Design detects local CLI harnesses, injects curated design intelligence, streams child process output via Server-Sent Events, and guarantees clean process tree teardown.

---

## 2. Responsibilities

The Agent Runtime Engine exclusively owns:
- **Runtime Discovery & Detection**: Concurrently probes installed executables, auth states, supported models, and CLI flags ([`apps/daemon/src/runtimes/detection.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/detection.ts)).
- **Executable Path Resolution**: Resolves binary locations safely using allowlists and user toolchains without path hijacking ([`apps/daemon/src/runtimes/executables.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/executables.ts)).
- **Subprocess Spawning**: Spawns agent CLIs with bounded environment variables, project workspace working directory, and configured prompt delivery format ([`apps/daemon/src/runtimes/launch.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/launch.ts)).
- **Stream Normalization**: Converts diverse agent outputs (raw text, JSON Lines, ACP protocol frames) into unified Open Design SSE events (`text_delta`, `tool_use`, `file_written`, `turn_end`).
- **Mid-Turn Run Steering**: Injects user messages into active `stream-json` sessions without killing the process ([`apps/daemon/src/runtimes/run-steering.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/run-steering.ts)).
- **Process Tree Termination**: Tracks PID trees and enforces clean teardown via `SIGTERM` followed by `SIGKILL` escalation ([`packages/platform/src/process.ts`](file:///home/sprime01/projects/open-design/packages/platform/src/)).

---

## 3. Supported Agent Runtimes

Open Design ships with 27 built-in runtime definitions located in [`apps/daemon/src/runtimes/defs/`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/defs/):

| Agent ID | Executable | Protocol / Format | Notes |
|---|---|---|---|
| `claude` | `claude` | `stream-json` (JSONL) | Full mid-turn steering support via persistent stdin; multi-frame `stop_reason` parsing. |
| `codex` | `codex` | JSON event stream | Native OpenAI Codex agent CLI integration. |
| `opencode` | `opencode` | JSON event stream | Local OpenCode agent harness. |
| `amr` / `vela` | `vela` | ACP / JSON stream | Auto Model Router with multi-provider failover. |
| `cursor-agent` | `cursor-agent` | Plain stream / text | Headless Cursor agent subprocess. |
| `devin` | `devin` | ACP protocol | Devin ACP agent integration. |
| `deepseek` | `deepseek` | Text / JSON stream | DeepSeek coding harness. |
| `qwen` | `qwen` | Text stream | Qwen Code agent CLI. |
| `grok-build` | `grok-build` | Plain stream | xAI Grok Build toolchain integration. |
| *Others* | `aider`, `amp`, `atomcode`, `codebuddy`, `copilot`, `hermes`, `kilo`, `kimi`, `kiro`, `mimo`, `pi`, `qoder`, `reasonix`, `trae-cli`, `vibe` | Disparate | Standardized via adapter definitions. |

---

## 4. Prompt Delivery & Stdin Formats

The `promptInputFormat` property on `RuntimeAgentDef` dictates how the daemon delivers the prompt:
1. **`text` (Default)**: The daemon writes the composed prompt to child process `stdin` and closes stdin immediately (`stdin.end()`). Suitable for single-turn CLIs that run to completion.
2. **`stream-json`**: Used by Claude Code (`claude`). The daemon delivers the prompt as a JSONL `user` message frame and **keeps stdin open**. This enables:
   - Mid-turn steering (`POST /api/runs/:id/steer`): The user can inject follow-up instructions while the agent is running tools.
   - Closing stdin only after a verified terminal event arrives (`turn_end` with non-`tool_use` `stop_reason`).

---

## 5. Claude Stream Multi-Frame Parser Invariants

Because Claude Code has evolved its stdout streaming format across versions (e.g. 2.1.259 moved `stop_reason`), the parser ([`apps/daemon/src/runtimes/claude-stream.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/claude-stream.ts)) reads `stop_reason` across **three** potential frames in order of precedence:

1. `stream_event` -> `message_delta` -> `delta.stop_reason` (Claude Code 2.1.259+ with `--include-partial-messages`).
2. `assistant` -> `message.stop_reason` (legacy format used by older CLIs and forks).
3. `result` frame (surfaced as terminal usage, present on all builds).

**Crucial Invariant:** `turn_end` is emitted only *after* all `tool_use` events of the message have been processed. Closing stdin prematurely while the agent is awaiting local tool execution would truncate the response.

---

## 6. Process Tree Cleanup & Teardown

Agent processes frequently spawn child processes (e.g. npm installs, linters, git commands, python scripts). Simply killing the top-level PID leaves orphaned background processes that lock ports and hold file handles.

When a run is cancelled or hits a timeout:
1. Open Design queries the operating system process tree using `listProcessSnapshots()` from `@open-design/platform`.
2. `collectProcessTreePids()` recursively traverses the PID hierarchy to identify all descendants.
3. `stopProcesses()` dispatches `SIGTERM` to the entire tree simultaneously.
4. After a configurable grace period, remaining processes receive `SIGKILL` to guarantee absolute reclamation.

---

## 7. Failure Modes & Diagnostics

| Symptom | Probable Cause | Diagnostic Check | Resolution |
|---|---|---|---|
| Agent detected as `unavailable` | Executable not in system PATH or failed version check. | `od agent list --json` | Install the agent CLI or configure its binary path in Settings. |
| Agent requires login (`AUTH_REQUIRED`) | Agent CLI credentials expired or missing. | Run CLI directly in terminal (e.g. `claude login`). | Complete CLI login flow and re-probe via `od agent list`. |
| Run hangs with no output | Agent spawned interactive prompt waiting on TTY stdin. | Check run log: `pnpm tools-dev logs` | Ensure agent definition includes non-interactive flags (e.g. `-y`, `--batch`). |
| Stream truncated prematurely | `turn_end` emitted before tool finished. | Review trace in `apps/daemon/tests/fixtures/claude-cli-recordings/` | Update stream parser to ensure tool deduplication. |

---

## 8. Extension Points

- To add support for a new coding agent, create a new definition file in `apps/daemon/src/runtimes/defs/<agent>.ts` and register it in `registry.ts`. Follow the step-by-step instructions in [How to Add an Agent Adapter](file:///home/sprime01/projects/open-design/docs/how-to/add-agent-adapter.md).

---

## 9. Source Trail

- [`apps/daemon/src/runtimes/types.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/types.ts) — `RuntimeAgentDef` interface.
- [`apps/daemon/src/runtimes/detection.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/detection.ts) — Concurrency-controlled agent detector.
- [`apps/daemon/src/runtimes/executables.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/executables.ts) — Binary path resolver and security allowlists.
- [`apps/daemon/src/runtimes/claude-stream.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/claude-stream.ts) — Claude multi-frame parser and dedup logic.
- [`apps/daemon/src/runtimes/run-steering.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/run-steering.ts) — Mid-turn stdin steering classifier.
- [`packages/platform/src/process.ts`](file:///home/sprime01/projects/open-design/packages/platform/src/) — Process tree collection and teardown.
