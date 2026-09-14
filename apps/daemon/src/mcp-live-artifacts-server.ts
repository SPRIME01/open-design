import readline from 'node:readline';

type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /**
   * MCP tool annotations (the SDK Tool shape's hint subset). Read-only tools
   * set `readOnlyHint: true` + `idempotentHint: true`; write-capable tools
   * set `readOnlyHint: false` so MCP clients can gate them (spec §11.3).
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

interface McpServerResult {
  exitCode: number;
}

const EMPTY_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} satisfies JsonObject;

const CONNECTORS_LIST_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    useCase: { type: 'string', enum: ['personal_daily_digest'] },
  },
} satisfies JsonObject;

const ARTIFACT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'LiveArtifactCreateInput/LiveArtifactUpdateInput JSON plus optional templateHtml and provenanceJson fields.',
} satisfies JsonObject;

const PROJECT_ROOT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectRoot'],
  properties: {
    projectRoot: { type: 'string', minLength: 1, description: 'Project root containing application.ir.json.' },
  },
} satisfies JsonObject;

const PLAN_TARGET_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectRoot', 'targetId'],
  properties: {
    projectRoot: { type: 'string', minLength: 1 },
    targetId: { type: 'string', minLength: 1 },
  },
} satisfies JsonObject;

const COMPILE_TARGET_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetId'],
  properties: {
    projectRoot: { type: 'string', description: 'Defaults to the daemon process cwd (".").' },
    targetId: { type: 'string', minLength: 1 },
  },
} satisfies JsonObject;

const RUN_ID_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId'],
  properties: {
    runId: { type: 'string', minLength: 1 },
  },
} satisfies JsonObject;

/** Read-only annotation shared by the six read tools (spec §11.3). */
function readOnlyToolAnnotations(title: string): NonNullable<McpTool['annotations']> {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  };
}

export function createLiveArtifactsMcpTools(): McpTool[] {
  return [
    {
      name: 'live_artifacts_create',
      description: 'Create a project-scoped live artifact through the daemon tool endpoint. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools live-artifacts create --input artifact.json`.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['input'],
        properties: {
          input: ARTIFACT_INPUT_SCHEMA,
          templateHtml: { type: 'string' },
          provenanceJson: { type: 'object', additionalProperties: true },
        },
      },
    },
    {
      name: 'live_artifacts_list',
      description: 'List compact project-scoped live artifacts through the daemon tool endpoint. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools live-artifacts list --format compact`.',
      inputSchema: EMPTY_OBJECT_SCHEMA,
    },
    {
      name: 'live_artifacts_update',
      description: 'Update a live artifact through the daemon tool endpoint. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools live-artifacts update --artifact-id <id> --input artifact.json`.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['artifactId', 'input'],
        properties: {
          artifactId: { type: 'string', minLength: 1 },
          input: ARTIFACT_INPUT_SCHEMA,
          templateHtml: { type: 'string' },
          provenanceJson: { type: 'object', additionalProperties: true },
        },
      },
    },
    {
      name: 'live_artifacts_refresh',
      description: 'Refresh a live artifact through the daemon tool endpoint. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools live-artifacts refresh --artifact-id <id>`.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['artifactId'],
        properties: {
          artifactId: { type: 'string', minLength: 1 },
        },
      },
    },
    {
      name: 'connectors_list',
      description: 'List connector catalog and available read-only tools through the daemon tool endpoint. Use `{ "useCase": "personal_daily_digest" }` for curated daily-digest tools. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools connectors list --use-case personal_daily_digest --format compact` or fallback `"$OD_NODE_BIN" "$OD_BIN" tools connectors list --format compact`.',
      inputSchema: CONNECTORS_LIST_INPUT_SCHEMA,
    },
    {
      name: 'connectors_execute',
      description: 'Execute an allowed connector read tool through the daemon tool endpoint. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools connectors execute --connector <id> --tool <name> --input input.json`.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['connectorId', 'toolName', 'input'],
        properties: {
          connectorId: { type: 'string', minLength: 1 },
          toolName: { type: 'string', minLength: 1 },
          input: { type: 'object', additionalProperties: true },
        },
      },
    },
    {
      name: 'list_application_targets',
      description:
        'List all registered application target adapters with their id, version, kind, features, and limitations. Read-only. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app targets list`.',
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: readOnlyToolAnnotations('List application targets'),
    },
    {
      name: 'get_application_ir',
      description:
        'Load a project\'s raw application IR documents — the bundle (application.ir.json) plus the domain, capabilities, boundary, persistence, and frontend modules — exactly as the compiler reads them from disk, without validating. Read-only. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app validate --project <dir>` (nearest CLI read of the same IR documents; it returns a verdict instead of the raw docs).',
      inputSchema: PROJECT_ROOT_INPUT_SCHEMA,
      annotations: readOnlyToolAnnotations('Get application IR'),
    },
    {
      name: 'validate_application_ir',
      description:
        'Validate a project\'s application IR and return the verdict plus structured diagnostics without compiling. Read-only. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app validate --project <dir>`.',
      inputSchema: PROJECT_ROOT_INPUT_SCHEMA,
      annotations: readOnlyToolAnnotations('Validate application IR'),
    },
    {
      name: 'plan_application_target',
      description:
        'Plan a compile for a target without writing generated output: returns the plan hash, file plan (creates/modifies/deletes/reuses), conflicts, and required permissions. The daemon records plan evidence under the project\'s compiler/ directory; generated/ output is not touched. Read-only. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app plan --project <dir> --target <id>`.',
      inputSchema: PLAN_TARGET_INPUT_SCHEMA,
      annotations: readOnlyToolAnnotations('Plan application target'),
    },
    {
      name: 'compile_application_target',
      description:
        'Run the full compilation pipeline for a target and poll the run until it reaches a terminal state (succeeded/failed/cancelled). Write-capable: it writes generated output under the project\'s generated/<target>/ directory and executes the verification steps the adapter planned. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app compile --project <path> --target <targetId>`.',
      inputSchema: COMPILE_TARGET_INPUT_SCHEMA,
      annotations: {
        title: 'Compile application target',
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    {
      name: 'get_compiler_run',
      description:
        'Fetch one compiler run record: status, phase, progress, plan hash, diagnostics, and evidence references. Read-only. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app run get <runId>`.',
      inputSchema: RUN_ID_INPUT_SCHEMA,
      annotations: readOnlyToolAnnotations('Get compiler run'),
    },
    {
      name: 'get_compiler_evidence',
      description:
        'Fetch a compiler run\'s evidence references (plan, manifest, evidence, and diagnostics paths) plus a concise diagnostics summary. Returns references and summaries, not file contents — use the existing get_file/list_files tools to read referenced files. Read-only. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" app run get <runId>`.',
      inputSchema: RUN_ID_INPUT_SCHEMA,
      annotations: readOnlyToolAnnotations('Get compiler evidence'),
    },
  ];
}

