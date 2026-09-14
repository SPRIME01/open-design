import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compile,
  planApplication,
  adapterRegistry,
  getFileHash,
  ApplicationCompilerInput,
  ConflictResolution,
  GeneratedFileSet,
} from "../src/index.js";
import { ReactViteAdapter } from "../../application-targets/src/frontend/react-vite/adapter.js";

/**
 * Conflict-resolution semantics for compile()/planApplication() (spec §10.6
 * rules, §13 recovery row "Generated-file conflict resolved through
 * retain-manual, regenerate, or explicitly approved force path", §14.4
 * `conflict_failure`). Vocabulary mapping between the schema enum and the
 * spec's recovery paths:
 *
 * - schema `block`     = spec default block (terminal `conflicted`, zero writes)
 * - schema `plan-only` = spec "retain-manual" (manual bytes kept, excluded
 *                        from the write set and from the manifest — ownership
 *                        is never taken)
 * - schema `force`     = spec "regenerate / explicitly approved force"
 *                        (compiler rewrites the file and reclaims ownership)
 *
 * The react-vite adapter is used because it emits several files whose
 * contents are deterministic: `index.html` is fully static (stable
 * regenerate target) and `src/App.tsx` embeds `bundle.name` (changes when
 * the IR is edited, exercising the "other files still write" path).
 */

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

const CONFLICTED_PATH = "index.html";
const IR_SENSITIVE_PATH = "src/App.tsx";
const MANUAL_SUFFIX = "\n<!-- manual edit -->";

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

function reactTargetConfig(conflictPolicy?: ConflictResolution) {
  return {
    schemaVersion: 1,
    application: "application.ir.json",
    targets: [
      {
        id: "react-target",
        adapter: "react-vite",
        mode: "scaffold" as const,
        outputRoot: "generated/conflict-react",
        frontend: {
          adapter: "react-vite",
        },
        ...(conflictPolicy ? { conflictPolicy } : {}),
      },
    ],
  };
}

/**
 * The compiler package is pure: compile() returns an in-memory file set and
 * never touches the filesystem. This helper mirrors the host-side write
 * contract — a host materializes a run's file set only when the run reached
 * `succeeded` — which is exactly the gate that makes `block` safe.
 */
function materializeIfSucceeded(
  root: string,
  res: { status: string; fileSet?: GeneratedFileSet }
): string[] {
  if (res.status !== "succeeded" || !res.fileSet) {
    return [];
  }
  const written: string[] = [];
  for (const file of res.fileSet.files) {
    const abs = path.join(root, file.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.content);
    written.push(file.path);
  }
  return written;
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

function readDisk(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

interface ConflictState {
  input: ApplicationCompilerInput;
  config: ReturnType<typeof reactTargetConfig>;
  tmpRoot: string;
  originalContent: string;
  manualContent: string;
  run1Manifest: Awaited<ReturnType<typeof compile>>["manifest"];
}

/**
 * Compile once (fresh), materialize like a host would, then manually edit a
 * compiler-owned file on disk. Every test starts from this state: the next
 * compile sees a CONFLICT_MODIFIED_GENERATED_FILE at CONFLICTED_PATH.
 */
async function setupManuallyEditedState(
  config: ReturnType<typeof reactTargetConfig> = reactTargetConfig(),
  input: ApplicationCompilerInput = loadFixtureInput("project-console")
): Promise<ConflictState> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "od-conflict-resolution-"));

  const res1 = await compile(
    input.bundle,
    input.domain,
    input.capabilities,
    input.boundary,
    input.persistence,
    input.frontend,
    config,
    "react-target"
  );
  expect(res1.status).toBe("succeeded");
  materializeIfSucceeded(tmpRoot, res1);

  const originalContent = readDisk(tmpRoot, CONFLICTED_PATH);
  const manualContent = originalContent + MANUAL_SUFFIX;
  fs.writeFileSync(path.join(tmpRoot, CONFLICTED_PATH), manualContent, "utf8");

  return { input, config, tmpRoot, originalContent, manualContent, run1Manifest: res1.manifest };
}

function cleanup(state: { tmpRoot: string }) {
  fs.rmSync(state.tmpRoot, { recursive: true, force: true });
}

