import { Diagnostic, ProjectionConfig, validateBundle } from "@open-design/application-ir";
import { buildPlanHash } from "./plan.js";
import { ConflictResolution, PlanConflictEntry, resolveConflictResolution } from "./conflict.js";
import { GeneratedFileManifest } from "./manifest.js";
import { prepareAdapterPlan, classifyPlanFiles, ApplicationCompilerInput } from "./prepare.js";

export type { ApplicationCompilerInput };

/**
 * Structurally identical to `CompilerValidationResult` in
 * `@open-design/contracts` (src/api/compiler.ts); the two packages do not
 * depend on each other, so keep the shapes in sync when either changes.
 */
export interface CompilerValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Structurally identical to `CompilerPlanSummary` in
 * `@open-design/contracts` (src/api/compiler.ts); keep the shapes in sync.
 */
export interface CompilerPlanSummary {
  planHash: string;
  targetId: string;
  creates: string[];
  modifies: string[];
  deletes: string[];
  reuses: string[];
  /** Per-conflict treatment under the run's effective policy (mirrors contracts' conflicts element). */
  conflicts: PlanConflictEntry[];
  /** Paths retained unchanged under conflict policy 'plan-only'; present only when at least one conflict was retained. */
  retainedConflicts?: string[];
  unresolved: string[];
  degradations: string[];
  permissionsRequired: string[];
  commandsProposed: { executable: string; argv: string[] }[];
  verificationPlanned: { name: string; command: { executable: string; argv: string[] } }[];
}

/**
 * Validate-only entry point: runs schema validation plus cross-reference
 * resolution over an already-loaded bundle. Pure — no lowering, no
 * projection, no writes, no filesystem access.
 */
export function validateApplication(input: ApplicationCompilerInput): CompilerValidationResult {
  const valRes = validateBundle(input.bundle, input.domain, input.capabilities, input.boundary, input.persistence, input.frontend);
  return {
    valid: valRes.diagnostics.length === 0,
    diagnostics: valRes.diagnostics,
  };
}

export interface PlanApplicationOptions {
  priorManifest?: GeneratedFileManifest | null;
  currentFilesFetcher?: (path: string) => { exists: boolean; content: string | null };
  /**
   * Explicit per-call conflict resolution; beats the target config's
   * `conflictPolicy`. Same precedence and semantics as compile()'s option.
   */
  conflictResolution?: ConflictResolution;
}

export type PlanApplicationStatus =
  | "succeeded"
  | "blocked"
  | "conflicted"
  | "failed-validation"
  | "failed-lowering"
  | "failed-planning";

export interface PlanApplicationResult {
  status: PlanApplicationStatus;
  diagnostics: Diagnostic[];
  plan?: CompilerPlanSummary;
  planHash?: string;
  /**
   * The conflict policy this plan actually applied (explicit per-call
   * `conflictResolution` option > target config `conflictPolicy` > 'block').
   * Surfaced so callers can bind approvals to the exact resolution a plan
   * would execute. Present whenever a plan was produced; absent on early
   * validation / lowering / planning failures.
   */
  effectiveConflictResolution?: ConflictResolution;
}

/**
 * Plan-only entry point: runs validate → resolve → normalize → lower → plan
 * (through prepareAdapterPlan) and stops BEFORE projection/write. The
 * returned hash is computed by the same buildPlanHash compile() uses, so a
 * plan accepted here hashes identically to the run compile() later executes
 * against the same disk state. Pure — the output root is never touched; the
 * optional currentFilesFetcher is the only way disk state enters the result.
 */
export async function planApplication(
  input: ApplicationCompilerInput,
  config: ProjectionConfig,
  targetId: string,
  options?: PlanApplicationOptions
): Promise<PlanApplicationResult> {
  const prepared = await prepareAdapterPlan(input, config, targetId, options?.priorManifest);
  if (!prepared.ok) {
    return {
      status: prepared.status,
      diagnostics: prepared.diagnostics,
    };
  }

  const { targetConfig, adapterPlan } = prepared;

  // Conflict classification over the planned files (no emission, no writes).
  const fetcher = options?.currentFilesFetcher || (() => ({ exists: false, content: null }));
  const { creates, modifies, reuses, conflicts } = classifyPlanFiles(adapterPlan.files, options?.priorManifest || null, fetcher);

  // Same conflict-resolution precedence as compile(): explicit per-call
  // option > target config conflictPolicy > 'block'. 'plan-only' and
  // 'force' resolve the conflicts (retained or reclaimed) instead of
  // surfacing them as terminal; the per-conflict marks below say which.
  const effectiveResolution = resolveConflictResolution(options?.conflictResolution, targetConfig.conflictPolicy);
  const annotatedConflicts: PlanConflictEntry[] = conflicts.map(c => ({ ...c, resolution: effectiveResolution }));

  let retainedConflicts: string[] | undefined;
  let diagnostics: Diagnostic[] = [];
  if (effectiveResolution === "plan-only" && conflicts.length > 0) {
    retainedConflicts = conflicts.map(c => c.path).sort();
    diagnostics = [
      {
        code: "generated_file_conflict_retained",
        message: `Conflict policy 'plan-only' retained ${retainedConflicts.length} manually-changed file(s) unchanged: ${retainedConflicts.join(", ")}`,
        severity: "advisory",
        phase: "planning",
        recommendedAction: "Rerun with conflictResolution 'force' to reclaim compiler ownership, or remove/revert the manual file.",
      },
    ];
  }

  const summary: Omit<CompilerPlanSummary, "planHash"> = {
    targetId: targetConfig.id,
    creates,
    modifies,
    deletes: [],
    reuses,
    conflicts: annotatedConflicts,
    unresolved: adapterPlan.unresolved,
    degradations: adapterPlan.degradations,
    permissionsRequired: adapterPlan.permissions,
    commandsProposed: adapterPlan.commands,
    verificationPlanned: adapterPlan.verificationSteps,
  };
  if (retainedConflicts) {
    summary.retainedConflicts = retainedConflicts;
  }

  const planHash = buildPlanHash(summary);
  const plan: CompilerPlanSummary = { ...summary, planHash };

  // Status precedence matches compile(): unresolved capabilities dominate;
  // conflicts only terminalize the plan under 'block'.
  let status: PlanApplicationResult["status"] = "succeeded";
  if (plan.unresolved.length > 0) {
    status = "blocked";
  } else if (plan.conflicts.length > 0 && effectiveResolution === "block") {
    status = "conflicted";
  }

  return {
    status,
    diagnostics,
    plan,
    planHash,
    effectiveConflictResolution: effectiveResolution,
  };
}
