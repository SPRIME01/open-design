import { describe, expect, it } from "vitest";
import { buildPlanHash, CompilePlan } from "../src/plan.js";

describe("plan builder tests", () => {
  it("builds a plan hash deterministically", () => {
    const plan: Omit<CompilePlan, "planHash"> = {
      planVersion: "1.0.0",
      runId: "run-1",
      sourceHash: "source-1",
      configHash: "config-1",
      targetId: "target-1",
      adapterVersions: {},
      creates: ["file-a.txt", "file-b.txt"],
      modifies: [],
      deletes: [],
      reuses: [],
      conflicts: [],
      unresolved: [],
      degradations: [],
      permissionsRequired: [],
      commandsProposed: [],
      verificationPlanned: [],
      estimatedOutputFiles: [],
    };

    const hashA = buildPlanHash(plan);
    const hashB = buildPlanHash({
      ...plan,
      creates: ["file-b.txt", "file-a.txt"] // different order
    });

    expect(hashA).toBe(hashB);
  });
});
