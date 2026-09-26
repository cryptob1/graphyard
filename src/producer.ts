import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { consentAnswerSchema } from './consent-prompt.js';
import { LaunchRefusedError } from './harness.js';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { closeFailedLaunch, launchStartMs, withLaunchClose, accountLaunch, acknowledgeLaunch, acknowledgementMs, allocateManagedCheckout, atomicPrivateWrite, autonomousSession, closeHerdrPane, createdHerdrTab, deliverPrompt, destructivePromptGuidance, herdrJson, loadMasterConfig, markReprompted, neverStarted, onSelectedSession, prepareSessionHarness, privateFile, profileAtLimit, profileSessions, registrySessionOf, readProducerCredential, readSessionScreen, repromptText, selectAccount, selectRegistryAccount, sessionActivity, sessionAgentName, settleCheckout, settlementDue, settlementReason, sharedGitDirectory, startAgentSession, stopCreatedHerdrTab, writeFailure, type PromptDelivery, type StartBounds, type HerdrAgent, type MasterConfig, type ProducerProfile, type RequestDelivery, type SessionRetryReport } from './master.js';
import type { FleetProbe, selectFleetSession } from './fleet.js';
import { implementerIdentities, type Work } from './model.js';
import type { DispatchRequest } from './model/dispatch.js';
import { reclaimSessionCheckouts, removeSessionCheckout, sessionCheckout, worktreeRoot, type CheckoutReclaimReport, type FilesystemProbe, type SessionCheckout } from './install/worktree-root.js';
import { assertSessionLedgerRoom, boundSessionLedger, readReviewLedger, releaseClosedRequests, unrecordedPaneStopped, type SessionLedgerSpec } from './reviewer.js';
import { closedQuestionFor } from './model/closed-question.js';
import { paneAlreadyGone, withPaneGone } from './request-settlement.js';
import { narrowRoleRuntime, piRuntimeSchema } from './runner/payloads.js';
import { liveRun, registeredRun, type RunAdopter } from './runner/registry.js';
import type { EvidencePayload } from './runner/payloads.js';
import { narrowRunner, piProducerPrompt, producerRunOptions, registryRunner, startNarrowRun, submitEvidence } from './runner/roles.js';
import { liveRunCheckouts } from './runner/registry.js';
import { runRecordSchema, type RunRecord, type Runner } from './runner/types.js';

/**
 * Producer sessions launched for the control plane's producer requests (model/dispatch.ts).
 *
 * A producer session is the proof counterpart of a reviewer session: one exact head, one proof
 * group, one principal whose evidence the control plane trusts by its grants and never by what
 * the session says. The session holds the producer's own credential file (a path in its
 * environment, never a value on a command line), works in a detached worktree it creates in the
 * session directory Graphyard allocated for it under the managed worktree root — on durable
 * storage, outside every Graphyard worktree, removed when the session resolves — and submits
 * each proof with the exact head, base and policy revision it was launched for. The ledger here
 * records launch, completion and outcome per session, which is what `master status` reports as
 * running per candidate and since when.
 */

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i);
/** `unexercised`: the pass was recorded as not exercising its criterion (GY-135, model/evidence.ts exerciseRefusal). */
export const producerOutcomes = ['pass', 'fail', 'unexercised', 'untrusted', 'missing'] as const;
export type ProducerOutcome = typeof producerOutcomes[number];
export const producerRecordSchema = z.object({
  id: z.string().uuid(),
  /** The control-plane producer request this session answers; one live session per request id. */
  requestId: z.string().min(1).max(64),
  /** Which launch for the request this is: a failed or expired session is relaunched as the next attempt. */
  attempt: z.number().int().min(1).max(50).default(1),
  /** When the loop saw the control plane no longer request `requestId`; until then the record is pinned (reviewer.ts boundSessionLedger). */
  requestClosedAt: z.string().min(1).max(40).optional(),
  /** The agent registry session the launch was chosen under (GY-205): ended once this record settles, so the role's slot frees with it. */
  session: z.string().min(1).max(200).optional(),
  key: z.string().min(1).max(40), pr: z.number().int().positive(),
  sha: sha40, baseSha: sha40, policyRevision: z.number().int().nonnegative(),
  group: z.string().min(1).max(40), proofs: z.array(z.string().min(1).max(200)).min(1).max(50),
  /** `agentName` is the Herdr session name: the profile's fixed agent name, or one derived per request when the profile runs several sessions (GY-107, sessionAgentName). */
  profile: z.string().min(1).max(80), principal: z.string().min(1).max(200), agentName: z.string().min(1).max(120),
  pane: z.string().min(1).max(200).nullable(),
  requestedAt: z.string().min(1).max(40), expiresAt: z.string().min(1).max(40),
  state: z.enum(['pending', 'completed', 'cancelled', 'expired', 'failed']),
  /** What the control plane holds for each proof of the group, as last reconciled. */
  outcome: z.record(z.string(), z.enum(producerOutcomes)).default({}),
  /** When the session was first seen finished by Herdr without every proof submitted. */
  idleSince: z.string().min(1).max(40).optional(),
  /** How the request reached the session: on its command line, or as a paste for a runtime without that contract (GY-93). */
  delivery: z.enum(['request', 'paste']).optional(),
  /** The first-run consent prompts the launcher answered before the session took its request, with the option it chose (GY-130). */
  consent: z.array(consentAnswerSchema).max(8).optional(),
  /** Acknowledgement of the request, judged by the loop (acknowledgeLaunch): when sustained activity was seen, when it was re-prompted once, and the observation window. */
  acknowledgedAt: z.string().min(1).max(40).optional(),
  repromptedAt: z.string().min(1).max(40).optional(),
  activeSince: z.string().min(1).max(40).optional(),
  screen: z.string().min(1).max(64).optional(),
  resolution: z.string().min(1).max(900).optional(),
  closedAt: z.string().min(1).max(40).optional(),
  closeFailure: z.string().min(1).max(500).optional(),
  /** The session directory under the managed worktree root; removed when the session resolves. */
  checkout: z.string().min(1).max(1200).optional(),
  /** Why the checkout could not be removed at settlement; the reclaim pass takes it back. */
  checkoutFailure: z.string().min(1).max(500).optional(),
  /** `pi`: a headless run (GY-169), with no pane; absent is a Herdr session. */
  runtime: z.enum(['herdr', 'pi']).optional(),
  /** A headless run's record: its last events, its result, and what became of each submission. */
  run: runRecordSchema.optional(),
}).strict();
export type ProducerRecord = z.infer<typeof producerRecordSchema>;
// Bounded and reaped on write by the one implementation the review ledger uses (reviewer.ts
// boundSessionLedger, GY-131): the same bound, the same retention, the same refusal.
export const producerLedgerSchema = z.object({ version: z.literal(1), producers: z.array(producerRecordSchema).default([]) }).strict();
export type ProducerLedger = z.infer<typeof producerLedgerSchema>;
export const producerLedgerSpec: SessionLedgerSpec = { name: 'producer ledger', path: '.graphyard/producers.json', role: 'producer', idleGraceMs: 5 * 60_000 };

