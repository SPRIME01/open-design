import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
});

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  it('GET /api/compiler/runs/:id returns 404 for unknown run', async () => {
    const resp = await fetch(`${baseUrl}/api/compiler/runs/non-existent-run`);
    expect(resp.status).toBe(404);
  });
});
