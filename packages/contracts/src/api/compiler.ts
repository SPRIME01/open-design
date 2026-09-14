
export interface CompilerTargetInfo {
  id: string;
  version: string;
  kind: 'frontend' | 'transport' | 'persistence' | 'compound';
  features: string[];
  limitations: string[];
}

export interface CompilerDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "advisory";
  phase: "validation" | "lowering" | "planning" | "write" | "verification";
  sourceFile?: string;
  pointer?: string;
  affectedIds?: string[];
  recommendedAction?: string;
}

export interface CompilerValidationResult {
  valid: boolean;
  diagnostics: CompilerDiagnostic[];
  /**
   * Project-relative-to-absolute path where the daemon persisted this
   * validation pass's diagnostics (`<projectRoot>/compiler/diagnostics/…`).
   * Present only on daemon-served responses; the pure compiler packages
   * return the first two fields.
   */
  diagnosticsPath?: string;
}

export interface CompilerValidateRequest {
  projectRoot: string;
}

/** Request body for `POST /api/compiler/ir`. */
export interface CompilerIrRequest {
  projectRoot: string;
}

/**
 * Response of `POST /api/compiler/ir`: the project's raw IR documents
 * exactly as loaded from disk — no validation, no mutation. `bundle` is the
 * parsed `application.ir.json`; each module is the raw JSON the bundle's
 * `modules` map points at (a missing module file loads as `{}`). This is the
 * same input a validate/plan/compile of the project would operate on.
 */
export interface CompilerIrResponse {
  bundle: unknown;
  modules: {
    domain: unknown;
    capabilities: unknown;
    boundary: unknown;
    persistence: unknown;
    frontend: unknown;
  };
}

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

export interface CompilerPlanRequest {
  projectRoot: string;
  targetId: string;
}

/**
 * Result of a plan-only pass (`POST /api/compiler/plan`). Structurally
 * identical to `PlanApplicationResult` in `@open-design/application-compiler`;
 * the two packages do not depend on each other, so keep the shapes in sync.
 */
export type CompilerPlanStatus =
  | 'succeeded'
  | 'blocked'
  | 'conflicted'
  | 'failed-validation'
  | 'failed-lowering'
  | 'failed-planning';

export interface CompilerPlanResult {
  status: CompilerPlanStatus;
  diagnostics: CompilerDiagnostic[];
  plan?: CompilerPlanSummary;
  planHash?: string;
  /** Where the daemon persisted the plan summary (`<projectRoot>/compiler/plans/…`). */
  evidenceRefs?: CompilerRunEvidenceRefs;
}

/** Approval body for `POST /api/compiler/runs/:id/approve`. */
export interface CompilerApproveRequest {
  planHash: string;
}

export interface CompilerRunEvidenceRefs {
  planPath?: string;
  manifestPath?: string;
  evidencePath?: string;
  diagnosticsPath?: string;
}

export interface CompilerRunStatus {
  runId: string;
  status: 'queued' | 'validating' | 'lowering' | 'planning' | 'writing' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  phase: 'validation' | 'lowering' | 'planning' | 'write' | 'verification' | 'idle';
  progress: number; // 0 to 100
  diagnostics: CompilerDiagnostic[];
  planHash?: string;
  /** Set by `POST /api/compiler/runs/:id/approve` when the presented hash matched `planHash`. */
  approvedPlanHash?: string;
  startedAt: string;
  completedAt?: string;
  evidenceRefs?: CompilerRunEvidenceRefs;
}

export interface CompilerRunResult {
  runId: string;
  status: CompilerRunStatus;
}

export interface CompilerEvidence {
  runId: string;
  logs: string[];
  filesEmitted: string[];
  verificationOutput: string;
}
