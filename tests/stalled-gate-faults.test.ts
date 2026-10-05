import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import type { ActionRecord, ActionRow } from '../src/model/actions.js';
import { reconcileActions } from '../src/model/actions.js';
import { actionStall } from '../src/model/action-progress.js';
import { resyncUnobservedPrefix } from '../src/model/action-kinds.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { evaluate } from '../src/model/gates.js';
import { stalledActionAttention } from '../src/cli/master-status.js';
import { actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import { faultClassOf, workFaults } from '../src/model/fault-classes.js';
import { restatements } from '../src/daemon/faults.js';
import { actionStallThreshold } from '../src/model/action-progress.js';
// The executor process as it runs in production: its modules loaded by its own entry point, one
// `tsImport` each, and its effects built by the same function (scripts/graphyard-executor.mjs).
// @ts-expect-error The standalone executor is a dependency-free entry point script.
import { controlPlaneEffects, load } from '../scripts/graphyard-executor.mjs';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1090 names this file for its proof: manual:fault-class-stalled-gate. The master loop filed 61
// stalled-gate faults in 24 hours on 1 October 2026 — an item holding a failing gate with nothing
// moving it. Every instance was the same misreading: something WAS moving it, a handoff the control
// plane had already made, and the reading could not see it.
//
//   - resync: the claim woke the item's observation job, which was due and queued for a worker; three
//     claims inside the minutes the job takes failed with one reason and read as a stall;
//   - dispatch: the loop's own producer session already answered the requested head, and the
//     executor's check for exactly that (GY-415) never matched — its process loads producer.ts twice,
//     so `instanceof` compared two different classes;
//   - request-review: the loop's reviewer session already answered the requested head, and the
//     executor had no check for it at all;
//   - actorless: a `request-rework` row was open for the verdict standing on the head, or Graphyard had
//     just restored the branch and its observation was owed, and neither counted as an actor.
//
// Each instance the item lists is replayed here from the ledger, as it stood at the instant the loop
// recorded it (tests/fixtures/gy-1090-stalled-gate.json, read from `graphyard events`), and asserted
// not to recur. Against the base each subtest fails: the instance reproduces.

interface Instance {
  id: string; at: string; kind: 'stalled-action' | 'actorless'; subject: string;
  /**
   * For a stalled action: the row's kind, its unchanged reason, and the instant of every failure in
   * the run the instance belongs to, oldest first — up to the instant the loop recorded it
   * (`detected` of them) and on until the run ended, so no point of the run is left unreplayed.
   */
  action?: 'resync' | 'dispatch' | 'request-review'; reason?: string; failures?: string[]; detected?: number;
  /** For a session already answering: the full head the request and the session are bound to, and the proofs asked for. */
  sha?: string; group?: string; proofs?: string[];
}
const instances: Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1090-stalled-gate.json', import.meta.url)), 'utf8'));
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const base = '55193b8c5915665695b2205451be306005418a6d';
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
// Written out rather than imported, so this file loads against the base and each instance there
// fails on its own assertion: the clause a scheduled, unheld, error-free job is named by, and the
// bound its wait keeps (src/model/action-kinds.ts).
const observationJobScheduled = 'its observation job is scheduled and records no error, yet saved no observation';
const observationWaitBoundMs = 30 * 60_000;

test('manual:fault-class-stalled-gate — the item lists 61 instances, and every one is replayed below', () => {
  assert.equal(instances.length, 61);
  assert.equal(new Set(instances.map(instance => instance.id)).size, 61);
  const shapes = instances.map(instance => instance.kind === 'actorless' ? 'actorless' : instance.action);
  assert.deepEqual([...new Set(shapes)].sort(), ['actorless', 'dispatch', 'request-review', 'resync']);
});

// ---- resync: an observation job the claim woke, queued for a worker -------------------------------

/** The resync row as the ledger records it: requested, then each claim and its failure. */
function resyncRow(instance: Instance): ActionRow {
  const failures = instance.failures!;
  const history: ActionRecord[] = [{ at: shift(failures[0], -90_000), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: `${instance.subject} is waiting on a fresh reading of its pull request` }];
  failures.forEach((at, index) => history.push(
    { at: shift(at, -20_000), event: 'claimed', requester: 'graphyard', executor: 'graphyard-master@vishrog/1', result: null, reason: `attempt ${index + 1} claimed by graphyard-master@vishrog/1 on vishrog` },
    { at, event: 'failed', requester: 'graphyard', executor: 'graphyard-master@vishrog/1', result: 'failed', reason: instance.reason! }));
  return { id: `resync-${instance.id}`, kind: 'resync', work: `work-${instance.subject}`, key: instance.subject, gate: 'merge', refusal: 'GitHub observation missing or older than two minutes',
    reason: `${instance.subject} is waiting on a fresh reading of its pull request`, binding: 'resync', inputs: { kind: 'resync', pr: 1, sha: null, baseSha: null, baseTip: null, observedAt: null },
    requestedBy: 'graphyard', requestedAt: history[0].at, state: 'pending', claim: null, attempts: failures.length, history, result: 'failed', resolution: instance.reason, resolvedAt: failures.at(-1) } as ActionRow;
}

for (const instance of instances.filter(entry => entry.action === 'resync')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: a resync waiting on the observation job its claim woke is not a stall inside the job's bound`, () => {
    assert.ok(instance.reason!.startsWith(`${instance.subject}: ${resyncUnobservedPrefix}; ${observationJobScheduled};`), 'the recorded reason names a scheduled job with no hold and no error');
    // At the instant the loop recorded it, master status raises nothing for the row.
    const detected = resyncRow({ ...instance, failures: instance.failures!.slice(0, instance.detected) });
    const work = { id: detected.work, key: instance.subject, title: instance.subject, stage: 'merge', actionQueue: { actions: [detected], history: [] } } as unknown as Work;
    assert.deepEqual(stalledActionAttention({ work: [work], now: instance.at }).filter(entry => entry.subject === instance.subject), [], 'master status raises no stalled-action attention');
    // Nor at any later failure of the same run, up to the observation that ended it.
    for (let count = 1; count <= instance.failures!.length; count++) {
      const failures = instance.failures!.slice(0, count);
      assert.equal(actionStall(resyncRow({ ...instance, failures })), null, `${count} failure(s) over ${Math.round((Date.parse(failures.at(-1)!) - Date.parse(failures[0])) / 1000)}s are a wait in progress`);
    }
    // Not weakened: the same row, still unobserved once the run outlasts the bound, is a stall.
    const outlasted = resyncRow({ ...instance, failures: [shift(instance.failures!.at(-1)!, -observationWaitBoundMs), ...instance.failures!.slice(1)] });
    assert.ok(actionStall(outlasted), 'a woken job that saves nothing for longer than the bound still stalls the row');
  });
}

