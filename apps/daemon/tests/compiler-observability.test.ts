/**
 * Compiler observability (spec §12.3 "Logs, Metrics, and Traces"):
 * - `GET /api/compiler/metrics` exposes the in-memory aggregate snapshot;
 * - a completed run carries `phaseDurationsMs`;
 * - failed runs increment the failed counter and emit a structured
 *   `run_terminal` JSON log line with the §12.3 context fields;
 * - cancelling a run mid-flight increments the cancelled counter exactly once.
 *
 * Metrics are process-wide module state: this file owns its own daemon
 * server and must stay the only file whose requests drive compiles against
 * it (vitest isolates each test file into a fresh module registry).
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

/**
 * Fresh guestbook copy without `generated/` or `compiler/` output, so the
 * first compile is a clean create-everything run and the second is a
 * deterministic no-op recompile.
 */
function makeTempGuestbook(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.copyFileSync(path.join(guestbookRoot, 'application.ir.json'), path.join(dir, 'application.ir.json'));
  fs.copyFileSync(path.join(guestbookRoot, 'projection.config.json'), path.join(dir, 'projection.config.json'));
  fs.cpSync(path.join(guestbookRoot, 'ir'), path.join(dir, 'ir'), { recursive: true });
  tempProjectRoots.push(dir);
  return dir;
}

const PHASE_KEYS = ['validation', 'lowering', 'planning', 'write', 'verification'];

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

