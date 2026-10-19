import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { implementerIdentities, postDeployProofPrefix, postDeployProofs, type Create, type Work } from './model.js';
import { observationWindowFor, postDeployFollowUpId, postDeployMarker, type PatternProjection, type PatternProjections, type PatternReader } from './model/observation-window.js';
import { evidenceProves } from './model/mechanical-proofs.js';
import type { MasterConfig } from './master.js';
import { repositoryFromRemote } from './onboarding.js';

/**
 * The observed release's own post-deploy checks (GY-1732): an isolated clean checkout of exactly the
 * serving commit decides them, so the loop's readings (src/daemon/cycle-readings.ts) never rest on a
 * coordinator checkout at another commit. Per-item deployment verification is gone (GY-1981).
 */

/** The release identity of a CLI checkout, and the repository it is a checkout of. */
export interface InstructionRelease { sha: string | null; clean: boolean; repository: string | null; reason: string | null }
export const emitsManagedInstructions = (release: InstructionRelease, repository?: string) => !repository || !release.repository || release.repository.toLowerCase() === repository.toLowerCase();
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
 * An isolated clean checkout of exactly the observed release, whose CLI decides the post-deploy
 * checks (GY-1732): their identity, text and observation window are that release's, never the
 * coordinator checkout's.
 */
export interface IsolatedRelease { release: InstructionRelease; checks?: PostDeployFiler; dispose: () => Promise<void> }

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
    return { release, checks: releaseChecks(cliPath, run), dispose };
  } catch (error) { await dispose(); return { reason: `Could not check out deployed release ${sha} in isolation: ${message(error)}` }; }
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
 * The filer for the observed release `sha` (GY-1732): the coordinator checkout's own code at that commit (or of
 * another repository, or with no commit); otherwise the release's isolated checkout, disposed by the caller; or the reason it cannot be had,
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
 * The check of a delivered item's declared post-deploy criteria (GY-1660)
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
      description: `${postDeployMarker}${requestId}\n\n${work.key} was delivered with ${criterion.id} declared a post-deploy verification (${proof}). the post-deploy check found no trusted passing ${proof} observation on the serving release ${release}, so this item owes it: observe the outcome on that release and record the proof.${observationWindow ? `\n\nObservation window: the reading can first exist at ${observationWindow.notBefore} — ${observationWindow.detail}. The item is not dispatched before then.` : ''}\n\n${work.key} ${criterion.id}: ${criterion.text}`.slice(0, 20000),
      criteria: [{ id: 'AC-1', text, proofs: [`manual:${name.replace(/\//g, '-')}-on-serving-release`] }], ...(observationWindow ? { observationWindow } : {}) } } };
  }));
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
