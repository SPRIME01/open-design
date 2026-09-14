import { test } from 'vitest';
import { createLiveArtifactsMcpTools, handleLiveArtifactsMcpRequest } from '../../src/mcp-live-artifacts-server.js';
import { AGENT_DEFS, assert, buildLiveArtifactsMcpServersForAgent, hermes, kimi } from './helpers/test-helpers.js';

test('live artifact MCP discovery is limited to mature ACP agents', () => {
  for (const agent of AGENT_DEFS) {
    const server = buildLiveArtifactsMcpServersForAgent(agent);
    if (agent.mcpDiscovery !== 'mature-acp') {
      assert.deepEqual(server, []);
      continue;
    }
    assert.equal(server.length, 1);
    const s = server[0];
    if (!s) throw new Error('unreachable: server length verified as 1 above');
    assert.equal(s.name, 'open-design-live-artifacts');
    assert.equal(s.command, 'od');
    assert.deepEqual(s.args, ['mcp', 'live-artifacts']);
    const envIsMap =
      typeof s.env === 'object' && s.env !== null && !Array.isArray(s.env);
    const envIsArray = Array.isArray(s.env);
    assert.ok(envIsArray || envIsMap, `env must be array or map, got ${typeof s.env}`);
    if (envIsArray) {
      assert.deepEqual(s.env, [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]);
    }
    if (envIsMap) {
      assert.deepEqual(s.env, { ELECTRON_RUN_AS_NODE: '1' });
    }
  }
});

test('live artifact MCP discovery is disabled when run-scoped tool auth is unavailable', () => {
  assert.deepEqual(buildLiveArtifactsMcpServersForAgent(hermes, { enabled: false }), []);
});

test('Kimi retains ACP live-artifacts and external MCP wiring', () => {
  assert.equal(kimi.mcpDiscovery, 'mature-acp');
  assert.equal(kimi.externalMcpInjection, 'acp-merge');
  assert.deepEqual(buildLiveArtifactsMcpServersForAgent(kimi), [
    {
      name: 'open-design-live-artifacts',
      command: 'od',
      args: ['mcp', 'live-artifacts'],
      env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    },
  ]);
});

test('live artifact MCP discovery can use daemon-resolved CLI command', () => {
  assert.deepEqual(
    buildLiveArtifactsMcpServersForAgent(hermes, {
      command: process.execPath,
      argsPrefix: ['/workspace/apps/daemon/dist/cli.js'],
    } as unknown as Parameters<typeof buildLiveArtifactsMcpServersForAgent>[1]),
    [
      {
        name: 'open-design-live-artifacts',
        command: process.execPath,
        args: ['/workspace/apps/daemon/dist/cli.js', 'mcp', 'live-artifacts'],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
      },
    ],
  );
});

