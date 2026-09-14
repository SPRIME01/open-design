// `od app …` — the canonical application-compiler CLI (spec §11.1).
//
// A thin HTTP client over the daemon's `/api/compiler/*` surface, plus one
// local-scaffold command (`init`). Registered as `app` in the SUBCOMMAND_MAP
// of `src/cli.ts`; the legacy `od compiler` alias delegates to the same
// `targets` / `compile` handlers exported here.
//
// Exit-code contract (mirrors sibling `od` commands):
//   0 — success
//   1 — run/validation failure or a daemon HTTP error response
//   2 — usage error (unknown flag/subcommand, missing required flag, init
//       overwrite refusal, unresolvable --target, --approve-plan without
//       --conflict-resolution force)
//   3 — daemon unreachable (connection error)
//   4 — the compile paused in awaiting_approval (force conflict resolution
//       without an approved plan hash); approve the printed plan hash with
//       `od app approve` and re-run

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CompilerDiagnostic,
  CompilerEvidence,
  CompilerMetricsSnapshot,
  CompilerPlanResult,
  CompilerRunStatus,
  CompilerTargetInfo,
  CompilerValidationResult,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';
import {
  isStarterTemplateId,
  STARTER_TEMPLATES,
  type StarterTemplate,
} from './app-templates.js';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_DAEMON = 3;
/** Compile paused in awaiting_approval — approve the plan hash, then re-run. */
const EXIT_AWAITING_APPROVAL = 4;

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_EVENT_TYPES = new Set(['success', 'failure', 'cancelled']);
const AWAITING_APPROVAL_EVENT_TYPE = 'awaiting_approval';

const CONFLICT_RESOLUTIONS = ['block', 'plan-only', 'force'] as const;
type ConflictResolutionFlag = (typeof CONFLICT_RESOLUTIONS)[number];

function parseConflictResolution(value: string): ConflictResolutionFlag {
  if ((CONFLICT_RESOLUTIONS as readonly string[]).includes(value)) {
    return value as ConflictResolutionFlag;
  }
  console.error(`Error: --conflict-resolution must be one of: ${CONFLICT_RESOLUTIONS.join(', ')}.`);
  process.exit(EXIT_USAGE);
}

/** True when a poll/SSE follow loop should stop: terminal or paused for approval. */
function runReachedStopState(status: string): boolean {
  return isTerminalRunStatus(status) || status === 'awaiting_approval';
}

/** Every string flag accepted anywhere under `od app` (union across subcommands). */
export const APP_STRING_FLAGS = new Set([
  'daemon-url',
  'project',
  'target',
  'template',
  'run',
  'conflict-resolution',
  'approve-plan',
  'plan-hash',
  'resolution',
]);
/** Every boolean flag accepted anywhere under `od app` (union across subcommands). */
export const APP_BOOLEAN_FLAGS = new Set(['help', 'h', 'json', 'follow', 'wait']);

const GLOBAL_STRING_FLAGS = new Set(['daemon-url']);
const GLOBAL_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const INIT_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS, 'project', 'template']);
const VALIDATE_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS, 'project']);
const TARGET_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS]);
const PLAN_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS, 'project', 'target', 'conflict-resolution']);
const RUN_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS, 'run']);
const METRICS_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS]);
const COMPILE_STRING_FLAGS = new Set([...PLAN_STRING_FLAGS, 'approve-plan']);
const APPROVE_STRING_FLAGS = new Set([...GLOBAL_STRING_FLAGS, 'plan-hash', 'resolution']);
const COMPILE_BOOLEAN_FLAGS = new Set([...GLOBAL_BOOLEAN_FLAGS, 'follow', 'wait']);

type Flags = Record<string, string | boolean | undefined>;

// Same semantics as `parseFlags` in cli.ts (strict `--flag` whitelist so a
// hallucinated flag fails fast instead of silently no-op'ing). Reimplemented
// locally because importing it from cli.ts would create an import cycle
// (cli.ts imports this module for SUBCOMMAND_MAP dispatch).
function parseFlags(argv: string[], stringFlags: Set<string>, booleanFlags: Set<string>): Flags {
  const known = new Set([...stringFlags, ...booleanFlags]);
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue; // positionals are collected by the caller
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (known.size > 0 && !known.has(key)) {
      throw new Error(`unknown flag: --${key}. Run with --help for the list of accepted flags.`);
    }
    if (eq >= 0) {
      out[key] = a.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    if (stringFlags.has(key)) {
      const next = argv[i + 1];
      if (next == null) throw new Error(`flag --${key} requires a value`);
      out[key] = next;
      i++;
      continue;
    }
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function positionalArgs(argv: string[], stringFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq < 0 && stringFlags.has(key)) i++;
  }
  return out;
}

function parseArgs(
  argv: string[],
  stringFlags: Set<string>,
  booleanFlags: Set<string>,
): Flags {
  try {
    return parseFlags(argv, stringFlags, booleanFlags);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_USAGE);
  }
}

