import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { relative, sep } from 'node:path';
import { z } from 'zod';
import { oracleBundleDigest } from './runner-setup.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const absolute = z.string().min(1).max(4096).refine(p => p.startsWith('/') && !/[\x00-\x1f\x7f]/.test(p), 'Use an absolute path without control characters');
const targetUrl = z.url().max(2000).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }, 'The approved target must be HTTPS without credentials or fragment');

/** Exactly the fields a runner may act on. A dispatch response is authority, not a suggestion. */
export const attemptGrantSchema = z.object({
  requestId: z.uuid(), attemptId: z.uuid(), epoch: z.number().int().positive(),
  runner: z.object({ id: name, revision: z.number().int().positive() }).strict(),
  bundleDigest: digest, runnerImageDigest: digest, targetUrl, deadline: z.iso.datetime(),
}).strict();
export type AttemptGrant = z.infer<typeof attemptGrantSchema>;

export const executionPlanSchema = z.object({
  grant: attemptGrantSchema,
  oraclePath: absolute, outputPath: absolute,
  imageRepository: z.string().regex(/^[a-z0-9][a-z0-9._\/-]*$/).max(255),
  network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  memoryMb: z.number().int().min(256).max(16_384).default(2048),
  cpus: z.number().min(0.5).max(16).default(2),
  pidsLimit: z.number().int().min(32).max(4096).default(256),
  // Unprivileged, and the same identity that owns the collector's output directory:
  // the container must be able to write its report without the collector needing root.
  runAsUser: z.string().regex(/^[0-9]{1,10}:[0-9]{1,10}$/).default(() => `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`),
  testAccountEnvFile: absolute.optional(),
}).strict();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
export type Phase = 'enumerate' | 'execute';
/** Both phases write through the approved reporter built into the pinned image. */
export const reportFiles: Record<Phase, string> = { enumerate: 'inventory.json', execute: 'report.json' };

// Control-plane, provider and package-manager variables must never reach the boundary
// that talks to the deployed candidate. NODE_*/npm_* additionally redirect module
// resolution, which would let candidate-influenced configuration supply oracle bytes.
const forbidden = /^(GRAPHYARD_(?!REPORT_FILE|TARGET_URL|PHASE)|NODE_|npm_|PLAYWRIGHT_|GH_|GITHUB_|AWS_|GOOGLE_|RAILWAY_|DATABASE_|PG|DOCKER_|SSH_|HERDR_)/;
export function containerEnvironment(plan: ExecutionPlan, phase: Phase) {
  const env: Record<string, string> = {
    HOME: '/scratch', TMPDIR: '/scratch', CI: '1',
    GRAPHYARD_PHASE: phase,
    GRAPHYARD_REPORT_FILE: `/output/${reportFiles[phase]}`,
    // The enumeration pass must not be able to observe or be steered by the target.
    ...(phase === 'execute' ? { GRAPHYARD_TARGET_URL: plan.grant.targetUrl } : {}),
  };
  const leaked = Object.keys(env).filter(key => forbidden.test(key));
  if (leaked.length) throw new Error(`Runner containers must not receive control-plane or provider credentials: ${leaked.sort().join(', ')}`);
  return env;
}

/** A worker-scoped runner credential. A collector/producer token here would let execution attest itself. */
export function assertRunnerCredentialScope(status: unknown) {
  const actor = (status as { actor?: { id?: string; role?: string; proofs?: string[] } } | null)?.actor;
  if (!actor?.id || actor.role !== 'worker' || actor.proofs?.length) throw new Error('The packaged runner requires a worker-scoped runner credential with no evidence-producer proof scope');
  return actor as { id: string; role: 'worker' };
}

/** Both container names are derived from the attempt alone, so a collector that never
 * saw the plan can name exactly the containers this attempt was allowed to start. */
export const containerNames = (attemptId: string) => (['enumerate', 'execute'] as Phase[]).map(phase => `graphyard-${phase}-${attemptId}`);
export const containerName = (plan: ExecutionPlan, phase: Phase) => `graphyard-${phase}-${plan.grant.attemptId}`;
export function executionCommand(plan: ExecutionPlan, phase: Phase) {
  const p = executionPlanSchema.parse(plan);
  const env = containerEnvironment(p, phase);
  const memory = `${p.memoryMb}m`;
  return {
    file: 'docker',
    argv: ['run', '--rm', '--name', containerName(p, phase),
      // Enumeration is offline: the approved inventory cannot depend on the target.
      '--network', phase === 'enumerate' ? 'none' : p.network,
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', p.runAsUser,
      `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${p.cpus}`, `--pids-limit=${p.pidsLimit}`,
      `--mount=type=bind,source=${p.oraclePath},target=/oracle,readonly`,
      `--mount=type=bind,source=${p.outputPath},target=/output`,
      '--tmpfs=/scratch:rw,noexec,nosuid,nodev,size=512m',
      '--workdir', '/scratch',
      ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      ...(phase === 'execute' && p.testAccountEnvFile ? ['--env-file', p.testAccountEnvFile] : []),
      `${p.imageRepository}@${p.grant.runnerImageDigest}`, phase],
    env,
  };
}