describe("conflict resolution — compile()", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new ReactViteAdapter());
    } catch (e) {}
  });

  it("block (default): a manually-edited generated file blocks the recompile and nothing changes on disk", async () => {
    const state = await setupManuallyEditedState();

    const res = await compile(
      state.input.bundle,
      state.input.domain,
      state.input.capabilities,
      state.input.boundary,
      state.input.persistence,
      state.input.frontend,
      state.config,
      "react-target",
      {
        priorManifest: state.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(state.tmpRoot),
      }
    );

    expect(res.status).toBe("conflicted");
    expect(res.effectiveConflictResolution).toBe("block");
    expect(res.plan?.conflicts).toEqual([
      { path: CONFLICTED_PATH, classification: "CONFLICT_MODIFIED_GENERATED_FILE", resolution: "block" },
    ]);
    expect(res.plan?.retainedConflicts).toBeUndefined();

    // Host contract: a non-succeeded run is never materialized, so the disk
    // stays byte-identical to the manual edit.
    const written = materializeIfSucceeded(state.tmpRoot, res);
    expect(written).toEqual([]);
    expect(readDisk(state.tmpRoot, CONFLICTED_PATH)).toBe(state.manualContent);

    cleanup(state);
  });

  it("plan-only via option: manual edit survives byte-identical, other files still write, manifest never takes ownership", async () => {
    const state = await setupManuallyEditedState();

    // Edit the IR so a non-conflicting file also changes: bundle.name is
    // embedded in src/App.tsx, which becomes a legitimate MODIFY write while
    // index.html stays conflicted.
    const renamed: ApplicationCompilerInput = {
      ...state.input,
      bundle: { ...state.input.bundle, name: `${state.input.bundle.name} v2` },
    };

    const res = await compile(
      renamed.bundle,
      renamed.domain,
      renamed.capabilities,
      renamed.boundary,
      renamed.persistence,
      renamed.frontend,
      state.config,
      "react-target",
      {
        priorManifest: state.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(state.tmpRoot),
        conflictResolution: "plan-only",
      }
    );

    expect(res.status).toBe("succeeded");
    expect(res.effectiveConflictResolution).toBe("plan-only");
    expect(res.plan?.conflicts).toEqual([
      { path: CONFLICTED_PATH, classification: "CONFLICT_MODIFIED_GENERATED_FILE", resolution: "plan-only" },
    ]);
    expect(res.plan?.retainedConflicts).toEqual([CONFLICTED_PATH]);
    expect(
      res.diagnostics.some(d => d.code === "generated_file_conflict_retained" && d.severity === "advisory")
    ).toBe(true);

    // The write set excludes the retained path but still carries the
    // non-conflicting modify.
    const writePaths = res.fileSet?.files.map(f => f.path) ?? [];
    expect(writePaths).not.toContain(CONFLICTED_PATH);
    expect(writePaths).toContain(IR_SENSITIVE_PATH);

    const regeneratedAppTsx = res.fileSet?.files.find(f => f.path === IR_SENSITIVE_PATH)?.content;
    expect(regeneratedAppTsx).not.toBe(readDisk(state.tmpRoot, IR_SENSITIVE_PATH));

    materializeIfSucceeded(state.tmpRoot, res);
    expect(readDisk(state.tmpRoot, CONFLICTED_PATH)).toBe(state.manualContent);
    expect(readDisk(state.tmpRoot, IR_SENSITIVE_PATH)).toBe(regeneratedAppTsx);

    // The emitted manifest does not claim the retained path, so a later
    // compile (back on block) sees it as an unowned conflicting file again —
    // ownership was deliberately never taken.
    expect(res.manifest?.files[CONFLICTED_PATH]).toBeUndefined();
    expect(res.manifest?.files[IR_SENSITIVE_PATH]?.hash).toBe(getFileHash(regeneratedAppTsx ?? ""));

    const next = await compile(
      renamed.bundle,
      renamed.domain,
      renamed.capabilities,
      renamed.boundary,
      renamed.persistence,
      renamed.frontend,
      state.config,
      "react-target",
      {
        priorManifest: res.manifest ?? null,
        currentFilesFetcher: diskFetcher(state.tmpRoot),
      }
    );
    expect(next.status).toBe("conflicted");
    expect(next.plan?.conflicts.map(c => c.path)).toEqual([CONFLICTED_PATH]);

    cleanup(state);
  });

  it("plan-only via target config conflictPolicy: a pre-existing manual file at an emitted path is retained unowned", async () => {
    const input = loadFixtureInput("project-console");
    const config = reactTargetConfig("plan-only");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "od-conflict-config-planonly-"));

    // A manual file already sits at a path the plan wants to emit; there is
    // no prior manifest, so this is the CONFLICT_MANUAL_FILE flavor.
    fs.mkdirSync(tmpRoot, { recursive: true });
    const manualContent = "<!DOCTYPE html>\n<!-- entirely manual homepage -->\n";
    fs.writeFileSync(path.join(tmpRoot, CONFLICTED_PATH), manualContent, "utf8");

    const res = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      config,
      "react-target",
      { currentFilesFetcher: diskFetcher(tmpRoot) }
    );

    expect(res.status).toBe("succeeded");
    expect(res.effectiveConflictResolution).toBe("plan-only");
    expect(res.plan?.conflicts).toEqual([
      { path: CONFLICTED_PATH, classification: "CONFLICT_MANUAL_FILE", resolution: "plan-only" },
    ]);
    expect(res.manifest?.files[CONFLICTED_PATH]).toBeUndefined();

    materializeIfSucceeded(tmpRoot, res);
    expect(readDisk(tmpRoot, CONFLICTED_PATH)).toBe(manualContent);
    expect(fs.existsSync(path.join(tmpRoot, "package.json"))).toBe(true);

    // Next compile back on block: the manual file is still unowned and still
    // differs from the proposal, so the run conflicts again.
    const next = await compile(
      input.bundle,
      input.domain,
      input.capabilities,
      input.boundary,
      input.persistence,
      input.frontend,
      reactTargetConfig(),
      "react-target",
      {
        priorManifest: res.manifest ?? null,
        currentFilesFetcher: diskFetcher(tmpRoot),
      }
    );
    expect(next.status).toBe("conflicted");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("force via option: the manual edit is overwritten with deterministic regenerated content and ownership is reclaimed", async () => {
    const state = await setupManuallyEditedState();

    const res = await compile(
      state.input.bundle,
      state.input.domain,
      state.input.capabilities,
      state.input.boundary,
      state.input.persistence,
      state.input.frontend,
      state.config,
      "react-target",
      {
        priorManifest: state.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(state.tmpRoot),
        conflictResolution: "force",
      }
    );

    expect(res.status).toBe("succeeded");
    expect(res.effectiveConflictResolution).toBe("force");
    expect(res.plan?.conflicts).toEqual([
      { path: CONFLICTED_PATH, classification: "CONFLICT_MODIFIED_GENERATED_FILE", resolution: "force" },
    ]);
    expect(res.plan?.retainedConflicts).toBeUndefined();

    materializeIfSucceeded(state.tmpRoot, res);
    expect(readDisk(state.tmpRoot, CONFLICTED_PATH)).toBe(state.originalContent);
    expect(res.manifest?.files[CONFLICTED_PATH]?.hash).toBe(getFileHash(state.originalContent));

    // Ownership was reclaimed: a follow-up compile with no options is a
    // pure no-op (NO_CHANGE everywhere).
    const next = await compile(
      state.input.bundle,
      state.input.domain,
      state.input.capabilities,
      state.input.boundary,
      state.input.persistence,
      state.input.frontend,
      state.config,
      "react-target",
      {
        priorManifest: res.manifest ?? null,
        currentFilesFetcher: diskFetcher(state.tmpRoot),
      }
    );
    expect(next.status).toBe("succeeded");
    expect(next.plan?.creates).toEqual([]);
    expect(next.plan?.modifies).toEqual([]);
    expect(next.plan?.conflicts).toEqual([]);
    expect(next.plan?.reuses.length).toBe(res.fileSet?.files.length);

    cleanup(state);
  });

  it("force via target config conflictPolicy reclaims the same way", async () => {
    const state = await setupManuallyEditedState(reactTargetConfig("force"));

    const res = await compile(
      state.input.bundle,
      state.input.domain,
      state.input.capabilities,
      state.input.boundary,
      state.input.persistence,
      state.input.frontend,
      state.config,
      "react-target",
      {
        priorManifest: state.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(state.tmpRoot),
      }
    );

    expect(res.status).toBe("succeeded");
    expect(res.effectiveConflictResolution).toBe("force");
    materializeIfSucceeded(state.tmpRoot, res);
    expect(readDisk(state.tmpRoot, CONFLICTED_PATH)).toBe(state.originalContent);
    expect(res.manifest?.files[CONFLICTED_PATH]?.hash).toBe(getFileHash(state.originalContent));

    cleanup(state);
  });

  it("explicit option overrides the target config policy in both directions", async () => {
    // config force + option block -> conflicted, manual edit intact.
    const blockOverForce = await setupManuallyEditedState(reactTargetConfig("force"));
    const blocked = await compile(
      blockOverForce.input.bundle,
      blockOverForce.input.domain,
      blockOverForce.input.capabilities,
      blockOverForce.input.boundary,
      blockOverForce.input.persistence,
      blockOverForce.input.frontend,
      blockOverForce.config,
      "react-target",
      {
        priorManifest: blockOverForce.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(blockOverForce.tmpRoot),
        conflictResolution: "block",
      }
    );
    expect(blocked.status).toBe("conflicted");
    expect(blocked.effectiveConflictResolution).toBe("block");
    materializeIfSucceeded(blockOverForce.tmpRoot, blocked);
    expect(readDisk(blockOverForce.tmpRoot, CONFLICTED_PATH)).toBe(blockOverForce.manualContent);
    cleanup(blockOverForce);

    // config block + option force -> reclaims.
    const forceOverBlock = await setupManuallyEditedState(reactTargetConfig("block"));
    const forced = await compile(
      forceOverBlock.input.bundle,
      forceOverBlock.input.domain,
      forceOverBlock.input.capabilities,
      forceOverBlock.input.boundary,
      forceOverBlock.input.persistence,
      forceOverBlock.input.frontend,
      forceOverBlock.config,
      "react-target",
      {
        priorManifest: forceOverBlock.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(forceOverBlock.tmpRoot),
        conflictResolution: "force",
      }
    );
    expect(forced.status).toBe("succeeded");
    expect(forced.effectiveConflictResolution).toBe("force");
    materializeIfSucceeded(forceOverBlock.tmpRoot, forced);
    expect(readDisk(forceOverBlock.tmpRoot, CONFLICTED_PATH)).toBe(forceOverBlock.originalContent);
    cleanup(forceOverBlock);
  });
});

