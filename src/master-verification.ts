import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { implementerIdentities, postDeployProofPrefix, postDeployProofs, type Create, type Work } from './model.js';
import { followUpOf, observationWindowFor, patternOfProof, postDeployFollowUpId, postDeployMarker, type PatternProjection, type PatternProjections, type PatternReader } from './model/observation-window.js';
import { evidenceProves } from './model/mechanical-proofs.js';
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

type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => string;
const defaultRun: Run = (command, args, options = {}) => execFileSync(command, args, { ...options, encoding: 'utf8', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 90_000 });
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

/**
 * An isolated clean checkout of exactly the observed release, whose CLI emits the instructions and
 * (GY-1732) decides the post-deploy follow-ups: their identity, text and observation window are that
 * release's, never the coordinator checkout's.
 */
export interface IsolatedRelease { release: InstructionRelease; emit: () => Promise<EmittedInstructions>; checks?: PostDeployFiler; dispose: () => Promise<void> }

/**
 * The release's own filer: `master post-deploy-checks` from the checkout at `cliPath`, the input on
 * stdin and the checks on stdout. No Graphyard credential reaches it; it reads and writes nothing else.
 * A release that predates the command, or any failure, throws, and the filing is deferred.
 */
export function releaseChecks(cliPath: string, run: Run = defaultRun): PostDeployFiler {
  return async input => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));
    const checks = JSON.parse(run(process.execPath, [cliPath, 'master', 'post-deploy-checks'], { cwd: dirname(cliPath), env, input: JSON.stringify(input) })) as unknown;
    if (!Array.isArray(checks) || !checks.every(check => check && typeof check.criterion === 'string' && typeof check.proof === 'string' && (check.result === 'observed' || check.result === 'owed')))
      throw new Error('master post-deploy-checks printed no list of checks');
    return checks as PostDeployCheck[];
  };
}

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
    // Borrow the coordinator's object store, and its shallow boundary when it has one: a clone of
    // a shallow checkout ignores --shared and copies only its refs, so a fetched release is lost.
    const [objects, shallow] = run('git', ['-C', top, 'rev-parse', '--path-format=absolute', '--git-path', 'objects', '--git-path', 'shallow']).trim().split('\n');
    run('git', ['init', '-q', checkout]);
    await writeFile(join(checkout, '.git/objects/info/alternates'), `${objects}\n`);
    await copyFile(shallow, join(checkout, '.git/shallow')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    run('git', ['-C', checkout, 'checkout', '-q', '--detach', sha]);
    await symlink(modules, join(checkout, 'node_modules'), 'dir');
    const cliPath = join(checkout, relative(top, config.cliPath));
    // The scratch checkout has no origin, so the repository is the coordinator's.
    const release = { ...checkoutRelease(cliPath, run), repository: checkoutRelease(config.cliPath, run).repository };
    return { release, emit: () => emitInstructions({ ...config, cliPath }, run), checks: releaseChecks(cliPath, run), dispose };
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
  /**
   * `POST work` with an idempotency key, as an identity that may create work — the master's operator
   * agent, never the coordinator: files the follow-up an owed post-deploy verification needs (GY-1660), returning the created item.
   */
  file?: (input: NonNullable<PostDeployCheck['followUp']>['input'], requestId: string) => Promise<{ key?: string } | unknown>;
  /** Releases a filed follow-up from backlog as the same operator agent (GY-1747): the observation that the release serves the delivery is its release. */
  releaseWork?: (key: string) => Promise<void>;
  /** The intervention report's under-threshold reading for a pattern (GY-1698): the follow-up's observation window is taken from it. */
  patterns?: PatternReader;
  /** The coordinator checkout's own filer, used only when it is at the observed release's commit (or has none to compare); `postDeployChecks` by default. */
  checks?: PostDeployFiler;
  now?: () => number;
}

