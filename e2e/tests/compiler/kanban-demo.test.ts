// @vitest-environment node

// Kanban demo app end-to-end (examples/kanban): the authored IR bundle must
// survive the real product paths — the daemon HTTP compiler flow (validate →
// plan → compile run) through the web proxy, and the in-process compile +
// materialize + sqlite round-trip the generated persistence output promises.
// One test on purpose: tools-dev boot is the expensive part, and the sqlite
// half reuses the SAME copied bundle the daemon flow validated.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { compile } from '@open-design/application-compiler';
import { registerAllBuiltInAdapters } from '@open-design/application-targets';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite, e2eWorkspaceRoot } from '@/vitest/suite';

const execFileAsync = promisify(execFile);

const workspaceRoot = e2eWorkspaceRoot();
const kanbanExampleDir = join(workspaceRoot, 'examples', 'kanban');

// Bundle only — deliberately excludes examples/kanban's generated/ and
// compiler/ output so the compile run below is what proves they appear.
const STARTER_FILES = [
  'application.ir.json',
  'projection.config.json',
  'ir/domain.ir.json',
  'ir/capabilities.ir.json',
  'ir/boundary.ir.json',
  'ir/persistence.ir.json',
  'ir/frontend.ir.json',
] as const;

type PlanResponse = {
  status: string;
  planHash?: string;
  plan?: { planHash: string };
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

type Toolchain = { npm: string; npmVersion: string };

type GeneratedFile = { path: string; content: string; sourceIds: string[] };

type CardRow = {
  id: string;
  title: string;
  column: string;
  position: number;
  created_at: string;
};

type CardDriverVerdict = {
  applied: { version: string; fileName: string }[];
  inserted: CardRow;
  got: CardRow | null;
  listed: CardRow[];
  updatedChanges: number;
  afterMove: CardRow | null;
  afterMoveList: CardRow[];
};

const INSERTED_CARD: CardRow = {
  id: 'card-e2e-1',
  title: 'Design review',
  column: 'todo',
  position: 1,
  created_at: '2026-09-13T12:00:00.000Z',
};

const MOVED_CARD: CardRow = { ...INSERTED_CARD, column: 'doing', position: 2 };

// The config type of compile()'s 7th parameter (ProjectionConfig) is not
// re-exported by @open-design/application-compiler; recover it from the
// signature so the in-process sqlite compile stays type-checked.
type CompileConfig = Parameters<typeof compile>[6];

describe('compiler kanban demo end-to-end', () => {
  test(
    '[P1] kanban demo compiles through the daemon HTTP flow and its generated sqlite persistence round-trips a card',
    async ({ skip }) => {
      const toolchain = await resolveNpmToolchain();
      if (!toolchain) {
        skip('npm toolchain unavailable; cannot exercise the generated sqlite output');
        return;
      }

      const suite = await createSmokeSuite('compiler-kanban-demo');

      await suite.with.toolsDev(async ({ webUrl }) => {
        const projectRoot = join(suite.scratchDir, 'kanban-project');
        await copyStarterBundle(projectRoot);

        // --- Part 1: validate the authored bundle (valid verdict is a 200) ---
        const validated = await requestJson<{
          valid: boolean;
          diagnostics: unknown[];
        }>(webUrl, '/api/compiler/validate', { body: { projectRoot } });
        expect(validated.valid, JSON.stringify(validated.diagnostics)).toBe(true);

        // --- Part 2: plan the html-static target (no writes, hash present) ---
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
        expect(started.runId).toBeTruthy();

        const finalRun = await pollRunUntilTerminal(webUrl, started.runId);
        expect(
          finalRun.diagnostics?.map((d) => `${d.code}: ${d.message}`).join('\n') ?? '',
        ).toBe('');
        expect(finalRun.status).toBe('succeeded');
        expect(finalRun.planHash).toBe(planHash);
        expect(finalRun.evidenceRefs?.manifestPath).toBeTruthy();
        expect(finalRun.evidenceRefs?.evidencePath).toBeTruthy();
        expect(existsSync(finalRun.evidenceRefs!.manifestPath!)).toBe(true);
        expect(existsSync(finalRun.evidenceRefs!.evidencePath!)).toBe(true);

        // The static preview must render the board: title, all three columns
        // (the IR titles render through the node ids/labels), and the per-card
        // move affordance bound to cards.move.
        const boardHtmlPath = join(projectRoot, 'generated', 'html-static', 'index.html');
        expect(existsSync(boardHtmlPath), `board preview at ${boardHtmlPath}`).toBe(true);
        const boardHtml = readFileSync(boardHtmlPath, 'utf8');
        expect(boardHtml).toContain('Kanban Board');
        for (const columnTitle of ['todo', 'doing', 'done']) {
          expect(boardHtml, `column ${columnTitle} must render`).toMatch(new RegExp(columnTitle, 'i'));
        }
        expect(boardHtml).toContain('<button>Move card</button>');

        // --- Part 4: in-process sqlite compile of the SAME copied bundle ---
        registerAllBuiltInAdapters();
        const bundle = readProjectJson(projectRoot, 'application.ir.json');
        const domain = readProjectJson(projectRoot, 'ir/domain.ir.json');
        const capabilities = readProjectJson(projectRoot, 'ir/capabilities.ir.json');
        const boundary = readProjectJson(projectRoot, 'ir/boundary.ir.json');
        const persistence = readProjectJson(projectRoot, 'ir/persistence.ir.json');
        const frontend = readProjectJson(projectRoot, 'ir/frontend.ir.json');
        const config = readProjectJson(projectRoot, 'projection.config.json') as CompileConfig;

        const result = await compile(
          bundle,
          domain,
          capabilities,
          boundary,
          persistence,
          frontend,
          config,
          'sqlite-better-sqlite3',
        );
        expect(
          result.status,
          `compile(sqlite-better-sqlite3) diagnostics: ${JSON.stringify(result.diagnostics)}`,
        ).toBe('succeeded');
        const files = (result.fileSet?.files ?? []) as GeneratedFile[];
        expect(files.length, 'sqlite compile returned an empty file set').toBeGreaterThan(0);

        const targetDir = await mkdtemp(join(tmpdir(), 'od-kanban-demo-sqlite-'));
        let preserved = false;
        try {
          await materialize(targetDir, files);

          // The generated output ships its own install manifest
          // (package.json with better-sqlite3) and repository module.
          expect(existsSync(join(targetDir, 'package.json')), 'generated package.json missing').toBe(true);
          const repositoryFile = join(targetDir, 'src', 'server', 'persistence', 'card-repository.ts');
          expect(existsSync(repositoryFile), 'generated card repository module missing').toBe(true);

          // `npm install` here is the point: better-sqlite3's install script
          // produces the native binding the generated db.ts loads. A previous
          // successful install on this machine makes the step a no-op guard.
          if (!existsSync(join(targetDir, 'node_modules', 'better-sqlite3'))) {
            await runNpm(toolchain, ['install', '--no-audit', '--no-fund'], targetDir);
          }

          // Driver: Node 24 strips types natively, so plain `node` can import
          // the generated TypeScript modules (annotation-only syntax).
          const driverFile = join(targetDir, 'driver.ts');
          await writeFile(driverFile, SQLITE_DRIVER_SOURCE, 'utf8');

          const { stdout } = await execFileAsync(
            process.execPath,
            [driverFile, join(targetDir, 'roundtrip.db'), join(targetDir, 'src', 'server', 'persistence', 'migrations')],
            { cwd: targetDir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
          );
          const verdict = parseDriverVerdict(stdout);

          // applyMigrations recorded the generated initial migration.
          expect(verdict.applied, `driver stdout: ${stdout}`).toEqual([
            { version: '0001_initial', fileName: '0001_initial.sql' },
          ]);
          // Insert → get/list round-trip byte-equal.
          expect(verdict.inserted).toEqual(INSERTED_CARD);
          expect(verdict.got, `driver stdout: ${stdout}`).toEqual(INSERTED_CARD);
          expect(verdict.listed, `driver stdout: ${stdout}`).toEqual([INSERTED_CARD]);
          // cards.move semantics through repo.update: column doing, position 2.
          expect(verdict.updatedChanges, `driver stdout: ${stdout}`).toBe(1);
          expect(verdict.afterMove, `driver stdout: ${stdout}`).toEqual(MOVED_CARD);
          expect(verdict.afterMoveList, `driver stdout: ${stdout}`).toEqual([MOVED_CARD]);
        } catch (error) {
          // Failed runs keep the generated tree (node_modules state included)
          // for diagnosis.
          preserved = true;
          console.error(`[kanban-demo] preserved sqlite scratch for diagnosis: ${targetDir}`);
          throw error;
        } finally {
          if (!preserved) {
            await rm(targetDir, { recursive: true, force: true });
          }
        }
      });
    },
    600_000,
  );
});

// --- helpers ---

async function copyStarterBundle(projectRoot: string): Promise<void> {
  for (const rel of STARTER_FILES) {
    const destination = join(projectRoot, rel);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(kanbanExampleDir, rel), destination);
  }
}

function readProjectJson(projectRoot: string, relativePath: string): unknown {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), 'utf8'));
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

