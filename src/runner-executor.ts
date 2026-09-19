import { constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { oracleBundleDigest } from './runner-setup.js';
import { defaultReportFormat, reportAdapter, reportFormats, type ReportFormat } from './report-adapters.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const absolute = z.string().min(1).max(4096).refine(p => p.startsWith('/') && !/[\x00-\x1f\x7f]/.test(p), 'Use an absolute path without control characters');
const targetUrl = z.url().max(2000).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }, 'The approved target must be HTTPS without credentials or fragment');
/** Docker resolves a network name against everything the daemon already has, so an
 * arbitrary one can attach the browser to databases and other internal services. The
 * approved name is operator-versioned authority, never runner configuration. */
const dockerNetwork = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/).refine(value => !['host', 'bridge', 'default', 'none'].includes(value), 'Use a dedicated operator-approved Docker network');
/**
 * The pinned Docker endpoint, in the form the operator registration enforces. Every
 * runtime command an attempt issues is addressed to it, so it has to be a daemon address
 * rather than free text: a value the CLI would read as another flag, or an unreachable
 * default context, is exactly how removal and inspection end up on different daemons.
 *
 * Only a local socket is accepted. Preflight measures the approved bundle, the attempt
 * boundary and their ancestry on the filesystem the attestor can see, while `--mount`
 * sources are interpreted by whichever daemon runs the container. Over `ssh://` or
 * `tcp://` those are two different filesystems, so the same pathnames could mount bytes
 * nobody measured — or resolve to nothing at all — while every host-side check passed.
 * A remote endpoint is only safe once preflight itself runs on the daemon host, which
 * this path does not do, so it is refused rather than trusted.
 */
const dockerEndpoint = z.string().min(1).max(500).regex(/^unix:\/\/\/[^\s]+$/, 'The pinned execution host must be a local unix:// Docker socket: the attestor measures the mounted bytes on its own filesystem, which only holds for a daemon on the same host');
/**
 * The unprivileged container identity. UID or GID zero is refused: a runner configuration
 * could otherwise name `0:0`, provide a root-owned boundary, satisfy every structural
 * check and run both browser phases as root against a hostile deployment — which is also
 * what commonly forces Chromium out of its own sandbox.
 */
const containerUser = z.string().regex(/^[0-9]{1,10}:[0-9]{1,10}$/)
  .refine(value => value.split(':').every(part => Number(part) !== 0), 'The runner container must run as a non-root UID and GID');

/** Exactly the fields a runner may act on. A dispatch response is authority, not a suggestion. */
export const attemptGrantSchema = z.object({
  requestId: z.uuid(), attemptId: z.uuid(), epoch: z.number().int().positive(),
  runner: z.object({ id: name, revision: z.number().int().positive() }).strict(),
  // These values come from the operator-versioned runner registration. They bind
  // collection to one host and to an attestor whose private key is unavailable to
  // the implementation worker.
  executionHost: dockerEndpoint,
  attestationPublicKey: z.string().min(32).max(4096),
  executionNetwork: dockerNetwork,
  bundleDigest: digest, runnerImageDigest: digest, targetUrl, deadline: z.iso.datetime(),
  /**
   * The report format the approved bundle definition pins beside the runner image. It
   * names which files the two phases must write and which adapter the collector verifies
   * them with; bytes in any other format are refused rather than sniffed.
   */
  reportFormat: z.enum(reportFormats).default(defaultReportFormat),
  /**
   * Which test-account material this attempt is approved to run with, as a digest of the
   * approved entries themselves — `null` when it is approved to run with none.
   *
   * The pathname the runner reads is host configuration, so it can never be the approval:
   * any private file the attestor can read would otherwise do, and a compromised runner
   * could obtain trusted evidence for a different account, and a different privilege
   * scenario, than the operator approved. The digest comes from the operator-versioned
   * runner registration through the dispatch grant, is re-read independently by the
   * attestor and the collector, and is covered by `grantDigest` in the signed attestation.
   */
  testAccountDigest: digest.nullable().default(null),
}).strict();
export type AttemptGrant = z.infer<typeof attemptGrantSchema>;

