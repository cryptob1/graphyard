import { execFileSync } from 'node:child_process';
import { createSign, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { accountLaunch, acknowledgeLaunch, acknowledgementMs, agentLaunchPlan, allocateManagedCheckout, assertOutsideWorktrees, atomicPrivateWrite, autonomousSession, createdHerdrTab, deliverPrompt, herdrJson, loadMasterConfig, markReprompted, neverStarted, onSelectedSession, prepareSessionHarness, privateFile, profileAtLimit, profileConcurrency, profileSessions, readSessionScreen, reviewerIdentitySchema, reviewerProfileSchema, closeHerdrPane, selectAccount, sessionActivity, sessionAgentName, settleCheckout, settlementDue, settlementReason, sharedGitDirectory, startAgentSession, stopCreatedHerdrTab, writeFailure, type HerdrAgent, type PromptDelivery, type StartBounds, type MasterConfig, type RequestDelivery, type ReviewerIdentity, type ReviewerProfile } from './master.js';
import type { FleetProbe } from './fleet.js';
import type { Work } from './model.js';
import { removeSessionCheckout, type FilesystemProbe, type SessionCheckout } from './install/worktree-root.js';
import { liveReviewRequest } from './model/dispatch.js';

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i);
export const reviewerCredentialSchema = z.object({
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  slug: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  privateKey: z.string().min(64).max(20_000),
}).strict();
export type ReviewerCredential = z.infer<typeof reviewerCredentialSchema>;

export const reviewRecordSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1).max(40),
  pr: z.number().int().positive(),
  sha: sha40, baseSha: sha40, policyRevision: z.number().int().nonnegative(),
  /** The Herdr session name: the profile's fixed agent name, or one derived per request when the profile runs several sessions (GY-107, sessionAgentName). */
  profile: z.string().min(1).max(80), agentName: z.string().min(1).max(120),
  pane: z.string().min(1).max(200).nullable(), sessionDirectory: z.string().min(1),
  requestedAt: z.string().min(1).max(40), tokenExpiresAt: z.string().min(1).max(40),
  // The control plane's review request this session answers (autoDispatch.review.id); a launch
  // by hand records none. One session per request id is what makes automatic dispatch idempotent.
  requestId: z.string().min(1).max(64).optional(),
  /** Which launch for the request this is: a failed or expired session is relaunched as the next attempt. */
  attempt: z.number().int().min(1).max(50).optional(),
  state: z.enum(['pending', 'completed', 'expired', 'cancelled', 'failed']),
  /** When Herdr first reported the session finished or blocked without a verdict. */
  idleSince: z.string().min(1).max(40).optional(),
  /** How the request reached the session: on its command line, or as a paste for a runtime without that contract (GY-93). */
  delivery: z.enum(['request', 'paste']).optional(),
  /** Acknowledgement of the request, judged by the loop (acknowledgeLaunch): when sustained activity was seen, when it was re-prompted once, and the observation window. */
  acknowledgedAt: z.string().min(1).max(40).optional(),
  repromptedAt: z.string().min(1).max(40).optional(),
  activeSince: z.string().min(1).max(40).optional(),
  screen: z.string().min(1).max(64).optional(),
  verdict: z.object({ state: z.string().min(1).max(40), reviewer: z.string().min(1).max(100), reviewId: z.number().int().positive(), submittedAt: z.string().min(1).max(40) }).optional(),
  closedAt: z.string().min(1).max(40).optional(),
  closeFailure: z.string().min(1).max(500).optional(),
  /** Why a session ended without a verdict: the head it was reviewing is no longer the candidate, or it stopped without one. */
  resolution: z.string().min(1).max(900).optional(),
  /** The session directory under the managed worktree root; removed when the session resolves. */
  checkout: z.string().min(1).max(1200).optional(),
  /** Why the checkout could not be removed at settlement; the reclaim pass takes it back. */
  checkoutFailure: z.string().min(1).max(500).optional(),
  /**
   * The launch that reserved this record has not yet confirmed its runtime started (GY-124). A
   * session is recorded before its runtime starts, so no session can review without a record;
   * the launcher fills in the pane and clears this once the runtime is up, or removes the record
   * when nothing was started.
   */
  launching: z.literal(true).optional(),
}).strict();
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export const reviewLedgerSchema = z.object({ version: z.literal(1), reviews: z.array(reviewRecordSchema).max(200).default([]) }).strict();
export type ReviewLedger = z.infer<typeof reviewLedgerSchema>;

const ledgerFile = (root: string) => resolve(root, '.graphyard/reviews.json');
export async function readReviewLedger(root: string): Promise<ReviewLedger> {
  const file = ledgerFile(root);
  try { await privateFile(file); return reviewLedgerSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return { version: 1, reviews: [] }; }
}
export const saveReviewLedger = (root: string, ledger: ReviewLedger) => atomicPrivateWrite(ledgerFile(root), reviewLedgerSchema.parse(ledger));

/**
 * Every launcher runs in its own process — the loop's dispatch tick, a stateless executor's
 * request-review handler, the daemon's failover relaunch, `master review` — and each used to read
 * the ledger, decide the request had no session, start one, and write the ledger back from its
 * own read. Two of them in the same few seconds both found no session, both started one, and the
 * later write dropped the earlier record (GY-124). Every read-modify-write of the ledger now holds
 * this lock, so the check that a request has no session and the record that reserves it are one
 * step no other launcher can interleave with.
 */
const ledgerLockFile = (root: string) => `${ledgerFile(root)}.lock`;
/** A holder that has not released the lock in this long is dead or wedged; its lock is broken. */
export const reviewLedgerLockStaleMs = 60_000;
const lockWaitMs = 30_000;
async function acquireLedgerLock(root: string) {
  const file = ledgerLockFile(root);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const { open, readFile: read, unlink } = await import('node:fs/promises');
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(`${process.pid} ${Date.now()}`); await handle.close(); return; }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const [pid, at] = (await read(file, 'utf8').catch(() => '')).split(' ').map(Number);
    let alive = true;
    try { if (pid) process.kill(pid, 0); } catch (error: any) { alive = error.code !== 'ESRCH'; }
    if (!alive || Number.isFinite(at) && Date.now() - at > reviewLedgerLockStaleMs) { await unlink(file).catch(() => {}); continue; }
    if (Date.now() > deadline) throw new Error(`The review ledger lock ${file} is held by process ${pid || 'unknown'}; another reviewer launch or reconciliation is in progress`);
    await new Promise(done => setTimeout(done, 20 + Math.random() * 30));
  }
}
/** Read the ledger under the lock, apply one change, and write it back before the lock is released. */
export async function updateReviewLedger<T>(root: string, change: (ledger: ReviewLedger) => T | Promise<T>): Promise<T> {
  await acquireLedgerLock(root);
  try {
    const ledger = await readReviewLedger(root);
    const result = await change(ledger);
    await saveReviewLedger(root, ledger);
    return result;
  } finally { await rm(ledgerLockFile(root), { force: true }); }
}
/**
 * Write back the records one pass changed, onto the ledger as it stands now. A pass that read the
 * ledger, spent seconds on GitHub and Herdr, and saved its whole copy would drop every record a
 * launcher reserved in the meantime; only what this pass changed is taken from its copy.
 */
