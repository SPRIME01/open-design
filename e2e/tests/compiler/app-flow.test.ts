// @vitest-environment node

// Application compiler app-flow e2e (completion plan I8, spec §17.4).
//
// One test on purpose: tools-dev boot is the expensive part, so the daemon
// HTTP flow (validate → plan → compile → hash-bound approve) and the MCP
// stdio round-trip share a single runtime. HTTP calls go through the web
// proxy (`webUrl + /api/...`), the same boundary the dialog specs use; the
// MCP child is pointed straight at the daemon port the harness allocated.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createInterface as createReadlineInterface } from 'node:readline';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite, e2eWorkspaceRoot } from '@/vitest/suite';

const workspaceRoot = e2eWorkspaceRoot();
const guestbookExampleDir = join(workspaceRoot, 'examples', 'guestbook');
const odBin = join(workspaceRoot, 'apps', 'daemon', 'bin', 'od.mjs');

// Starter bundle only — deliberately excludes examples/guestbook's committed
// generated/ and compiler/ evidence so the compile run below is what proves
// the manifest appears on disk.
const STARTER_FILES = [
  'application.ir.json',
  'projection.config.json',
  'ir/domain.ir.json',
  'ir/capabilities.ir.json',
  'ir/boundary.ir.json',
  'ir/persistence.ir.json',
  'ir/frontend.ir.json',
] as const;

// The seven spec §11.3 application compiler tools the MCP server must expose.
const APPLICATION_COMPILER_MCP_TOOLS = [
  'list_application_targets',
  'get_application_ir',
  'validate_application_ir',
  'plan_application_target',
  'compile_application_target',
  'get_compiler_run',
  'get_compiler_evidence',
] as const;

type PlanResponse = {
  status: string;
  planHash?: string;
  plan?: { planHash: string; targetId: string };
  evidenceRefs?: { planPath?: string };
};

type RunResponse = {
  runId: string;
  status: {
    status: string;
    planHash?: string;
    evidenceRefs?: { planPath?: string; manifestPath?: string; evidencePath?: string };
    diagnostics?: Array<{ code: string; message: string; severity: string }>;
  };
};

describe('compiler app flow end-to-end', () => {
  test('[P1] daemon HTTP validate/plan/compile/approve plus MCP stdio tools round-trip', async () => {
    const suite = await createSmokeSuite('compiler-app-flow');

    await suite.with.toolsDev(async ({ runtime, webUrl }) => {
      const projectRoot = join(suite.scratchDir, 'guestbook-project');
      await copyStarterBundle(projectRoot);

      // --- Part 1: validate (valid verdict is a 200) ---
      const validated = await requestJson<{
        valid: boolean;
        diagnostics: unknown[];
        diagnosticsPath?: string;
      }>(webUrl, '/api/compiler/validate', { body: { projectRoot } });
      expect(validated.valid, JSON.stringify(validated.diagnostics)).toBe(true);

      // --- Part 2: plan (no generated/ writes, hash present) ---
      const planned = await requestJson<PlanResponse>(webUrl, '/api/compiler/plan', {
        body: { projectRoot, targetId: 'html-static' },
      });
      expect(planned.status).toBe('succeeded');
      const planHash = planned.planHash ?? planned.plan?.planHash;
      expect(typeof planHash).toBe('string');
      expect(planHash!.length).toBeGreaterThan(0);
      expect(planned.evidenceRefs?.planPath).toBeTruthy();
      expect(existsSync(planned.evidenceRefs!.planPath!)).toBe(true);
      expect(existsSync(join(projectRoot, 'generated'))).toBe(false);

      // --- Part 3: compile run to terminal state ---
      const started = await requestJson<RunResponse>(webUrl, '/api/compiler/runs', {
        body: { projectRoot, targetId: 'html-static' },
      });
      const runId = started.runId;
      expect(runId).toBeTruthy();

      const finalRun = await pollRunUntilTerminal(webUrl, runId);
      expect(
        finalRun.diagnostics?.map((d) => `${d.code}: ${d.message}`).join('\n') ?? '',
      ).toBe('');
      expect(finalRun.status).toBe('succeeded');
      expect(finalRun.planHash).toBe(planHash);
      expect(finalRun.evidenceRefs?.manifestPath).toBeTruthy();
      expect(finalRun.evidenceRefs?.evidencePath).toBeTruthy();
      const manifestPath = join(projectRoot, 'generated', 'html-static', 'manifest.json');
      expect(existsSync(manifestPath), `manifest at ${manifestPath}`).toBe(true);
      expect(existsSync(finalRun.evidenceRefs!.evidencePath!)).toBe(true);

      // --- Part 4: hash-bound approve ---
      const mismatch = await postApprove(webUrl, runId, `${planHash!}-wrong`);
      expect(mismatch.status).toBe(409);
      expect(mismatch.body?.error?.code ?? JSON.stringify(mismatch.body)).toContain('PLAN_HASH_MISMATCH');

      const approved = await postApprove(webUrl, runId, planHash!);
      expect(approved.status).toBe(200);
      expect(approved.body?.approvedPlanHash).toBe(planHash);

      // --- Part 5: MCP stdio round-trip against the same daemon ---
      const daemonUrl = `http://127.0.0.1:${runtime.daemonPort}`;
      await runMcpRoundTrip(daemonUrl, projectRoot);
    });
  }, 300_000);
});

