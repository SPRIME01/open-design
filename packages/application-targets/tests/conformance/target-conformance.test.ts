import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "../../src/index.js";

const fixturesDir = path.join(import.meta.dirname, "../../../application-ir/tests/fixtures");

describe("Target conformance tests for all frontend targets", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  const runTargetTest = async (adapterId: string) => {
    const projectConsoleDir = path.join(fixturesDir, "valid", "project-console");
    
    const bundleRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "application.ir.json"), "utf8"));
    const domainRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "domain.ir.json"), "utf8"));
    const capabilitiesRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "capabilities.ir.json"), "utf8"));
    const boundaryRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "boundary.ir.json"), "utf8"));
    const persistenceRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "persistence.ir.json"), "utf8"));
    const frontendRaw = JSON.parse(fs.readFileSync(path.join(projectConsoleDir, "ir", "frontend.ir.json"), "utf8"));

    const config = {
      schemaVersion: 1,
      application: "application.ir.json",
      targets: [
        {
          id: `${adapterId}-target`,
          adapter: adapterId,
          mode: "scaffold" as const,
          outputRoot: `generated/${adapterId}-target`,
          frontend: {
            adapter: adapterId
          }
        }
      ]
    };

    const res = await compile(
      bundleRaw,
      domainRaw,
      capabilitiesRaw,
      boundaryRaw,
      persistenceRaw,
      frontendRaw,
      config,
      `${adapterId}-target`
    );

    expect(res.status).toBe("succeeded");
    expect(res.fileSet).toBeDefined();
    expect(res.fileSet?.files.length).toBeGreaterThan(0);
  };

  it("conforms react-vite adapter", async () => {
    await runTargetTest("react-vite");
  });

  it("conforms nextjs-app adapter", async () => {
    await runTargetTest("nextjs-app");
  });

  it("conforms sveltekit adapter", async () => {
    await runTargetTest("sveltekit");
  });
});
