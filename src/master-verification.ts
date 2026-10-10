import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { postDeployChecks, type PostDeployCheck, type Work } from './model.js';
import type { MasterConfig } from './master.js';
import { observeDeployment, type DeploymentObservation } from './master-daemon.js';
import { repositoryFromRemote } from './onboarding.js';

/**
 * The deployment-verification step of the perpetual master loop, for one delivered item.
 *
 * Done marks an observed merge. Whether the release that is actually serving carries the change
 * is a separate fact, and this module establishes it the only way the loop accepts: a fresh
 * observation of the deployed release, checked against the instructions that exact release
 * emits — `master guide`, and a fresh `init` into a scratch checkout outside the repository —
 * and recorded on the delivered item as the deployment observation Graphyard binds later
 * post-deployment proof to. Anything weaker is refused with the reason: a stale observation, a
 * checkout that is not the deployed release, a release that does not serve the merge yet, or
 * emitted instructions that lack the loop. A refusal keeps the loop cycling; it never claims the
 * step. A coordinator checkout at another commit than the observed release — the supervised
 * master upgrades past what production serves — emits nothing itself: the instructions come from
 * an isolated clean checkout of exactly the observed commit (GY-1409), or the step is refused.
 */

/** How long a deployment observation may be relied on before the release must be observed again. */
export const deploymentFreshnessMs = 300_000;

const phrase = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
/** The statements every emitted instruction set must carry for the loop to be the one the docs describe. */
export const masterLoopStatements = [
  { name: 'the perpetual cycle', pattern: /keep cycling/i },
  { name: 'deployment verification as a step of the cycle', pattern: phrase('deployment verification') },
  { name: 'the terminal condition', pattern: phrase('genuinely external blocker recorded in Graphyard') },
  { name: 'verification against the exact deployed release', pattern: phrase('against the exact deployed release') },
  { name: 'the non-stopping conditions', pattern: phrase('Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions') },
  { name: 'the finished-agent closure duty', pattern: phrase('Close finished agent sessions') },
] as const;
export const missingLoopStatements = (text: string) => masterLoopStatements.filter(statement => !statement.pattern.test(text)).map(statement => statement.name);

/** The release identity of the checkout whose CLI emitted the instructions, and the repository it is a checkout of. */
export interface InstructionRelease { sha: string | null; clean: boolean; repository: string | null; reason: string | null }
/** What the release emitted: the master guide, and the AGENTS.md a fresh init wrote into a scratch checkout. */
export interface EmittedInstructions { guide: string; init: string }
/**
 * `repository` is the managed repository. The emitted instructions are the live check when the
 * launcher's checkout is a checkout of it — Graphyard verifying its own release; a checkout of
 * an unrelated repository can only be judged on whether the release serves the merge.
 */
export interface VerificationInput { observation: DeploymentObservation; release: InstructionRelease; emitted?: EmittedInstructions; now: number; freshnessMs?: number; repository?: string }
export type InstructionCheck = 'pass' | 'fail' | 'unobserved' | 'not-applicable';
export const emitsManagedInstructions = (release: InstructionRelease, repository?: string) => !repository || !release.repository || release.repository.toLowerCase() === repository.toLowerCase();
export interface VerificationRecord { sha: string; mergeSha: string; source: 'endpoint' | 'github-deployment'; observedAt: string }

/**
 * Pure: decide whether one observation verifies one delivery. Every refusal is a sentence the
 * master can act on. `emitted` is optional so the executor can refuse before spending a scratch
 * checkout on a release that cannot verify anyway; a full assessment always supplies it.
 */