async function copyStarterBundle(projectRoot: string): Promise<void> {
  for (const rel of STARTER_FILES) {
    const destination = join(projectRoot, rel);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(guestbookExampleDir, rel), destination);
  }
}

async function pollRunUntilTerminal(webUrl: string, runId: string): Promise<RunResponse['status']> {
  const deadline = Date.now() + 60_000;
  let last: RunResponse['status'] | null = null;
  while (Date.now() < deadline) {
    last = await requestJson<RunResponse['status']>(webUrl, `/api/compiler/runs/${runId}`);
    if (last.status === 'succeeded' || last.status === 'failed' || last.status === 'cancelled') {
      return last;
    }
    await delay(500);
  }
  throw new Error(
    `compiler run ${runId} did not reach a terminal state within 60s (last: ${JSON.stringify(last)})`,
  );
}

async function postApprove(
  webUrl: string,
  runId: string,
  planHash: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(`/api/compiler/runs/${runId}/approve`, `${webUrl}/`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planHash }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * Drive `od mcp live-artifacts` over stdio: initialize handshake, roster
 * check, and one real tools/call against the running daemon. The server
 * speaks line-delimited JSON-RPC (one JSON object per stdin/stdout line).
 */
async function runMcpRoundTrip(daemonUrl: string, projectRoot: string): Promise<void> {
  const child = spawn(process.execPath, [odBin, 'mcp', 'live-artifacts'], {
    env: {
      ...process.env,
      OD_DAEMON_URL: daemonUrl,
      // The MCP client always sends a Bearer header; tools-dev runs the
      // daemon without OD_API_TOKEN, so any non-empty token is accepted.
      OD_TOOL_TOKEN: 'e2e-compiler-mcp-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stderrChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void }>();
  let nextId = 1;

  const stdout = createReadlineInterface({ input: child.stdout });
  stdout.on('line', (line) => {
    if (!line.trim()) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      pending.get(message.id)!.resolve(message);
      pending.delete(message.id);
    }
  });

  const request = (method: string, params?: unknown): Promise<JsonRpcResponse> => {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      setTimeout(
        () => {
          if (pending.delete(id)) {
            reject(new Error(`MCP request ${method} timed out (stderr: ${stderrChunks.join('')})`));
          }
        },
        30_000,
      ).unref();
    });
  };

  const notify = (method: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  };

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-compiler-app-flow', version: '0.0.0' },
    });
    expect(initialized.error, JSON.stringify(initialized.error)).toBeUndefined();
    expect((initialized.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe(
      'open-design-live-artifacts',
    );

    notify('notifications/initialized');

    const listed = await request('tools/list');
    expect(listed.error, JSON.stringify(listed.error)).toBeUndefined();
    const tools = (listed.result as { tools?: Array<{ name: string }> }).tools ?? [];
    const names = tools.map((tool) => tool.name);
    for (const expected of APPLICATION_COMPILER_MCP_TOOLS) {
      expect(names, `MCP roster missing ${expected}`).toContain(expected);
    }

    const called = await request('tools/call', {
      name: 'validate_application_ir',
      arguments: { projectRoot },
    });
    expect(called.error, JSON.stringify(called.error)).toBeUndefined();
    const content = (called.result as { content?: Array<{ type: string; text: string }> }).content ?? [];
    expect(content).toHaveLength(1);
    const textPart = content[0];
    expect(textPart, 'MCP tools/call must return one content part').toBeDefined();
    expect(textPart!.type).toBe('text');
    const verdict = JSON.parse(textPart!.text) as { valid: boolean; diagnostics?: unknown[] };
    expect(verdict.valid, textPart!.text).toBe(true);
  } finally {
    // Closing stdin lets the server's readline loop end and the process exit
    // cleanly; SIGTERM is the fallback if anything is still in flight.
    child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
    await Promise.race([
      exited,
      delay(5_000).then(() => {
        child.kill('SIGTERM');
        return exited;
      }),
    ]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
