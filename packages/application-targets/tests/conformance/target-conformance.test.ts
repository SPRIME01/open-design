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

  const runTargetTest = async (adapterId: string, fixtureName = "project-console") => {
    const fixtureDir = path.join(fixturesDir, "valid", fixtureName);

    const bundleRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "application.ir.json"), "utf8"));
    const domainRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "ir", "domain.ir.json"), "utf8"));
    const capabilitiesRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "ir", "capabilities.ir.json"), "utf8"));
    const boundaryRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "ir", "boundary.ir.json"), "utf8"));
    const persistenceRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "ir", "persistence.ir.json"), "utf8"));
    const frontendRaw = JSON.parse(fs.readFileSync(path.join(fixtureDir, "ir", "frontend.ir.json"), "utf8"));

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
    expect((res.plan?.creates ?? []).length).toBeGreaterThan(0);
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

  // The same conformance contract must hold for the richer variation
  // fixtures: a multi-screen flow app (mobile-onboarding) and an
  // auth-flavored app with authorization-bearing capabilities (auth-settings).
  const frontendAdapters = ["react-vite", "nextjs-app", "sveltekit"] as const;
  const variationFixtures = ["auth-settings", "mobile-onboarding"] as const;

  for (const adapterId of frontendAdapters) {
    for (const fixtureName of variationFixtures) {
      it(`conforms ${adapterId} adapter for ${fixtureName}`, async () => {
        await runTargetTest(adapterId, fixtureName);
      });
    }
  }
});
