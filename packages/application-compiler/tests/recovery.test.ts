import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compile,
  planApplication,
  validateApplication,
  adapterRegistry,
  ApplicationCompilerInput,
  ApplicationTargetAdapter,
  AdapterContext,
  AdapterPlan,
  GeneratedFileSet,
  VerificationStep,
} from "../src/index.js";
import { Diagnostic } from "@open-design/application-ir";
import { HtmlStaticAdapter } from "../../application-targets/src/frontend/html-static/adapter.js";
import { ReactViteAdapter } from "../../application-targets/src/frontend/react-vite/adapter.js";

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

function loadFixtureProjectionConfig(fixtureName: string) {
  const file = path.join(fixturesDir, "valid", fixtureName, "projection.config.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The compiler package is pure: compile() returns an in-memory file set and
 * never touches the filesystem. This helper mirrors the host-side write pass
 * (materializing a successful run's file set under a root) so the recovery
 * tests can observe exactly what a host would have written, and when.
 */
function materializeFileSet(root: string, fileSet: GeneratedFileSet): string[] {
  const written: string[] = [];
  for (const file of fileSet.files) {
    const abs = path.join(root, file.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content);
    written.push(file.path);
  }
  return written;
}

function readDirSnapshot(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relEntry = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relEntry);
      } else {
        snapshot.set(relEntry, fs.readFileSync(path.join(root, relEntry), "utf8"));
      }
    }
  };
  walk("");
  return snapshot;
}

function diskFetcher(root: string) {
  return (p: string) => {
    const abs = path.join(root, p);
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    return {
      exists,
      content: exists ? fs.readFileSync(abs, "utf8") : null,
    };
  };
}

function htmlTargetConfig(outputRoot = "generated/recovery-html") {
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
          adapter: "html-static",
        },
      },
    ],
  };
}

/**
 * Test-only adapter that models a target with an external tool dependency:
 * it refuses to plan (unresolved) unless the bundle metadata declares the
 * required tool. Used for the missing-tool blocked -> success recovery pair.
 */
class RecoveryToolProbeAdapter implements ApplicationTargetAdapter {
  readonly id = "recovery-tool-probe";
  readonly version = "0.1.0";
  readonly kind = "frontend" as const;
  readonly supportedIr = { application: "1.0.0" };
  readonly capabilities = {
    features: ["probe-file"],
    limitations: [],
  };

  private missingTool(ir: AdapterContext["ir"]): string | null {
    const required = ir.bundle.metadata?.requiredTools;
    const declared = Array.isArray(required) && required.includes("token-exporter");
    return declared ? null : "tool:token-exporter";
  }

  validate(context: AdapterContext): Diagnostic[] {
    return [];
  }

  async plan(context: AdapterContext): Promise<AdapterPlan> {
    const unresolved = this.missingTool(context.ir) ? ["tool:token-exporter"] : [];
    return {
      targetId: this.id,
      files: [
        {
          path: "probe.txt",
          content: `application: ${context.ir.bundle.applicationId}\ntools: ${JSON.stringify(context.ir.bundle.metadata?.requiredTools ?? [])}\n`,
          sourceIds: [context.ir.bundle.applicationId],
        },
      ],
      unresolved,
      degradations: [],
      permissions: [],
      commands: [],
      verificationSteps: [],
    };
  }

  async emit(plan: AdapterPlan): Promise<GeneratedFileSet> {
    return { files: plan.files };
  }

  verification(plan: AdapterPlan): VerificationStep[] {
    return plan.verificationSteps;
  }
}

function probeTargetConfig() {
  return {
    schemaVersion: 1,
    application: "application.ir.json",
    targets: [
      {
        id: "probe-target",
        adapter: "recovery-tool-probe",
        mode: "scaffold" as const,
        outputRoot: "generated/recovery-probe",
        frontend: {
          adapter: "recovery-tool-probe",
        },
      },
    ],
  };
}

