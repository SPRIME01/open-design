import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { adapterRegistry, compile, CompileResult } from "@open-design/application-compiler";
import { CustomTxtAdapter } from "./fixtures/custom-adapter.js";

/**
 * Spec §13 recovery row: "Verification failure corrected without corrupting
 * prior evidence". The compiler package is pure and never executes
 * verification itself — the host does — so "prior evidence" at this layer is
 * the deterministic plan/manifest pair a compile returns. These tests prove:
 *
 *  1. a compile whose recorded verification step fails still succeeds through
 *     planning and returns complete plan/manifest evidence of what was
 *     attempted, byte-stable across recompiles of the same IR;
 *  2. correcting the step (same adapter identity, same IR, passing command)
 *     changes ONLY the step's command — manifest bytes and every other plan
 *     field, including the plan hash an approval binds, are untouched.
 */

const fixturesDir = path.join(import.meta.dirname, "../../application-ir/tests/fixtures");

const TARGET_ID = "custom-verify-target";

const config = {
  schemaVersion: 1,
  application: "application.ir.json",
  targets: [
    {
      id: TARGET_ID,
      adapter: "custom-txt",
      mode: "scaffold" as const,
      outputRoot: "generated/custom-verify-target",
      frontend: { adapter: "custom-txt" },
    },
  ],
};

/** Deterministic failing verification command (exit code 1). */
const FAILING_STEP = {
  name: "custom-verify",
  command: { executable: process.execPath, argv: ["-e", "process.exit(1)"] },
};

/** The corrected variant: same step name, deterministic success (exit code 0). */
const CORRECTED_STEP = {
  name: "custom-verify",
  command: { executable: process.execPath, argv: ["-e", "process.exit(0)"] },
};

type StepCommand = { executable: string; argv: string[] } | undefined;

/** Execute a recorded verification step the way a host would. */
function runRecordedStep(command: StepCommand): { success: boolean; output: string } {
  if (!command) {
    return { success: false, output: "no verification step was recorded" };
  }
  try {
    const stdout = execFileSync(command.executable, command.argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { success: true, output: stdout };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: message };
  }
}

function loadProjectConsoleIr() {
  const readJson = (...parts: string[]) =>
    JSON.parse(fs.readFileSync(path.join(fixturesDir, ...parts), "utf8"));
  return {
    bundle: readJson("valid", "project-console", "application.ir.json"),
    domain: readJson("valid", "project-console", "ir", "domain.ir.json"),
    capabilities: readJson("valid", "project-console", "ir", "capabilities.ir.json"),
    boundary: readJson("valid", "project-console", "ir", "boundary.ir.json"),
    persistence: readJson("valid", "project-console", "ir", "persistence.ir.json"),
    frontend: readJson("valid", "project-console", "ir", "frontend.ir.json"),
  };
}

/** Fresh compile: no prior manifest, explicit runId so plan bytes are comparable. */
async function compileFresh(runId: string): Promise<CompileResult> {
  const ir = loadProjectConsoleIr();
  return compile(
    ir.bundle,
    ir.domain,
    ir.capabilities,
    ir.boundary,
    ir.persistence,
    ir.frontend,
    config,
    TARGET_ID,
    { runId }
  );
}

describe("verification failure evidence (spec §13)", () => {
  let adapter: CustomTxtAdapter;

  beforeAll(() => {
    adapter = new CustomTxtAdapter({ verificationSteps: [FAILING_STEP] });
    adapterRegistry.register(adapter);
  });

  it("compiles through planning with a verification step that fails when executed", async () => {
    adapter.verificationSteps = [FAILING_STEP];
    const res = await compileFresh("run-verify-fail");

    expect(res.status).toBe("succeeded");
    expect(res.plan?.verificationPlanned).toEqual([FAILING_STEP]);
    expect(runRecordedStep(res.plan?.verificationPlanned[0]?.command).success).toBe(false);

    // Evidence of the attempt is complete independent of the outcome: the
    // manifest carries an ownership entry (hash + sourceIds) for every
    // emitted file, and the plan records exactly which command would run.
    const files = res.fileSet?.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(res.manifest?.files[file.path]?.hash).toBeTruthy();
      expect(res.manifest?.files[file.path]?.sourceIds).toEqual(file.sourceIds);
    }
    expect(res.plan?.estimatedOutputFiles).toEqual(files.map((f) => f.path));
  });

  it("reproduces byte-identical plan and manifest for the same IR", async () => {
    adapter.verificationSteps = [FAILING_STEP];
    const first = await compileFresh("run-verify-stable");
    const second = await compileFresh("run-verify-stable");

    expect(first.manifest).toBeDefined();
    expect(first.plan).toBeDefined();
    // Serialized the way the host persists them (JSON.stringify(_, null, 2)).
    expect(JSON.stringify(first.manifest, null, 2)).toBe(
      JSON.stringify(second.manifest, null, 2)
    );
    expect(JSON.stringify(first.plan, null, 2)).toBe(JSON.stringify(second.plan, null, 2));
  });

  it("a corrected step changes only the step outcome, not the plan or manifest", async () => {
    adapter.verificationSteps = [FAILING_STEP];
    const failing = await compileFresh("run-verify-corrected");
    expect(failing.status).toBe("succeeded");
    expect(runRecordedStep(failing.plan?.verificationPlanned[0]?.command).success).toBe(false);

    // Correction: the adapter's step now passes; adapter identity, IR, and
    // config are unchanged.
    adapter.verificationSteps = [CORRECTED_STEP];
    const corrected = await compileFresh("run-verify-corrected");
    expect(corrected.status).toBe("succeeded");

    // The manifest — what was written and owned — is byte-identical.
    expect(corrected.manifest).toBeDefined();
    expect(JSON.stringify(corrected.manifest, null, 2)).toBe(
      JSON.stringify(failing.manifest, null, 2)
    );

    // Every plan field except the recorded command is unchanged.
    const { verificationPlanned: failingSteps, ...failingRest } = failing.plan!;
    const { verificationPlanned: correctedSteps, ...correctedRest } = corrected.plan!;
    expect(correctedRest).toEqual(failingRest);
    expect(correctedSteps).toHaveLength(1);
    expect(correctedSteps[0]?.name).toBe(failingSteps[0]?.name);
    expect(correctedSteps[0]?.command).toEqual(CORRECTED_STEP.command);

    // The plan hash an approval binds is derived from the classification
    // fields only, so correcting verification never invalidates a prior
    // approval of the same work.
    expect(corrected.plan?.planHash).toBe(failing.plan?.planHash);

    // The corrected step actually passes when executed.
    expect(runRecordedStep(corrected.plan?.verificationPlanned[0]?.command).success).toBe(true);
  });
});