/**
 * One verification attempt. The observation is taken fresh, the instructions are emitted only
 * once the cheap refusals pass, and the record is written only when the full assessment holds
 * — with `now` read again after emitting, so a slow emission cannot ride on an observation that
 * has since gone stale. A coordinator checkout at another commit than the observed release is
 * replaced, for emission and for the post-deploy follow-ups it files (GY-1732), by an isolated
 * checkout of exactly that release; the coordinator's own commit and dirt then emit nothing and
 * decide nothing. Where that checkout cannot be had or its filer cannot run, the follow-ups are
 * deferred — owed, unfiled, the observation unrecorded so a later attempt files them — never filed
 * by the coordinator's code, which may predate the release's observation windows.
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
  // GY-1732 AC-1: a checkout of the observed release's repository at another commit files nothing with its own code.
  // A checkout of another repository has no commit comparable to the release, and the release carries no Graphyard
  // filer to run (its commit is never in the launcher's store), so the coordinator's Graphyard code is the only filer.
  const isolate = emits && !!observation.sha && !!coordinator.sha && coordinator.sha !== observation.sha;
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
  let checkout: IsolatedRelease | null = null;
  if (isolate) {
    const materialized = effects.isolate ? await effects.isolate(observation.sha!) : { reason: 'no isolated checkout of the observed release can be made' };
    // GY-1732 AC-2: without the release's checkout its filer cannot run, so each owed follow-up is deferred, never filed by this checkout's code.
    if ('reason' in materialized) return result({ ...preflight, verifiable: false, refusals: [materialized.reason] }, null,
      deferPostDeployFollowUps(current, observation.sha!, snapshot.work, `the observed release ${observation.sha!.slice(0, 12)} could not be checked out to file it at its own identity: ${materialized.reason}`));
    // The release's checkout is a clone of the coordinator's, so it is judged as the coordinator's repository.
    checkout = materialized; release = { ...checkout.release, repository: coordinator.repository }; isolated = true;
  }
  try {
    const emitted = !emits ? undefined : checkout ? await checkout.emit() : await effects.emit();
    const assessment = assessDeploymentVerification(current, { observation, release, emitted, now: now(), freshnessMs, repository: effects.repository });
    if (!assessment.verifiable) return result(assessment, null);
    // Follow-ups are filed before the observation is recorded: a filing that fails leaves the delivery
    // unobserved, so the retry files it, where recording first would refuse every retry as already observed.
    let postDeploy: FiledPostDeployCheck[];
    try { postDeploy = await filePostDeployFollowUps(current, assessment.record!.sha, snapshot.work, effects.file, new Date(now()), effects.patterns, new Date(observation.at), checkout ? checkout.checks ?? noReleaseFiler : effects.checks); }
    catch (error) { if (error instanceof ReleaseFilerUnavailable) return result({ ...assessment, verifiable: false, refusals: [error.message] }, null); throw error; }
    const deferred = postDeploy.filter(check => check.deferred);
    // A deferred filing leaves the delivery unobserved for the same reason: the attempt that can run the release's filer files it.
    if (deferred.length) return result({ ...assessment, verifiable: false, refusals: deferred.map(check => `${check.criterion} (${check.proof}) owes its post-deploy follow-up ${check.requestId}, whose filing is deferred: ${check.deferred}`) }, null, postDeploy);
    // GY-1747: the serving release being observed releases its follow-ups from backlog, before the record, so a failed release retries.
    const filed = postDeploy.filter(check => check.followUp && !snapshot.work.some(item => item.key === check.followUp && item.ready));
    // Authority is owed only for a follow-up still unreleased; without it a filed follow-up would stay in backlog once this action is recorded away, so the delivery stays unobserved.
    if (filed.length && !effects.releaseWork) return result({ ...assessment, verifiable: false, refusals: filed.map(check => `${check.criterion} (${check.proof}) has a filed post-deploy follow-up, and this master has no operator-agent identity to release it from backlog with`) }, null, postDeploy);
    for (const check of filed) await effects.releaseWork!(check.followUp!);
    const existing = current.delivery!.deployment?.sha === assessment.record!.sha;
    if (!existing) await effects.record(current, assessment.record!);
    return result(assessment, existing ? 'existing' : 'now', postDeploy);
  } finally { await checkout?.dispose(); }
}

export interface PostDeployCheck {
  criterion: string; proof: string; result: 'observed' | 'owed';
  /** The follow-up an owed observation files: its create input and the request id that makes filing it idempotent. */
  followUp: { title: string; requestId: string; input: Pick<Create, 'title' | 'description' | 'type' | 'priority' | 'dependencies' | 'criteria' | 'observationWindow'> & { reason: string } } | null;
}
/** The window computation lives in model/observation-window.ts, where the control plane reads it too (GY-1735). */
export { criterionHoldDays, criterionWindowDays, criterionWindowHours, observationWindowFor, patternOfProof, postDeployFollowUpId, type PatternProjection, type PatternProjections, type PatternReader } from './model/observation-window.js';
/** What a release's filer decides from (GY-1732): `master post-deploy-checks` reads it as JSON on stdin. */
export interface PostDeployChecksInput { work: Work; release: string; now: string; projections: PatternProjections; servedAt?: string }
/** The code that decides a delivered item's post-deploy checks and their follow-ups: the observed release's own, wherever it differs from the coordinator's. */
export type PostDeployFiler = (input: PostDeployChecksInput) => Promise<PostDeployCheck[]>;
/**
 * The filer for the observed release `sha` outside `verifyDeployment` (GY-1732): the executor's verify-deployment
 * files through it. The coordinator checkout's own code at that commit (or of another repository, or with no commit, as in
 * `verifyDeployment`); otherwise the release's isolated checkout, disposed by the caller; or the reason it cannot be had,
 * for which each owed follow-up is deferred rather than filed by the coordinator's code.
 */
