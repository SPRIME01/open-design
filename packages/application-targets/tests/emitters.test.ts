import { describe, expect, it, beforeAll } from "vitest";
import { compile } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "../src/index.js";

const bundleRaw = {
  schemaVersion: "1.0.0",
  applicationId: "emitter-fixture",
  name: "Emitter Fixture",
  modules: {
    domain: "ir/domain.ir.json",
    capabilities: "ir/capabilities.ir.json",
    boundary: "ir/boundary.ir.json",
    persistence: "ir/persistence.ir.json",
    frontend: "ir/frontend.ir.json",
  },
  source: { projectId: "emitter-fixture", runId: "run-test", parentBundleHash: null },
};

const domainRaw = {
  schemaVersion: "1.0.0",
  applicationId: "emitter-fixture",
  entities: [
    {
      id: "entry",
      identity: "entry.id",
      fields: [
        { id: "entry.id", type: "uuid", generated: true },
        { id: "entry.message", type: "string", minLength: 1, maxLength: 500 },
        { id: "entry.created-at", type: "timestamp", generated: true },
      ],
      invariants: [],
    },
  ],
  enums: [],
  valueObjects: [],
  scalarTypes: [],
  invariants: [],
  stateMachines: [],
};

const capabilitiesRaw = {
  schemaVersion: "1.0.0",
  applicationId: "emitter-fixture",
  queries: [],
  commands: [
    {
      id: "entries.sign",
      input: "sign-entry-input",
      output: "entry",
      transactional: true,
      idempotency: "required",
      authorization: "entry.create",
      preconditions: [],
      effects: [{ kind: "create", entity: "entry" }],
      errors: ["VALIDATION_FAILED"],
    },
  ],
  events: [],
  workflows: [],
  authorizationCapabilities: ["entry.create"],
  errorCatalog: [{ id: "VALIDATION_FAILED", recoverable: true }],
};

const boundaryRaw = {
  schemaVersion: "1.0.0",
  applicationId: "emitter-fixture",
  operations: [
    {
      id: "entries.sign",
      capability: "entries.sign",
      input: "sign-entry-input",
      output: "entry",
      errors: ["VALIDATION_FAILED"],
      idempotencyKey: "required",
    },
  ],
  schemas: [
    {
      id: "sign-entry-input",
      kind: "object",
      fields: [{ id: "message", type: "string", required: true }],
    },
  ],
  errors: [],
  subscriptions: [],
  versioningPolicy: "compatible-additive",
};

const persistenceRaw = {
  schemaVersion: "1.0.0",
  applicationId: "emitter-fixture",
  aggregates: [{ id: "entry", rootEntity: "entry", transactionBoundary: true }],
  repositories: [{ id: "entry-repository", aggregate: "entry", operations: ["insert"] }],
  relations: [],
  indexes: [],
  uniqueness: [],
  retention: [],
  deletionPolicies: [],
  concurrency: [],
  migrationIntent: [],
};

const frontendRaw = {
  schemaVersion: "1.0.0",
  applicationId: "emitter-fixture",
  routes: [{ id: "route.home", path: "/", screen: "screen.home" }],
  screens: [{ id: "screen.home", rootNode: "component.sign-form" }],
  components: [],
  nodes: [
    {
      id: "component.sign-form",
      level: "component",
      kind: "form",
      slots: {
        fields: ["atomic.author", "atomic.message"],
        actions: ["atomic.sign"],
      },
      bindings: [],
      actions: [
        { trigger: "submit", operation: "entries.sign", input: { message: "atomic.message.value" } },
      ],
      states: ["idle"],
      styleIntent: {},
      responsive: {},
      accessibility: { label: "Sign the guestbook" },
      sourceRef: "brief.sign-form",
    },
    {
      id: "atomic.author",
      level: "atomic",
      kind: "input",
      children: [],
      bindings: [],
      actions: [],
      states: [],
      styleIntent: {},
      responsive: {},
      accessibility: { label: "Your name", required: true },
      sourceRef: "domain.entry.author",
    },
    {
      id: "atomic.message",
      level: "atomic",
      kind: "textarea",
      children: [],
      bindings: [],
      actions: [],
      states: [],
      styleIntent: {},
      responsive: {},
      accessibility: { label: "Message", required: true },
      sourceRef: "domain.entry.message",
    },
    {
      id: "atomic.sign",
      level: "atomic",
      kind: "button",
      children: [],
      bindings: [],
      actions: [{ trigger: "activate", intent: "submit-nearest-form" }],
      states: [],
      styleIntent: { variant: "primary" },
      responsive: {},
      accessibility: { label: "Sign guestbook" },
      sourceRef: "capability.entries.sign",
    },
  ],
  flows: [],
  localState: [],
  operationBindings: [{ node: "component.sign-form", operation: "entries.sign" }],
  tokenReferences: [],
  accessibilityDefaults: {},
};