export function assessDeploymentVerification(work: Work, input: VerificationInput) {
  const refusals: string[] = [];
  const freshnessMs = input.freshnessMs ?? deploymentFreshnessMs;
  const { observation, release } = input;
  const delivery = work.stage === 'done' ? work.delivery : undefined;
  if (!delivery) refusals.push(`${work.key} is not delivered; deployment verification follows the observed merge`);
  if (observation.source === 'unavailable' || !observation.sha) refusals.push(`The deployed release is unobserved: ${observation.reason ?? 'no deployment observation is configured'}`);
  const age = input.now - Date.parse(observation.at);
  if (!Number.isFinite(age) || age < 0) refusals.push(`Deployment observation time ${observation.at} is invalid or ahead of the coordinator clock`);
  else if (age > freshnessMs) refusals.push(`Deployment observation from ${observation.at} is stale (${Math.round(age / 1000)}s old; limit ${freshnessMs / 1000}s); observe the release again`);
  if (delivery && observation.sha) {
    if (delivery.deployment && delivery.deployment.sha !== observation.sha) refusals.push(`${work.key} already records deployment ${delivery.deployment.sha} for merge ${delivery.mergeSha}; a later rollout to ${observation.sha} is verified through a follow-up item`);
    if (!observation.deployed.includes(work.key)) refusals.push(`Deployed release ${observation.sha} does not serve ${work.key} merge commit ${delivery.mergeSha}${observation.pending.includes(work.key) ? ' yet' : ''}`);
  }
  const emits = emitsManagedInstructions(release, input.repository);
  if (observation.sha && emits) {
    if (!release.sha) refusals.push(`The checkout emitting the instructions has no release identity: ${release.reason ?? 'not a git checkout'}`);
    else if (release.sha !== observation.sha || !release.clean) refusals.push(`Instructions were emitted by a local checkout at ${release.sha}${release.clean ? '' : ' with uncommitted changes'}, not by the deployed release ${observation.sha}; check out the deployed release and verify again`);
  }
  const initial: InstructionCheck = emits ? 'unobserved' : 'not-applicable';
  const checks: { guide: InstructionCheck; init: InstructionCheck } = { guide: initial, init: initial };
  // A launcher that is not a checkout of the managed repository emits nothing about it; the
  // release's coverage of the merge is then the whole check.
  if (emits && input.emitted) {
    const guide = missingLoopStatements(input.emitted.guide), init = missingLoopStatements(input.emitted.init);
    checks.guide = guide.length ? 'fail' : 'pass'; checks.init = init.length ? 'fail' : 'pass';
    if (guide.length) refusals.push(`master guide from the deployed release lacks ${guide.join(', ')}`);
    if (init.length) refusals.push(`A fresh init from the deployed release emits instructions lacking ${init.join(', ')}`);
  }
  const verifiable = !refusals.length && (!emits || !!input.emitted);
  const record: VerificationRecord | null = verifiable
    ? { sha: observation.sha!, mergeSha: delivery!.mergeSha, source: observation.source as VerificationRecord['source'], observedAt: observation.at }
    : null;
  return { verifiable, refusals, checks, record, covers: record ? record.sha === record.mergeSha ? 'exact' as const : 'descendant' as const : null };
}

type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string;
const defaultRun: Run = (command, args, options = {}) => execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The commit the CLI checkout is at, and whether its tracked files are untouched. */
export function checkoutRelease(cliPath: string, run: Run = defaultRun): InstructionRelease {
  try {
    const sha = run('git', ['-C', dirname(cliPath), 'rev-parse', 'HEAD']).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) return { sha: null, clean: false, repository: null, reason: 'git did not report a commit for the CLI checkout' };
    const clean = run('git', ['-C', dirname(cliPath), 'status', '--porcelain', '--untracked-files=no']).trim() === '';
    let repository: string | null = null;
    try { repository = repositoryFromRemote(run('git', ['-C', dirname(cliPath), 'remote', 'get-url', 'origin'])); } catch { /* no origin: judged as a checkout of the managed repository */ }
    return { sha, clean, repository, reason: null };
  } catch (error) { return { sha: null, clean: false, repository: null, reason: message(error) }; }
}

/**
 * What the release emits, read the way an operator would: `master guide` on stdout, and the
 * AGENTS.md a fresh `init --url` writes into a scratch git checkout outside every repository.
 * No Graphyard credential reaches either process, so the init contacts no server and the
 * scratch checkout is removed whether or not it succeeded.
 */
