// Application Compiler panel — spec §11.4 minimum v0.1 UI.
//
// Flow: enter a project root → Load (targets + IR validation) → pick a
// target → Create plan (summary, permissions, conflicts, plan hash) →
// Compile (run progress over SSE with polling fallback) → terminal state
// shows evidence paths + verification verdict. A run that stopped on a
// blocked/conflicted plan offers hash-bound Approve, surfacing the daemon's
// 409 PLAN_HASH_MISMATCH as a stale-plan message with a Re-plan affordance;
// a force-resolution run paused in awaiting_approval shows the same Approve
// affordance (sending resolution 'force'), and approving resumes it.
//
// The panel consumes ONLY the daemon HTTP/SSE surface through
// ../features/application-compiler/compiler-api (contracts DTOs); it never
// imports daemon source. The same capability stays available in the CLI as
// `od app` — the UI is not the only way to operate the compiler.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, VisuallyHidden } from '@open-design/components';
import type {
  CompilerPlanResult,
  CompilerRunStatus,
  CompilerTargetInfo,
  CompilerValidationResult,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { useEventStream } from '../../hooks/useEventStream';
import {
  approveCompilerRun,
  cancelCompilerRun,
  fetchCompilerTargets,
  getCompilerRun,
  planCompilerProject,
  startCompilerRun,
  validateCompilerProject,
} from './compiler-api';
import {
  classifyApproveError,
  diagnosticRows,
  evidenceEntries,
  isApprovalConflictRun,
  isAwaitingApprovalRun,
  isRunActive,
  isTerminalRunStatus,
  parseCompilerRunEvent,
  acceptRunStatus,
  planShowsSummary,
  planSummaryCounts,
  verificationOutcome,
  type ApproveOutcome,
} from './run-flow';
import styles from './ApplicationCompilerPanel.module.css';

type StatusKey = `compiler.status.${CompilerRunStatus['status']}`;
const STATUS_KEYS: Record<CompilerRunStatus['status'], StatusKey> = {
  queued: 'compiler.status.queued',
  validating: 'compiler.status.validating',
  lowering: 'compiler.status.lowering',
  planning: 'compiler.status.planning',
  writing: 'compiler.status.writing',
  verifying: 'compiler.status.verifying',
  awaiting_approval: 'compiler.status.awaiting_approval',
  succeeded: 'compiler.status.succeeded',
  failed: 'compiler.status.failed',
  cancelled: 'compiler.status.cancelled',
};

const PHASE_KEYS: Record<CompilerRunStatus['phase'], keyof Dict> = {
  idle: 'compiler.phase.idle',
  validation: 'compiler.phase.validation',
  lowering: 'compiler.phase.lowering',
  planning: 'compiler.phase.planning',
  write: 'compiler.phase.write',
  verification: 'compiler.phase.verification',
};

const PLAN_STATUS_KEYS: Record<CompilerPlanResult['status'], keyof Dict> = {
  succeeded: 'compiler.planStatus.succeeded',
  blocked: 'compiler.planStatus.blocked',
  conflicted: 'compiler.planStatus.conflicted',
  'failed-validation': 'compiler.planStatus.failed-validation',
  'failed-lowering': 'compiler.planStatus.failed-lowering',
  'failed-planning': 'compiler.planStatus.failed-planning',
};

const EVIDENCE_KEYS: Record<'manifestPath' | 'planPath' | 'evidencePath' | 'diagnosticsPath', keyof Dict> = {
  manifestPath: 'compiler.evidence.manifestPath',
  planPath: 'compiler.evidence.planPath',
  evidencePath: 'compiler.evidence.evidencePath',
  diagnosticsPath: 'compiler.evidence.diagnosticsPath',
};

/** Poll floor while SSE is down; relaxed while the shared stream is live. */
const POLL_ACTIVE_MS = 1_000;
const POLL_SSE_LIVE_MS = 5_000;

export function ApplicationCompilerPanel() {
  const { t } = useI18n();

  const [projectRootInput, setProjectRootInput] = useState('');
  const [loadedRoot, setLoadedRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [targets, setTargets] = useState<CompilerTargetInfo[]>([]);
  const [targetId, setTargetId] = useState('');
  const [validation, setValidation] = useState<CompilerValidationResult | null>(null);

  const [plan, setPlan] = useState<CompilerPlanResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [run, setRun] = useState<CompilerRunStatus | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [approveState, setApproveState] = useState<ApproveOutcome | 'idle'>('idle');

  const runActive = isRunActive(run);
  const runId = run?.runId ?? null;

  // Guard the async setters against a panel that moved on (user re-loaded
  // or started another run while a request was in flight).
  const flowEpochRef = useRef(0);

  const handleLoad = useCallback(async () => {
    const root = projectRootInput.trim();
    if (!root || loading) return;
    const epoch = ++flowEpochRef.current;
    setLoading(true);
    setLoadError(null);
    setPlan(null);
    setPlanError(null);
    setRun(null);
    setCompileError(null);
    setApproveState('idle');
    try {
      const [targetList, validationResult] = await Promise.all([
        fetchCompilerTargets(),
        validateCompilerProject({ projectRoot: root }),
      ]);
      if (epoch !== flowEpochRef.current) return;
      setTargets(targetList);
      setValidation(validationResult);
      setLoadedRoot(root);
      setTargetId((current) =>
        current && targetList.some((target) => target.id === current)
          ? current
          : (targetList[0]?.id ?? ''),
      );
    } catch (err) {
      if (epoch !== flowEpochRef.current) return;
      setLoadError(err instanceof Error ? err.message : t('compiler.loadError'));
    } finally {
      if (epoch === flowEpochRef.current) setLoading(false);
    }
  }, [projectRootInput, loading, t]);

  const handlePlan = useCallback(async () => {
    if (!loadedRoot || !targetId || planning || runActive) return;
    const epoch = ++flowEpochRef.current;
    setPlanning(true);
    setPlanError(null);
    setApproveState('idle');
    try {
      const result = await planCompilerProject({ projectRoot: loadedRoot, targetId });
      if (epoch !== flowEpochRef.current) return;
      setPlan(result);
    } catch (err) {
      if (epoch !== flowEpochRef.current) return;
      setPlan(null);
      setPlanError(err instanceof Error ? err.message : t('compiler.planError'));
    } finally {
      if (epoch === flowEpochRef.current) setPlanning(false);
    }
  }, [loadedRoot, targetId, planning, runActive, t]);

  const handleCompile = useCallback(async () => {
    if (!loadedRoot || !targetId || compiling || runActive) return;
    const epoch = ++flowEpochRef.current;
    setCompiling(true);
    setCompileError(null);
    setApproveState('idle');
    try {
      const status = await startCompilerRun({ projectRoot: loadedRoot, targetId });
      if (epoch !== flowEpochRef.current) return;
      setRun(status);
    } catch (err) {
      if (epoch !== flowEpochRef.current) return;
      setRun(null);
      setCompileError(err instanceof Error ? err.message : t('compiler.compileError'));
    } finally {
      if (epoch === flowEpochRef.current) setCompiling(false);
    }
  }, [loadedRoot, targetId, compiling, runActive, t]);

  const handleCancel = useCallback(async () => {
    if (!runId || !runActive) return;
    try {
      const status = await cancelCompilerRun(runId);
      setRun(status);
    } catch {
      /* the poll/SSE floor will re-read the run and catch up */
    }
  }, [runId, runActive]);

  const handleApprove = useCallback(async () => {
    if (!run || !run.planHash) return;
    setApproveState('idle');
    try {
      // A run paused in awaiting_approval is a force-resolution run: the
      // approval must name resolution 'force' to resume it. A finished
      // conflicted-blocked run keeps the plain hash-bound approve.
      await approveCompilerRun(run.runId, run.planHash, {
        ...(isAwaitingApprovalRun(run) ? { resolution: 'force' as const } : {}),
      });
      setApproveState('approved');
    } catch (err) {
      setApproveState(classifyApproveError(err));
    }
  }, [run]);

  // SSE: the daemon's run-events endpoint writes unnamed `data:` frames
  // shaped `{type, data}` — the shared stream surfaces those through the
  // browser's default `message` event. The hook shares one EventSource per
  // URL and reports `connected` so the poll below can relax while live.
  const handleSsePayload = useCallback((payload: unknown) => {
    const event = parseCompilerRunEvent(payload);
    if (!event) return;
    setRun((current) => (acceptRunStatus(current, event.run) ? event.run : current));
  }, []);
  const { connected: sseConnected } = useEventStream(
    runActive && runId ? `/api/compiler/runs/${encodeURIComponent(runId)}/events` : null,
    { enabled: Boolean(runActive && runId), events: { message: handleSsePayload } },
  );

  // Poll-as-floor: keeps progress accurate when SSE is unavailable (no
  // EventSource in the runtime, proxy buffering, tab parked) and catches up
  // after any disconnect gap.
  useEffect(() => {
    if (!runActive || !runId) return undefined;
    const period = sseConnected ? POLL_SSE_LIVE_MS : POLL_ACTIVE_MS;
    const timer = setInterval(() => {
      void getCompilerRun(runId)
        .then((status) => {
          setRun((current) => (acceptRunStatus(current, status) ? status : current));
        })
        .catch(() => {
          /* transient poll failure — the next tick retries */
        });
    }, period);
    return () => clearInterval(timer);
  }, [runActive, runId, sseConnected]);

  const planSummary = plan?.plan && planShowsSummary(plan.status) ? planSummaryCounts(plan.plan) : null;
  const approvalConflict = isApprovalConflictRun(run);
  const awaitingApproval = isAwaitingApprovalRun(run);
  const verification = verificationOutcome(run);
  const evidence = run && isTerminalRunStatus(run.status) ? evidenceEntries(run.evidenceRefs) : [];
  const runDiagnostics = run ? diagnosticRows(run.diagnostics) : [];
  const validationRows = validation ? diagnosticRows(validation.diagnostics) : [];

  return (
    <section className={styles.panel} data-testid="application-compiler-panel" aria-labelledby="application-compiler-title">
      <header className={styles.header}>
        <h1 id="application-compiler-title" className={styles.title}>{t('compiler.title')}</h1>
        <p className={styles.description}>{t('compiler.description')}</p>
      </header>

      <div className={styles.card}>
        <div className={styles.loadRow}>
          <div className={styles.field}>
            <label htmlFor="application-compiler-root" className={styles.fieldLabel}>
              {t('compiler.projectRootLabel')}
            </label>
            <Input
              id="application-compiler-root"
              value={projectRootInput}
              placeholder={t('compiler.projectRootPlaceholder')}
              onChange={(event) => setProjectRootInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleLoad();
              }}
              spellCheck={false}
              data-testid="compiler-project-root"
            />
          </div>
          <Button
            variant="primary"
            onClick={() => void handleLoad()}
            disabled={!projectRootInput.trim() || loading}
            data-testid="compiler-load-button"
          >
            {t('compiler.load')}
          </Button>
        </div>

        {loadError ? (
          <p className={styles.error} role="alert" data-testid="compiler-load-error">
            {loadError}
          </p>
        ) : null}

        {validation ? (
          <p
            className={validation.valid ? styles.statusOk : styles.statusError}
            data-testid="compiler-validation-status"
          >
            {validation.valid ? t('compiler.validation.valid') : t('compiler.validation.invalid')}
          </p>
        ) : loadedRoot ? (
          <p className={styles.statusMuted}>{t('compiler.validation.pending')}</p>
        ) : null}

        {validationRows.length > 0 ? (
          <div className={styles.subsection}>
            <h2 className={styles.subsectionTitle}>
              {t('compiler.diagnosticsTitle', { count: validationRows.length })}
            </h2>
            <ul className={styles.diagnosticList} data-testid="compiler-validation-diagnostics">
              {validationRows.map((row, index) => (
                <li key={`${row.code}-${index}`} className={styles.diagnosticItem}>
                  <VisuallyHidden>{row.severity}: </VisuallyHidden>
                  <span className={styles.diagnosticCode}>{row.code}</span>
                  <span className={styles.diagnosticMessage}>{row.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className={styles.card} hidden={!loadedRoot}>
        <div className={styles.field}>
          <label htmlFor="application-compiler-target" className={styles.fieldLabel}>
            {t('compiler.targetsLabel')}
          </label>
          {targets.length > 0 ? (
            <Select
              id="application-compiler-target"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              disabled={runActive}
              data-testid="compiler-target-select"
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {`${target.id} · ${target.version}`}
                </option>
              ))}
            </Select>
          ) : (
            <p className={styles.statusMuted} data-testid="compiler-targets-empty">
              {t('compiler.targetsEmpty')}
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <Button
            onClick={() => void handlePlan()}
            disabled={!loadedRoot || !targetId || planning || runActive}
            data-testid="compiler-plan-button"
          >
            {t('compiler.planButton')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCompile()}
            disabled={!loadedRoot || !targetId || compiling || runActive}
            data-testid="compiler-compile-button"
          >
            {t('compiler.compileButton')}
          </Button>
        </div>

        {planError ? (
          <p className={styles.error} role="alert" data-testid="compiler-plan-error">
            {planError}
          </p>
        ) : null}
        {compileError ? (
          <p className={styles.error} role="alert" data-testid="compiler-compile-error">
            {compileError}
          </p>
        ) : null}

        {plan ? (
          <div className={styles.subsection} data-testid="compiler-plan-summary">
            <h2 className={styles.subsectionTitle}>{t(PLAN_STATUS_KEYS[plan.status])}</h2>
            {plan.planHash ? (
              <p className={styles.hashLine}>
                <span className={styles.fieldLabel}>{t('compiler.planHash')}</span>{' '}
                <code className={styles.hash}>{plan.planHash}</code>
              </p>
            ) : null}
            {planSummary && plan.plan ? (
              <>
                <dl className={styles.countGrid} data-testid="compiler-plan-counts">
                  <div><dt>{t('compiler.planCreates')}</dt><dd>{planSummary.creates}</dd></div>
                  <div><dt>{t('compiler.planModifies')}</dt><dd>{planSummary.modifies}</dd></div>
                  <div><dt>{t('compiler.planDeletes')}</dt><dd>{planSummary.deletes}</dd></div>
                  <div><dt>{t('compiler.planReuses')}</dt><dd>{planSummary.reuses}</dd></div>
                  <div><dt>{t('compiler.planConflicts')}</dt><dd>{planSummary.conflicts}</dd></div>
                  <div><dt>{t('compiler.planUnresolved')}</dt><dd>{planSummary.unresolved}</dd></div>
                </dl>
                <p className={styles.permissionLine}>
                  <span className={styles.fieldLabel}>{t('compiler.planPermissions')}</span>{' '}
                  {plan.plan.permissionsRequired.length > 0
                    ? plan.plan.permissionsRequired.join(', ')
                    : '—'}
                </p>
                <p className={styles.permissionLine}>
                  <span className={styles.fieldLabel}>{t('compiler.planVerification')}</span>{' '}
                  {plan.plan.verificationPlanned.length > 0
                    ? plan.plan.verificationPlanned.map((step) => step.name).join(', ')
                    : t('compiler.planNoVerification')}
                </p>
                {plan.plan.conflicts.length > 0 ? (
                  <div className={styles.subsection}>
                    <h3 className={styles.subsectionTitle}>{t('compiler.conflictsTitle')}</h3>
                    <ul className={styles.conflictList} data-testid="compiler-plan-conflicts">
                      {plan.plan.conflicts.map((conflict) => (
                        <li key={conflict.path} className={styles.conflictItem}>
                          <code className={styles.path}>{conflict.path}</code>
                          <span className={styles.conflictClass}>{conflict.classification}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className={styles.statusMuted}>{t('compiler.conflictsEmpty')}</p>
                )}
              </>
            ) : null}
            {plan.diagnostics.length > 0 ? (
              <ul className={styles.diagnosticList} data-testid="compiler-plan-diagnostics">
                {diagnosticRows(plan.diagnostics).map((row, index) => (
                  <li key={`${row.code}-${index}`} className={styles.diagnosticItem}>
                    <VisuallyHidden>{row.severity}: </VisuallyHidden>
                    <span className={styles.diagnosticCode}>{row.code}</span>
                    <span className={styles.diagnosticMessage}>{row.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {run ? (
        <div className={styles.card} data-testid="compiler-run-section">
          <div className={styles.runHeader}>
            <p className={styles.runStatus} aria-live="polite" data-testid="compiler-run-status">
              {t(STATUS_KEYS[run.status])}
            </p>
            <p className={styles.runMeta}>
              <span>{t('compiler.runIdLabel')}: <code className={styles.hash}>{run.runId}</code></span>
              <span>{t('compiler.phaseLabel')}: {t(PHASE_KEYS[run.phase])}</span>
            </p>
          </div>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label={t('compiler.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={run.progress}
            data-testid="compiler-progress"
          >
            <div className={styles.progressFill} style={{ width: `${run.progress}%` }} />
          </div>
          <span className={styles.statusMuted} data-testid="compiler-progress-value">
            {t('compiler.progressLabel')} {run.progress}%
          </span>
          {runActive ? (
            <div className={styles.actions}>
              <Button onClick={() => void handleCancel()} data-testid="compiler-cancel-button">
                {t('compiler.cancelButton')}
              </Button>
            </div>
          ) : null}

          {verification ? (
            <p
              className={verification === 'passed' ? styles.statusOk : styles.statusError}
              data-testid="compiler-verification-outcome"
            >
              {verification === 'passed'
                ? t('compiler.verification.passed')
                : t('compiler.verification.failed')}
            </p>
          ) : null}

          {evidence.length > 0 ? (
            <div className={styles.subsection}>
              <h2 className={styles.subsectionTitle}>{t('compiler.evidenceTitle')}</h2>
              <dl className={styles.evidenceList} data-testid="compiler-evidence-list">
                {evidence.map((entry) => (
                  <div key={entry.key} className={styles.evidenceRow}>
                    <dt>{t(EVIDENCE_KEYS[entry.key])}</dt>
                    <dd><code className={styles.path}>{entry.path}</code></dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {runDiagnostics.length > 0 ? (
            <div className={styles.subsection}>
              <h2 className={styles.subsectionTitle}>
                {t('compiler.diagnosticsTitle', { count: runDiagnostics.length })}
              </h2>
              <ul className={styles.diagnosticList} data-testid="compiler-run-diagnostics">
                {runDiagnostics.map((row, index) => (
                  <li key={`${row.code}-${index}`} className={styles.diagnosticItem}>
                    <VisuallyHidden>{row.severity}: </VisuallyHidden>
                    <span className={styles.diagnosticCode}>{row.code}</span>
                    <span className={styles.diagnosticMessage}>{row.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {approvalConflict || awaitingApproval ? (
            <div className={styles.approveBlock} data-testid="compiler-approve-block">
              {awaitingApproval ? (
                <p className={styles.statusMuted} data-testid="compiler-awaiting-approval">
                  {t('compiler.awaitingApprovalNotice')}{' '}
                  <code className={styles.hash}>{run.planHash}</code>
                </p>
              ) : null}
              <Button
                variant="primary"
                onClick={() => void handleApprove()}
                data-testid="compiler-approve-button"
              >
                {t('compiler.approveButton')}
              </Button>
              {approveState === 'approved' ? (
                <p className={styles.statusOk} role="status">{t('compiler.approvedNotice')}</p>
              ) : null}
              {approveState === 'stale-plan' ? (
                <div className={styles.staleNotice} role="alert" data-testid="compiler-approve-stale">
                  <p className={styles.error}>{t('compiler.approveStale')}</p>
                  <Button
                    onClick={() => void handlePlan()}
                    disabled={!loadedRoot || !targetId || planning || runActive}
                    data-testid="compiler-replan-button"
                  >
                    {t('compiler.replanButton')}
                  </Button>
                </div>
              ) : null}
              {approveState === 'error' ? (
                <p className={styles.error} role="alert">{t('compiler.approveError')}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