function isHelp(flags: Flags): boolean {
  return flags.help === true || flags.h === true;
}

async function daemonBaseUrl(flags: Flags): Promise<string> {
  const flagUrl = typeof flags['daemon-url'] === 'string' ? flags['daemon-url'] : null;
  return (await resolveDaemonUrl({ flagUrl })).replace(/\/+$/, '');
}

function connectError(base: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Failed to connect to daemon at ${base}: ${message}`);
  process.exit(EXIT_DAEMON);
}

async function httpErrorMessage(resp: Response): Promise<string> {
  let raw = '';
  try {
    raw = await resp.text();
  } catch {
    // fall through to the status-only message
  }
  try {
    const parsed = raw ? (JSON.parse(raw) as { error?: unknown }) : {};
    const err = parsed?.error;
    const message = typeof err === 'string' ? err : (err as { message?: string } | undefined)?.message;
    if (message) return `${resp.status}: ${message}`;
  } catch {
    // non-JSON body
  }
  return `${resp.status}${raw ? `: ${raw}` : ''}`;
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function diagnosticLine(d: CompilerDiagnostic): string {
  const where = d.sourceFile ? ` at ${d.sourceFile}${d.pointer ?? ''}` : '';
  return `[${d.severity.toUpperCase()}] ${d.message} (${d.code}) [${d.phase}]${where}`;
}

function requireProjectRoot(flags: Flags): string {
  const project = typeof flags.project === 'string' ? flags.project.trim() : '';
  return path.resolve(project.length > 0 ? project : process.cwd());
}

/**
 * Resolve the target for plan/compile/verify. An explicit `--target` always
 * wins; without one, the project's projection.config.json must declare
 * exactly one target (spec §11.1). Zero or multiple targets is a usage error
 * that lists the available target IDs. Deliberately resolved BEFORE any
 * daemon contact so target-usage mistakes fail fast and offline.
 */
function resolveTargetId(flags: Flags, projectRoot: string): string {
  const explicit = typeof flags.target === 'string' ? flags.target.trim() : '';
  if (explicit.length > 0) return explicit;

  const configPath = path.join(projectRoot, 'projection.config.json');
  let config: { targets?: Array<{ id?: unknown }> } | null = null;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { targets?: Array<{ id?: unknown }> };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: failed to parse ${configPath}: ${message}`);
      process.exit(EXIT_USAGE);
    }
  }
  const ids = (config?.targets ?? [])
    .map((t) => (t && typeof t.id === 'string' ? t.id : null))
    .filter((id): id is string => id != null);
  const [onlyTarget] = ids;
  if (ids.length === 1 && onlyTarget !== undefined) return onlyTarget;
  if (ids.length === 0) {
    console.error(
      `Error: --target is required (${
        config ? 'projection.config.json declares no targets' : `no projection.config.json at ${configPath}`
      }).`,
    );
    process.exit(EXIT_USAGE);
  }
  console.error(
    `Error: --target is required: projection.config.json declares multiple targets (${ids.join(', ')}).`,
  );
  process.exit(EXIT_USAGE);
}

// ---- help -------------------------------------------------------------------