/**
 * Resolve a usable npm. PATH `npm` can be intercepted by package-manager
 * shims, so prefer the npm that ships beside the running node binary, then
 * fall back to PATH (mirrors generated-targets.test.ts).
 */
async function resolveNpmToolchain(): Promise<Toolchain | null> {
  const candidates = [join(dirname(process.execPath), 'npm'), 'npm'];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 30_000 });
      const npmVersion = stdout.trim();
      if (/^\d+\.\d+\.\d+/.test(npmVersion)) {
        return { npm: candidate, npmVersion };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function runNpm(toolchain: Toolchain, args: string[], cwd: string): Promise<void> {
  const nodeBinDir = dirname(process.execPath);
  try {
    await execFileAsync(toolchain.npm, args, {
      cwd,
      timeout: 420_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${nodeBinDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
      },
    });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `npm ${args.join(' ')} failed in ${cwd}\n${err.message ?? ''}\n${(err.stdout ?? '').slice(-2000)}\n${(err.stderr ?? '').slice(-2000)}`,
    );
  }
}

/** Minimal materialization of a compile file set (ProjectWriter happy path). */
async function materialize(targetDir: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const absolute = join(targetDir, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, 'utf8');
  }
}

function parseDriverVerdict(stdout: string): CardDriverVerdict {
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  if (!last) {
    throw new Error(`sqlite driver printed no verdict line; stdout: ${stdout}`);
  }
  return JSON.parse(last) as CardDriverVerdict;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exercises the generated artifacts only: db.ts (getDatabase + the generated
 * applyMigrations runner) and the generated card repository module, whose
 * insert/get/list/update run the round-trip through prepared statements
 * against the `card` table the emitter derives from the kanban domain IR
 * (id/title/column/position/created_at columns). The move step mirrors the
 * cards.move command semantics: same row, column doing, position 2.
 */
const SQLITE_DRIVER_SOURCE = [
  "import { getDatabase, applyMigrations } from './src/server/persistence/db.ts';",
  "import { createCardRepository } from './src/server/persistence/card-repository.ts';",
  '',
  'const db = getDatabase(process.argv[2]);',
  'const applied = applyMigrations(db, process.argv[3]);',
  'const cardRepository = createCardRepository(db);',
  `const inserted = ${JSON.stringify(INSERTED_CARD)};`,
  'cardRepository.insert(inserted);',
  "const got = cardRepository.get('card-e2e-1');",
  'const listed = cardRepository.list();',
  `const moved = ${JSON.stringify(MOVED_CARD)};`,
  'const updatedChanges = cardRepository.update(moved);',
  "const afterMove = cardRepository.get('card-e2e-1');",
  'const afterMoveList = cardRepository.list();',
  'console.log(',
  '  JSON.stringify({',
  '    applied,',
  '    inserted,',
  '    got,',
  '    listed,',
  '    updatedChanges,',
  '    afterMove,',
  '    afterMoveList,',
  '  }),',
  ');',
  '',
].join('\n');
