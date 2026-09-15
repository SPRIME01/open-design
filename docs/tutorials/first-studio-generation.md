# Tutorial: Your First Creative Studio Generation

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Workflow Guide:** [`docs/workflows/generation-lifecycle.md`](file:///home/sprime01/projects/open-design/docs/workflows/generation-lifecycle.md) · **Subsystem Guide:** [`docs/subsystems/web.md`](file:///home/sprime01/projects/open-design/docs/subsystems/web.md)

This tutorial walks you through creating a design project, choosing a brand design system, running an interactive AI generation turn, and inspecting the live deliverable in the Open Design Creative Studio.

---

## Prerequisites

Before starting, verify you have:
1. Node.js `~24` and `pnpm@10.33.2`.
2. A supported coding agent CLI installed and authenticated (e.g. `claude`, `codex`, or `opencode`).
   - Run `claude --version` or `codex --version` to verify availability.
3. Open Design repository dependencies installed (`pnpm install`).

---

## Step 1: Launch the Local Development Environment

Start the coordinated Open Design environment using `tools-dev`:

```bash
pnpm tools-dev
```

**Expected Result:**
```text
[tools-dev] Starting daemon sidecar...
[tools-dev] Daemon ready on http://127.0.0.1:7456
[tools-dev] Starting web sidecar...
[tools-dev] Web ready on http://localhost:17573
[tools-dev] Launching Electron desktop window...
```
The native desktop window opens (or navigate your browser to `http://localhost:17573`).

---

## Step 2: Create a New Project

1. In the left navigation sidebar, click **New Project** (`+`).
2. Enter a project name: `Fintech Landing Page`.
3. In the project settings, select your primary design aesthetics:
   - **Design System**: Select `linear-app` or `stripe`.
   - **Agent Runtime**: Select your installed agent (e.g. `claude`).
4. Click **Create Project**.

---

## Step 3: Execute Your First Generation Turn

In the chat composer at the bottom of the screen, enter your prompt:

```text
Create a high-conversion pricing page with three tiers (Starter, Pro, Enterprise), an annual billing toggle with 20% discount, and an interactive FAQ accordion.
```

Press **Send** (`Enter`).

**Expected Result:**
1. The chat panel mounts an **Execution Shell** displaying the planned execution steps.
2. The **Plan Pill** appears above the composer showing the active step (`Step 1 / 3`).
3. The agent streams its thinking and tool calls in real time.
4. As the agent writes `index.html` and `styles.css` to the workspace, the right-hand **Live Preview** pane automatically refreshes without flashing.

---

## Step 4: Interact with the Live Preview

Open Design's preview pane is not a static screenshot; it is a living sandbox:

1. **Test Interactivity**: Click the pricing toggle (Monthly / Annual) inside the preview iframe to verify dynamic calculation. Click the FAQ items to test accordion expansion.
2. **Inspect Elements**: Click the **Inspect** button in the preview toolbar. Hover over elements in the preview to inspect their CSS rules and verified design tokens.
3. **Leave a Visual Comment**: Select the **Comment** tool in the toolbar and click directly on a pricing card. Type: `Make the Pro tier border glow with our primary accent color.` Submit the comment to initiate a targeted follow-up turn.

---

## Step 5: Answering Clarifying Questions

If your prompt was ambiguous, the agent will emit an inline `<question-form>`:
1. An interactive form appears directly within the assistant message.
2. Select your preferred options (e.g. currency symbols, color modes).
3. Click **Submit Answers**. The agent immediately resumes with full clarity.

---

## Next Steps

- Explore available brand systems: inspect the catalog in [`design-systems/`](file:///home/sprime01/projects/open-design/design-systems/).
- Learn about the underlying execution mechanics: read [Creative Generation Lifecycle](file:///home/sprime01/projects/open-design/docs/workflows/generation-lifecycle.md).
- Compile formal applications: try [Compiling Your First Application from IR](file:///home/sprime01/projects/open-design/docs/tutorials/build-first-app-from-ir.md).