export function printAppHelp(): void {
  console.log(`Usage: od app <subcommand> [flags]

Canonical application-compiler CLI. Every subcommand talks to the OpenDesign
daemon over HTTP except init, which only writes local files.

Subcommands:
  init --project <dir> [--template crud|marketing] [--json]
                                        Scaffold a valid, immediately
                                        compilable starter bundle
                                        (application.ir.json + ir/*.ir.json +
                                        projection.config.json). WRITES FILES
                                        under <dir>; refuses to overwrite an
                                        existing application.ir.json.
  validate --project <dir> [--json]     Validate the bundle. Read-only.
  targets [list] [--json]               List target adapters. Read-only.
  plan --project <dir> [--target <id>] [--conflict-resolution <block|plan-only|force>] [--json]
                                        Plan a compile without writing any
                                        output. Read-only (the daemon records
                                        the plan under compiler/plans/).
                                        --target may be omitted when
                                        projection.config.json declares
                                        exactly one target. Plan with the
                                        same --conflict-resolution you will
                                        compile with: the returned hash is
                                        what --approve-plan presents.
  compile --project <dir> [--target <id>] [--conflict-resolution <block|plan-only|force>] [--approve-plan <hash>] [--follow] [--wait] [--json]
                                        Run the full pipeline. WRITES FILES
                                        under the target outputRoot via the
                                        daemon. --conflict-resolution
                                        overrides the target config's
                                        conflictPolicy; when the effective
                                        resolution is 'force' (from the flag
                                        OR the config) and no matching
                                        --approve-plan hash is presented,
                                        the run pauses in awaiting_approval
                                        (exit 4) before any write — approve
                                        the printed plan hash and re-run.
                                        --approve-plan is only valid with
                                        --conflict-resolution force. A run
                                        may also end blocked by unresolved
                                        references or file conflicts;
                                        approving a plan afterwards
                                        requires the run's planHash through
                                        POST /api/compiler/runs/<id>/approve.
  verify --project <dir> [--target <id>] [--conflict-resolution <block|plan-only|force>] [--approve-plan <hash>] [--follow] [--json]
                                        Compile, then report verification
                                        evidence. WRITES FILES and EXECUTES
                                        the VERIFICATION commands the target
                                        adapter planned.
  approve <run-id> --plan-hash <hash> [--resolution force] [--json]
                                        Approve a run's plan hash. On a run
                                        paused in awaiting_approval with a
                                        matching hash (and --resolution
                                        force) the run resumes and completes
                                        the force compile.
  run get <run-id> [--json]             Fetch one compile run record.
                                        Read-only.
  conflicts list --run <run-id> [--json]
                                        Show plan conflicts recorded on a
                                        run's diagnostics. Read-only.
  metrics [--json]                     Daemon-wide compiler run metrics
                                        (spec §12.3): runs by terminal
                                        status, per-target success, no-op
                                        rate, phase durations, and the
                                        conflict/degraded/verification-
                                        failure counters. Read-only;
                                        counters reset when the daemon
                                        restarts.

Common flags:
  --project <dir>       Project root containing application.ir.json
                        (plan/compile/verify/validate; defaults to the
                        current directory).
  --target <id>         Target adapter ID (e.g. html-static). Optional when
                        projection.config.json declares exactly one target.
  --conflict-resolution <mode>
                        plan/compile/verify: how generated-file conflicts
                        resolve (block | plan-only | force). Overrides the
                        target config's conflictPolicy.
  --approve-plan <hash>
                        compile/verify: pre-approved plan hash for a force
                        run (from 'od app plan --conflict-resolution
                        force'). Only valid together with
                        --conflict-resolution force.
  --daemon-url <url>    Daemon HTTP base (default: auto-discovered).
  --json                Stable machine-readable output.
  --follow              compile/verify: stream run events over SSE until the
                        run reaches a terminal state (falls back to polling
                        when the event stream is unavailable).
  --wait                compile: accepted alias of the default poll-to-
                        completion behavior.

Exit codes: 0 success; 1 run/validation failure or HTTP error; 2 usage error;
3 daemon unreachable; 4 compile paused in awaiting_approval — run the printed
'od app approve' command, then compile again.`);
}

// ---- init -------------------------------------------------------------------

function nextCompileCommand(projectArg: string): string {
  return `od app compile --project ${projectArg} --target html-static`;
}

export async function appInit(rest: string[]): Promise<void> {
  const flags = parseArgs(rest, INIT_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const projectArg = typeof flags.project === 'string' ? flags.project.trim() : '';
  if (projectArg.length === 0) {
    console.error('Error: --project <dir> is required.');
    console.error('Usage: od app init --project <dir> [--template crud|marketing] [--json]');
    process.exit(EXIT_USAGE);
  }
  const templateId = typeof flags.template === 'string' && flags.template.trim().length > 0
    ? flags.template.trim()
    : 'crud';
  if (!isStarterTemplateId(templateId)) {
    console.error(`Error: unknown template '${templateId}' (expected crud | marketing).`);
    process.exit(EXIT_USAGE);
  }
  const template: StarterTemplate = STARTER_TEMPLATES[templateId];
  const projectRoot = path.resolve(projectArg);
  const bundlePath = path.join(projectRoot, 'application.ir.json');
  if (fs.existsSync(bundlePath)) {
    console.error(`Error: refusing to overwrite existing ${bundlePath}.`);
    console.error("'od app init' only scaffolds into a directory that has no application.ir.json.");
    process.exit(EXIT_USAGE);
  }
  fs.mkdirSync(projectRoot, { recursive: true });
  const written: string[] = [];
  for (const file of template.files) {
    const target = path.join(projectRoot, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(file.content, null, 2)}\n`, 'utf8');
    written.push(file.path);
  }
  const next = nextCompileCommand(projectArg);
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ template: templateId, projectRoot, files: written, nextCommand: next }, null, 2)}\n`,
    );
    return;
  }
  console.log(`Initialized ${template.id} template (${template.description}) in ${projectRoot}`);
  for (const file of written) console.log(`  created ${file}`);
  console.log(`Next: ${next}`);
}

// ---- validate ---------------------------------------------------------------

export async function appValidate(rest: string[]): Promise<void> {
  const flags = parseArgs(rest, VALIDATE_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const projectRoot = requireProjectRoot(flags);
  const base = await daemonBaseUrl(flags);
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot }),
    });
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Validation request failed: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  const result = (await resp.json()) as CompilerValidationResult;
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.valid ? EXIT_OK : EXIT_FAILURE);
  }
  console.log(`Valid: ${result.valid ? 'yes' : 'no'}`);
  for (const d of result.diagnostics ?? []) console.log(diagnosticLine(d));
  if (result.diagnosticsPath) console.log(`Diagnostics written to: ${result.diagnosticsPath}`);
  process.exit(result.valid ? EXIT_OK : EXIT_FAILURE);
}

// ---- targets ----------------------------------------------------------------

