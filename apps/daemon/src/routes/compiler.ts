import type { Express, Response } from 'express';
import type { RouteDeps } from '../server-context.js';
import { compilerService, CompilerServiceError } from '../compiler/compiler-service.js';
import { runPersistence } from '../compiler/run-persistence.js';
import { adapterRegistry } from '@open-design/application-compiler';
import type {
  CompilerApproveRequest,
  CompilerIrRequest,
  CompilerPlanRequest,
  CompilerValidateRequest,
} from '@open-design/contracts';

export interface RegisterCompilerRoutesDeps extends RouteDeps<'http'> {}

export function registerCompilerRoutes(app: Express, ctx: RegisterCompilerRoutesDeps) {
  const { sendApiError } = ctx.http;

  /**
   * Map a typed CompilerServiceError onto its HTTP response. Returns false for
   * non-service errors so callers can fall through to their 500 handler.
   */
  const sendCompilerServiceError = (res: Response, err: unknown): boolean => {
    if (!(err instanceof CompilerServiceError)) return false;
    if (err.code === 'PLAN_HASH_MISMATCH') {
      sendApiError(res, 409, 'PLAN_HASH_MISMATCH', err.message);
    } else {
      sendApiError(res, 404, 'NOT_FOUND', err.message);
    }
    return true;
  };

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

  app.post('/api/compiler/ir', (req, res) => {
    try {
      const { projectRoot } = req.body as CompilerIrRequest;
      if (!projectRoot || typeof projectRoot !== 'string') {
        return sendApiError(res, 400, 'BAD_REQUEST', "projectRoot is a required field.");
      }
      // Raw IR retrieval for MCP `get_application_ir`: the docs as loaded,
      // with no validation verdict attached (spec §11.3 read tool).
      res.json(compilerService.loadRaw(projectRoot));
    } catch (err: any) {
      if (!sendCompilerServiceError(res, err)) {
        sendApiError(res, 500, 'INTERNAL', `Failed to load application IR: ${err.message}`);
      }
    }
  });

  app.post('/api/compiler/validate', async (req, res) => {
    try {
      const { projectRoot } = req.body as CompilerValidateRequest;
      if (!projectRoot || typeof projectRoot !== 'string') {
        return sendApiError(res, 400, 'BAD_REQUEST', "projectRoot is a required field.");
      }
      // Validation verdicts (including valid:false) are 200s — only transport
      // failures (missing/nonexistent projectRoot, internal errors) are 4xx/5xx.
      const result = await compilerService.validate(projectRoot);
      res.json(result);
    } catch (err: any) {
      if (!sendCompilerServiceError(res, err)) {
        sendApiError(res, 500, 'INTERNAL', `Failed to validate application: ${err.message}`);
      }
    }
  });

  app.post('/api/compiler/plan', async (req, res) => {
    try {
      const { projectRoot, targetId } = req.body as CompilerPlanRequest;
      if (!projectRoot || !targetId) {
        return sendApiError(res, 400, 'BAD_REQUEST', "projectRoot and targetId are required fields.");
      }
      const result = await compilerService.plan(projectRoot, targetId);
      res.json(result);
    } catch (err: any) {
      if (!sendCompilerServiceError(res, err)) {
        sendApiError(res, 500, 'INTERNAL', `Failed to plan application compile: ${err.message}`);
      }
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
      const { planHash } = (req.body ?? {}) as CompilerApproveRequest;
      if (!planHash) {
        return sendApiError(res, 400, 'BAD_REQUEST', "planHash is a required field.");
      }
      // Hash-bound approval: a mismatch is a 409, not a silent mock pass-through.
      res.json(compilerService.approve(req.params.id, planHash));
    } catch (err: any) {
      if (!sendCompilerServiceError(res, err)) {
        sendApiError(res, 500, 'INTERNAL', `Failed to approve plan: ${err.message}`);
      }
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