export const executionPlanSchema = z.object({
  grant: attemptGrantSchema,
  oraclePath: absolute, outputPath: absolute,
  imageRepository: z.string().regex(/^[a-z0-9][a-z0-9._\/-]*$/).max(255),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  memoryMb: z.number().int().min(256).max(16_384).default(2048),
  cpus: z.number().min(0.5).max(16).default(2),
  pidsLimit: z.number().int().min(32).max(4096).default(256),
  // Unprivileged, and carrying the group that the attempt boundary is shared through: the
  // container writes its report as a member of that group, and the attestor and collector
  // read it as members of the same group. Never root, and never the runner's own identity.
  runAsUser: containerUser,
  testAccountEnvFile: absolute.optional(),
}).strict();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
/**
 * What the runner account configures locally. Everything that decides *what* is approved
 * — the target, the bundle and image digests, the isolated network, the attestor's public
 * key and execution host — comes from the operator-versioned registration through the
 * dispatch grant, never from this file. `runAsUser` is required because the dedicated
 * container UID and boundary-group GID are execution-host facts. Defaulting either to
 * the attestor would collapse identities or select its unrelated primary group.
 */
export const runnerPlanSchema = executionPlanSchema.omit({ grant: true, runAsUser: true }).extend({
  runAsUser: containerUser,
  registration: z.object({ id: z.string(), revision: z.number().int().positive() }).strict(),
  // How this host reaches the operator's attestor, for example
  // `sudo -n -u graphyard-attestor /usr/local/bin/graphyard runner supervise`.
  supervisor: z.object({ command: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(32).default([]) }).strict(),
}).strict();
export type Phase = 'enumerate' | 'execute';
/** Both phases write through the approved reporter built into the pinned image; the file
 * each phase must write is fixed by the report format the bundle approval pinned. */
export const reportFilesFor = (format: ReportFormat): Record<Phase, string> => {
  const { artifacts } = reportAdapter(format);
  return { enumerate: artifacts.inventory.file, execute: artifacts.report.file };
};
export const reportFiles: Record<Phase, string> = reportFilesFor(defaultReportFormat);

// Control-plane, provider and package-manager variables must never reach the boundary
// that talks to the deployed candidate. NODE_*/npm_* additionally redirect module
// resolution, which would let candidate-influenced configuration supply oracle bytes.
const forbidden = /^(GRAPHYARD_(?!REPORT_FILE|TARGET_URL|PHASE)|NODE_|npm_|PLAYWRIGHT_|GH_|GITHUB_|AWS_|GOOGLE_|RAILWAY_|DATABASE_|PG|DOCKER_|SSH_|HERDR_)/;
const testAccountKey = /^TEST_ACCOUNT(?:_[A-Z0-9_]+)?$/;
/** The approved test-account variables, parsed once from the file preflight validated. */
export type TestAccountEnv = Record<string, string>;
/**
 * The identity of one set of approved test-account entries, independent of the file that
 * happened to carry them. Comments, ordering and blank lines are not part of the approval,
 * so an operator can reformat the env file without re-registering; the keys and values the
 * container would actually receive are. This is what a runner registration pins and what
 * preflight and `containerEnvironment` check the material they hold against.
 *
 * The joined encoding is unambiguous because both readers refuse anything else: a key is
 * `TEST_ACCOUNT_*` and so cannot contain `=`, and a value cannot contain a newline, so no
 * two distinct entry sets can serialise to the same bytes.
 */
