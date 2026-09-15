# How-To: Add a New Application Compiler Target

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Subsystem Guide:** [`docs/subsystems/compiler.md`](file:///home/sprime01/projects/open-design/docs/subsystems/compiler.md) · **Reference:** [`docs/reference/ir-schema.md`](file:///home/sprime01/projects/open-design/docs/reference/ir-schema.md)

This procedural guide details how to implement and register a new target framework adapter in the Application Compiler.

---

## Goal

Create, register, and verify a new `ApplicationTargetAdapter` (e.g. `vue-vite`, `solid-vite`, or a custom backend) capable of projecting lowered Application IR into runnable, framework-native files.

---

## Prerequisites

- Node.js `~24`, pnpm `10.33.2`.
- Open Design repository cloned and dependencies installed (`pnpm install`).
- Understanding of the target framework's idiomatic project structure (e.g. `package.json`, build configs, routing conventions).

---

## Step 1: Create the Target Adapter Module

Create a new adapter file under [`packages/application-targets/src/frontend/`](file:///home/sprime01/projects/open-design/packages/application-targets/src/frontend/):

```bash
touch packages/application-targets/src/frontend/vue-vite.ts
```

Implement the `ApplicationTargetAdapter` interface:

```ts
import type {
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
} from "@open-design/application-compiler";

export const vueViteAdapter: ApplicationTargetAdapter = {
  id: "vue-vite",
  version: "1.0.0",
  targetKind: "frontend",

  // 1. Planning pass (does not write files)
  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const plannedFiles: string[] = [
      "package.json",
      "vite.config.ts",
      "index.html",
      "src/main.ts",
      "src/App.vue",
    ];

    // Add screen components from lowered IR
    for (const screen of context.ir.frontend.screens) {
      plannedFiles.push(`src/views/${screen.id}.vue`);
    }

    return {
      targetId: "vue-vite",
      files: plannedFiles,
    };
  },

  // 2. Emission pass (renders concrete file contents)
  async emit(plan: AdapterPlan): Promise<GeneratedFileSet> {
    return {
      targetId: "vue-vite",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            name: "generated-vue-app",
            version: "0.1.0",
            scripts: { build: "vite build" },
            dependencies: { vue: "^3.4.0" },
            devDependencies: { vite: "^5.0.0", typescript: "^5.0.0" },
          }, null, 2),
          sourceIds: ["bundle"],
        },
        {
          path: "src/App.vue",
          content: `<template>\n  <main id="app">\n    <h1>Generated Vue App</h1>\n  </main>\n</template>\n`,
          sourceIds: ["frontend.root"],
        },
        // Render additional planned files...
      ],
    };
  },
};
```

---

## Step 2: Register in the Adapter Registry

Open [`packages/application-targets/src/index.ts`](file:///home/sprime01/projects/open-design/packages/application-targets/src/index.ts) and export the new adapter:

```ts
export * from "./frontend/vue-vite.js";
```

Register the adapter in [`packages/application-compiler/src/adapter-registry.ts`](file:///home/sprime01/projects/open-design/packages/application-compiler/src/adapter-registry.ts):

```ts
import { vueViteAdapter } from "@open-design/application-targets";

adapterRegistry.register(vueViteAdapter);
```

---

## Step 3: Register Verification Command

Open [`apps/daemon/src/compiler/verification-runner.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/compiler/verification-runner.ts) and declare the build verification commands for `vue-vite`:

```ts
case "vue-vite":
  return [
    { name: "typecheck", command: "pnpm", args: ["vue-tsc", "--noEmit"] },
    { name: "build", command: "pnpm", args: ["vite", "build"] },
  ];
```

---

## Step 4: Add Adapter Tests

Create unit tests in `packages/application-targets/tests/vue-vite.test.ts`:

```ts
import { test, expect } from "vitest";
import { vueViteAdapter } from "../src/frontend/vue-vite.js";

test("vueViteAdapter plans and emits required files", async () => {
  const plan = await vueViteAdapter.plan(mockContext);
  expect(plan.files).toContain("package.json");
  expect(plan.files).toContain("src/App.vue");

  const emitted = await vueViteAdapter.emit(plan);
  expect(emitted.files.find(f => f.path === "package.json")).toBeDefined();
});
```

Run test suite:
```bash
pnpm --filter @open-design/application-targets test
pnpm guard
pnpm typecheck
```

---

## Step 5: Test Full Compilation

Test end-to-end compilation with an example project:

```bash
od app compile --project ./examples/guestbook --target vue-vite --follow
```

**Expected Result:**
```text
[7/9] Projecting files via vueViteAdapter... OK
[8/9] Writing files to generated/vue-vite... OK
[9/9] Verifying production build... OK
Compilation succeeded!
```

---

## Troubleshooting

- **Target not found error**: Ensure `targetConfig.adapter` in `projection.config.json` matches `vue-vite` and that the adapter was registered in `adapterRegistry`.
- **Build verification failure**: Inspect `compiler/evidence/<runId>.verification.json` to review stdout/stderr from `vite build`.