function daemonUrl(): URL {
  const rawUrl = process.env.OD_DAEMON_URL;
  if (!rawUrl) throw new Error('OD_DAEMON_URL is required');
  const url = new URL(rawUrl);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url;
}

function toolToken(): string {
  const token = process.env.OD_TOOL_TOKEN;
  if (!token) throw new Error('OD_TOOL_TOKEN is required');
  return token;
}

function endpoint(baseUrl: URL, pathname: string): string {
  const url = new URL(baseUrl.toString());
  const [pathPart, searchPart] = pathname.split('?');
  url.pathname = `${url.pathname}${pathPart ?? ''}`.replace(/\/+/gu, '/');
  url.search = searchPart === undefined ? '' : `?${searchPart}`;
  return url.toString();
}

async function requestJson<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint(daemonUrl(), pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${toolToken()}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    const error = new Error(`daemon tool endpoint failed with ${response.status}`);
    (error as Error & { details?: unknown }).details = body;
    throw error;
  }
  return body as T;
}

/**
 * Concise diagnostics summary for `get_compiler_evidence` (spec §11.3 prefers
 * references and concise summaries over dumping content): severity counts
 * plus per-diagnostic code/severity/phase with messages truncated to 200
 * chars — full messages live in the referenced diagnostics file.
 */
function summarizeCompilerDiagnostics(diagnostics: unknown): {
  total: number;
  errors: number;
  warnings: number;
  advisories: number;
  items: Array<{ code: unknown; severity: unknown; phase: unknown; message: unknown }>;
} {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const countBySeverity = (severity: string) =>
    list.filter((d) => typeof d === 'object' && d !== null && (d as { severity?: unknown }).severity === severity).length;
  return {
    total: list.length,
    errors: countBySeverity('error'),
    warnings: countBySeverity('warning'),
    advisories: countBySeverity('advisory'),
    items: list.map((d) => {
      const item = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {};
      const message = typeof item.message === 'string' && item.message.length > 200
        ? `${item.message.slice(0, 197)}...`
        : item.message;
      return { code: item.code, severity: item.severity, phase: item.phase, message };
    }),
  };
}

