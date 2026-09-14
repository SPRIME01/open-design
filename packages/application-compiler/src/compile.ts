import {
  Diagnostic,
  ProjectionConfig
} from "@open-design/application-ir";
import { CompilePlan, buildPlanHash } from "./plan.js";
import { GeneratedFileSet } from "./adapter-contract.js";
import { getFileHash } from "./conflict.js";
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
