import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
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
  // These values come from the operator-versioned runner registration. They bind
  // collection to one host and to an attestor whose private key is unavailable to
  // the implementation worker.
  executionHost: z.string().min(1).max(500),
  attestationPublicKey: z.string().min(32).max(4096),
  bundleDigest: digest, runnerImageDigest: digest, targetUrl, deadline: z.iso.datetime(),
}).strict();
export type AttemptGrant = z.infer<typeof attemptGrantSchema>;

export const executionPlanSchema = z.object({
  grant: attemptGrantSchema,
  oraclePath: absolute, outputPath: absolute,
  imageRepository: z.string().regex(/^[a-z0-9][a-z0-9._\/-]*$/).max(255),
  network: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/).refine(value => !['host', 'bridge', 'default', 'none'].includes(value), 'Use a dedicated operator-approved Docker network'),
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
const testAccountKey = /^TEST_ACCOUNT(?:_[A-Z0-9_]+)?$/;
/** The approved test-account variables, parsed once from the file preflight validated. */
export type TestAccountEnv = Record<string, string>;
/**
 * Approved test-account material is passed by value, never by pathname. Docker reopens an
 * `--env-file` when the container starts, which is after the allowlist was checked: the
 * identity that owns that mode 0600 file could rewrite it in between and inject variables
 * such as `NODE_OPTIONS` into the trusted runner container. Only the entries preflight
 * actually read and validated reach the boundary.
 */
export function containerEnvironment(plan: ExecutionPlan, phase: Phase, testAccount: TestAccountEnv = {}) {
  const approved = phase === 'execute' ? z.record(z.string(), z.string().max(4096).regex(/^[^\x00-\x1f\x7f]*$/)).parse(testAccount) : {};
  if (phase === 'execute' && plan.testAccountEnvFile && !Object.keys(approved).length) throw new Error('Approved test-account configuration must be read and validated in preflight before execution');
  const unapproved = Object.keys(approved).filter(key => !testAccountKey.test(key));
  if (unapproved.length) throw new Error(`Only validated TEST_ACCOUNT_* variables may reach the runner container: ${unapproved.sort().join(', ')}`);
  const env: Record<string, string> = {
    ...approved,
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
export function executionCommand(plan: ExecutionPlan, phase: Phase, testAccount: TestAccountEnv = {}) {
  const p = executionPlanSchema.parse(plan);
  const env = containerEnvironment(p, phase, testAccount);
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
 * Ownership the runner identity cannot defeat. A read-only container mount stops the
 * container, not the host: an oracle tree the runner can write may be weakened between
 * the preflight digest and execution and restored before the closing digest. The approved
 * bytes must therefore belong to another identity — an operator-owned snapshot — and no
 * entry, nor any directory leading to it, may be writable by the runner's own uid or by
 * group/world. Sticky ancestors such as `/tmp` are accepted: their entries can only be
 * renamed or removed by their owner.
 */
async function assertOracleImmutable(root: string, runnerUid: number) {
  const refuse = (path: string, info: Stats, ancestor: boolean) => {
    // A symlink's target can be redirected without touching the tree, so the bundle's
    // own refusal of them is enforced here too, before any mode or ownership claim.
    if (!ancestor && info.isSymbolicLink()) throw new Error(`Approved oracle bundles cannot contain symlinks: ${path}`);
    if (info.uid === runnerUid) throw new Error(`Approved oracle bytes must be owned by an identity the runner cannot write as: ${path}`);
    // A sticky ancestor such as `/tmp` is shared on purpose: only an entry's owner can
    // rename or remove it there, so the path to the approved bytes stays fixed.
    if (ancestor && info.mode & 0o1000) return;
    if (info.mode & 0o020) throw new Error(`Approved oracle bytes must not be group-writable throughout execution: ${path}`);
    if (info.mode & 0o002) throw new Error(`Approved oracle bytes must not be world-writable throughout execution: ${path}`);
  };
  for (let path = dirname(root), previous = ''; path !== previous; previous = path, path = dirname(path)) refuse(path, await lstat(path), true);
  let entries = 0;
  async function walk(path: string, depth: number) {
    if (depth > 20) throw new Error('Approved oracle bundle exceeds the supported directory depth');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 10_000) throw new Error('Approved oracle bundle exceeds the supported file limit');
      const child = resolve(path, entry.name);
      refuse(child, await lstat(child), false);
      if (entry.isDirectory()) await walk(child, depth + 1);
    }
  }
  refuse(root, await lstat(root), false);
  await walk(root, 0);
}

/**
 * Structural checks before any container starts. The approved bytes and the writable
 * collection area must be separate, the approved bytes must be immutable to the runner
 * identity for the whole attempt, and the collection area must be empty so a previous
 * or candidate-planted file cannot be mistaken for this attempt's output.
 *
 * `uid` is the identity the runner executes as; it defaults to this process's own.
 */
export async function assertIsolation(plan: ExecutionPlan, options: { uid?: number } = {}) {
  const p = executionPlanSchema.parse(plan);
  const runnerUid = options.uid ?? process.getuid?.() ?? 0;
  const oracle = await directory(p.oraclePath), output = await directory(p.outputPath);
  if (contains(oracle.path, output.path) || contains(output.path, oracle.path)) throw new Error('Approved oracle bytes and the writable output path must not overlap');
  if (oracle.mode & 0o022) throw new Error('The approved oracle directory must not be group- or world-writable');
  await assertOracleImmutable(oracle.path, runnerUid);
  if (output.mode & 0o077) throw new Error('The collector output directory must be private to the collector');
  if (output.uid !== Number(p.runAsUser.split(':')[0])) throw new Error('The collector output directory must be owned by the unprivileged container user');
  if ((await readdir(output.path)).length) throw new Error('The collector output directory must be empty before an attempt');
  const testAccountEnv = p.testAccountEnvFile ? await readTestAccountEnv(p.testAccountEnvFile) : {};
  return { oraclePath: oracle.path, outputPath: output.path, testAccountEnv };
}

/**
 * Read the approved variables once, from the descriptor that was validated. The returned
 * entries — not the pathname — are what execution may pass to the container.
 */
async function readTestAccountEnv(path: string): Promise<TestAccountEnv> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077) throw new Error('Approved test-account configuration must be a private regular file (mode 0600)');
    if (info.size > 65_536) throw new Error('Approved test-account configuration is too large');
    const entries: TestAccountEnv = {};
    for (const line of (await file.readFile('utf8')).split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || !testAccountKey.test(match[1])) throw new Error('Approved test-account configuration may contain only TEST_ACCOUNT_* variables');
      if (match[1] in entries) throw new Error('Approved test-account configuration must not define a variable twice');
      if (match[2].length > 4096) throw new Error('Approved test-account values must be bounded single-line text');
      entries[match[1]] = match[2];
    }
    if (!Object.keys(entries).length) throw new Error('Approved test-account configuration must define at least one TEST_ACCOUNT variable');
    return entries;
  } finally { await file.close(); }
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
  return new Promise(resolve => {
    const child = spawn('docker', dockerArgv(dockerHost, ['inspect', '--type=container', name]), { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', done = false;
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const finish = (state: ContainerState) => { if (done) return; done = true; clearTimeout(timer); resolve(state); };
    child.on('error', () => finish('unknown'));
    child.on('close', code => finish(code === 0 ? 'present' : code === 1 && /no such (object|container)/i.test(stderr) ? 'absent' : 'unknown'));
  });
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
export type Preflight = { oraclePath: string; outputPath: string; bundleDigest: string; testAccountEnv: TestAccountEnv };
/**
 * Structural isolation plus the first bundle measurement. A runner performs this before
 * acknowledging: a refusal here leaves the attempt unacknowledged, so it expires and
 * releases its reservations instead of blocking them until an operator settles by hand.
 */
export async function preflightAttempt(plan: unknown, options: { uid?: number } = {}): Promise<Preflight> {
  const p = executionPlanSchema.parse(plan);
  const paths = await assertIsolation(p, options);
  return { ...paths, bundleDigest: (await oracleBundleDigest(paths.oraclePath)).digest };
}

/**
 * Run one authorized attempt. This process decides nothing about acceptance: it verifies
 * the approved bytes before and after execution and hands an execution record plus the
 * untouched output directory to the separately trusted collector. `signal` carries loss
 * of attempt authority: an aborted attempt stops talking to the target and settles.
 */
export async function executeAttempt(plan: unknown, options: { run?: Runner; settle?: Settler; now?: () => Date; preflight?: Preflight; signal?: AbortSignal; uid?: number } = {}): Promise<ExecutionRecord> {
  const p = executionPlanSchema.parse(plan);
  const now = options.now ?? (() => new Date());
  const run = options.run ?? dockerRunner, settle = options.settle ?? dockerSettler;
  const signal = options.signal;
  const paths = options.preflight ?? await preflightAttempt(p, { uid: options.uid });
  // The exact canonical roots checked and hashed in preflight are the roots mounted.
  // Never resolve a worker-replaceable symlink a second time in `docker run`.
  const mountedPlan: ExecutionPlan = { ...p, oraclePath: paths.oraclePath, outputPath: paths.outputPath };
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
      const outcome = await run(executionCommand(mountedPlan, phase, paths.testAccountEnv), deadline, signal);
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