async function directory(path: string) {
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`Execution boundary path must be a directory: ${path}`);
  return { path: resolved, mode: info.mode & 0o777, uid: info.uid };
}
const contains = (outer: string, inner: string) => { const r = relative(outer, inner); return r === '' || (!r.startsWith('..') && !r.startsWith(sep)); };

/**
 * Structural checks before any container starts. The approved bytes and the writable
 * collection area must be separate, and the collection area must be empty so a previous
 * or candidate-planted file cannot be mistaken for this attempt's output.
 */
export async function assertIsolation(plan: ExecutionPlan) {
  const p = executionPlanSchema.parse(plan);
  const oracle = await directory(p.oraclePath), output = await directory(p.outputPath);
  if (contains(oracle.path, output.path) || contains(output.path, oracle.path)) throw new Error('Approved oracle bytes and the writable output path must not overlap');
  if (oracle.mode & 0o022) throw new Error('The approved oracle directory must not be group- or world-writable');
  if (output.mode & 0o077) throw new Error('The collector output directory must be private to the collector');
  if (output.uid !== Number(p.runAsUser.split(':')[0])) throw new Error('The collector output directory must be owned by the unprivileged container user');
  if ((await readdir(output.path)).length) throw new Error('The collector output directory must be empty before an attempt');
  if (p.testAccountEnvFile) {
    const file = await open(p.testAccountEnvFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.mode & 0o077) throw new Error('Approved test-account configuration must be a private regular file (mode 0600)');
    } finally { await file.close(); }
  }
  return { oraclePath: oracle.path, outputPath: output.path };
}

export type PhaseResult = { phase: Phase; exitCode: number; timedOut: boolean; durationMs: number };
export type Runner = (command: { file: string; argv: string[] }, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; timedOut: boolean }>;
/** `absent` is the only state that proves this attempt can no longer act on shared resources. */
export type ContainerState = 'absent' | 'present' | 'unknown';
export type Settler = (name: string) => Promise<ContainerState>;

const spawnProcess = (file: string, argv: string[], timeoutMs: number, signal?: AbortSignal) => new Promise<{ exitCode: number; timedOut: boolean }>(resolve => {
  // Candidate-influenced stdout/stderr is never captured or forwarded: it can carry
  // test-account credentials, and the report file is the only accepted channel.
  const child = spawn(file, argv, { stdio: 'ignore' });
  let timedOut = false, done = false;
  const stop = () => child.kill('SIGKILL');
  const finish = (exitCode: number) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ exitCode, timedOut }); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  // Losing attempt authority stops this process immediately; settlement afterwards is
  // what actually removes the container it started.
  if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
  child.on('error', () => finish(127));
  child.on('close', code => finish(code ?? 1));
});
const dockerRunner: Runner = (command, timeoutMs, signal) => spawnProcess(command.file, command.argv, timeoutMs, signal);
const dockerArgv = (dockerHost: string | undefined, argv: string[]) => (dockerHost ? ['--host', dockerHost, ...argv] : argv);
async function inspectContainer(name: string, dockerHost?: string): Promise<ContainerState> {
  const inspected = await spawnProcess('docker', dockerArgv(dockerHost, ['inspect', '--type=container', name]), 30_000);
  if (inspected.timedOut) return 'unknown';
  return inspected.exitCode === 0 ? 'present' : inspected.exitCode === 1 ? 'absent' : 'unknown';
}
/**
 * Read-only settlement observation for a party that is not the runner. The collector
 * uses it to derive settlement itself instead of believing the execution record; it
 * never removes anything, so observing is not a way to manufacture `absent`.
 */
export async function observeContainers(names: string[], options: { dockerHost?: string; inspect?: (name: string) => Promise<ContainerState> } = {}) {
  const inspect = options.inspect ?? (name => inspectContainer(name, options.dockerHost));
  const observed: { name: string; state: ContainerState }[] = [];
  for (const name of z.array(z.string().min(1).max(200)).max(8).parse(names)) observed.push({ name, state: await inspect(name) });
  return observed;
}
/**
 * Killing `docker run` does not stop the container it started, so settlement is an
 * independent observation: force removal, then confirm the name no longer resolves.
 * Anything else stays `unknown`, and the execution-resource barrier remains closed.
 */
