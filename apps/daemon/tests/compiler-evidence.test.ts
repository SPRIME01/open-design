import type http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/server.js';
import type {
  VerificationResult,
  VerificationStepContext,
} from '../src/compiler/verification-runner.js';

/**
 * Spec §13 recovery row: "Verification failure corrected without corrupting
 * prior evidence", at the daemon layer where per-run evidence lives on disk
 * (`generated/<target>/manifest.json`, `plan.json`,
 * `compiler/evidence/<runId>.verification.json`).
 *
 * Sabotage mechanism: the html-static verification step executes
 * `echo HTML verified successfully.` — `echo` is a shell builtin, so no PATH
 * or argv sabotage can make the real command fail. Rather than adding a
 * production seam, this file mocks the verification runner in-process: while
 * `verificationSabotage.active` is set, every step reports a deterministic
 * failure shaped like the runner's real failure output; otherwise the real
 * runner executes. The flag is set around run 2 only, so runs 1 and 3
 * exercise the genuine verification path. The project IR is never touched,
 * so run 2's planning still classifies the existing generated files against
 * run 1's manifest.
 */
const verificationSabotage = vi.hoisted(() => ({
  active: false,
  output:
    "Verification step 'html-lint' failed.\n" +
    'Error: Command failed: echo HTML verified successfully.\n' +
    'Output:\nhtml-lint reported a deliberate failure (compiler-evidence test sabotage)',
}));

vi.mock('../src/compiler/verification-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/compiler/verification-runner.js')>();
  return {
    ...actual,
    runVerificationStep: (
      name: string,
      command: { executable: string; argv: string[] },
      cwd: string,
      ctx?: VerificationStepContext,
      timeoutMs?: number
    ): Promise<VerificationResult> => {
      if (verificationSabotage.active) {
        return Promise.resolve({ success: false, output: verificationSabotage.output });
      }
      return actual.runVerificationStep(name, command, cwd, ctx, timeoutMs);
    },
  };
});

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;
let projectRoot: string;

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

async function startRun(runId: string): Promise<void> {
  const resp = await postJson(`${baseUrl}/api/compiler/runs`, {
    projectRoot,
    targetId: 'html-static',
    runId,
  });
  expect(resp.status).toBe(200);
}

