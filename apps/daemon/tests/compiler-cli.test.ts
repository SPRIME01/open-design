import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const TARGETS_PAYLOAD = [
  { id: 'html-static', version: '0.1.0', kind: 'frontend', features: [], limitations: [] }
];

interface SeenRequest {
  method: string;
  url: string;
  body: string;
}

async function startFakeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, seen };
}

const openServers: http.Server[] = [];

async function stopFakeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: daemonRoot,
    env: { ...process.env },
  });
}

function runCliExpectFailure(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(args).then(
    () => {
      throw new Error(`expected CLI to exit non-zero: od ${args.join(' ')}`);
    },
    (err) => {
      const code = typeof err.code === 'number' ? err.code : -1;
      return { code, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    },
  );
}

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await stopFakeServer(server);
  }
});

describe('od compiler CLI', () => {
  it('GET /api/compiler/targets is triggered when running compiler targets', async () => {
    const seenRequests: Array<{ method: string; url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        seenRequests.push({ method: req.method ?? '', url: req.url ?? '', body });
        if (req.method === 'GET' && req.url === '/api/compiler/targets') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(TARGETS_PAYLOAD));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          'compiler',
          'targets',
          '--daemon-url',
          `http://127.0.0.1:${address.port}`,
          '--json',
        ],
        {
          cwd: daemonRoot,
          env: { ...process.env },
        },
      );

      expect(seenRequests).toEqual([
        { method: 'GET', url: '/api/compiler/targets', body: '' },
      ]);
      expect(JSON.parse(stdout)).toEqual(TARGETS_PAYLOAD);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('compiler compile starts a run, polls it to completion and prints the final run', async () => {
    const succeededRun = {
      runId: 'run-compat-1',
      status: 'succeeded',
      phase: 'idle',
      progress: 100,
      diagnostics: [],
      planHash: 'sha256:compat',
      startedAt: '2026-09-13T00:00:00.000Z',
      completedAt: '2026-09-13T00:00:01.000Z',
    };
    const { server, baseUrl, seen } = await startFakeServer((req, res, body) => {
      if (req.method === 'POST' && req.url === '/api/compiler/runs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          runId: 'run-compat-1',
          status: {
            runId: 'run-compat-1',
            status: 'queued',
            phase: 'validation',
            progress: 0,
            diagnostics: [],
            startedAt: '2026-09-13T00:00:00.000Z',
          },
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-compat-1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(succeededRun));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const projectArg = path.resolve(daemonRoot);
    const { stdout } = await runCli([
      'compiler', 'compile',
      '--project', projectArg,
      '--target', 'html-static',
      '--daemon-url', baseUrl,
      '--json',
    ]);

    expect(JSON.parse(stdout)).toEqual(succeededRun);
    const start = seen.find((r) => r.method === 'POST' && r.url === '/api/compiler/runs');
    expect(start).toBeTruthy();
    expect(JSON.parse(start!.body)).toEqual({
      projectRoot: projectArg,
      targetId: 'html-static',
    });
  }, 30_000);
});

describe('od app CLI', () => {
  it('targets list hits GET /api/compiler/targets through the new surface', async () => {
    const { server, baseUrl, seen } = await startFakeServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/compiler/targets') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(TARGETS_PAYLOAD));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli([
      'app', 'targets', 'list', '--daemon-url', baseUrl, '--json',
    ]);
    expect(JSON.parse(stdout)).toEqual(TARGETS_PAYLOAD);
    expect(seen).toEqual([{ method: 'GET', url: '/api/compiler/targets', body: '' }]);

    // Bare `targets` (no `list`) hits the same handler.
    const bare = await runCli(['app', 'targets', '--daemon-url', baseUrl, '--json']);
    expect(JSON.parse(bare.stdout)).toEqual(TARGETS_PAYLOAD);
  });

  it('init scaffolds a compilable crud bundle, prints the next command, and refuses to overwrite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-app-init-'));

    const { stdout } = await runCli(['app', 'init', '--project', dir]);
    expect(stdout).toContain(`Next: od app compile --project ${dir} --target html-static`);
    for (const file of [
      'application.ir.json',
      'ir/domain.ir.json',
      'ir/capabilities.ir.json',
      'ir/boundary.ir.json',
      'ir/persistence.ir.json',
      'ir/frontend.ir.json',
      'projection.config.json',
    ]) {
      expect(fs.existsSync(path.join(dir, file))).toBe(true);
    }
    const projection = JSON.parse(fs.readFileSync(path.join(dir, 'projection.config.json'), 'utf8'));
    expect(projection.targets.map((t: { id: string }) => t.id)).toEqual(['html-static']);
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, 'application.ir.json'), 'utf8'));
    expect(bundle.applicationId).toBe('project-console');

    // Second init into the same directory must refuse with exit 2.
    const failure = await runCliExpectFailure(['app', 'init', '--project', dir]);
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain('refusing to overwrite');
  });

  it('init --template marketing scaffolds the marketing bundle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-app-init-marketing-'));
    const { stdout } = await runCli(['app', 'init', '--project', dir, '--template', 'marketing', '--json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.template).toBe('marketing');
    expect(parsed.files).toContain('ir/frontend.ir.json');
    expect(parsed.nextCommand).toBe(`od app compile --project ${dir} --target html-static`);
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, 'application.ir.json'), 'utf8'));
    expect(bundle.applicationId).toBe('marketing-site');

    const failure = await runCliExpectFailure(['app', 'init', '--project', dir, '--template', 'nope']);
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain("unknown template 'nope'");
  });

  it('plan without --target resolves the single target from projection.config.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-app-plan-single-'));
    fs.writeFileSync(path.join(dir, 'application.ir.json'), JSON.stringify({ schemaVersion: '1.0.0' }), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'projection.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        application: 'application.ir.json',
        targets: [
          { id: 'html-static', adapter: 'html-static', mode: 'scaffold', outputRoot: 'generated/html-static' },
        ],
      }),
      'utf8',
    );

    const planResult = {
      status: 'succeeded',
      diagnostics: [],
      plan: {
        planHash: 'sha256:plan-single',
        targetId: 'html-static',
        creates: ['generated/html-static/index.html'],
        modifies: [],
        deletes: [],
        reuses: [],
        conflicts: [],
        unresolved: [],
        degradations: [],
        permissionsRequired: [],
        commandsProposed: [],
        verificationPlanned: [],
      },
      planHash: 'sha256:plan-single',
      evidenceRefs: { planPath: path.join(dir, 'compiler/plans/plan-x.json') },
    };
    const { server, baseUrl, seen } = await startFakeServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/compiler/plan') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(planResult));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli([
      'app', 'plan', '--project', dir, '--daemon-url', baseUrl,
    ]);
    expect(stdout).toContain('Plan status: succeeded');
    expect(stdout).toContain('creates:    1');
    expect(stdout).toContain('Plan hash: sha256:plan-single');

    const planReq = seen.find((r) => r.method === 'POST' && r.url === '/api/compiler/plan');
    expect(planReq).toBeTruthy();
    expect(JSON.parse(planReq!.body)).toEqual({ projectRoot: dir, targetId: 'html-static' });
  });

  it('plan without --target fails with exit 2 listing targets when the config declares several', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-app-plan-multi-'));
    fs.writeFileSync(path.join(dir, 'application.ir.json'), JSON.stringify({ schemaVersion: '1.0.0' }), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'projection.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        application: 'application.ir.json',
        targets: [
          { id: 'html-static', adapter: 'html-static', mode: 'scaffold' },
          { id: 'react-vite', adapter: 'react-vite', mode: 'scaffold' },
        ],
      }),
      'utf8',
    );

    // No daemon is contacted: target resolution fails locally before any HTTP.
    const failure = await runCliExpectFailure(['app', 'plan', '--project', dir]);
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain('--target is required');
    expect(failure.stderr).toContain('html-static');
    expect(failure.stderr).toContain('react-vite');
  });

  it('run get fetches the run record over GET /api/compiler/runs/:id', async () => {
    const run = {
      runId: 'run-42',
      status: 'succeeded',
      phase: 'idle',
      progress: 100,
      diagnostics: [],
      planHash: 'sha256:run42',
      startedAt: '2026-09-13T00:00:00.000Z',
    };
    const { server, baseUrl, seen } = await startFakeServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-42') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(run));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli(['app', 'run', 'get', 'run-42', '--daemon-url', baseUrl, '--json']);
    expect(JSON.parse(stdout)).toEqual(run);
    expect(seen).toEqual([{ method: 'GET', url: '/api/compiler/runs/run-42', body: '' }]);
  });

  it('conflicts list reports planning-phase diagnostics recorded on the run', async () => {
    const run = {
      runId: 'run-conflicted',
      status: 'failed',
      phase: 'idle',
      progress: 30,
      planHash: 'sha256:conflicted',
      diagnostics: [
        {
          code: 'file_conflicts',
          message: 'Compile blocked: Unresolved conflicts in manual files.',
          severity: 'error',
          phase: 'planning',
        },
        {
          code: 'unexpected_error',
          message: 'boom',
          severity: 'error',
          phase: 'write',
        },
      ],
      startedAt: '2026-09-13T00:00:00.000Z',
    };
    const { server, baseUrl } = await startFakeServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-conflicted') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(run));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli([
      'app', 'conflicts', 'list', '--run', 'run-conflicted', '--daemon-url', baseUrl, '--json',
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.runId).toBe('run-conflicted');
    expect(parsed.conflicts).toEqual([run.diagnostics[0]]);
  });

  it('metrics renders the human summary and --json round-trips the snapshot', async () => {
    const metricsPayload = {
      runsByTerminalStatus: { succeeded: 3, failed: 1, cancelled: 2 },
      phaseDurationsMs: {
        validation: { lastMs: 12, cumulativeMs: 45 },
        write: { lastMs: 7, cumulativeMs: 21 },
      },
      targetSuccessRate: { 'html-static': { succeeded: 2, total: 3 } },
      noopRate: { noops: 1, recompiles: 3 },
      conflictCount: 1,
      degradedSemanticCount: 0,
      verificationFailureCategory: { build: 1, runtime: 0, a11y: 0, migration: 0 },
    };
    const { server, baseUrl, seen } = await startFakeServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/compiler/metrics') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(metricsPayload));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const human = await runCli(['app', 'metrics', '--daemon-url', baseUrl]);
    expect(human.stdout).toContain('Runs by terminal status:');
    expect(human.stdout).toContain('succeeded: 3');
    expect(human.stdout).toContain('cancelled: 2');
    expect(human.stdout).toContain('Per-target success (cancelled runs excluded):');
    expect(human.stdout).toContain('html-static: 2/3 (67%)');
    expect(human.stdout).toContain('No-op rate: 1/3 recompiles were no-ops');
    expect(human.stdout).toContain('Phase durations (last / cumulative ms):');
    expect(human.stdout).toContain('validation: 12 / 45');
    expect(human.stdout).toContain('Counters:');
    expect(human.stdout).toContain('conflicts: 1');
    expect(human.stdout).toContain('verification failures by category: build=1');

    const jsonRun = await runCli(['app', 'metrics', '--daemon-url', baseUrl, '--json']);
    expect(JSON.parse(jsonRun.stdout)).toEqual(metricsPayload);

    expect(seen).toEqual([
      { method: 'GET', url: '/api/compiler/metrics', body: '' },
      { method: 'GET', url: '/api/compiler/metrics', body: '' },
    ]);
  });

  it('metrics renders the empty snapshot without crashing', async () => {
    const emptyPayload = {
      runsByTerminalStatus: {},
      phaseDurationsMs: {},
      targetSuccessRate: {},
      noopRate: { noops: 0, recompiles: 0 },
      conflictCount: 0,
      degradedSemanticCount: 0,
      verificationFailureCategory: {},
    };
    const { server, baseUrl } = await startFakeServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/compiler/metrics') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(emptyPayload));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli(['app', 'metrics', '--daemon-url', baseUrl]);
    expect(stdout).toContain('Runs by terminal status:');
    expect(stdout).toContain('(none)');
    expect(stdout).toContain('No-op rate: 0/0 recompiles were no-ops');
    expect(stdout).toContain('verification failures by category: none');
  });

  it('compile --follow streams SSE frames and ends on the terminal event', async () => {
    const started = {
      runId: 'run-follow-1',
      status: 'queued',
      phase: 'validation',
      progress: 0,
      diagnostics: [],
      startedAt: '2026-09-13T00:00:00.000Z',
    };
    const succeeded = {
      ...started,
      status: 'succeeded',
      phase: 'idle',
      progress: 100,
      planHash: 'sha256:follow',
    };
    const { server, baseUrl } = await startFakeServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/compiler/runs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run-follow-1', status: started }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-follow-1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'progress', data: { ...started, status: 'verifying', phase: 'verification', progress: 80 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'success', data: succeeded })}\n\n`);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-follow-1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(succeeded));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli([
      'app', 'compile',
      '--project', daemonRoot,
      '--target', 'html-static',
      '--daemon-url', baseUrl,
      '--follow', '--json',
    ]);

    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { type: 'progress', data: expect.objectContaining({ status: 'verifying', progress: 80 }) },
      { type: 'success', data: succeeded },
    ]);
  });

  it('compile --follow falls back to polling when the SSE endpoint is unavailable', async () => {
    const started = {
      runId: 'run-fallback-1',
      status: 'queued',
      phase: 'validation',
      progress: 0,
      diagnostics: [],
      startedAt: '2026-09-13T00:00:00.000Z',
    };
    const succeeded = { ...started, status: 'succeeded', phase: 'idle', progress: 100 };
    const { server, baseUrl } = await startFakeServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/compiler/runs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: 'run-fallback-1', status: started }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-fallback-1/events') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-fallback-1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(succeeded));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli([
      'app', 'compile',
      '--project', daemonRoot,
      '--target', 'html-static',
      '--daemon-url', baseUrl,
      '--follow', '--json', '--wait',
    ]);
    // Fallback must behave like plain polling: exactly one final run object.
    expect(JSON.parse(stdout)).toEqual(succeeded);
  });
});

