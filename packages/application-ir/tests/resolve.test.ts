import { describe, expect, it } from "vitest";
import { resolveCrossReferences } from "../src/resolve.js";
import { ResolvedApplicationIR } from "../src/types.js";

describe("cross-reference resolution tests", () => {
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

  it("succeeds when all references are valid (empty case)", () => {
    const ir = baseIR();
    const errors = resolveCrossReferences(ir);
    expect(errors.length).toBe(0);
  });

  it("detects app ID mismatch", () => {
    const ir = baseIR();
    ir.domain.applicationId = "mismatched-app";
    const errors = resolveCrossReferences(ir);
    expect(errors.length).toBe(1);
    expect(errors[0]!.code).toBe("cross_reference_error");
    expect(errors[0]!.message).toContain("applicationId mismatch");
  });

  it("detects route screen reference failures", () => {
    const ir = baseIR();
    ir.frontend.routes.push({ id: "route.home", path: "/", screen: "screen.home" });
    const errors = resolveCrossReferences(ir);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("references non-existent screen 'screen.home'");
  });
});
