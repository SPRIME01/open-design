// @vitest-environment node

// Real-toolchain integration tests for generated targets (hardening plan N2,
// spec §17.4): the compiler's react-vite, nextjs-app, and sveltekit outputs
// must install and build under the real npm toolchain, and the
// sqlite-better-sqlite3 output must apply its generated migration and
// round-trip a row through the generated repository module against a real
// better-sqlite3 native build.
//
// No tools-dev runtime is needed: the compiler packages are driven
// in-process (the same boundary packages/application-compiler/tests/
// compile.test.ts uses) and each returned file set is materialized with a
// minimal mkdir+writeFile loop that mirrors the daemon ProjectWriter's happy
// path. Installs and builds run strictly sequentially (this file's tests are
// order-independent but never concurrent; see describe.sequential below).
//
// Spec rule: skipped integration tests MUST be reported as skipped, never
// silently passed. Every test checks the npm toolchain gate first and calls
// context.skip() with an explicit reason when the toolchain is absent.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { compile } from '@open-design/application-compiler';
import { registerAllBuiltInAdapters } from '@open-design/application-targets';

import { e2eWorkspaceRoot } from '@/vitest/suite';

const execFileAsync = promisify(execFile);

const workspaceRoot = e2eWorkspaceRoot();
const guestbookExampleDir = join(workspaceRoot, 'examples', 'guestbook');

const TARGET_IDS = ['react-vite', 'nextjs-app', 'sveltekit', 'sqlite-better-sqlite3'] as const;
type TargetId = (typeof TARGET_IDS)[number];

const INSTALL_TIMEOUT_MS = 420_000;
const BUILD_TIMEOUT_MS = 300_000;
const DRIVER_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

type Toolchain = { npm: string; npmVersion: string };

type GeneratedFile = { path: string; content: string; sourceIds: string[] };

type SqliteDriverVerdict = {
  row: { id: string; author: string; message: string; created_at: string } | null;
  tables: string[];
  foreignKeys: number;
};

// The config type of compile()'s 7th parameter (ProjectionConfig) is not
// re-exported by @open-design/application-compiler; recover it from the
// signature so the target matrix below stays type-checked.
type CompileConfig = Parameters<typeof compile>[6];

const config: CompileConfig = {
  schemaVersion: 1,
  application: 'application.ir.json',
  targets: [
    {
      id: 'react-vite',
      adapter: 'react-vite',
      mode: 'scaffold' as const,
      outputRoot: 'generated/react-vite',
      frontend: { adapter: 'react-vite' },
    },
    {
      id: 'nextjs-app',
      adapter: 'nextjs-app',
      mode: 'scaffold' as const,
      outputRoot: 'generated/nextjs-app',
      frontend: { adapter: 'nextjs-app' },
    },
    {
      id: 'sveltekit',
      adapter: 'sveltekit',
      mode: 'scaffold' as const,
      outputRoot: 'generated/sveltekit',
      frontend: { adapter: 'sveltekit' },
    },
    {
      id: 'sqlite-better-sqlite3',
      adapter: 'sqlite-better-sqlite3',
      mode: 'scaffold' as const,
      outputRoot: 'generated/sqlite-better-sqlite3',
      persistence: { adapter: 'sqlite-better-sqlite3' },
    },
    // The persistence target intentionally has no `frontend` block; the cast
    // below bridges the zod-inferred output type (frontend required) with the
    // runtime contract every adapter already accepts.
  ] as CompileConfig['targets'],
} as CompileConfig;

let toolchain: Toolchain | null = null;
let generatedRoot: string | null = null;
const targetDirs = new Map<TargetId, string>();
let preserveGeneratedRoot = false;