describe('od app conflict-resolution surface', () => {
  const awaitingRun = {
    runId: 'run-await-1',
    status: 'awaiting_approval',
    phase: 'planning',
    progress: 50,
    diagnostics: [
      {
        code: 'approval_required',
        message: "Conflict resolution 'force' would overwrite manually-changed generated file(s).",
        severity: 'advisory',
        phase: 'planning',
      },
    ],
    planHash: 'sha256:need-approval',
    startedAt: '2026-09-13T00:00:00.000Z',
  };

  function awaitingServer(opts: { sse?: boolean } = {}): Promise<{
    server: http.Server;
    baseUrl: string;
    seen: SeenRequest[];
  }> {
    return startFakeServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/compiler/runs') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          runId: 'run-await-1',
          status: { ...awaitingRun, status: 'queued', phase: 'validation', progress: 0 },
        }));
        return;
      }
      if (opts.sse && req.method === 'GET' && req.url === '/api/compiler/runs/run-await-1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'awaiting_approval', data: awaitingRun })}\n\n`);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/api/compiler/runs/run-await-1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(awaitingRun));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }).then(({ server, baseUrl, seen }) => {
      openServers.push(server);
      return { server, baseUrl, seen };
    });
  }

  it('compile --conflict-resolution force without approval sends the flag and exits 4 with the approve command', async () => {
    const { baseUrl, seen } = await awaitingServer();

    const failure = await runCliExpectFailure([
      'app', 'compile',
      '--project', daemonRoot,
      '--target', 'html-static',
      '--daemon-url', baseUrl,
      '--conflict-resolution', 'force',
    ]);
    expect(failure.code).toBe(4);
    expect(failure.stdout).toContain('awaiting_approval');
    expect(failure.stdout).toContain('Plan hash: sha256:need-approval');
    expect(failure.stdout).toContain(
      'od app approve run-await-1 --plan-hash sha256:need-approval --resolution force',
    );

    const start = seen.find((r) => r.method === 'POST' && r.url === '/api/compiler/runs');
    expect(start).toBeTruthy();
    expect(JSON.parse(start!.body)).toEqual({
      projectRoot: path.resolve(daemonRoot),
      targetId: 'html-static',
      conflictResolution: 'force',
    });
  }, 30_000);

  it('compile --conflict-resolution force --json exits 4 with the run on stdout and the hint on stderr', async () => {
    const { baseUrl } = await awaitingServer();

    const failure = await runCliExpectFailure([
      'app', 'compile',
      '--project', daemonRoot,
      '--target', 'html-static',
      '--daemon-url', baseUrl,
      '--conflict-resolution', 'force',
      '--json',
    ]);
    expect(failure.code).toBe(4);
    expect(JSON.parse(failure.stdout)).toEqual(awaitingRun);
    expect(failure.stderr).toContain(
      'od app approve run-await-1 --plan-hash sha256:need-approval --resolution force',
    );
  }, 30_000);

  it('compile --follow exits 4 when the SSE stream delivers the awaiting_approval frame', async () => {
    const { baseUrl } = await awaitingServer({ sse: true });

    const failure = await runCliExpectFailure([
      'app', 'compile',
      '--project', daemonRoot,
      '--target', 'html-static',
      '--daemon-url', baseUrl,
      '--conflict-resolution', 'force',
      '--follow',
    ]);
    expect(failure.code).toBe(4);
    expect(failure.stdout).toContain('plan approval required (sha256:need-approval)');
    expect(failure.stdout).toContain(
      'od app approve run-await-1 --plan-hash sha256:need-approval --resolution force',
    );
  }, 30_000);

  it('compile --approve-plan without --conflict-resolution force is a usage error (exit 2)', async () => {
    // No daemon needed: the flag-combination check fires before any HTTP.
    for (const extra of [[], ['--conflict-resolution', 'plan-only'], ['--conflict-resolution', 'block']]) {
      const failure = await runCliExpectFailure([
        'app', 'compile',
        '--project', daemonRoot,
        '--target', 'html-static',
        '--daemon-url', 'http://127.0.0.1:1',
        '--approve-plan', 'sha256:abc',
        ...extra,
      ]);
      expect(failure.code).toBe(2);
      expect(failure.stderr).toContain('--approve-plan is only valid together with --conflict-resolution force');
    }
  }, 30_000);

  it('compile rejects an invalid --conflict-resolution value with exit 2', async () => {
    const failure = await runCliExpectFailure([
      'app', 'compile',
      '--project', daemonRoot,
      '--target', 'html-static',
      '--daemon-url', 'http://127.0.0.1:1',
      '--conflict-resolution', 'obliterate',
    ]);
    expect(failure.code).toBe(2);
    expect(failure.stderr).toContain('--conflict-resolution must be one of');
  }, 30_000);

  it('approve posts the plan hash with resolution force and prints the result', async () => {
    const approvedRun = {
      runId: 'run-appr-1',
      status: 'queued',
      phase: 'validation',
      progress: 0,
      diagnostics: [],
      planHash: 'sha256:approved',
      approvedPlanHash: 'sha256:approved',
      startedAt: '2026-09-13T00:00:00.000Z',
    };
    const { server, baseUrl, seen } = await startFakeServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/compiler/runs/run-appr-1/approve') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(approvedRun));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const human = await runCli([
      'app', 'approve', 'run-appr-1',
      '--plan-hash', 'sha256:approved',
      '--resolution', 'force',
      '--daemon-url', baseUrl,
    ]);
    expect(human.stdout).toContain('Run run-appr-1 approved (plan hash: sha256:approved)');

    const json = await runCli([
      'app', 'approve', 'run-appr-1',
      '--plan-hash', 'sha256:approved',
      '--resolution', 'force',
      '--daemon-url', baseUrl,
      '--json',
    ]);
    expect(JSON.parse(json.stdout)).toEqual(approvedRun);

    const approveCalls = seen.filter((r) => r.method === 'POST' && r.url === '/api/compiler/runs/run-appr-1/approve');
    expect(approveCalls).toHaveLength(2);
    for (const call of approveCalls) {
      expect(JSON.parse(call.body)).toEqual({ planHash: 'sha256:approved', resolution: 'force' });
    }
  }, 30_000);

  it('approve without --plan-hash or with a bad --resolution is a usage error', async () => {
    const missing = await runCliExpectFailure(['app', 'approve', 'run-appr-1', '--daemon-url', 'http://127.0.0.1:1']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('--plan-hash <hash> are required');

    const bad = await runCliExpectFailure([
      'app', 'approve', 'run-appr-1',
      '--plan-hash', 'sha256:approved',
      '--resolution', 'plan-only',
      '--daemon-url', 'http://127.0.0.1:1',
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--resolution must be 'force'");
  }, 30_000);

  it('plan passes --conflict-resolution through to POST /api/compiler/plan', async () => {
    const planResult = {
      status: 'succeeded',
      diagnostics: [],
      plan: {
        planHash: 'sha256:force-plan',
        targetId: 'html-static',
        creates: [],
        modifies: ['generated/html-static/index.html'],
        deletes: [],
        reuses: [],
        conflicts: [{ path: 'index.html', classification: 'CONFLICT_MODIFIED_GENERATED_FILE', resolution: 'force' }],
        unresolved: [],
        degradations: [],
        permissionsRequired: [],
        commandsProposed: [],
        verificationPlanned: [],
      },
      planHash: 'sha256:force-plan',
      effectiveConflictResolution: 'force',
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-app-plan-force-'));
    fs.writeFileSync(path.join(dir, 'application.ir.json'), JSON.stringify({ schemaVersion: '1.0.0' }), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'projection.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        application: 'application.ir.json',
        targets: [{ id: 'html-static', adapter: 'html-static', mode: 'scaffold' }],
      }),
      'utf8',
    );
    const { server, baseUrl, seen } = await startFakeServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/compiler/plan') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(planResult));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    openServers.push(server);

    const { stdout } = await runCli([
      'app', 'plan', '--project', dir, '--daemon-url', baseUrl, '--conflict-resolution', 'force',
    ]);
    expect(stdout).toContain('Plan hash: sha256:force-plan');
    const planReq = seen.find((r) => r.method === 'POST' && r.url === '/api/compiler/plan');
    expect(JSON.parse(planReq!.body)).toEqual({ projectRoot: dir, targetId: 'html-static', conflictResolution: 'force' });
  }, 30_000);
});