// ---- dispatch and request-review: a session the loop launched already answers the head -------------

const herdr = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });

/** The item as submitted and observed at `at` — now, for a launch, whose candidate must be freshly observed. */
function submitted(instance: Instance, extra: Partial<Work> = {}, at = new Date(Date.now() - 60_000).toISOString()): Work {
  const pr = 500 + instances.indexOf(instance);
  const candidate = { sha: instance.sha!, baseSha: base, pr, branch: `graphyard/${instance.subject.toLowerCase()}-1`, author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at,
    prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true } as unknown as Observation;
  return { id: `work-${instance.id}`, key: instance.subject, title: instance.subject, description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: instance.proofs ?? ['unit:x'] }], producerProofs: (instance.proofs ?? []).filter(proof => proof.startsWith('manual:')), policy: { checks: [], review: true, reviewProvider: 'github' }, stage: 'review', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: `/w/${instance.subject}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }], violations: [], ...extra } as unknown as Work;
}

// Loaded once, as the executor process loads them once at its start.
let executorModules: ReturnType<typeof load> | undefined;
let reviewerKey: string | undefined;
/** A coordinator checkout with one producer profile and a bound reviewer App, as the executor host has. */
async function executorHost() {
  const root = await temporaryDirectory('gy-1090'), credentials = await temporaryDirectory('gy-1090-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const modules = await (executorModules ??= load());
  const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await modules.master.setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, status as typeof fetch);
  const credential = join(credentials, 'producer.token'); await writeFile(credential, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await modules.master.saveProducerProfile(root, { name: 'claude-producer', principal: 'proof-runner', agentName: 'produce-claude-1', kind: 'claude', credentialFile: credential, concurrency: 4 },
    async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'manual:*'] } }));
  const privateKey = reviewerKey ??= generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  await modules.reviewer.bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') },
    async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await modules.reviewer.saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude', concurrency: 2 });
  const loaded = await modules.master.loadMasterConfig(root);
  const config = { ...loaded, run: { ...loaded.run, reviewerProfile: 'claude-reviewer' } };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  return { root, modules, config, mint, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** The executor's handlers over one item, wired exactly as `scripts/graphyard-executor.mjs` wires them. */
function executorHandlers(host: Awaited<ReturnType<typeof executorHost>>, item: Work) {
  const snapshot = async () => ({ work: [item], now: new Date().toISOString() });
  const effects = controlPlaneEffects(host.modules, { root: host.root, current: () => host.config, run: herdr, snapshot, mutate: async () => ({}) });
  return host.modules.executor.controlPlaneHandlers(() => host.config, { ...effects, agents: async () => [], recordSession: undefined,
    producerCredentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])) });
}
const executor = { id: 'graphyard-master@vishrog/1', host: 'vishrog' };

// The proof-dispatch instances cannot recur at all since GY-1235: proofs gate nothing (unit tests run
// in CI, e2e in UAT), so dispatch opens no producer request for the executor to claim on any head.
for (const instance of instances.filter(entry => entry.action === 'dispatch')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: no producer request is opened on ${instance.sha!.slice(0, 7)}, so no proof dispatch can stall`, () => {
    assert.match(instance.reason!, new RegExp(`^A producer session for ${instance.subject} ${instance.group} proofs is already pending on ${instance.sha!.slice(0, 7)};`));
    const item = submitted(instance);
    reconcileAutoDispatch(item, [item], new Date());
    assert.deepEqual(item.autoDispatch?.producers ?? [], []);
  });
}

