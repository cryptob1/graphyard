import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { accountLaunch, atomicPrivateWrite, closeHerdrPane, createdHerdrTab, deliverPrompt, herdrJson, loadMasterConfig, privateFile, readProducerCredential, selectAccount, sharedGitDirectory, stopCreatedHerdrTab, type EnvironmentProbe, type PromptDelivery, type HerdrAgent, type MasterConfig, type ProducerProfile } from './master.js';
import { implementerIdentities, type Work } from './model.js';
import type { DispatchRequest } from './model/dispatch.js';

/**
 * Producer sessions launched for the control plane's producer requests (model/dispatch.ts).
 *
 * A producer session is the proof counterpart of a reviewer session: one exact head, one proof
 * group, one principal whose evidence the control plane trusts by its grants and never by what
 * the session says. The session holds the producer's own credential file (a path in its
 * environment, never a value on a command line), works in a detached worktree it creates
 * outside every Graphyard worktree, and submits each proof with the exact head, base and policy
 * revision it was launched for. The ledger here records launch, completion and outcome per
 * session, which is what `master status` reports as running per candidate and since when.
 */

const sha40 = z.string().regex(/^[0-9a-f]{40}$/i);
export const producerOutcomes = ['pass', 'fail', 'untrusted', 'missing'] as const;
export type ProducerOutcome = typeof producerOutcomes[number];
export const producerRecordSchema = z.object({
  id: z.string().uuid(),
  /** The control-plane producer request this session answers; one session per request id. */
  requestId: z.string().min(1).max(64),
  key: z.string().min(1).max(40), pr: z.number().int().positive(),
  sha: sha40, baseSha: sha40, policyRevision: z.number().int().nonnegative(),
  group: z.string().min(1).max(40), proofs: z.array(z.string().min(1).max(200)).min(1).max(50),
  profile: z.string().min(1).max(80), principal: z.string().min(1).max(200), agentName: z.string().min(1).max(100),
  pane: z.string().min(1).max(200).nullable(),
  requestedAt: z.string().min(1).max(40), expiresAt: z.string().min(1).max(40),
  state: z.enum(['pending', 'completed', 'cancelled', 'expired', 'failed']),
  /** What the control plane holds for each proof of the group, as last reconciled. */
  outcome: z.record(z.string(), z.enum(producerOutcomes)).default({}),
  /** When the session was first seen finished by Herdr without every proof submitted. */
  idleSince: z.string().min(1).max(40).optional(),
  resolution: z.string().min(1).max(500).optional(),
  closedAt: z.string().min(1).max(40).optional(),
  closeFailure: z.string().min(1).max(500).optional(),
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

export function producerPrompt(config: MasterConfig, binding: ProducerBinding, profile: Pick<ProducerProfile, 'principal'>) {
  const worktree = `/tmp/graphyard-proof-${binding.key.toLowerCase()}-${binding.sha.slice(0, 7)}`;
  const evidenceFile = (proof: string) => `${worktree}-${proof.replace(/[^a-zA-Z0-9]+/g, '-')}.evidence.json`;
  return `You are an independent Graphyard proof producer for ${config.repository}, principal ${profile.principal}. Produce trusted evidence for work item ${binding.key} (pull request #${binding.pr}) at exact head ${binding.sha} against base ${binding.baseSha} under policy revision ${binding.policyRevision}, for the ${binding.group} proof group: ${binding.proofs.join(', ')}. `
    + `Your Graphyard credential is the file named by GRAPHYARD_TOKEN_FILE and is used only by node ${config.cliPath}; never print, copy, cat, or echo it or any other credential, and never read .graphyard/connection.json, .graphyard/credentials.json, .env, or anything under ~/.config. `
    + `Work in a detached worktree of the exact head, never in this checkout and never under .graphyard/worktrees: git fetch origin ${binding.sha} && git worktree add --detach ${worktree} ${binding.sha}. Install and build there, then run what establishes each proof — start from the tests and scripts named for the proof (grep the proof name under tests/ and scripts/) and the acceptance criteria in node ${config.cliPath} status ${binding.key} — with every GRAPHYARD_* and HERDR_* variable unset for the project's own test runs and a free GRAPHYARD_TEST_PORT. `
    + 'Do not edit, commit, push, rebase or merge the candidate, do not claim Graphyard work, do not post a review, and never weaken, skip or narrow a test to make a proof pass. '
    + `For each proof write a JSON file such as ${evidenceFile(binding.proofs[0])} of the form {"proof":"${binding.proofs[0]}","sha":"${binding.sha}","baseSha":"${binding.baseSha}","policyRevision":${binding.policyRevision},"result":"pass"|"fail","executed":N,"skipped":0,"environment":"<runtime and how it was produced>","scopeFiles":["<paths the proof depends on>"]} — exactly this sha, baseSha and policyRevision, executed as the number of cases actually run, and a failing or incomplete run submitted as result fail rather than omitted — and submit it with node ${config.cliPath} evidence ${binding.key} FILE. `
    + `When every proof of the group is submitted, remove the worktree with git worktree remove --force ${worktree}, print a one-paragraph summary naming each proof and its result, and stop; Graphyard closes this session once it observes the evidence.`;
}

export async function launchProducer(root: string, work: Work, request: DispatchRequest, profile: ProducerProfile, agents: { name?: string }[], observedAt: string, dependencies: {
  run?: (command: string, args: string[]) => string;
  now?: () => Date;
  /** How the profile's agent accounts are checked before the launch, and how its prompt is confirmed. */
  probe?: EnvironmentProbe;
  prompt?: PromptDelivery;
} = {}) {
  const now = dependencies.now ?? (() => new Date());
  const config = await loadMasterConfig(root);
  const binding = assertProducerCandidate(work, request, observedAt);
  if (!config.producers.some(item => item.name === profile.name)) throw new Error(`Unknown producer profile ${profile.name}`);
  if (!independentProducerProfiles(work, [profile]).length) throw new Error(`Producer principal ${profile.principal} has held an assignment on ${work.key}; its evidence would not be trusted`);
  const ledger = await readProducerLedger(root);
  const pending = ledger.producers.find(record => record.state === 'pending' && record.key === work.key && record.group === binding.group);
  if (pending) throw new Error(`A producer session for ${work.key} ${binding.group} proofs is already pending on ${pending.sha.slice(0, 7)}; reconcile it with master status before launching another`);
  if (ledger.producers.some(record => record.requestId === request.id)) throw new Error(`Request ${request.id} was already launched for ${work.key}; one session per request`);
  if (agents.some(agent => agent.name === profile.agentName)) throw new Error(`Producer agent ${profile.agentName} is already visible in Herdr`);
  await readProducerCredential(root, profile.credentialFile);
  const selected = await selectAccount(config, 'producer', profile, { ...dependencies.probe, work: work.key });
  // A producer builds in a detached worktree under /tmp that commits into the repository's Git directory.
  const launch = accountLaunch(profile, selected.account, { writable: ['/tmp', sharedGitDirectory(root)].filter((path): path is string => !!path) });
  let pane: string | undefined, tabId: string | undefined;
  try {
    const environment = { ...launch.environment, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_PRODUCER: `${binding.key}@${binding.sha}` };
    const created = createdHerdrTab(herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root,
      '--label', `${binding.key} ${binding.group} proofs · ${profile.agentName}`, ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]), '--no-focus'], dependencies.run));
    pane = created.pane; tabId = created.tab;
    herdrJson(['agent', 'start', profile.agentName, '--kind', launch.kind!, '--pane', created.pane, '--', ...launch.args], dependencies.run);
    deliverPrompt(profile.agentName, producerPrompt(config, binding, profile), dependencies.run, dependencies.prompt);
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    if (pane || tabId || malformedTab) try { stopCreatedHerdrTab(pane, tabId ?? malformedTab, dependencies.run); }
      catch { throw new Error(`${error instanceof Error ? error.message : 'Producer launch failed'}; Herdr could not confirm cleanup of the created tab`); }
    throw error;
  }
  const requestedAt = now();
  const record: ProducerRecord = producerRecordSchema.parse({ id: randomUUID(), requestId: request.id, key: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision,
    group: binding.group, proofs: binding.proofs, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: pane ?? null,
    requestedAt: requestedAt.toISOString(), expiresAt: new Date(requestedAt.getTime() + config.run.producerTimeoutMinutes * 60_000).toISOString(), state: 'pending', outcome: Object.fromEntries(binding.proofs.map(proof => [proof, 'missing'])) });
  await saveProducerLedger(root, { ...ledger, producers: [...ledger.producers, record] });
  return { producer: record.id, requestId: request.id, work: binding.key, pr: binding.pr, sha: binding.sha, baseSha: binding.baseSha, policyRevision: binding.policyRevision, group: binding.group, proofs: binding.proofs,
    profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: record.pane, expiresAt: record.expiresAt, approvals: launch.plan.approvals,
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
 */
/** `agents` is null when Herdr could not be read: a session is then never judged finished. */
export async function reconcileProducers(root: string, config: MasterConfig, work: Work[], agents: HerdrAgent[] | null, dependencies: {
  run?: (command: string, args: string[]) => string;
  now?: () => Date;
} = {}) {
  const ledger = await readProducerLedger(root);
  const now = (dependencies.now ?? (() => new Date()))();
  const run = dependencies.run ?? ((command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
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
    let next: { state: ProducerRecord['state']; resolution: string } | null = null;
    if (results.some(result => result === 'fail')) next = { state: 'completed', resolution: `trusted evidence failed for ${record.proofs.filter(proof => outcome[proof] === 'fail').join(', ')}` };
    else if (results.every(result => result === 'pass')) next = { state: 'completed', resolution: `trusted passing evidence recorded for ${record.proofs.join(', ')}` };
    else if (request && request.state === 'cancelled') next = { state: 'cancelled', resolution: request.resolution ?? 'the control plane withdrew the request' };
    else if (item && (!item.candidate || item.candidate.sha !== record.sha || item.candidate.baseSha !== record.baseSha || item.policyRevision !== record.policyRevision)) next = { state: 'cancelled', resolution: `head changed from ${record.sha.slice(0, 12)} to ${item.candidate?.sha.slice(0, 12) ?? 'none'}` };
    else if (Date.parse(record.expiresAt) <= now.getTime()) next = { state: 'expired', resolution: `no trusted evidence for ${record.proofs.filter(proof => outcome[proof] !== 'pass').join(', ')} within ${config.run.producerTimeoutMinutes} minutes` };
    else if (finished) {
      if (!record.idleSince) { record.idleSince = now.toISOString(); changed++; }
      else if (now.getTime() - Date.parse(record.idleSince) >= producerIdleGraceMs) next = { state: 'failed', resolution: `the session finished (${agent?.agent_status ?? 'gone from Herdr'}) without trusted evidence for ${record.proofs.filter(proof => outcome[proof] !== 'pass').map(proof => `${proof} (${outcome[proof]})`).join(', ')}` };
    } else if (record.idleSince) { delete record.idleSince; changed++; }
    if (!next) continue;
    let closeFailure: string | undefined;
    try { if (record.pane && (agent || agents === null)) closeHerdrPane(record.pane, run); }
    catch (error) { closeFailure = `Herdr could not close pane ${record.pane}: ${error instanceof Error ? error.message : 'unknown reason'}`; }
    record.closeFailure = closeFailure;
    if (!closeFailure) { record.state = next.state; record.resolution = next.resolution; record.closedAt = now.toISOString(); }
    changed++;
  }
  if (changed) await saveProducerLedger(root, ledger);
  return { producers: ledger.producers, changed };
}

export function summarizeProducers(records: ProducerRecord[]) {
  const describe = (record: ProducerRecord) => ({ producer: record.id, requestId: record.requestId, work: record.key, pr: record.pr, sha: record.sha, policyRevision: record.policyRevision, group: record.group, proofs: record.proofs,
    profile: record.profile, principal: record.principal, agentName: record.agentName, state: record.state, outcome: record.outcome, requestedAt: record.requestedAt, expiresAt: record.expiresAt, closedAt: record.closedAt ?? null, resolution: record.resolution ?? null, attention: record.closeFailure ?? null });
  return { pending: records.filter(record => record.state === 'pending').map(describe), completed: records.filter(record => record.state !== 'pending').slice(-20).map(describe) };
}