const dockerSettler: Settler = async name => {
  await spawnProcess('docker', ['rm', '--force', name], 30_000);
  return inspectContainer(name);
};

/** What a collector may accept as an execution record. It is data, never authority. */
export const executionRecordSchema = z.object({
  grant: attemptGrantSchema, startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  phases: z.array(z.object({ phase: z.enum(['enumerate', 'execute']), exitCode: z.number().int(), timedOut: z.boolean(), durationMs: z.number().finite().min(0) }).strict()).max(8),
  bundleDigestBefore: digest, bundleDigestAfter: digest, runnerImageDigest: digest,
  outcome: z.enum(['completed', 'timed_out', 'failed']), refusals: z.array(z.string().min(1).max(500)).max(50),
  outputPath: absolute,
  settlement: z.object({ settled: z.boolean(), containers: z.array(z.object({ name: z.string().min(1).max(200), state: z.enum(['absent', 'present', 'unknown']) }).strict()).max(8) }).strict(),
}).strict();
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

/** Everything that can refuse locally before the attempt is acknowledged. */
export type Preflight = { oraclePath: string; outputPath: string; bundleDigest: string };
/**
 * Structural isolation plus the first bundle measurement. A runner performs this before
 * acknowledging: a refusal here leaves the attempt unacknowledged, so it expires and
 * releases its reservations instead of blocking them until an operator settles by hand.
 */
export async function preflightAttempt(plan: unknown): Promise<Preflight> {
  const p = executionPlanSchema.parse(plan);
  const paths = await assertIsolation(p);
  return { ...paths, bundleDigest: (await oracleBundleDigest(paths.oraclePath)).digest };
}

/**
 * Run one authorized attempt. This process decides nothing about acceptance: it verifies
 * the approved bytes before and after execution and hands an execution record plus the
 * untouched output directory to the separately trusted collector. `signal` carries loss
 * of attempt authority: an aborted attempt stops talking to the target and settles.
 */
export async function executeAttempt(plan: unknown, options: { run?: Runner; settle?: Settler; now?: () => Date; preflight?: Preflight; signal?: AbortSignal } = {}): Promise<ExecutionRecord> {
  const p = executionPlanSchema.parse(plan);
  const now = options.now ?? (() => new Date());
  const run = options.run ?? dockerRunner, settle = options.settle ?? dockerSettler;
  const signal = options.signal;
  const paths = options.preflight ?? await preflightAttempt(p);
  const before = { digest: paths.bundleDigest };
  const refusals: string[] = [];
  if (before.digest !== p.grant.bundleDigest) refusals.push('Approved oracle bundle bytes differ from the pinned digest');
  const startedAt = now().toISOString();
  const phases: PhaseResult[] = [];
  const lostAuthority = 'Attempt authority was lost during execution; the attempt was aborted';
  if (signal?.aborted) refusals.push(lostAuthority);
  if (!refusals.length) {
    for (const phase of ['enumerate', 'execute'] as Phase[]) {
      const deadline = Math.min(p.timeoutMs, Math.max(0, Date.parse(p.grant.deadline) - now().getTime()));
      if (deadline < 1_000) { refusals.push('Attempt deadline elapsed before execution'); break; }
      const at = now().getTime();
      const outcome = await run(executionCommand(p, phase), deadline, signal);
      phases.push({ phase, ...outcome, durationMs: now().getTime() - at });
      if (signal?.aborted) { refusals.push(lostAuthority); break; }
      if (outcome.timedOut) break;
      // A failing execute phase is a behaviour signal for the collector, not a reason to
      // skip the post-execution integrity check. A failing enumerate phase is fatal.
      if (phase === 'enumerate' && outcome.exitCode !== 0) { refusals.push('Approved inventory enumeration did not complete'); break; }
    }
  }
  const finishedAt = now().toISOString();
  const containers: { name: string; state: ContainerState }[] = [];
  for (const phase of ['enumerate', 'execute'] as Phase[]) containers.push({ name: containerName(p, phase), state: await settle(containerName(p, phase)) });
  const settled = containers.every(c => c.state === 'absent');
  if (!settled) refusals.push('Execution settlement is unverified; the execution-resource barrier stays closed');
  const after = await oracleBundleDigest(paths.oraclePath);
  if (after.digest !== before.digest) refusals.push('Approved oracle bundle changed during the attempt');
  const timedOut = phases.some(phase => phase.timedOut);
  return { grant: p.grant, startedAt, finishedAt, phases,
    bundleDigestBefore: before.digest, bundleDigestAfter: after.digest, runnerImageDigest: p.grant.runnerImageDigest,
    outcome: timedOut ? 'timed_out' : refusals.length || phases.length < 2 ? 'failed' : 'completed',
    refusals, outputPath: paths.outputPath, settlement: { settled, containers } };
}
