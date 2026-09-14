/**
 * Compiler recovery cases (spec §13 "Required recovery cases" + §14.1 class 9
 * cancellation) — the rows this iteration adds:
 *
 * - Cancel during planning.
 * - Cancel during verification.
 * - Stale approval rejected after a source change (extends the plain
 *   hash-mismatch 409 in compiler-routes.test.ts with a
 *   changed-IR-then-replan flow).
 *
 * (Failed file commit rollback lives in compiler-project-writer.test.ts.)
 *
 * Why these are state-machine assertions, not wall-clock races: a guestbook
 * html-static compile finishes in well under a second, so racing
 * POST /cancel against a live 'planning'/'verification' phase would be a
 * sleep-flavored coin flip that lands in whichever phase happens to be active.
 * §14.1's required behavior ("stop future phases, record cancelled") is a
 * state-machine property: whatever phase a run is in when cancel lands, the
 * same transition must fire. Each test pins a run record into the exact phase
 * through runPersistence (the same store executeRun writes every phase
 * transition through) and cancels via compilerService.cancel — the identical
 * code path POST /api/compiler/runs/:id/cancel delegates to — asserting the
 * terminal status, the cancelled metrics counter, and the run_terminal
 * structured log. A live race would add no assertion these do not make.
 *
 * Metrics are process-wide module state: this file owns its own daemon server
 * and only its own requests drive compiles against it (vitest isolates each
 * test file into a fresh module registry).
 */
import type http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/server.js';
import { compilerService } from '../src/compiler/compiler-service.js';
import { runPersistence } from '../src/compiler/run-persistence.js';
import { runMetrics } from '../src/compiler/run-metrics.js';
import type { CompilerRunStatus } from '@open-design/contracts';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

const guestbookRoot = fileURLToPath(new URL('../../../examples/guestbook', import.meta.url));
const jsonHeaders = { 'Content-Type': 'application/json' };
const tempProjectRoots: string[] = [];

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

async function getMetrics(): Promise<any> {
  const resp = await fetch(`${baseUrl}/api/compiler/metrics`);
  expect(resp.status).toBe(200);
  return resp.json();
}