async function callTool(name: string, args: JsonObject): Promise<unknown> {
  if (name === 'live_artifacts_create') {
    return await requestJson('/api/tools/live-artifacts/create', {
      method: 'POST',
      body: JSON.stringify({
        input: args.input ?? {},
        ...(typeof args.templateHtml === 'string' ? { templateHtml: args.templateHtml } : {}),
        ...(args.provenanceJson && typeof args.provenanceJson === 'object' && !Array.isArray(args.provenanceJson) ? { provenanceJson: args.provenanceJson } : {}),
      }),
    });
  }
  if (name === 'live_artifacts_list') {
    return await requestJson('/api/tools/live-artifacts/list', { method: 'GET' });
  }
  if (name === 'live_artifacts_update') {
    return await requestJson('/api/tools/live-artifacts/update', {
      method: 'POST',
      body: JSON.stringify({
        artifactId: args.artifactId,
        input: typeof args.input === 'object' && args.input ? args.input : {},
        ...(typeof args.templateHtml === 'string' ? { templateHtml: args.templateHtml } : {}),
        ...(args.provenanceJson && typeof args.provenanceJson === 'object' && !Array.isArray(args.provenanceJson) ? { provenanceJson: args.provenanceJson } : {}),
      }),
    });
  }
  if (name === 'live_artifacts_refresh') {
    return await requestJson('/api/tools/live-artifacts/refresh', { method: 'POST', body: JSON.stringify({ artifactId: args.artifactId }) });
  }
  if (name === 'connectors_list') {
    const useCase = args.useCase === 'personal_daily_digest' ? '?useCase=personal_daily_digest' : '';
    return await requestJson(`/api/tools/connectors/list${useCase}`, { method: 'GET' });
  }
  if (name === 'connectors_execute') {
    return await requestJson('/api/tools/connectors/execute', {
      method: 'POST',
      body: JSON.stringify({ connectorId: args.connectorId, toolName: args.toolName, input: args.input ?? {} }),
    });
  }
  if (name === 'list_application_targets') {
    return await requestJson('/api/compiler/targets', { method: 'GET' });
  }
  if (name === 'get_application_ir') {
    return await requestJson('/api/compiler/ir', {
      method: 'POST',
      body: JSON.stringify({ projectRoot: args.projectRoot }),
    });
  }
  if (name === 'validate_application_ir') {
    return await requestJson('/api/compiler/validate', {
      method: 'POST',
      body: JSON.stringify({ projectRoot: args.projectRoot }),
    });
  }
  if (name === 'plan_application_target') {
    return await requestJson('/api/compiler/plan', {
      method: 'POST',
      body: JSON.stringify({ projectRoot: args.projectRoot, targetId: args.targetId }),
    });
  }
  if (name === 'compile_application_target') {
    const projectRoot = typeof args.projectRoot === 'string' ? args.projectRoot : '.';
    const targetId = args.targetId;
    const startRes = await requestJson('/api/compiler/runs', {
      method: 'POST',
      body: JSON.stringify({ projectRoot, targetId }),
    }) as any;
    const runId = startRes.runId;
    let status = startRes.status;
    while (status.status !== 'succeeded' && status.status !== 'failed' && status.status !== 'cancelled') {
      await new Promise(resolve => setTimeout(resolve, 500));
      status = await requestJson(`/api/compiler/runs/${runId}`, { method: 'GET' });
    }
    return status;
  }
  if (name === 'get_compiler_run') {
    return await requestJson(`/api/compiler/runs/${encodeURIComponent(String(args.runId))}`, { method: 'GET' });
  }
  if (name === 'get_compiler_evidence') {
    const run = await requestJson(`/api/compiler/runs/${encodeURIComponent(String(args.runId))}`, { method: 'GET' }) as any;
    return {
      runId: run.runId,
      status: run.status,
      evidenceRefs: run.evidenceRefs ?? {},
      diagnosticsSummary: summarizeCompilerDiagnostics(run.diagnostics),
    };
  }
  throw new Error(`unknown MCP tool: ${name}`);
}

export async function handleLiveArtifactsMcpRequest(request: JsonRpcRequest): Promise<JsonObject | undefined> {
  const id = request.id ?? null;
  const method = request.method;

  if (method === 'notifications/initialized') return undefined;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'open-design-live-artifacts', version: '0.1.0' },
        },
      };
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: createLiveArtifactsMcpTools() } };
    }

    if (method === 'tools/call') {
      const params = request.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as JsonObject) : {};
      const result = await callTool(name, args);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        },
      };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: unknown }).details : undefined;
    return { jsonrpc: '2.0', id, error: { code: -32000, message, ...(details === undefined ? {} : { data: details }) } };
  }
}

export async function runLiveArtifactsMcpServer(): Promise<McpServerResult> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      continue;
    }
    const response = await handleLiveArtifactsMcpRequest(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  return { exitCode: 0 };
}