describe.sequential('compiler generated targets real-toolchain integration', () => {
  beforeAll(async () => {
    toolchain = await resolveNpmToolchain();
    console.log(
      toolchain
        ? `[generated-targets] npm toolchain: ${toolchain.npm} (v${toolchain.npmVersion})`
        : '[generated-targets] npm toolchain NOT found; install/build tests will be reported as skipped',
    );

    registerAllBuiltInAdapters();
    const bundle = readGuestbookJson('application.ir.json');
    const domain = readGuestbookJson('ir/domain.ir.json');
    const capabilities = readGuestbookJson('ir/capabilities.ir.json');
    const boundary = readGuestbookJson('ir/boundary.ir.json');
    const persistence = readGuestbookJson('ir/persistence.ir.json');
    const frontend = readGuestbookJson('ir/frontend.ir.json');

    generatedRoot = await mkdtemp(join(tmpdir(), 'od-generated-targets-'));

    for (const targetId of TARGET_IDS) {
      const result = await compile(
        bundle,
        domain,
        capabilities,
        boundary,
        persistence,
        frontend,
        config,
        targetId,
      );
      expect(
        result.status,
        `compile(${targetId}) diagnostics: ${JSON.stringify(result.diagnostics)}`,
      ).toBe('succeeded');
      const files = (result.fileSet?.files ?? []) as GeneratedFile[];
      expect(files.length, `compile(${targetId}) returned an empty file set`).toBeGreaterThan(0);

      const targetDir = join(generatedRoot, targetId);
      await materialize(targetDir, files);
      targetDirs.set(targetId, targetDir);
    }
  }, 120_000);

  afterAll(async () => {
    // Failed runs keep the generated tree (node_modules state included) for
    // diagnosis; successful runs clean their scratch.
    if (generatedRoot && !preserveGeneratedRoot) {
      await rm(generatedRoot, { recursive: true, force: true });
    }
  });

  test(
    '[P2] react-vite generated app installs and builds with the real npm toolchain',
    async ({ skip, onTestFailed }) => {
      const npmToolchain = toolchain;
      const targetDir = targetDirs.get('react-vite');
      if (!npmToolchain || !targetDir) {
        skip(`npm toolchain unavailable (${describeToolchain()}); cannot build react-vite output`);
        return;
      }
      onTestFailed(() => {
        preserveGeneratedRoot = true;
      });

      await runNpm(npmToolchain, ['install', '--no-audit', '--no-fund'], targetDir, INSTALL_TIMEOUT_MS, 'install');
      await runNpm(npmToolchain, ['run', 'build'], targetDir, BUILD_TIMEOUT_MS, 'build');

      // The generated build script is `tsc && vite build`; vite emits the
      // entry HTML plus hashed JS assets under dist/.
      expect(existsSync(join(targetDir, 'dist', 'index.html')), 'vite dist/index.html missing').toBe(true);
      const assets = await readdir(join(targetDir, 'dist', 'assets'));
      expect(assets.filter((name) => name.endsWith('.js')).length, `dist/assets contents: ${assets.join(', ')}`).toBeGreaterThan(0);
    },
    600_000,
  );

  test(
    '[P2] sveltekit generated app installs and builds with the real npm toolchain',
    async ({ skip, onTestFailed }) => {
      const npmToolchain = toolchain;
      const targetDir = targetDirs.get('sveltekit');
      if (!npmToolchain || !targetDir) {
        skip(`npm toolchain unavailable (${describeToolchain()}); cannot build sveltekit output`);
        return;
      }
      onTestFailed(() => {
        preserveGeneratedRoot = true;
      });

      await runNpm(npmToolchain, ['install', '--no-audit', '--no-fund'], targetDir, INSTALL_TIMEOUT_MS, 'install');
      // The generated build script is `vite build` with the sveltekit plugin
      // (svelte-kit's own `build` wrapper is not used by the emitter).
      await runNpm(npmToolchain, ['run', 'build'], targetDir, BUILD_TIMEOUT_MS, 'build');

      // adapter-auto leaves the intermediate build under .svelte-kit/output:
      // server and client bundles must both exist.
      expect(existsSync(join(targetDir, '.svelte-kit', 'output', 'server')), '.svelte-kit/output/server missing').toBe(true);
      expect(existsSync(join(targetDir, '.svelte-kit', 'output', 'client')), '.svelte-kit/output/client missing').toBe(true);
    },
    600_000,
  );

  test(
    '[P2] nextjs-app generated app installs and builds with the real npm toolchain',
    async ({ skip, onTestFailed }) => {
      const npmToolchain = toolchain;
      const targetDir = targetDirs.get('nextjs-app');
      if (!npmToolchain || !targetDir) {
        skip(`npm toolchain unavailable (${describeToolchain()}); cannot build nextjs-app output`);
        return;
      }
      onTestFailed(() => {
        preserveGeneratedRoot = true;
      });

      await runNpm(npmToolchain, ['install', '--no-audit', '--no-fund'], targetDir, INSTALL_TIMEOUT_MS, 'install');
      await runNpm(npmToolchain, ['run', 'build'], targetDir, BUILD_TIMEOUT_MS, 'build');

      // The emitter ships a tsconfig.json (Next 14 App Router baseline) plus
      // the @types/* pins in package.json, so `next build` verifies
      // TypeScript without synthesizing a config or installing type packages
      // on its own — the build stays offline-safe and deterministic.
      expect(existsSync(join(targetDir, 'tsconfig.json')), 'generated tsconfig.json missing').toBe(true);

      expect(existsSync(join(targetDir, '.next', 'BUILD_ID')), '.next/BUILD_ID missing').toBe(true);
    },
    600_000,
  );

  test(
    '[P2] sqlite-better-sqlite3 generated persistence installs the native module and round-trips a row',
    async ({ skip, onTestFailed }) => {
      const npmToolchain = toolchain;
      const targetDir = targetDirs.get('sqlite-better-sqlite3');
      if (!npmToolchain || !targetDir) {
        skip(`npm toolchain unavailable (${describeToolchain()}); cannot exercise sqlite-better-sqlite3 output`);
        return;
      }
      onTestFailed(() => {
        preserveGeneratedRoot = true;
      });

      // The sqlite emitter ships its own install manifest (package.json with
      // better-sqlite3 at the repo-pinned major and ESM type so the generated
      // import syntax parses under plain node); no test-local scaffold.
      expect(existsSync(join(targetDir, 'package.json')), 'generated package.json missing').toBe(true);
      const repositoryFile = join(targetDir, 'src', 'server', 'persistence', 'entry-repository.ts');
      expect(existsSync(repositoryFile), 'generated entry repository module missing').toBe(true);

      // `npm install` here is the point of the test: better-sqlite3's install
      // script runs prebuild-install (or node-gyp) and produces the native
      // binding the generated db.ts loads.
      await runNpm(npmToolchain, ['install', '--no-audit', '--no-fund'], targetDir, INSTALL_TIMEOUT_MS, 'install');

      const dbFile = join(targetDir, 'roundtrip.db');
      const migrationFile = join(targetDir, 'src', 'server', 'persistence', 'migrations', '0001_initial.sql');
      expect(existsSync(migrationFile), 'generated migration missing').toBe(true);

      // Driver: Node 24 strips types natively, so plain `node` can import the
      // generated TypeScript modules (annotation-only syntax).
      const driverFile = join(targetDir, 'driver.ts');
      await writeFile(driverFile, SQLITE_DRIVER_SOURCE, 'utf8');

      const { stdout } = await runNode(
        [driverFile, dbFile, migrationFile],
        targetDir,
        DRIVER_TIMEOUT_MS,
        'sqlite round-trip driver',
      );
      const verdict = parseDriverVerdict(stdout);
      expect(verdict.row, `driver stdout: ${stdout}`).toEqual({
        id: 'entry-n2-1',
        author: 'Ada Lovelace',
        message: 'Generated persistence round-trip',
        created_at: '2026-09-13T12:00:00.000Z',
      });
      expect(verdict.tables, `driver stdout: ${stdout}`).toContain('entry');
      // getDatabase() sets `foreign_keys = ON`; prove the generated pragma ran.
      expect(verdict.foreignKeys, `driver stdout: ${stdout}`).toBe(1);
    },
    600_000,
  );
});