async function waitForRunCompletion(runId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resp = await fetch(`${baseUrl}/api/compiler/runs/${runId}`);
    expect(resp.status).toBe(200);
    const run = await resp.json() as any;
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`compiler run ${runId} did not reach a terminal status within ${timeoutMs}ms (last: ${run.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Fresh guestbook copy (no generated/ or compiler/ output) in a temp dir. */
function makeTempGuestbook(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.copyFileSync(path.join(guestbookRoot, 'application.ir.json'), path.join(dir, 'application.ir.json'));
  fs.copyFileSync(path.join(guestbookRoot, 'projection.config.json'), path.join(dir, 'projection.config.json'));
  fs.cpSync(path.join(guestbookRoot, 'ir'), path.join(dir, 'ir'), { recursive: true });
  tempProjectRoots.push(dir);
  return dir;
}

/**
 * Pin a non-terminal run record into `phase`/`status`, mirroring exactly what
 * executeRun's emitPhase persists at that point in the pipeline, and start the
 * run's phase timer so cancel's phase-duration capture has a live phase to
 * close.
 */
function pinRunInPhase(runId: string, phase: CompilerRunStatus['phase'], status: CompilerRunStatus['status']): void {
  runPersistence.save({
    runId,
    status,
    phase,
    progress: phase === 'planning' ? 50 : 80,
    diagnostics: [],
    startedAt: new Date().toISOString(),
  });
  runMetrics.beginPhase(runId, phase);
}

function terminalLogLines(spy: { mock: { calls: unknown[][] } }, runId: string): any[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === 'string')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (parsed) =>
        parsed !== null &&
        parsed.namespace === 'compiler' &&
        parsed.event === 'run_terminal' &&
        parsed.compiler_run_id === runId
    );
}

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
}, 120_000);

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of tempProjectRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('cancel during planning / verification (spec §13, §14.1 class 9)', () => {
  it.each([
    { phase: 'planning', status: 'planning', runId: 'rec-cancel-planning' },
    { phase: 'verification', status: 'verifying', runId: 'rec-cancel-verification' },
  ] as const)(
    'cancelling a run in the $phase phase records cancelled, counts the metric once, and logs run_terminal',
    async ({ phase, status, runId }) => {
      pinRunInPhase(runId, phase, status);
      const before = await getMetrics();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const run = compilerService.cancel(runId);
        expect(run.status).toBe('cancelled');
        expect(run.completedAt).toBeTruthy();
        // The open phase timer was closed into the run record.
        expect(typeof run.phaseDurationsMs?.[phase]).toBe('number');
        expect(run.phaseDurationsMs![phase]).toBeGreaterThanOrEqual(0);
        // The persisted record carries the same terminal state.
        expect(runPersistence.get(runId)?.status).toBe('cancelled');

        // Cancelled terminal counted exactly once; a second cancel is a no-op.
        compilerService.cancel(runId);

        const after = await getMetrics();
        expect(after.runsByTerminalStatus.cancelled).toBe((before.runsByTerminalStatus.cancelled ?? 0) + 1);
        // Cancelled runs say nothing about target success and must not pollute it.
        expect(after.targetSuccessRate).toEqual(before.targetSuccessRate);

        const terminals = terminalLogLines(logSpy, runId);
        expect(terminals.length).toBe(1);
        expect(terminals[0].terminal_status).toBe('cancelled');
        expect(terminals[0].phase).toBe(phase);
        expect(typeof terminals[0].duration_ms).toBe('number');
      } finally {
        logSpy.mockRestore();
      }
    },
    60_000,
  );

  it('POST /runs/:id/cancel cancels an in-flight-shaped run and 404s for unknown ids', async () => {
    pinRunInPhase('rec-route-cancel', 'planning', 'planning');
    const before = await getMetrics();

    const resp = await postJson(`${baseUrl}/api/compiler/runs/rec-route-cancel/cancel`, {});
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.status).toBe('cancelled');
    expect(body.completedAt).toBeTruthy();

    const after = await getMetrics();
    expect(after.runsByTerminalStatus.cancelled).toBe((before.runsByTerminalStatus.cancelled ?? 0) + 1);

    const unknown = await postJson(`${baseUrl}/api/compiler/runs/no-such-recovery-run/cancel`, {});
    expect(unknown.status).toBe(404);
    expect(await getMetrics()).toEqual(after);
  }, 60_000);
});

describe('stale approval after a source change (spec §13, §14.2)', () => {
  it('rejects an approval bound to the pre-change plan hash with 409 after the IR changed and replanned', async () => {
    const projectRoot = makeTempGuestbook('od-compiler-rec-stale-');

    // Plan A on the untouched project: index.html is classified as a create.
    const planAResp = await postJson(`${baseUrl}/api/compiler/plan`, {
      projectRoot,
      targetId: 'html-static',
    });
    expect(planAResp.status).toBe(200);
    const planA = await planAResp.json() as any;
    expect(planA.status).toBe('succeeded');
    expect(planA.planHash).toMatch(/^sha256:/);

    // Compile once so generated/html-static (manifest + index.html) exists.
    const start1 = await postJson(`${baseUrl}/api/compiler/runs`, {
      projectRoot,
      targetId: 'html-static',
      runId: 'rec-stale-run1',
    });
    expect(start1.status).toBe(200);
    const run1 = await waitForRunCompletion('rec-stale-run1');
    expect(run1.status).toBe('succeeded');
    expect(run1.planHash).toBe(planA.planHash);

    // Source change: the bundle name flows into the emitted index.html
    // (<title>/<h1>), so the next plan reclassifies index.html from
    // create/reuse to modify — the plan hash moves even though the emitted
    // file-path set itself is unchanged.
    const bundlePath = path.join(projectRoot, 'application.ir.json');
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    bundle.name = 'Guestbook (renamed for stale-approval recovery)';
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');

    const planBResp = await postJson(`${baseUrl}/api/compiler/plan`, {
      projectRoot,
      targetId: 'html-static',
    });
    expect(planBResp.status).toBe(200);
    const planB = await planBResp.json() as any;
    expect(planB.status).toBe('succeeded');
    expect(planB.planHash).toMatch(/^sha256:/);
    expect(planB.planHash).not.toBe(planA.planHash);
    expect(planB.plan.modifies).toContain('index.html');

    // A compile of the changed source plans the post-change hash…
    const start2 = await postJson(`${baseUrl}/api/compiler/runs`, {
      projectRoot,
      targetId: 'html-static',
      runId: 'rec-stale-run2',
    });
    expect(start2.status).toBe(200);
    const run2 = await waitForRunCompletion('rec-stale-run2');
    expect(run2.status).toBe('succeeded');
    expect(run2.planHash).toBe(planB.planHash);

    // …so the approval the caller captured before the source change is stale.
    const staleResp = await postJson(`${baseUrl}/api/compiler/runs/rec-stale-run2/approve`, {
      planHash: planA.planHash,
    });
    expect(staleResp.status).toBe(409);
    const staleBody = await staleResp.json() as any;
    expect(staleBody.error.code).toBe('PLAN_HASH_MISMATCH');

    // Control: approving the hash the run actually planned still succeeds.
    const freshResp = await postJson(`${baseUrl}/api/compiler/runs/rec-stale-run2/approve`, {
      planHash: run2.planHash,
    });
    expect(freshResp.status).toBe(200);
    const fresh = await freshResp.json() as any;
    expect(fresh.approvedPlanHash).toBe(run2.planHash);
  }, 240_000);
});