describe('compiler observability (spec §12.3)', () => {
  it('GET /api/compiler/metrics returns the empty snapshot shape before any run', async () => {
    const snapshot = await getMetrics();
    expect(snapshot).toEqual({
      runsByTerminalStatus: {},
      phaseDurationsMs: {},
      targetSuccessRate: {},
      noopRate: { noops: 0, recompiles: 0 },
      conflictCount: 0,
      degradedSemanticCount: 0,
      verificationFailureCategory: {},
    });
  }, 60_000);

  it('a guestbook html-static compile is fully reflected in metrics and phaseDurationsMs', async () => {
    const projectRoot = makeTempGuestbook('od-compiler-obs-success-');
    const startResp = await postJson(`${baseUrl}/api/compiler/runs`, {
      projectRoot,
      targetId: 'html-static',
      runId: 'obs-run-success',
    });
    expect(startResp.status).toBe(200);

    const run = await waitForRunCompletion('obs-run-success');
    expect(run.status).toBe('succeeded');

    // The completed run record carries per-phase durations for all five phases.
    expect(run.phaseDurationsMs).toBeTruthy();
    for (const phase of PHASE_KEYS) {
      expect(typeof run.phaseDurationsMs[phase]).toBe('number');
      expect(run.phaseDurationsMs[phase]).toBeGreaterThanOrEqual(0);
    }

    const snapshot = await getMetrics();
    expect(snapshot.runsByTerminalStatus).toEqual({ succeeded: 1 });
    expect(snapshot.targetSuccessRate['html-static']).toEqual({ succeeded: 1, total: 1 });
    for (const phase of PHASE_KEYS) {
      const stats = snapshot.phaseDurationsMs[phase];
      expect(stats, `phase ${phase} present in metrics`).toBeTruthy();
      expect(typeof stats.lastMs).toBe('number');
      expect(typeof stats.cumulativeMs).toBe('number');
      expect(stats.cumulativeMs).toBeGreaterThanOrEqual(0);
    }
    // First compile of a fresh project: real work, no conflicts/degradations.
    expect(snapshot.noopRate).toEqual({ noops: 0, recompiles: 1 });
    expect(snapshot.conflictCount).toBe(0);
    expect(snapshot.degradedSemanticCount).toBe(0);
    expect(snapshot.verificationFailureCategory).toEqual({});
  }, 180_000);

  it('recompiling an unchanged project counts as a deterministic no-op', async () => {
    // Reuse the project from the previous test via its evidence on disk: the
    // metrics tracker is keyed by target, not project, so a second fresh
    // project that is compiled twice proves the no-op rate the same way.
    const projectRoot = makeTempGuestbook('od-compiler-obs-noop-');
    for (const runId of ['obs-run-noop-1', 'obs-run-noop-2']) {
      const startResp = await postJson(`${baseUrl}/api/compiler/runs`, {
        projectRoot,
        targetId: 'html-static',
        runId,
      });
      expect(startResp.status).toBe(200);
      const run = await waitForRunCompletion(runId);
      expect(run.status).toBe('succeeded');
    }

    const snapshot = await getMetrics();
    // Two runs on this project plus the one from the previous test.
    expect(snapshot.runsByTerminalStatus).toEqual({ succeeded: 3 });
    expect(snapshot.noopRate).toEqual({ noops: 1, recompiles: 3 });
    expect(snapshot.targetSuccessRate['html-static']).toEqual({ succeeded: 3, total: 3 });
  }, 240_000);

  it('a 409 approve mismatch leaves the metrics snapshot untouched', async () => {
    const before = await getMetrics();
    const resp = await postJson(`${baseUrl}/api/compiler/runs/obs-run-success/approve`, {
      planHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(resp.status).toBe(409);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('PLAN_HASH_MISMATCH');

    const after = await getMetrics();
    expect(after).toEqual(before);
  }, 60_000);

  it('a failed validation increments the failed counter and logs a structured run_terminal line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-compiler-obs-invalid-'));
    tempProjectRoots.push(dir);
    fs.writeFileSync(
      path.join(dir, 'application.ir.json'),
      JSON.stringify({ schemaVersion: 'not-a-version' }),
      'utf8'
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const startResp = await postJson(`${baseUrl}/api/compiler/runs`, {
        projectRoot: dir,
        targetId: 'html-static',
        runId: 'obs-run-failed',
      });
      expect(startResp.status).toBe(200);
      const run = await waitForRunCompletion('obs-run-failed');
      expect(run.status).toBe('failed');
      expect(run.diagnostics.length).toBeGreaterThan(0);

      const terminalLines = logSpy.mock.calls
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
            parsed.compiler_run_id === 'obs-run-failed'
        );
      expect(terminalLines.length).toBe(1);
      const terminal = terminalLines[0];
      expect(terminal.project_id).toBe(dir);
      expect(terminal.target_id).toBe('html-static');
      expect(terminal.phase).toBe('validation');
      expect(typeof terminal.diagnostic_code).toBe('string');
      expect(terminal.diagnostic_code.length).toBeGreaterThan(0);
      expect(terminal.terminal_status).toBe('failed');
      expect(typeof terminal.duration_ms).toBe('number');

      const snapshot = await getMetrics();
      expect(snapshot.runsByTerminalStatus.failed).toBe(1);
      expect(snapshot.runsByTerminalStatus.succeeded).toBe(3);
      // No plan was produced, so the plan-evaluation (recompile) counter
      // must not have grown.
      expect(snapshot.noopRate.recompiles).toBe(3);
    } finally {
      logSpy.mockRestore();
    }
  }, 120_000);

  it('cancelling a non-terminal run counts cancelled exactly once and logs run_terminal', async () => {
    // A mid-flight HTTP cancel is inherently racy on a fast machine (the
    // whole guestbook compile can finish inside one HTTP round trip), so the
    // cancelled accounting is exercised deterministically at the service
    // boundary the route delegates to, plus the route tests below.
    const runId = 'obs-run-unit-cancel';
    runPersistence.save({
      runId,
      status: 'queued',
      phase: 'validation',
      progress: 0,
      diagnostics: [],
      startedAt: new Date().toISOString(),
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const run = compilerService.cancel(runId);
      expect(run.status).toBe('cancelled');
      expect(run.completedAt).toBeTruthy();

      let snapshot = await getMetrics();
      expect(snapshot.runsByTerminalStatus.cancelled).toBe(1);

      // A second cancel of the now-terminal run must not double count.
      compilerService.cancel(runId);
      snapshot = await getMetrics();
      expect(snapshot.runsByTerminalStatus.cancelled).toBe(1);

      const terminalLines = logSpy.mock.calls
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
      expect(terminalLines.length).toBe(1);
      expect(terminalLines[0].terminal_status).toBe('cancelled');
      expect(typeof terminalLines[0].duration_ms).toBe('number');
    } finally {
      logSpy.mockRestore();
    }
  }, 60_000);

  it('the cancel route delegates to the service without recounting terminal runs', async () => {
    const before = await getMetrics();

    // 'obs-run-success' finished earlier in this file: cancelling it exercises
    // the HTTP delegation while asserting a terminal run bumps nothing.
    const resp = await postJson(`${baseUrl}/api/compiler/runs/obs-run-success/cancel`, {});
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.status).toBe('cancelled');

    expect(await getMetrics()).toEqual(before);

    const unknownResp = await postJson(`${baseUrl}/api/compiler/runs/no-such-run/cancel`, {});
    expect(unknownResp.status).toBe(404);
    expect(await getMetrics()).toEqual(before);
  }, 60_000);
});
