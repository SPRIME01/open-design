import * as fs from "node:fs";
import * as path from "node:path";
import {
  compile,
  CompileResult,
  validateApplication,
  planApplication,
  PlanApplicationResult,
  ApplicationCompilerInput,
} from "@open-design/application-compiler";
import { registerAllBuiltInAdapters } from "@open-design/application-targets";
import { runPersistence } from "./run-persistence.js";
import { ProjectWriter } from "./project-writer.js";
import { runVerificationStep } from "./verification-runner.js";
import { CompilerRunEvidenceRefs, CompilerRunStatus } from "@open-design/contracts";

registerAllBuiltInAdapters();

const runListeners = new Map<string, ((event: any) => void)[]>();

export type CompilerServiceErrorCode = "INPUT_NOT_FOUND" | "PLAN_HASH_MISMATCH";

/**
 * Typed compiler-service failure the routes map onto a concrete HTTP status:
 * INPUT_NOT_FOUND → 404 NOT_FOUND, PLAN_HASH_MISMATCH → 409 PLAN_HASH_MISMATCH.
 * Anything else stays a plain Error and surfaces as 500 INTERNAL.
 */
export class CompilerServiceError extends Error {
  constructor(readonly code: CompilerServiceErrorCode, message: string) {
    super(message);
    this.name = "CompilerServiceError";
  }
}

/** Filesystem-safe timestamp for evidence file names (2026-09-13T10-30-00-000Z). */
function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function requireExistingProjectRoot(projectRoot: string): void {
  if (typeof projectRoot !== "string" || !projectRoot || !fs.existsSync(projectRoot)) {
    throw new CompilerServiceError("INPUT_NOT_FOUND", `projectRoot '${projectRoot}' does not exist.`);
  }
}

interface LoadedCompilerInput {
  /** The six raw IR documents, ready for compile/validateApplication/planApplication. */
  input: ApplicationCompilerInput;
  /** Parsed projection.config.json, or the single-target fallback startRun has always used. */
  config: any;
}

/**
 * Shared disk loader for every compiler capability: startRun, validate, and
 * plan all read the same raw docs so a validation verdict, a plan hash, and a
 * compile run can never disagree about what the project contains.
 */
function loadCompilerInput(projectRoot: string, targetId?: string): LoadedCompilerInput {
  requireExistingProjectRoot(projectRoot);

  // By convention, the bundle resides in projectRoot/application.ir.json and
  // its modules under projectRoot/ir/ (or wherever bundle.modules points).
  const appIrPath = path.join(projectRoot, "application.ir.json");
  if (!fs.existsSync(appIrPath)) {
    throw new CompilerServiceError("INPUT_NOT_FOUND", `application.ir.json not found at ${appIrPath}`);
  }

  const bundleRaw = JSON.parse(fs.readFileSync(appIrPath, "utf8"));
  const getModuleRaw = (relPath: string) => {
    const fullPath = path.resolve(projectRoot, relPath);
    if (!fs.existsSync(fullPath)) return {};
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  };

  const input: ApplicationCompilerInput = {
    bundle: bundleRaw,
    domain: getModuleRaw(bundleRaw.modules?.domain || "ir/domain.ir.json"),
    capabilities: getModuleRaw(bundleRaw.modules?.capabilities || "ir/capabilities.ir.json"),
    boundary: getModuleRaw(bundleRaw.modules?.boundary || "ir/boundary.ir.json"),
    persistence: getModuleRaw(bundleRaw.modules?.persistence || "ir/persistence.ir.json"),
    frontend: getModuleRaw(bundleRaw.modules?.frontend || "ir/frontend.ir.json"),
  };

  // Load projection config. Without one, fall back to the same single html-static
  // target startRun has always synthesized (targetId-scoped when known).
  const projConfigPath = path.join(projectRoot, "projection.config.json");
  const config = fs.existsSync(projConfigPath)
    ? JSON.parse(fs.readFileSync(projConfigPath, "utf8"))
    : {
        schemaVersion: 1,
        application: "application.ir.json",
        targets: targetId
          ? [
              {
                id: targetId,
                adapter: "html-static",
                mode: "scaffold",
                outputRoot: "generated/html-static",
                frontend: { adapter: "html-static" }
              }
            ]
          : []
      };

  return { input, config };
}

function resolveOutputRoot(projectRoot: string, config: any, targetId: string): string {
  const targetConfig = config.targets.find((t: any) => t.id === targetId);
  return targetConfig
    ? path.resolve(projectRoot, targetConfig.outputRoot)
    : path.resolve(projectRoot, "generated", targetId);
}

function loadPriorManifest(projectRoot: string, targetId: string): any | null {
  const manifestPath = path.join(projectRoot, "generated", targetId, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (_) {}
  }
  return null;
}

function makeCurrentFilesFetcher(outputRoot: string) {
  return (rel: string) => {
    const full = path.resolve(outputRoot, rel);
    const exists = fs.existsSync(full);
    return {
      exists,
      content: exists ? fs.readFileSync(full, "utf8") : null,
    };
  };
}

