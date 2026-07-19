import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';
import { compilerService } from '../compiler/compiler-service.js';
import { runPersistence } from '../compiler/run-persistence.js';
import { adapterRegistry } from '@open-design/application-compiler';

export interface RegisterCompilerRoutesDeps extends RouteDeps<'http'> {}

export function registerCompilerRoutes(app: Express, ctx: RegisterCompilerRoutesDeps) {
  const { sendApiError } = ctx.http;

  app.get('/api/compiler/targets', (req, res) => {
    try {
      const list = adapterRegistry.list().map((a: any) => ({
        id: a.id,
        version: a.version,
        kind: a.kind,
        features: a.capabilities.features,
        limitations: a.capabilities.limitations,
      }));
      res.json(list);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL', `Failed to list compiler targets: ${err.message}`);
    }
  });

  app.post('/api/compiler/runs', async (req, res) => {
    try {
      const { projectRoot, targetId, runId } = req.body as { projectRoot: string; targetId: string; runId?: string };
      if (!projectRoot || !targetId) {
        return sendApiError(res, 400, 'BAD_REQUEST', "projectRoot and targetId are required fields.");
      }
      const runStatus = await compilerService.startRun(projectRoot, targetId, runId);
      res.json({ runId: runStatus.runId, status: runStatus });
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL', `Failed to start compiler run: ${err.message}`);
    }
  });

  app.get('/api/compiler/runs/:id', (req, res) => {
    try {
      const run = runPersistence.get(req.params.id);
      if (!run) {
        return sendApiError(res, 404, 'NOT_FOUND', `Compiler run '${req.params.id}' not found.`);
      }
      res.json(run);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL', `Failed to get compiler run: ${err.message}`);
    }
  });

  app.post('/api/compiler/runs/:id/cancel', (req, res) => {
    try {
      const run = runPersistence.get(req.params.id);
      if (!run) {
        return sendApiError(res, 404, 'NOT_FOUND', `Compiler run '${req.params.id}' not found.`);
      }
      run.status = "cancelled";
      run.completedAt = new Date().toISOString();
      runPersistence.save(run);
      compilerService.emitEvent(run.runId, "cancelled", run);
      res.json(run);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL', `Failed to cancel compiler run: ${err.message}`);
    }
  });

  app.post('/api/compiler/runs/:id/approve', (req, res) => {
    try {
      const run = runPersistence.get(req.params.id);
      if (!run) {
        return sendApiError(res, 404, 'NOT_FOUND', `Compiler run '${req.params.id}' not found.`);
      }
      // Simple approval mock
      res.json(run);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL', `Failed to approve plan: ${err.message}`);
    }
  });

  app.get('/api/compiler/runs/:id/events', (req, res) => {
    const runId = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const listener = (event: any) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    compilerService.getListeners(runId).push(listener);

    req.on('close', () => {
      const list = compilerService.getListeners(runId);
      const idx = list.indexOf(listener);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    });
  });
}
