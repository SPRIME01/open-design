import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tempProjectDir = path.join(repoRoot, '.tmp/my-test-project');
const evidenceDir = path.join(repoRoot, '.agents/evidence/application-compiler-e2e');
const screenshotDir = path.join(evidenceDir, 'screenshots');

test.describe('Open Design Application Compiler E2E Verification', () => {
  test.beforeAll(() => {
    fs.mkdirSync(screenshotDir, { recursive: true });
  });

  test('Scenario A & B: Load generated html-static and verify structure', async ({ page }) => {
    const htmlFilePath = path.join(tempProjectDir, 'generated/html-static/index.html');
    expect(fs.existsSync(htmlFilePath)).toBe(true);

    const fileUrl = `file://${path.resolve(htmlFilePath)}`;
    await page.goto(fileUrl);
    
    // Check main heading
    const title = page.locator('h1');
    await expect(title).toContainText('Project Console (Preview)');

    // Check screen
    const screen = page.locator('#screen\\.projects');
    await expect(screen).toBeVisible();

    // Check dashboard semantic node
    const dashboard = page.locator('#semantic\\.projects-dashboard');
    await expect(dashboard).toBeVisible();

    // Check create form component
    const form = page.locator('#component\\.create-project-form');
    await expect(form).toBeVisible();

    // Check input and button atomic nodes
    const input = page.locator('#atomic\\.project-name input');
    await expect(input).toBeVisible();
    await input.fill('E2E Test Project Name');

    const button = page.locator('#atomic\\.create-project button');
    await expect(button).toBeVisible();

    // Take screenshot
    await page.screenshot({ path: path.join(screenshotDir, '01-html-static-initial-page.png'), fullPage: true });

    // Click submit
    await button.click();
    await page.screenshot({ path: path.join(screenshotDir, '02-html-static-submitted.png'), fullPage: true });
  });

  test('Generated Code Quality: Check React, Next.js, SvelteKit, SQLite output structure', async () => {
    // Next.js App
    const nextPackageJsonPath = path.join(tempProjectDir, 'generated/nextjs-app/package.json');
    expect(fs.existsSync(nextPackageJsonPath)).toBe(true);
    const nextPkg = JSON.parse(fs.readFileSync(nextPackageJsonPath, 'utf8'));
    expect(nextPkg.dependencies.next).toBeDefined();
    expect(nextPkg.dependencies.react).toBeDefined();

    const nextPagePath = path.join(tempProjectDir, 'generated/nextjs-app/src/app/page.tsx');
    expect(fs.existsSync(nextPagePath)).toBe(true);
    const nextPage = fs.readFileSync(nextPagePath, 'utf8');
    expect(nextPage).toContain('Next.js App: Project Console');

    // React Vite
    const reactPackageJsonPath = path.join(tempProjectDir, 'generated/react-vite/package.json');
    expect(fs.existsSync(reactPackageJsonPath)).toBe(true);
    const reactPkg = JSON.parse(fs.readFileSync(reactPackageJsonPath, 'utf8'));
    expect(reactPkg.devDependencies.vite).toBeDefined();
    expect(reactPkg.devDependencies['@vitejs/plugin-react']).toBeDefined();

    const reactAppPath = path.join(tempProjectDir, 'generated/react-vite/src/App.tsx');
    expect(fs.existsSync(reactAppPath)).toBe(true);
    const reactApp = fs.readFileSync(reactAppPath, 'utf8');
    expect(reactApp).toContain('React/Vite App: Project Console');

    const tsconfigPath = path.join(tempProjectDir, 'generated/react-vite/tsconfig.json');
    expect(fs.existsSync(tsconfigPath)).toBe(true);

    // SvelteKit
    const sveltePackageJsonPath = path.join(tempProjectDir, 'generated/sveltekit/package.json');
    expect(fs.existsSync(sveltePackageJsonPath)).toBe(true);
    
    const sveltePagePath = path.join(tempProjectDir, 'generated/sveltekit/src/routes/+page.svelte');
    expect(fs.existsSync(sveltePagePath)).toBe(true);
    const sveltePage = fs.readFileSync(sveltePagePath, 'utf8');
    expect(sveltePage).toContain('SvelteKit: Project Console');

    // Sqlite better-sqlite3 DDL & client code
    const sqliteSqlPath = path.join(tempProjectDir, 'generated/sqlite-better-sqlite3/src/server/persistence/migrations/0001_initial.sql');
    expect(fs.existsSync(sqliteSqlPath)).toBe(true);
    const sql = fs.readFileSync(sqliteSqlPath, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "project"');
    expect(sql).toContain('"id" TEXT PRIMARY KEY');
    expect(sql).toContain('"name" TEXT');

    const sqliteDbPath = path.join(tempProjectDir, 'generated/sqlite-better-sqlite3/src/server/persistence/db.ts');
    expect(fs.existsSync(sqliteDbPath)).toBe(true);
    const dbCode = fs.readFileSync(sqliteDbPath, 'utf8');
    expect(dbCode).toContain('import Database from "better-sqlite3"');
  });

  test('Verify API compiler rejection paths', async ({ request }) => {
    const daemonUrl = process.env.OD_DAEMON_URL || 'http://127.0.0.1:43555';

    // 1. Missing targetId/projectRoot should return 400
    const resp400 = await request.post(`${daemonUrl}/api/compiler/runs`, {
      data: { projectRoot: tempProjectDir }
    });
    expect(resp400.status()).toBe(400);
    const err400 = await resp400.json();
    expect(err400.error.code).toBe('BAD_REQUEST');

    // 2. Non-existent project path should queue a run, which then fails asynchronously
    const resp500 = await request.post(`${daemonUrl}/api/compiler/runs`, {
      data: { projectRoot: '/non/existent/path', targetId: 'html-static' }
    });
    expect(resp500.status()).toBe(200);
    const start500 = await resp500.json();
    const runId = start500.runId;
    expect(runId).toBeDefined();

    // Poll the status until it completes
    let status = start500.status;
    let attempts = 0;
    while (status.status !== 'succeeded' && status.status !== 'failed' && attempts < 20) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const poll = await request.get(`${daemonUrl}/api/compiler/runs/${runId}`);
      expect(poll.status()).toBe(200);
      status = await poll.json();
      attempts++;
    }
    expect(status.status).toBe('failed');
    expect(status.diagnostics.some((d: any) => d.message.includes('application.ir.json not found'))).toBe(true);

    // 3. Unknown compiler run should return 404
    const resp404 = await request.get(`${daemonUrl}/api/compiler/runs/unknown-run-12345`);
    expect(resp404.status()).toBe(404);
    const err404 = await resp404.json();
    expect(err404.error.code).toBe('NOT_FOUND');
  });
});

