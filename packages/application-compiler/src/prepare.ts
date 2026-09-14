import {
  Diagnostic,
  ProjectionConfig,
  ProjectionTarget,
  ResolvedApplicationIR,
  validateBundle,
} from "@open-design/application-ir";
import { runLoweringPipeline } from "./pipeline.js";
import { adapterRegistry } from "./adapter-registry.js";
import {
  AdapterContext,
  AdapterPlan,
  ApplicationTargetAdapter,
  FileChange,
} from "./adapter-contract.js";
import { ConflictClassification, classifyPath } from "./conflict.js";
import { GeneratedFileManifest } from "./manifest.js";

/**
 * The already-loaded raw IR documents a compile or plan run operates on.
 * Mirrors the six raw documents compile() receives as positional arguments;
 * loading them from disk is the caller's concern.
 */
export interface ApplicationCompilerInput {
  bundle: any;
  domain: any;
  capabilities: any;
  boundary: any;
  persistence: any;
  frontend: any;
}

export type PreparedAdapterPlan =
  | {
      ok: false;
      status: "failed-validation" | "failed-lowering" | "failed-planning";
      diagnostics: Diagnostic[];
    }
  | {
      ok: true;
      ir: ResolvedApplicationIR;
      targetConfig: ProjectionTarget;
      adapter: ApplicationTargetAdapter;
      adapterPlan: AdapterPlan;
    };

/**
 * Shared front half of compile() and planApplication(): validate, lower,
 * resolve the target config and adapter, then run adapter validate + plan.
 * Stops before projection (adapter.emit) and performs no writes.
 */
export async function prepareAdapterPlan(
  input: ApplicationCompilerInput,
  config: ProjectionConfig,
  targetId: string,
  priorManifest?: GeneratedFileManifest | null
): Promise<PreparedAdapterPlan> {
  // 1. Validation & Resolution
  const valRes = validateBundle(input.bundle, input.domain, input.capabilities, input.boundary, input.persistence, input.frontend);
  if (valRes.diagnostics.length > 0) {
    return {
      ok: false,
      status: "failed-validation",
      diagnostics: valRes.diagnostics,
    };
  }

  // 2. Lowering Pipeline
  const lowerRes = runLoweringPipeline(valRes.ir!);
  if (lowerRes.diagnostics.some(d => d.severity === "error")) {
    return {
      ok: false,
      status: "failed-lowering",
      diagnostics: lowerRes.diagnostics,
    };
  }

  // Find target config
  const targetConfig = config.targets.find(t => t.id === targetId);
  if (!targetConfig) {
    return {
      ok: false,
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
      ok: false,
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
    priorManifest,
  };

  const adapterDiagnostics = adapter.validate(context);
  if (adapterDiagnostics.some(d => d.severity === "error")) {
    return {
      ok: false,
      status: "failed-planning",
      diagnostics: adapterDiagnostics,
    };
  }

  let adapterPlan;
  try {
    adapterPlan = await adapter.plan(context);
  } catch (err: any) {
    return {
      ok: false,
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

  return { ok: true, ir: lowerRes.ir, targetConfig, adapter, adapterPlan };
}

export interface PlanFileBuckets {
  creates: string[];
  modifies: string[];
  reuses: string[];
  conflicts: { path: string; classification: ConflictClassification }[];
}

/**
 * Classify proposed file changes into plan buckets. Shared by compile() and
 * planApplication() so both always agree on what a plan says about the disk.
 */
export function classifyPlanFiles(
  files: FileChange[],
  priorManifest: GeneratedFileManifest | null,
  currentFilesFetcher: (path: string) => { exists: boolean; content: string | null }
): PlanFileBuckets {
  const buckets: PlanFileBuckets = { creates: [], modifies: [], reuses: [], conflicts: [] };

  for (const file of files) {
    const { exists, content } = currentFilesFetcher(file.path);
    const classification = classifyPath(file.path, exists, content, priorManifest, file.content);

    if (classification === "CREATE") {
      buckets.creates.push(file.path);
    } else if (classification === "MODIFY_GENERATED_FILE") {
      buckets.modifies.push(file.path);
    } else if (classification === "NO_CHANGE" || classification === "REUSE_IDENTICAL_MANUAL") {
      buckets.reuses.push(file.path);
    } else {
      buckets.conflicts.push({ path: file.path, classification });
    }
  }

  return buckets;
}