describe("conflict resolution — planApplication()", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new ReactViteAdapter());
    } catch (e) {}
  });

  it("surfaces effectiveConflictResolution and per-conflict resolution marks in all three modes", async () => {
    const state = await setupManuallyEditedState();
    const planOptions = (conflictResolution?: ConflictResolution) => ({
      priorManifest: state.run1Manifest ?? null,
      currentFilesFetcher: diskFetcher(state.tmpRoot),
      ...(conflictResolution ? { conflictResolution } : {}),
    });

    // block
    const blocked = await planApplication(state.input, state.config, "react-target", planOptions());
    expect(blocked.status).toBe("conflicted");
    expect(blocked.effectiveConflictResolution).toBe("block");
    expect(blocked.plan?.conflicts).toEqual([
      { path: CONFLICTED_PATH, classification: "CONFLICT_MODIFIED_GENERATED_FILE", resolution: "block" },
    ]);
    expect(blocked.plan?.retainedConflicts).toBeUndefined();
    expect(blocked.diagnostics).toEqual([]);

    // plan-only
    const retained = await planApplication(state.input, state.config, "react-target", planOptions("plan-only"));
    expect(retained.status).toBe("succeeded");
    expect(retained.effectiveConflictResolution).toBe("plan-only");
    expect(retained.plan?.conflicts[0]?.resolution).toBe("plan-only");
    expect(retained.plan?.retainedConflicts).toEqual([CONFLICTED_PATH]);
    expect(
      retained.diagnostics.some(d => d.code === "generated_file_conflict_retained" && d.severity === "advisory")
    ).toBe(true);

    // force
    const forced = await planApplication(state.input, state.config, "react-target", planOptions("force"));
    expect(forced.status).toBe("succeeded");
    expect(forced.effectiveConflictResolution).toBe("force");
    expect(forced.plan?.conflicts[0]?.resolution).toBe("force");
    expect(forced.plan?.retainedConflicts).toBeUndefined();

    // Planning is pure: none of the above touched the manually-edited disk.
    expect(readDisk(state.tmpRoot, CONFLICTED_PATH)).toBe(state.manualContent);

    cleanup(state);
  });

  it("derives the effective policy from the target config and lets an explicit option override it", async () => {
    const configPlanOnly = reactTargetConfig("plan-only");
    const state = await setupManuallyEditedState(configPlanOnly);

    const fromConfig = await planApplication(state.input, configPlanOnly, "react-target", {
      priorManifest: state.run1Manifest ?? null,
      currentFilesFetcher: diskFetcher(state.tmpRoot),
    });
    expect(fromConfig.effectiveConflictResolution).toBe("plan-only");
    expect(fromConfig.status).toBe("succeeded");

    const optionBeatsConfig = await planApplication(state.input, configPlanOnly, "react-target", {
      priorManifest: state.run1Manifest ?? null,
      currentFilesFetcher: diskFetcher(state.tmpRoot),
      conflictResolution: "block",
    });
    expect(optionBeatsConfig.effectiveConflictResolution).toBe("block");
    expect(optionBeatsConfig.status).toBe("conflicted");

    const configBlock = reactTargetConfig("block");
    const optionForceOverBlock = await planApplication(state.input, configBlock, "react-target", {
      priorManifest: state.run1Manifest ?? null,
      currentFilesFetcher: diskFetcher(state.tmpRoot),
      conflictResolution: "force",
    });
    expect(optionForceOverBlock.effectiveConflictResolution).toBe("force");
    expect(optionForceOverBlock.status).toBe("succeeded");

    cleanup(state);
  });
});