export async function appTargetsList(rest: string[]): Promise<void> {
  if (rest[0] && !rest[0].startsWith('--') && rest[0] !== 'list') {
    console.error(`unknown subcommand: od app targets ${rest[0]}`);
    process.exit(EXIT_USAGE);
  }
  const args = rest[0] === 'list' ? rest.slice(1) : rest;
  const flags = parseArgs(args, TARGET_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const base = await daemonBaseUrl(flags);
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/targets`);
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Failed to list targets: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  const targets = (await resp.json()) as CompilerTargetInfo[];
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(targets, null, 2)}\n`);
    return;
  }
  for (const t of targets) {
    console.log(`${t.id}@${t.version} (${t.kind})`);
    console.log(`  Features: ${t.features.join(', ') || 'none'}`);
    console.log(`  Limitations: ${t.limitations.join(', ') || 'none'}`);
  }
}

// ---- plan -------------------------------------------------------------------

export async function appPlan(rest: string[]): Promise<void> {
  const flags = parseArgs(rest, PLAN_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const projectRoot = requireProjectRoot(flags);
  const targetId = resolveTargetId(flags, projectRoot);
  const conflictResolution =
    typeof flags['conflict-resolution'] === 'string'
      ? parseConflictResolution(flags['conflict-resolution'])
      : undefined;
  const base = await daemonBaseUrl(flags);
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot,
        targetId,
        ...(conflictResolution ? { conflictResolution } : {}),
      }),
    });
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Plan request failed: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  const result = (await resp.json()) as CompilerPlanResult;
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.status === 'succeeded' ? EXIT_OK : EXIT_FAILURE);
  }
  console.log(`Plan status: ${result.status} (target: ${targetId})`);
  const plan = result.plan;
  if (plan) {
    console.log(`  creates:    ${plan.creates.length}`);
    console.log(`  modifies:   ${plan.modifies.length}`);
    console.log(`  deletes:    ${plan.deletes.length}`);
    console.log(`  conflicts:  ${plan.conflicts.length}`);
    console.log(`  unresolved: ${plan.unresolved.length}`);
    for (const c of plan.conflicts) console.log(`  conflict: ${c.path} (${c.classification})`);
    for (const u of plan.unresolved) console.log(`  unresolved: ${u}`);
    console.log(`Plan hash: ${result.planHash ?? plan.planHash}`);
  }
  for (const d of result.diagnostics ?? []) console.log(diagnosticLine(d));
  if (result.evidenceRefs?.planPath) console.log(`Plan written to: ${result.evidenceRefs.planPath}`);
  process.exit(result.status === 'succeeded' ? EXIT_OK : EXIT_FAILURE);
}

// ---- compile / verify -------------------------------------------------------

interface RunFlags extends Flags {
  follow?: boolean;
  wait?: boolean;
}

/**
 * Resolve the conflict-resolution flags a compile/verify run carries.
 * `--approve-plan` is only meaningful for a force run: presenting a hash
 * without asking for force is a usage error (exit 2), not a silent no-op.
 */
function resolveRunConflictFlags(flags: Flags): {
  conflictResolution?: ConflictResolutionFlag;
  approvedPlanHash?: string;
} {
  const conflictResolution =
    typeof flags['conflict-resolution'] === 'string'
      ? parseConflictResolution(flags['conflict-resolution'])
      : undefined;
  const approvePlan = typeof flags['approve-plan'] === 'string' ? flags['approve-plan'].trim() : '';
  if (approvePlan.length === 0) {
    return conflictResolution ? { conflictResolution } : {};
  }
  if (conflictResolution !== 'force') {
    console.error('Error: --approve-plan is only valid together with --conflict-resolution force.');
    console.error('Plan first with: od app plan --conflict-resolution force');
    process.exit(EXIT_USAGE);
  }
  return { conflictResolution, approvedPlanHash: approvePlan };
}

/**
 * Start a compile run and wait for it to reach a terminal state. `--wait` is
 * accepted as an alias of the default polling behavior (kept for the
 * documented `od compiler compile --wait` compatibility surface); `--follow`
 * streams the daemon's SSE run events and wins when both are given.
 * `streamed` reports whether the terminal state reached the caller through
 * SSE frames (false when plain-polling or a polling fallback produced it).
 * A run that pauses in awaiting_approval also stops the wait; the caller
 * decides how to surface it (compile/verify exit 4 with the approve hint).
 */
async function startAndAwaitRun(
  flags: RunFlags,
  label: string,
): Promise<{ run: CompilerRunStatus; streamed: boolean }> {
  const projectRoot = requireProjectRoot(flags);
  const targetId = resolveTargetId(flags, projectRoot);
  const { conflictResolution, approvedPlanHash } = resolveRunConflictFlags(flags);
  const base = await daemonBaseUrl(flags);
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot,
        targetId,
        ...(conflictResolution ? { conflictResolution } : {}),
        ...(approvedPlanHash ? { approvedPlanHash } : {}),
      }),
    });
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Failed to start ${label.toLowerCase()} run: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  const started = (await resp.json()) as { runId: string; status: CompilerRunStatus };
  if (runReachedStopState(started.status.status)) return { run: started.status, streamed: false };
  if (flags.follow === true) return followRunToTerminal(base, started.runId, flags);
  return { run: await pollRunToTerminal(base, started.runId, flags), streamed: false };
}

