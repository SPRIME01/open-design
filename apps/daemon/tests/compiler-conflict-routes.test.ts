// R2 — daemon conflict-resolution surface over HTTP (spec §10.6/§13/§14).
//
// One temp-copied guestbook project drives the whole force-approval state
// machine at the real `/api/compiler/*` boundary:
//
//   initial compile → manual edit of a compiler-owned file →
//   (a) force without approval pauses in awaiting_approval, bytes intact
//   (b) approving a wrong hash is 409 PLAN_HASH_MISMATCH
//   (c) approving the computed hash with resolution 'force' resumes and
//       overwrites with the deterministic compiled content, counted once
//   (d) force + approvedPlanHash from a prior /plan (same resolution)
//       proceeds directly, no pause
//   (e) config-only force (projection.config.json conflictPolicy) still
//       gates; awaiting_approval → cancelled works
//   (f) invalid conflictResolution is 400
//
// The invariant under test: no path silently overwrites a manually-changed
// compiler-owned file — force is only legal behind an approval bound to the
// pair {planHash, effectiveConflictResolution}.

import type http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

const guestbookRoot = fileURLToPath(new URL('../../../examples/guestbook', import.meta.url));
const jsonHeaders = { 'Content-Type': 'application/json' };

/** Fresh temp copy of the guestbook fixture (project + generated state). */
function copyGuestbook(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `od-compiler-force-${tag}-`));
  fs.cpSync(guestbookRoot, dir, { recursive: true });
  return dir;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

async function startRun(projectRoot: string, body: Record<string, unknown> = {}): Promise<string> {
  const resp = await postJson(`${baseUrl}/api/compiler/runs`, {
    projectRoot,
    targetId: 'html-static',
    ...body,
  });
  expect(resp.status).toBe(200);
  const started = await resp.json() as any;
  return started.runId as string;
}

/**
 * Poll a run until it stops: terminal (succeeded/failed/cancelled) or the
 * awaiting_approval pause. Anything else past the deadline fails the test.
 */