export async function releasePostDeployFiler(config: MasterConfig, sha: string, run: Run = defaultRun, isolate: typeof isolateRelease = isolateRelease): Promise<{ filer: PostDeployFiler; dispose: () => Promise<void> } | { reason: string }> {
  const coordinator = checkoutRelease(config.cliPath, run);
  if (!emitsManagedInstructions(coordinator, config.repository) || !coordinator.sha || coordinator.sha === sha) return { filer: localPostDeployChecks, dispose: async () => {} };
  const materialized = await isolate(config, sha, run);
  if ('reason' in materialized) return { reason: `the observed release ${sha.slice(0, 12)} could not be checked out to file it at its own identity: ${materialized.reason}` };
  return { filer: materialized.checks ?? noReleaseFiler, dispose: materialized.dispose };
}
/** An isolated checkout that carries no filer: its filing is deferred, never done by the coordinator's code. */
const noReleaseFiler: PostDeployFiler = async () => { throw new Error('the isolated release checkout carries no post-deploy filer'); };
/** `postDeployChecks` over a filer's input: what this checkout's code decides, and what `master post-deploy-checks` prints. */
export const localPostDeployChecks: PostDeployFiler = async input => postDeployChecks(input.work, input.release, new Date(input.now), input.projections ?? {}, input.servedAt ? new Date(input.servedAt) : undefined);
/**
 * `master verify-deployment`'s check of the delivered item's declared post-deploy criteria (GY-1660)
 * on the serving release `release`: a proof is observed only by evidence the acceptance gate would
 * itself accept there — trusted, unrevoked, under the item's current policy, unexpired, from no
 * implementer, and passing by its family's rule — recorded at that release, against the delivered
 * merge as its base and after the merge: evidence recorded before delivery is a pre-merge record,
 * never the live observation. Owed otherwise. An owed one carries its follow-up: a chore depending
 * on the delivered item, marked with its request id so two proofs of one criterion are two items
 * however long their names, whose single criterion asks for the same observation
 * from its own head against that serving release — a pre-merge observation there, never itself
 * declared post-deploy.
 */
