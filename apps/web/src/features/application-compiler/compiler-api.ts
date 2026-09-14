// Typed fetch client for the daemon's Application Compiler HTTP surface
// (spec §11.4 / §11.5). Same-origin `/api` prefix, contracts DTOs only —
// this module must never import `apps/daemon/src/**`. Errors surface as
// `CompilerApiError` carrying the HTTP status and the daemon's
// `{ error: { code, message } }` code so callers can branch on
// PLAN_HASH_MISMATCH (409) without string matching.

import type {
  CompilerPlanRequest,
  CompilerPlanResult,
  CompilerRunStatus,
  CompilerTargetInfo,
  CompilerValidateRequest,
  CompilerValidationResult,
} from '@open-design/contracts';

export class CompilerApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'CompilerApiError';
    this.status = status;
    this.code = code;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    /* fall through to the status text */
  }
  return `Compiler API request failed with status ${response.status}.`;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new CompilerApiError(0, null, err instanceof Error ? err.message : 'Network error.');
  }
  if (!response.ok) {
    const [message, code] = await Promise.all([readErrorMessage(response), errorCode(response)]);
    throw new CompilerApiError(response.status, code, message);
  }
  return (await response.json()) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export function fetchCompilerTargets(): Promise<CompilerTargetInfo[]> {
  return request<CompilerTargetInfo[]>('/api/compiler/targets');
}

export function validateCompilerProject(
  req: CompilerValidateRequest,
): Promise<CompilerValidationResult> {
  // Validation verdicts (valid: false) arrive as 200s; only transport
  // failures throw here.
  return post<CompilerValidationResult>('/api/compiler/validate', req);
}

export function planCompilerProject(req: CompilerPlanRequest): Promise<CompilerPlanResult> {
  return post<CompilerPlanResult>('/api/compiler/plan', req);
}

export async function startCompilerRun(
  req: CompilerPlanRequest,
): Promise<CompilerRunStatus> {
  const result = await post<{ runId: string; status: CompilerRunStatus }>(
    '/api/compiler/runs',
    req,
  );
  return result.status;
}

export function getCompilerRun(runId: string): Promise<CompilerRunStatus> {
  return request<CompilerRunStatus>(
    `/api/compiler/runs/${encodeURIComponent(runId)}`,
  );
}

export function cancelCompilerRun(runId: string): Promise<CompilerRunStatus> {
  return post<CompilerRunStatus>(
    `/api/compiler/runs/${encodeURIComponent(runId)}/cancel`,
    {},
  );
}

export function approveCompilerRun(
  runId: string,
  planHash: string,
): Promise<CompilerRunStatus> {
  return post<CompilerRunStatus>(
    `/api/compiler/runs/${encodeURIComponent(runId)}/approve`,
    { planHash },
  );
}
