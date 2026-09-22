import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { accountLaunch, acknowledgeLaunch, acknowledgementMs, allocateManagedCheckout, atomicPrivateWrite, autonomousSession, closeHerdrPane, createdHerdrTab, deliverPrompt, herdrJson, loadMasterConfig, markReprompted, neverStarted, prepareSessionHarness, privateFile, profileAtLimit, profileSessions, readProducerCredential, readSessionScreen, repromptText, selectAccount, sessionActivity, sessionAgentName, settleCheckout, settlementDue, settlementReason, sharedGitDirectory, startAgentSession, stopCreatedHerdrTab, writeFailure, type EnvironmentProbe, type PromptDelivery, type HerdrAgent, type MasterConfig, type ProducerProfile, type RequestDelivery, type SessionRetryReport } from './master.js';
import { implementerIdentities, type Work } from './model.js';
import type { DispatchRequest } from './model/dispatch.js';
import { reclaimSessionCheckouts, removeSessionCheckout, sessionCheckout, worktreeRoot, type CheckoutReclaimReport, type FilesystemProbe, type SessionCheckout } from './install/worktree-root.js';
import { readReviewLedger } from './reviewer.js';

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
export const producerOutcomes = ['pass', 'fail', 'untrusted', 'missing'] as const;
export type ProducerOutcome = typeof producerOutcomes[number];
export const producerRecordSchema = z.object({
  id: z.string().uuid(),
  /** The control-plane producer request this session answers; one live session per request id. */
  requestId: z.string().min(1).max(64),
  /** Which launch for the request this is: a failed or expired session is relaunched as the next attempt. */
  attempt: z.number().int().min(1).max(50).default(1),
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
}).strict();
export type ProducerRecord = z.infer<typeof producerRecordSchema>;
export const producerLedgerSchema = z.object({ version: z.literal(1), producers: z.array(producerRecordSchema).max(400).default([]) }).strict();
export type ProducerLedger = z.infer<typeof producerLedgerSchema>;

const ledgerFile = (root: string) => resolve(root, '.graphyard/producers.json');
export async function readProducerLedger(root: string): Promise<ProducerLedger> {
  const file = ledgerFile(root);
  try { await privateFile(file); return producerLedgerSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return { version: 1, producers: [] }; }
}
export const saveProducerLedger = (root: string, ledger: ProducerLedger) => atomicPrivateWrite(ledgerFile(root), producerLedgerSchema.parse({ ...ledger, producers: ledger.producers.slice(-400) }));