export async function emitInstructions(config: MasterConfig, run: Run = defaultRun): Promise<EmittedInstructions> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-verify-'));
  try {
    run('git', ['init', '-q', scratch]);
    const guide = run(process.execPath, [config.cliPath, 'master', 'guide'], { cwd: scratch, env });
    run(process.execPath, [config.cliPath, 'init', '--url', config.url, '--cli-path', config.cliPath], { cwd: scratch, env });
    return { guide, init: await readFile(join(scratch, 'AGENTS.md'), 'utf8') };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** An isolated clean checkout of exactly the observed release, whose CLI emits the instructions. */
export interface IsolatedRelease { release: InstructionRelease; emit: () => Promise<EmittedInstructions>; dispose: () => Promise<void> }

/**
 * Check out `sha` from the coordinator checkout's object store into a scratch directory outside
 * every repository, without touching the coordinator checkout. A commit the store lacks is
 * refused (missing), never fetched or approximated; the scratch checkout's identity is read back
 * from git, so a checkout that is not exactly `sha` and clean is refused by the assessment.
 */
export async function isolateRelease(config: MasterConfig, sha: string, run: Run = defaultRun): Promise<IsolatedRelease | { reason: string }> {
  const source = dirname(config.cliPath);
  let top: string, modules: string;
  try { top = run('git', ['-C', source, 'rev-parse', '--show-toplevel']).trim(); } catch (error) { return { reason: `The coordinator checkout has no release identity: ${message(error)}` }; }
  try { run('git', ['-C', top, 'cat-file', '-e', `${sha}^{commit}`]); } catch { return { reason: `Deployed release ${sha} is missing from the coordinator checkout; fetch it and verify again` }; }
  try { modules = createRequire(config.cliPath).resolve('tsx').replace(/\/node_modules\/.*$/, '/node_modules'); } catch (error) { return { reason: `The coordinator checkout's dependencies do not resolve: ${message(error)}` }; }
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-release-'));
  const dispose = () => rm(scratch, { recursive: true, force: true });
  try {
    const checkout = join(scratch, 'release');
    run('git', ['clone', '-q', '--shared', '--no-checkout', top, checkout]);
    run('git', ['-C', checkout, 'checkout', '-q', '--detach', sha]);
    await symlink(modules, join(checkout, 'node_modules'), 'dir');
    const cliPath = join(checkout, relative(top, config.cliPath));
    // The clone's origin is the coordinator checkout, so the repository is the coordinator's.
    const release = { ...checkoutRelease(cliPath, run), repository: checkoutRelease(config.cliPath, run).repository };
    return { release, emit: () => emitInstructions({ ...config, cliPath }, run), dispose };
  } catch (error) { await dispose(); return { reason: `Could not check out deployed release ${sha} in isolation: ${message(error)}` }; }
}

export interface VerificationEffects {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  observe: (delivered: Work[]) => Promise<DeploymentObservation>;
  release: () => InstructionRelease;
  emit: () => Promise<EmittedInstructions>;
  /** Materialize the observed release when the coordinator checkout is at another commit. */
  isolate?: (sha: string) => Promise<IsolatedRelease | { reason: string }>;
  /** `POST work/:id/deployment`; the control plane binds it to the delivery and refuses a second one. */
  record: (work: Work, data: VerificationRecord) => Promise<unknown>;
  /** The managed repository; see `VerificationInput.repository`. */
  repository?: string;
  /** `POST work` with an idempotency key: files the follow-up an owed post-deploy verification needs (GY-1660), returning the created item. */
  file?: (input: NonNullable<PostDeployCheck['followUp']>['input'], requestId: string) => Promise<{ key?: string } | unknown>;
  now?: () => number;
}

/**
 * One verification attempt. The observation is taken fresh, the instructions are emitted only
 * once the cheap refusals pass, and the record is written only when the full assessment holds
 * — with `now` read again after emitting, so a slow emission cannot ride on an observation that
 * has since gone stale. A coordinator checkout at another commit than the observed release is
 * replaced, for emission, by an isolated checkout of exactly that release; the coordinator's own
 * commit and dirt then emit nothing and decide nothing.
 */
export async function verifyDeployment(work: Work, effects: VerificationEffects, freshnessMs = deploymentFreshnessMs) {
  const now = effects.now ?? Date.now;
  const snapshot = await effects.snapshot();
  const current = snapshot.work.find(item => item.id === work.id);
  if (!current) throw new Error(`Unknown work item ${work.key}`);
  // The probe reads each item's merge commit, so only a delivered item reaches it; undelivered
  // work is refused by the assessment with nothing to observe, never by a crash in the probe.
  const observation = await effects.observe(current.stage === 'done' && current.delivery ? [current] : []);
  const coordinator = effects.release();
  const emits = emitsManagedInstructions(coordinator, effects.repository);
  const isolate = emits && !!effects.isolate && !!observation.sha && !!coordinator.sha && coordinator.sha !== observation.sha;
  let release = coordinator, isolated: boolean = false;
  const result = (assessment: ReturnType<typeof assessDeploymentVerification>, recorded: 'now' | 'existing' | null, postDeploy: Awaited<ReturnType<typeof filePostDeployFollowUps>> = []) => ({
    key: current.key, result: assessment.verifiable ? 'verified' as const : 'refused' as const,
    release: { sha: observation.sha, source: observation.source, observedAt: observation.at, covers: assessment.covers },
    checkout: { sha: coordinator.sha, clean: coordinator.clean }, emittedFrom: emits ? { sha: release.sha, clean: release.clean, isolated } : null,
    checks: assessment.checks, refusals: assessment.refusals, recorded, postDeploy,
  });
  // Before spending a scratch checkout, the release identity is presumed to be the one isolation
  // will produce; the full assessment judges the identity git reads back from it.
  const presumed = isolate ? { ...coordinator, sha: observation.sha, clean: true } : coordinator;
  const preflight = assessDeploymentVerification(current, { observation, release: presumed, now: now(), freshnessMs, repository: effects.repository });
  if (preflight.refusals.length) return result(preflight, null);
  let emitted: EmittedInstructions | undefined;
  if (isolate) {
    const checkout = await effects.isolate!(observation.sha!);
    if ('reason' in checkout) return result({ ...preflight, refusals: [checkout.reason] }, null);
    release = checkout.release; isolated = true;
    try { emitted = await checkout.emit(); } finally { await checkout.dispose(); }
  } else if (emits) emitted = await effects.emit();
  const assessment = assessDeploymentVerification(current, { observation, release, emitted, now: now(), freshnessMs, repository: effects.repository });
  if (!assessment.verifiable) return result(assessment, null);
  const existing = current.delivery!.deployment?.sha === assessment.record!.sha;
  if (!existing) await effects.record(current, assessment.record!);
  return result(assessment, existing ? 'existing' : 'now', await filePostDeployFollowUps(current, assessment.record!.sha, snapshot.work, effects.file));
}

/**
 * GY-1660: a verified release checks the delivered item's declared post-deploy verifications on
 * itself. An owed one files its follow-up — once: an item already holding that follow-up's title
 * is named instead, and the request id makes a retried filing a replay — so the live observation
 * the merge never waited for is owned by an item rather than by nobody.
 */
export async function filePostDeployFollowUps(work: Work, release: string, all: readonly Pick<Work, 'key' | 'title'>[], file?: VerificationEffects['file']) {
  return Promise.all(postDeployChecks(work, release).map(async check => {
    const { followUp, ...rest } = check;
    if (!followUp) return { ...rest, followUp: null };
    const filed = all.find(item => item.title === followUp.title)?.key;
    if (filed || !file) return { ...rest, followUp: filed ?? null };
    const created = await file(followUp.input, followUp.requestId) as { key?: string } | undefined;
    return { ...rest, followUp: created?.key ?? null };
  }));
}

/** Effects bound to the real coordinator process, mirroring the daemon's. */
export function verificationEffects(config: MasterConfig, deps: { root: string; snapshot: () => Promise<{ work: Work[]; now: string }>; mutate: (path: string, data: unknown, requestId?: string) => Promise<any>; run?: Run }): VerificationEffects {
  const run = deps.run ?? defaultRun;
  return {
    snapshot: deps.snapshot, repository: config.repository,
    // Containment is derived in the managed repository's checkout, never the launcher's directory.
    observe: delivered => observeDeployment(config, delivered, run, fetch, () => Date.now(), { root: deps.root }),
    release: () => checkoutRelease(config.cliPath, run),
    emit: () => emitInstructions(config, run),
    isolate: sha => isolateRelease(config, sha, run),
    record: (work, data) => deps.mutate(`work/${work.id}/deployment`, data),
    file: (input, requestId) => deps.mutate('work', input, requestId),
  };
}