export const approvedAccountDigest = (entries: TestAccountEnv) =>
  `sha256:${createHash('sha256').update(Object.keys(entries).sort().map(key => `${key}=${entries[key]}\n`).join('')).digest('hex')}`;
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
  // The last check before these values become container arguments: the material must be
  // exactly what this attempt's authority approved. Preflight already refused anything
  // else, and this refuses again here so no caller can assemble a command that carries
  // account material the grant does not cover.
  if (phase === 'execute') {
    const pinned = plan.grant.testAccountDigest;
    if (!pinned && Object.keys(approved).length) throw new Error('This attempt authority approves no test-account material; the runner container must receive none');
    if (pinned && approvedAccountDigest(approved) !== pinned) throw new Error('The test-account material for this container is not the material this attempt authority approved');
  }
  const env: Record<string, string> = {
    ...approved,
    HOME: '/scratch', TMPDIR: '/scratch', CI: '1',
    GRAPHYARD_PHASE: phase,
    GRAPHYARD_REPORT_FILE: `/output/${reportFilesFor(plan.grant.reportFormat)[phase]}`,
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

/**
 * The rule every background-renewed attempt authority follows, in one place because the
 * executing runner and the collecting host must not answer it differently.
 *
 * A renewal the server *confirmed* it refuses is authority being taken away: this attempt
 * may no longer act, and no later success takes that back — the refusal was a decision,
 * not a lost packet. A transport error or a 5xx is not a decision, so it only ends the
 * attempt once the authority it renews has actually gone stale; until then a renewal that
 * succeeds afterwards proves the lease is current, and treating the first dropped packet
 * as fatal would abandon executions and collections that still hold their lease.
 * Authority is equally lost when nothing renews it at all, which a failure count alone
 * never notices.
 */
export function authorityWatch(options: { staleAfterMs?: number; now?: () => number } = {}) {
  const staleAfterMs = options.staleAfterMs ?? 50_000, now = options.now ?? Date.now;
  let renewedAt = now(), refused = false, failure: unknown;
  return {
    /** A renewal the server accepted. */
    renewed() { renewedAt = now(); if (!refused) failure = undefined; },
    /** A renewal that did not land, with whatever the attempt was told. */
    failed(error: unknown) {
      if ((error as { confirmedRefusal?: boolean } | null)?.confirmedRefusal) { refused = true; failure = error; }
      else if (now() - renewedAt >= staleAfterMs) failure = error;
    },
    /** Whether this attempt may no longer act on anything its authority covers. */
    get lost() { return failure !== undefined || now() - renewedAt >= staleAfterMs; },
  };
}

/** Both container names are derived from the attempt alone, so a collector that never
 * saw the plan can name exactly the containers this attempt was allowed to start. */
export const containerNames = (attemptId: string) => (['enumerate', 'execute'] as Phase[]).map(phase => `graphyard-${phase}-${attemptId}`);
export const containerName = (plan: ExecutionPlan, phase: Phase) => `graphyard-${phase}-${plan.grant.attemptId}`;
/**
 * Address a Docker command to the endpoint the runner registration pinned. The attestor's
 * own default context is not that endpoint: if it were used for `run` and removal while
 * the collector inspects the registered one, a failed removal on the real daemon would
 * still read as `absent` on the other, and the attempt would settle with its container
 * still live against the target.
 */
const dockerArgv = (dockerHost: string | undefined, argv: string[]) => (dockerHost ? ['--host', dockerHost, ...argv] : argv);
/**
 * How one container variable is named on the Docker command line.
 *
 * Approved test-account entries are credentials, and a command line is public on an
 * ordinary host: any local identity can read another account's arguments through the
 * process listing or `/proc/<pid>/cmdline`, which would hand the runner account — the one
 * account this boundary exists to keep out — the password the operator approved. Those
 * entries are therefore named without their values and Docker reads each value from the
 * environment of the `docker` process this attestor starts, which the runner cannot see.
 * Everything else the container receives is non-secret wiring and stays inline, where it
 * remains visible to an operator watching what was executed.
 */
const commandEnvArgv = (key: string, value: string) => (testAccountKey.test(key) ? ['--env', key] : ['--env', `${key}=${value}`]);
export function executionCommand(plan: ExecutionPlan, phase: Phase, testAccount: TestAccountEnv = {}) {
  const p = executionPlanSchema.parse(plan);
  const env = containerEnvironment(p, phase, testAccount);
  const memory = `${p.memoryMb}m`;
  return {
    file: 'docker',
    argv: dockerArgv(p.grant.executionHost, ['run', '--rm', '--name', containerName(p, phase),
      // Enumeration is offline: the approved inventory cannot depend on the target.
      '--network', phase === 'enumerate' ? 'none' : p.grant.executionNetwork,
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', p.runAsUser,
      `--memory=${memory}`, `--memory-swap=${memory}`, `--cpus=${p.cpus}`, `--pids-limit=${p.pidsLimit}`,
      `--mount=type=bind,source=${p.oraclePath},target=/oracle,readonly`,
      `--mount=type=bind,source=${p.outputPath},target=/output`,
      '--tmpfs=/scratch:rw,noexec,nosuid,nodev,size=512m',
      '--workdir', '/scratch',
      ...Object.entries(env).flatMap(([key, value]) => commandEnvArgv(key, value)),
      `${p.imageRepository}@${p.grant.runnerImageDigest}`, phase]),
    env,
    // The environment the `docker` process itself must carry for the variables named
    // without a value above. It holds only this attempt's approved material, so nothing
    // else of the attestor's environment is forwarded by name.
    processEnv: Object.fromEntries(Object.entries(env).filter(([key]) => testAccountKey.test(key))),
  };
}

async function directory(path: string) {
  const resolved = await realpath(path);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`Execution boundary path must be a directory: ${path}`);
  return { path: resolved, mode: info.mode & 0o777, uid: info.uid, gid: info.gid, identity: { dev: info.dev, ino: info.ino } };
}