/** A finished session that submitted nothing for a proof is given this long to finish submitting before it is recorded as failed. */
export const producerIdleGraceMs = 5 * 60_000;

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
export const sessionRetryLimit = 4, sessionRetryBaseMs = 60_000, sessionRetryMaxMs = 30 * 60_000, unstartedRetryLimit = 3;
export const sessionRetryDelay = (attempts: number) => Math.min(sessionRetryBaseMs * 4 ** Math.max(0, attempts - 1), sessionRetryMaxMs);
const retriedStates = ['failed', 'expired'];
export function sessionRetry(records: { requestId?: string; state: string; requestedAt: string; closedAt?: string | null; resolution?: string | null }[], requestId: string, now: number) {
  const launched = records.filter(record => record.requestId === requestId);
  const last = launched.at(-1);
  const unstarted = launched.filter(neverStarted);
  const started = launched.length - unstarted.length;
  const report = { requestId, attempts: launched.length, started, neverStarted: unstarted.length, limit: sessionRetryLimit, unstartedLimit: unstartedRetryLimit, last: last ? { state: last.state, resolution: last.resolution ?? null } : null };
  if (!last) return { ...report, launch: true, settled: false, nextAt: null, exhausted: false };
  if (!retriedStates.includes(last.state)) return { ...report, launch: false, settled: true, nextAt: null, exhausted: false };
  if (started >= sessionRetryLimit || unstarted.length >= unstartedRetryLimit) return { ...report, launch: false, settled: false, nextAt: null, exhausted: true };
  const nextAt = Date.parse(last.closedAt ?? last.requestedAt) + (neverStarted(last) ? sessionRetryBaseMs : sessionRetryDelay(started));
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
 * `checkout` is the session directory a launch allocated under the managed worktree root; a
 * session record carries its own, so the request rebuilt from a record (the GY-93 re-prompt) names
 * the directory the session was launched into. Without either the prompt names the directory a
 * launch from this checkout would allocate, so what is previewed is always a path under the
 * configured root.
 */
export function producerPrompt(config: Pick<MasterConfig, 'repository' | 'cliPath'> & { run?: MasterConfig['run'] }, binding: Pick<ProducerBinding, 'key' | 'pr' | 'sha' | 'baseSha' | 'policyRevision' | 'proofs'> & { group: string; requestId?: string; checkout?: string }, profile: Pick<ProducerProfile, 'principal'>,
  checkout: SessionCheckout = binding.checkout ? { directory: binding.checkout, worktree: resolve(binding.checkout, 'checkout') } : sessionCheckout(worktreeRoot(process.cwd(), config), 'proof', binding.key, binding.sha, binding.requestId ?? '0'.repeat(8))) {
  const worktree = checkout.worktree;
  const evidenceFile = (proof: string) => resolve(checkout.directory, `${proof.replace(/[^a-zA-Z0-9]+/g, '-')}.evidence.json`);
  return `You are an independent Graphyard proof producer for ${config.repository}, principal ${profile.principal}. Produce trusted evidence for work item ${binding.key} (pull request #${binding.pr}) at exact head ${binding.sha} against base ${binding.baseSha} under policy revision ${binding.policyRevision}, for the ${binding.group} proof group: ${binding.proofs.join(', ')}. `
    + `Your Graphyard credential is the file named by GRAPHYARD_TOKEN_FILE and is used only by node ${config.cliPath}; never print, copy, cat, or echo it or any other credential, and never read .graphyard/connection.json, .graphyard/credentials.json, .env, or anything under ~/.config. `
    + `Work in a detached worktree of the exact head, created only at the path Graphyard allocated for this session under its managed worktree root — never in this checkout, never under .graphyard/worktrees and never under a temporary directory: git fetch origin ${binding.sha} && git worktree add --detach ${worktree} ${binding.sha}. Install and build there, then run what establishes each proof — start from the tests and scripts named for the proof (grep the proof name under tests/ and scripts/) and the acceptance criteria in node ${config.cliPath} status ${binding.key} — with every GRAPHYARD_* and HERDR_* variable unset for the project's own test runs and a free GRAPHYARD_TEST_PORT. `
    + 'Do not edit, commit, push, rebase or merge the candidate, do not claim Graphyard work, do not post a review, and never weaken, skip or narrow a test to make a proof pass. '
    + `For each proof write a JSON file such as ${evidenceFile(binding.proofs[0])} of the form {"proof":"${binding.proofs[0]}","sha":"${binding.sha}","baseSha":"${binding.baseSha}","policyRevision":${binding.policyRevision},"result":"pass"|"fail","executed":N,"skipped":0,"environment":"<runtime and how it was produced>","scopeFiles":["<paths the proof depends on>"]} — exactly this sha, baseSha and policyRevision, executed as the number of cases actually run, and a failing or incomplete run submitted as result fail rather than omitted — and submit it with node ${config.cliPath} evidence ${binding.key} FILE. `
    + `Keep everything this session writes — the install, build output, evidence files — inside ${checkout.directory}; Graphyard removes that directory when the session ends. When every proof of the group is submitted, remove the worktree with git worktree remove --force ${worktree}, print a one-paragraph summary naming each proof and its result, and stop; Graphyard closes this session once it observes the evidence. `
    + autonomousSession('submit pass or fail evidence for every proof of the group', `submit that proof as result fail with executed as the cases that ran, putting the blocked command and its error in environment`);
}

export async function launchProducer(root: string, work: Work, request: DispatchRequest, profile: ProducerProfile, agents: { name?: string }[], observedAt: string, dependencies: {
  run?: (command: string, args: string[]) => string;
  now?: () => Date;
  /** How the profile's agent accounts are checked before the launch, and how its prompt is confirmed. */
  probe?: EnvironmentProbe;
  prompt?: PromptDelivery;
  /** How the managed worktree root's volume is read; the kernel's own answer by default. */
  filesystem?: FilesystemProbe;
} = {}) {
  const now = dependencies.now ?? (() => new Date());
  const config = await loadMasterConfig(root);
  const binding = assertProducerCandidate(work, request, observedAt);
  if (!config.producers.some(item => item.name === profile.name)) throw new Error(`Unknown producer profile ${profile.name}`);
  if (!independentProducerProfiles(work, [profile]).length) throw new Error(`Producer principal ${profile.principal} has held an assignment on ${work.key}; its evidence would not be trusted`);
  const ledger = await readProducerLedger(root);
  const pending = ledger.producers.find(record => record.state === 'pending' && record.key === work.key && record.group === binding.group);
  if (pending) throw new Error(`A producer session for ${work.key} ${binding.group} proofs is already pending on ${pending.sha.slice(0, 7)}; reconcile it with master status before launching another`);
  // One live session per request: a request whose sessions all failed or expired may be launched
  // again, as its next attempt, until the retry limit.
  const prior = ledger.producers.filter(record => record.requestId === request.id);
  if (prior.some(record => !retriedStates.includes(record.state))) throw new Error(`Request ${request.id} was already launched for ${work.key}; one session per request`);
  if (prior.length >= sessionRetryLimit) throw new Error(`Request ${request.id} for ${work.key} already had ${prior.length} sessions fail or expire; no further automatic attempt`);
  // The profile's room (GY-107): one session per name, and no more sessions than it declares.
  // A name this session would take that Herdr already shows is the same launch twice.
  const id = randomUUID();
  const agentName = sessionAgentName(profile, { id, requestId: request.id, attempt: prior.length + 1 });
  if (agents.some(agent => agent.name === agentName)) throw new Error(`Producer agent ${agentName} is already visible in Herdr`);
  const sessions = profileSessions(profile, agents, ledger.producers);
  if (!sessions.free) throw new Error(profileAtLimit('Producer', profile, sessions));
  await readProducerCredential(root, profile.credentialFile);
  const selected = await selectAccount(config, 'producer', profile, { ...dependencies.probe, work: work.key });
  // A producer builds in a detached worktree that commits into the repository's Git directory. Its
  // session directory is allocated under the managed worktree root — durable storage with room
  // left, outside every worktree — and is the only place beside the Git directory it may write.
  const checkout = await allocateManagedCheckout(root, config, 'proof', binding.key, binding.sha, id, dependencies.filesystem);
  const launch = accountLaunch(profile, selected.account, { writable: [checkout.directory, sharedGitDirectory(root)].filter((path): path is string => !!path) });
  // The producer loads its own role rules, never the master's. The harness follows the account's
  // runtime, so a cross-runtime failover keeps its role rules.
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    const harness = await prepareSessionHarness(root, config, { role: 'producer', kind: launch.kind, profile: profile.name, credentialFiles: [profile.credentialFile] });
    const environment = { ...launch.environment, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_PRODUCER: `${binding.key}@${binding.sha}` };
    const created = createdHerdrTab(herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root,
      '--label', `${binding.key} ${binding.group} proofs · ${agentName}`, ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--no-focus'], dependencies.run));
    pane = created.pane; tabId = created.tab;
    // The request is the session's own first message, on the runtime's command line (GY-93).
    ({ delivery } = startAgentSession(agentName, launch.kind!, created.pane, [...launch.args, ...harness.args], producerPrompt(config, binding, profile, checkout), dependencies.run, dependencies.prompt));
  } catch (error) {
    // A launch that never became a session leaves no checkout behind.
    await removeSessionCheckout(root, dirname(checkout.directory), checkout.directory).catch(() => {});
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { stopCreatedHerdrTab(pane, tabId ?? malformedTab, dependencies.run); }
      catch { throw new Error(`${error instanceof Error ? error.message : 'Producer launch failed'}; Herdr could not confirm cleanup of the created tab`); }
    // A launch that failed for want of room says so, with the path and the reclaim command.
    throw writeFailure(error, `Launching the ${binding.key} producer session (${String((error as Error)?.message ?? error).split('\n')[0]})`, checkout.directory);
  }
  const requestedAt = now();
  const record: ProducerRecord = producerRecordSchema.parse({ id, requestId: request.id, attempt: prior.length + 1, key: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision,
    group: binding.group, proofs: binding.proofs, profile: profile.name, principal: profile.principal, agentName, pane: pane ?? null,
    requestedAt: requestedAt.toISOString(), expiresAt: new Date(requestedAt.getTime() + config.run.producerTimeoutMinutes * 60_000).toISOString(), state: 'pending', outcome: Object.fromEntries(binding.proofs.map(proof => [proof, 'missing'])), delivery, checkout: checkout.directory });
  await saveProducerLedger(root, { ...ledger, producers: [...ledger.producers, record] });
  return { producer: record.id, requestId: request.id, attempt: record.attempt, work: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision, group: binding.group, proofs: binding.proofs,
    profile: profile.name, principal: profile.principal, agentName, pane: record.pane, checkout: checkout.directory, expiresAt: record.expiresAt, approvals: launch.plan.approvals, delivery,
    account: selected.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null,
    recorded: 'the launch is recorded; master status reconciles the evidence and closes the session' };
}

/** What the control plane holds for one proof on the exact head the session was launched for. */
export function proofOutcome(work: Work | undefined, record: Pick<ProducerRecord, 'sha' | 'baseSha' | 'policyRevision'>, proof: string): ProducerOutcome {
  const bound = (work?.evidence ?? []).filter(entry => entry.proof === proof && entry.sha === record.sha && entry.baseSha === record.baseSha && entry.policyRevision === record.policyRevision && !entry.revocation);
  const trusted = bound.filter(entry => entry.trusted).at(-1);
  if (trusted) return trusted.result === 'pass' && trusted.executed > 0 && trusted.skipped === 0 ? 'pass' : 'fail';
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
  run?: (command: string, args: string[]) => string;
  now?: () => Date;
  /** Re-prompts a quiet session with its request; the default delivers it in Herdr. */
  reprompt?: (record: ProducerRecord, message: string) => void;
} = {}) {
  const ledger = await readProducerLedger(root);
  const now = (dependencies.now ?? (() => new Date()))();
  const run = dependencies.run ?? ((command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const reprompt = dependencies.reprompt ?? ((record: ProducerRecord, message: string) => { deliverPrompt(record.agentName, message, run); });
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
    const finished = agents !== null && (!agent || ['done', 'idle', 'blocked'].includes(agent.agent_status ?? ''));
    const screen = () => readSessionScreen(record.agentName, run);
    // Acknowledgement is judged only from a Herdr that could be read; a submitted proof is the
    // strongest acknowledgement of all.
    if (agents !== null) {
      const judged = acknowledgeLaunch(record, agent, { now: now.getTime(), ackMs, result: results.some(result => result !== 'missing'), screen });
      if (judged.changed) changed++;
      if (judged.reprompt) {
        markReprompted(record, now.getTime()); changed++;
        try { reprompt(record, repromptText(producerPrompt(config, record, record), ackMs)); }
        catch { /* the settlement below records a session the re-prompt could not reach */ }
      }
    }
    let next: { state: ProducerRecord['state']; resolution: string } | null = null;
    if (results.some(result => result === 'fail')) next = { state: 'completed', resolution: `trusted evidence failed for ${record.proofs.filter(proof => outcome[proof] === 'fail').join(', ')}` };
    else if (results.every(result => result === 'pass')) next = { state: 'completed', resolution: `trusted passing evidence recorded for ${record.proofs.join(', ')}` };
    else if (request && request.state === 'cancelled') next = { state: 'cancelled', resolution: request.resolution ?? 'the control plane withdrew the request' };
    else if (item && (!item.candidate || item.candidate.sha !== record.sha || item.candidate.baseSha !== record.baseSha || item.policyRevision !== record.policyRevision)) next = { state: 'cancelled', resolution: `head changed from ${record.sha.slice(0, 12)} to ${item.candidate?.sha.slice(0, 12) ?? 'none'}` };
    else if (Date.parse(record.expiresAt) <= now.getTime()) next = { state: 'expired', resolution: `no trusted evidence for ${record.proofs.filter(proof => outcome[proof] !== 'pass').join(', ')} within ${config.run.producerTimeoutMinutes} minutes` };
    else if (finished) {
      if (!record.idleSince) { record.idleSince = now.toISOString(); changed++; }
      else if (now.getTime() - Date.parse(record.idleSince) >= producerIdleGraceMs && settlementDue(record, agent, { now: now.getTime(), ackMs })) {
        const missing = record.proofs.filter(proof => outcome[proof] !== 'pass').map(proof => `${proof} (${outcome[proof]})`).join(', ');
        const failure = agent?.agent_status === 'blocked'
          ? `the session ended waiting on input (Herdr reports it blocked) instead of deciding on its own, without trusted evidence for ${missing}`
          : `the session finished (${agent?.agent_status ?? 'gone from Herdr'}) without trusted evidence for ${missing}`;
        next = { state: 'failed', resolution: settlementReason(record, agent, { now: now.getTime(), ackMs, screen }, failure) };
      }
    } else if (record.idleSince) { delete record.idleSince; changed++; }
    if (!next) continue;
    let closeFailure: string | undefined;
    try { if (record.pane && (agent || agents === null)) closeHerdrPane(record.pane, run); }
    catch (error) { closeFailure = `Herdr could not close pane ${record.pane}: ${error instanceof Error ? error.message : 'unknown reason'}`; }
    record.closeFailure = closeFailure;
    if (!closeFailure) {
      // The session is gone, so its checkout goes with it — whatever the outcome. One that cannot
      // be removed is said so on the record and taken back by the next reclaim pass.
      const failure = await settleCheckout(root, record.checkout);
      if (failure) record.checkoutFailure = failure; else delete record.checkoutFailure;
      record.state = next.state; record.resolution = next.resolution; record.closedAt = now.toISOString();
    }
    changed++;
  }
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
  const live = [...producers.producers, ...reviews.reviews].filter(record => record.state === 'pending' && record.checkout).map(record => record.checkout!);
  return reclaimSessionCheckouts(root, worktreeRoot(root, config), live, { ...options, failure: writeFailure });
}

export function summarizeProducers(records: ProducerRecord[]) {
  const describe = (record: ProducerRecord) => ({ producer: record.id, requestId: record.requestId, attempt: record.attempt, work: record.key, pr: record.pr, sha: record.sha, policyRevision: record.policyRevision, group: record.group, proofs: record.proofs,
    profile: record.profile, principal: record.principal, agentName: record.agentName, state: record.state, outcome: record.outcome, requestedAt: record.requestedAt, expiresAt: record.expiresAt, closedAt: record.closedAt ?? null, resolution: record.resolution ?? null, attention: record.closeFailure ?? null,
    // GY-93: how the request reached the session, and whether the session has taken it up.
    delivery: record.delivery ?? null, activity: record.state === 'pending' ? sessionActivity(record) : null, acknowledgedAt: record.acknowledgedAt ?? null, repromptedAt: record.repromptedAt ?? null, neverStarted: neverStarted(record) });
  return { pending: records.filter(record => record.state === 'pending').map(describe), completed: records.filter(record => record.state !== 'pending').slice(-20).map(describe) };
}