for (const instance of instances.filter(entry => entry.action === 'request-review')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: the executor's request-review settles on the reviewer session the loop launched on ${instance.sha!.slice(0, 7)}`, async () => {
    assert.match(instance.reason!, new RegExp(`^A reviewer session for ${instance.subject} is already pending on ${instance.sha!.slice(0, 7)} .*one review request is answered by one session`));
    const host = await executorHost();
    try {
      // A review is requested once the head's mechanical proofs pass (GY-115).
      const item = submitted(instance, { evidence: [{ id: 'evidence-1', proof: 'unit:x', sha: instance.sha!, baseSha: base, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: new Date().toISOString() }] } as Partial<Work>);
      reconcileAutoDispatch(item, [item], new Date());
      const request = item.autoDispatch!.review!;
      assert.equal(request.sha, instance.sha);
      // The loop's tick launches the session first, from its own process.
      await host.modules.reviewer.launchReview(host.root, item, 'claude-reviewer', [], new Date().toISOString(), { run: herdr, mint: host.mint, requestId: request.id });
      const handlers = executorHandlers(host, item);
      const action = { id: `row-${instance.id}`, key: item.key, work: item.id, kind: 'request-review', gate: 'review', state: 'claimed', attempts: 1, history: [],
        inputs: { kind: 'request-review', provider: 'github', requestId: request.id, pr: request.pr, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision } } as unknown as ActionRow;
      for (const _failure of instance.failures!) assert.match(String(await handlers['request-review']!(action, executor)), new RegExp(`${instance.subject}'s review of ${instance.sha!.slice(0, 12)} is left to reviewer session \\S+ already answering that head`));
      assert.equal((await host.modules.reviewer.readReviewLedger(host.root)).reviews.length, 1, 'no second session was launched');
    } finally { await host.cleanup(); }
  });
}

// ---- actorless: a step the control plane already named --------------------------------------------

const reviewerBot = 'graphyard-reviewer[bot]';
/** A submitted item as the record held it at the instant: gates evaluated, dispatch and action queue reconciled. */
function recorded(work: Work, at: string) {
  const now = new Date(at);
  Object.assign(work, evaluate(work, [work], now, [15368]));
  reconcileAutoDispatch(work, [work], now);
  reconcileActions(work, [work], now);
  return work;
}

