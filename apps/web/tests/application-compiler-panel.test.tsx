// @vitest-environment jsdom
//
// Application Compiler panel (spec §11.4) — core flow against a stubbed
// daemon HTTP surface: Load (targets + validate) → Create plan → Compile
// with the polling floor (jsdom has no EventSource, which is exactly the
// transport the poll fallback exists for) → terminal evidence, plus the
// hash-bound approve path where a 409 PLAN_HASH_MISMATCH must surface as a
// stale-plan message with a Re-plan affordance.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompilerPlanResult,
  CompilerRunStatus,
  CompilerTargetInfo,
  CompilerValidationResult,
} from '@open-design/contracts';
import { ApplicationCompilerPanel } from '../src/features/application-compiler/ApplicationCompilerPanel';
import {
  acceptRunStatus,
  classifyApproveError,
  isApprovalConflictRun,
  isAwaitingApprovalRun,
  isRunActive,
  parseCompilerRunEvent,
  planSummaryCounts,
  verificationOutcome,
} from '../src/features/application-compiler/run-flow';
import { CompilerApiError } from '../src/features/application-compiler/compiler-api';

const TARGETS: CompilerTargetInfo[] = [
  {
    id: 'html-static',
    version: '1.0.0',
    kind: 'frontend',
    features: ['static-html'],
    limitations: [],
  },
];