async function saveChangedRecords(root: string, mine: ReviewRecord[], before: Map<string, string>) {
  const changed = new Map(mine.filter(record => JSON.stringify(record) !== before.get(record.id)).map(record => [record.id, record]));
  if (!changed.size) return;
  await updateReviewLedger(root, ledger => { ledger.reviews = ledger.reviews.map(record => changed.get(record.id) ?? record); });
}

/** A reservation whose launcher never confirmed the runtime within this long died mid-launch. */
export const reviewLaunchReservationMs = 10 * 60_000;

/**
 * The Herdr session already serving this request, when there is one: a session a record of the
 * request names, or one whose name a multi-session profile derives from the request id. A fixed
 * name is attributed through the record, since the name alone says nothing about which request.
 */
export function requestSessionInHerdr(records: Pick<ReviewRecord, 'key' | 'sha' | 'requestId' | 'agentName' | 'state' | 'closeFailure'>[], agents: { name?: string }[], profiles: { agentName: string; concurrency?: number }[], request: { key: string; sha: string; requestId?: string }): string | null {
  const visible = new Set(agents.map(agent => agent.name).filter((name): name is string => !!name));
  // A settled record whose pane was closed no longer owns its name: a fixed name visible now is another session's.
  const recorded = records.find(record => (record.state === 'pending' || !!record.closeFailure) && (request.requestId ? record.requestId === request.requestId : record.key === request.key && record.sha === request.sha) && visible.has(record.agentName));
  if (recorded) return recorded.agentName;
  if (!request.requestId) return null;
  for (const profile of profiles) {
    if (profileConcurrency(profile) === 1) continue;
    for (let attempt = 1; attempt <= 50; attempt++) {
      const name = sessionAgentName(profile, { id: request.requestId, requestId: request.requestId, attempt });
      if (visible.has(name)) return name;
    }
  }
  return null;
}

// Reviewer credentials live beside the coordinator credential, outside every worktree.
export function reviewerCredentialDirectory(config?: Pick<MasterConfig, 'credentialFile'>, input?: string) {
  if (input) return resolve(input);
  return config ? resolve(config.credentialFile, '../..', 'reviewers') : resolve(process.env.GRAPHYARD_CONFIG_HOME ?? resolve(homedir(), '.config/graphyard'), 'reviewers');
}
export async function readReviewerCredential(root: string, file: string): Promise<ReviewerCredential> {
  await privateFile(file);
  await assertOutsideWorktrees(root, file, 'Reviewer credential file');
  return reviewerCredentialSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

function assertReviewerKey(privateKey: string) {
  if (!/^-----BEGIN (RSA )?PRIVATE KEY-----/m.test(privateKey)) throw new Error('The reviewer App private key must be the PEM GitHub issued for that App');
  try { createSign('RSA-SHA256').update('graphyard').sign(privateKey); }
  catch { throw new Error('The reviewer App private key is not a usable RSA key'); }
}
export function appJwt(appId: number, privateKey: string, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issued - 60, exp: issued + 540, iss: String(appId) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}

// The reviewer session receives an installation token scoped to one repository and to the two
// permissions a review needs. GitHub caps installation tokens at one hour; anything longer,
// broader, or able to write code is refused before it reaches a session.
export async function mintReviewerToken(credential: ReviewerCredential, repository: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (credential.repository.toLowerCase() !== repository.toLowerCase()) throw new Error('The stored reviewer identity belongs to another repository; rerun master reviewer setup');
  assertReviewerKey(credential.privateKey);
  const response = await fetcher(`https://api.github.com/app/installations/${credential.installationId}/access_tokens`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${appJwt(credential.appId, credential.privateKey, now)}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ repositories: [repository.split('/')[1]], permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }),
  });
  if (!response.ok) throw new Error(`The reviewer App could not mint an installation token (${response.status}); check the App installation and its private key`);
  const result: any = await response.json();
  const expires = Date.parse(result?.expires_at);
  if (typeof result?.token !== 'string' || result.token.length < 20) throw new Error('GitHub returned no reviewer installation token');
  if (!Number.isFinite(expires) || expires <= now || expires > now + 3_600_000 + 60_000) throw new Error('GitHub returned a reviewer token without a short expiry; refusing to launch a review with it');
  const permissions: Record<string, string> = result.permissions && typeof result.permissions === 'object' ? result.permissions : {};
  if (permissions.contents === 'write' || permissions.administration || permissions.checks === 'write' || permissions.workflows) throw new Error('The reviewer App can write code, checks, or administration; a reviewer identity must not. Reinstall it with metadata read, contents read, and pull requests write only');
  if (permissions.pull_requests !== 'write') throw new Error('The reviewer App cannot post a review; grant it Pull requests: write');
  return { token: result.token as string, expiresAt: new Date(expires).toISOString(), permissions };
}

