import * as fs from "node:fs";
import * as path from "node:path";
import {
  compile,
  CompileResult,
  validateApplication,
  planApplication,
  PlanApplicationResult,
  ApplicationCompilerInput,
  resolveConflictResolution,
} from "@open-design/application-compiler";
import { computeSemanticHash } from "@open-design/application-ir";
import { registerAllBuiltInAdapters } from "@open-design/application-targets";
import { runPersistence } from "./run-persistence.js";
import { ProjectWriter } from "./project-writer.js";
import { runVerificationStep } from "./verification-runner.js";
import { logCompilerEvent, CompilerLogEvent, CompilerLogEventName } from "./run-logger.js";
import { runMetrics } from "./run-metrics.js";
import {
  CompilerConflictResolution,
  CompilerRunEvidenceRefs,
  CompilerRunStatus,
} from "@open-design/contracts";

registerAllBuiltInAdapters();

const runListeners = new Map<string, ((event: any) => void)[]>();

/**
 * projectRoot/targetId per run id. The run record (CompilerRunStatus) does not
 * carry them, but approval and cancel logs need the same §12.3 context the
 * in-flight run logs have. In-memory like the run store; never persisted.
 */
const runContexts = new Map<string, { projectRoot: string; targetId: string }>();

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

/**
 * Per-call options a run/plan accepts from `POST /api/compiler/runs` (and
 * the plan endpoint for `conflictResolution`). `conflictResolution` uses
 * the package precedence — request field > target config `conflictPolicy`
 * > `block`. `approvedPlanHash` is an inline approval: when the effective
 * resolution is `force` and this equals the plan hash the run computes,
 * the force gate passes without pausing.
 */
export interface CompilerRunOptions {
  conflictResolution?: CompilerConflictResolution;
  approvedPlanHash?: string;
}

/**
 * Effective conflict resolution for a run: request field > the target
 * config's `conflictPolicy` > `block`. Resolved against the same parsed
 * projection config the run compiles with, before any write can happen.
 */
function resolveRunConflictResolution(
  config: any,
  targetId: string,
  requestResolution: CompilerConflictResolution | undefined
): CompilerConflictResolution {
  const targetConfig = Array.isArray(config?.targets)
    ? config.targets.find((t: any) => t?.id === targetId)
    : undefined;
  const configPolicy =
    targetConfig && isConflictResolution(targetConfig.conflictPolicy)
      ? targetConfig.conflictPolicy
      : undefined;
  return resolveConflictResolution(requestResolution, configPolicy);
}