const ledgerFile = (root: string) => resolve(root, producerLedgerSpec.path);
export async function readProducerLedger(root: string): Promise<ProducerLedger> {
  const file = ledgerFile(root);
  try { await privateFile(file); return producerLedgerSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return { version: 1, producers: [] }; }
}
export const saveProducerLedger = async (root: string, ledger: ProducerLedger) => atomicPrivateWrite(ledgerFile(root), producerLedgerSchema.parse({ ...ledger, producers: boundSessionLedger(ledger.producers, producerLedgerSpec) }));

/** A finished session that submitted nothing for a proof is given this long to finish submitting before it is recorded as failed. */
export const producerIdleGraceMs = producerLedgerSpec.idleGraceMs;

/**
 * A session recorded failed or expired does not end its request: the loop relaunches it for the
 * same request, up to `sessionRetryLimit` sessions in all, each after a wider wait than the last
 * (1, 4 and 16 minutes, never more than 30). Any other recorded state — pending, completed,
 * cancelled — means the request has its session, and nothing is launched for it again.
 *
 * A session that never started (GY-93: it took up neither its request nor the re-prompt) is a
 * launch that failed, not work that failed, and it does not spend that budget: it neither counts
 * toward the limit nor widens the wait, and the request is launched again after the base wait.
 * Such sessions have a bound of their own, `unstartedRetryLimit`, because a request whose
 * sessions keep not starting has a launcher problem that more launches will not fix.
 */
/** Every session one request may have in all, however each ended: the dispatch failure limit (auto-dispatch.ts). */
export const requestAttemptLimit = 12;
export const sessionRetryLimit = 4, sessionRetryBaseMs = 60_000, sessionRetryMaxMs = 30 * 60_000, unstartedRetryLimit = 3;
export const sessionRetryDelay = (attempts: number) => Math.min(sessionRetryBaseMs * 4 ** Math.max(0, attempts - 1), sessionRetryMaxMs);
const retriedStates = ['failed', 'expired'];
/**
 * A headless run whose process was killed from outside it (GY-453) — its host went down, or a
 * restart reached it before runs were detached — judged nothing: like a session that never
 * started, it is retried after the base wait and spends no attempt of the request's budget.
 */
export const lostRunReason = 'headless run lost';
export const lostRun = (record: { state: string; resolution?: string | null }) => record.state === 'failed' && !!record.resolution?.startsWith(lostRunReason);
export function sessionRetry(records: { requestId?: string; state: string; requestedAt: string; closedAt?: string | null; resolution?: string | null }[], requestId: string, now: number) {
  const launched = records.filter(record => record.requestId === requestId);
  const last = launched.at(-1);
  const unstarted = launched.filter(neverStarted);
  const started = launched.length - unstarted.length - launched.filter(lostRun).length;
  const report = { requestId, attempts: launched.length, started, neverStarted: unstarted.length, limit: sessionRetryLimit, unstartedLimit: unstartedRetryLimit, last: last ? { state: last.state, resolution: last.resolution ?? null } : null };
  if (!last) return { ...report, launch: true, settled: false, nextAt: null, exhausted: false };
  if (!retriedStates.includes(last.state)) return { ...report, launch: false, settled: true, nextAt: null, exhausted: false };
  if (started >= sessionRetryLimit || unstarted.length >= unstartedRetryLimit) return { ...report, launch: false, settled: false, nextAt: null, exhausted: true };
  const nextAt = Date.parse(last.closedAt ?? last.requestedAt) + (neverStarted(last) || lostRun(last) ? sessionRetryBaseMs : sessionRetryDelay(started));
  return { ...report, launch: now >= nextAt, settled: false, nextAt: new Date(nextAt).toISOString(), exhausted: false };
}
/** The retry schedule of every request whose latest session failed or expired, as master status reports it. */
export function sessionRetries(records: { requestId?: string; state: string; requestedAt: string; closedAt?: string | null; resolution?: string | null }[], now: number): SessionRetryReport[] {
  const requests = [...new Set(records.map(record => record.requestId).filter((id): id is string => !!id))];
  return requests.map(id => sessionRetry(records, id, now)).filter(retry => retry.last && retriedStates.includes(retry.last.state))
    .map(({ requestId, attempts, started, neverStarted: unstarted, limit, unstartedLimit, nextAt, exhausted, last }) => ({ requestId, attempts, started, neverStarted: unstarted, limit, unstartedLimit, nextAt, exhausted, last }));
}

// The request must still be the one the record holds for the exact current candidate; a session
// launched for anything else would submit evidence the gates cannot bind.
export function assertProducerCandidate(work: Work, request: DispatchRequest, observedAt: string) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('A producer launch requires a valid Graphyard snapshot clock');
  if (request.kind !== 'producer' || !request.group || !request.proofs?.length) throw new Error(`${work.key} request ${request.id} is not a producer request`);
  const live = work.autoDispatch?.producers.find(entry => entry.id === request.id);
  if (!live || live.state !== 'requested') throw new Error(`${work.key} no longer requests a producer for ${request.group} proofs on ${request.sha.slice(0, 12)}`);
  const candidate = work.candidate;
  if (!work.submission || !candidate) throw new Error(`${work.key} has no independently observed pull-request candidate`);
  if (work.reworkRequested) throw new Error(`${work.key} is awaiting rework; the next submitted candidate is requested afresh`);
  if (candidate.sha !== request.sha || candidate.baseSha !== request.baseSha || work.policyRevision !== request.policyRevision) throw new Error(`${work.key} candidate ${candidate.sha.slice(0, 12)} is not the requested head ${request.sha.slice(0, 12)}`);
  if (work.observation?.prState === 'closed') throw new Error(`${work.key} pull request is closed`);
  return { key: work.key, id: work.id, pr: candidate.pr, sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: work.policyRevision, group: request.group, proofs: request.proofs, requestId: request.id, branch: candidate.branch };
}
export type ProducerBinding = ReturnType<typeof assertProducerCandidate>;