export function postDeployChecks(work: Work, release: string, now = new Date(), projections: PatternProjections = {}, servedAt?: Date): PostDeployCheck[] {
  const implementers = implementerIdentities(work), mergedAt = work.delivery ? Date.parse(work.delivery.mergedAt) : NaN;
  // GY-1727: a live window runs from the earliest instant the release is known to serve the item — a
  // deployment already recorded at this release, else the observation filing now, else the filing clock.
  const recorded = work.delivery?.deployment?.sha === release ? Date.parse(work.delivery.deployment.observedAt) : NaN;
  const served = Math.min(...[recorded, servedAt?.getTime() ?? now.getTime()].filter(Number.isFinite));
  // The latest applicable record decides, as on the evidence path: a later trusted failure outranks an earlier pass.
  const observes = (proof: string) => {
    const latest = (work.evidence ?? []).filter(evidence => !!work.delivery && evidence.proof === proof && evidence.sha === release && evidence.trusted && !evidence.revocation
      && evidence.baseSha === work.delivery.mergeSha && Date.parse(evidence.at) > mergedAt
      && evidence.policyRevision === work.policyRevision && (!evidence.expiresAt || Date.parse(evidence.expiresAt) > now.getTime()) && !implementers.includes(evidence.producer))
      .reduce<NonNullable<Work['evidence']>[number] | undefined>((last, evidence) => !last || Date.parse(evidence.at) >= Date.parse(last.at) ? evidence : last, undefined);
    return !!latest && evidenceProves(proof, latest);
  };
  return work.criteria.flatMap(criterion => postDeployProofs(criterion).map(proof => {
    if (observes(proof)) return { criterion: criterion.id, proof, result: 'observed' as const, followUp: null };
    const name = proof.slice(postDeployProofPrefix.length), short = release.slice(0, 12);
    const title = `Post-deploy verification of ${work.key} ${criterion.id} (${name}) on release ${short}`.slice(0, 200);
    const text = `From this head against the serving release ${short} that carries ${work.key}'s merge ${work.delivery?.mergeSha.slice(0, 12) ?? ''}: ${criterion.text}`.slice(0, 2000);
    const requestId = postDeployFollowUpId(work, criterion.id, proof, release);
    // GY-1698: a windowed reading's earliest instant rides the follow-up, so nothing dispatches it before then.
    const observationWindow = observationWindowFor(work, criterion, proof, projections[proof], served);
    return { criterion: criterion.id, proof, result: 'owed' as const, followUp: { title, requestId, input: {
      title, type: 'chore' as const, priority: 1, dependencies: [work.id], reason: `${work.key} ${criterion.id}'s declared post-deploy verification ${proof} is unobserved on the serving release ${short}`.slice(0, 2000),
      // The marker leads, so no truncation of a long criterion can cut the identity a later check matches by.
      description: `${postDeployMarker}${requestId}\n\n${work.key} was delivered with ${criterion.id} declared a post-deploy verification (${proof}). master verify-deployment found no trusted passing ${proof} observation on the serving release ${release}, so this item owes it: observe the outcome on that release and record the proof.${observationWindow ? `\n\nObservation window: the reading can first exist at ${observationWindow.notBefore} — ${observationWindow.detail}. The item is not dispatched before then.` : ''}\n\n${work.key} ${criterion.id}: ${criterion.text}`.slice(0, 20000),
      criteria: [{ id: 'AC-1', text, proofs: [`manual:${name.replace(/\//g, '-')}-on-serving-release`] }], ...(observationWindow ? { observationWindow } : {}) } } };
  }));
}

/** The follow-up's identity: a retried filing replays under it, and an item whose description leads with it is that follow-up. */

/**
 * GY-1660: a verified release checks the delivered item's declared post-deploy verifications on
 * itself. An owed one files its follow-up — once: an item already marked with that follow-up's
 * request id is named instead, the request id makes a retried filing a replay, and checks are filed one after
 * another so none is filed against a snapshot another has just changed — so the live observation
 * the merge never waited for is owned by an item rather than by nobody.
 */
/** The release's filer failed where this checkout's code sees nothing to defer: what is owed cannot be known, so nothing is recorded (GY-1732). */
export class ReleaseFilerUnavailable extends Error {}
/** A check as filed: its follow-up's key, or — deferred (GY-1732) — the request id a later filing keeps and why it waits. */
export type FiledPostDeployCheck = Omit<PostDeployCheck, 'followUp'> & { followUp: string | null; requestId?: string; deferred?: string };
export async function filePostDeployFollowUps(work: Work, release: string, all: readonly Pick<Work, 'key' | 'description'>[], file?: VerificationEffects['file'], now = new Date(), patterns?: PatternReader, servedAt?: Date, filer: PostDeployFiler = localPostDeployChecks) {
  const known = [...all], results: FiledPostDeployCheck[] = [];
  let checks: PostDeployCheck[];
  // GY-1732: the filer is the observed release's code; one that cannot run defers every owed follow-up rather than filing it without the release's window.
  try { checks = await filer({ work, release, now: now.toISOString(), projections: await patternProjections(work, patterns), ...(servedAt ? { servedAt: servedAt.toISOString() } : {}) }); }
  catch (error) {
    const reason = `the observed release ${release.slice(0, 12)}'s own filer could not run: ${message(error)}`.slice(0, 2000), deferred = deferPostDeployFollowUps(work, release, all, reason);
    // What is owed is the release's code to decide: where this checkout's code sees nothing left to defer, the release may still owe one, so the filing fails rather than reading as nothing owed.
    if (!deferred.some(check => check.deferred)) throw new ReleaseFilerUnavailable(`${work.key}: whether the release ${release.slice(0, 12)} owes post-deploy follow-ups is its own code's to decide, and ${reason}; the deployment observation waits for it`);
    return deferred;
  }
  for (const { followUp, ...rest } of checks) {
    if (!followUp) { results.push({ ...rest, followUp: null }); continue; }
    const filed = known.find(item => followUpOf(item) === followUp.requestId)?.key;
    if (filed || !file) { results.push({ ...rest, followUp: filed ?? null }); continue; }
    const created = await file(followUp.input, followUp.requestId) as { key?: string } | undefined;
    if (created?.key) known.push({ key: created.key, description: followUp.input.description });
    results.push({ ...rest, followUp: created?.key ?? null });
  }
  return results;
}

