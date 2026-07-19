import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "../src/index.js";

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

describe("Vertical slice integration tests", () => {
  beforeAll(() => {
    registerAllBuiltInAdapters();
  });

  it("compiles a vertical CRUD slice with frontend, transport, and persistence adapters", async () => {
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
          id: "vertical-slice-target",
          adapter: "compound-target", // compound mapping
          mode: "scaffold" as const,
          outputRoot: "generated/vertical-slice-target",
          frontend: { adapter: "nextjs-app" },
          transport: { adapter: "next-server-actions" },
          persistence: { adapter: "sqlite-better-sqlite3" }
        }
      ]
    };

    // Note: Since we don't have a single composite adapter called 'compound-target', we can compile the target by running NextjsAppAdapter + NextServerActionsAdapter + SqliteBetterSqlite3Adapter manually, or we can compile them one by one.
    // Let's run Next.js App compilation:
    const resFront = await compile(
      bundleRaw, domainRaw, capabilitiesRaw, boundaryRaw, persistenceRaw, frontendRaw,
      { ...config, targets: [{ ...config.targets[0]!, adapter: "nextjs-app" }] },
      "vertical-slice-target"
    );
    expect(resFront.status).toBe("succeeded");
    expect(resFront.fileSet?.files.some(f => f.path === "src/app/page.tsx")).toBe(true);

    // Let's run transport compilation:
    const resTrans = await compile(
      bundleRaw, domainRaw, capabilitiesRaw, boundaryRaw, persistenceRaw, frontendRaw,
      { ...config, targets: [{ ...config.targets[0]!, adapter: "next-server-actions" }] },
      "vertical-slice-target"
    );
    expect(resTrans.status).toBe("succeeded");
    expect(resTrans.fileSet?.files.some(f => f.path === "src/generated/server-actions.ts")).toBe(true);

    // Let's run persistence compilation:
    const resPers = await compile(
      bundleRaw, domainRaw, capabilitiesRaw, boundaryRaw, persistenceRaw, frontendRaw,
      { ...config, targets: [{ ...config.targets[0]!, adapter: "sqlite-better-sqlite3" }] },
      "vertical-slice-target"
    );
    expect(resPers.status).toBe("succeeded");
    expect(resPers.fileSet?.files.some(f => f.path === "src/server/persistence/migrations/0001_initial.sql")).toBe(true);
  });
});