async function pollRunToTerminal(
  base: string,
  runId: string,
  flags: RunFlags,
): Promise<CompilerRunStatus> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let resp: Response;
    try {
      resp = await fetch(`${base}/api/compiler/runs/${encodeURIComponent(runId)}`);
    } catch (err) {
      connectError(base, err);
    }
    if (resp.status === 404) {
      console.error(`Run ${runId} disappeared from the daemon (404).`);
      process.exit(EXIT_FAILURE);
    }
    if (!resp.ok) continue; // transient poll failure — retry on the next tick
    const run = (await resp.json()) as CompilerRunStatus;
    if (flags.json !== true) {
      console.log(`[${run.phase}] status=${run.status} progress=${run.progress}%`);
    }
    if (runReachedStopState(run.status)) return run;
  }
}

function renderRunEvent(frame: { type?: unknown; data?: unknown }, flags: RunFlags): void {
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
    return;
  }
  const data = frame?.data as CompilerRunStatus | undefined;
  if (frame?.type === 'progress' && data) {
    console.log(`[${data.phase}] status=${data.status} progress=${data.progress}%`);
    return;
  }
  if (frame?.type === AWAITING_APPROVAL_EVENT_TYPE && data) {
    console.log(
      `[${data.phase}] status=${data.status} — plan approval required (${data.planHash ?? 'no plan hash'})`,
    );
    return;
  }
  console.log(`[event] ${String(frame?.type ?? 'unknown')}`);
}

/**
 * Follow a run over the daemon's SSE stream (`data: {type, data}` frames,
 * same reader/TextDecoder/split-on-blank-line convention as the other `od`
 * SSE consumers). The stream has no backlog, so a run that terminated before
 * we connected would never push a frame: a slow safety poll runs underneath
 * and tears the stream down once the run is terminal. Any connect failure
 * falls back to plain polling.
 */