/**
 * Persist a run's diagnostics under `<projectRoot>/compiler/diagnostics/` and
 * record the path on the run's evidenceRefs. Spec §6 project layout:
 * `compiler/diagnostics/<run-id>.diagnostics.json`.
 */
function writeRunDiagnostics(projectRoot: string, runId: string, status: CompilerRunStatus): string {
  const dir = path.join(projectRoot, "compiler", "diagnostics");
  fs.mkdirSync(dir, { recursive: true });
  const diagnosticsPath = path.join(dir, `${runId}.diagnostics.json`);
  fs.writeFileSync(
    diagnosticsPath,
    JSON.stringify({ runId, status: status.status, diagnostics: status.diagnostics }, null, 2),
    "utf8"
  );
  status.evidenceRefs = { ...status.evidenceRefs, diagnosticsPath };
  return diagnosticsPath;
}

export const compilerService = {
  getListeners(runId: string) {
    if (!runListeners.has(runId)) {
      runListeners.set(runId, []);
    }
    return runListeners.get(runId)!;
  },

  emitEvent(runId: string, type: string, data: any) {
    const listeners = this.getListeners(runId);
    for (const listener of listeners) {
      listener({ type, data });
    }
  },

  async startRun(
    projectRoot: string,
    targetId: string,
    runId = `run-${Date.now()}`
  ): Promise<CompilerRunStatus> {
    const startedAt = new Date().toISOString();
    const status: CompilerRunStatus = {
      runId,
      status: "queued",
      phase: "validation",
      progress: 0,
      diagnostics: [],
      startedAt,
    };
    runPersistence.save(status);

    // Run compile asynchronously
    this.executeRun(projectRoot, targetId, runId).catch(console.error);

    return status;
  },

  /**
   * Validate-only: runs the compiler's validation pass over the project's raw
   * IR docs and persists the diagnostics under compiler/diagnostics/. Never
   * writes to generated/ — an invalid project is not a transport error, so
   * the route serves validation verdicts as 200, not 4xx.
   */
  async validate(projectRoot: string) {
    const { input } = loadCompilerInput(projectRoot);
    const result = validateApplication(input);

    const diagnosticsDir = path.join(projectRoot, "compiler", "diagnostics");
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    const diagnosticsPath = path.join(diagnosticsDir, `validate-${timestampId()}.json`);
    fs.writeFileSync(diagnosticsPath, JSON.stringify(result, null, 2), "utf8");

    return { ...result, diagnosticsPath };
  },

  /**
   * Plan-only: runs validate → resolve → normalize → lower → plan and stops
   * before projection/write. The hash is computed by the same buildPlanHash
   * compile() uses, so approving this hash binds the caller to exactly the
   * plan a later compile of the same disk state would execute. The plan
   * summary is persisted under compiler/plans/ and referenced by evidenceRefs.
   * No writes to generated/.
   */
  async plan(
    projectRoot: string,
    targetId: string
  ): Promise<PlanApplicationResult & { evidenceRefs: CompilerRunEvidenceRefs }> {
    const { input, config } = loadCompilerInput(projectRoot, targetId);
    const priorManifest = loadPriorManifest(projectRoot, targetId);
    const outputRoot = resolveOutputRoot(projectRoot, config, targetId);

    const result = await planApplication(input, config, targetId, {
      priorManifest,
      currentFilesFetcher: makeCurrentFilesFetcher(outputRoot),
    });

    const plansDir = path.join(projectRoot, "compiler", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, `plan-${timestampId()}.json`);
    fs.writeFileSync(planPath, JSON.stringify(result, null, 2), "utf8");

    return { ...result, evidenceRefs: { planPath } };
  },

  /**
   * Approve a run's plan hash. The approval is only valid against the hash the
   * run actually planned; anything else is a PLAN_HASH_MISMATCH (HTTP 409).
   * On success the run is marked approved (approvedPlanHash, in memory via
   * runPersistence) and an 'approved' SSE event is emitted.
   */
  approve(runId: string, planHash: string): CompilerRunStatus {
    const run = runPersistence.get(runId);
    if (!run) {
      throw new CompilerServiceError("INPUT_NOT_FOUND", `Compiler run '${runId}' not found.`);
    }
    if (!run.planHash || run.planHash !== planHash) {
      throw new CompilerServiceError(
        "PLAN_HASH_MISMATCH",
        run.planHash
          ? `Plan hash mismatch for run '${runId}': planned ${run.planHash}, approval presented ${planHash}.`
          : `Compiler run '${runId}' has no stored plan hash to approve against yet.`
      );
    }
    run.approvedPlanHash = planHash;
    runPersistence.save(run);
    this.emitEvent(runId, "approved", run);
    return run;
  },

  async executeRun(projectRoot: string, targetId: string, runId: string) {
    const status = runPersistence.get(runId);
    if (!status) return;

    const emitPhase = (phase: CompilerRunStatus["phase"], statusStr: CompilerRunStatus["status"], progress: number) => {
      status.phase = phase;
      status.status = statusStr;
      status.progress = progress;
      runPersistence.save(status);
      this.emitEvent(runId, "progress", status);
    };

    try {
      emitPhase("validation", "validating", 10);

      const { input, config } = loadCompilerInput(projectRoot, targetId);
      const priorManifest = loadPriorManifest(projectRoot, targetId);

      emitPhase("lowering", "lowering", 30);

      const outputRoot = resolveOutputRoot(projectRoot, config, targetId);
      const currentFilesFetcher = makeCurrentFilesFetcher(outputRoot);

      const compileRes = await compile(
        input.bundle,
        input.domain,
        input.capabilities,
        input.boundary,
        input.persistence,
        input.frontend,
        config,
        targetId,
        {
          runId,
          priorManifest,
          currentFilesFetcher,
        }
      );

      if (compileRes.status === "failed-validation" || compileRes.status === "failed-lowering" || compileRes.status === "failed-planning") {
        status.status = "failed";
        status.diagnostics = compileRes.diagnostics.map((d: any) => ({
          ...d,
          phase: d.phase as any,
          severity: d.severity as any,
        }));
        status.completedAt = new Date().toISOString();
        writeRunDiagnostics(projectRoot, runId, status);
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // If planning succeeded, but blocked or conflicted, we report it
      if (compileRes.status === "blocked" || compileRes.status === "conflicted") {
        status.status = "failed";
        if (compileRes.plan?.planHash) {
          status.planHash = compileRes.plan.planHash;
        }
        status.diagnostics = [
          {
            code: compileRes.status === "blocked" ? "unresolved_references" : "file_conflicts",
            message: `Compile blocked: ${compileRes.status === "blocked" ? "Unresolved references in adapters." : "Unresolved conflicts in manual files."}`,
            severity: "error",
            phase: "planning",
          }
        ];
        status.completedAt = new Date().toISOString();
        writeRunDiagnostics(projectRoot, runId, status);
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // Phase: Writing files
      emitPhase("write", "writing", 60);
      const writer = new ProjectWriter(outputRoot);
      writer.stageAndWrite(compileRes.fileSet!.files);

      // Save manifest and plan to outputRoot
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "manifest.json"), JSON.stringify(compileRes.manifest, null, 2), "utf8");
      fs.writeFileSync(path.join(outputRoot, "plan.json"), JSON.stringify(compileRes.plan, null, 2), "utf8");

      // Phase: Verification
      emitPhase("verification", "verifying", 80);
      let verifySuccess = true;
      const verifyOutputLogs: string[] = [];

      if (compileRes.plan?.verificationPlanned) {
        for (const step of compileRes.plan.verificationPlanned) {
          const stepRes = await runVerificationStep(step.name, step.command, outputRoot);
          verifyOutputLogs.push(stepRes.output);
          if (!stepRes.success) {
            verifySuccess = false;
          }
        }
      }

      // Persist verification evidence under compiler/evidence/ (spec §6 layout)
      // and reference the run's actual write locations from evidenceRefs.
      const evidenceDir = path.join(projectRoot, "compiler", "evidence");
      fs.mkdirSync(evidenceDir, { recursive: true });
      const evidencePath = path.join(evidenceDir, `${runId}.verification.json`);
      fs.writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            runId,
            logs: verifyOutputLogs,
            filesEmitted: compileRes.fileSet!.files.map((f: any) => f.path),
            verificationOutput: verifyOutputLogs.join("\n"),
          },
          null,
          2
        ),
        "utf8"
      );
      status.evidenceRefs = {
        ...status.evidenceRefs,
        planPath: path.join(outputRoot, "plan.json"),
        manifestPath: path.join(outputRoot, "manifest.json"),
        evidencePath,
      };

      if (!verifySuccess) {
        status.status = "failed";
        status.diagnostics = [
          {
            code: "verification_failed",
            message: `One or more verification steps failed. Output logs:\n${verifyOutputLogs.join("\n")}`,
            severity: "error",
            phase: "verification",
          }
        ];
        status.completedAt = new Date().toISOString();
        writeRunDiagnostics(projectRoot, runId, status);
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // Succeeded!
      status.status = "succeeded";
      status.phase = "idle";
      status.progress = 100;
      if (compileRes.plan?.planHash) {
        status.planHash = compileRes.plan.planHash;
      }
      status.completedAt = new Date().toISOString();
      runPersistence.save(status);
      this.emitEvent(runId, "success", status);

    } catch (err: any) {
      status.status = "failed";
      status.diagnostics = [
        {
          code: "unexpected_error",
          message: `Unexpected compilation error: ${err.message}`,
          severity: "error",
          phase: (status.phase === "idle" ? "validation" : status.phase) as any,
        }
      ];
      status.completedAt = new Date().toISOString();
      try {
        writeRunDiagnostics(projectRoot, runId, status);
      } catch (_) {}
      runPersistence.save(status);
      this.emitEvent(runId, "failure", status);
    }
  }
};
