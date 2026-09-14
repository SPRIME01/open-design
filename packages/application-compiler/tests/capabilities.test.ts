import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  validateApplication,
  planApplication,
  compile,
  adapterRegistry,
  ApplicationCompilerInput,
} from "../src/index.js";
import { HtmlStaticAdapter } from "../../application-targets/src/frontend/html-static/adapter.js";

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

function loadFixtureInput(fixtureName: string): ApplicationCompilerInput {
  const dir = path.join(fixturesDir, "valid", fixtureName);
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  return {
    bundle: read("application.ir.json"),
    domain: read("ir/domain.ir.json"),
    capabilities: read("ir/capabilities.ir.json"),
    boundary: read("ir/boundary.ir.json"),
    persistence: read("ir/persistence.ir.json"),
    frontend: read("ir/frontend.ir.json"),
  };
}

function projectionConfig(outputRoot = "generated/html-target") {
  return {
    schemaVersion: 1,
    application: "application.ir.json",
    targets: [
      {
        id: "html-target",
        adapter: "html-static",
        mode: "scaffold" as const,
        outputRoot,
        frontend: {
          adapter: "html-static"
        }
      }
    ]
  };
}

describe("validateApplication", () => {
  it("returns valid=true with zero diagnostics for every valid fixture", () => {
    for (const fixture of ["marketing-site", "project-console"]) {
      const res = validateApplication(loadFixtureInput(fixture));
      expect(res.valid, fixture).toBe(true);
      expect(res.diagnostics, fixture).toEqual([]);
    }
  });

  it("surfaces typed schema diagnostics for an invalid bundle", () => {
    const input = loadFixtureInput("project-console");
    const broken: ApplicationCompilerInput = {
      ...input,
      bundle: { ...input.bundle, schemaVersion: "not-a-version" },
    };

    const res = validateApplication(broken);
    expect(res.valid).toBe(false);
    expect(res.diagnostics.length).toBeGreaterThan(0);
    for (const d of res.diagnostics) {
      expect(d.severity).toBe("error");
      expect(d.phase).toBe("validation");
      expect(d.code).toBe("schema_error");
      expect(d.sourceFile).toBeDefined();
      expect(d.pointer).toBeDefined();
    }
  });

  it("surfaces typed cross-reference diagnostics for mismatched module ownership", () => {
    const input = loadFixtureInput("project-console");
    const mismatched: ApplicationCompilerInput = {
      ...input,
      frontend: { ...input.frontend, applicationId: "some-other-app" },
    };

    const res = validateApplication(mismatched);
    expect(res.valid).toBe(false);
    expect(res.diagnostics.some(d => d.code === "cross_reference_error")).toBe(true);
    for (const d of res.diagnostics) {
      expect(d.severity).toBe("error");
      expect(d.phase).toBe("validation");
    }
  });
});

describe("planApplication", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new HtmlStaticAdapter());
    } catch (e) {}
  });

  it("returns a plan summary with a stable hash and writes nothing", async () => {
    const input = loadFixtureInput("project-console");

    // An output root that does not exist anywhere: a pure planner must never
    // need to create it, and a temp dir it could plausibly write into must
    // stay empty.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "od-plan-application-"));
    const outputRoot = "od-plan-purity-check/out";
    const config = projectionConfig(outputRoot);

    const res1 = await planApplication(input, config, "html-target");
    const res2 = await planApplication(input, config, "html-target");

    expect(res1.status).toBe("succeeded");
    expect(res1.plan).toBeDefined();
    expect(res1.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res1.plan?.targetId).toBe("html-target");
    expect(res1.plan?.creates).toContain("index.html");
    expect(res1.plan?.planHash).toBe(res1.planHash);

    // Identical input yields an identical plan hash.
    expect(res2.status).toBe("succeeded");
    expect(res2.planHash).toBe(res1.planHash);
    expect(res2.plan?.creates).toEqual(res1.plan?.creates);

    // No output directory was created and nothing landed in the temp root.
    expect(fs.existsSync(path.join(process.cwd(), outputRoot))).toBe(false);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("hashes identically to compile() against the same (fresh) disk state", async () => {
    const input = loadFixtureInput("project-console");
    const config = projectionConfig();

    const compileRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "html-target"
    );
    expect(compileRes.status).toBe("succeeded");

    const planRes = await planApplication(input, config, "html-target");
    expect(planRes.status).toBe("succeeded");
    expect(planRes.planHash).toBe(compileRes.plan?.planHash);
  });

  it("reports failed-planning diagnostics for an unknown target id", async () => {
    const input = loadFixtureInput("project-console");
    const res = await planApplication(input, projectionConfig(), "missing-target");
    expect(res.status).toBe("failed-planning");
    expect(res.plan).toBeUndefined();
    expect(res.diagnostics.some(d => d.code === "unsupported_kind_error" && d.severity === "error")).toBe(true);
  });

  it("reports failed-validation diagnostics without planning", async () => {
    const input = loadFixtureInput("project-console");
    const broken: ApplicationCompilerInput = {
      ...input,
      bundle: { ...input.bundle, schemaVersion: "not-a-version" },
    };

    const res = await planApplication(broken, projectionConfig(), "html-target");
    expect(res.status).toBe("failed-validation");
    expect(res.plan).toBeUndefined();
    expect(res.diagnostics.length).toBeGreaterThan(0);
  });
});