/** Profiles whose principal never implemented the item: only their evidence can be trusted. */
export function independentProducerProfiles(work: Work, profiles: ProducerProfile[]) {
  const implementers = new Set(implementerIdentities(work));
  return profiles.filter(profile => !implementers.has(profile.principal));
}

/**
 * Closed-question proofs (GY-109). Before a session is launched for a group, every proof of it
 * that its criterion declares answerable as a closed question is put to the control plane, which
 * asks the configured responder against the bound candidate state and records the answer as
 * evidence. A decided proof needs no session. An answer below the threshold — or no answer at all:
 * no responder configured, a refusal, an unreachable server — leaves the proof on its ordinary
 * path, so the session is launched for exactly the proofs no answer decided.
 */
export type ClosedQuestionJudge = (proof: string) => Promise<{ verdict: 'decided' | 'escalated'; escalation?: { reason: string } | null }>;
export async function judgeClosedQuestions(work: Work, binding: Pick<ProducerBinding, 'proofs'>, judge: ClosedQuestionJudge) {
  const decided: string[] = [], escalated: { proof: string; reason: string }[] = [];
  for (const proof of binding.proofs.filter(entry => closedQuestionFor(work, entry))) {
    try {
      const judged = await judge(proof);
      if (judged.verdict === 'decided') decided.push(proof);
      else escalated.push({ proof, reason: judged.escalation?.reason ?? 'the answer was below the threshold' });
    } catch (error) { escalated.push({ proof, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { decided, escalated, remaining: binding.proofs.filter(proof => !decided.includes(proof)) };
}
/** The control plane's judge, called with the producer's own credential: it triggers the judgement and supplies nothing it rests on. */
export const httpClosedQuestionJudge = (url: string, token: string, binding: Pick<ProducerBinding, 'key' | 'sha' | 'baseSha' | 'policyRevision'>, fetcher: typeof fetch = fetch): ClosedQuestionJudge => async proof => {
  const response = await fetcher(`${url}/api/work/${encodeURIComponent(binding.key)}/closed-question`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `closed-question:${binding.key}:${binding.sha}:${binding.baseSha}:${binding.policyRevision}:${proof}` },
    body: JSON.stringify({ proof, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision }), signal: AbortSignal.timeout(150_000),
  });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`closed question for ${proof} refused (${response.status}): ${body?.error ?? 'no reason given'}`);
  return body;
};
/** Thrown instead of launching when every proof of the group was decided by a closed-question answer. */
export class ClosedQuestionsDecided extends Error {
  constructor(readonly work: string, readonly proofs: string[]) { super(`No producer session launched for ${work}: ${proofs.join(', ')} ${proofs.length === 1 ? 'was' : 'were'} decided by a closed-question answer recorded as evidence`); }
}

/**
 * `checkout` is the session directory a launch allocated under the managed worktree root; a
 * session record carries its own, so the request rebuilt from a record (the GY-93 re-prompt) names
 * the directory the session was launched into. Without either the prompt names the directory a
 * launch from this checkout would allocate, so what is previewed is always a path under the
 * configured root.
 */
export function producerPrompt(config: Pick<MasterConfig, 'repository' | 'cliPath'> & { run?: MasterConfig['run'] }, binding: Pick<ProducerBinding, 'key' | 'pr' | 'sha' | 'baseSha' | 'policyRevision' | 'proofs'> & { group: string; requestId?: string; checkout?: string }, profile: Pick<ProducerProfile, 'principal'>,
  checkout: SessionCheckout = binding.checkout ? { directory: binding.checkout, worktree: resolve(binding.checkout, 'checkout') } : sessionCheckout(worktreeRoot(process.cwd(), config), 'proof', binding.key, binding.sha, binding.requestId ?? '0'.repeat(8))) {
  const worktree = checkout.worktree, stripped = resolve(checkout.directory, 'exercise');
  const evidenceFile = (proof: string) => resolve(checkout.directory, `${proof.replace(/[^a-zA-Z0-9]+/g, '-')}.evidence.json`);
  return `You are an independent Graphyard proof producer for ${config.repository}, principal ${profile.principal}. Produce trusted evidence for work item ${binding.key} (pull request #${binding.pr}) at exact head ${binding.sha} against base ${binding.baseSha} under policy revision ${binding.policyRevision}, for the ${binding.group} proof group: ${binding.proofs.join(', ')}. `
    + `Your Graphyard credential is the file named by GRAPHYARD_TOKEN_FILE and is used only by node ${config.cliPath}; never print, copy, cat, or echo it or any other credential, and never read .graphyard/connection.json, .graphyard/credentials.json, .env, or anything under ~/.config. `
    + `Work in a detached worktree of the exact head, created only at the path Graphyard allocated for this session under its managed worktree root — never in this checkout, never under .graphyard/worktrees and never under a temporary directory: git fetch origin ${binding.sha} && git worktree add --detach ${worktree} ${binding.sha}. Install and build there, then run what establishes each proof — start from the tests and scripts named for the proof (grep the proof name under tests/ and scripts/) and the acceptance criteria in node ${config.cliPath} status ${binding.key}. Run the project's tests through its own runners — node ${config.cliPath} verify ${binding.key} in that worktree, or npm test — which withhold every GRAPHYARD_* and HERDR_* variable from the tests and reserve free test ports themselves; a proof's cases are the ones whose title begins with its name, counted from a run of its whole test file, never narrowed with --test-name-pattern. `
    + 'Do not edit, commit, push, rebase or merge the candidate, do not claim Graphyard work, do not post a review, and never weaken, skip or narrow a test to make a proof pass. '
    + `A proof that passes against an unchanged tree proves nothing, so for each proof that passes also show it exercises its criterion: in a second detached worktree of the same head at ${stripped} (git worktree add --detach ${stripped} ${binding.sha}), remove the behaviour the criterion the proof is attached to describes — revert or stub exactly the lines of the change that implement it — and run the same proof there. `
    + `For each proof write a JSON file such as ${evidenceFile(binding.proofs[0])} of the form {"proof":"${binding.proofs[0]}","sha":"${binding.sha}","baseSha":"${binding.baseSha}","policyRevision":${binding.policyRevision},"result":"pass"|"fail","executed":N,"skipped":0,"environment":"<runtime and how it was produced>","scopeFiles":["<paths the proof depends on>"],"exercise":{"criterion":"<the criterion id, such as AC-1>","behaviour":"<the behaviour you removed, in words a worker can find in the diff>","result":"pass"|"fail","executed":N}} — exactly this sha, baseSha and policyRevision, executed as the number of cases actually run, a failing or incomplete run submitted as result fail rather than omitted, and exercise as the stripped run's true outcome: a proof that still passes there is recorded as not exercising its criterion rather than as passing, which is the finding, not something to hide — and submit it with node ${config.cliPath} evidence ${binding.key} FILE. `
    + `Keep everything this session writes — the install, build output, evidence files — inside ${checkout.directory}; Graphyard removes that directory when the session ends. When every proof of the group is submitted, remove both worktrees with git worktree remove --force ${worktree} and git worktree remove --force ${stripped}, print a one-paragraph summary naming each proof and its result, and stop; Graphyard closes this session once it observes the evidence. `
    + destructivePromptGuidance
    + autonomousSession('submit pass or fail evidence for every proof of the group', `submit that proof as result fail with executed as the cases that ran, putting the blocked command and its error in environment`);
}

export async function launchProducer(root: string, work: Work, request: DispatchRequest, profile: ProducerProfile, agents: { name?: string }[], observedAt: string, dependencies: {
  run?: ChildRun;
  now?: () => Date;
  /** How the profile's agent accounts are checked before the launch, and how its prompt is confirmed. */
  probe?: FleetProbe;
  prompt?: PromptDelivery;
  /** The start bound: how long the pane is read for the runtime before the launch is refused (master.ts awaitRuntimeStart). */
  start?: StartBounds;
  /** How the managed worktree root's volume is read; the kernel's own answer by default. */
  filesystem?: FilesystemProbe;
  /** How closed-question proofs are judged before the launch (GY-109); the control plane's route by default. */
  judge?: ClosedQuestionJudge;
  /** The headless runner a `pi` producer runs on (GY-169); the configured Pi runner by default. */
  runner?: Runner;
  fetcher?: typeof fetch;
} = {}) {
  const now = dependencies.now ?? (() => new Date());
  const config = await loadMasterConfig(root);
  let binding = assertProducerCandidate(work, request, observedAt);
  if (!config.producers.some(item => item.name === profile.name)) throw new Error(`Unknown producer profile ${profile.name}`);
  if (!independentProducerProfiles(work, [profile]).length) throw new Error(`Producer principal ${profile.principal} has held an assignment on ${work.key}; its evidence would not be trusted`);
  const ledger = await readProducerLedger(root);
  const pending = ledger.producers.find(record => record.state === 'pending' && record.key === work.key && record.group === binding.group);
  if (pending) throw new Error(`A producer session for ${work.key} ${binding.group} proofs is already pending on ${pending.sha.slice(0, 7)}; reconcile it with master status before launching another`);
  // One live session per request: a request whose sessions all failed or expired may be launched
  // again, as its next attempt, until the retry limit. A session that settled any other way while
  // the request still stands answered nothing, and the dispatcher attempts it again (GY-193), up to
  // `requestAttemptLimit` sessions for the request in all.
  const prior = ledger.producers.filter(record => record.requestId === request.id);
  if (prior.some(record => record.state === 'pending')) throw new Error(`Request ${request.id} was already launched for ${work.key}; one session per request`);
  const failedRuns = prior.filter(record => retriedStates.includes(record.state) && !lostRun(record)).length;
  if (retriedStates.includes(prior.at(-1)?.state ?? '') && failedRuns >= sessionRetryLimit) throw new Error(`Request ${request.id} for ${work.key} already had ${failedRuns} sessions fail or expire; no further automatic attempt`);
  if (prior.length >= requestAttemptLimit) throw new Error(`Request ${request.id} for ${work.key} already had ${prior.length} sessions; no further automatic attempt`);
  // The profile's room (GY-107): one session per name, and no more sessions than it declares.
  // A name this session would take that Herdr already shows is the same launch twice.
  const id = randomUUID();
  const agentName = sessionAgentName(profile, { id, requestId: request.id, attempt: prior.length + 1 });
  if (agents.some(agent => agent.name === agentName)) throw new Error(`Producer agent ${agentName} is already visible in Herdr`);
  // The ledger's room is local state, judged before any session exists (see launchReview).
  assertSessionLedgerRoom(ledger.producers, producerLedgerSpec, `${binding.key} ${binding.group} proofs of ${binding.sha.slice(0, 12)}`, { state: 'pending', requestedAt: new Date().toISOString(), key: binding.key, sha: binding.sha, requestId: request.id });
  const sessions = profileSessions(profile, agents, ledger.producers);
  if (!sessions.free) throw new Error(profileAtLimit('Producer', profile, sessions));
  const credential = await readProducerCredential(root, profile.credentialFile);
  // A closed question answers in seconds what a session takes most of an hour to; the session is
  // launched only for the proofs no confident answer decided.
  if (binding.proofs.some(proof => closedQuestionFor(work, proof))) {
    const judged = await judgeClosedQuestions(work, binding, dependencies.judge ?? httpClosedQuestionJudge(config.url, credential, binding));
    if (!judged.remaining.length) throw new ClosedQuestionsDecided(work.key, judged.decided);
    binding = { ...binding, proofs: judged.remaining };
  }
  // The group is part of the request: a producer session answers one proof group of one item, so a
  // relaunch for that group replaces its own predecessor instead of being refused by it.
  // GY-170: when the registry defines the producer role its choice decides the runtime: a unit-group
  // session on a `pi` account runs headless on that account, and any other group on one is refused
  // below; `run.runtimes` covers only a producer role the registry does not define.
  const registry = await selectRegistryAccount(config, 'producer', profile, { ...dependencies.probe, work: work.key, group: binding.group });
  if (registry ? registry.account.kind === 'pi' && binding.group === 'unit' : narrowRoleRuntime(config.run, 'producer', binding.group) === 'pi')
    return launchHeadlessProducer(root, config, work, binding, request, profile, { id, agentName, credential, attempt: prior.length + 1 }, { ...dependencies, now, registry });
  // Pi runs a producer headless for the unit group only; a Pi account chosen for any other group is
  // refused, its session given back, rather than started as a Herdr terminal session no launch path
  // supervises for Pi (GY-397).
  if (registry?.account.kind === 'pi') {
    const reason = `Graphyard refuses to launch account ${registry.account.name} for ${work.key} ${binding.group} proofs: runtime ${registry.account.fleet.runtime} runs producer sessions headless for the unit group only. Name an account of a terminal runtime ahead of it in the producer role (master registry role set producer ACCOUNT[,ACCOUNT…] --reason R).`;
    await registry.release(reason.slice(0, 400));
    throw new LaunchRefusedError('pi', reason);
  }
  const selected = registry ?? await selectAccount(config, 'producer', profile, { ...dependencies.probe, work: work.key, group: binding.group });
  // Everything past the choice can fail; the session it chose is given back at once when it does.
  return onSelectedSession(selected, `producer launch for ${work.key} ${binding.group} proofs failed`, async () => {
    // A producer builds in a detached worktree that commits into the repository's Git directory. Its
    // session directory is allocated under the managed worktree root — durable storage with room
    // left, outside every worktree — and is the only place beside the Git directory it may write.
    const checkout = await allocateManagedCheckout(root, config, 'proof', binding.key, binding.sha, id, dependencies.filesystem);
    const launch = accountLaunch(profile, selected.account, { writable: [checkout.directory, await sharedGitDirectory(root)].filter((path): path is string => !!path) });
    // The producer loads its own role rules, never the master's. The harness follows the account's
    // runtime, so a cross-runtime failover keeps its role rules.
    let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined, consent: z.infer<typeof consentAnswerSchema>[] = [];
    try {
      const harness = await prepareSessionHarness(root, config, { role: 'producer', kind: launch.kind, profile: profile.name, credentialFiles: [profile.credentialFile] });
      const environment = { ...launch.environment, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_PRODUCER: `${binding.key}@${binding.sha}`,
        GRAPHYARD_PRODUCER_BINDING: `${binding.key}@${binding.sha}@${binding.baseSha}@${binding.policyRevision}` };
      const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root,
        '--label', `${binding.key} ${binding.group} proofs · ${agentName}`, ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--no-focus'], dependencies.run));
      pane = created.pane; tabId = created.tab;
      // The request is the session's own first message, on the runtime's command line (GY-93), read
      // from the request file in the session's checkout so the typed line stays short (GY-121).
      ({ delivery, consent } = await startAgentSession(agentName, launch.kind!, created.pane, [...launch.args, ...harness.args], producerPrompt(config, binding, profile, checkout), dependencies.run, { ...dependencies.prompt, ...dependencies.start, timeoutMs: dependencies.start?.timeoutMs ?? launchStartMs(config), directory: checkout.directory, cwd: root, environment, role: harness.role, contract: launch.contract }));
    } catch (error) {
      // A launch that never became a session leaves no checkout behind.
      await removeSessionCheckout(root, dirname(checkout.directory), checkout.directory).catch(() => {});
      const malformedTab = (error as any)?.herdrTab as string | undefined;
      // Closed through the loop's own close path, and recorded in the failure (GY-413).
      let closed: string | null = null;
      if (pane || tabId || malformedTab) try { closed = await closeFailedLaunch(pane, tabId ?? malformedTab, dependencies.run); }
        catch { throw new Error(`${error instanceof Error ? error.message : 'Producer launch failed'}; Herdr could not confirm cleanup of the created tab`); }
      // A launch that failed for want of room says so, with the path and the reclaim command.
      const failure = writeFailure(error, `Launching the ${binding.key} producer session (${String((error as Error)?.message ?? error).split('\n')[0]})`, checkout.directory);
      // A disk-exhaustion report keeps its advice last; the close rides on it as `paneClosed` (GY-413).
      if (closed) { if (failure === error) withLaunchClose(failure, closed); else Object.assign(failure, { paneClosed: closed }); }
      throw failure;
    }
    const requestedAt = now();
    const record: ProducerRecord = producerRecordSchema.parse({ id, requestId: request.id, attempt: prior.length + 1, key: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision,
      group: binding.group, proofs: binding.proofs, profile: profile.name, principal: profile.principal, agentName, pane: pane ?? null,
      requestedAt: requestedAt.toISOString(), expiresAt: new Date(requestedAt.getTime() + config.run.producerTimeoutMinutes * 60_000).toISOString(), state: 'pending', outcome: Object.fromEntries(binding.proofs.map(proof => [proof, 'missing'])), delivery, ...(consent.length ? { consent } : {}), checkout: checkout.directory,
      ...(registrySessionOf(selected) ? { session: registrySessionOf(selected) } : {}) });
    // A record that cannot be written leaves no session behind.
    try { await saveProducerLedger(root, { ...ledger, producers: [...ledger.producers, record] }); }
    catch (error) {
      // A pane Herdr could not confirm closed keeps its checkout and is named in the refusal, so it is not lost with the record.
      if (!await unrecordedPaneStopped(error, pane, tabId, agentName, () => stopCreatedHerdrTab(pane, tabId, dependencies.run))) throw error;
      await removeSessionCheckout(root, dirname(checkout.directory), checkout.directory).catch(() => {}); throw error;
    }
    return { producer: record.id, requestId: request.id, attempt: record.attempt, work: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision, group: binding.group, proofs: binding.proofs,
      profile: profile.name, principal: profile.principal, agentName, pane: record.pane, checkout: checkout.directory, expiresAt: record.expiresAt, approvals: launch.plan.approvals, delivery,
      account: selected.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null,
      recorded: 'the launch is recorded; master status reconciles the evidence and closes the session' };
  });
}

/**
 * The unit proof producer on the headless runner (GY-169). The same request, binding, profile and
 * principal as a Herdr session, and the same ledger record, but no pane: the run is registered
 * under the session name, each proof comes back as a validated graphyard_submit_evidence call, and
 * the loop submits it as the producer principal on the route `graphyard evidence` uses, so the
 * server trusts it by the producer's grants and the exercise rule exactly as it does today. When
 * the run ends its record is kept on the session record, and reconciliation settles it as usual.
 */
async function launchHeadlessProducer(root: string, config: MasterConfig, work: Work, binding: ProducerBinding, request: DispatchRequest, profile: ProducerProfile,
  session: { id: string; agentName: string; credential: string; attempt: number }, dependencies: { now: () => Date; runner?: Runner; fetcher?: typeof fetch; filesystem?: FilesystemProbe; registry?: Awaited<ReturnType<typeof selectFleetSession>> }) {
  const pi = piRuntimeSchema.parse(config.run.pi ?? {}), registry = dependencies.registry ?? null;
  // The runner and the name evidence is attributed to come from the registry's choice when it made one.
  // A launch the registry's contract refuses (a tools allowlist with no tools flag) gives its session back.
  let runner: Runner;
  try { runner = dependencies.runner ?? (registry ? registryRunner(registry.account) : narrowRunner(pi)); }
  catch (error) { await registry?.release(`producer run for ${binding.key} was refused before it started: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400)); throw error; }
  const via = registry ? `${registry.account.fleet.runtime} ${registry.account.fleet.modelId ?? registry.account.fleet.model} on ${registry.account.name}` : `pi ${pi.model} via ${pi.command}`;
  let checkout: Awaited<ReturnType<typeof allocateManagedCheckout>>;
  try { checkout = await allocateManagedCheckout(root, config, 'proof', binding.key, binding.sha, session.id, dependencies.filesystem); }
  catch (error) { await registry?.release(`producer run for ${binding.key} failed before it started: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400)); throw error; }
  const requestedAt = dependencies.now();
  const timeoutMs = config.run.producerTimeoutMinutes * 60_000;
  const record: ProducerRecord = producerRecordSchema.parse({ id: session.id, requestId: request.id, attempt: session.attempt, key: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision,
    group: binding.group, proofs: binding.proofs, profile: profile.name, principal: profile.principal, agentName: session.agentName, pane: null,
    // A run holds its request on its command line from its first instant: there is nothing to re-prompt.
    requestedAt: requestedAt.toISOString(), expiresAt: new Date(requestedAt.getTime() + timeoutMs).toISOString(), state: 'pending', outcome: Object.fromEntries(binding.proofs.map(proof => [proof, 'missing'])),
    delivery: 'request', acknowledgedAt: requestedAt.toISOString(), checkout: checkout.directory, runtime: 'pi', ...(registry ? { session: registry.account.fleet.session } : {}) });
  const ledger = await readProducerLedger(root);
  try { await saveProducerLedger(root, { ...ledger, producers: [...ledger.producers, record] }); }
  catch (error) { await removeSessionCheckout(root, dirname(checkout.directory), checkout.directory).catch(() => {}); await registry?.release('the producer record could not be written'); throw error; }
  const environment = { GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_PRODUCER: `${binding.key}@${binding.sha}` };
  let started: ReturnType<typeof startNarrowRun>;
  try {
    started = startNarrowRun({ runner, name: session.agentName, role: 'producer', work: binding.key, subject: session.id, root,
      // What an adoption after a restart needs to judge and submit the run's evidence (producerRunAdopter); the credential is read from its file then.
      context: { url: config.url, credentialFile: profile.credentialFile, workId: binding.id, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision, proofs: binding.proofs, via, timeoutMs, checkout: checkout.directory },
      prompt: piProducerPrompt(config, binding, work.criteria, checkout, root),
      options: producerRunOptions(checkout.directory, binding, environment, timeoutMs),
      apply: async result => { const applied = []; for (const payload of result.payloads) applied.push(await submitEvidence(config.url, session.credential, { id: binding.id }, payload, via, dependencies.fetcher)); return applied; } });
  } catch (error) {
    await updateProducerRecord(root, session.id, entry => ({ ...entry, state: 'failed', resolution: `the headless run could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 900), closedAt: new Date().toISOString() }));
    await removeSessionCheckout(root, dirname(checkout.directory), checkout.directory).catch(() => {});
    await registry?.release(`producer run for ${binding.key} failed to start`);
    throw error;
  }
  // A registry session is the run: its slot is given back the moment the run ends.
  const settled = started.settled.finally(() => registry?.release(`the headless producer run for ${binding.key} ended`)).then(run => updateProducerRecord(root, session.id, entry => ({ ...entry, run })).then(() => run));
  settled.catch(() => { /* reconciliation settles the record on its expiry */ });
  return { producer: record.id, requestId: request.id, attempt: record.attempt, work: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision, group: binding.group, proofs: binding.proofs,
    profile: profile.name, principal: profile.principal, agentName: session.agentName, pane: null, checkout: checkout.directory, expiresAt: record.expiresAt, runtime: 'pi' as const, delivery: 'request' as const,
    account: registry ? { environment: registry.account.name, kind: registry.account.kind, quota: registry.health?.quota ?? null, skipped: registry.skipped } : null, approvals: null,
    run: started.record, settled, recorded: 'the headless run is recorded; its evidence is submitted as it arrives and master status reconciles it' };
}
const producerRunContextSchema = z.object({ url: z.string(), credentialFile: z.string(), workId: z.string(), sha: sha40, baseSha: sha40, policyRevision: z.number().int().nonnegative(),
  proofs: z.array(z.string()).min(1), via: z.string(), timeoutMs: z.number().int().positive(), checkout: z.string() }).passthrough();
/**
 * How a restarted loop takes back a headless producer run (GY-453, registry.ts adoptRuns): the
 * same validation of each submission against the run's binding, each proof submitted as the
 * producer principal (its credential read from its file now), and the run's record kept on its
 * ledger entry. A run whose ledger entry already settled is stopped instead: nothing wants it.
 */
export function producerRunAdopter(root: string, fetcher?: typeof fetch): RunAdopter {
  return async owner => {
    const context = producerRunContextSchema.parse(owner.context);
    const record = (await readProducerLedger(root)).producers.find(entry => entry.id === owner.subject);
    const options = producerRunOptions(context.checkout, { sha: context.sha, baseSha: context.baseSha, policyRevision: context.policyRevision, proofs: context.proofs }, {}, context.timeoutMs);
    if (!record || record.state !== 'pending') return { options, apply: async () => [], cancel: `the producer session ${owner.subject} already settled${record ? ` (${record.state})` : ''}` };
    return {
      options,
      apply: async result => {
        if (!result.payloads.length) return [];
        const credential = await readProducerCredential(root, context.credentialFile);
        const applied = [];
        for (const payload of result.payloads) applied.push(await submitEvidence(context.url, credential, { id: context.workId }, payload as EvidencePayload, context.via, fetcher));
        return applied;
      },
      settled: run => updateProducerRecord(root, owner.subject, entry => ({ ...entry, run })),
    };
  };
}
async function updateProducerRecord(root: string, id: string, change: (record: ProducerRecord) => ProducerRecord) {
  const ledger = await readProducerLedger(root);
  await saveProducerLedger(root, { ...ledger, producers: ledger.producers.map(entry => entry.id === id ? change(entry) : entry) });
}

/** What the control plane holds for one proof on the exact head the session was launched for. */
export function proofOutcome(work: Work | undefined, record: Pick<ProducerRecord, 'sha' | 'baseSha' | 'policyRevision'>, proof: string): ProducerOutcome {
  const bound = (work?.evidence ?? []).filter(entry => entry.proof === proof && entry.sha === record.sha && entry.baseSha === record.baseSha && entry.policyRevision === record.policyRevision && !entry.revocation);
  const trusted = bound.filter(entry => entry.trusted).at(-1);
  if (trusted) return trusted.result === 'pass' && trusted.executed > 0 && trusted.skipped === 0 ? 'pass' : 'fail';
  if (bound.at(-1)?.unexercised) return 'unexercised';
  return bound.length ? 'untrusted' : 'missing';
}

/**
 * Settle pending producer sessions against the control plane and Herdr: completed once every
 * proof of the group has a trusted outcome (or one failed), cancelled when the control plane
 * withdrew the request, expired past the configured timeout, and failed when the session
 * finished without submitting. A pane is closed on every settlement; if Herdr cannot confirm
 * it, the record stays pending with the reason rather than claiming the session is gone.
 *
 * Every pending session is also judged for acknowledgement (master.ts acknowledgeLaunch): one
 * that shows no activity for `run.acknowledgementSeconds` is re-prompted once with its request,
 * and one that then settles without evidence is recorded as never started, in the session's own
 * words, rather than as work that failed. The grace never settles an unacknowledged session that
 * is still in Herdr before its re-prompt and the interval after it (settlementDue), whatever the
 * interval is set to.
 */
/** `agents` is null when Herdr could not be read: a session is then never judged finished. */
export async function reconcileProducers(root: string, config: MasterConfig, work: Work[], agents: HerdrAgent[] | null, dependencies: {
  run?: ChildRun;
  now?: () => Date;
  /** Re-prompts a quiet session with its request; the default delivers it in Herdr. */
  reprompt?: (record: ProducerRecord, message: string) => void | Promise<void>;
} = {}) {
  const ledger = await readProducerLedger(root);
  const now = (dependencies.now ?? (() => new Date()))();
  const run = dependencies.run ?? defaultChildRun;
  const reprompt = dependencies.reprompt ?? (async (record: ProducerRecord, message: string) => { await deliverPrompt(record.agentName, message, run); });
  const ackMs = acknowledgementMs(config);
  let changed = 0;
  for (const record of ledger.producers) {
    if (record.state !== 'pending') continue;
    const item = work.find(candidate => candidate.key === record.key);
    const outcome = Object.fromEntries(record.proofs.map(proof => [proof, proofOutcome(item, record, proof)])) as Record<string, ProducerOutcome>;
    if (JSON.stringify(outcome) !== JSON.stringify(record.outcome)) { record.outcome = outcome; changed++; }
    const results = Object.values(outcome);
    const request = item?.autoDispatch ? [...item.autoDispatch.producers, ...item.autoDispatch.history].find(entry => entry.id === record.requestId) : undefined;
    const agent = agents?.find(candidate => candidate.name === record.agentName);
    // A headless run (GY-169) has finished once it ended, which its record or this process's
    // registry says; a run neither knows about belongs to another process and is left to its expiry.
    const headless = record.runtime === 'pi', ended = headless ? record.run?.endedAt ? record.run : registeredRun(record.agentName)?.record ?? null : null;
    if (headless && ended && !record.run) { record.run = ended; changed++; }
    const lost = headless && ended?.result?.ok === false && ended.result.reason === 'lost';
    const finished = headless ? !!ended && !liveRun(record.agentName) : agents !== null && (!agent || ['done', 'idle', 'blocked'].includes(agent.agent_status ?? ''));
    const screen = () => readSessionScreen(record.agentName, run);
    // Acknowledgement is judged only from a Herdr that could be read; a submitted proof is the
    // strongest acknowledgement of all. A headless run holds its request from its start.
    if (agents !== null && !headless) {
      const judged = await acknowledgeLaunch(record, agent, { now: now.getTime(), ackMs, result: results.some(result => result !== 'missing'), screen });
      if (judged.changed) changed++;
      if (judged.reprompt) {
        markReprompted(record, now.getTime()); changed++;
        try { await reprompt(record, repromptText(producerPrompt(config, record, record), ackMs)); }
        catch { /* the settlement below records a session the re-prompt could not reach */ }
      }
    }
    let next: { state: ProducerRecord['state']; resolution: string } | null = null;
    if (results.some(result => result === 'fail')) next = { state: 'completed', resolution: `trusted evidence failed for ${record.proofs.filter(proof => outcome[proof] === 'fail').join(', ')}` };
    // A pass recorded as not exercising its criterion is the producer's finding about the proof: the
    // worker fixes it from the reason, which names the proof, the criterion and the behaviour. The
    // session keeps its time for the group's other proofs until none is still missing.
    else if (results.some(result => result === 'unexercised') && !results.includes('missing')) next = { state: 'completed', resolution: `evidence does not exercise its criterion: ${record.proofs.filter(proof => outcome[proof] === 'unexercised')
      .map(proof => item?.evidence.filter(entry => entry.proof === proof && entry.sha === record.sha && entry.unexercised).at(-1)?.unexercised ?? proof).join('; ')}`.slice(0, 900) };
    else if (results.every(result => result === 'pass')) next = { state: 'completed', resolution: `trusted passing evidence recorded for ${record.proofs.join(', ')}` };
    else if (request && request.state === 'cancelled') next = { state: 'cancelled', resolution: request.resolution ?? 'the control plane withdrew the request' };
    else if (item && (!item.candidate || item.candidate.sha !== record.sha || item.candidate.baseSha !== record.baseSha || item.policyRevision !== record.policyRevision)) next = { state: 'cancelled', resolution: `head changed from ${record.sha.slice(0, 12)} to ${item.candidate?.sha.slice(0, 12) ?? 'none'}` };
    // A lost run judged nothing and never will: it is settled at once and retried as if it never started.
    else if (lost) next = { state: 'failed', resolution: `${lostRunReason}: ${ended!.result!.ok === false ? ended!.result!.detail : ''}; retried without spending an attempt`.slice(0, 900) };
    else if (Date.parse(record.expiresAt) <= now.getTime()) next = { state: 'expired', resolution: `no trusted evidence for ${record.proofs.filter(proof => outcome[proof] !== 'pass').join(', ')} within ${config.run.producerTimeoutMinutes} minutes` };
    else if (finished) {
      if (!record.idleSince) { record.idleSince = now.toISOString(); changed++; }
      else if (now.getTime() - Date.parse(record.idleSince) >= producerIdleGraceMs && settlementDue(record, agent, { now: now.getTime(), ackMs })) {
        const missing = record.proofs.filter(proof => outcome[proof] !== 'pass').map(proof => `${proof} (${outcome[proof]})`).join(', ');
        if (headless) {
          const result = ended?.result, refused = ended?.applied.filter(entry => entry.outcome === 'refused').map(entry => `${entry.subject}: ${entry.detail}`) ?? [];
          next = { state: 'failed', resolution: `the headless run ended (${!result ? 'no result recorded' : result.ok ? `${result.submitted} submission(s)` : `${result.reason}: ${result.detail}`}) without trusted evidence for ${missing}${refused.length ? `; refused: ${refused.join('; ')}` : ''}`.slice(0, 900) };
        } else {
        const failure = agent?.agent_status === 'blocked'
          ? `the session ended waiting on input (Herdr reports it blocked) instead of deciding on its own, without trusted evidence for ${missing}`
          : `the session finished (${agent?.agent_status ?? 'gone from Herdr'}) without trusted evidence for ${missing}`;
        next = { state: 'failed', resolution: await settlementReason(record, agent, { now: now.getTime(), ackMs, screen }, failure) };
        }
      }
    } else if (record.idleSince) { delete record.idleSince; changed++; }
    if (!next) continue;
    // A headless run still going when its request settles is stopped, as a pane would be closed.
    if (headless) liveRun(record.agentName)?.run.cancel(next.resolution);
    let closeFailure: string | undefined, paneGone = false;
    // A pane that is already gone is the state the close wanted (GY-137), so it settles the record
    // with the absence named on the resolution; any other close failure keeps it pending and retried.
    // A session Herdr no longer reports is not closed at all, so an expired request settles as expired.
    try { if (record.pane && (agent || agents === null)) await closeHerdrPane(record.pane, run); }
    catch (error) { if (paneAlreadyGone(error)) paneGone = true; else closeFailure = `Herdr could not close pane ${record.pane}: ${error instanceof Error ? error.message : 'unknown reason'}`; }
    record.closeFailure = closeFailure;
    if (!closeFailure) {
      // The session is gone, so its checkout goes with it — whatever the outcome. One that cannot
      // be removed is said so on the record and taken back by the next reclaim pass.
      const failure = await settleCheckout(root, record.checkout);
      if (failure) record.checkoutFailure = failure; else delete record.checkoutFailure;
      record.state = next.state; record.resolution = paneGone ? withPaneGone(next.resolution, record.pane!) : next.resolution; record.closedAt = now.toISOString();
    }
    changed++;
  }
  // A request the control plane no longer holds open releases its records to the retention window.
  changed += releaseClosedRequests(ledger.producers, work, now);
  if (changed) await saveProducerLedger(root, ledger);
  return { producers: ledger.producers, changed };
}

/**
 * The reclaim pass over the managed worktree root: every session directory no pending producer or
 * reviewer record owns is removed. Settlement removes a session's own checkout, so what this finds
 * was left by a session whose master died before it could settle.
 */
export async function reclaimCheckouts(root: string, config: MasterConfig, options: { now?: number; graceMs?: number; probe?: FilesystemProbe } = {}): Promise<CheckoutReclaimReport> {
  const [producers, reviews] = await Promise.all([readProducerLedger(root), readReviewLedger(root)]);
  // A live headless approver's directory is owned by its run, not by a ledger record (GY-391).
  const live = [...[...producers.producers, ...reviews.reviews].filter(record => record.state === 'pending' && record.checkout).map(record => record.checkout!), ...liveRunCheckouts()];
  return reclaimSessionCheckouts(root, worktreeRoot(root, config), live, { ...options, failure: writeFailure });
}

export function summarizeProducers(records: ProducerRecord[]) {
  const describe = (record: ProducerRecord) => ({ producer: record.id, requestId: record.requestId, attempt: record.attempt, work: record.key, pr: record.pr, sha: record.sha, policyRevision: record.policyRevision, group: record.group, proofs: record.proofs,
    profile: record.profile, principal: record.principal, agentName: record.agentName, state: record.state, outcome: record.outcome, requestedAt: record.requestedAt, expiresAt: record.expiresAt, closedAt: record.closedAt ?? null, resolution: record.resolution ?? null, attention: record.closeFailure ?? null,
    // GY-93: how the request reached the session, and whether the session has taken it up.
    delivery: record.delivery ?? null, activity: record.state === 'pending' ? sessionActivity(record) : null, acknowledgedAt: record.acknowledgedAt ?? null, repromptedAt: record.repromptedAt ?? null, neverStarted: neverStarted(record) });
  return { pending: records.filter(record => record.state === 'pending').map(describe), completed: records.filter(record => record.state !== 'pending').slice(-20).map(describe) };
}