export async function bindReviewer(root: string, input: { appId: number; installationId: number; slug: string; privateKey: string; credentialDirectory?: string },
  verify: (credential: ReviewerCredential) => Promise<{ repository: string; permissions: Record<string, string> }>) {
  const config = await loadMasterConfig(root);
  if (input.appId === config.githubAppId) throw new Error('The reviewer App must be a different GitHub App from the Graphyard control-plane App; an identity cannot independently review the work it gates');
  assertReviewerKey(input.privateKey);
  const candidate = reviewerCredentialSchema.parse({ appId: input.appId, installationId: input.installationId, slug: input.slug, repository: config.repository, privateKey: input.privateKey });
  const observed = await verify(candidate);
  if (observed.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('The reviewer App installation does not cover the managed repository');
  if (observed.permissions.contents === 'write' || observed.permissions.administration || observed.permissions.checks === 'write') throw new Error('The reviewer App installation can write code, checks, or administration; a reviewer identity must not');
  const requested = reviewerCredentialDirectory(config, input.credentialDirectory);
  if (requested === resolve(root) || requested.startsWith(`${resolve(root)}/`)) throw new Error('Reviewer credentials must be stored outside the managed repository');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const directory = await realpath(requested);
  await assertOutsideWorktrees(root, directory, 'Reviewer credential directory');
  const credentialFile = resolve(directory, `${config.repository.replace('/', '-')}-${input.appId}.json`);
  await atomicPrivateWrite(credentialFile, candidate);
  const reviewer: ReviewerIdentity = reviewerIdentitySchema.parse({ appId: input.appId, installationId: input.installationId, slug: input.slug, credentialFile, boundAt: new Date().toISOString() });
  await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), { ...config, reviewer });
  return { reviewer: { appId: reviewer.appId, installationId: reviewer.installationId, slug: reviewer.slug, credentialFile: reviewer.credentialFile }, controlPlaneAppId: config.githubAppId,
    identity: `${reviewer.slug}[bot]`, permissions: observed.permissions, next: 'Add a reviewer profile with master reviewer add, then launch a review with master review GY-N' };
}

export async function saveReviewerProfile(root: string, profileInput: unknown) {
  const profile = reviewerProfileSchema.parse(profileInput);
  const config = await loadMasterConfig(root);
  if (config.reviewers.some(item => item.name === profile.name || item.agentName === profile.agentName)) throw new Error('Reviewer profile name and agent name must be unique');
  if (config.workers.some(item => item.agentName === profile.agentName)) throw new Error('A worker profile already uses that Herdr agent name');
  await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), { ...config, reviewers: [...config.reviewers, profile] });
  const launch = agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment);
  return { added: profile.name, agentName: profile.agentName, kind: profile.kind, reviewers: config.reviewers.length + 1, launch };
}

/** Remove a reviewer profile; an automatic-dispatch setting that named it is cleared with it. */
export async function removeReviewerProfile(root: string, name: string) {
  const config = await loadMasterConfig(root);
  const removed = config.reviewers.find(item => item.name === name);
  if (!removed) throw new Error(`Unknown reviewer profile ${name}`);
  const reviewers = config.reviewers.filter(item => item.name !== name);
  const clearedAutomatic = config.run.reviewerProfile === name;
  const run = { ...config.run }; if (clearedAutomatic) delete run.reviewerProfile;
  await atomicPrivateWrite(resolve(root, '.graphyard/master.json'), { ...config, reviewers, run });
  return { removed: name, agentName: removed.agentName, reviewers: reviewers.length, clearedAutomatic,
    automatic: run.reviewerProfile ?? (reviewers.length === 1 ? reviewers[0].name : null),
    next: reviewers.length ? 'master run adopts the change on its next tick' : 'No reviewer profile remains; review requests wait until one is added with master reviewer add' };
}

/** The file `master reviewer setup` registers the reviewer App into before it is bound. */
export const reviewerRegistrationFile = (config: Pick<MasterConfig, 'credentialFile' | 'repository'>) => resolve(reviewerCredentialDirectory(config), `${config.repository.replace('/', '-')}-registration.json`);
/**
 * A reviewer App that exists but is not the bound identity: registered by `master reviewer setup`
 * and never bound (the browser flow stopped before the installation was verified, or the bind
 * failed), or bound to a credential file that is gone. Only the App's public facts are read.
 */