/**
 * Which directory a pathname actually reaches. A path is a name, not a thing: the same
 * name can be made to lead somewhere else, so the boundary a preflight approved is
 * identified by the filesystem object it resolved to and re-checked against it later.
 */
export type BoundaryIdentity = { dev: number; ino: number };
export async function boundaryIdentity(path: string): Promise<BoundaryIdentity> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`Execution boundary path must be a directory: ${path}`);
  return { dev: info.dev, ino: info.ino };
}
const sameBoundary = (a: BoundaryIdentity, b: BoundaryIdentity) => a.dev === b.dev && a.ino === b.ino;
/** Resolve the boundary again and report whether it is still the one that was approved. */
export async function boundaryUnchanged(path: string, approved: BoundaryIdentity) {
  try { return sameBoundary(await boundaryIdentity(path), approved); } catch { return false; }
}
const contains = (outer: string, inner: string) => { const r = relative(outer, inner); return r === '' || (!r.startsWith('..') && !r.startsWith(sep)); };

/**
 * Ownership no other identity on the host can defeat. A read-only container mount stops
 * the container, not the host: an oracle tree that some other account can write may be
 * weakened between the preflight digest and execution and restored before the closing
 * one. Nor is "not owned by the executing account" enough, because the worker that asks
 * for supervision is a different account again. So every entry under the approved bytes
 * must belong to the supervising attestor identity itself (or to root) and must not be
 * group- or world-writable. The path leading to them is held to the same rule by
 * `assertAncestryFixed`.
 */
async function assertOracleImmutable(root: string, attestorUid: number) {
  const refuse = (path: string, info: Stats) => {
    // A symlink's target can be redirected without touching the tree, so the bundle's
    // own refusal of them is enforced here too, before any mode or ownership claim.
    if (info.isSymbolicLink()) throw new Error(`Approved oracle bundles cannot contain symlinks: ${path}`);
    if (info.uid !== attestorUid && info.uid !== 0) throw new Error(`Approved oracle bytes must be owned by the supervising attestor identity or by root: ${path}`);
    if (info.mode & 0o020) throw new Error(`Approved oracle bytes must not be group-writable throughout execution: ${path}`);
    if (info.mode & 0o002) throw new Error(`Approved oracle bytes must not be world-writable throughout execution: ${path}`);
  };
  let entries = 0;
  async function walk(path: string, depth: number) {
    if (depth > 20) throw new Error('Approved oracle bundle exceeds the supported directory depth');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 10_000) throw new Error('Approved oracle bundle exceeds the supported file limit');
      const child = resolve(path, entry.name);
      refuse(child, await lstat(child));
      if (entry.isDirectory()) await walk(child, depth + 1);
    }
  }
  refuse(root, await lstat(root));
  await walk(root, 0);
}