function runStatus(overrides: Partial<CompilerRunStatus> = {}): CompilerRunStatus {
  return {
    runId: 'run-1',
    status: 'queued',
    phase: 'idle',
    progress: 0,
    diagnostics: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const PLAN_SUCCEEDED: CompilerPlanResult = {
  status: 'succeeded',
  diagnostics: [],
  plan: {
    planHash: 'hash-plan-1',
    targetId: 'html-static',
    creates: ['generated/index.html', 'generated/app.js'],
    modifies: ['generated/styles.css'],
    deletes: [],
    reuses: ['generated/vendor.js'],
    conflicts: [],
    unresolved: [],
    degradations: [],
    permissionsRequired: ['fs.write:generated'],
    commandsProposed: [],
    verificationPlanned: [
      { name: 'link-check', command: { executable: 'node', argv: ['check-links.js'] } },
    ],
  },
  planHash: 'hash-plan-1',
  evidenceRefs: { planPath: '/proj/compiler/plans/plan-1.json' },
};

const PLAN_CONFLICTED: CompilerPlanResult = {
  status: 'conflicted',
  diagnostics: [],
  plan: {
    ...PLAN_SUCCEEDED.plan!,
    conflicts: [{ path: 'generated/manual.html', classification: 'manual-edits' }],
  },
  planHash: 'hash-plan-1',
  evidenceRefs: { planPath: '/proj/compiler/plans/plan-1.json' },
};

interface StubState {
  plan: CompilerPlanResult;
  run: CompilerRunStatus;
  approveStatus: number;
}

interface Stub {
  state: StubState;
  calls: Array<{ method: string; pathname: string; body: unknown }>;
}

function installFetchStub(initial: StubState): Stub {
  const stub: Stub = { state: initial, calls: [] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://daemon.local');
    const method = init?.method ?? 'GET';
    stub.calls.push({
      method,
      pathname: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === 'GET' && url.pathname === '/api/compiler/targets') {
      return respond(TARGETS);
    }
    if (method === 'POST' && url.pathname === '/api/compiler/validate') {
      const valid: CompilerValidationResult = {
        valid: stub.state.plan.status !== 'failed-validation',
        diagnostics: [],
        diagnosticsPath: '/proj/compiler/diagnostics/validate-1.json',
      };
      return respond(valid);
    }
    if (method === 'POST' && url.pathname === '/api/compiler/plan') {
      return respond(stub.state.plan);
    }
    if (method === 'POST' && url.pathname === '/api/compiler/runs') {
      return respond({ runId: stub.state.run.runId, status: stub.state.run });
    }
    const runMatch = url.pathname.match(/^\/api\/compiler\/runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      return respond(stub.state.run);
    }
    const runActionMatch = url.pathname.match(/^\/api\/compiler\/runs\/([^/]+)\/(cancel|approve)$/);
    if (method === 'POST' && runActionMatch?.[2] === 'cancel') {
      return respond(runStatus({ ...stub.state.run, status: 'cancelled' }));
    }
    if (method === 'POST' && runActionMatch?.[2] === 'approve') {
      if (stub.state.approveStatus !== 200) {
        return respond(
          {
            error: {
              code: 'PLAN_HASH_MISMATCH',
              message: 'Plan hash mismatch for run run-1.',
            },
          },
          stub.state.approveStatus,
        );
      }
      return respond(runStatus({ ...stub.state.run, approvedPlanHash: 'hash-plan-1' }));
    }
    return respond({ error: { code: 'NOT_FOUND', message: 'no route' } }, 404);
  }) as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  return stub;
}

function respond(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response;
}

async function loadProject(root = '/proj') {
  fireEvent.change(screen.getByTestId('compiler-project-root'), {
    target: { value: root },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId('compiler-load-button'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ApplicationCompilerPanel', () => {
  it('loads targets and the validation verdict, then shows the plan summary', async () => {
    installFetchStub({ plan: PLAN_SUCCEEDED, run: runStatus(), approveStatus: 200 });
    render(<ApplicationCompilerPanel />);

    expect(screen.getByText('Application Compiler')).toBeTruthy();

    await loadProject();

    // Target selector populated from GET /api/compiler/targets.
    const select = screen.getByTestId('compiler-target-select') as HTMLSelectElement;
    expect(select.value).toBe('html-static');
    // Validation verdict from POST /api/compiler/validate.
    expect(screen.getByTestId('compiler-validation-status').textContent).toBe(
      'Validation passed',
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-plan-button'));
    });

    expect(screen.getByText('Plan created')).toBeTruthy();
    expect(screen.getByText('hash-plan-1')).toBeTruthy();
    const counts = screen.getByTestId('compiler-plan-counts');
    expect(counts.textContent).toContain('Creates');
    expect(counts.textContent).toContain('2');
    expect(counts.textContent).toContain('1');
    expect(screen.getByText('link-check')).toBeTruthy();
    expect(screen.getByText('fs.write:generated')).toBeTruthy();
    expect(screen.getByText('No conflicts.')).toBeTruthy();
  });

  it('follows the compile run through the polling floor to a succeeded terminal state with evidence', async () => {
    const stub = installFetchStub({
      plan: PLAN_SUCCEEDED,
      run: runStatus({ status: 'writing', phase: 'write', progress: 60 }),
      approveStatus: 200,
    });
    render(<ApplicationCompilerPanel />);
    await loadProject();
    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-plan-button'));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-compile-button'));
    });

    // Run started: progress visible, cancel available, plan/compile locked.
    expect(screen.getByTestId('compiler-run-status').textContent).toBe('Writing');
    expect(
      (screen.getByTestId('compiler-progress') as HTMLElement).getAttribute('aria-valuenow'),
    ).toBe('60');
    expect(screen.getByTestId('compiler-cancel-button')).toBeTruthy();
    expect((screen.getByTestId('compiler-plan-button') as HTMLButtonElement).disabled).toBe(true);

    stub.state.run = runStatus({
      status: 'verifying',
      phase: 'verification',
      progress: 80,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId('compiler-run-status').textContent).toBe('Verifying');

    stub.state.run = runStatus({
      status: 'succeeded',
      phase: 'idle',
      progress: 100,
      completedAt: '2026-01-01T00:00:05.000Z',
      evidenceRefs: {
        manifestPath: '/proj/generated/html-static/manifest.json',
        planPath: '/proj/generated/html-static/plan.json',
        evidencePath: '/proj/compiler/evidence/run-1.verification.json',
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByTestId('compiler-run-status').textContent).toBe('Succeeded');
    expect(screen.getByTestId('compiler-verification-outcome').textContent).toBe(
      'Verification passed',
    );
    const evidence = screen.getByTestId('compiler-evidence-list');
    expect(evidence.textContent).toContain('/proj/generated/html-static/manifest.json');
    expect(evidence.textContent).toContain('/proj/compiler/evidence/run-1.verification.json');
    // Terminal: cancel affordance gone, poll stopped (no further run reads).
    expect(screen.queryByTestId('compiler-cancel-button')).toBeNull();
    const runReads = stub.calls.filter(
      (call) => call.method === 'GET' && call.pathname === '/api/compiler/runs/run-1',
    ).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const runReadsAfter = stub.calls.filter(
      (call) => call.method === 'GET' && call.pathname === '/api/compiler/runs/run-1',
    ).length;
    expect(runReadsAfter).toBe(runReads);
  });

  it('surfaces a 409 approve as a stale-plan message with a re-plan affordance', async () => {
    const stub = installFetchStub({
      plan: PLAN_CONFLICTED,
      run: runStatus({
        status: 'failed',
        phase: 'planning',
        progress: 30,
        planHash: 'hash-plan-1',
        diagnostics: [
          {
            code: 'file_conflicts',
            message: 'Compile blocked: Unresolved conflicts in manual files.',
            severity: 'error',
            phase: 'planning',
          },
        ],
        completedAt: '2026-01-01T00:00:03.000Z',
      }),
      approveStatus: 409,
    });
    render(<ApplicationCompilerPanel />);
    await loadProject();
    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-plan-button'));
    });
    // Conflicted plan still shows its conflict list (spec §11.4).
    const conflicts = screen.getByTestId('compiler-plan-conflicts');
    expect(conflicts.textContent).toContain('generated/manual.html');

    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-compile-button'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Failed-on-conflict run with a plan hash → approve affordance.
    expect(screen.getByTestId('compiler-run-status').textContent).toBe('Failed');
    expect(screen.getByTestId('compiler-approve-block')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-approve-button'));
    });

    const approveCall = stub.calls.find(
      (call) => call.method === 'POST' && call.pathname === '/api/compiler/runs/run-1/approve',
    );
    expect(approveCall?.body).toEqual({ planHash: 'hash-plan-1' });
    expect(screen.getByTestId('compiler-approve-stale').textContent).toContain(
      'no longer current',
    );
    expect(screen.getByTestId('compiler-replan-button')).toBeTruthy();

    const plansBefore = stub.calls.filter(
      (call) => call.method === 'POST' && call.pathname === '/api/compiler/plan',
    ).length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-replan-button'));
    });
    const plansAfter = stub.calls.filter(
      (call) => call.method === 'POST' && call.pathname === '/api/compiler/plan',
    ).length;
    expect(plansAfter).toBe(plansBefore + 1);
  });

  it('renders awaiting_approval with the plan hash and approves with resolution force, then follows the resumed run', async () => {
    const stub = installFetchStub({
      plan: PLAN_SUCCEEDED,
      run: runStatus({
        status: 'awaiting_approval',
        phase: 'planning',
        progress: 50,
        planHash: 'hash-plan-1',
        diagnostics: [
          {
            code: 'approval_required',
            message: "Conflict resolution 'force' would overwrite manually-changed generated file(s).",
            severity: 'advisory',
            phase: 'planning',
          },
        ],
      }),
      approveStatus: 200,
    });
    render(<ApplicationCompilerPanel />);
    await loadProject();
    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-plan-button'));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-compile-button'));
    });

    // Paused state: status label, plan hash, approve + cancel affordances
    // (awaiting_approval is not terminal — the panel keeps following).
    expect(screen.getByTestId('compiler-run-status').textContent).toBe('Awaiting approval');
    const awaiting = screen.getByTestId('compiler-awaiting-approval');
    expect(awaiting.textContent).toContain('Paused before writing');
    expect(awaiting.textContent).toContain('hash-plan-1');
    expect(screen.getByTestId('compiler-approve-block')).toBeTruthy();
    expect(screen.getByTestId('compiler-cancel-button')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('compiler-approve-button'));
    });

    // The approve call names resolution 'force' for a paused run.
    const approveCall = stub.calls.find(
      (call) => call.method === 'POST' && call.pathname === '/api/compiler/runs/run-1/approve',
    );
    expect(approveCall?.body).toEqual({ planHash: 'hash-plan-1', resolution: 'force' });
    expect(screen.getByText('Plan approved.')).toBeTruthy();

    // Daemon resumed the run: the polling floor picks the progress back up.
    stub.state.run = runStatus({ status: 'writing', phase: 'write', progress: 60 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByTestId('compiler-run-status').textContent).toBe('Writing');
  });
});