for (const instance of instances.filter(entry => entry.kind === 'actorless')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: the submission is not actorless while the step it owes is already named`, () => {
    const verdictAt = shift(instance.at, -6 * 60_000);
    const work = instance.subject === 'GY-971'
      // Ejected from the merge queue, the branch restored to its own head off the speculative tip the
      // record still names; the observation the restore woke has not run yet.
      ? (() => {
        const tip = '424d5a53da9b'.padEnd(40, '0'), own = '5c7065bcf08a357ff8b50ddba402c2bc1f9d491b';
        const item = submitted({ ...instance, sha: tip, proofs: ['unit:mechanical-findings-auto-fixed', 'unit:mechanical-mislabel-caught'] }, {}, shift(instance.at, -15 * 60_000));
        item.observation!.at = shift(instance.at, -5 * 60_000 - 13_000);
        item.baseRefresh = { from: { sha: tip, baseSha: base }, base, baseTree: base, policyRevision: 1, at: shift(instance.at, -5 * 60_000 + 6_000), head: own, conflict: null, carry: null,
          restore: { contaminated: tip, foreign: ['GY-1'], own, cause: 'ejection', requested: null, reason: `ejected from the merge queue: Landing speculative tip ${tip.slice(0, 12)} on ${base.slice(0, 12)} would revert work outside its planned files`, performedAt: shift(instance.at, -5 * 60_000 + 6_000), outcome: 'restored' } } as Work['baseRefresh'];
        Object.assign(item, evaluate(item, [item], new Date(instance.at), [15368]));
        // As the instance recorded it: no request of any kind raised for the tip, and no row queued.
        item.autoDispatch = { review: null, producers: [], history: [] };
        return item;
      })()
      // A verdict standing against the head: the control plane raises the request-rework it owes.
      : (() => {
        const sha = (instance.subject === 'GY-887' ? '4ff8cfd4f689' : 'c64cc36e7a65').padEnd(40, '0');
        const item = submitted({ ...instance, sha }, { evidence: [{ id: 'evidence-1', proof: 'unit:x', sha, baseSha: base, policyRevision: 1, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: shift(verdictAt, -10 * 60_000) }] } as Partial<Work>, shift(verdictAt, -20 * 60_000));
        item.observation!.reviews = [{ reviewer: reviewerBot, sha, state: 'CHANGES_REQUESTED', submittedAt: verdictAt }];
        item.observation!.at = verdictAt;
        return recorded(item, verdictAt);
      })();
    const named = actorlessSubmissions([work], new Date(instance.at));
    assert.deepEqual(named, [], `${instance.subject} has its next step named: ${(work.actionQueue?.actions ?? []).map(row => row.kind).join(', ') || 'the observation its published head is owed'}`);
    if (instance.subject !== 'GY-971') assert.deepEqual(work.actionQueue!.actions.map(row => row.kind), ['request-rework'], 'the step named is the request-rework the verdict owes');
  });
}

test('manual:fault-class-stalled-gate — a submission with nothing named for it is still actorless', () => {
  const instance = { id: 'nothing-named', at: '2026-10-01T14:04:32.793Z', kind: 'actorless', subject: 'GY-9', sha: 'c'.repeat(40) } as Instance;
  const work = submitted(instance, {}, shift(instance.at, -30 * 60_000));
  // Its proofs pending and no producer request raised for them, and no row on its queue.
  work.autoDispatch = { review: null, producers: [], history: [] };
  const named = actorlessSubmissions([work], new Date(instance.at));
  assert.equal(named.length, 1);
  assert.match(named[0].text, /no review request, no producer request, no rework request and no named wait/);
});

// ---- GY-1097: the four instances filed on 2 October 2026 -------------------------------------------
//
// The loop filed GY-1097 for four more stalled-gate faults within seven minutes of main taking
// 947d2b6212 (GY-1093's workflow changes, and GY-1090 itself). They share that move, not one reading:
//
//   - resync (GY-1023, GY-1072): the same wait GY-1090 fixed — a claim that woke the observation job,
//     three identical failures inside minutes. GY-1090 merged at 00:50:08Z, five minutes before the
//     first of them; the loop that recorded them was still running the release it had loaded before
//     it (55193b8c's rule: three identical failures are a stall, whatever the wait). Against this
//     candidate's base the rows read as waits already; they are replayed here so the shape stays
//     covered, and the pre-GY-1090 rule is shown to flag them.
//   - blocker (GY-793, GY-1094): each worker's push was refused by GitHub — "refusing to allow a
//     GitHub App to create or update workflow ... without workflows permission". Worker push tokens
//     never carry workflows, by design, so the gate is held by a permission the worker identity
//     lacks, not by nothing: a configuration fault (`workflow-permission`), as a sandbox refusal is
//     (`sandbox-blocker`). The push itself is GY-1098's control-plane path. Against the base each was
//     read as `blocker`, a stalled gate: these subtests fail there.

interface Gy1097Instance { id: string; at: string; kind: 'stalled-action' | 'blocker'; subject: string; action?: 'resync'; reason?: string; failures?: string[]; detected?: number; blocker?: string }
const gy1097: Gy1097Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1097-stalled-gate.json', import.meta.url)), 'utf8'));

test('manual:fault-class-stalled-gate — GY-1097 lists 4 instances, and every one is replayed below', () => {
  assert.deepEqual(gy1097.map(instance => instance.subject), ['GY-1023', 'GY-1072', 'GY-793', 'GY-1094']);
  assert.deepEqual(gy1097.map(instance => instance.kind), ['stalled-action', 'stalled-action', 'blocker', 'blocker']);
});

for (const instance of gy1097.filter(entry => entry.action === 'resync')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: the resync waited on its woken observation job, inside the job's bound`, () => {
    const replay = instance as unknown as Instance;
    assert.ok(instance.reason!.startsWith(`${instance.subject}: ${resyncUnobservedPrefix}; ${observationJobScheduled};`), 'the recorded reason names a scheduled job with no hold and no error');
    // The release the loop was running read a stall from the count alone: the instance's shape.
    assert.ok(instance.detected! >= actionStallThreshold, 'three identical failures were on the row when the loop recorded it');
    assert.ok(Date.parse(instance.failures!.at(-1)!) - Date.parse(instance.failures![0]) < observationWaitBoundMs, 'the whole run sat inside the observation job\'s bound');
    const detected = resyncRow({ ...replay, failures: instance.failures!.slice(0, instance.detected) });
    const work = { id: detected.work, key: instance.subject, title: instance.subject, stage: 'merge', actionQueue: { actions: [detected], history: [] } } as unknown as Work;
    assert.deepEqual(stalledActionAttention({ work: [work], now: instance.at }).filter(entry => entry.subject === instance.subject), [], 'master status raises no stalled-action attention');
    for (let count = 1; count <= instance.failures!.length; count++)
      assert.equal(actionStall(resyncRow({ ...replay, failures: instance.failures!.slice(0, count) })), null, `${count} failure(s) are a wait in progress`);
  });
}