test('MCP-capable agents can discover equivalent live artifact and connector tools', async () => {
  const tools = createLiveArtifactsMcpTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'live_artifacts_create',
    'live_artifacts_list',
    'live_artifacts_update',
    'live_artifacts_refresh',
    'connectors_list',
    'connectors_execute',
    'list_application_targets',
    'get_application_ir',
    'validate_application_ir',
    'plan_application_target',
    'compile_application_target',
    'get_compiler_run',
    'get_compiler_evidence',
  ]);

  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.match(tool.description, /POSIX equivalent: `"\$OD_NODE_BIN" "\$OD_BIN" (tools|app) /u);
    assert.equal(tool.inputSchema.type, 'object');
  }

  // Spec §11.3: the six compiler read tools are read-only + idempotent and
  // carry no destructive hint; compile is the only write-capable tool.
  const READ_TOOLS = [
    'list_application_targets',
    'get_application_ir',
    'validate_application_ir',
    'plan_application_target',
    'get_compiler_run',
    'get_compiler_evidence',
  ];
  for (const name of READ_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `expected tool ${name} in roster`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} must be annotated readOnlyHint:true`);
    assert.equal(tool.annotations?.idempotentHint, true, `${name} must be annotated idempotentHint:true`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name} must not carry a destructive hint`);
  }
  const compileTool = tools.find((t) => t.name === 'compile_application_target');
  assert.ok(compileTool);
  assert.equal(compileTool.annotations?.readOnlyHint, false, 'compile_application_target must be annotated readOnlyHint:false');
  assert.equal(compileTool.annotations?.destructiveHint, false, 'compile_application_target is write-capable but not destructive');

  const initialized = await handleLiveArtifactsMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as { result: { serverInfo: { name: string }; capabilities: unknown } };
  assert.equal(initialized.result.serverInfo.name, 'open-design-live-artifacts');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });

  const listed = await handleLiveArtifactsMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) as { result: { tools: Array<{ name: string; annotations?: unknown }> } };
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), tools.map((tool) => tool.name));
  const listedCompile = listed.result.tools.find((tool) => tool.name === 'compile_application_target');
  assert.ok(listedCompile);
  assert.deepEqual(listedCompile.annotations, { title: 'Compile application target', readOnlyHint: false, destructiveHint: false });

  const createTool = tools.find((tool) => tool.name === 'live_artifacts_create')!;
  const updateTool = tools.find((tool) => tool.name === 'live_artifacts_update')!;
  const connectorsListTool = tools.find((tool) => tool.name === 'connectors_list')!;
  const createProperties = createTool.inputSchema.properties as Record<string, unknown>;
  const updateProperties = updateTool.inputSchema.properties as Record<string, unknown>;
  const connectorsListProperties = connectorsListTool.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(createProperties).sort(), ['input', 'provenanceJson', 'templateHtml']);
  assert.deepEqual(Object.keys(updateProperties).sort(), ['artifactId', 'input', 'provenanceJson', 'templateHtml']);
  assert.deepEqual(Object.keys(connectorsListProperties).sort(), ['useCase']);

  // R2: compile accepts the conflict-resolution pass-through (force
  // documents the approvedPlanHash requirement in the schema itself).
  const compileProperties = compileTool.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(compileProperties).sort(), ['approvedPlanHash', 'conflictResolution', 'projectRoot', 'targetId']);
  assert.match(String((compileProperties.conflictResolution as { description?: unknown })?.description), /awaiting_approval/u);
  assert.match(compileTool.description, /awaiting_approval/u);
});

test('live artifact MCP connector list forwards daily digest use case to daemon tools', async () => {
  process.env.OD_DAEMON_URL = 'http://127.0.0.1:17456/base';
  process.env.OD_TOOL_TOKEN = 'test-tool-token';
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ connectors: [] }), { status: 200 });
  };

  const response = await handleLiveArtifactsMcpRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'connectors_list', arguments: { useCase: 'personal_daily_digest' } },
  }) as { error?: unknown };

  assert.equal(response.error, undefined);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'http://127.0.0.1:17456/base/api/tools/connectors/list?useCase=personal_daily_digest');
});

test('live artifact MCP create forwards input and artifact payload fields to daemon tools', async () => {
  process.env.OD_DAEMON_URL = 'http://127.0.0.1:17456';
  process.env.OD_TOOL_TOKEN = 'test-tool-token';
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ artifact: { id: 'artifact-1' } }), { status: 200 });
  };

  const input = { title: 'Demo', preview: { type: 'html', entry: 'index.html' } };
  const templateHtml = '<h1>{{data.title}}</h1>';
  const provenanceJson = { source: { type: 'mcp-test' } };
  const response = await handleLiveArtifactsMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'live_artifacts_create', arguments: { input, templateHtml, provenanceJson } },
  }) as { error?: unknown };

  assert.equal(response.error, undefined);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.ok(call.init);
  assert.equal(call.url, 'http://127.0.0.1:17456/api/tools/live-artifacts/create');
  assert.deepEqual(JSON.parse(call.init.body as string), { input, templateHtml, provenanceJson });
});

test('live artifact MCP update preserves nested input and artifact payload fields', async () => {
  process.env.OD_DAEMON_URL = 'http://127.0.0.1:17456';
  process.env.OD_TOOL_TOKEN = 'test-tool-token';
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ artifact: { id: 'artifact-1', title: 'Updated' } }), { status: 200 });
  };

  const input = { title: 'Updated', pinned: true };
  const templateHtml = '<p>{{data.value}}</p>';
  const provenanceJson = { source: { type: 'mcp-update-test' } };
  const response = await handleLiveArtifactsMcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'live_artifacts_update', arguments: { artifactId: 'artifact-1', input, templateHtml, provenanceJson } },
  }) as { error?: unknown };

  assert.equal(response.error, undefined);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.ok(call.init);
  assert.equal(call.url, 'http://127.0.0.1:17456/api/tools/live-artifacts/update');
  assert.deepEqual(JSON.parse(call.init.body as string), { artifactId: 'artifact-1', input, templateHtml, provenanceJson });
});

test('compiler MCP read tools dispatch to the daemon compiler API', async () => {
  process.env.OD_DAEMON_URL = 'http://127.0.0.1:17456';
  process.env.OD_TOOL_TOKEN = 'test-tool-token';
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/compiler/targets')) {
      return new Response(JSON.stringify([{ id: 'html-static' }]), { status: 200 });
    }
    return new Response(JSON.stringify({ bundle: { applicationId: 'guestbook' }, modules: {} }), { status: 200 });
  };

  const targetsResponse = await handleLiveArtifactsMcpRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'list_application_targets', arguments: {} },
  }) as { error?: unknown };
  assert.equal(targetsResponse.error, undefined);

  const irResponse = await handleLiveArtifactsMcpRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'get_application_ir', arguments: { projectRoot: '/tmp/guestbook' } },
  }) as { error?: unknown };
  assert.equal(irResponse.error, undefined);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:17456/api/compiler/targets');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[1]?.url, 'http://127.0.0.1:17456/api/compiler/ir');
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1]?.init?.body as string), { projectRoot: '/tmp/guestbook' });
});

test('compiler MCP evidence tool returns references and a concise summary, not file contents', async () => {
  process.env.OD_DAEMON_URL = 'http://127.0.0.1:17456';
  process.env.OD_TOOL_TOKEN = 'test-tool-token';
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        runId: 'run-1',
        status: 'failed',
        diagnostics: [
          { code: 'verification_failed', severity: 'error', phase: 'verification', message: 'x'.repeat(500) },
          { code: 'lint_advisory', severity: 'advisory', phase: 'write', message: 'minor' },
        ],
        evidenceRefs: { planPath: '/p/plan.json', manifestPath: '/p/manifest.json' },
      }),
      { status: 200 },
    );
  };

  const response = await handleLiveArtifactsMcpRequest({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'get_compiler_evidence', arguments: { runId: 'run-1' } },
  }) as { error?: unknown; result: { content: Array<{ type: string; text: string }> } };

  assert.equal(response.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://127.0.0.1:17456/api/compiler/runs/run-1');
  const payload = JSON.parse(response.result.content[0]!.text) as {
    runId: string;
    status: string;
    evidenceRefs: Record<string, string>;
    diagnosticsSummary: { total: number; errors: number; warnings: number; advisories: number; items: Array<{ message: string }> };
  };
  assert.equal(payload.runId, 'run-1');
  assert.equal(payload.status, 'failed');
  assert.deepEqual(payload.evidenceRefs, { planPath: '/p/plan.json', manifestPath: '/p/manifest.json' });
  assert.equal(payload.diagnosticsSummary.total, 2);
  assert.equal(payload.diagnosticsSummary.errors, 1);
  assert.equal(payload.diagnosticsSummary.advisories, 1);
  assert.equal(payload.diagnosticsSummary.items[0]?.message.length, 200);
  assert.ok(payload.diagnosticsSummary.items[0]?.message.endsWith('...'));
});
