// Concern: the master's own identity and its commands — onboarding it, and applying intent with it at once.
import { randomUUID, randomBytes } from 'node:crypto';
import { wholeDocument } from '../model/work-summary.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { localDirectory } from '../onboarding.js';
import { writeHarnessPermissions } from '../harness.js';
import type { Work } from '../model.js';
import { type EnvironmentKind, environmentKinds, type MasterConfig, masterConfigSchema } from './profiles.js';
import { externalCredential, loadStoredMasterConfig } from './config.js';
import { assertOutsideWorktrees, atomicPrivateText, atomicPrivateWrite, readCredentialFile } from '../private-file.js';
import { setupAgentEnvironments } from './environments.js';
import { withLaunchedRuntime } from './launch.js';
import type { HerdrAgent } from './herdr.js';
import { herdrAttach } from './dispatch.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { registeredLaunch } from '../model/session-state.js';
import { liveReviewRequest } from '../model/dispatch.js';
import { autonomyPlan, autonomyReason, humanOnlyDecisions, masterHarness } from './harness.js';
import { attemptKey, unblockWithRetry } from './unblock.js';
import { restartMasterLoop } from './loop-restart.js';

type AutonomyFetch = typeof fetch;
async function adminCall(config: MasterConfig, token: string, fetcher: AutonomyFetch, path: string, body?: unknown) {
  const response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? 'unknown'}`);
  return result;
}
async function identityHolds(config: MasterConfig, file: string, id: string, fetcher: AutonomyFetch) {
  try { return (await adminCall(config, await readCredentialFile(file), fetcher, 'status')).actor?.id === id; } catch { return false; }
}
/**
 * Onboarding for autonomy: provision (or repair) the master's operator-agent identity, store its
 * credential beside the coordinator's, record it in the master configuration, and install the
 * master's harness rules. The admin credential is read once from stdin and never stored. Without
 * `apply` it reports the plan and changes nothing.
 */
export async function setupAutonomy(root: string, input: { adminToken?: string; apply: boolean; harness?: string }, fetcher: AutonomyFetch = fetch) {
  const config = await loadStoredMasterConfig(root);
  const plan = autonomyPlan(config);
  const identities = [plan.operatorAgent];
  const describe = identities.map(({ id, capabilities, credentialFile, role }) => ({ id, capabilities, credentialFile, role }));
  if (!input.apply) return { applied: false, identities: describe, humanOnly: humanOnlyDecisions, harness: await writeHarnessPermissions(root, masterHarness(root, config, input.harness ?? 'claude'), false),
    next: 'Rerun with --apply and the admin credential on stdin: graphyard master autonomy --admin-token-stdin --apply' };
  if (!input.adminToken || input.adminToken.length < 32) throw new Error('Autonomy setup needs the admin credential once, on stdin; it is used to provision the master identity and is never stored');
  const status = await adminCall(config, input.adminToken, fetcher, 'status');
  if (status.actor?.role !== 'admin') throw new Error('Autonomy setup needs the admin credential; it provisions operator-agent identities, which only an admin may create');
  const existing: any[] = await adminCall(config, input.adminToken, fetcher, 'operator-agents');
  const changes: string[] = [];
  for (const identity of identities) {
    const current = existing.find(document => document.id === identity.id);
    if (current?.revokedAt) throw new Error(`${identity.id} was revoked; choose another identity in .graphyard/master.json or restore it through the operator-agent API`);
    const body = { capabilities: identity.capabilities, scope: identity.scope, reason: autonomyReason };
    // Compared as sets: the server stores these in jsonb, which keeps neither key nor entry order.
    const same = (left: string[] = [], right: string[] = []) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
    if (current && (!same(current.capabilities, identity.capabilities) || !same(current.scope?.repositories, identity.scope.repositories) || !same(current.scope?.workItems, identity.scope.workItems))) {
      await adminCall(config, input.adminToken, fetcher, `operator-agents/${encodeURIComponent(identity.id)}/configure`, { expectedRevision: current.revision, ...body });
      changes.push(`${identity.id}: capabilities set to ${identity.capabilities.join(', ')}`);
    }
    if (current && await identityHolds(config, identity.credentialFile, identity.id, fetcher)) continue;
    const token = randomBytes(32).toString('hex');
    if (current) await adminCall(config, input.adminToken, fetcher, `operator-agents/${encodeURIComponent(identity.id)}/rotate`, { token, transitionSeconds: 0, reason: autonomyReason });
    else await adminCall(config, input.adminToken, fetcher, 'operator-agents', { id: identity.id, displayName: identity.displayName, token, ...body });
    await atomicPrivateText(identity.credentialFile, token);
    await assertOutsideWorktrees(root, identity.credentialFile, `${identity.id} credential file`);
    changes.push(`${identity.id}: ${current ? 'credential rotated' : 'provisioned'}`);
  }
  const next = { ...config, supervision: 'autonomous' as const, operatorAgent: { id: plan.operatorAgent.id, credentialFile: plan.operatorAgent.credentialFile } };
  await atomicPrivateWrite(resolve(await localDirectory(root), 'master.json'), masterConfigSchema.parse(next));
  const harness = await writeHarnessPermissions(root, masterHarness(root, next, input.harness ?? 'claude'), true);
  return { applied: true, identities: describe, changes, humanOnly: humanOnlyDecisions, harness,
    next: 'The master now applies every decision with its operator-agent identity: graphyard master create, release, unblock, requirements, rework, attest and close' };
}
export async function agentToken(root: string, config: MasterConfig, _which: 'operatorAgent' = 'operatorAgent') {
  const identity = config.operatorAgent;
  if (!identity) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply');
  await externalCredential(root, identity.credentialFile, 'Operator-agent');
  return readCredentialFile(identity.credentialFile);
}
/**
 * Fill the binding an intent needs from the item's current state, so the master names the change
 * and its reason and Graphyard supplies the exact revision or candidate it binds to.
 */
export function intentInput(action: 'requirements' | 'attest', work: Work, input: Record<string, unknown>) {
  if (action === 'requirements') return { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], ...input };
  if (!work.candidate) throw new Error(`${work.key} has no candidate to attest`);
  return { sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, result: 'pass', executed: 1, skipped: 0, ...attestationExercise(work, input.proof), ...input };
}
/**
 * GY-523. The exercise record an attestation carries: the proof run against the candidate base —
 * the tree with the change, and so the criterion's behaviour, removed — failed. Without it the
 * control plane records the attested pass as not exercising its criterion (GY-135). The behaviour
 * removed is the candidate's diff against its base, named by both commits, and `executed: 1` is the
 * floor the master's one confirming run guarantees; a master that measured more names its own `exercise`.
 */
export function attestationExercise(work: Pick<Work, 'criteria' | 'candidate'>, proof: unknown) {
  const criterion = work.criteria.find(entry => typeof proof === 'string' && entry.proofs.includes(proof));
  if (!criterion || !work.candidate) return {};
  return { exercise: { criterion: criterion.id, behaviour: `the diff of candidate ${work.candidate.sha.slice(0, 12)} against the candidate base ${work.candidate.baseSha.slice(0, 12)}; the proof fails on that base, as the master confirmed by running it`, result: 'fail' as const, executed: 1 } };
}


/**
 * `master review` registers the reviewer session before its runtime starts (GY-172 AC-2), keyed on
 * the review request it answers, as the loop's own reviewer launches are; the pane and name the
 * launcher returns are written over the registration once it has started. `launch` is the reviewer
 * launcher itself, which still refuses an unknown item or profile with its own reason.
 */
export async function registeredReview<T>(config: MasterConfig, args: string[], snapshot: { work: Work[] }, mutate: (path: string, body: unknown) => Promise<unknown>, launch: () => Promise<T>) {
  const work = snapshot.work.find(item => item.id === args[0] || item.key === args[0]);
  const profile = args[1] ? config.reviewers.find(entry => entry.name === args[1]) : config.reviewers.length === 1 ? config.reviewers[0] : undefined;
  if (!work?.candidate || !profile) return launch();
  const request = liveReviewRequest(work), sha = work.candidate.sha, id = request?.id ?? `review:${sha}`;
  // A reviewer another launch registered for this request is not this call's to close: the control plane refuses to register over
  // or close a running handle another attempt's token holds, checked in its mutation, not this shared snapshot. A running handle
  // with no token predates that rule, so it is left alone here.
  if (work.sessions?.some(handle => handle.id === id && handle.state === 'running' && handle.head === sha && !handle.launch)) return launch();
  const handle: SessionHandleInput = { id, kind: 'review', role: 'review', head: sha, runtime: profile.kind, host: config.hostId,
    ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}), subject: `${work.key}: review ${sha.slice(0, 12)} (PR #${work.candidate.pr})`, state: 'running' };
  // The coordinates carry the runtime the launch started, not the profile's (GY-1306).
  return registeredLaunch(handle => mutate(`work/${work.id}/session`, handle), handle,
    withLaunchedRuntime(handle, launch), launched => launched as { pane?: string | null; agentName?: string | null }, pane => herdrAttach(pane, config.herdrWorkspace));
}