/** The blocked item as the loop read it: a live attempt's blocker, nothing else standing. */
const blockedItem = (instance: Gy1097Instance, blocker: string) => ({ id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, stage: 'build', blocker,
  escalations: [], violations: [], proofGaps: [], containmentQuarantine: null, humanRequest: null, scopeRequest: null, lease: null }) as unknown as Work;

for (const instance of gy1097.filter(entry => entry.kind === 'blocker')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: a push GitHub refused for the workflows permission is a configuration fault, not a stalled gate`, () => {
    const faults = workFaults(blockedItem(instance, instance.blocker!), Date.parse(instance.at));
    assert.deepEqual(faults.map(fault => [fault.kind, fault.faultClass]), [['workflow-permission', 'configuration']]);
    assert.equal(faults.filter(fault => fault.faultClass === 'stalled-gate').length, 0, 'the instance does not recur as a stalled gate');
    // The derived line for the gate it holds restates that fault rather than counting a second one.
    assert.ok(restatements['stalled-item']?.includes('workflow-permission' as never), 'a stalled-item line on the item restates its workflow-permission blocker');
  });
}

test('manual:fault-class-stalled-gate — a blocker naming nothing the installation lacks is still a stalled gate', () => {
  const instance = gy1097.find(entry => entry.kind === 'blocker')!;
  const faults = workFaults(blockedItem(instance, 'The PR conflicts with main and the resolution needs a decision about which migration wins'), Date.parse(instance.at));
  assert.deepEqual(faults.map(fault => [fault.kind, fault.faultClass]), [['blocker', 'stalled-gate']]);
  assert.equal(faultClassOf('workflow-permission'), 'configuration');
});

// ---- GY-1108: recurring stalled-gate faults (8 in 24 hours) ---------------------------------------
//
// The loop filed GY-1108 for 8 stalled-gate faults across eight items in 24 hours. Every instance was
// a worker dispatch failing repeatedly with one reason: all worker profiles were busy with live or
// lingering Herdr sessions, or reserved by concurrent dispatches.
//
// Like an observation job the claim woke (GY-1090) or a role at its concurrency limit (GY-950),
// waiting for an occupied worker slot to free is a handoff in progress: it stalls only once the run
// outlasts the 30-minute wait bound. Against the base each subtest fails because the base had no slot
// wait bound on dispatch actions: the instance reproduces.

interface Gy1108Instance {
  id: string; at: string; kind: 'stalled-action'; subject: string;
  action: 'dispatch'; reason: string; failures: string[]; detected: number;
}
const gy1108: Gy1108Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1108-stalled-gate.json', import.meta.url)), 'utf8'));

// Written out rather than imported, so this file loads against the base and each instance there
// fails on its own assertion: the bound a worker slot wait keeps (src/model/action-kinds.ts).
const workerSlotWaitBoundMs = 30 * 60_000;
function workerSlotWait(reason: string): boolean {
  const match = reason.match(/^no worker profile can take \S+: (.+)$/);
  if (!match) return false;
  const detail = match[1];
  if (detail.startsWith('every healthy profile is reserved by another dispatch')) return true;
  if (detail === 'no launch profile is configured') return false;
  const entries = [...detail.matchAll(/([a-zA-Z0-9._-]+) \(([^)]+)\)/g)];
  if (!entries.length) return false;
  let busyLaunchProfiles = 0;
  for (const [, , r] of entries) {
    if (r === 'Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process') continue;
    if (/^(\S+ )?agent \S+ is \S+$/.test(r)) {
      busyLaunchProfiles++;
      continue;
    }
    return false;
  }
  return busyLaunchProfiles > 0;
}

/** The dispatch row as the ledger records it: requested, then each claim and its failure. */
function dispatchRow(instance: Gy1108Instance): ActionRow {
  const failures = instance.failures;
  const history: ActionRecord[] = [{ at: shift(failures[0], -90_000), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: `${instance.subject} is waiting for worker dispatch` }];
  failures.forEach((at, index) => history.push(
    { at: shift(at, -20_000), event: 'claimed', requester: 'graphyard', executor: 'graphyard-master@vishrog/1', result: null, reason: `attempt ${index + 1} claimed by graphyard-master@vishrog/1 on vishrog` },
    { at, event: 'failed', requester: 'graphyard', executor: 'graphyard-master@vishrog/1', result: 'failed', reason: instance.reason }));
  return { id: `dispatch-${instance.id}`, kind: 'dispatch', work: `work-${instance.subject}`, key: instance.subject, gate: 'ready', refusal: instance.reason,
    reason: `${instance.subject} is waiting for worker dispatch`, binding: 'worker', inputs: { kind: 'dispatch', target: 'worker' },
    requestedBy: 'graphyard', requestedAt: history[0].at, state: 'pending', claim: null, attempts: failures.length, history, result: 'failed', resolution: instance.reason, resolvedAt: failures.at(-1) } as unknown as ActionRow;
}

test('manual:fault-class-stalled-gate — GY-1108 lists 8 instances, and every one is replayed below', () => {
  assert.equal(gy1108.length, 8);
  assert.equal(new Set(gy1108.map(instance => instance.id)).size, 8);
  assert.deepEqual(gy1108.map(instance => instance.subject), ['GY-1008', 'GY-866', 'GY-950', 'GY-1103', 'GY-1099', 'GY-1107', 'GY-1104', 'GY-1075']);
  assert.ok(gy1108.every(instance => instance.action === 'dispatch' && instance.kind === 'stalled-action'));
});

for (const instance of gy1108) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: a dispatch waiting for a worker slot is not a stall inside the slot bound`, () => {
    assert.ok(workerSlotWait(instance.reason), 'the recorded reason names worker profiles occupied or reserved with no credential error');
    assert.ok(instance.detected >= actionStallThreshold, 'three identical failures were on the row when the loop recorded it');
    assert.ok(Date.parse(instance.failures.at(-1)!) - Date.parse(instance.failures[0]) < workerSlotWaitBoundMs, 'the whole run sat inside the worker slot wait bound');
    // At the instant the loop recorded it, master status raises nothing for the row.
    const detected = dispatchRow({ ...instance, failures: instance.failures.slice(0, instance.detected) });
    const work = { id: detected.work, key: instance.subject, title: instance.subject, stage: 'build', actionQueue: { actions: [detected], history: [] } } as unknown as Work;
    assert.deepEqual(stalledActionAttention({ work: [work], now: instance.at }).filter(entry => entry.subject === instance.subject), [], 'master status raises no stalled-action attention');
    // Nor at any later failure of the same run.
    for (let count = 1; count <= instance.failures.length; count++) {
      const failures = instance.failures.slice(0, count);
      assert.equal(actionStall(dispatchRow({ ...instance, failures })), null, `${count} failure(s) are a wait in progress`);
    }
    // Not weakened: the same row, still waiting once the run outlasts the bound, is a stall.
    const outlasted = dispatchRow({ ...instance, failures: [shift(instance.failures.at(-1)!, -workerSlotWaitBoundMs), ...instance.failures.slice(1)] });
    assert.ok(actionStall(outlasted), 'waiting for longer than the bound still stalls the row');
  });
}

