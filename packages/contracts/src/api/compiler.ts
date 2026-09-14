
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

/**
 * How a compiler run resolves generated-file conflicts. Mirrors the
 * projection config's `conflictPolicy` enum in `@open-design/application-ir`
 * and `ConflictResolution` in `@open-design/application-compiler`
 * (src/conflict.ts); the three packages do not depend on each other, so keep
 * the shapes in sync. Vocabulary mapping to the compiler spec (§10.6/§13/§14):
 * `block` = default block; `plan-only` = retain-manual (manual bytes kept,
 * ownership never taken); `force` = regenerate / explicitly approved force.
 */
export type CompilerConflictResolution = 'block' | 'plan-only' | 'force';

export interface CompilerPlanSummary {
  planHash: string;
  targetId: string;
  creates: string[];
  modifies: string[];
  deletes: string[];
  reuses: string[];
  /** Per-conflict treatment under the run's effective policy; `resolution` names how each was handled. */
  conflicts: { path: string; classification: string; resolution?: CompilerConflictResolution }[];
  /** Paths retained unchanged under conflict policy 'plan-only'; present only when at least one conflict was retained. */
  retainedConflicts?: string[];
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
  /**
   * The conflict policy the plan actually applied (explicit per-call option >
   * target config `conflictPolicy` > 'block'); callers bind approvals to it.
   * Mirrors `PlanApplicationResult.effectiveConflictResolution` in
   * `@open-design/application-compiler`; keep the shapes in sync.
   */
  effectiveConflictResolution?: CompilerConflictResolution;
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
  /**
   * Per-phase wall-clock durations in milliseconds, keyed by phase name
   * (`validation`/`lowering`/`planning`/`write`/`verification`). Populated by
   * the daemon when the run reaches a terminal status; absent before that and
   * on runs that terminated before any phase completed.
   */
  phaseDurationsMs?: Record<string, number>;
}

/** Aggregate phase-duration stats from the daemon's in-memory compiler metrics tracker. */
export interface CompilerPhaseDurationStats {
  /** Duration of the most recent completed observation of this phase, in milliseconds. */
  lastMs: number;
  /** Sum of every observed duration of this phase, in milliseconds. */
  cumulativeMs: number;
}

/** Per-target terminal-outcome tallies backing the target compile success rate metric. */
export interface CompilerTargetSuccessStats {
  succeeded: number;
  total: number;
}

/**
 * Snapshot of the daemon's in-process compiler metrics (spec §12.3 "Logs,
 * Metrics, and Traces"). Counters reset when the daemon process restarts —
 * this is a local observability surface, not a metrics server.
 */
export interface CompilerMetricsSnapshot {
  /** Compiler runs keyed by terminal status (`succeeded`/`failed`/`cancelled`). */
  runsByTerminalStatus: Record<string, number>;
  /** Wall-clock durations per compiler phase (validation/lowering/planning/write/verification). */
  phaseDurationsMs: Record<string, CompilerPhaseDurationStats>;
  /**
   * Terminal outcomes per target id. Cancelled runs are excluded: an
   * interrupted compile says nothing about whether the target works.
   */
  targetSuccessRate: Record<string, CompilerTargetSuccessStats>;
  /** Deterministic no-op tallies: recompiles that produced an empty plan vs. total recompiles. */
  noopRate: { noops: number; recompiles: number };
  /** Cumulative generated-file conflicts seen across compile plans. */
  conflictCount: number;
  /** Cumulative unsupported/degraded semantics seen across compile plans. */
  degradedSemanticCount: number;
  /** Verification step failures keyed by heuristic category (build/runtime/a11y/migration). */
  verificationFailureCategory: Record<string, number>;
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
