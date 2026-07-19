import { describe, expect, it } from "vitest";
import { runLoweringPipeline } from "../src/pipeline.js";
import { ResolvedApplicationIR } from "@open-design/application-ir";

describe("Lowering pipeline tests", () => {
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

  it("runs the full lowering pipeline successfully", () => {
    const ir = baseIR();
    const res = runLoweringPipeline(ir);
    expect(res.diagnostics.length).toBe(0);
  });
});
