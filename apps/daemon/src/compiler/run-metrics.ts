/**
 * In-memory compiler run metrics (spec §12.3 "Logs, Metrics, and Traces").
 *
 * Aggregate counters and phase durations keyed per the spec's required
 * metrics list. This is a local daemon observability surface, not a
 * metrics server: everything lives in module state, resets when the
 * daemon process restarts, and is exposed read-only through
 * `GET /api/compiler/metrics`.
 *
 * Deliberate accounting rules:
 * - A run is counted terminal exactly once (first terminal wins), so a
 *   cancel racing a completing run cannot double-count `cancelled` and
 *   `succeeded` for the same run.
 * - Cancelled runs are excluded from `targetSuccessRate`: an interrupted
 *   compile says nothing about whether the target works.
 * - `verificationFailureCategory` maps a failed step's name
 *   heuristically (`build`→build, `migration`→migration, `a11y`→a11y,
 *   anything else→runtime). Toolchain-shaped failures (missing binary,
 *   timeout) currently fall into `runtime`; splitting them out needs a
 *   richer verification result than the runner reports today.
 */

import { CompilerMetricsSnapshot } from "@open-design/contracts";

export type VerificationFailureCategory = "build" | "runtime" | "a11y" | "migration";

/** Heuristic §12.3 failure-category mapping from a verification step name. */
export function categorizeVerificationFailure(stepName: string): VerificationFailureCategory {
  const name = stepName.toLowerCase();
  if (name.includes("build")) return "build";
  if (name.includes("migration")) return "migration";
  if (name.includes("a11y")) return "a11y";
  return "runtime";
}

interface RunPhaseTiming {
  activePhase: string | null;
  phaseStartedAt: number;
  recorded: Record<string, number>;
}

const runPhaseTimings = new Map<string, RunPhaseTiming>();
/** Run ids that already landed a terminal status; guards the once-per-run terminal count. */
const finalizedRuns = new Set<string>();

const runsByTerminalStatus: Record<string, number> = {};
const phaseDurationsMs: Record<string, { lastMs: number; cumulativeMs: number }> = {};
const targetSuccessRate: Record<string, { succeeded: number; total: number }> = {};
const noopRate = { noops: 0, recompiles: 0 };
let conflictCount = 0;
let degradedSemanticCount = 0;
const verificationFailureCategory: Record<string, number> = {};

function closeActivePhase(runId: string, timing: RunPhaseTiming): void {
  if (timing.activePhase === null) return;
  const duration = Date.now() - timing.phaseStartedAt;
  timing.recorded[timing.activePhase] =
    (timing.recorded[timing.activePhase] ?? 0) + duration;
  timing.activePhase = null;
}

export const runMetrics = {
  /** Start the wall-clock timer for a run's phase; closes any previously open phase. */
  beginPhase(runId: string, phase: string): void {
    let timing = runPhaseTimings.get(runId);
    if (!timing) {
      timing = { activePhase: null, phaseStartedAt: 0, recorded: {} };
      runPhaseTimings.set(runId, timing);
    }
    closeActivePhase(runId, timing);
    timing.activePhase = phase;
    timing.phaseStartedAt = Date.now();
  },

  /** Close a run's phase and return its duration in ms (undefined if it never started). */
  endPhase(runId: string, phase: string): number | undefined {
    const timing = runPhaseTimings.get(runId);
    if (!timing || timing.activePhase !== phase) return undefined;
    closeActivePhase(runId, timing);
    return timing.recorded[phase];
  },

  /**
   * Record plan-level observations: no-op (empty create/modify/delete set)
   * recompiles, generated-file conflicts, and degraded semantics.
   */
  recordPlanObservations(plan: {
    creates: unknown[];
    modifies: unknown[];
    deletes: unknown[];
    conflicts: unknown[];
    degradations: unknown[];
  }): void {
    noopRate.recompiles += 1;
    const noop =
      plan.creates.length === 0 && plan.modifies.length === 0 && plan.deletes.length === 0;
    if (noop) noopRate.noops += 1;
    conflictCount += plan.conflicts.length;
    degradedSemanticCount += plan.degradations.length;
  },

  /** Count a failed verification step under its heuristic §12.3 category. */
  recordVerificationFailure(stepName: string): void {
    const category = categorizeVerificationFailure(stepName);
    verificationFailureCategory[category] = (verificationFailureCategory[category] ?? 0) + 1;
  },

  /**
   * Finalize a run: close any open phase, merge its per-phase durations into
   * the aggregates, and count the terminal status. The first terminal call
   * for a run id wins; later calls (a cancel racing a completing run) only
   * return the recorded durations without counting again. Returns the run's
   * per-phase durations in ms for the run record.
   */
  recordTerminal(
    runId: string,
    terminalStatus: string,
    targetId?: string
  ): Record<string, number> | undefined {
    const timing = runPhaseTimings.get(runId);
    if (timing) closeActivePhase(runId, timing);
    const recorded: Record<string, number> = { ...(timing?.recorded ?? {}) };
    runPhaseTimings.delete(runId);

    if (finalizedRuns.has(runId)) return recorded;
    finalizedRuns.add(runId);

    runsByTerminalStatus[terminalStatus] = (runsByTerminalStatus[terminalStatus] ?? 0) + 1;
    for (const [phase, ms] of Object.entries(recorded)) {
      const agg = phaseDurationsMs[phase] ?? { lastMs: 0, cumulativeMs: 0 };
      agg.lastMs = ms;
      agg.cumulativeMs += ms;
      phaseDurationsMs[phase] = agg;
    }
    if (targetId && (terminalStatus === "succeeded" || terminalStatus === "failed")) {
      const outcomes = targetSuccessRate[targetId] ?? { succeeded: 0, total: 0 };
      outcomes.total += 1;
      if (terminalStatus === "succeeded") outcomes.succeeded += 1;
      targetSuccessRate[targetId] = outcomes;
    }
    return recorded;
  },

  /** Read-only aggregate snapshot for `GET /api/compiler/metrics`. */
  snapshot(): CompilerMetricsSnapshot {
    return {
      runsByTerminalStatus: { ...runsByTerminalStatus },
      phaseDurationsMs: Object.fromEntries(
        Object.entries(phaseDurationsMs).map(([phase, agg]) => [phase, { ...agg }])
      ),
      targetSuccessRate: Object.fromEntries(
        Object.entries(targetSuccessRate).map(([target, outcomes]) => [
          target,
          { ...outcomes },
        ])
      ),
      noopRate: { ...noopRate },
      conflictCount,
      degradedSemanticCount,
      verificationFailureCategory: { ...verificationFailureCategory },
    };
  },
};