test('manual:fault-class-stalled-gate — a dispatch failure with credential or configuration errors still stalls', () => {
  const at = '2026-10-02T08:59:06.536Z';
  const makeFailures = () => [shift(at, -120_000), shift(at, -60_000), at];

  // No launch profile configured
  const unconfiguredReason = 'no worker profile can take GY-999: no launch profile is configured';
  assert.equal(workerSlotWait(unconfiguredReason), false);
  const unconfigured = dispatchRow({ id: 'unconfigured', at, kind: 'stalled-action', subject: 'GY-999', action: 'dispatch', reason: unconfiguredReason, failures: makeFailures(), detected: 3 });
  assert.ok(actionStall(unconfigured), 'missing launch profile stalls after 3 attempts');

  // Credential unavailable
  const credReason = 'no worker profile can take GY-999: claude-primary (Worker credential is unavailable)';
  assert.equal(workerSlotWait(credReason), false);
  const credFailed = dispatchRow({ id: 'cred-failed', at, kind: 'stalled-action', subject: 'GY-999', action: 'dispatch', reason: credReason, failures: makeFailures(), detected: 3 });
  assert.ok(actionStall(credFailed), 'unavailable credential stalls after 3 attempts');

  // Cooldown
  const cooldownReason = 'no worker profile can take GY-999: claude-primary (Cooling off after a failed launch until 2026-10-02T09:30:00.000Z: launch failed)';
  assert.equal(workerSlotWait(cooldownReason), false);
  const cooling = dispatchRow({ id: 'cooling', at, kind: 'stalled-action', subject: 'GY-999', action: 'dispatch', reason: cooldownReason, failures: makeFailures(), detected: 3 });
  assert.ok(actionStall(cooling), 'profile cooling off stalls after 3 attempts');
});

