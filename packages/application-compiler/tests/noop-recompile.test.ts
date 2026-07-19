import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile, adapterRegistry } from "../src/index.js";
import { HtmlStaticAdapter } from "../../application-targets/src/frontend/html-static/adapter.js";

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

describe("noop recompile tests", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new HtmlStaticAdapter());
    } catch (e) {}
  });

  it("produces identical output and no changes when run twice", async () => {
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

    const res1 = await compile(
      bundleRaw,
      domainRaw,
      capabilitiesRaw,
      boundaryRaw,
      persistenceRaw,
      frontendRaw,
      config,
      "html-target"
    );

    if (res1.status !== "succeeded") {
      console.log("res1 diagnostics:", JSON.stringify(res1.diagnostics, null, 2));
    }
    expect(res1.status).toBe("succeeded");

    const filesMap = new Map(res1.fileSet?.files.map(f => [f.path, f.content]));

    const res2 = await compile(
      bundleRaw,
      domainRaw,
      capabilitiesRaw,
      boundaryRaw,
      persistenceRaw,
      frontendRaw,
      config,
      "html-target",
      {
        priorManifest: res1.manifest ?? null,
        currentFilesFetcher: (p) => ({
          exists: filesMap.has(p),
          content: filesMap.get(p) || null,
        }),
      }
    );

    expect(res2.status).toBe("succeeded");
    expect(res2.plan?.creates.length).toBe(0);
    expect(res2.plan?.modifies.length).toBe(0);
    expect(res2.plan?.reuses.length).toBe(res1.fileSet?.files.length);
  });

  it("classifies changed output over untouched prior output as modify, not conflict", async () => {
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

    const res1 = await compile(
      bundleRaw,
      domainRaw,
      capabilitiesRaw,
      boundaryRaw,
      persistenceRaw,
      frontendRaw,
      config,
      "html-target"
    );
    expect(res1.status).toBe("succeeded");

    // Disk still holds exactly what run 1 generated; only the IR changed.
    const filesMap = new Map(res1.fileSet?.files.map(f => [f.path, f.content]));
    const renamedBundle = { ...bundleRaw, name: `${bundleRaw.name} v2` };

    const res2 = await compile(
      renamedBundle,
      domainRaw,
      capabilitiesRaw,
      boundaryRaw,
      persistenceRaw,
      frontendRaw,
      config,
      "html-target",
      {
        priorManifest: res1.manifest ?? null,
        currentFilesFetcher: (p) => ({
          exists: filesMap.has(p),
          content: filesMap.get(p) || null,
        }),
      }
    );

    expect(res2.status).toBe("succeeded");
    expect(res2.plan?.conflicts ?? []).toEqual([]);
    expect(res2.plan?.modifies).toContain("index.html");
  });
});