async function waitForRunStop(runId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resp = await fetch(`${baseUrl}/api/compiler/runs/${runId}`);
    expect(resp.status).toBe(200);
    const run = await resp.json() as any;
    if (
      run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
      || run.status === 'awaiting_approval'
    ) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`compiler run ${runId} did not stop within ${timeoutMs}ms (last: ${run.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function metricsSnapshot(): Promise<any> {
  const resp = await fetch(`${baseUrl}/api/compiler/metrics`);
  expect(resp.status).toBe(200);
  return resp.json() as any;
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
});

describe('conflict-resolution force gate (POST /api/compiler/runs)', () => {
  it(
    'gates force without approval, 409s a wrong hash, resumes on the right hash, and counts once',
    async () => {
      const projectRoot = copyGuestbook('flow');
      const indexPath = path.join(projectRoot, 'generated', 'html-static', 'index.html');

      // Initial plain compile reclaims any pre-existing state deterministically.
      const initialRunId = await startRun(projectRoot);
      const initialRun = await waitForRunStop(initialRunId);
      expect(initialRun.status).toBe('succeeded');
      const deterministicIndex = fs.readFileSync(indexPath, 'utf8');

      // Manual edit of a compiler-owned file: every subsequent compile sees
      // a CONFLICT_MODIFIED_GENERATED_FILE until force reclaims it.
      fs.writeFileSync(indexPath, `${deterministicIndex}\n<!-- manual edit -->`, 'utf8');
      const manualBytes = fs.readFileSync(indexPath, 'utf8');
      expect(manualBytes).toContain('<!-- manual edit -->');

      // (a) force without approval → awaiting_approval, no writes.
      const gatedRunId = await startRun(projectRoot, { conflictResolution: 'force' });
      const gated = await waitForRunStop(gatedRunId);
      expect(gated.status).toBe('awaiting_approval');
      expect(typeof gated.planHash).toBe('string');
      expect(gated.planHash).toMatch(/^sha256:/);
      expect(gated.completedAt).toBeUndefined();
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(manualBytes);
      const advisory = (gated.diagnostics ?? []).find((d: any) => d.code === 'approval_required');
      expect(advisory).toBeTruthy();
      expect(advisory.severity).toBe('advisory');
      expect(advisory.recommendedAction).toContain(
        `od app approve ${gatedRunId} --plan-hash ${gated.planHash} --resolution force`,
      );

      // (b) wrong hash → 409 PLAN_HASH_MISMATCH, run stays paused.
      const wrongResp = await postJson(`${baseUrl}/api/compiler/runs/${gatedRunId}/approve`, {
        planHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        resolution: 'force',
      });
      expect(wrongResp.status).toBe(409);
      expect(((await wrongResp.json()) as any).error.code).toBe('PLAN_HASH_MISMATCH');
      const stillGated = await (await fetch(`${baseUrl}/api/compiler/runs/${gatedRunId}`)).json() as any;
      expect(stillGated.status).toBe('awaiting_approval');
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(manualBytes);

      // (c) right hash + resolution force → resume → succeeded, overwritten
      // with the deterministic content, terminal metrics counted once.
      const succeededBefore = (await metricsSnapshot()).runsByTerminalStatus.succeeded ?? 0;
      const approveResp = await postJson(`${baseUrl}/api/compiler/runs/${gatedRunId}/approve`, {
        planHash: gated.planHash,
        resolution: 'force',
      });
      expect(approveResp.status).toBe(200);
      const approved = (await approveResp.json()) as any;
      expect(approved.approvedPlanHash).toBe(gated.planHash);

      const resumed = await waitForRunStop(gatedRunId);
      expect(resumed.status).toBe('succeeded');
      expect(resumed.approvedPlanHash).toBe(gated.planHash);
      expect(resumed.planHash).toBe(gated.planHash);
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(deterministicIndex);

      const metricsAfter = await metricsSnapshot();
      expect(metricsAfter.runsByTerminalStatus.succeeded).toBe(succeededBefore + 1);
    },
    300_000,
  );

  it(
    'proceeds directly when the create request carries the hash a force plan computed',
    async () => {
      const projectRoot = copyGuestbook('inline');
      const indexPath = path.join(projectRoot, 'generated', 'html-static', 'index.html');

      const initialRunId = await startRun(projectRoot);
      expect((await waitForRunStop(initialRunId)).status).toBe('succeeded');
      const deterministicIndex = fs.readFileSync(indexPath, 'utf8');
      fs.writeFileSync(indexPath, `${deterministicIndex}\n<!-- manual edit 2 -->`, 'utf8');

      // A prior /plan call with the SAME resolution produces the hash an
      // inline approval presents back.
      const planResp = await postJson(`${baseUrl}/api/compiler/plan`, {
        projectRoot,
        targetId: 'html-static',
        conflictResolution: 'force',
      });
      expect(planResp.status).toBe(200);
      const plan = (await planResp.json()) as any;
      expect(plan.status).toBe('succeeded');
      expect(plan.effectiveConflictResolution).toBe('force');
      expect(plan.planHash).toMatch(/^sha256:/);

      // (d) force + matching approvedPlanHash → no pause, straight to success.
      const runId = await startRun(projectRoot, {
        conflictResolution: 'force',
        approvedPlanHash: plan.planHash,
      });
      const run = await waitForRunStop(runId);
      expect(run.status).toBe('succeeded');
      expect(run.status).not.toBe('awaiting_approval');
      expect(run.approvedPlanHash).toBe(plan.planHash);
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(deterministicIndex);
    },
    300_000,
  );

  it(
    '(e) config-only force (conflictPolicy in projection.config.json) still gates; awaiting_approval can be cancelled',
    async () => {
      const projectRoot = copyGuestbook('config');
      const indexPath = path.join(projectRoot, 'generated', 'html-static', 'index.html');

      const initialRunId = await startRun(projectRoot);
      expect((await waitForRunStop(initialRunId)).status).toBe('succeeded');
      const deterministicIndex = fs.readFileSync(indexPath, 'utf8');
      fs.writeFileSync(indexPath, `${deterministicIndex}\n<!-- manual edit 3 -->`, 'utf8');
      const manualBytes = fs.readFileSync(indexPath, 'utf8');

      // conflictPolicy: force on the target config — no request field.
      const configPath = path.join(projectRoot, 'projection.config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const htmlStatic = config.targets.find((t: any) => t.id === 'html-static');
      htmlStatic.conflictPolicy = 'force';
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

      const runId = await startRun(projectRoot);
      const run = await waitForRunStop(runId);
      expect(run.status).toBe('awaiting_approval');
      expect(run.planHash).toMatch(/^sha256:/);
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(manualBytes);

      // awaiting_approval → cancelled: the pending state is not terminal,
      // so cancel records it exactly once.
      const cancelResp = await postJson(`${baseUrl}/api/compiler/runs/${runId}/cancel`, {});
      expect(cancelResp.status).toBe(200);
      const cancelled = (await cancelResp.json()) as any;
      expect(cancelled.status).toBe('cancelled');
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(manualBytes);
    },
    300_000,
  );

  it('(f) rejects an invalid conflictResolution with 400', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/runs`, {
      projectRoot: guestbookRoot,
      targetId: 'html-static',
      conflictResolution: 'overwrite-everything',
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('BAD_REQUEST');

    const planResp = await postJson(`${baseUrl}/api/compiler/plan`, {
      projectRoot: guestbookRoot,
      targetId: 'html-static',
      conflictResolution: 'nope',
    });
    expect(planResp.status).toBe(400);
  });

  it('rejects an approve resolution other than force with 400', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/runs/some-run/approve`, {
      planHash: 'sha256:whatever',
      resolution: 'plan-only',
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});