/**
 * GY-1732 AC-2: the checks a filing at the release's identity would have filed, when it cannot run —
 * each unobserved declared proof owed under the request id the release files it by (an identity of
 * item, criterion, proof and release, not of any code's window), unfiled, with `reason` naming the
 * deferral. One already filed under that id is named instead: there is nothing left to defer.
 */
export function deferPostDeployFollowUps(work: Work, release: string, all: readonly Pick<Work, 'key' | 'description'>[], reason: string): FiledPostDeployCheck[] {
  return postDeployChecks(work, release).map(({ followUp, ...rest }) => {
    if (!followUp) return { ...rest, followUp: null };
    const filed = all.find(item => followUpOf(item) === followUp.requestId)?.key;
    return filed ? { ...rest, followUp: filed } : { ...rest, followUp: null, requestId: followUp.requestId, deferred: reason };
  });
}

/**
 * The report's reading for every declared intervention-pattern proof the item carries, read once per
 * proof before the checks run (GY-1698). A reader that fails, or none, leaves the proof without a
 * reading: the follow-up then falls back to the merge time plus the criterion's window, and is still
 * filed — the window is the follow-up's convenience, never a reason to lose it.
 */
export async function patternProjections(work: Pick<Work, 'criteria'>, patterns?: PatternReader): Promise<PatternProjections> {
  const projections: Record<string, PatternProjection | null> = {};
  if (!patterns) return projections;
  for (const proof of new Set(work.criteria.flatMap(postDeployProofs))) {
    const pattern = patternOfProof(proof);
    if (!pattern) continue;
    try { projections[proof] = await patterns(pattern); } catch { projections[proof] = null; }
  }
  return projections;
}
/**
 * A reader over `GET /api/interventions` (the coordinator credential reads it; an operator agent may
 * not): the pattern's row and its under-threshold reading, or null when the report holds none.
 */
export function patternReader(read: (path: string) => Promise<unknown>): PatternReader {
  return async pattern => {
    const report = await read('interventions') as { patterns?: { kind: string; stage: string; underThreshold?: PatternProjection }[] } | null;
    const row = report?.patterns?.find(entry => entry.kind === pattern.kind && entry.stage === pattern.stage);
    return row?.underThreshold ? { since: row.underThreshold.since ?? null, projected: row.underThreshold.projected ?? null } : null;
  };
}

/** Effects bound to the real coordinator process, mirroring the daemon's. */
export function verificationEffects(config: MasterConfig, deps: { root: string; snapshot: () => Promise<{ work: Work[]; now: string }>; mutate: (path: string, data: unknown, requestId?: string) => Promise<any>; file?: VerificationEffects['file']; read?: (path: string) => Promise<unknown>; run?: Run }): VerificationEffects {
  const run = deps.run ?? defaultRun;
  return {
    snapshot: deps.snapshot, repository: config.repository,
    ...(deps.read ? { patterns: patternReader(deps.read) } : {}),
    // Containment is derived in the managed repository's checkout, never the launcher's directory.
    observe: delivered => observeDeployment(config, delivered, run, fetch, () => Date.now(), { root: deps.root }),
    release: () => checkoutRelease(config.cliPath, run),
    emit: () => emitInstructions(config, run),
    isolate: sha => isolateRelease(config, sha, run),
    record: (work, data) => deps.mutate(`work/${work.id}/deployment`, data),
    checks: localPostDeployChecks,
    ...(deps.file ? { file: deps.file } : {}),
    // GY-1747: a master that can file a follow-up as its operator agent releases it as that agent, so the CLI path releases what the executor's does.
    ...(deps.file ? { releaseWork: async (key: string) => {
      const item = (await deps.snapshot()).work.find(entry => entry.key === key);
      if (!item || item.stage !== 'backlog' || item.ready) return;
      const { agentToken } = await import('./master/autonomy.js');
      const response = await fetch(`${config.url}/api/work/${item.id}/ready`, { method: 'POST', body: JSON.stringify({ expectedRevision: item.revision, reason: 'the release serving the delivery is observed deployed' }), headers: { Authorization: `Bearer ${await agentToken(deps.root, config, 'operatorAgent')}`, 'Content-Type': 'application/json', 'Idempotency-Key': `release-${item.id}-${item.revision}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: unknown } | null; throw new Error(typeof body?.error === 'string' ? body.error : `releasing ${key} returned ${response.status}`); }
    } } : {}),
  };
}