describe("invalid-IR retry recovery", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new HtmlStaticAdapter());
    } catch (e) {}
  });

  it("a corrupted bundle fails with typed diagnostics and writes nothing; the corrected bundle then compiles", async () => {
    const input = loadFixtureInput("mobile-onboarding");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "od-recovery-empty-"));

    // Corrupted at the schema layer: bad bundle schemaVersion.
    const schemaCorrupted: ApplicationCompilerInput = {
      ...input,
      bundle: { ...input.bundle, schemaVersion: "corrupted" },
    };

    const compileRes = await compile(
      schemaCorrupted.bundle,
      schemaCorrupted.domain,
      schemaCorrupted.capabilities,
      schemaCorrupted.boundary,
      schemaCorrupted.persistence,
      schemaCorrupted.frontend,
      htmlTargetConfig(),
      "html-target"
    );
    expect(compileRes.status).toBe("failed-validation");
    expect(compileRes.diagnostics.length).toBeGreaterThan(0);
    for (const d of compileRes.diagnostics) {
      expect(d.severity).toBe("error");
      expect(d.phase).toBe("validation");
      expect(d.code).toBe("schema_error");
    }
    expect(compileRes.fileSet).toBeUndefined();
    expect(compileRes.manifest).toBeUndefined();
    expect(compileRes.plan).toBeUndefined();

    const planRes = await planApplication(schemaCorrupted, htmlTargetConfig(), "html-target");
    expect(planRes.status).toBe("failed-validation");
    expect(planRes.plan).toBeUndefined();

    // Nothing was written anywhere near the output root.
    expect(fs.readdirSync(tmpRoot)).toEqual([]);

    // Corrupted at the lowering layer: entity without fields survives the
    // schema but is rejected by the domain-check pass.
    const loweringCorrupted: ApplicationCompilerInput = {
      ...input,
      domain: {
        ...input.domain,
        entities: [{ ...input.domain.entities[0], fields: [] }],
      },
    };

    const loweringRes = await compile(
      loweringCorrupted.bundle,
      loweringCorrupted.domain,
      loweringCorrupted.capabilities,
      loweringCorrupted.boundary,
      loweringCorrupted.persistence,
      loweringCorrupted.frontend,
      htmlTargetConfig(),
      "html-target"
    );
    expect(loweringRes.status).toBe("failed-lowering");
    expect(loweringRes.diagnostics.some(d => d.code === "domain_validation_error")).toBe(true);
    expect(loweringRes.fileSet).toBeUndefined();
    expect(loweringRes.manifest).toBeUndefined();
    expect(fs.readdirSync(tmpRoot)).toEqual([]);

    // Retry with the corrected (valid) fixture: the run now succeeds and the
    // host-side materialization writes the full file set.
    const fixedRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      htmlTargetConfig(),
      "html-target"
    );
    expect(fixedRes.status).toBe("succeeded");
    expect(fixedRes.plan?.creates).toContain("index.html");
    expect(fixedRes.fileSet).toBeDefined();

    const written = materializeFileSet(tmpRoot, fixedRes.fileSet!);
    expect(written).toContain("index.html");
    expect(fs.existsSync(path.join(tmpRoot, "index.html"))).toBe(true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("a failed retry after a successful materialization leaves the previous output untouched", async () => {
    const input = loadFixtureInput("auth-settings");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "od-recovery-retry-"));
    const config = htmlTargetConfig();

    // Successful run, materialized like a host would.
    const res1 = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "html-target"
    );
    expect(res1.status).toBe("succeeded");
    materializeFileSet(tmpRoot, res1.fileSet!);
    const beforeFailure = readDirSnapshot(tmpRoot);
    expect(beforeFailure.size).toBeGreaterThan(0);

    // A later run arrives with a corrupted bundle while the previous output
    // is on disk. The run fails and the previous output survives untouched.
    const corrupted: ApplicationCompilerInput = {
      ...input,
      bundle: { ...input.bundle, applicationId: "Auth-Settings" },
    };

    const failedRes = await compile(
      corrupted.bundle,
      corrupted.domain,
      corrupted.capabilities,
      corrupted.boundary,
      corrupted.persistence,
      corrupted.frontend,
      config,
      "html-target",
      {
        priorManifest: res1.manifest ?? null,
        currentFilesFetcher: diskFetcher(tmpRoot),
      }
    );
    expect(failedRes.status).toBe("failed-validation");
    expect(failedRes.fileSet).toBeUndefined();
    expect(readDirSnapshot(tmpRoot)).toEqual(beforeFailure);

    // The corrected retry converges back to a no-op against its own output.
    const retryRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "html-target",
      {
        priorManifest: res1.manifest ?? null,
        currentFilesFetcher: diskFetcher(tmpRoot),
      }
    );
    expect(retryRes.status).toBe("succeeded");
    expect(retryRes.plan?.creates).toEqual([]);
    expect(retryRes.plan?.modifies).toEqual([]);
    expect(retryRes.plan?.reuses.length).toBe(res1.fileSet?.files.length);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe("missing-tool blocked -> success recovery", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new RecoveryToolProbeAdapter());
    } catch (e) {}
  });

  it("blocks planning while a required tool is missing and succeeds once the bundle declares it", async () => {
    const input = loadFixtureInput("custom-paths");
    const config = probeTargetConfig();

    // Sanity: the fixture itself is valid; only the tool dependency is absent.
    expect(validateApplication(input).valid).toBe(true);

    const blockedPlan = await planApplication(input, config, "probe-target");
    expect(blockedPlan.status).toBe("blocked");
    expect(blockedPlan.plan?.unresolved).toContain("tool:token-exporter");

    const blockedCompile = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "probe-target"
    );
    expect(blockedCompile.status).toBe("blocked");
    expect(blockedCompile.plan?.unresolved).toContain("tool:token-exporter");

    // Recovery: the corrected bundle declares the required tool.
    const fixed: ApplicationCompilerInput = {
      ...input,
      bundle: {
        ...input.bundle,
        metadata: { requiredTools: ["token-exporter"] },
      },
    };
    expect(validateApplication(fixed).valid).toBe(true);

    const fixedPlan = await planApplication(fixed, config, "probe-target");
    expect(fixedPlan.status).toBe("succeeded");
    expect(fixedPlan.plan?.unresolved).toEqual([]);
    expect(fixedPlan.plan?.creates).toContain("probe.txt");

    const fixedCompile = await compile(
      fixed.bundle,
      fixed.domain,
      fixed.capabilities,
      fixed.boundary,
      fixed.persistence,
      fixed.frontend,
      config,
      "probe-target"
    );
    expect(fixedCompile.status).toBe("succeeded");
    expect(fixedCompile.plan?.unresolved).toEqual([]);
    expect(fixedCompile.fileSet?.files.map(f => f.path)).toContain("probe.txt");
  });
});

