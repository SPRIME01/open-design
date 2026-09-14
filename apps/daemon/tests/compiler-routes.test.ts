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

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
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

describe('Compiler integration routes', () => {
  it('GET /api/compiler/targets returns the list of built-in targets', async () => {
    const resp = await fetch(`${baseUrl}/api/compiler/targets`);
    expect(resp.status).toBe(200);
    const targets = await resp.json() as any[];
    expect(Array.isArray(targets)).toBe(true);
    expect(targets.some(t => t.id === 'html-static')).toBe(true);
  });

  it('POST /api/compiler/runs with invalid payload returns 400', async () => {
    const resp = await fetch(`${baseUrl}/api/compiler/runs`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it('GET /api/compiler/runs/:id returns 404 for unknown run', async () => {
    const resp = await fetch(`${baseUrl}/api/compiler/runs/non-existent-run`);
    expect(resp.status).toBe(404);
  });
});

describe('POST /api/compiler/validate', () => {
  it('returns 200 with valid=true for the guestbook fixture', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/validate`, { projectRoot: guestbookRoot });
    expect(resp.status).toBe(200);
    const result = await resp.json() as any;
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(typeof result.diagnosticsPath).toBe('string');
  }, 60_000);

  it('returns 200 with valid=false and diagnostics for an invalid application.ir.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-compiler-invalid-'));
    fs.writeFileSync(
      path.join(dir, 'application.ir.json'),
      JSON.stringify({ schemaVersion: 'not-a-version' }),
      'utf8'
    );

    const resp = await postJson(`${baseUrl}/api/compiler/validate`, { projectRoot: dir });
    expect(resp.status).toBe(200);
    const result = await resp.json() as any;
    expect(result.valid).toBe(false);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(fs.existsSync(result.diagnosticsPath)).toBe(true);
  }, 60_000);

  it('returns 400 when projectRoot is missing', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/validate`, {});
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when projectRoot does not exist', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/validate`, {
      projectRoot: path.join(os.tmpdir(), 'od-compiler-no-such-project-root'),
    });
    expect(resp.status).toBe(404);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/compiler/ir', () => {
  it('returns the raw bundle and module documents for the guestbook fixture', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/ir`, { projectRoot: guestbookRoot });
    expect(resp.status).toBe(200);
    const result = await resp.json() as any;
    expect(result.bundle.applicationId).toBe('guestbook');
    expect(result.bundle.modules.domain).toBe('ir/domain.ir.json');
    expect(Object.keys(result.modules).sort()).toEqual(
      ['boundary', 'capabilities', 'domain', 'frontend', 'persistence'],
    );
    for (const module of Object.values(result.modules)) {
      expect(typeof module).toBe('object');
    }
  }, 60_000);

  it('returns 400 when projectRoot is missing', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/ir`, {});
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when projectRoot does not exist', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/ir`, {
      projectRoot: path.join(os.tmpdir(), 'od-compiler-no-such-project-root'),
    });
    expect(resp.status).toBe(404);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when application.ir.json is absent from an existing project root', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-compiler-empty-ir-'));
    const resp = await postJson(`${baseUrl}/api/compiler/ir`, { projectRoot: emptyDir });
    expect(resp.status).toBe(404);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/compiler/plan', () => {
  it('returns a succeeded plan with a plan hash and on-disk evidence for guestbook html-static', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/plan`, {
      projectRoot: guestbookRoot,
      targetId: 'html-static',
    });
    expect(resp.status).toBe(200);
    const result = await resp.json() as any;
    expect(result.status).toBe('succeeded');
    expect(result.plan.planHash).toMatch(/^sha256:/);
    expect(result.planHash).toBe(result.plan.planHash);
    expect(typeof result.evidenceRefs.planPath).toBe('string');
    expect(fs.existsSync(result.evidenceRefs.planPath)).toBe(true);
  }, 120_000);

  it('returns 400 when targetId is missing', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/plan`, { projectRoot: guestbookRoot });
    expect(resp.status).toBe(400);
  });

  it('returns 404 when projectRoot does not exist', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/plan`, {
      projectRoot: path.join(os.tmpdir(), 'od-compiler-no-such-project-root'),
      targetId: 'html-static',
    });
    expect(resp.status).toBe(404);
  });
});

describe('POST /api/compiler/runs/:id/approve', () => {
  it('approves a completed run with the matching plan hash and rejects a mismatch with 409', async () => {
    const startResp = await postJson(`${baseUrl}/api/compiler/runs`, {
      projectRoot: guestbookRoot,
      targetId: 'html-static',
    });
    expect(startResp.status).toBe(200);
    const started = await startResp.json() as any;

    const run = await waitForRunCompletion(started.runId);
    expect(run.status).toBe('succeeded');
    expect(run.planHash).toMatch(/^sha256:/);
    expect(run.evidenceRefs?.planPath).toBeTruthy();
    expect(run.evidenceRefs?.manifestPath).toBeTruthy();
    expect(run.evidenceRefs?.evidencePath).toBeTruthy();

    const approveResp = await postJson(`${baseUrl}/api/compiler/runs/${started.runId}/approve`, {
      planHash: run.planHash,
    });
    expect(approveResp.status).toBe(200);
    const approved = await approveResp.json() as any;
    expect(approved.approvedPlanHash).toBe(run.planHash);

    const mismatchResp = await postJson(`${baseUrl}/api/compiler/runs/${started.runId}/approve`, {
      planHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(mismatchResp.status).toBe(409);
    const mismatchBody = await mismatchResp.json() as any;
    expect(mismatchBody.error.code).toBe('PLAN_HASH_MISMATCH');
  }, 180_000);

  it('returns 404 for an unknown run', async () => {
    const resp = await postJson(`${baseUrl}/api/compiler/runs/non-existent-run/approve`, {
      planHash: 'sha256:whatever',
    });
    expect(resp.status).toBe(404);
  });

  it('returns 400 when planHash is missing', async () => {
    // A run against a project root without application.ir.json exists in the
    // registry immediately and fails fast, so no compile writes happen.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-compiler-empty-'));
    const startResp = await postJson(`${baseUrl}/api/compiler/runs`, {
      projectRoot: emptyDir,
      targetId: 'html-static',
    });
    expect(startResp.status).toBe(200);
    const started = await startResp.json() as any;
    await waitForRunCompletion(started.runId);

    const resp = await postJson(`${baseUrl}/api/compiler/runs/${started.runId}/approve`, {});
    expect(resp.status).toBe(400);
    const body = await resp.json() as any;
    expect(body.error.code).toBe('BAD_REQUEST');
  }, 60_000);
});