const projectFile = (rel: string) => path.join(projectRoot, rel);
const readProjectFile = (rel: string) => fs.readFileSync(projectFile(rel), 'utf8');

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;

  // Temp-copy the guestbook so the scenario never mutates the repo fixture.
  // generated/ and compiler/ are daemon-owned output (and gitignored) and are
  // excluded so run 1 is a true first compile against a clean project.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-compiler-evidence-'));
  for (const entry of fs.readdirSync(guestbookRoot, { withFileTypes: true })) {
    if (entry.name === 'generated' || entry.name === 'compiler') continue;
    const source = path.join(guestbookRoot, entry.name);
    const target = projectFile(entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(source, target, { recursive: true });
    } else {
      fs.copyFileSync(source, target);
    }
  }
}, 120_000);

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('Compiler evidence survives a failed verification (spec §13)', () => {
  it('keeps run 1 evidence intact through a failed run 2 and a corrected run 3', async () => {
    // Run 1: clean compile succeeds; snapshot its evidence bytes.
    await startRun('evidence-run-1');
    const run1 = await waitForRunCompletion('evidence-run-1');
    expect(run1.status).toBe('succeeded');

    const snapshot = {
      manifest: readProjectFile('generated/html-static/manifest.json'),
      plan: readProjectFile('generated/html-static/plan.json'),
      evidence: readProjectFile('compiler/evidence/evidence-run-1.verification.json'),
    };
    const parsedSnapshotPlan = JSON.parse(snapshot.plan);
    expect(parsedSnapshotPlan.runId).toBe('evidence-run-1');
    expect(JSON.parse(snapshot.evidence).filesEmitted.length).toBeGreaterThan(0);

    // Run 2: verification sabotaged in-process; IR untouched, so planning
    // still sees run 1's manifest and the unchanged generated bytes.
    let run2: any;
    try {
      verificationSabotage.active = true;
      await startRun('evidence-run-2');
      run2 = await waitForRunCompletion('evidence-run-2');
    } finally {
      verificationSabotage.active = false;
    }

    expect(run2.status).toBe('failed');
    expect(run2.phase).toBe('verification');
    expect(run2.diagnostics[0]?.code).toBe('verification_failed');
    expect(run2.diagnostics[0]?.message).toContain('html-lint');
    expect(run2.evidenceRefs?.evidencePath).toContain('evidence-run-2.verification.json');
    expect(run2.evidenceRefs?.manifestPath).toContain('manifest.json');
    expect(run2.evidenceRefs?.planPath).toContain('plan.json');

    // The failed run's own evidence is complete: diagnostics reference the
    // failed step, and the per-run verification record exists with the
    // failure output and the files the run wrote before verification ran.
    const diagnostics2 = JSON.parse(
      readProjectFile('compiler/diagnostics/evidence-run-2.diagnostics.json')
    );
    expect(diagnostics2.runId).toBe('evidence-run-2');
    expect(diagnostics2.status).toBe('failed');
    expect(diagnostics2.diagnostics[0]?.code).toBe('verification_failed');
    const evidence2 = JSON.parse(
      readProjectFile('compiler/evidence/evidence-run-2.verification.json')
    );
    expect(evidence2.runId).toBe('evidence-run-2');
    expect(evidence2.filesEmitted.length).toBeGreaterThan(0);
    expect(evidence2.verificationOutput).toContain('html-lint');

    // Prior evidence is untouched: run 1's verification record is
    // byte-identical, and the manifest on disk is byte-identical — a failed
    // verification must not claim new ownership (the manifest has no
    // run-scoped fields, so byte equality is meaningful here).
    expect(readProjectFile('compiler/evidence/evidence-run-1.verification.json')).toBe(
      snapshot.evidence
    );
    expect(readProjectFile('generated/html-static/manifest.json')).toBe(snapshot.manifest);

    // plan.json now describes run 2's attempt: run-scoped identity updated,
    // but the description of the work itself (source, config, output files,
    // verification commands) is unchanged from run 1's plan.
    const plan2 = JSON.parse(readProjectFile('generated/html-static/plan.json'));
    expect(plan2.runId).toBe('evidence-run-2');
    expect(plan2.sourceHash).toBe(parsedSnapshotPlan.sourceHash);
    expect(plan2.configHash).toBe(parsedSnapshotPlan.configHash);
    expect(plan2.estimatedOutputFiles).toEqual(parsedSnapshotPlan.estimatedOutputFiles);
    expect(plan2.verificationPlanned).toEqual(parsedSnapshotPlan.verificationPlanned);

    // Run 3: sabotage removed — the corrected run succeeds, the manifest is
    // still byte-identical (noop recompile), and all prior evidence remains.
    await startRun('evidence-run-3');
    const run3 = await waitForRunCompletion('evidence-run-3');
    expect(run3.status).toBe('succeeded');
    expect(run3.evidenceRefs?.evidencePath).toContain('evidence-run-3.verification.json');

    const evidence3 = JSON.parse(
      readProjectFile('compiler/evidence/evidence-run-3.verification.json')
    );
    expect(evidence3.runId).toBe('evidence-run-3');
    expect(evidence3.filesEmitted.length).toBeGreaterThan(0);
    expect(evidence3.verificationOutput).toContain('HTML verified successfully.');

    expect(readProjectFile('generated/html-static/manifest.json')).toBe(snapshot.manifest);
    expect(readProjectFile('compiler/evidence/evidence-run-1.verification.json')).toBe(
      snapshot.evidence
    );
    expect(readProjectFile('compiler/evidence/evidence-run-2.verification.json')).toBe(
      JSON.stringify(evidence2, null, 2)
    );

    const plan3 = JSON.parse(readProjectFile('generated/html-static/plan.json'));
    expect(plan3.runId).toBe('evidence-run-3');
    expect(plan3.creates).toEqual([]);
    expect(plan3.modifies).toEqual([]);
    expect(plan3.reuses.length).toBeGreaterThan(0);
  }, 180_000);
});
