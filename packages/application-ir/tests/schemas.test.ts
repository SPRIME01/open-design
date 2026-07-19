import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  applicationIRBundleSchema,
  domainIRSchema,
  capabilityIRSchema,
  boundaryIRSchema,
  persistenceIRSchema,
  frontendIRSchema
} from "../src/schemas/index.js";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

describe("IR schema parsing tests", () => {
  it("parses the valid project-console fixture successfully", () => {
    const projectConsoleDir = path.join(fixturesDir, "valid", "project-console");
    
    const bundleRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "application.ir.json"), "utf8"));
    const domainRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "domain.ir.json"), "utf8"));
    const capabilitiesRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "capabilities.ir.json"), "utf8"));
    const boundaryRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "boundary.ir.json"), "utf8"));
    const persistenceRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "persistence.ir.json"), "utf8"));
    const frontendRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "frontend.ir.json"), "utf8"));

    expect(applicationIRBundleSchema.safeParse(bundleRaw).success).toBe(true);
    expect(domainIRSchema.safeParse(domainRaw).success).toBe(true);
    expect(capabilityIRSchema.safeParse(capabilitiesRaw).success).toBe(true);
    expect(boundaryIRSchema.safeParse(boundaryRaw).success).toBe(true);
    expect(persistenceIRSchema.safeParse(persistenceRaw).success).toBe(true);
    expect(frontendIRSchema.safeParse(frontendRaw).success).toBe(true);
  });

  it("parses the valid marketing-site fixture successfully", () => {
    const marketingSiteDir = path.join(fixturesDir, "valid", "marketing-site");
    
    const bundleRaw = JSON.parse(fs.readFileSync(path.join(marketingSiteDir, "application.ir.json"), "utf8"));
    const domainRaw = JSON.parse(fs.readFileSync(path.join(marketingSiteDir, "ir", "domain.ir.json"), "utf8"));
    const capabilitiesRaw = JSON.parse(fs.readFileSync(path.join(marketingSiteDir, "ir", "capabilities.ir.json"), "utf8"));
    const boundaryRaw = JSON.parse(fs.readFileSync(path.join(marketingSiteDir, "ir", "boundary.ir.json"), "utf8"));
    const persistenceRaw = JSON.parse(fs.readFileSync(path.join(marketingSiteDir, "ir", "persistence.ir.json"), "utf8"));
    const frontendRaw = JSON.parse(fs.readFileSync(path.join(marketingSiteDir, "ir", "frontend.ir.json"), "utf8"));

    expect(applicationIRBundleSchema.safeParse(bundleRaw).success).toBe(true);
    expect(domainIRSchema.safeParse(domainRaw).success).toBe(true);
    expect(capabilityIRSchema.safeParse(capabilitiesRaw).success).toBe(true);
    expect(boundaryIRSchema.safeParse(boundaryRaw).success).toBe(true);
    expect(persistenceIRSchema.safeParse(persistenceRaw).success).toBe(true);
    expect(frontendIRSchema.safeParse(frontendRaw).success).toBe(true);
  });

  it("rejects invalid ID format", () => {
    const invalidBundle = {
      schemaVersion: "1.0.0",
      applicationId: "Project-Console", // capital letters not allowed by ID pattern
      name: "Project Console",
      modules: {
        domain: "ir/domain.ir.json",
        capabilities: "ir/capabilities.ir.json",
        boundary: "ir/boundary.ir.json",
        persistence: "ir/persistence.ir.json",
        frontend: "ir/frontend.ir.json"
      },
      source: {
        projectId: "project-console",
        runId: "run-example",
        parentBundleHash: null
      }
    };
    expect(applicationIRBundleSchema.safeParse(invalidBundle).success).toBe(false);
  });
});
