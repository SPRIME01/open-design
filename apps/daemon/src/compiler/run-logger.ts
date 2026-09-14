/**
 * Structured compiler-run logging (spec §12.3 "Logs, Metrics, and Traces").
 *
 * One JSON object per line on stdout, namespaced `compiler` — the same
 * JSON-line convention as `logging/critique.ts`, so an operator's existing
 * log pipeline ingests compiler events without a new adapter. Daemon
 * logging outside this convention stays plain `console.*`; structured
 * JSON lines are reserved for event streams worth aggregating.
 *
 * Field mapping notes for the spec's required log context:
 * - `project_id` carries the daemon-side project root path. This compiler
 *   model has no od-project id; the project root is the stable identity a
 *   compile is bound to, so it stands in for project_id.
 * - Fields are present when known. A run that fails validation has no
 *   source/plan hash or adapter identity yet, so those keys are omitted
 *   from that run's lines rather than logged with placeholder values.
 * - `config_hash` is computed with `computeSemanticHash` from
 *   `@open-design/application-ir` — the same function `compile()` uses for
 *   `manifest.configHash`, so a run's log lines agree with its manifest.
 */

export type CompilerLogEventName =
  | 'run_created'
  | 'validation_completed'
  | 'lowering_started'
  | 'lowering_completed'
  | 'plan_created'
  | 'write_committed'
  | 'verification_step_started'
  | 'verification_step_completed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'approval_rejected'
  | 'run_terminal';

export interface CompilerLogEvent {
  /** Lifecycle event name (§12.3 "Required traces/events" subset wired in the daemon). */
  event: CompilerLogEventName;
  compiler_run_id?: string | undefined;
  /** Daemon project root standing in for the spec's project_id (see header comment). */
  project_id?: string | undefined;
  application_id?: string | undefined;
  target_id?: string | undefined;
  phase?: string | undefined;
  source_hash?: string | undefined;
  config_hash?: string | undefined;
  plan_hash?: string | undefined;
  /** Adapter ids+versions keyed by role, e.g. `{ frontend: "html-static@1.0.0" }`. */
  adapters?: Record<string, string> | undefined;
  /** First error diagnostic code, on failure events. */
  diagnostic_code?: string | undefined;
  /** Verification step name, on verification events. */
  command_step_id?: string | undefined;
  /** Event-specific extras (duration_ms, terminal_status, counts, ...). */
  [key: string]: unknown;
}

/**
 * Emit one structured JSON line for a compiler lifecycle event. The
 * timestamp is ISO-8601 with millisecond precision so an aggregator
 * ingesting multiple log streams can stable-sort across them.
 */
export function logCompilerEvent(e: CompilerLogEvent): void {
  console.log(
    JSON.stringify({ ...e, namespace: 'compiler', timestamp: new Date().toISOString() })
  );
}
