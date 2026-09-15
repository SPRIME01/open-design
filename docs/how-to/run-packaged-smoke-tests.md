# How-To: Run Packaged Smoke Tests

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Subsystem Guide:** [`docs/subsystems/tools-dev-pack.md`](file:///home/sprime01/projects/open-design/docs/subsystems/tools-dev-pack.md) · **Reference:** [`tools/pack/AGENTS.md`](file:///home/sprime01/projects/open-design/tools/pack/AGENTS.md)

This procedural guide details how to build, install, smoke-test, and verify packaged Electron application artifacts locally across macOS, Windows, and Linux.

---

## Goal

Produce a real packaged distribution binary (DMG, NSIS installer, or AppImage), install it into an isolated test namespace, and run automated smoke verification using `tools-pack`.

---

## Prerequisites

- Node.js `~24`, pnpm `10.33.2`.
- Platform build toolchains:
  - **macOS**: Xcode Command Line Tools.
  - **Windows**: Visual Studio Build Tools 2022 (C++ desktop workload for native `better-sqlite3` compilation).
  - **Linux**: Standard build utilities (`build-essential`, `libfuse2` for AppImage, or Docker for containerized builds).

---

## Step 1: Build the Packaged Binary

Run the package build command for your target platform:

```bash
# macOS (Builds arm64 & x64 universal DMGs)
pnpm tools-pack mac build --to all

# Windows (Builds NSIS installer)
pnpm tools-pack win build --to nsis

# Linux (Builds x86_64 AppImage)
pnpm tools-pack linux build --to appimage
```

**Expected Result:**
The output artifact is generated under `.tmp/pack/<platform>/dist/`.

---

## Step 2: Start the Local Fixture Service (For Updater Testing)

If verifying auto-update behavior, start the local fixture service to serve deterministic release feeds:

```bash
pnpm tools-serve start updater
```

**Expected Output:**
```text
[tools-serve] Mock updater fixture server running on http://127.0.0.1:18456
[tools-serve] Serving synthetic update feeds for stable/beta channels
```

---

## Step 3: Install into an Isolated Test Namespace

Install the newly built package into an isolated test namespace to avoid interfering with any production installation:

```bash
# macOS
pnpm tools-pack mac install --namespace test-smoke

# Windows
pnpm tools-pack win install --namespace test-smoke

# Linux (Headless execution)
pnpm tools-pack linux install --headless --namespace test-smoke
pnpm tools-pack linux start --headless --namespace test-smoke
```

---

## Step 4: Run Smoke Verification & Inspection

Inspect the running packaged instance via sidecar IPC:

```bash
# Query running application status
pnpm tools-pack <platform> inspect status --namespace test-smoke --json

# Execute JavaScript expression in the renderer
pnpm tools-pack <platform> inspect eval --expr "document.title" --namespace test-smoke

# Capture a screenshot of the packaged window
pnpm tools-pack <platform> inspect screenshot --path /tmp/smoke-test.png --namespace test-smoke
```

**Expected Result:**
The eval expression returns `"Open Design"`, confirming that sidecars spawned and the frontend rendered successfully.

---

## Step 5: Cleanup

After testing, cleanly shut down and remove the test installation:

```bash
pnpm tools-pack <platform> cleanup --namespace test-smoke
```

---

## Troubleshooting

- **Windows `better-sqlite3` build fails**: Install Visual Studio Build Tools 2022 with C++ desktop development. Ensure Node 24 is active.
- **Linux AppImage fails on Ubuntu 24.04**: Ubuntu 24.04 dropped `libfuse2` by default. Install `sudo apt install libfuse2` or run with `--containerized`.
- **Sidecar timeout during install**: Check `.tmp/tools-pack/<namespace>/logs/` for daemon startup errors.
