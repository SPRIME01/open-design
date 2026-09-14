/**
 * Production-resource presence (application-compiler hardening plan N4,
 * spec §17.4 last bullet): the compiler must ship with the BUILT daemon
 * artifact, not only from the source checkout.
 *
 * What this proves:
 * 1. The daemon's compiled dist output — the artifact packaged runtimes
 *    consume — contains the compiler route, and that route still references
 *    the compiler service, the adapter registry, and the /api/compiler paths
 *    after compilation.
 * 2. Bare-specifier imports of `@open-design/application-compiler` /
 *    `@open-design/application-targets` (which is exactly how the compiled
 *    route imports them) resolve through each package's exports map to the
 *    BUILT `dist/index.mjs` artifacts — never into the packages' src trees.
 * 3. Loading the compiled route module functionally registers all seven
 *    built-in adapters in the shared registry: html-static, react-vite,
 *    nextjs-app, sveltekit, mock-local, next-server-actions,
 *    sqlite-better-sqlite3.
 *
 * Build-freshness design (why absence is a failure, never a skip):
 * - `tests/setup.ts` runs `ensureDaemonCliBuilt()` in every daemon vitest
 *   process, so `apps/daemon/dist` is guaranteed to exist by the time this
 *   test runs. A dist that exists but lacks `dist/routes/compiler.js` is a
 *   stale build and must fail with a rebuild instruction.
 * - The workspace packages' dists are guaranteed in every sanctioned
 *   invocation context: `scripts/postinstall.mjs` prebuilds package
 *   entrypoints, and the daemon `pretest` script builds all
 *   `@open-design/daemon^...` dependencies before `pnpm --filter
 *   @open-design/daemon test`. CI's `daemon_unit_tests` job uses exactly
 *   that command, so these assertions are green there without extra wiring.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapterRegistry } from '@open-design/application-compiler';
import { registerAllBuiltInAdapters } from '@open-design/application-targets';

const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(daemonRoot, '../..');
const compilerPkgRoot = path.join(repoRoot, 'packages', 'application-compiler');
const targetsPkgRoot = path.join(repoRoot, 'packages', 'application-targets');

const daemonCompilerRouteDist = path.join(daemonRoot, 'dist', 'routes', 'compiler.js');
const daemonCompilerServiceDist = path.join(daemonRoot, 'dist', 'compiler', 'compiler-service.js');
const compilerPkgDistEntry = path.join(compilerPkgRoot, 'dist', 'index.mjs');
const targetsPkgDistEntry = path.join(targetsPkgRoot, 'dist', 'index.mjs');

const REBUILD_HINT =
  'Stale or partial daemon build. Rebuild with `pnpm --filter @open-design/daemon build` and re-run.';

/** Realpath a build output so symlinked workspace deps compare against real package roots. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const BUILT_IN_ADAPTER_IDS = [
  'html-static',
  'mock-local',
  'next-server-actions',
  'nextjs-app',
  'react-vite',
  'sqlite-better-sqlite3',
  'sveltekit',
];

function listAdapterIds(): string[] {
  return adapterRegistry.list().map((adapter) => adapter.id).sort();
}

describe('compiler production-resource presence (spec §17.4)', () => {
  it('ships the compiler route in the built daemon dist', () => {
    // tests/setup.ts guarantees apps/daemon/dist exists (it builds dist/cli.js
    // on demand), so a missing route file here is a stale build, not a
    // first-run bootstrap gap. Presence tests fail on absence by design.
    expect(
      fs.existsSync(path.join(daemonRoot, 'dist', 'cli.js')),
      'daemon dist exists (guaranteed by tests/setup.ts ensureDaemonCliBuilt)',
    ).toBe(true);
    expect(fs.existsSync(daemonCompilerRouteDist), REBUILD_HINT).toBe(true);
    expect(fs.existsSync(daemonCompilerServiceDist), REBUILD_HINT).toBe(true);
  });

  it('builds the application-compiler and application-targets package dists', () => {
    // Workspace deps resolve through each package's exports map to
    // dist/index.mjs; those artifacts must exist for any runtime (packaged or
    // checkout) that consumes the packages the way the daemon does.
    expect(fs.existsSync(compilerPkgDistEntry), 'packages/application-compiler build output is missing').toBe(true);
    expect(fs.existsSync(targetsPkgDistEntry), 'packages/application-targets build output is missing').toBe(true);
  });

  it('resolves the compiler packages to their built dist, never to src', () => {
    const requireFromTest = createRequire(import.meta.url);

    const compilerResolved = realPath(requireFromTest.resolve('@open-design/application-compiler'));
    expect(compilerResolved.endsWith(path.join('dist', 'index.mjs'))).toBe(true);
    expect(compilerResolved.startsWith(realPath(path.join(compilerPkgRoot, 'dist')))).toBe(true);
    expect(compilerResolved).not.toContain(`${path.sep}src${path.sep}`);

    const targetsResolved = realPath(requireFromTest.resolve('@open-design/application-targets'));
    expect(targetsResolved.endsWith(path.join('dist', 'index.mjs'))).toBe(true);
    expect(targetsResolved.startsWith(realPath(path.join(targetsPkgRoot, 'dist')))).toBe(true);
    expect(targetsResolved).not.toContain(`${path.sep}src${path.sep}`);
  });

  it('keeps the compiler wiring intact through compilation (byte-level)', () => {
    const routeBytes = fs.readFileSync(daemonCompilerRouteDist, 'utf8');
    // The route must still reference the compiler service singleton, the
    // adapter registry, and the api/compiler endpoints after tsc emitted it.
    expect(routeBytes).toContain('compilerService');
    expect(routeBytes).toContain('adapterRegistry');
    expect(routeBytes).toContain('/api/compiler/targets');
    // Bare-specifier imports are what make the compiled route consume the
    // packages' dist through their exports maps at runtime.
    expect(routeBytes).toContain('@open-design/application-compiler');

    const serviceBytes = fs.readFileSync(daemonCompilerServiceDist, 'utf8');
    // Module-init registration of every built-in adapter survived compilation.
    expect(serviceBytes).toContain('registerAllBuiltInAdapters');
    expect(serviceBytes).toContain('@open-design/application-targets');
  });

  it('loads the compiled route and registers exactly the seven built-in adapters', async () => {
    const routeModule = await import(pathToFileURL(daemonCompilerRouteDist).href);
    expect(typeof routeModule.registerCompilerRoutes).toBe('function');

    // Importing the compiled route module initialized the compiled
    // compiler-service, which calls registerAllBuiltInAdapters() at module
    // load against the SAME registry instance this test imports (both sides
    // externalize to packages/application-compiler/dist/index.mjs). The
    // adapters must already be present before this test registers anything.
    expect(listAdapterIds()).toEqual(BUILT_IN_ADAPTER_IDS);

    // The documented registration API is idempotent in the presence case
    // (duplicate registrations are swallowed) and leaves the roster stable.
    expect(() => registerAllBuiltInAdapters()).not.toThrow();
    expect(listAdapterIds()).toEqual(BUILT_IN_ADAPTER_IDS);
    expect(adapterRegistry.list()).toHaveLength(7);
  });
});
