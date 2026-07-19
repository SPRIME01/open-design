import { describe, expect, it } from "vitest";
import { calculateOperationCoverage } from "../src/coverage.js";
import { ResolvedApplicationIR } from "@open-design/application-ir";

describe("operation coverage calculation tests", () => {
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

  it("calculates operation coverage successfully", () => {
    const ir = baseIR();
    ir.frontend.operationBindings.push({ node: "node-a", operation: "op-1" });
    const coverage = calculateOperationCoverage(ir, new Set(["op-1"]));
    expect(coverage.length).toBe(1);
    expect(coverage[0]!.operationId).toBe("op-1");
    expect(coverage[0]!.implemented).toBe(true);
  });
});
