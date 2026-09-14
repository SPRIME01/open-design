import {
  Diagnostic,
  ProjectionConfig
} from "@open-design/application-ir";
import { CompilePlan, buildPlanHash } from "./plan.js";
import { GeneratedFileSet } from "./adapter-contract.js";
import { ConflictResolution, PlanConflictEntry, getFileHash, resolveConflictResolution } from "./conflict.js";
import { GeneratedFileManifest } from "./manifest.js";
import { computeSemanticHash } from "@open-design/application-ir";
import { prepareAdapterPlan, classifyPlanFiles } from "./prepare.js";

export interface CompileResult {
  status:
    | "succeeded"
    | "blocked"
    | "failed-validation"
    | "failed-lowering"
    | "failed-planning"
    | "conflicted"
    | "failed-write"
    | "failed-verification";
  diagnostics: Diagnostic[];
  plan?: CompilePlan;
  fileSet?: GeneratedFileSet;
  manifest?: GeneratedFileManifest;
  /**
   * The conflict policy this run actually applied (explicit per-call
   * `conflictResolution` option > target config `conflictPolicy` > 'block').
   * Present whenever a plan was produced; absent on early validation /
   * lowering / planning failures where no target was resolved.
   */
  effectiveConflictResolution?: ConflictResolution;
}

export async function compile(
  rawBundle: any,
  rawDomain: any,
  rawCapabilities: any,
  rawBoundary: any,
  rawPersistence: any,
  rawFrontend: any,
  config: ProjectionConfig,
  targetId: string,
  options?: {
    runId?: string;
    priorManifest?: GeneratedFileManifest | null;
    currentFilesFetcher?: (path: string) => { exists: boolean; content: string | null };
    /**
     * Explicit per-call conflict resolution; beats the target config's
     * `conflictPolicy`. 'force' is the only mode that may overwrite a
     * manually-changed file, and it is legal only through this explicit
     * input or an explicit config value — never a default.
     */
    conflictResolution?: ConflictResolution;
  }
): Promise<CompileResult> {
  const runId = options?.runId || "run-default";

  // 1-3. Validation, lowering, target/adapter resolution, adapter plan
  const prepared = await prepareAdapterPlan(
    { bundle: rawBundle, domain: rawDomain, capabilities: rawCapabilities, boundary: rawBoundary, persistence: rawPersistence, frontend: rawFrontend },
    config,
    targetId,
    options?.priorManifest
  );
  if (!prepared.ok) {
    return {
      status: prepared.status,
      diagnostics: prepared.diagnostics,
    };
  }

  const { ir, targetConfig, adapter, adapterPlan } = prepared;

  // 4. Emit file set
  let fileSet: GeneratedFileSet;
  try {
    fileSet = await adapter.emit(adapterPlan);
  } catch (err: any) {
    return {
      status: "failed-planning",
      diagnostics: [
        {
          code: "template_render_error",
          message: `Adapter emission failed: ${err.message}`,
          severity: "error",
          phase: "planning",
        }
      ]
    };
  }

  // 5. Conflict classification
  const fetcher = options?.currentFilesFetcher || (() => ({ exists: false, content: null }));
  const { creates, modifies, reuses, conflicts } = classifyPlanFiles(fileSet.files, options?.priorManifest || null, fetcher);

  // 5b. Conflict-resolution semantics (spec §10.6 / §13 / §14.4; vocabulary
  // mapping documented on ConflictResolution). Precedence: explicit
  // per-call option > target config conflictPolicy > 'block'.
  const effectiveResolution = resolveConflictResolution(options?.conflictResolution, targetConfig.conflictPolicy);
  const annotatedConflicts: PlanConflictEntry[] = conflicts.map(c => ({ ...c, resolution: effectiveResolution }));

  // 'plan-only' (spec "retain-manual"): conflicting files are excluded from
  // the write set AND from the emitted manifest — the manual bytes survive
  // and ownership is never taken, so a later compile still classifies the
  // path as conflicting. 'block' and 'force' keep the full write set:
  // 'block' never reaches a host write (terminal `conflicted`, zero writes),
  // 'force' reclaims the file by overwrite.
  let writeFiles = fileSet.files;
  let retainedConflicts: string[] | undefined;
  let diagnostics: Diagnostic[] = [];
  if (effectiveResolution === "plan-only" && conflicts.length > 0) {
    const retained = new Set(conflicts.map(c => c.path));
    writeFiles = fileSet.files.filter(f => !retained.has(f.path));
    retainedConflicts = [...retained].sort();
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

  // Compile final manifest structure over the write set only: a manifest
  // entry is an ownership claim on bytes the compiler actually wrote (or
  // would write), so a retained manual file must not appear here.
  const filesManifest: Record<string, { hash: string; sourceIds: string[] }> = {};
  for (const file of writeFiles) {
    const contentHash = getFileHash(file.content);
    filesManifest[file.path] = {
      hash: contentHash,
      sourceIds: file.sourceIds,
    };
  }

  const manifest: GeneratedFileManifest = {
    schemaVersion: 1,
    targetId: targetConfig.id,
    applicationId: ir.bundle.applicationId,
    compilerVersion: "0.1.0",
    sourceHash: computeSemanticHash(ir),
    configHash: computeSemanticHash(config),
    adapterVersions: {
      frontend: `${adapter.id}@${adapter.version}`,
    },
    files: filesManifest,
  };

  const plan: CompilePlan = {
    planVersion: "1.0.0",
    runId,
    sourceHash: manifest.sourceHash,
    configHash: manifest.configHash,
    targetId: targetConfig.id,
    adapterVersions: manifest.adapterVersions,
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
    estimatedOutputFiles: writeFiles.map(f => f.path),
    planHash: "",
  };
  if (retainedConflicts) {
    plan.retainedConflicts = retainedConflicts;
  }

  plan.planHash = buildPlanHash(plan);

  // Status precedence is unchanged: unresolved capabilities still dominate.
  // Conflicts change the terminal status only under 'block'; 'plan-only'
  // and 'force' resolve them (retained or reclaimed) and succeed.
  let status: CompileResult["status"] = "succeeded";
  if (plan.unresolved.length > 0) {
    status = "blocked";
  } else if (conflicts.length > 0 && effectiveResolution === "block") {
    status = "conflicted";
  }

  return {
    status,
    diagnostics,
    plan,
    fileSet: { files: writeFiles },
    manifest,
    effectiveConflictResolution: effectiveResolution,
  };
}
