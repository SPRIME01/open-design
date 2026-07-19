import { describe, expect, it } from "vitest";
import { migrateResolvedIR } from "../src/migrate.js";
import { ResolvedApplicationIR } from "../src/types.js";

describe("schema migration tests", () => {
  const baseIR = (): ResolvedApplicationIR => ({
    bundle: {
      schemaVersion: "1.0.0",
      applicationId: "test-app",
      name: "Test App",
      modules: { domain: "", capabilities: "", boundary: "", persistence: "", frontend: "" },
      source: { projectId: "", runId: "", parentBundleHash: null },
    },
    domain: { schemaVersion: "1.0.0", applicationId: "test-app", entities: [], enums: [], valueObjects: [], scalarTypes: [], invariants: [], stateMachines: [] },
    capabilities: { schemaVersion: "1.0.0", applicationId: "test-app", queries: [], commands: [], events: [], workflows: [], authorizationCapabilities: [], errorCatalog: [] },
    boundary: { schemaVersion: "1.0.0", applicationId: "test-app", operations: [], schemas: [], errors: [], subscriptions: [], versioningPolicy: "compatible-additive" },
    persistence: { schemaVersion: "1.0.0", applicationId: "test-app", aggregates: [], repositories: [], relations: [], indexes: [], uniqueness: [], retention: [], deletionPolicies: [], concurrency: [], migrationIntent: [] },
    frontend: { schemaVersion: "1.0.0", applicationId: "test-app", routes: [], screens: [], components: [], nodes: [], flows: [], localState: [], operationBindings: [], tokenReferences: [], accessibilityDefaults: {} },
  });

  it("migrates minor and patch changes", () => {
    const ir = baseIR();
    const migrated = migrateResolvedIR(ir, "1.1.2");
    expect(migrated.bundle.schemaVersion).toBe("1.1.2");
    expect(migrated.domain.schemaVersion).toBe("1.1.2");
  });

  it("fails when major version differs", () => {
    const ir = baseIR();
    expect(() => migrateResolvedIR(ir, "2.0.0")).toThrow();
  });
});