interface TestTarget {
  id: string;
  adapter: string;
  mode: "scaffold";
  outputRoot: string;
  frontend: { adapter: string };
  persistence?: { adapter: string };
}

async function compileTarget(targetId: string, target: TestTarget) {
  const config = {
    schemaVersion: 1,
    application: "application.ir.json",
    targets: [target],
  };
  return compile(
    bundleRaw,
    domainRaw,
    capabilitiesRaw,
    boundaryRaw,
    persistenceRaw,
    frontendRaw,
    config,
    targetId
  );
}

describe("emitter output quality", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  it("html-static renders accessibility labels and form controls, not node IDs", async () => {
    const res = await compileTarget("html-static", {
      id: "html-static",
      adapter: "html-static",
      mode: "scaffold" as const,
      outputRoot: "generated/html-static",
      frontend: { adapter: "html-static" },
    });

    expect(res.status).toBe("succeeded");
    const html = res.fileSet?.files.find(f => f.path === "index.html")?.content ?? "";
    expect(html).toContain("<button>Sign guestbook</button>");
    expect(html).not.toContain("<button>atomic.sign</button>");
    expect(html).toContain('Your name <input type="text" required />');
    expect(html).toContain("Message <textarea required></textarea>");
  });

  it("sqlite migration converts kebab-case field IDs to snake_case columns", async () => {
    const res = await compileTarget("sqlite-target", {
      id: "sqlite-target",
      adapter: "sqlite-better-sqlite3",
      mode: "scaffold" as const,
      outputRoot: "generated/sqlite-target",
      frontend: { adapter: "html-static" },
      persistence: { adapter: "sqlite-better-sqlite3" },
    });

    expect(res.status).toBe("succeeded");
    const sql =
      res.fileSet?.files.find(f => f.path === "src/server/persistence/migrations/0001_initial.sql")
        ?.content ?? "";
    expect(sql).toContain('"created_at"');
    expect(sql).not.toContain('"created-at"');
  });

  it("nextjs-app emits a tsconfig.json and @types/node pin so next build stays offline-safe", async () => {
    const res = await compileTarget("nextjs-app", {
      id: "nextjs-app",
      adapter: "nextjs-app",
      mode: "scaffold" as const,
      outputRoot: "generated/nextjs-app",
      frontend: { adapter: "nextjs-app" },
    });

    expect(res.status).toBe("succeeded");
    const tsconfig = JSON.parse(
      res.fileSet?.files.find(f => f.path === "tsconfig.json")?.content ?? "{}"
    );

    // Next 14 App Router baseline: presence of the config (plus the @types/*
    // pins below) keeps `next build` from synthesizing a tsconfig or
    // installing type packages through the package manager.
    expect(tsconfig.compilerOptions).toMatchObject({
      jsx: "preserve",
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      isolatedModules: true,
      esModuleInterop: true,
    });
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
    expect(tsconfig.include).toContain("next-env.d.ts");
    expect(tsconfig.include).toContain("**/*.tsx");
    expect(tsconfig.exclude).toContain("node_modules");

    const pkg = JSON.parse(
      res.fileSet?.files.find(f => f.path === "package.json")?.content ?? "{}"
    );
    expect(pkg.devDependencies["@types/node"]).toBeDefined();
  });
});