async function followRunToTerminal(
  base: string,
  runId: string,
  flags: RunFlags,
): Promise<{ run: CompilerRunStatus; streamed: boolean }> {
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/runs/${encodeURIComponent(runId)}/events`, {
      headers: { accept: 'text/event-stream' },
    });
  } catch {
    return { run: await pollRunToTerminal(base, runId, flags), streamed: false };
  }
  if (!resp.ok || !resp.body) {
    return { run: await pollRunToTerminal(base, runId, flags), streamed: false };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readerCancelled = false;
  let stopFromPoll: CompilerRunStatus | null = null;
  const safetyPoll = setInterval(() => {
    void (async () => {
      try {
        const r = await fetch(`${base}/api/compiler/runs/${encodeURIComponent(runId)}`);
        if (!r.ok) return;
        const run = (await r.json()) as CompilerRunStatus;
        if (runReachedStopState(run.status)) {
          stopFromPoll = run;
          if (!readerCancelled) {
            readerCancelled = true;
            void reader.cancel().catch(() => {});
          }
        }
      } catch {
        // transient safety-poll failure — the SSE stream is still authoritative
      }
    })();
  }, 5000);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataRaw = block
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        if (!dataRaw) continue;
        let frame: { type?: unknown; data?: unknown };
        try {
          frame = JSON.parse(dataRaw) as { type?: unknown; data?: unknown };
        } catch {
          continue;
        }
        renderRunEvent(frame, flags);
        if (typeof frame?.type === 'string' && TERMINAL_EVENT_TYPES.has(frame.type)) {
          // The terminal frame already carried the final run object to the
          // consumer; callers must not reprint it.
          return { run: (frame.data ?? {}) as CompilerRunStatus, streamed: true };
        }
        if (frame?.type === AWAITING_APPROVAL_EVENT_TYPE) {
          // Same contract as the terminal frames: the pause frame carried
          // the run object (including planHash) to the consumer already.
          return { run: (frame.data ?? {}) as CompilerRunStatus, streamed: true };
        }
      }
    }
    // Stream closed without a terminal frame (daemon restart or the run
    // finished before the stream attached): nothing about the terminal state
    // was streamed, so let the caller print the final record.
    if (stopFromPoll) return { run: stopFromPoll, streamed: false };
    return { run: await pollRunToTerminal(base, runId, flags), streamed: false };
  } finally {
    clearInterval(safetyPoll);
    if (!readerCancelled) {
      readerCancelled = true;
      void reader.cancel().catch(() => {});
    }
  }
}

/**
 * Surface a run paused in awaiting_approval: print the planHash and the
 * exact approve command, then exit 4 (distinct from 0/1/2/3 so scripts can
 * branch on "needs approval" without parsing output). In --json mode the
 * run object keeps stdout machine-readable; the guidance goes to stderr.
 */
function exitAwaitingApproval(
  run: CompilerRunStatus,
  label: string,
  flags: RunFlags,
  streamed: boolean,
): never {
  const planHash = run.planHash ?? '';
  const approveCommand = `od app approve ${run.runId} --plan-hash ${planHash} --resolution force`;
  if (flags.json === true) {
    if (!streamed) {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    }
    console.error(`${label} paused in awaiting_approval. Next: ${approveCommand}`);
  } else {
    console.log(`${label} paused with status: awaiting_approval (no files were written)`);
    if (planHash) console.log(`Plan hash: ${planHash}`);
    console.log(`Next: ${approveCommand}`);
  }
  process.exit(EXIT_AWAITING_APPROVAL);
}

export async function appCompile(rest: string[]): Promise<void> {
  const flags = parseArgs(rest, COMPILE_STRING_FLAGS, COMPILE_BOOLEAN_FLAGS) as RunFlags;
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const { run, streamed } = await startAndAwaitRun(flags, 'Compilation');
  if (run.status === 'awaiting_approval') {
    exitAwaitingApproval(run, 'Compilation', flags, streamed);
  }
  if (flags.json === true) {
    // When the terminal state arrived as an SSE frame the consumer already
    // saw the final run object; reprinting it would duplicate the last line.
    if (!streamed) {
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    }
  } else {
    console.log(`Compilation finished with status: ${run.status}`);
  }
  if (run.status !== 'succeeded') {
    if (flags.json !== true) {
      for (const d of run.diagnostics ?? []) console.error(diagnosticLine(d));
    }
    process.exit(EXIT_FAILURE);
  }
}

// ---- verify -----------------------------------------------------------------

function loadVerificationEvidence(evidencePath: string | undefined): CompilerEvidence | null {
  if (!evidencePath) return null;
  try {
    return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as CompilerEvidence;
  } catch {
    return null;
  }
}

export async function appVerify(rest: string[]): Promise<void> {
  const flags = parseArgs(rest, COMPILE_STRING_FLAGS, COMPILE_BOOLEAN_FLAGS) as RunFlags;
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const { run, streamed } = await startAndAwaitRun(flags, 'Verification');
  if (run.status === 'awaiting_approval') {
    exitAwaitingApproval(run, 'Verification', flags, streamed);
  }
  const evidencePath = run.evidenceRefs?.evidencePath;
  const evidence = run.status === 'succeeded' ? loadVerificationEvidence(evidencePath) : null;
  const verificationRan = evidence != null && evidence.logs.length > 0;

  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify({ run, evidence, verificationRan }, null, 2)}\n`,
    );
  } else {
    console.log(`Verification finished with status: ${run.status}`);
    if (run.status === 'succeeded') {
      if (!evidencePath) {
        console.log('No verification evidence was recorded for this run.');
      } else if (!evidence) {
        console.log(`Verification evidence could not be read at ${evidencePath}.`);
      } else if (evidence.logs.length === 0) {
        console.log('This target planned no verification steps, so no verification commands ran.');
      } else {
        console.log(`Verification steps executed: ${evidence.logs.length}`);
        for (const log of evidence.logs) {
          const trimmed = log.trim().split('\n')[0];
          console.log(`  - ${trimmed}`);
        }
      }
      if (run.evidenceRefs?.planPath) console.log(`Plan: ${run.evidenceRefs.planPath}`);
      if (run.evidenceRefs?.manifestPath) console.log(`Manifest: ${run.evidenceRefs.manifestPath}`);
      if (evidencePath) console.log(`Verification evidence: ${evidencePath}`);
    }
  }
  if (run.status !== 'succeeded') {
    if (flags.json !== true) {
      for (const d of run.diagnostics ?? []) console.error(diagnosticLine(d));
    }
    process.exit(EXIT_FAILURE);
  }
}

// ---- run get ----------------------------------------------------------------

function printRunRecord(run: CompilerRunStatus): void {
  console.log(`Run ${run.runId}: status=${run.status} phase=${run.phase} progress=${run.progress}%`);
  if (run.planHash) console.log(`Plan hash: ${run.planHash}`);
  if (run.approvedPlanHash) console.log(`Approved plan hash: ${run.approvedPlanHash}`);
  const refs = run.evidenceRefs ?? {};
  if (refs.planPath) console.log(`Plan: ${refs.planPath}`);
  if (refs.manifestPath) console.log(`Manifest: ${refs.manifestPath}`);
  if (refs.evidencePath) console.log(`Verification evidence: ${refs.evidencePath}`);
  if (refs.diagnosticsPath) console.log(`Diagnostics: ${refs.diagnosticsPath}`);
  for (const d of run.diagnostics ?? []) console.log(diagnosticLine(d));
}

