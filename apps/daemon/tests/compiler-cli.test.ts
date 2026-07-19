import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

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
          res.end(JSON.stringify([
            { id: 'html-static', version: '0.1.0', kind: 'frontend', features: [], limitations: [] }
          ]));
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
      expect(JSON.parse(stdout)).toEqual([
        { id: 'html-static', version: '0.1.0', kind: 'frontend', features: [], limitations: [] }
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
