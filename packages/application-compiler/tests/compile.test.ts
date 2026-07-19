import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile, adapterRegistry } from "../src/index.js";
import { HtmlStaticAdapter } from "../../application-targets/src/frontend/html-static/adapter.js";

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

describe("compiler integration tests", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new HtmlStaticAdapter());
    } catch (e) {}
  });

  it("compiles valid project-console successfully into html-static", async () => {
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
          id: "html-target",
          adapter: "html-static",
          mode: "scaffold" as const,
          outputRoot: "generated/html-target",
          frontend: {
            adapter: "html-static"
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
      "html-target"
    );

    if (res.status !== "succeeded") {
      console.log("Compile diagnostics:", JSON.stringify(res.diagnostics, null, 2));
    }
    expect(res.status).toBe("succeeded");
    expect(res.plan).toBeDefined();
    expect(res.fileSet).toBeDefined();
    expect(res.fileSet?.files.some(f => f.path === "index.html")).toBe(true);
  });
});