async function fetchRun(base: string, runId: string): Promise<CompilerRunStatus> {
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/runs/${encodeURIComponent(runId)}`);
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Failed to get run ${runId}: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  return (await resp.json()) as CompilerRunStatus;
}

export async function appRunGet(rest: string[]): Promise<void> {
  // rest = ['get', '<run-id>', ...flags]
  const args = rest.slice(1);
  const flags = parseArgs(args, GLOBAL_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const runId = positionalArgs(args, GLOBAL_STRING_FLAGS)[0];
  if (!runId) {
    console.error('Error: run id is required.');
    console.error('Usage: od app run get <run-id> [--json] [--daemon-url <url>]');
    process.exit(EXIT_USAGE);
  }
  const base = await daemonBaseUrl(flags);
  const run = await fetchRun(base, runId);
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }
  printRunRecord(run);
}

async function appRun(rest: string[]): Promise<void> {
  if (rest.length === 0 || rest[0] === 'help' || rest.includes('--help') || rest.includes('-h')) {
    console.log('Usage: od app run get <run-id> [--json] [--daemon-url <url>]');
    process.exit(rest.length === 0 ? EXIT_USAGE : EXIT_OK);
  }
  if (rest[0] !== 'get') {
    console.error(`unknown subcommand: od app run ${rest[0]}`);
    process.exit(EXIT_USAGE);
  }
  return appRunGet(rest);
}

// ---- approve -----------------------------------------------------------------

/**
 * `od app approve <run-id> --plan-hash <hash> [--resolution force]`: the CLI
 * twin of `POST /api/compiler/runs/:id/approve`. On a run paused in
 * awaiting_approval, a matching hash with --resolution force resumes the
 * run; on a completed run it records the (idempotent) approval. The daemon
 * answers 409 PLAN_HASH_MISMATCH for a wrong hash, which exits 1 with the
 * daemon's message.
 */
export async function appApprove(rest: string[]): Promise<void> {
  // rest = ['<run-id>', ...flags] — approve takes the run id directly.
  const flags = parseArgs(rest, APPROVE_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const runId = positionalArgs(rest, APPROVE_STRING_FLAGS)[0];
  const planHash = typeof flags['plan-hash'] === 'string' ? flags['plan-hash'].trim() : '';
  if (!runId || planHash.length === 0) {
    console.error('Error: run id and --plan-hash <hash> are required.');
    console.error('Usage: od app approve <run-id> --plan-hash <hash> [--resolution force] [--json]');
    process.exit(EXIT_USAGE);
  }
  const resolution = typeof flags.resolution === 'string' ? flags.resolution.trim() : '';
  if (resolution.length > 0 && resolution !== 'force') {
    console.error("Error: --resolution must be 'force'.");
    process.exit(EXIT_USAGE);
  }
  const base = await daemonBaseUrl(flags);
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/runs/${encodeURIComponent(runId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planHash,
        ...(resolution === 'force' ? { resolution } : {}),
      }),
    });
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Failed to approve run ${runId}: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  const run = (await resp.json()) as CompilerRunStatus;
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }
  console.log(`Run ${runId} approved (plan hash: ${planHash}).`);
  if (run.status === 'queued' || run.status === 'validating') {
    console.log('The run has resumed; poll it with:');
    console.log(`  od app run get ${runId}`);
  }
}

// ---- conflicts list -----------------------------------------------------------

/**
 * Conflicts for a run, HTTP-only: the daemon embeds plan-time conflicts in
 * the run's diagnostics while the run is in the conflicted/blocked state, so
 * `conflicts list` reads the run record and filters diagnostics classified
 * with phase 'planning' (the file_conflicts / unresolved_references codes).
 * The run record carries no projectRoot, so re-planning is not possible from
 * this surface; when no planning diagnostics are recorded, the run simply
 * reports 'no conflicts recorded'.
 */
export async function appConflictsList(rest: string[]): Promise<void> {
  if (rest[0] && !rest[0].startsWith('--') && rest[0] !== 'list') {
    console.error(`unknown subcommand: od app conflicts ${rest[0]}`);
    process.exit(EXIT_USAGE);
  }
  const args = rest[0] === 'list' ? rest.slice(1) : rest;
  const flags = parseArgs(args, RUN_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const runId =
    (typeof flags.run === 'string' && flags.run.trim().length > 0 ? flags.run.trim() : undefined) ??
    positionalArgs(args, RUN_STRING_FLAGS)[0];
  if (!runId) {
    console.error('Error: --run <run-id> is required.');
    console.error('Usage: od app conflicts list --run <run-id> [--json] [--daemon-url <url>]');
    process.exit(EXIT_USAGE);
  }
  const base = await daemonBaseUrl(flags);
  const run = await fetchRun(base, runId);
  const conflicts = (run.diagnostics ?? []).filter((d) => d.phase === 'planning');
  if (flags.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        { runId, runStatus: run.status, planHash: run.planHash ?? null, conflicts },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (conflicts.length === 0) {
    const hash = run.planHash ? ` (plan ${run.planHash})` : '';
    console.log(`No conflicts recorded for run ${runId}${hash}.`);
    return;
  }
  console.log(`Conflicts recorded for run ${runId}: ${conflicts.length}`);
  for (const d of conflicts) console.log(diagnosticLine(d));
}

async function appConflicts(rest: string[]): Promise<void> {
  if (rest.length === 0 || rest[0] === 'help' || rest.includes('--help') || rest.includes('-h')) {
    console.log('Usage: od app conflicts list --run <run-id> [--json] [--daemon-url <url>]');
    process.exit(rest.length === 0 ? EXIT_USAGE : EXIT_OK);
  }
  if (rest[0] !== 'list') {
    console.error(`unknown subcommand: od app conflicts ${rest[0]}`);
    process.exit(EXIT_USAGE);
  }
  return appConflictsList(rest);
}

// ---- metrics -------------------------------------------------------------------

/**
 * Human rendering of the daemon's compiler metrics snapshot (spec §12.3).
 * Every section prints even when empty (`(none)`) so the output shape stays
 * stable for eyeballs and for scripts scraping the human surface.
 */
function printMetricsSnapshot(m: CompilerMetricsSnapshot): void {
  console.log('Compiler metrics (in-process; counters reset on daemon restart):');

  console.log('Runs by terminal status:');
  const terminalEntries = Object.entries(m.runsByTerminalStatus);
  if (terminalEntries.length === 0) console.log('  (none)');
  for (const [status, count] of terminalEntries) console.log(`  ${status}: ${count}`);

  console.log('Per-target success (cancelled runs excluded):');
  const targetEntries = Object.entries(m.targetSuccessRate);
  if (targetEntries.length === 0) console.log('  (none)');
  for (const [target, stats] of targetEntries) {
    const pct = stats.total > 0 ? Math.round((stats.succeeded / stats.total) * 100) : 0;
    console.log(`  ${target}: ${stats.succeeded}/${stats.total} (${pct}%)`);
  }

  console.log(`No-op rate: ${m.noopRate.noops}/${m.noopRate.recompiles} recompiles were no-ops`);

  console.log('Phase durations (last / cumulative ms):');
  const phaseEntries = Object.entries(m.phaseDurationsMs);
  if (phaseEntries.length === 0) console.log('  (none)');
  for (const [phase, stats] of phaseEntries) console.log(`  ${phase}: ${stats.lastMs} / ${stats.cumulativeMs}`);

  console.log('Counters:');
  console.log(`  conflicts: ${m.conflictCount}`);
  console.log(`  degraded semantics: ${m.degradedSemanticCount}`);
  const failureCategories = Object.entries(m.verificationFailureCategory).filter(([, n]) => n > 0);
  console.log(
    `  verification failures by category: ${
      failureCategories.length > 0
        ? failureCategories.map(([cat, n]) => `${cat}=${n}`).join(' ')
        : 'none'
    }`,
  );
}

/**
 * `od app metrics`: the CLI twin of `GET /api/compiler/metrics`. Daemon-wide,
 * so it takes no --project/--target — only the global --daemon-url/--json.
 */
export async function appMetrics(rest: string[]): Promise<void> {
  const flags = parseArgs(rest, METRICS_STRING_FLAGS, GLOBAL_BOOLEAN_FLAGS);
  if (isHelp(flags)) {
    printAppHelp();
    process.exit(EXIT_OK);
  }
  const base = await daemonBaseUrl(flags);
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/compiler/metrics`);
  } catch (err) {
    connectError(base, err);
  }
  if (!resp.ok) {
    console.error(`Failed to fetch compiler metrics: ${await httpErrorMessage(resp)}`);
    process.exit(EXIT_FAILURE);
  }
  const snapshot = (await resp.json()) as CompilerMetricsSnapshot;
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }
  printMetricsSnapshot(snapshot);
}

