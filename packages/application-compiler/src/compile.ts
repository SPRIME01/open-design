import {
  ResolvedApplicationIR,
  Diagnostic,
  validateBundle,
  ProjectionTarget,
  ProjectionConfig
} from "@open-design/application-ir";
import { runLoweringPipeline } from "./pipeline.js";
import { adapterRegistry } from "./adapter-registry.js";
import { CompilePlan, buildPlanHash } from "./plan.js";
import { GeneratedFileSet, AdapterContext } from "./adapter-contract.js";
import { classifyPath, ConflictClassification, getFileHash } from "./conflict.js";
import { GeneratedFileManifest } from "./manifest.js";
import { computeSemanticHash } from "@open-design/application-ir";

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
  }
): Promise<CompileResult> {
  const runId = options?.runId || "run-default";
  
  // 1. Validation & Resolution
  const valRes = validateBundle(rawBundle, rawDomain, rawCapabilities, rawBoundary, rawPersistence, rawFrontend);
  if (valRes.diagnostics.length > 0) {
    return {
      status: "failed-validation",
      diagnostics: valRes.diagnostics,
    };
  }

  // 2. Lowering Pipeline
  const lowerRes = runLoweringPipeline(valRes.ir!);
  if (lowerRes.diagnostics.some(d => d.severity === "error")) {
    return {
      status: "failed-lowering",
      diagnostics: lowerRes.diagnostics,
    };
  }

  // Find target config
  const targetConfig = config.targets.find(t => t.id === targetId);
  if (!targetConfig) {
    return {
      status: "failed-planning",
      diagnostics: [
        {
          code: "unsupported_kind_error",
          message: `Target configuration '${targetId}' not found.`,
          severity: "error",
          phase: "planning",
        }
      ]
    };
  }

  // Find adapter
  const adapter = adapterRegistry.get(targetConfig.adapter);
  if (!adapter) {
    return {
      status: "failed-planning",
      diagnostics: [
        {
          code: "adapter_load_error",
          message: `Target adapter '${targetConfig.adapter}' is not registered.`,
          severity: "error",
          phase: "planning",
        }
      ]
    };
  }

  // 3. Adapter Validate & Plan
  const context: AdapterContext = {
    ir: lowerRes.ir,
    targetConfig,
    config,
    priorManifest: options?.priorManifest,
  };

  const adapterDiagnostics = adapter.validate(context);
  if (adapterDiagnostics.some(d => d.severity === "error")) {
    return {
      status: "failed-planning",
      diagnostics: adapterDiagnostics,
    };
  }

  let adapterPlan;
  try {
    adapterPlan = await adapter.plan(context);
  } catch (err: any) {
    return {
      status: "failed-planning",
      diagnostics: [
        {
          code: "template_render_error",
          message: `Adapter planning failed: ${err.message}`,
          severity: "error",
          phase: "planning",
        }
      ]
    };
  }

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
  const creates: string[] = [];
  const modifies: string[] = [];
  const deletes: string[] = [];
  const reuses: string[] = [];
  const conflicts: { path: string; classification: ConflictClassification }[] = [];

  const fetcher = options?.currentFilesFetcher || (() => ({ exists: false, content: null }));

  for (const file of fileSet.files) {
    const { exists, content } = fetcher(file.path);
    const classification = classifyPath(file.path, exists, content, options?.priorManifest || null, file.content);

    if (classification === "CREATE") {
      creates.push(file.path);
    } else if (classification === "MODIFY_GENERATED_FILE") {
      modifies.push(file.path);
    } else if (classification === "NO_CHANGE" || classification === "REUSE_IDENTICAL_MANUAL") {
      reuses.push(file.path);
    } else {
      conflicts.push({ path: file.path, classification });
    }
  }

  // Compile final manifest structure
  const filesManifest: Record<string, { hash: string; sourceIds: string[] }> = {};
  for (const file of fileSet.files) {
    const contentHash = getFileHash(file.content);
    filesManifest[file.path] = {
      hash: contentHash,
      sourceIds: file.sourceIds,
    };
  }

  const manifest: GeneratedFileManifest = {
    schemaVersion: 1,
    targetId: targetConfig.id,
    applicationId: lowerRes.ir.bundle.applicationId,
    compilerVersion: "0.1.0",
    sourceHash: computeSemanticHash(lowerRes.ir),
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
    deletes,
    reuses,
    conflicts,
    unresolved: adapterPlan.unresolved,
    degradations: adapterPlan.degradations,
    permissionsRequired: adapterPlan.permissions,
    commandsProposed: adapterPlan.commands,
    verificationPlanned: adapterPlan.verificationSteps,
    estimatedOutputFiles: fileSet.files.map(f => f.path),
    planHash: "",
  };

  plan.planHash = buildPlanHash(plan);

  let status: CompileResult["status"] = "succeeded";
  if (plan.unresolved.length > 0) {
    status = "blocked";
  } else if (conflicts.length > 0) {
    status = "conflicted";
  }

  return {
    status,
    diagnostics: [],
    plan,
    fileSet,
    manifest,
  };
}