/**
 * A boundary is only as fixed as the pathname that reaches it. Checking a directory's
 * own ownership, mode and contents says nothing about who may rename it: an identity
 * that can write a parent directory can move the checked entry aside and leave a
 * different directory — an earlier attempt's passing output, or a weakened oracle tree —
 * at the same path, and every later `docker run` mount and host-side measurement follows
 * the name. So no identity but the supervising attestor (or root) may control a
 * component of the path.
 *
 * A sticky shared directory such as `/tmp` may still be group- or world-writable, because
 * the sticky bit means only an entry's own owner can rename or remove it there. That
 * exemption is about the *writers*, never about the directory itself: POSIX sticky rules
 * leave the directory's own owner able to rename any child, so a runner-owned mode-1777
 * parent would let the runner swap the oracle tree or the output boundary aside during
 * execution and put the original back before the closing inode and digest checks.
 * Ownership is therefore required of every ancestor, sticky or not.
 */
export async function assertAncestryFixed(root: string, attestorUid: number, subject: string) {
  for (let path = dirname(root), previous = ''; path !== previous; previous = path, path = dirname(path)) {
    const info = await lstat(path);
    if (info.uid !== attestorUid && info.uid !== 0) throw new Error(`Every directory leading to the ${subject} must be owned by the supervising attestor identity or by root: ${path}`);
    if (!(info.mode & 0o1000) && info.mode & 0o022) throw new Error(`Every directory leading to the ${subject} must not be group- or world-writable: ${path}`);
  }
}

/**
 * The mode a provisioned attempt boundary carries. The attestor owns it, the container's
 * group may create and read files in it, and no identity outside that group can even
 * traverse it. The setgid bit hands that same group to every file the container writes,
 * so the trusted readers keep access to output they do not own.
 */
export const attemptBoundaryMode = 0o2770;
/** Where one attempt's output lives, under the configured collection root. */
export const attemptBoundaryPath = (plan: ExecutionPlan) => resolve(plan.outputPath, plan.grant.attemptId);
/**
 * Provision this attempt's own output boundary.
 *
 * A single static output directory cannot be reused: nothing removes the previous
 * attempt's `inventory.json` and `report.json`, so the emptiness check — which is what
 * stops an older passing report from being measured as this attempt's behaviour — would
 * refuse every retry and every subsequent assignment until someone cleaned up by hand.
 * The attempt the grant authorizes names its own directory instead, and the attestor
 * creates it: only the identity that creates a directory can own it without root, and the
 * trusted readers need to read, and eventually remove, output the container wrote.
 */
async function provisionAttemptBoundary(plan: ExecutionPlan, attestorUid: number) {
  const root = await directory(plan.outputPath);
  if (root.uid !== attestorUid) throw new Error('The collection root must be owned by the supervising attestor identity, which provisions each attempt boundary beneath it');
  if (root.mode & 0o022) throw new Error('The collection root must not be group- or world-writable');
  const path = resolve(root.path, plan.grant.attemptId);
  try { await mkdir(path); } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
  // `mkdir`'s mode argument is masked by the attestor's umask, which would silently drop
  // the group access the container writes through, so the boundary mode is set explicitly.
  await chmod(path, attemptBoundaryMode);
  return path;
}

/** The identity the supervising attestor checks against, and the groups it can read through. */
export type AttestorIdentity = { uid?: number; gids?: number[] };
const attestorIdentity = (options: AttestorIdentity) => ({
  uid: options.uid ?? process.getuid?.() ?? 0,
  gids: options.gids ?? [...(process.getgroups?.() ?? []), process.getgid?.() ?? 0],
});

/**
 * Structural checks before any container starts. The approved bytes and the writable
 * collection area must be separate, the approved bytes must be immutable to every
 * identity but the supervising attestor for the whole attempt, and the collection area
 * must be empty so a previous or candidate-planted file cannot be mistaken for this
 * attempt's output.
 *
 * The boundary is shared between three identities that must not be the same account, and
 * a directory private to any one of them would break the other two. The attestor owns it,
 * so it can provision it, read it afterwards and remove it. The container writes into it
 * as a member of the group named in `runAsUser`. The attestor — and the separately
 * identified collector, on its own host — reads what the container wrote through that
 * same group, which is why membership is required here rather than discovered as an
 * `EACCES` after the phases have already exercised the target. Everything outside that
 * group, the runner account above all, cannot even traverse it.
 *
 * `uid` and `gids` are the supervising attestor's identity; they default to this
 * process's own, because this runs inside the attestor. `boundaryPath` is the directory
 * provisioned for this attempt, defaulting to the configured path for callers that
 * prepared one themselves.
 */