// ---- dispatch -----------------------------------------------------------------

export interface AppDispatchFlags {
  stringFlags: Set<string>;
  booleanFlags: Set<string>;
}

export async function runApp(
  args: string[],
  dispatchFlags?: AppDispatchFlags,
): Promise<void> {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printAppHelp();
    process.exit(args.length === 0 ? EXIT_USAGE : EXIT_OK);
  }
  // Dispatch-level strictness: the union APP_*_FLAGS Sets hoisted in cli.ts
  // reject a hallucinated flag before any subcommand routing (each handler
  // then re-parses narrowly for per-subcommand precision).
  if (dispatchFlags) {
    try {
      parseFlags(args, dispatchFlags.stringFlags, dispatchFlags.booleanFlags);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_USAGE);
    }
  }
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'init':
      return appInit(rest);
    case 'validate':
      return appValidate(rest);
    case 'targets':
      return appTargetsList(rest);
    case 'plan':
      return appPlan(rest);
    case 'compile':
      return appCompile(rest);
    case 'verify':
      return appVerify(rest);
    case 'approve':
      return appApprove(rest);
    case 'run':
      return appRun(rest);
    case 'conflicts':
      return appConflicts(rest);
    case 'metrics':
      return appMetrics(rest);
    default:
      console.error(`unknown subcommand: od app ${sub}`);
      printAppHelp();
      process.exit(EXIT_USAGE);
  }
}