export const autonomySubcommands = ['autonomy', 'create', 'release', 'unblock', 'defer', 'requirements', 'rework', 'attest', 'restart', 'environments'] as const;
export interface AutonomyDependencies {
  coordinator: (path: string) => Promise<any>;
  readSecret: () => Promise<string>;
  agents: () => HerdrAgent[] | Promise<HerdrAgent[]>;
  daemonLock: () => Promise<{ pid: number; host: string; heartbeatAt: string } | null>;
  fetcher?: typeof fetch;
}
const words = (args: string[]) => args.join(' ').trim();
async function jsonArgument(value: string) { return JSON.parse(value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value); }
/**
 * The autonomy subcommands of `graphyard master`: onboarding the master identity, the intent it
 * applies at once and the loop restart. Each authenticates as the identity the
 * command belongs to, never as another.
 */
export async function runAutonomyCommand(root: string, config: MasterConfig, id: string, args: string[], deps: AutonomyDependencies) {
  if (!(autonomySubcommands as readonly string[]).includes(id)) throw new Error(`Unknown autonomy command ${id}`);
  const fetcher = deps.fetcher ?? fetch, call = async (token: string, path: string, body?: unknown, key = attemptKey(1)) => {
    const response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const operator = () => agentToken(root, config, 'operatorAgent');
  const snapshotItem = async (key: string | undefined) => {
    if (!key) throw new Error(`Use master ${id} GY-N …`);
    const snapshot = await deps.coordinator('work-snapshot'), found = snapshot.work.find((work: Work) => work.id === key || work.key === key);
    // A settled delivery is a summary in the snapshot (GY-422); intent reads its whole document.
    if (!found) throw new Error(`Unknown work item ${key}`); return wholeDocument(found, deps.coordinator);
  };
  const item = snapshotItem;
  const reason = (rest: string[]) => { const text = words(rest); if (!text) throw new Error(`master ${id} needs a REASON; every agent decision is attributable`); return text; };
  if (id === 'environments') {
    // The agent accounts sessions run on: discover or create them, report login and quota, and
    // with --apply generate profiles from the logged-in ones (see setupAgentEnvironments).
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const create = (value('--create') ?? '').split(',').filter(Boolean) as EnvironmentKind[];
    if (create.some(kind => !environmentKinds.includes(kind))) throw new Error(`master environments --create takes ${environmentKinds.join(', ')}`);
    return setupAgentEnvironments(root, { directory: value('--directory'), create, apply: args.includes('--apply'), verify: token => call(token, 'status'), registry: () => deps.coordinator('agent-registry/document') });
  }
  if (id === 'autonomy') {
    const apply = args.includes('--apply'), harness = args[args.indexOf('--harness') + 1];
    if (apply && !args.includes('--admin-token-stdin')) throw new Error('Use master autonomy --admin-token-stdin --apply so the admin credential is not stored in shell history');
    return setupAutonomy(root, { apply, adminToken: apply ? await deps.readSecret() : undefined, ...(args.includes('--harness') ? { harness } : {}) }, fetcher);
  }
  if (id === 'create') {
    if (!args[0]) throw new Error('Use master create FILE REASON');
    const input = await jsonArgument(`@${args[0]}`);
    return call(await operator(), 'work', { ...input, reason: reason(args.slice(1)) });
  }
  if (id === 'release' || id === 'unblock') {
    const work = await item(args[0]), text = reason(args.slice(1)), write = async (work: Work, attempt = 1) => call(await operator(), `work/${work.id}/${id === 'release' ? 'ready' : 'unblock'}`, { expectedRevision: work.revision, reason: text }, attemptKey(attempt));
    return id === 'release' ? write(work) : unblockWithRetry(work, write, item);
  }
  if (id === 'defer') {
    // GY-1740: an unleased post-deploy follow-up held on the instant its reading can first exist; its blocker cleared in the same write.
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master defer GY-N NOT-BEFORE REASON');
    return call(await operator(), `work/${work.id}/window`, { notBefore: args[1], reason: reason(args.slice(2)), expectedRevision: work.revision });
  }
  if (id === 'requirements') {
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master requirements GY-N FILE REASON');
    const input = intentInput('requirements', work, await jsonArgument(`@${args[1]}`));
    return call(await operator(), `work/${work.id}/requirements`, { ...input, reason: reason(args.slice(2)) });
  }
  if (id === 'rework') {
    const work = await item(args[0]);
    return call(await operator(), `work/${work.id}/rework`, { reason: reason(args.slice(1)), previousWorkerStopped: true });
  }
  if (id === 'attest') {
    // A manual: proof no producer may run, attested by the master on the exact current head.
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master attest GY-N PROOF REASON');
    return call(await operator(), `work/${work.id}/evidence`, intentInput('attest', work, { proof: args[1], reason: reason(args.slice(2)) }));
  }
  return restartMasterLoop(root, config, await deps.daemonLock());
}