describe("variation fixture projection configs", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new HtmlStaticAdapter());
    } catch (e) {}
    try {
      adapterRegistry.register(new ReactViteAdapter());
    } catch (e) {}
  });

  it("compiles two-design-systems against both of its token-set targets from the same bundle", async () => {
    const input = loadFixtureInput("two-design-systems");
    const config = loadFixtureProjectionConfig("two-design-systems");

    // Both token vocabularies travel in the single frontend module the
    // bundle schema allows; the projection config selects between them via
    // the only styling knob it supports, frontend.styling.
    expect(input.frontend.tokenReferences).toEqual(
      expect.arrayContaining(["--bg-surface", "--fg-primary", "--accent-strong", "--surface", "--text", "--primary"])
    );

    const auroraRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "aurora-static"
    );
    const cobaltRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "cobalt-static"
    );

    expect(auroraRes.status).toBe("succeeded");
    expect(cobaltRes.status).toBe("succeeded");
    expect(auroraRes.plan?.creates).toContain("index.html");
    expect(cobaltRes.plan?.creates).toContain("index.html");

    // Same source IR for both design systems; distinct target identities.
    expect(auroraRes.manifest?.sourceHash).toBe(cobaltRes.manifest?.sourceHash);
    expect(auroraRes.manifest?.targetId).toBe("aurora-static");
    expect(cobaltRes.manifest?.targetId).toBe("cobalt-static");

    // The styling selection lives in the target config, so the two targets
    // share one configHash (the whole config object is hashed) and — because
    // no built-in emitter consumes frontend.styling yet — identical emitted
    // bytes and therefore identical plan hashes.
    expect(auroraRes.manifest?.configHash).toBe(cobaltRes.manifest?.configHash);
    expect(auroraRes.plan?.planHash).toBe(cobaltRes.plan?.planHash);

    // Tokens demonstrably travel through the IR: changing the referenced
    // token vocabulary changes the source hash the manifest carries.
    const retokenized: ApplicationCompilerInput = {
      ...input,
      frontend: {
        ...input.frontend,
        tokenReferences: ["--bg-surface", "--fg-primary", "--accent-strong"],
      },
    };
    const retokenizedRes = await compile(
      retokenized.bundle,
      retokenized.domain,
      retokenized.capabilities,
      retokenized.boundary,
      retokenized.persistence,
      retokenized.frontend,
      config,
      "aurora-static"
    );
    expect(retokenizedRes.status).toBe("succeeded");
    expect(retokenizedRes.manifest?.sourceHash).not.toBe(auroraRes.manifest?.sourceHash);
  });

  it("compiles custom-paths with its custom outputRoot, layout paths, and policies", async () => {
    const input = loadFixtureInput("custom-paths");
    const config = loadFixtureProjectionConfig("custom-paths");

    const htmlRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "custom-html"
    );
    expect(htmlRes.status).toBe("succeeded");
    expect(htmlRes.plan?.creates).toContain("index.html");
    expect(htmlRes.manifest?.targetId).toBe("custom-html");

    const reactRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "custom-react"
    );
    expect(reactRes.status).toBe("succeeded");
    expect((reactRes.plan?.creates ?? []).length).toBeGreaterThan(0);
    expect(reactRes.manifest?.targetId).toBe("custom-react");

    // The declared file-layout options are configuration, so they surface in
    // the config hash without touching the source hash.
    const relaidOut = {
      ...config,
      targets: config.targets.map((t: any) =>
        t.id === "custom-html" ? { ...t, paths: { ...t.paths, entry: "app/preview/entry.html" } } : t
      ),
    };
    const relaidOutRes = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      relaidOut,
      "custom-html"
    );
    expect(relaidOutRes.status).toBe("succeeded");
    expect(relaidOutRes.manifest?.sourceHash).toBe(htmlRes.manifest?.sourceHash);
    expect(relaidOutRes.manifest?.configHash).not.toBe(htmlRes.manifest?.configHash);
  });
});
