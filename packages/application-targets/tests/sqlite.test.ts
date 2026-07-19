import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "../src/index.js";

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

describe("sqlite persistence adapter tests", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  it("compiles with sqlite-better-sqlite3 persistence successfully", async () => {
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
          id: "sqlite-target",
          adapter: "sqlite-better-sqlite3",
          mode: "scaffold" as const,
          outputRoot: "generated/sqlite-target",
          frontend: { adapter: "html-static" },
          persistence: { adapter: "sqlite-better-sqlite3" }
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
      "sqlite-target"
    );

    expect(res.status).toBe("succeeded");
    expect(res.fileSet?.files.some(f => f.path === "src/server/persistence/migrations/0001_initial.sql")).toBe(true);
  });
});