/** Narrow an untrusted value to the conflict-resolution vocabulary. */
export function isConflictResolution(value: unknown): value is CompilerConflictResolution {
  return value === "block" || value === "plan-only" || value === "force";
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
    runId = `run-${Date.now()}`,
    options: CompilerRunOptions = {}
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
    runContexts.set(runId, { projectRoot, targetId });
    logCompilerEvent({
      event: "run_created",
      compiler_run_id: runId,
      project_id: projectRoot,
      target_id: targetId,
      phase: "validation",
      ...(options.conflictResolution
        ? { conflict_resolution: options.conflictResolution }
        : {}),
      ...(options.approvedPlanHash ? { approved_plan_hash: options.approvedPlanHash } : {}),
    });

    // Run compile asynchronously
    this.executeRun(projectRoot, targetId, runId, options).catch(console.error);

    return status;
  },

  /**
   * Raw IR retrieval for MCP `get_application_ir`: returns the six raw JSON
   * documents exactly as the shared loader reads them (no validation, no
   * mutation), so a caller sees the same input a validate/plan/compile of
   * this project would operate on.
   */
  loadRaw(projectRoot: string) {
    const { input } = loadCompilerInput(projectRoot);
    return {
      bundle: input.bundle,
      modules: {
        domain: input.domain,
        capabilities: input.capabilities,
        boundary: input.boundary,
        persistence: input.persistence,
        frontend: input.frontend,
      },
    };
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
    targetId: string,
    options: Pick<CompilerRunOptions, "conflictResolution"> = {}
  ): Promise<PlanApplicationResult & { evidenceRefs: CompilerRunEvidenceRefs }> {
    const { input, config } = loadCompilerInput(projectRoot, targetId);
    const priorManifest = loadPriorManifest(projectRoot, targetId);
    const outputRoot = resolveOutputRoot(projectRoot, config, targetId);

    const result = await planApplication(input, config, targetId, {
      priorManifest,
      currentFilesFetcher: makeCurrentFilesFetcher(outputRoot),
      ...(options.conflictResolution
        ? { conflictResolution: options.conflictResolution }
        : {}),
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
   *
   * When the run is paused in `awaiting_approval` (a force-resolution run
   * gated before any write), a matching approval also RESUMES it: the run
   * is moved out of `awaiting_approval` synchronously — so a concurrent
   * approve cannot double-resume — and executeRun re-runs with the approval
   * inline. The re-run recomputes the gate hash, so if the disk changed
   * since the pause, the presented hash no longer matches and the run
   * re-gates with the fresh hash instead of overwriting under a stale
   * approval. Runs that already terminated keep the historical
   * idempotent-approve behavior (200, no resume).
   */
  approve(
    runId: string,
    planHash: string,
    options: { resolution?: "force" } = {}
  ): CompilerRunStatus {
    const run = runPersistence.get(runId);
    if (!run) {
      throw new CompilerServiceError("INPUT_NOT_FOUND", `Compiler run '${runId}' not found.`);
    }
    const ctx = runContexts.get(runId);
    const logApproval = (event: CompilerLogEventName, extra: Record<string, unknown> = {}) =>
      logCompilerEvent({
        event,
        compiler_run_id: runId,
        project_id: ctx?.projectRoot,
        target_id: ctx?.targetId,
        phase: "planning",
        ...extra,
      });
    logApproval("approval_requested", {
      plan_hash: planHash,
      ...(options.resolution ? { resolution: options.resolution } : {}),
    });
    if (!run.planHash || run.planHash !== planHash) {
      logApproval("approval_rejected", {
        plan_hash: planHash,
        diagnostic_code: "PLAN_HASH_MISMATCH",
      });
      throw new CompilerServiceError(
        "PLAN_HASH_MISMATCH",
        run.planHash
          ? `Plan hash mismatch for run '${runId}': planned ${run.planHash}, approval presented ${planHash}.`
          : `Compiler run '${runId}' has no stored plan hash to approve against yet.`
      );
    }

    const resume = run.status === "awaiting_approval" && ctx != null;
    run.approvedPlanHash = planHash;
    if (resume) {
      // Leave the pending state before dispatching so the status transition
      // itself is the double-resume guard for concurrent approvals. The
      // pause advisory is cleared: the resumed run reports its own phases.
      run.status = "queued";
      run.phase = "validation";
      run.progress = 0;
      run.diagnostics = [];
    }
    runPersistence.save(run);
    logApproval("approval_resolved", { plan_hash: planHash });
    this.emitEvent(runId, "approved", run);
    if (resume) {
      // The approval binds the pair {planHash, 'force'}: the resumed compile
      // runs with force passed per-call, so the explicit approval — not a
      // possibly-re-edited projection config — is what authorizes the
      // overwrite. executeRun re-runs the gate against the approved hash.
      this.executeRun(ctx!.projectRoot, ctx!.targetId, runId, {
        conflictResolution: "force",
        approvedPlanHash: planHash,
      }).catch(console.error);
    }
    return run;
  },

  /**
   * Mark a run cancelled. Preserves the historical last-writer-wins behavior
   * (the status is set even if the run already terminated); the metrics
   * terminal count and run_terminal log fire only for runs that were still
   * non-terminal, so a completed run cannot be counted twice.
   */
  cancel(runId: string): CompilerRunStatus {
    const run = runPersistence.get(runId);
    if (!run) {
      throw new CompilerServiceError("INPUT_NOT_FOUND", `Compiler run '${runId}' not found.`);
    }
    const wasTerminal =
      run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
    let recorded: Record<string, number> | undefined;
    if (!wasTerminal) {
      recorded = runMetrics.recordTerminal(runId, "cancelled");
      if (recorded && Object.keys(recorded).length > 0) {
        run.phaseDurationsMs = recorded;
      }
    }
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    runPersistence.save(run);
    this.emitEvent(runId, "cancelled", run);
    if (!wasTerminal) {
      const ctx = runContexts.get(runId);
      logCompilerEvent({
        event: "run_terminal",
        compiler_run_id: runId,
        project_id: ctx?.projectRoot,
        target_id: ctx?.targetId,
        phase: run.phase,
        terminal_status: "cancelled",
        duration_ms: Date.parse(run.completedAt) - Date.parse(run.startedAt),
        phase_durations_ms: recorded ?? {},
      });
    }
    return run;
  },

  async executeRun(
    projectRoot: string,
    targetId: string,
    runId: string,
    options: CompilerRunOptions = {}
  ) {
    const status = runPersistence.get(runId);
    if (!status) return;

    // §12.3 log context accumulated as the run learns it. Fields stay absent
    // until known (a failed-validation run never learns its hashes/adapters).
    const logCtx: Pick<
      CompilerLogEvent,
      "application_id" | "source_hash" | "config_hash" | "plan_hash" | "adapters"
    > = {};
    const log = (event: CompilerLogEventName, extra: Record<string, unknown> = {}) =>
      logCompilerEvent({
        event,
        compiler_run_id: runId,
        project_id: projectRoot,
        target_id: targetId,
        ...logCtx,
        ...extra,
      });

    const emitPhase = (phase: CompilerRunStatus["phase"], statusStr: CompilerRunStatus["status"], progress: number) => {
      status.phase = phase;
      status.status = statusStr;
      status.progress = progress;
      runPersistence.save(status);
      this.emitEvent(runId, "progress", status);
      runMetrics.beginPhase(runId, phase);
    };

    /**
     * Shared terminal tail: stamps status/completedAt, closes phase timings,
     * counts the terminal metric (once per run — runMetrics enforces it),
     * populates phaseDurationsMs on the run record, and emits the run_terminal
     * structured log line with terminal status, per-phase durations, and the
     * first diagnostic code when the run failed.
     */
    const finishRun = (
      terminal: "failed" | "succeeded",
      diagnostics?: CompilerRunStatus["diagnostics"]
    ) => {
      status.status = terminal;
      if (diagnostics) {
        status.diagnostics = diagnostics;
      }
      status.completedAt = new Date().toISOString();
      const recorded = runMetrics.recordTerminal(runId, terminal, targetId);
      if (recorded && Object.keys(recorded).length > 0) {
        status.phaseDurationsMs = recorded;
      }
      log("run_terminal", {
        terminal_status: terminal,
        phase: diagnostics?.[0]?.phase ?? status.phase,
        diagnostic_code: diagnostics?.[0]?.code,
        duration_ms: Date.parse(status.completedAt) - Date.parse(status.startedAt),
        phase_durations_ms: recorded ?? {},
      });
    };

    try {
      emitPhase("validation", "validating", 10);

      const { input, config } = loadCompilerInput(projectRoot, targetId);
      const priorManifest = loadPriorManifest(projectRoot, targetId);
      if (typeof input.bundle?.applicationId === "string") {
        logCtx.application_id = input.bundle.applicationId;
      }
      // Same hash function compile() uses for manifest.configHash, so the log
      // lines agree with the emitted manifest on every run that gets one.
      logCtx.config_hash = computeSemanticHash(config);
      runMetrics.endPhase(runId, "validation");
      log("validation_completed", { phase: "validation" });

      const outputRoot = resolveOutputRoot(projectRoot, config, targetId);
      const currentFilesFetcher = makeCurrentFilesFetcher(outputRoot);

      // Force-approval gate (spec §10.6/§13: force is never automatic).
      // Whenever the effective resolution for this run would be 'force' —
      // from the request OR merely from the projection config — the daemon
      // must not write. Plan the run with that resolution first (the hash
      // is what an approval presents back); without a matching
      // approvedPlanHash the run pauses in 'awaiting_approval' before any
      // compile or write. 'block' and 'plan-only' never gate. The plan hash
      // does not encode the resolution, so the approval binds the PAIR
      // {planHash, effectiveConflictResolution}: resume passes force
      // explicitly, and the approve request names resolution:'force'.
      const effectiveResolution = resolveRunConflictResolution(
        config,
        targetId,
        options.conflictResolution
      );
      if (effectiveResolution === "force") {
        const gatePlan = await planApplication(input, config, targetId, {
          priorManifest,
          currentFilesFetcher,
          conflictResolution: effectiveResolution,
        });
        const computedPlanHash = gatePlan.planHash;
        if (computedPlanHash && options.approvedPlanHash !== computedPlanHash) {
          // Pause for approval: not failed, no compile, no writes. The run
          // carries the computed hash and an advisory saying how to approve.
          status.planHash = computedPlanHash;
          status.phase = "planning";
          status.progress = 50;
          status.status = "awaiting_approval";
          status.diagnostics = [
            {
              code: "approval_required",
              message: `Conflict resolution 'force' would overwrite manually-changed generated file(s). The run paused before writing; approve plan hash ${computedPlanHash} to proceed.`,
              severity: "advisory",
              phase: "planning",
              recommendedAction: `od app approve ${runId} --plan-hash ${computedPlanHash} --resolution force`,
            },
          ];
          runPersistence.save(status);
          log("approval_requested", {
            phase: "planning",
            plan_hash: computedPlanHash,
            conflict_resolution: effectiveResolution,
          });
          this.emitEvent(runId, "awaiting_approval", status);
          return;
        }
        if (computedPlanHash) {
          // Inline approval: the create request already carried the hash the
          // run computed under this resolution — the gate passes.
          status.approvedPlanHash = computedPlanHash;
          runPersistence.save(status);
        }
      }

      emitPhase("lowering", "lowering", 30);
      log("lowering_started", { phase: "lowering" });

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
          // Effective resolution resolved above (request > config > block);
          // passed per-call so a resumed force run keeps its approved force
          // authority even if the config changed since the pause.
          conflictResolution: effectiveResolution,
        }
      );
      runMetrics.endPhase(runId, "lowering");
      logCtx.source_hash = compileRes.manifest?.sourceHash;
      logCtx.plan_hash = compileRes.plan?.planHash;
      logCtx.adapters = compileRes.plan?.adapterVersions;
      log("lowering_completed", { phase: "lowering" });

      if (compileRes.status === "failed-validation" || compileRes.status === "failed-lowering" || compileRes.status === "failed-planning") {
        const diagnostics = compileRes.diagnostics.map((d: any) => ({
          ...d,
          phase: d.phase as any,
          severity: d.severity as any,
        }));
        finishRun("failed", diagnostics);
        writeRunDiagnostics(projectRoot, runId, status);
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // Phase: Planning — the plan exists now; evaluating it (blocked /
      // conflicted decisions, hash exposure for approval) is this phase.
      emitPhase("planning", "planning", 50);

      if (compileRes.plan) {
        runMetrics.recordPlanObservations(compileRes.plan);
        log("plan_created", {
          phase: "planning",
          conflict_count: compileRes.plan.conflicts.length,
          degradation_count: compileRes.plan.degradations.length,
          noop:
            compileRes.plan.creates.length === 0 &&
            compileRes.plan.modifies.length === 0 &&
            compileRes.plan.deletes.length === 0,
          files_planned: compileRes.plan.estimatedOutputFiles.length,
        });
      }

      // If planning succeeded, but blocked or conflicted, we report it
      if (compileRes.status === "blocked" || compileRes.status === "conflicted") {
        finishRun("failed", [
          {
            code: compileRes.status === "blocked" ? "unresolved_references" : "file_conflicts",
            message: `Compile blocked: ${compileRes.status === "blocked" ? "Unresolved references in adapters." : "Unresolved conflicts in manual files."}`,
            severity: "error",
            phase: "planning",
          }
        ]);
        writeRunDiagnostics(projectRoot, runId, status);
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }
      runMetrics.endPhase(runId, "planning");

      // Phase: Writing files
      emitPhase("write", "writing", 60);
      const writer = new ProjectWriter(outputRoot);
      writer.stageAndWrite(compileRes.fileSet!.files);

      // Save manifest and plan to outputRoot
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.writeFileSync(path.join(outputRoot, "manifest.json"), JSON.stringify(compileRes.manifest, null, 2), "utf8");
      fs.writeFileSync(path.join(outputRoot, "plan.json"), JSON.stringify(compileRes.plan, null, 2), "utf8");
      runMetrics.endPhase(runId, "write");
      log("write_committed", {
        phase: "write",
        files_written: compileRes.fileSet!.files.length,
      });

      // Phase: Verification
      emitPhase("verification", "verifying", 80);
      let verifySuccess = true;
      const verifyOutputLogs: string[] = [];

      if (compileRes.plan?.verificationPlanned) {
        for (const step of compileRes.plan.verificationPlanned) {
          const stepRes = await runVerificationStep(step.name, step.command, outputRoot, {
            runId,
            projectId: projectRoot,
            targetId,
          });
          verifyOutputLogs.push(stepRes.output);
          if (!stepRes.success) {
            verifySuccess = false;
            runMetrics.recordVerificationFailure(step.name);
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
      runMetrics.endPhase(runId, "verification");

      if (!verifySuccess) {
        finishRun("failed", [
          {
            code: "verification_failed",
            message: `One or more verification steps failed. Output logs:\n${verifyOutputLogs.join("\n")}`,
            severity: "error",
            phase: "verification",
          }
        ]);
        writeRunDiagnostics(projectRoot, runId, status);
        runPersistence.save(status);
        this.emitEvent(runId, "failure", status);
        return;
      }

      // Succeeded!
      status.phase = "idle";
      status.progress = 100;
      if (compileRes.plan?.planHash) {
        status.planHash = compileRes.plan.planHash;
      }
      finishRun("succeeded");
      runPersistence.save(status);
      this.emitEvent(runId, "success", status);

    } catch (err: any) {
      finishRun("failed", [
        {
          code: "unexpected_error",
          message: `Unexpected compilation error: ${err.message}`,
          severity: "error",
          phase: (status.phase === "idle" ? "validation" : status.phase) as any,
        }
      ]);
      try {
        writeRunDiagnostics(projectRoot, runId, status);
      } catch (_) {}
      runPersistence.save(status);
      this.emitEvent(runId, "failure", status);
    }
  }
};
