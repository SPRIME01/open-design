/**
 * ProjectWriter rollback (spec §13 "Failed file commit rolls back staged
 * writes" + §14.1 class 5 write_failure: "roll back staging and preserve
 * prior target").
 *
 * The writer backs up every staged path before writing (content for files
 * that existed, a null marker for files it was about to create) and, when any
 * write in the batch fails, restores byte-for-byte prior contents and unlinks
 * the files the failed batch had created. Rollback operates on files: empty
 * parent directories mkdir'ed during the failed batch may remain behind —
 * prior target FILE state is what the spec requires preserved, and it is.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWriter } from '../src/compiler/project-writer.js';

const tempRoots: string[] = [];

function makeOutputRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('ProjectWriter staged writes (spec §13 recovery / §14.1 class 5)', () => {
  it('writes the full staged set, creating parent directories', () => {
    const root = makeOutputRoot('od-writer-commit-');
    const writer = new ProjectWriter(root);
    writer.stageAndWrite([
      { path: 'index.html', content: '<html>home</html>' },
      { path: 'assets/app.css', content: 'body { margin: 0 }' },
    ]);
    expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe('<html>home</html>');
    expect(fs.readFileSync(path.join(root, 'assets/app.css'), 'utf8')).toBe('body { margin: 0 }');
  });

  it('a failed commit restores prior contents byte-for-byte and removes files the batch created', () => {
    const root = makeOutputRoot('od-writer-rollback-');

    // A file the batch would modify — rollback must restore it exactly.
    const preexisting = path.join(root, 'existing.html');
    const priorContent = '<!DOCTYPE html>\n<html lang="en">\n  <body>prior target</body>\n</html>\n';
    fs.writeFileSync(preexisting, priorContent, 'utf8');

    // Force a later write in the batch to fail: the staged target path is a
    // directory, so the writer's pre-write backup read (and any write) fails
    // with EISDIR — the same failure shape as a permission/atomic-rename
    // failure on a real target path.
    fs.mkdirSync(path.join(root, 'evil.html'));

    const writer = new ProjectWriter(root);
    expect(() =>
      writer.stageAndWrite([
        { path: 'existing.html', content: 'OVERWRITTEN BY THE FAILED BATCH' },
        { path: 'nested/created.html', content: 'created before the batch failed' },
        { path: 'evil.html', content: 'never lands' },
      ]),
    ).toThrow(/EISDIR/);

    // Prior target preserved: the pre-existing file is byte-for-byte intact…
    expect(fs.readFileSync(preexisting, 'utf8')).toBe(priorContent);
    // …and the file this batch had created before the failure is gone.
    expect(fs.existsSync(path.join(root, 'nested/created.html'))).toBe(false);
    // The failing path itself never became a file.
    expect(fs.statSync(path.join(root, 'evil.html')).isDirectory()).toBe(true);
  });

  it('is reusable after a failed batch: backups reset per batch, no stale rollback entries', () => {
    const root = makeOutputRoot('od-writer-reuse-');
    fs.mkdirSync(path.join(root, 'evil.html'));

    const writer = new ProjectWriter(root);
    expect(() =>
      writer.stageAndWrite([
        { path: 'good.html', content: 'first batch' },
        { path: 'evil.html', content: 'boom' },
      ]),
    ).toThrow(/EISDIR/);
    // The failed batch rolled its own successful writes back.
    expect(fs.existsSync(path.join(root, 'good.html'))).toBe(false);

    // A fresh batch on the same writer commits normally, and a later manual
    // rollback() restores exactly this batch's state (no entries leaked from
    // the failed batch).
    writer.stageAndWrite([{ path: 'good.html', content: 'second batch' }]);
    expect(fs.readFileSync(path.join(root, 'good.html'), 'utf8')).toBe('second batch');
    writer.rollback();
    expect(fs.existsSync(path.join(root, 'good.html'))).toBe(false);
  });
});
