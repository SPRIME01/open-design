import { Diagnostic, ProjectionConfig, validateBundle } from "@open-design/application-ir";
import { buildPlanHash } from "./plan.js";
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
  conflicts: { path: string; classification: string }[];
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

  const summary: Omit<CompilerPlanSummary, "planHash"> = {
    targetId: targetConfig.id,
    creates,
    modifies,
    deletes: [],
    reuses,
    conflicts,
    unresolved: adapterPlan.unresolved,
    degradations: adapterPlan.degradations,
    permissionsRequired: adapterPlan.permissions,
    commandsProposed: adapterPlan.commands,
    verificationPlanned: adapterPlan.verificationSteps,
  };

  const planHash = buildPlanHash(summary);
  const plan: CompilerPlanSummary = { ...summary, planHash };

  let status: PlanApplicationResult["status"] = "succeeded";
  if (plan.unresolved.length > 0) {
    status = "blocked";
  } else if (plan.conflicts.length > 0) {
    status = "conflicted";
  }

  return {
    status,
    diagnostics: [],
    plan,
    planHash,
  };
}
