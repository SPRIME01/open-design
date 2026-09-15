# How-To: Add a New AI Agent Adapter

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Subsystem Guide:** [`docs/subsystems/agent-runtimes.md`](file:///home/sprime01/projects/open-design/docs/subsystems/agent-runtimes.md) · **Reference:** [`docs/reference/cli.md`](file:///home/sprime01/projects/open-design/docs/reference/cli.md)

This procedural guide details how to integrate support for a new external AI coding agent CLI into Open Design.

---

## Goal

Create, register, and verify a new `RuntimeAgentDef` so the daemon can detect, launch, and stream output from an external AI coding toolchain.

---

## Prerequisites

- Node.js `~24`, pnpm `10.33.2`.
- The target agent CLI installed locally on your development machine.
- Familiarity with the target CLI's command-line arguments and stdout streaming format.

---

## Step 1: Create the Runtime Definition Module

Create a new definition file under [`apps/daemon/src/runtimes/defs/`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/defs/):

```bash
touch apps/daemon/src/runtimes/defs/my-agent.ts
```

Populate `my-agent.ts` adhering to the `RuntimeAgentDef` interface:

```ts
import type { RuntimeAgentDef } from '../types.js';

export const myAgentDef: RuntimeAgentDef = {
  id: 'my-agent',
  displayName: 'My Agent CLI',
  defaultBinary: 'my-agent',
  
  // Launch argument builder: must include non-interactive / headless flags
  getLaunchArgs: ({ workspaceDir, model }) => {
    return [
      '--project', workspaceDir,
      '--non-interactive',
      ...(model ? ['--model', model] : []),
    ];
  },

  // 'text' ends stdin immediately; 'stream-json' keeps stdin open for steering
  promptInputFormat: 'text',

  // Normalizer: map CLI stdout into Open Design stream parser
  streamFormat: 'plain', // or 'json-events' / custom stream adapter

  // Probing: command to check if agent is installed and functional
  versionArgs: ['--version'],
  
  // Auth probing (optional): check if CLI is logged in
  authProbe: {
    args: ['auth', 'status'],
    expectedPattern: /logged in as/i,
  },
};
```

---

## Step 2: Register in Runtime Registry

Open [`apps/daemon/src/runtimes/registry.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/registry.ts) and register the new definition:

```ts
import { myAgentDef } from './defs/my-agent.js';

export const SHIPPED_AGENTS: RuntimeAgentDef[] = [
  ...
  myAgentDef,
];
```

---

## Step 3: Add to Allowed Executables Allowlist

To prevent arbitrary command injection, add the binary name to the executable allowlist in [`packages/platform/src/`](file:///home/sprime01/projects/open-design/packages/platform/src/) and [`apps/daemon/src/runtimes/executables.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/runtimes/executables.ts):

```ts
const WELL_KNOWN_AGENT_BINARIES = new Set([
  ...
  'my-agent',
]);
```

---

## Step 4: Validate Discovery via CLI

Verify that the daemon detects the new agent:

```bash
od agent list --json
```

**Expected Output:**
```json
{
  "id": "my-agent",
  "displayName": "My Agent CLI",
  "available": true,
  "binaryPath": "/usr/local/bin/my-agent",
  "authStatus": "authenticated"
}
```

---

## Step 5: Add Unit & Stream Replay Tests

1. Create a test in `apps/daemon/tests/runtimes/defs/my-agent.test.ts` asserting launch arguments, version probe, and stream parsing.
2. If the agent emits structured JSON, record a trace in `apps/daemon/tests/fixtures/` and add parser assertions against `json-event-stream.ts`.
3. Run test verification:
   ```bash
   pnpm --filter @open-design/daemon test
   pnpm guard
   ```

---

## Troubleshooting

- **Agent reported as `unavailable`**: Verify `which my-agent` outputs a valid path and that `my-agent --version` returns exit code 0 within 3000ms.
- **Run hangs without streaming**: The agent CLI may be prompting for interactive TTY confirmation. Ensure non-interactive flags (e.g. `--yes`, `--batch`) are included in `getLaunchArgs`.
