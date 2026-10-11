import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { implementerIdentities, postDeployProofPrefix, postDeployProofs, stages, type Create, type ObservationWindow, type Stage, type Work } from './model.js';
import { interventionKinds, type InterventionKind, type UnderThreshold } from './model/interventions.js';
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
  /**
   * `POST work` with an idempotency key, as an identity that may create work — the master's operator
   * agent, never the coordinator: files the follow-up an owed post-deploy verification needs (GY-1660), returning the created item.
   */
  file?: (input: NonNullable<PostDeployCheck['followUp']>['input'], requestId: string) => Promise<{ key?: string } | unknown>;
  /** The intervention report's under-threshold reading for a pattern (GY-1698): the follow-up's observation window is taken from it. */
  patterns?: PatternReader;
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
  // Follow-ups are filed before the observation is recorded: a filing that fails leaves the delivery
  // unobserved, so the retry files it, where recording first would refuse every retry as already observed.
  const postDeploy = await filePostDeployFollowUps(current, assessment.record!.sha, snapshot.work, effects.file, new Date(now()), effects.patterns);
  const existing = current.delivery!.deployment?.sha === assessment.record!.sha;
  if (!existing) await effects.record(current, assessment.record!);
  return result(assessment, existing ? 'existing' : 'now', postDeploy);
}

export interface PostDeployCheck {
  criterion: string; proof: string; result: 'observed' | 'owed';
  /** The follow-up an owed observation files: its create input and the request id that makes filing it idempotent. */
  followUp: { title: string; requestId: string; input: Pick<Create, 'title' | 'description' | 'type' | 'priority' | 'dependencies' | 'criteria' | 'observationWindow'> & { reason: string } } | null;
}
/** The intervention report's reading for one kind-at-stage pair, as `patterns[].underThreshold` carries it; null when the report holds no row for it. */
export type PatternProjection = Pick<UnderThreshold, 'since' | 'projected'>;
export type PatternReader = (pattern: { kind: InterventionKind; stage: Stage | 'none' }) => Promise<PatternProjection | null>;
/** The projections `postDeployChecks` reads, keyed by the declared proof; a proof with no entry, or a null one, has no report reading. */
export type PatternProjections = Readonly<Record<string, PatternProjection | null>>;
const day = 86_400_000;
/**
 * The kind-at-stage pair a declared `manual:post-deploy/intervention-pattern-KIND-STAGE` proof names
 * (interventions/patterns.ts files it so), or null for any other proof: the kinds carry hyphens
 * themselves, so each is tried whole against the name rather than split on one.
 */
export function patternOfProof(proof: string): { kind: InterventionKind; stage: Stage | 'none' } | null {
  if (!proof.startsWith(`${postDeployProofPrefix}intervention-pattern-`)) return null;
  const name = proof.slice(postDeployProofPrefix.length + 'intervention-pattern-'.length);
  for (const kind of interventionKinds) {
    if (!name.startsWith(`${kind}-`)) continue;
    const stage = name.slice(kind.length + 1);
    if (stage === 'none' || (stages as readonly string[]).includes(stage)) return { kind, stage: stage as Stage | 'none' };
  }
  return null;
}
/**
 * The rolling window a criterion's reading needs, in days, or null when it names none: a rate
 * "per 7 days", a hold "for 14 consecutive days" or "in any rolling 7-day window". The longest named
 * is the reading's: a hold of 14 consecutive days over 7-day windows cannot be read before 14 have run.
 */
export function criterionWindowDays(text: string): number | null {
  const days = [...text.matchAll(/\b(?:per|every|in|within|over|across)\s+(\d{1,3})\s+days?\b|\b(\d{1,3})\s+consecutive\s+days?\b|\b(\d{1,3})[-\s]day\b/gi)]
    .map(match => Number(match[1] ?? match[2] ?? match[3])).filter(value => value > 0);
  return days.length ? Math.max(...days) : null;
}
/**
 * GY-1698 AC-1: the earliest instant the follow-up's reading can exist, or undefined for a follow-up
 * whose criterion names no window and whose proof the report holds no row for. From the report's
 * reading for the pattern: `since` plus the criterion's window where the streak has begun, else the
 * instant the report projects the streak to begin; and never before the delivered item's merge
 * plus the window the criterion names, the later of the two where both exist.
 */