export async function assertIsolation(plan: ExecutionPlan, options: AttestorIdentity & { boundaryPath?: string } = {}) {
  const p = executionPlanSchema.parse(plan);
  const { uid: attestorUid, gids: attestorGids } = attestorIdentity(options);
  const oracle = await directory(p.oraclePath), output = await directory(options.boundaryPath ?? p.outputPath);
  if (contains(oracle.path, output.path) || contains(output.path, oracle.path)) throw new Error('Approved oracle bytes and the writable output path must not overlap');
  if (oracle.mode & 0o022) throw new Error('The approved oracle directory must not be group- or world-writable');
  await assertAncestryFixed(oracle.path, attestorUid, 'approved oracle bundle');
  await assertOracleImmutable(oracle.path, attestorUid);
  const containerGid = Number(p.runAsUser.split(':')[1]);
  if (output.mode & 0o007) throw new Error('The collection boundary must be closed to every identity outside the trusted boundary group');
  if (output.uid !== attestorUid) throw new Error('The collection boundary must be owned by the supervising attestor identity that provisioned it');
  if (output.gid !== containerGid) throw new Error("The collection boundary must be group-owned by the container's group, so the container can write its report and the trusted readers can read it");
  if ((output.mode & 0o070) !== 0o070) throw new Error("The collection boundary must grant its group read, write and traverse access; the container writes its report through that group");
  if (!attestorGids.includes(containerGid)) throw new Error('The supervising attestor must belong to the boundary group in runAsUser; it cannot otherwise read the output the container writes');
  // The output directory's own mode keeps the runner out of it; its ancestry is what
  // keeps the runner from putting a different directory at the same pathname, which
  // both the container mount and the attestor's post-execution measurement would follow.
  await assertAncestryFixed(output.path, attestorUid, 'collection boundary');
  if ((await readdir(output.path)).length) throw new Error('The collection boundary must be empty before an attempt');
  // Reading approved account material and being approved to use it are separate facts.
  // The plan says which file this host keeps it in; the grant says which material the
  // operator approved. Neither alone may decide what the container receives.
  if (p.grant.testAccountDigest && !p.testAccountEnvFile) throw new Error('This attempt authority approves test-account material, but the runner plan names no env file to read it from');
  if (!p.grant.testAccountDigest && p.testAccountEnvFile) throw new Error('This attempt authority approves no test-account material; remove testAccountEnvFile or register the approved account digest');
  const testAccountEnv = p.testAccountEnvFile ? await readTestAccountEnv(p.testAccountEnvFile, p.grant.testAccountDigest!) : {};
  return { oraclePath: oracle.path, outputPath: output.path, outputBoundary: output.identity, testAccountEnv };
}

/**
 * Read one private env file into validated entries. This decides only what the file
 * contains, never whether that material is approved for anything; `readTestAccountEnv`
 * below is the only reader execution uses, and it answers that separately.
 */