test('manual:fault-class-stalled-gate — a dispatch where every healthy profile is reserved is a slot wait', () => {
  const reservedReason = 'no worker profile can take GY-1103: every healthy profile is reserved by another dispatch (process 4177280 on vishrog since 2026-10-02T08:27:57.276Z)';
  assert.equal(workerSlotWait(reservedReason), true);
  const at = '2026-10-02T09:03:24.638Z';
  const row = dispatchRow({ id: 'reserved', at, kind: 'stalled-action', subject: 'GY-1103', action: 'dispatch', reason: reservedReason, failures: [shift(at, -120_000), shift(at, -60_000), at], detected: 3 });
  assert.equal(actionStall(row), null, 'reserved profiles are a wait in progress');
});

test('manual:fault-class-stalled-gate — a dispatch failure with profile names ending in a dot is handled as a slot wait', () => {
  const dotReason = 'no worker profile can take GY-999: claude. (Herdr agent graphyard-claude-1 is working)';
  assert.equal(workerSlotWait(dotReason), true);
  const at = '2026-10-02T08:59:06.536Z';
  const row = dispatchRow({ id: 'dot-profile', at, kind: 'stalled-action', subject: 'GY-999', action: 'dispatch', reason: dotReason, failures: [shift(at, -120_000), shift(at, -60_000), at], detected: 3 });
  assert.equal(actionStall(row), null, 'profile ending in a dot is recognized as a slot wait');
});

test('manual:fault-class-stalled-gate — a configuration with only existing profiles is a configuration failure, not a slot wait', () => {
  const existingOnlyReason = 'no worker profile can take GY-999: bootstrap-existing (Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process)';
  assert.equal(workerSlotWait(existingOnlyReason), false);
  const at = '2026-10-02T08:59:06.536Z';
  const row = dispatchRow({ id: 'existing-only', at, kind: 'stalled-action', subject: 'GY-999', action: 'dispatch', reason: existingOnlyReason, failures: [shift(at, -120_000), shift(at, -60_000), at], detected: 3 });
  assert.ok(actionStall(row), 'configuration with only existing profiles stalls after 3 attempts');
});