describe('run-flow helpers', () => {
  it('parses only well-shaped run events', () => {
    expect(parseCompilerRunEvent(null)).toBeNull();
    expect(parseCompilerRunEvent({ type: 'progress' })).toBeNull();
    expect(parseCompilerRunEvent({ type: 'progress', data: { runId: 'r' } })).toBeNull();
    const run = runStatus({ status: 'writing', progress: 60 });
    expect(parseCompilerRunEvent({ type: 'progress', data: run })).toEqual({
      type: 'progress',
      run,
    });
  });

  it('rejects frames from another run or after a terminal state', () => {
    const run = runStatus({ status: 'writing' });
    expect(acceptRunStatus(null, run)).toBe(true);
    expect(acceptRunStatus(run, runStatus({ status: 'succeeded' }))).toBe(true);
    expect(
      acceptRunStatus(runStatus({ runId: 'other' }), run),
    ).toBe(false);
    expect(
      acceptRunStatus(runStatus({ status: 'cancelled' }), runStatus({ status: 'writing' })),
    ).toBe(false);
  });

  it('treats awaiting_approval as a valid, non-terminal, followable state', () => {
    const awaiting = runStatus({ status: 'awaiting_approval', planHash: 'hash-plan-1' });
    // SSE frames carrying the pause state parse and are accepted.
    expect(parseCompilerRunEvent({ type: 'awaiting_approval', data: awaiting })).toEqual({
      type: 'awaiting_approval',
      run: awaiting,
    });
    expect(acceptRunStatus(runStatus({ status: 'validating' }), awaiting)).toBe(true);
    // Not terminal: the panel keeps following, and approve/cancel apply.
    expect(isRunActive(awaiting)).toBe(true);

    expect(isAwaitingApprovalRun(awaiting)).toBe(true);
    expect(isAwaitingApprovalRun(runStatus({ status: 'awaiting_approval' }))).toBe(false);
    expect(isAwaitingApprovalRun(runStatus({ status: 'failed', planHash: 'hash-plan-1' }))).toBe(false);
    expect(isAwaitingApprovalRun(null)).toBe(false);
  });

  it('classifies approve errors by HTTP status', () => {
    expect(classifyApproveError(new CompilerApiError(409, 'PLAN_HASH_MISMATCH', 'x'))).toBe(
      'stale-plan',
    );
    expect(classifyApproveError(new CompilerApiError(404, 'NOT_FOUND', 'x'))).toBe('error');
    expect(classifyApproveError(new Error('network'))).toBe('error');
  });

  it('derives the approval-conflict, verification, and count projections', () => {
    expect(isApprovalConflictRun(null)).toBe(false);
    expect(isApprovalConflictRun(runStatus({ status: 'failed' }))).toBe(false);
    const conflicted = runStatus({
      status: 'failed',
      planHash: 'h',
      diagnostics: [
        { code: 'file_conflicts', message: 'm', severity: 'error', phase: 'planning' },
      ],
    });
    expect(isApprovalConflictRun(conflicted)).toBe(true);

    expect(verificationOutcome(runStatus({ status: 'writing' }))).toBeNull();
    expect(verificationOutcome(runStatus({ status: 'succeeded' }))).toBe('passed');
    expect(
      verificationOutcome(
        runStatus({
          status: 'failed',
          diagnostics: [
            { code: 'verification_failed', message: 'm', severity: 'error', phase: 'verification' },
          ],
        }),
      ),
    ).toBe('failed');

    expect(planSummaryCounts(PLAN_SUCCEEDED.plan!)).toEqual({
      creates: 2,
      modifies: 1,
      deletes: 0,
      reuses: 1,
      conflicts: 0,
      unresolved: 0,
    });
  });
});