async function readAccountFile(path: string): Promise<TestAccountEnv> {
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
/**
 * Measure an approved test-account env file, for an operator registering its digest. It
 * grants nothing: the entries stay in this process, and approving them is a separate
 * operator action against Graphyard under an operator credential.
 */
export const accountFileDigest = async (path: string) => approvedAccountDigest(await readAccountFile(path));
/**
 * The approved variables for this attempt, read once from the descriptor that was
 * validated. The returned entries — not the pathname — are what execution may pass to the
 * container, and only once they are shown to be the material `pinned` approves.
 *
 * Shape alone is not approval. Every attestor-readable private file of `TEST_ACCOUNT_*`
 * variables satisfies the structural checks, including one for an account holding
 * privileges this scenario was never approved to exercise; only the digest carried by the
 * attempt grant says which account material this attempt may run with.
 */
async function readTestAccountEnv(path: string, pinned: string): Promise<TestAccountEnv> {
  const entries = await readAccountFile(path);
  if (approvedAccountDigest(entries) !== pinned) throw new Error('The test-account configuration at this path is not the material this attempt authority approved');
  return entries;
}

export type PhaseResult = { phase: Phase; exitCode: number; timedOut: boolean; durationMs: number };
export type Runner = (command: { file: string; argv: string[]; processEnv?: Record<string, string> }, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; timedOut: boolean }>;
/** `absent` is the only state that proves this attempt can no longer act on shared resources. */
export type ContainerState = 'absent' | 'present' | 'unknown';
export type Settler = (name: string) => Promise<ContainerState>;

const spawnProcess = (file: string, argv: string[], timeoutMs: number, signal?: AbortSignal, processEnv?: Record<string, string>) => new Promise<{ exitCode: number; timedOut: boolean }>(resolve => {
  // Candidate-influenced stdout/stderr is never captured or forwarded: it can carry
  // test-account credentials, and the report file is the only accepted channel.
  // `processEnv` carries the approved test-account values that the command line names
  // without them; the attestor's own environment is otherwise passed through unchanged so
  // the Docker CLI keeps the configuration it needs to reach the pinned socket.
  const child = spawn(file, argv, { stdio: 'ignore', env: processEnv && Object.keys(processEnv).length ? { ...process.env, ...processEnv } : process.env });
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
const dockerRunner: Runner = (command, timeoutMs, signal) => spawnProcess(command.file, command.argv, timeoutMs, signal, command.processEnv);
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
 * Both commands address the same pinned endpoint the attempt ran on, because removing on
 * one daemon and confirming absence on another proves nothing about the live container.
 */
export const dockerSettler = (dockerHost: string): Settler => async name => {
  await spawnProcess('docker', dockerArgv(dockerHost, ['rm', '--force', name]), 30_000);
  return inspectContainer(name, dockerHost);
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
export type Preflight = { oraclePath: string; outputPath: string; outputBoundary: BoundaryIdentity; bundleDigest: string; testAccountEnv: TestAccountEnv };
/**
 * Structural isolation plus the first bundle measurement. The attestor that will execute
 * performs this before the runner acknowledges: a refusal here leaves the attempt
 * unacknowledged, so it expires and releases its reservations instead of blocking them
 * until an operator settles by hand.
 */
export async function preflightAttempt(plan: unknown, options: AttestorIdentity = {}): Promise<Preflight> {
  const p = executionPlanSchema.parse(plan);
  const boundaryPath = await provisionAttemptBoundary(p, attestorIdentity(options).uid);
  const paths = await assertIsolation(p, { ...options, boundaryPath });
  return { ...paths, bundleDigest: (await oracleBundleDigest(paths.oraclePath)).digest };
}

/**
 * Run one authorized attempt inside the host attestor. Every fact this returns is the
 * supervising process's own observation — the digests it measured, the exit codes and
 * timings of the container invocations it made, and the container states it confirmed
 * after removal — which is what makes the record signable. It still decides nothing
 * about acceptance. `signal` carries loss of attempt authority: an aborted attempt stops
 * talking to the target and settles.
 */
export async function executeAttempt(plan: unknown, options: AttestorIdentity & { run?: Runner; settle?: Settler; now?: () => Date; preflight?: Preflight; signal?: AbortSignal } = {}): Promise<ExecutionRecord> {
  const p = executionPlanSchema.parse(plan);
  const now = options.now ?? (() => new Date());
  const run = options.run ?? dockerRunner, settle = options.settle ?? dockerSettler(p.grant.executionHost);
  const signal = options.signal;
  const paths = options.preflight ?? await preflightAttempt(p, { uid: options.uid, gids: options.gids });
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
  // The recorded output path must still lead to the directory preflight approved. A
  // renamed or replaced boundary would otherwise let an older attempt's passing report
  // be measured, signed and collected as this attempt's behaviour.
  if (!await boundaryUnchanged(paths.outputPath, paths.outputBoundary)) refusals.push('The collection boundary was replaced during the attempt; the recorded output path is not the directory this attempt prepared');
  const timedOut = phases.some(phase => phase.timedOut);
  return { grant: p.grant, startedAt, finishedAt, phases,
    bundleDigestBefore: before.digest, bundleDigestAfter: after.digest, runnerImageDigest: p.grant.runnerImageDigest,
    outcome: timedOut ? 'timed_out' : refusals.length || phases.length < 2 ? 'failed' : 'completed',
    refusals, outputPath: paths.outputPath, settlement: { settled, containers } };
}
