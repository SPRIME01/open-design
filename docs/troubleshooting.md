# Troubleshooting & Diagnostic Matrix

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Source Map:** [`docs/source-map.md`](file:///home/sprime01/projects/open-design/docs/source-map.md) · **Subsystem Guides:** [`docs/subsystems/`](file:///home/sprime01/projects/open-design/docs/subsystems/)

This document provides an actionable diagnostic matrix for common operational and runtime failure modes in Open Design, complete with root causes, diagnostic commands, and verified recovery procedures.

---

## 1. Application Compiler Failures

### 1.1 Status: `conflicted`
- **Observable Symptom**: `od app compile` terminates with `status: "conflicted"` and writes zero files to disk.
- **Likely Cause**: A generated file inside `generated/<target>/` was edited by hand since it was last emitted. The content hash on disk differs from the hash recorded in `compiler/manifests/<target>.manifest.json`.
- **Subsystem**: `@open-design/application-compiler` ([`conflict.ts`](file:///home/sprime01/projects/open-design/packages/application-compiler/src/conflict.ts)).
- **Diagnostic Command**:
  ```bash
  od app conflicts list --run <runId>
  ```
- **Recovery Path**:
  1. **Option A (Preserve manual edits)**: Re-run with `--conflict-resolution plan-only`. Non-conflicting files will compile, and your manual edits will remain untouched.
  2. **Option B (Reclaim compiler ownership)**: Re-run with `--conflict-resolution force` to overwrite the manual edits.
  3. **Option C (Manual merge)**: Stash or revert the conflicting file, then re-compile.

---

### 1.2 Status: `failed-verification`
- **Observable Symptom**: Compilation completes lowering and writes files, but terminates with `failed-verification`.
- **Likely Cause**: The target framework's build or typecheck command (e.g. `vite build`, `next build`, `tsc`) failed with syntax errors or missing dependencies.
- **Subsystem**: Daemon Compiler Service ([`verification-runner.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/compiler/verification-runner.ts)).
- **Diagnostic Command**:
  ```bash
  cat ./my-project/compiler/evidence/<runId>.verification.json
  ```
- **Recovery Path**: Inspect the build log in the verification file. Common causes include unmapped component slots or type mismatches in custom schema fields.

---

## 2. Agent Runtime & Studio Failures

### 2.1 Agent Reported as `unavailable`
- **Observable Symptom**: `od agent list` shows the agent with `"available": false`, or the web UI grays out the agent in the dropdown.
- **Likely Cause**: The CLI executable is not found in the system PATH, or the probe command timed out.
- **Subsystem**: Daemon Runtime Engine ([`runtimes/detection.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/detection.ts)).
- **Diagnostic Command**:
  ```bash
  which claude # (or codex / opencode)
  claude --version
  od agent probe claude --json
  ```
- **Recovery Path**:
  1. Ensure the binary is installed globally (`npm install -g @anthropic-ai/claude-code`).
  2. If installed in a non-standard location, configure the explicit executable path in Settings -> Agents.

---

### 2.2 Agent Error: `AUTH_REQUIRED`
- **Observable Symptom**: Generation turns fail immediately with an authentication warning.
- **Likely Cause**: The agent CLI's OAuth session expired or API credentials are missing from its native home directory.
- **Subsystem**: Daemon Auth Prober ([`runtimes/auth.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/auth.ts)).
- **Recovery Path**: Open a terminal and run the native CLI login command directly (e.g. `claude login` or `codex auth`). After logging in, refresh the Open Design studio.

---

### 2.3 Run Hangs Indefinitely
- **Observable Symptom**: The chat panel displays a spinning progress bar, but no text or tool events stream.
- **Likely Cause**: The agent CLI spawned an interactive prompt waiting for TTY keyboard input (e.g. asking for file overwrite permission or model download confirmation).
- **Subsystem**: Subprocess Launcher ([`runtimes/launch.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/launch.ts)).
- **Diagnostic Command**:
  ```bash
  pnpm tools-dev logs --json
  ```
- **Recovery Path**: Check the stderr logs. Ensure the agent definition in `runtimes/defs/<agent>.ts` includes headless/non-interactive flags (e.g. `-y`, `--batch`).

---

## 3. Environment & Operating System Friction

### 3.1 Port Collision (`EADDRINUSE`)
- **Observable Symptom**: `pnpm tools-dev` fails with `Error: listen EADDRINUSE: address already in use :::7456`.
- **Likely Cause**: An orphaned daemon or web instance is still running in the background.
- **Diagnostic Command**:
  ```bash
  pnpm tools-dev check
  lsof -i :7456
  ```
- **Recovery Path**:
  1. Terminate orphaned sidecars: `pnpm tools-dev stop`.
  2. Or specify alternate ports: `pnpm tools-dev --daemon-port 17456 --web-port 17573`.

---

### 3.2 Windows Native: `better-sqlite3` Build Failure
- **Observable Symptom**: `pnpm install` errors with `node-gyp rebuild` failure on Windows.
- **Likely Cause**: `better-sqlite3` has no prebuilt binary for win32/Node 24; it compiles from source via node-gyp and requires Visual Studio C++ tools.
- **Recovery Path**:
  1. Install Visual Studio Build Tools 2022 (with the **Desktop development with C++** workload).
  2. Verify Node 24 is active (`node --version`). Do not use Node 22.
  3. Re-run `pnpm install`.

---

### 3.3 Linux: AppImage Execution Fails on Ubuntu 24.04+
- **Observable Symptom**: Running a packaged AppImage fails with `dlopen(): error loading libfuse.so.2`.
- **Likely Cause**: Ubuntu 24.04 and modern Linux distros removed `libfuse2` in favor of `libfuse3`.
- **Recovery Path**:
  ```bash
  sudo apt install libfuse2
  # Or run containerized build:
  pnpm tools-pack linux build --containerized
  ```

---

### 3.4 SSE Stream Interrupted / Buffering Behind Reverse Proxy
- **Observable Symptom**: Chat text appears all at once after 30 seconds rather than streaming progressively.
- **Likely Cause**: An intermediate reverse proxy (e.g. Nginx, Caddy) is buffering chunked responses or compressing SSE streams.
- **Recovery Path**: Ensure the reverse proxy configuration disables response buffering (`proxy_buffering off;`) and gzip compression for `/api/*` SSE endpoints.
