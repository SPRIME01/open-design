// Pure state logic for the Application Compiler panel (spec §11.4).
//
// Everything here is framework-free so the run-following decision table —
// which SSE frames to accept, when a run is finished, when the Approve
// affordance applies, and how a 409 reads — is unit-testable without
// mounting the component. The component only renders what these helpers
// derive. Wire shapes come from `@open-design/contracts` DTOs only; this
// module must never import daemon source.

import type {
  CompilerDiagnostic,
  CompilerPlanStatus,
  CompilerPlanSummary,
  CompilerRunEvidenceRefs,
  CompilerRunStatus,
} from '@open-design/contracts';

/** Run statuses the daemon will not advance past. */
export function isTerminalRunStatus(status: CompilerRunStatus['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/** True while the panel should keep following the run (SSE + poll). */
export function isRunActive(run: CompilerRunStatus | null | undefined): boolean {
  return Boolean(run && !isTerminalRunStatus(run.status));
}

/**
 * One SSE frame from `GET /api/compiler/runs/:id/events`. The daemon writes
 * unnamed `data:` frames shaped `{ type, data }` where `data` is the run
 * status snapshot (see `emitEvent(runId, type, data)` in the daemon's
 * compiler service).
 */
export interface CompilerRunEvent {
  type: string;
  run: CompilerRunStatus;
}

const RUN_STATUS_VALUES: ReadonlySet<string> = new Set([
  'queued', 'validating', 'lowering', 'planning', 'writing', 'verifying',
  'awaiting_approval', 'succeeded', 'failed', 'cancelled',
]);

function looksLikeRunStatus(value: unknown): value is CompilerRunStatus {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CompilerRunStatus>;
  return typeof candidate.runId === 'string'
    && typeof candidate.status === 'string'
    && RUN_STATUS_VALUES.has(candidate.status);
}

/**
 * Validate one parsed SSE payload into a typed run event. The shared
 * `useEventStream` hook already JSON-parses the `data:` frame; this guards
 * the shape so a malformed frame can never poison the panel state.
 */
export function parseCompilerRunEvent(payload: unknown): CompilerRunEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as { type?: unknown; data?: unknown };
  if (typeof candidate.type !== 'string' || candidate.type.length === 0) return null;
  if (!looksLikeRunStatus(candidate.data)) return null;
  return { type: candidate.type, run: candidate.data };
}

/**
 * Which run snapshot the panel should keep. A status frame for a different
 * run id than the one being followed is stale (a shared SSE manager can
 * deliver frames across a quick run switch), and so is any frame that
 * arrives after the followed run already reached a terminal state — the
 * daemon never legitimately moves a run out of succeeded/failed/cancelled.
 */
export function acceptRunStatus(
  current: CompilerRunStatus | null,
  next: CompilerRunStatus,
): boolean {
  if (current && current.runId !== next.runId) return false;
  if (current && isTerminalRunStatus(current.status)) return false;
  return true;
}

/** Count-only projection of a plan summary for the panel's summary grid. */
export function planSummaryCounts(plan: CompilerPlanSummary) {
  return {
    creates: plan.creates.length,
    modifies: plan.modifies.length,
    deletes: plan.deletes.length,
    reuses: plan.reuses.length,
    conflicts: plan.conflicts.length,
    unresolved: plan.unresolved.length,
  };
}

/**
 * Plan statuses whose summary the panel should still show (a blocked or
 * conflicted plan is exactly when the conflict list matters), as opposed to
 * the failed-* statuses where diagnostics are the story.
 */
export function planShowsSummary(status: CompilerPlanStatus): boolean {
  return status === 'succeeded' || status === 'blocked' || status === 'conflicted';
}

/** Diagnostic codes the daemon emits when a run stopped on a blocked/conflicted plan. */
const APPROVAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'file_conflicts',
  'unresolved_references',
]);

/**
 * True when a finished run stopped because its plan was blocked or
 * conflicted AND the run carries the plan hash approval binds against.
 * This is the one state where the Approve affordance applies (spec §11.5:
 * approval-requiring actions must be explicit, never hidden).
 */
export function isApprovalConflictRun(run: CompilerRunStatus | null | undefined): boolean {
  if (!run || run.status !== 'failed' || !run.planHash) return false;
  return run.diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error'
      && APPROVAL_CONFLICT_CODES.has(diagnostic.code),
  );
}

/**
 * True when a run paused in `awaiting_approval`: its effective conflict
 * resolution is `force` and the daemon stopped before any write, carrying
 * the planHash an approval must present. Not terminal — approve resumes
 * the run and the panel keeps following it.
 */
export function isAwaitingApprovalRun(run: CompilerRunStatus | null | undefined): boolean {
  return Boolean(run && run.status === 'awaiting_approval' && run.planHash);
}

/** How a `POST /runs/:id/approve` call resolved, for panel messaging. */
export type ApproveOutcome = 'approved' | 'stale-plan' | 'error';

/** Error body the daemon's `sendApiError` produces: `{ error: { code, message } }`. */
export function classifyApproveError(err: unknown): Exclude<ApproveOutcome, 'approved'> {
  if (
    typeof err === 'object'
    && err !== null
    && 'status' in err
    && (err as { status?: unknown }).status === 409
  ) {
    return 'stale-plan';
  }
  return 'error';
}

/**
 * Verification verdict for a terminal run. A succeeded run completed the
 * verification phase without a failed step; a failed run carrying a
 * verification-phase error diagnostic failed verification; anything else
 * (failed earlier, cancelled) has no verdict to show.
 */
export function verificationOutcome(
  run: CompilerRunStatus | null | undefined,
): 'passed' | 'failed' | null {
  if (!run || !isTerminalRunStatus(run.status)) return null;
  if (run.status === 'succeeded') return 'passed';
  if (run.status === 'cancelled') return null;
  const failedVerification = run.diagnostics.some(
    (diagnostic) => diagnostic.phase === 'verification' && diagnostic.severity === 'error',
  );
  return failedVerification ? 'failed' : null;
}

/** Non-empty evidence path entries, in the panel's display order. */
export function evidenceEntries(
  refs: CompilerRunEvidenceRefs | undefined,
): Array<{ key: keyof CompilerRunEvidenceRefs; path: string }> {
  if (!refs) return [];
  const order: Array<keyof CompilerRunEvidenceRefs> = [
    'manifestPath', 'planPath', 'evidencePath', 'diagnosticsPath',
  ];
  return order.flatMap((key) => {
    const path = refs[key];
    return typeof path === 'string' && path.length > 0 ? [{ key, path }] : [];
  });
}

/** Diagnostic rows the panel lists (message plus code for triage). */
export function diagnosticRows(diagnostics: CompilerDiagnostic[] | undefined) {
  return (diagnostics ?? []).map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
  }));
}