export function observationWindowFor(work: Pick<Work, 'key' | 'delivery'>, criterion: { id: string; text: string }, proof: string, projection: PatternProjection | null | undefined): ObservationWindow | undefined {
  const windowDays = criterionWindowDays(criterion.text), mergedAt = work.delivery ? Date.parse(work.delivery.mergedAt) : NaN;
  const iso = (ms: number) => new Date(ms).toISOString();
  const fromMerge = windowDays !== null && Number.isFinite(mergedAt) ? mergedAt + windowDays * day : null;
  const pattern = patternOfProof(proof);
  const since = projection?.since ? Date.parse(projection.since) : null, projected = projection?.projected ? Date.parse(projection.projected) : null;
  const fromReport = since !== null ? since + (windowDays ?? 0) * day : projected;
  const reading = pattern ? `the ${pattern.kind} reading at ${pattern.stage === 'none' ? 'no stage' : `the ${pattern.stage} stage`}` : `the reading ${proof} names`;
  const window = windowDays !== null ? `${criterion.id} names a ${windowDays}-day window` : `${criterion.id} names no window`;
  if (fromReport !== null && (fromMerge === null || fromReport >= fromMerge)) {
    const detail = since !== null
      ? `the intervention report reads ${reading} under its threshold since ${iso(since)}, and ${window}, so the reading can first exist at ${iso(fromReport)}`
      : `the intervention report reads ${reading} not yet under its threshold (since null) and projects the streak to begin at ${iso(projected!)}, so the reading can first exist then`;
    return { notBefore: iso(fromReport), basis: 'intervention-report', detail: `${detail}${fromMerge !== null ? `; ${work.key} merged at ${iso(mergedAt)}, ${windowDays} days after which is no later` : ''}`.slice(0, 2000) };
  }
  if (fromMerge === null) return undefined;
  const detail = `${work.key} merged at ${iso(mergedAt)} and ${window}, so the reading can first exist at ${iso(fromMerge)}${fromReport !== null ? ` (the intervention report's projection for ${reading}, ${iso(fromReport)}, is earlier)` : pattern ? ` (the intervention report holds no reading for ${reading})` : ''}`;
  return { notBefore: iso(fromMerge), basis: 'criterion-window', detail: detail.slice(0, 2000) };
}
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
export function postDeployChecks(work: Work, release: string, now = new Date(), projections: PatternProjections = {}): PostDeployCheck[] {
  const implementers = implementerIdentities(work), mergedAt = work.delivery ? Date.parse(work.delivery.mergedAt) : NaN;
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
    const observationWindow = observationWindowFor(work, criterion, proof, projections[proof]);
    return { criterion: criterion.id, proof, result: 'owed' as const, followUp: { title, requestId, input: {
      title, type: 'chore' as const, priority: 1, dependencies: [work.id], reason: `${work.key} ${criterion.id}'s declared post-deploy verification ${proof} is unobserved on the serving release ${short}`.slice(0, 2000),
      // The marker leads, so no truncation of a long criterion can cut the identity a later check matches by.
      description: `${postDeployMarker}${requestId}\n\n${work.key} was delivered with ${criterion.id} declared a post-deploy verification (${proof}). master verify-deployment found no trusted passing ${proof} observation on the serving release ${release}, so this item owes it: observe the outcome on that release and record the proof.${observationWindow ? `\n\nObservation window: the reading can first exist at ${observationWindow.notBefore} — ${observationWindow.detail}. The item is not dispatched before then.` : ''}\n\n${work.key} ${criterion.id}: ${criterion.text}`.slice(0, 20000),
      criteria: [{ id: 'AC-1', text, proofs: [`manual:${name.replace(/\//g, '-')}-on-serving-release`] }], ...(observationWindow ? { observationWindow } : {}) } } };
  }));
}

/** The follow-up's identity: a retried filing replays under it, and an item whose description leads with it is that follow-up. */
export const postDeployFollowUpId = (work: Pick<Work, 'id'>, criterion: string, proof: string, release: string) => `post-deploy:${work.id}:${criterion}:${proof}:${release}`;
const postDeployMarker = 'Post-deploy follow-up: ';
const followUpOf = (item: Pick<Work, 'description'>) => item.description?.startsWith(postDeployMarker) ? item.description.slice(postDeployMarker.length).split('\n', 1)[0] : null;

/**
 * GY-1660: a verified release checks the delivered item's declared post-deploy verifications on
 * itself. An owed one files its follow-up — once: an item already marked with that follow-up's
 * request id is named instead, the request id makes a retried filing a replay, and checks are filed one after
 * another so none is filed against a snapshot another has just changed — so the live observation
 * the merge never waited for is owned by an item rather than by nobody.
 */
export async function filePostDeployFollowUps(work: Work, release: string, all: readonly Pick<Work, 'key' | 'description'>[], file?: VerificationEffects['file'], now = new Date(), patterns?: PatternReader) {
  const known = [...all], results: (Omit<PostDeployCheck, 'followUp'> & { followUp: string | null })[] = [];
  for (const { followUp, ...rest } of postDeployChecks(work, release, now, await patternProjections(work, patterns))) {
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
    ...(deps.file ? { file: deps.file } : {}),
  };
}