// --- helpers ---

/**
 * Resolve a usable npm. PATH `npm` can be intercepted by package-manager
 * shims (this repository's dev machines pin pnpm through one), so prefer the
 * npm that ships beside the running node binary, then fall back to PATH.
 * Returns null (skip, per spec §17.4) when neither answers `--version`.
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

function describeToolchain(): string {
  return toolchain ? `${toolchain.npm} v${toolchain.npmVersion}` : 'not found next to node or on PATH';
}

/** Minimal materialization of a compile file set (ProjectWriter happy path). */
async function materialize(targetDir: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const absolute = join(targetDir, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, 'utf8');
  }
}

function readGuestbookJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(guestbookExampleDir, relativePath), 'utf8'));
}

function commandEnv(): NodeJS.ProcessEnv {
  const nodeBinDir = dirname(process.execPath);
  return {
    ...process.env,
    PATH: `${nodeBinDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

async function runNpm(
  npmToolchain: Toolchain,
  args: string[],
  cwd: string,
  timeoutMs: number,
  label: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(npmToolchain.npm, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: commandEnv(),
    });
    return stdout;
  } catch (error) {
    throw new Error(
      `npm ${args.join(' ')} failed (${label}) in ${cwd}\n${commandErrorDetail(error)}`,
    );
  }
}

async function runNode(
  args: string[],
  cwd: string,
  timeoutMs: number,
  label: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(process.execPath, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: commandEnv(),
    });
  } catch (error) {
    throw new Error(`node ${args.join(' ')} failed (${label}) in ${cwd}\n${commandErrorDetail(error)}`);
  }
}

function commandErrorDetail(error: unknown): string {
  const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
  const tail = (text: string | undefined): string => (text ? text.slice(-4000) : '');
  return [
    err.killed ? '(process timed out or was killed)' : '',
    err.message ?? '',
    '--- stdout tail ---',
    tail(err.stdout),
    '--- stderr tail ---',
    tail(err.stderr),
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

function parseDriverVerdict(stdout: string): SqliteDriverVerdict {
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  if (!last) {
    throw new Error(`sqlite driver printed no verdict line; stdout: ${stdout}`);
  }
  return JSON.parse(last) as SqliteDriverVerdict;
}

/**
 * Exercises the generated artifacts only: db.ts (via getDatabase), the
 * migration SQL, and — the point of this driver — the generated entry
 * repository module, whose insert/get run the round-trip through prepared
 * statements against the `entry` table the emitter derives from the guestbook
 * domain IR (id/author/message/created_at columns).
 */
const SQLITE_DRIVER_SOURCE = [
  "import { readFileSync } from 'node:fs';",
  "import { getDatabase } from './src/server/persistence/db.ts';",
  "import { createEntryRepository } from './src/server/persistence/entry-repository.ts';",
  '',
  'const db = getDatabase(process.argv[2]);',
  "db.exec(readFileSync(process.argv[3], 'utf8'));",
  'const entryRepository = createEntryRepository(db);',
  'entryRepository.insert({',
  "  id: 'entry-n2-1',",
  "  author: 'Ada Lovelace',",
  "  message: 'Generated persistence round-trip',",
  "  created_at: '2026-09-13T12:00:00.000Z',",
  '});',
  'const row = entryRepository.get("entry-n2-1");',
  'const tables = db',
  "  .prepare(\"SELECT name FROM sqlite_master WHERE type = 'table'\")",
  '  .all()',
  '  .map((table) => table.name);',
  'console.log(',
  '  JSON.stringify({',
  '    row,',
  '    tables,',
  "    foreignKeys: db.pragma('foreign_keys', { simple: true }),",
  '  }),',
  ');',
  '',
].join('\n');