describe("conflict resolution — invariant", () => {
  beforeAll(() => {
    try {
      adapterRegistry.register(new ReactViteAdapter());
    } catch (e) {}
  });

  it("INVARIANT: no code path silently overwrites a manually-changed compiler-owned file without an explicit force", async () => {
    const nonForceModes: { label: string; config: ReturnType<typeof reactTargetConfig>; option?: ConflictResolution }[] = [
      { label: "default (no option, no config policy)", config: reactTargetConfig() },
      { label: "config block", config: reactTargetConfig("block") },
      { label: "option block", config: reactTargetConfig(), option: "block" },
      { label: "config plan-only", config: reactTargetConfig("plan-only") },
      { label: "option plan-only", config: reactTargetConfig(), option: "plan-only" },
    ];

    for (const mode of nonForceModes) {
      const state = await setupManuallyEditedState(mode.config);

      const res = await compile(
        state.input.bundle,
        state.input.domain,
        state.input.capabilities,
        state.input.boundary,
        state.input.persistence,
        state.input.frontend,
        state.config,
        "react-target",
        {
          priorManifest: state.run1Manifest ?? null,
          currentFilesFetcher: diskFetcher(state.tmpRoot),
          ...(mode.option ? { conflictResolution: mode.option } : {}),
        }
      );

      // Every non-force mode either refuses to write (block: conflicted) or
      // excludes the manual file from the write set (plan-only). Applying the
      // host write contract leaves the manual bytes untouched either way.
      if (res.status === "succeeded") {
        expect(res.effectiveConflictResolution, mode.label).toBe("plan-only");
        expect(res.fileSet?.files.map(f => f.path), mode.label).not.toContain(CONFLICTED_PATH);
      } else {
        expect(res.status, mode.label).toBe("conflicted");
      }
      materializeIfSucceeded(state.tmpRoot, res);
      expect(readDisk(state.tmpRoot, CONFLICTED_PATH), mode.label).toBe(state.manualContent);

      cleanup(state);
    }

    // Control: the explicit force path — and only it — overwrites the manual
    // edit with the deterministic regenerated content.
    const forced = await setupManuallyEditedState(reactTargetConfig("block"));
    const res = await compile(
      forced.input.bundle,
      forced.input.domain,
      forced.input.capabilities,
      forced.input.boundary,
      forced.input.persistence,
      forced.input.frontend,
      forced.config,
      "react-target",
      {
        priorManifest: forced.run1Manifest ?? null,
        currentFilesFetcher: diskFetcher(forced.tmpRoot),
        conflictResolution: "force",
      }
    );
    expect(res.status).toBe("succeeded");
    materializeIfSucceeded(forced.tmpRoot, res);
    expect(readDisk(forced.tmpRoot, CONFLICTED_PATH)).toBe(forced.originalContent);

    cleanup(forced);
  });
});