export async function reviewerBindingHealth(config: Pick<MasterConfig, 'credentialFile' | 'repository' | 'reviewer'>) {
  const attention: string[] = [];
  let registered: { appId?: unknown; slug?: unknown; installationId?: unknown } | null = null;
  try { registered = JSON.parse(await readFile(reviewerRegistrationFile(config), 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') attention.push(`The reviewer App registration ${reviewerRegistrationFile(config)} is unreadable: ${error instanceof Error ? error.message : 'unknown reason'}`); }
  const app = registered && Number.isSafeInteger(registered.appId) ? { appId: registered.appId as number, slug: typeof registered.slug === 'string' ? registered.slug : null, installationId: Number.isSafeInteger(registered.installationId) ? registered.installationId as number : null } : null;
  if (app && app.appId !== config.reviewer?.appId) {
    attention.push(`Reviewer App ${app.slug ?? app.appId} (App ${app.appId}) is registered for ${config.repository} but not bound${config.reviewer ? `; the bound reviewer is App ${config.reviewer.appId}` : ''}. ${app.installationId ? 'Its installation is recorded: rerun master reviewer setup to bind it, or master reviewer bind FILE --key-stdin' : 'Install it on the repository, then rerun master reviewer setup to verify and bind it'}; until then no reviewer can be launched with it`);
  }
  if (config.reviewer) {
    try { await privateFile(config.reviewer.credentialFile); }
    catch (error: any) { attention.push(`The bound reviewer App ${config.reviewer.slug} has no usable credential at ${config.reviewer.credentialFile} (${error.code ?? (error instanceof Error ? error.message : 'unknown reason')}); rerun master reviewer bind`); }
  }
  return { registered: app, bound: config.reviewer ? { appId: config.reviewer.appId, slug: config.reviewer.slug } : null, attention };
}

// A launched reviewer reads one exact candidate. Everything a verdict is bound to is verified
// here, before a token exists: a stale or unobserved candidate never reaches a reviewer session.
export function assertReviewCandidate(work: Work, observedAt: string) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('A reviewer launch requires a valid Graphyard snapshot clock');
  if (!work.policy.review) throw new Error(`${work.key} does not require independent review`);
  const provider = work.policy.reviewProvider ?? 'github';
  if (provider !== 'github') throw new Error(`${work.key} uses the ${provider} review provider; its verdict comes from that provider, not from a launched reviewer session`);
  const candidate = work.candidate, observation = work.observation;
  if (!work.submission || !candidate) throw new Error(`${work.key} has no independently observed pull-request candidate to review`);
  if (work.reworkRequested) throw new Error(`${work.key} is awaiting rework; review the next submitted candidate`);
  if (!observation || observation.candidate.sha !== candidate.sha || observation.candidate.baseSha !== candidate.baseSha) throw new Error(`${work.key} GitHub observation does not match the current candidate`);
  const age = now - Date.parse(observation.at);
  if (!(age >= 0 && age < 120_000)) throw new Error(`${work.key} GitHub observation is missing or older than two minutes`);
  if (observation.prState === 'closed') throw new Error(`${work.key} pull request is closed`);
  if (observation.draft) throw new Error(`${work.key} pull request is still a draft`);
  // A head behind the base branch would be reviewed against a diff GitHub will later recompute,
  // and the approval dismissed with it. The worker syncs, or the queue publishes a tip that
  // contains the base; the review waits for a head that does.
  if (observation.baseTipContained === false) throw new Error(`${work.key} candidate ${candidate.sha.slice(0, 12)} does not contain the base branch tip ${observation.baseTip?.slice(0, 12) ?? ''}; a review of it would be dismissed when the merge base changes. Run graphyard sync ${work.key} and push, or wait for the merge queue to publish a tip that contains it`);
  return { key: work.key, pr: candidate.pr, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, author: candidate.author, branch: candidate.branch };
}

export type ReviewBinding = ReturnType<typeof assertReviewCandidate>;
/** `checkout` is the session directory a launch allocated under the managed worktree root, when it allocated one. */
export function reviewPrompt(config: Pick<MasterConfig, 'repository'>, binding: Pick<ReviewBinding, 'key' | 'pr' | 'sha' | 'baseSha' | 'policyRevision'>, checkout?: SessionCheckout) {
  return `You are the independent Graphyard reviewer for ${config.repository}. Review pull request #${binding.pr} at head ${binding.sha} against base ${binding.baseSha} under policy revision ${binding.policyRevision}, for work item ${binding.key}. `
    + `Read the change with: gh pr diff ${binding.pr} --repo ${config.repository}. `
    + (checkout ? `When judging the diff needs the surrounding code, read it from a detached checkout of the exact head, created only at the path Graphyard allocated for this session under its managed worktree root and never under a temporary directory: git fetch origin ${binding.sha} && git worktree add --detach ${checkout.worktree} ${binding.sha}. Read there and change nothing; Graphyard removes ${checkout.directory} when this session ends. ` : '')
    + 'This session is read-only: do not edit, stage, commit, push, rebase, or merge anything, do not run the project\'s build, tests, or servers, do not claim Graphyard work, and do not submit evidence. '
    + `Post exactly one verdict, bound to that exact commit: gh api --method POST repos/${config.repository}/pulls/${binding.pr}/reviews -f commit_id=${binding.sha} -f event=APPROVE -f body=YOUR_JUSTIFICATION (use event=REQUEST_CHANGES instead when the change is not acceptable). `
    + `Judge only whether this diff is correct, safe, and matches what ${binding.key} requires; never weaken a requirement to let it pass. `
    + `Posting that review is granted to this session's role, not a permission to request: the launch allows exactly this one call, so post it as soon as you have judged the diff, without asking for confirmation. `
    + `GH_CONFIG_DIR points at a reviewer credential that expires within the hour and can only read this repository and write reviews. `
    + `Immediately before posting, run gh pr view ${binding.pr} --repo ${config.repository} --json mergeable,mergeStateStatus,headRefOid and repeat it every 5 seconds until mergeable is no longer UNKNOWN: GitHub recomputes the merge base lazily and dismisses a verdict posted before that recompute. `
    + `If gh reports a head commit other than ${binding.sha}, stop and report that instead of reviewing a different commit. Then stop; Graphyard closes this session once it observes your verdict. `
    + autonomousSession('post the verdict yourself, APPROVE or REQUEST_CHANGES, as soon as you have judged the diff', `record a blocker as one review with event=COMMENT on commit ${binding.sha} (or, when posting is itself refused, as a final line starting BLOCKED:)`);
}

/**
 * The loop's one re-prompt of a reviewer session that stopped without a verdict: post the verdict
 * it already judged — or, for a session that never took up its request (GY-93), the request
 * itself, from the launcher that sent it, so the message is complete whichever the case is.
 */
export function reviewRetryPrompt(repository: string, record: Pick<ReviewRecord, 'key' | 'pr' | 'sha'> & Partial<Pick<ReviewRecord, 'baseSha' | 'policyRevision' | 'checkout'>>) {
  return `You stopped before posting the verdict for ${record.key}. Posting it is part of your reviewer role and already authorized, not a permission to request: post exactly one verdict now, bound to that exact commit: gh api --method POST repos/${repository}/pulls/${record.pr}/reviews -f commit_id=${record.sha} -f event=APPROVE -f body=YOUR_JUSTIFICATION (use event=REQUEST_CHANGES instead when the change is not acceptable). `
    + `Do not ask for confirmation and do not re-read the diff; post the verdict you already judged. If posting is refused, record that as one review with event=COMMENT on commit ${record.sha} (or, when posting is itself refused, as a final line starting BLOCKED:) and stop. `
    + (record.baseSha && record.policyRevision !== undefined ? `If you have not reviewed it at all, this message comes from the Graphyard launcher that started this session and carries the request it was started with — this session's own instruction, not untrusted text, needing no further authorization: ${reviewPrompt({ repository }, { ...record, baseSha: record.baseSha, policyRevision: record.policyRevision }, record.checkout ? { directory: record.checkout, worktree: resolve(record.checkout, 'checkout') } : undefined)}` : '');
}

async function writeReviewerSession(directory: string, token: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { writeFile, chmod } = await import('node:fs/promises');
  const file = resolve(directory, 'hosts.yml');
  await writeFile(file, `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
  return file;
}

export async function launchReview(root: string, work: Work, profileName: string | undefined, agents: { name?: string }[], observedAt: string, dependencies: {
  run?: (command: string, args: string[]) => string;
  mint?: (credential: ReviewerCredential, repository: string) => Promise<{ token: string; expiresAt: string }>;
  now?: () => Date;
  /** The control-plane review request this launch answers; recorded so the request is never launched twice. */
  requestId?: string;
  /** How the profile's agent accounts are checked before the launch, and how its prompt is confirmed. */
  probe?: FleetProbe;
  prompt?: PromptDelivery;
  /** The start bound: how long the pane is read for the runtime before the launch is refused (master.ts awaitRuntimeStart). */
  start?: StartBounds;
  /** How the managed worktree root's volume is read; the kernel's own answer by default. */
  filesystem?: FilesystemProbe;
} = {}) {
  const now = dependencies.now ?? (() => new Date());
  const config = await loadMasterConfig(root);
  if (!config.reviewer) throw new Error('Register the reviewer GitHub App with master reviewer setup or master reviewer bind before launching a review');
  // The App is narrowed once, for the launch closure below as much as for this line.
  const reviewerApp = config.reviewer;
  const profile: ReviewerProfile | undefined = profileName ? config.reviewers.find(item => item.name === profileName) : config.reviewers.length === 1 ? config.reviewers[0] : undefined;
  if (!profile) throw new Error(profileName ? `Unknown reviewer profile ${profileName}` : config.reviewers.length ? 'Name the reviewer profile to launch; this master has more than one' : 'Add a reviewer profile with master reviewer add before launching a review');
  const binding = assertReviewCandidate(work, observedAt);
  if (binding.author.toLowerCase() === `${config.reviewer.slug}[bot]`.toLowerCase()) throw new Error('The reviewer App authored this pull request; an identity cannot independently review its own work');
  // One request, one session (GY-124). Under the ledger lock, as one step: records for a superseded
  // head are closed, the launch is refused when the request or the candidate already has a pending
  // record or a Herdr session, and otherwise a pending record is reserved for this session before
  // anything is started, so a second launcher — in this process or another — finds it and stands down.
  const id = randomUUID();
  const sessionDirectory = resolve(dirname(reviewerApp.credentialFile), 'sessions', id);
  const reservation = await updateReviewLedger(root, async ledger => {
    // A record for a superseded head never blocks a review request for the current head: every
    // such record is closed as cancelled with the reason on the record, and this launch proceeds.
    // Only a record for the exact current candidate holds the key: one session per candidate.
    const pendings = ledger.reviews.filter(record => record.state === 'pending' && record.key === work.key);
    const current = pendings.find(pending => !staleReviewReason(pending, [work]));
    if (current) return { refusal: new Error(`A reviewer session for ${work.key} is already ${current.launching ? 'being launched' : 'pending'} on ${current.sha.slice(0, 7)} (${current.agentName}${current.requestId ? `, request ${current.requestId}` : ''}); one review request is answered by one session, so no second one is launched`) };
    for (const pending of pendings) await closeReviewSession(root, pending, { run: dependencies.run, now }, { state: 'cancelled', resolution: staleReviewReason(pending, [work])!, force: true });
    // A Herdr session already serving this request is the same launch twice, whatever the ledger says.
    const serving = requestSessionInHerdr(ledger.reviews, agents, config.reviewers, { key: work.key, sha: binding.sha, requestId: dependencies.requestId });
    if (serving) return { refusal: new Error(`Reviewer session ${serving} is already visible in Herdr for ${work.key}${dependencies.requestId ? ` review request ${dependencies.requestId}` : ` on ${binding.sha.slice(0, 7)}`}; one review request is answered by one session`) };
    // The profile's room (GY-107): one session per name, and no more sessions than it declares.
    // A name this session would take that Herdr already shows, or a launch in progress reserved,
    // is the same launch twice.
    const attempt = dependencies.requestId ? ledger.reviews.filter(entry => entry.requestId === dependencies.requestId).length + 1 : undefined;
    const agentName = sessionAgentName(profile, { id, requestId: dependencies.requestId, attempt });
    if (agents.some(agent => agent.name === agentName)) return { refusal: new Error(`Reviewer agent ${agentName} is already visible in Herdr`) };
    if (ledger.reviews.some(entry => entry.state === 'pending' && entry.launching && entry.agentName === agentName)) return { refusal: new Error(`Reviewer agent ${agentName} is already being launched for another request`) };
    const sessions = profileSessions(profile, agents, ledger.reviews);
    if (!sessions.free) return { refusal: new Error(profileAtLimit('Reviewer', profile, sessions)) };
    const requestedAt = now().toISOString();
    const record: ReviewRecord = reviewRecordSchema.parse({ id, key: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision,
      profile: profile.name, agentName, pane: null, sessionDirectory, requestedAt, tokenExpiresAt: new Date(Date.parse(requestedAt) + 3_600_000).toISOString(), state: 'pending', launching: true,
      ...(dependencies.requestId ? { requestId: dependencies.requestId, attempt } : {}) });
    ledger.reviews.push(record);
    return { record };
  });
  if ('refusal' in reservation) throw reservation.refusal;
  const { agentName } = reservation.record;
  // A launch that never became a session gives its reservation back; one whose tab Herdr could
  // not confirm closed keeps it, settled as failed with the reason, so the session it may have
  // left behind is still on the record.
  let startedTab = false;
  const release = (error: unknown) => updateReviewLedger(root, ledger => {
    const reason = error instanceof Error ? error.message : String(error);
    ledger.reviews = startedTab && /could not confirm cleanup/.test(reason)
      ? ledger.reviews.map(entry => entry.id === id ? { ...entry, state: 'failed' as const, launching: undefined, closedAt: now().toISOString(), resolution: `the launch failed: ${reason}`.slice(0, 900), closeFailure: reason.slice(0, 500) } : entry)
      : ledger.reviews.filter(entry => entry.id !== id);
  }).catch(() => { /* a reservation that cannot be given back is failed by reconciliation once it is stale */ });
  try {
    // Before a token is minted: an exhausted or logged-out account is skipped for the profile's next.
    const selected = await selectAccount(config, 'reviewer', profile, { ...dependencies.probe, work: work.key });
    // Everything past the choice can fail; the session it chose is given back at once when it does.
    return await onSelectedSession(selected, `reviewer launch for ${work.key} failed`, async () => {
      const credential = await readReviewerCredential(root, reviewerApp.credentialFile);
      if (credential.appId !== reviewerApp.appId || credential.installationId !== reviewerApp.installationId || credential.slug !== reviewerApp.slug) throw new Error('The stored reviewer credential does not match the recorded reviewer identity; rerun master reviewer bind');
      if (credential.appId === config.githubAppId) throw new Error('The reviewer App must be a different GitHub App from the Graphyard control-plane App');
      const mint = dependencies.mint ?? ((value: ReviewerCredential, repository: string) => mintReviewerToken(value, repository));
      // Before a token exists: the one place this session may check the head out, under the managed
      // worktree root — durable storage with room left, outside every worktree.
      const checkout = await allocateManagedCheckout(root, config, 'review', binding.key, binding.sha, id, dependencies.filesystem);
      const discard = () => removeSessionCheckout(root, dirname(checkout.directory), checkout.directory).catch(() => {});
      let minted: { token: string; expiresAt: string };
      try { minted = await mint(credential, config.repository); await writeReviewerSession(sessionDirectory, minted.token); }
      catch (error) { await discard(); throw error; }
      const launch = accountLaunch(profile, selected.account, { writable: [checkout.directory, sharedGitDirectory(root)].filter((path): path is string => !!path) });
      let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
      try {
        // The reviewer loads its own role rules, never the master's: it may post this one verdict.
        // The harness follows the account's runtime, so a cross-runtime failover keeps its role rules.
        const harness = await prepareSessionHarness(root, config, { role: 'reviewer', kind: launch.kind, profile: profile.name, pr: binding.pr, checkout: checkout.worktree });
        const environment = { ...launch.environment, GH_CONFIG_DIR: sessionDirectory, GRAPHYARD_REVIEW: `${binding.key}@${binding.sha}` };
        startedTab = true;
        const created = createdHerdrTab(herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root,
          '--label', `${binding.key} review · ${agentName}`, ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--no-focus'], dependencies.run));
        pane = created.pane; tabId = created.tab;
        // The request is the session's own first message, on the runtime's command line (GY-93), read
        // from the request file in the session's checkout so the typed line stays short (GY-121).
        ({ delivery } = startAgentSession(agentName, launch.kind!, created.pane, [...launch.args, ...harness.args], reviewPrompt(config, binding, checkout), dependencies.run, { ...dependencies.prompt, ...dependencies.start, directory: checkout.directory, role: harness.role }));
      } catch (error) {
        // A launch that never became a session leaves no checkout behind.
        await discard();
        const malformedTab = (error as any)?.herdrTab as string | undefined;
        if (pane || tabId || malformedTab) try { stopCreatedHerdrTab(pane, tabId ?? malformedTab, dependencies.run); }
          catch { await rm(sessionDirectory, { recursive: true, force: true }); throw new Error(`${error instanceof Error ? error.message : 'Reviewer launch failed'}; Herdr could not confirm cleanup, so the reviewer credential directory was removed and the token will expire at ${minted.expiresAt}`); }
        await rm(sessionDirectory, { recursive: true, force: true });
        // A launch that failed for want of room says so, with the path and the reclaim command.
        throw writeFailure(error, `Launching the ${binding.key} reviewer session (${String((error as Error)?.message ?? error).split('\n')[0]})`, checkout.directory);
      }
      // The runtime is up: the reserved record takes the pane, the token's real expiry and the delivery.
      const record = await updateReviewLedger(root, ledger => {
        const index = ledger.reviews.findIndex(entry => entry.id === id);
        const { launching: _launching, ...reserved } = index >= 0 ? ledger.reviews[index] : reservation.record;
        const settled: ReviewRecord = reviewRecordSchema.parse({ ...reserved, pane: pane ?? null, tokenExpiresAt: minted.expiresAt, delivery, checkout: checkout.directory });
        if (index >= 0) ledger.reviews[index] = settled; else ledger.reviews.push(settled);
        return settled;
      });
      return { review: record.id, requestId: record.requestId ?? null, work: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision, profile: profile.name, agentName,
        pane: record.pane, checkout: checkout.directory, reviewer: `${reviewerApp.slug}[bot]`, tokenExpiresAt: minted.expiresAt, approvals: launch.plan.approvals, delivery,
        account: selected.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null,
        recorded: 'the request is recorded; master status reconciles the verdict and closes the session' };
    });
  } catch (error) { await release(error); throw error; }
}

/**
 * `master review GY-N [PROFILE]`: launch the bound reviewer on the item's exact current candidate.
 *
 * The launch answers the control plane's own open request for that head, as the loop's would, and
 * is recorded as that request's next attempt. That is what forces a further attempt for a request
 * whose session already settled without satisfying the review gate — a dismissed approval, a
 * reviewer that stopped — which no automatic relaunch follows. A head with no open request (the
 * recovery path for a launch the loop refused) records none.
 */
export async function reviewCommand(root: string, args: string[], snapshot: { work: Work[]; now: string }, agents: { name?: string }[], dependencies: Parameters<typeof launchReview>[5] = {}) {
  if (!args[0]) throw new Error('Use master review GY-N [PROFILE]');
  const work = snapshot.work.find(item => item.id === args[0] || item.key === args[0]);
  if (!work) throw new Error(`Unknown work item ${args[0]}`);
  const request = liveReviewRequest(work);
  return launchReview(root, work, args[1], agents, snapshot.now, { ...dependencies, ...(request ? { requestId: request.id } : {}) });
}

const reviewStates = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'];
/**
 * The reviewer identity's latest verdict on this session's exact head, ignoring the verdicts an
 * earlier session of the same head already recorded. Without that, a relaunch after a dismissal
 * would read the dismissed review back as its own answer the moment it started and burn every
 * remaining attempt on a verdict GitHub had already withdrawn.
 */
export function observeReviewVerdict(repository: string, record: ReviewRecord, reviewer: string, run: (command: string, args: string[]) => string, answered: Set<number> = new Set()) {
  const reviews = JSON.parse(run('gh', ['api', '--paginate', `repos/${repository}/pulls/${record.pr}/reviews`]));
  if (!Array.isArray(reviews)) throw new Error('GitHub did not return a review list for the pending reviewer session');
  const match = reviews.filter((review: any) => review?.commit_id === record.sha && typeof review?.user?.login === 'string' && review.user.login.toLowerCase() === reviewer.toLowerCase() && reviewStates.includes(review?.state) && !answered.has(Number(review?.id))).at(-1);
  return match ? { state: String(match.state), reviewer, reviewId: Number(match.id), submittedAt: String(match.submitted_at ?? new Date().toISOString()) } : null;
}

/**
 * A dismissal is GitHub withdrawing a verdict, never the reviewer giving one: the review gate
 * still refuses, so the session that collected it answered nothing. This is the resolution such
 * a session is recorded unanswered with, and it distinguishes the two causes, because they need
 * different heads. `dismiss_stale_reviews` dismisses an approval when the head it was bound to is
 * replaced, and the review the control plane then wants is of the new head. A dismissal while the
 * candidate is unchanged — a recomputed merge base, a dismissal by hand — leaves the same commit
 * needing the same review, and demanding a new head for it would cost a rework round for a
 * candidate nobody found fault with.
 */
export function dismissalResolution(record: Pick<ReviewRecord, 'key' | 'sha' | 'baseSha' | 'policyRevision'>, work: Work[] | undefined): string {
  const moved = staleReviewReason(record, work);
  return moved
    ? `the approval of ${record.sha.slice(0, 12)} was dismissed and ${moved}; the request for the current head is answered afresh`
    : `the approval of ${record.sha.slice(0, 12)} was dismissed while it was still the candidate; the same commit is reviewed again`;
}

/**
 * Why a pending session no longer reviews the candidate: the head it was launched for was
 * replaced, or the item left review altogether. The session is closed and its token withdrawn;
 * a verdict it managed to post for the old head settles nothing the record does not already say.
 */
/** A session Herdr reports finished or blocked is given this long to post its verdict before it is recorded as failed. */
export const reviewIdleGraceMs = 5 * 60_000;

export function staleReviewReason(record: Pick<ReviewRecord, 'key' | 'sha' | 'baseSha' | 'policyRevision'>, work: Work[] | undefined): string | null {
  const item = work?.find(candidate => candidate.key === record.key);
  if (!item) return null;
  if (item.stage === 'done' || item.observation?.merged) return 'the work is delivered';
  if (item.reworkRequested) return 'rework was requested for the item';
  if (!item.submission || !item.candidate) return 'the item no longer has a submitted candidate';
  if (item.candidate.sha !== record.sha) return `head changed from ${record.sha.slice(0, 12)} to ${item.candidate.sha.slice(0, 12)}`;
  if (item.candidate.baseSha !== record.baseSha) return `base changed from ${record.baseSha.slice(0, 12)} to ${item.candidate.baseSha.slice(0, 12)}`;
  if (item.policyRevision !== record.policyRevision) return `policy revision changed from ${record.policyRevision} to ${item.policyRevision}`;
  return null;
}

/**
 * Settle one record: close its pane, withdraw the session credential, and record the outcome.
 * A record whose pane Herdr could not close stays pending, so the close is retried, unless
 * `force` applies: a posted verdict, or a head the candidate has replaced, settles the record
 * even when that confirmation fails — such a session decides nothing further for the candidate —
 * with the close failure kept on the record as attention. The credential is withdrawn on every
 * path that settles the record: nothing revisits a settled record, so a session directory left
 * behind there would never be removed at all, while a record that stays pending is retried.
 */
async function closeReviewSession(root: string, record: ReviewRecord, dependencies: { run?: (command: string, args: string[]) => string; now: () => Date }, options: { state: ReviewRecord['state']; resolution?: string; force?: boolean }) {
  let closeFailure: string | undefined;
  try { if (record.pane) closeHerdrPane(record.pane, dependencies.run); }
  catch (error) { closeFailure = `Herdr could not close pane ${record.pane}: ${error instanceof Error ? error.message : 'unknown reason'}`; }
  if (!closeFailure || options.force) {
    try { await rm(record.sessionDirectory, { recursive: true, force: true }); }
    catch (error) { closeFailure = `${closeFailure ? `${closeFailure}; ` : ''}the reviewer credential directory ${record.sessionDirectory} could not be removed: ${error instanceof Error ? error.message : 'unknown reason'}`; }
  }
  record.closeFailure = closeFailure;
  if (!closeFailure || options.force) {
    // The session decides nothing further, so its checkout under the managed worktree root goes
    // with it — whatever the outcome. One that cannot be removed is said so on the record and
    // taken back by the next reclaim pass.
    const failure = await settleCheckout(root, record.checkout);
    if (failure) record.checkoutFailure = failure; else delete record.checkoutFailure;
    record.state = options.state; record.closedAt = dependencies.now().toISOString();
    if (options.resolution) record.resolution = options.resolution;
  }
  return closeFailure;
}

// A session is reported closed only once Herdr confirms the pane is gone — except that a posted
// verdict, and a superseded head, settle the record even when that confirmation fails, and the
// credential directory is removed either way (see closeReviewSession). Given the current work
// snapshot, a session whose head is no longer the candidate is cancelled the same way, with the
// reason on the record.
export async function reconcileReviews(root: string, config: MasterConfig, dependencies: {
  run?: (command: string, args: string[]) => string;
  /** `answered` holds the verdict ids an earlier session of the same head already recorded. */
  observe?: (record: ReviewRecord, reviewer: string, answered: Set<number>) => { state: string; reviewer: string; reviewId: number; submittedAt: string } | null;
  now?: () => Date;
  work?: Work[];
  /** Herdr's agent list; null when Herdr could not be read, when a session is never judged finished. */
  agents?: HerdrAgent[] | null;
  /** Retries a session that stopped without a verdict; the default prompts it in Herdr. */
  retry?: (record: ReviewRecord, message: string) => void;
} = {}) {
  const ledger = await readReviewLedger(root);
  if (!config.reviewer) return { reviews: ledger.reviews, changed: 0 };
  const before = new Map(ledger.reviews.map(record => [record.id, JSON.stringify(record)]));
  const reviewer = `${config.reviewer.slug}[bot]`;
  const observe = dependencies.observe ?? ((record: ReviewRecord, identity: string, answered: Set<number>) => observeReviewVerdict(config.repository, record, identity, dependencies.run ?? ((command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), answered));
  const now = (dependencies.now ?? (() => new Date()))();
  // The retry goes through the same confirmed delivery as the launch: a prompt the stopped
  // session never visibly accepts throws, and the grace period records it failed as before.
  const retry = dependencies.retry ?? ((record: ReviewRecord, message: string) => { deliverPrompt(record.agentName, message, dependencies.run); });
  const ackMs = acknowledgementMs(config);
  let changed = 0;
  for (const record of ledger.reviews) {
    if (record.state !== 'pending') continue;
    // A reservation whose launcher is still starting the runtime is not a session yet; one that
    // never confirmed within the bound belongs to a launcher that died mid-launch.
    if (record.launching) {
      if (now.getTime() - Date.parse(record.requestedAt) < reviewLaunchReservationMs) continue;
      delete record.launching;
      await closeReviewSession(root, record, { run: dependencies.run, now: () => now }, { state: 'failed', resolution: `the launch reserved at ${record.requestedAt} never confirmed its runtime started`, force: true });
      changed++;
      continue;
    }
    const answered = new Set(ledger.reviews.filter(entry => entry.id !== record.id && entry.key === record.key && entry.sha === record.sha && entry.verdict).map(entry => entry.verdict!.reviewId));
    const verdict = record.verdict ?? observe(record, reviewer, answered) ?? undefined;
    // A dismissed approval is not an answer: the session is recorded unanswered, with the
    // dismissal and its cause, so the request is relaunched exactly as any other unanswered
    // session is rather than settling a request the review gate still refuses.
    const dismissed = verdict?.state === 'DISMISSED' ? dismissalResolution(record, dependencies.work) : null;
    const expired = !verdict && Date.parse(record.tokenExpiresAt) <= now.getTime();
    const stale = verdict ? null : staleReviewReason(record, dependencies.work);
    // A session that finished, vanished or sits blocked without a verdict is retried where it
    // stopped: the loop itself prompts it once to post the verdict it already judged, so the
    // master never has to. One still without a verdict after a grace period is recorded as
    // failed, and the request relaunched as its next attempt. That one prompt is also the
    // re-prompt of a session that never took up its request (GY-93): it carries the request, and
    // a session still unacknowledged when the grace ends is recorded as never started — but not
    // before a whole acknowledgement interval has followed the re-prompt (settlementDue), since
    // the interval is configured and the grace is not.
    let failed: string | null = null;
    if (!verdict && !expired && !stale && dependencies.agents) {
      const agent = dependencies.agents.find(candidate => candidate.name === record.agentName);
      const screen = () => readSessionScreen(record.agentName, dependencies.run);
      const judged = acknowledgeLaunch(record, agent, { now: now.getTime(), ackMs, result: false, screen });
      if (judged.changed) changed++;
      if (!agent || ['done', 'idle', 'blocked'].includes(agent.agent_status ?? '')) {
        if (!record.idleSince) {
          record.idleSince = now.toISOString(); changed++;
          if (agent && !record.repromptedAt) markReprompted(record, now.getTime());
          try { retry(record, reviewRetryPrompt(config.repository, record)); }
          catch { /* the grace period records the session as failed when the prompt cannot reach it */ }
        }
        else if (now.getTime() - Date.parse(record.idleSince) >= reviewIdleGraceMs && settlementDue(record, agent, { now: now.getTime(), ackMs })) failed = settlementReason(record, agent, { now: now.getTime(), ackMs, screen }, agent?.agent_status === 'blocked'
          ? `the reviewer session ended waiting on input (Herdr reports it blocked) instead of deciding on its own, without a verdict on ${record.sha.slice(0, 12)}`
          : `the reviewer session finished (${agent?.agent_status ?? 'gone from Herdr'}) without posting a verdict on ${record.sha.slice(0, 12)}`);
      } else if (record.idleSince) { delete record.idleSince; changed++; }
    }
    if (verdict && !record.acknowledgedAt) { record.acknowledgedAt = now.toISOString(); changed++; }
    if (!verdict && !expired && !stale && !failed) continue;
    if (verdict) record.verdict = verdict;
    if (dismissed) await closeReviewSession(root, record, { run: dependencies.run, now: () => now }, { state: 'failed', resolution: dismissed, force: true });
    else if (verdict) await closeReviewSession(root, record, { run: dependencies.run, now: () => now }, { state: 'completed', force: true });
    else if (stale) await closeReviewSession(root, record, { run: dependencies.run, now: () => now }, { state: 'cancelled', resolution: stale, force: true });
    else await closeReviewSession(root, record, { run: dependencies.run, now: () => now }, { state: failed ? 'failed' : 'expired', resolution: failed ?? `the reviewer token expired at ${record.tokenExpiresAt} without a verdict on ${record.sha.slice(0, 12)}` });
    changed++;
  }
  // An approval recorded as a session's verdict can be withdrawn after that session closed: a push
  // or a recomputed merge base dismisses it, the review gate refuses again, and nothing revisits a
  // settled record. A closed session carrying the approval the control plane is still waiting for
  // on this exact head is therefore re-read, and a dismissal reopens it as an unanswered session,
  // so the request is relaunched instead of waiting on a verdict that no longer exists.
  for (const record of ledger.reviews) {
    if (record.state !== 'completed' || record.verdict?.state !== 'APPROVED') continue;
    const request = dependencies.work?.find(item => item.key === record.key)?.autoDispatch?.review;
    if (!request || request.state !== 'requested' || request.sha !== record.sha || request.baseSha !== record.baseSha || request.policyRevision !== record.policyRevision) continue;
    if (observe(record, reviewer, new Set())?.state !== 'DISMISSED') continue;
    record.verdict = { ...record.verdict, state: 'DISMISSED' };
    record.state = 'failed'; record.resolution = dismissalResolution(record, dependencies.work); record.closedAt = now.toISOString();
    changed++;
  }
  if (changed) await saveChangedRecords(root, ledger.reviews, before);
  return { reviews: changed ? (await readReviewLedger(root)).reviews : ledger.reviews, changed };
}

export function summarizeReviews(records: ReviewRecord[]) {
  const describe = (record: ReviewRecord) => ({ review: record.id, requestId: record.requestId ?? null, attempt: record.attempt ?? 1, work: record.key, pr: record.pr, sha: record.sha, policyRevision: record.policyRevision, profile: record.profile, agentName: record.agentName,
    state: record.state, verdict: record.verdict?.state ?? null, requestedAt: record.requestedAt, tokenExpiresAt: record.tokenExpiresAt, closedAt: record.closedAt ?? null, resolution: record.resolution ?? null, attention: record.closeFailure ?? null,
    // GY-93: how the request reached the session, and whether the session has taken it up.
    delivery: record.delivery ?? null, activity: record.state === 'pending' ? sessionActivity(record) : null, acknowledgedAt: record.acknowledgedAt ?? null, repromptedAt: record.repromptedAt ?? null, neverStarted: neverStarted(record) });
  return { pending: records.filter(record => record.state === 'pending').map(describe), completed: records.filter(record => record.state !== 'pending').slice(-20).map(describe) };
}

// Independent confirmation that the App is installed on the managed repository, using a token
// minted the same way a review session's token is minted.
export async function verifyReviewerInstallation(credential: ReviewerCredential, fetcher: typeof fetch = fetch) {
  const minted = await mintReviewerToken(credential, credential.repository, fetcher);
  const response = await fetcher('https://api.github.com/installation/repositories?per_page=100', { headers: { Authorization: `Bearer ${minted.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The reviewer installation could not list its repositories (${response.status})`);
  const body: any = await response.json();
  const match = (Array.isArray(body?.repositories) ? body.repositories : []).find((entry: any) => String(entry?.full_name).toLowerCase() === credential.repository.toLowerCase());
  if (!match) throw new Error('The reviewer App installation does not include the managed repository');
  return { repository: String(match.full_name), permissions: minted.permissions };
}
