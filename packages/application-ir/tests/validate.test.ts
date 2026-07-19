import { describe, expect, it } from "vitest";
import { validateBundle } from "../src/validate.js";

describe("high-level validateBundle integration tests", () => {
  it("fails validation if schema fields are wrong", () => {
    const rawBundle = {
      schemaVersion: "1.0.0",
      applicationId: "test-app",
      name: "Test App",
      modules: {
        // missing domain reference
        capabilities: "ir/capabilities.ir.json",
        boundary: "ir/boundary.ir.json",
        persistence: "ir/persistence.ir.json",
        frontend: "ir/frontend.ir.json"
      },
      source: { projectId: "", runId: "", parentBundleHash: null },
    };

    const res = validateBundle(rawBundle, {}, {}, {}, {}, {});
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics[0]!.code).toBe("schema_error");
  });
});
