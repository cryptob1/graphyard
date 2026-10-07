import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { faultClassOf, workFaults } from '../src/model/fault-classes.js';
import { leaseLapseCause } from '../src/model/escalation.js';
import { doctorBounds, doctorPrompt } from '../src/daemon/doctor.js';
import { preserveInterruptedAttempt } from '../src/daemon/effects.js';
import { preservePartialWork } from '../src/master/launch.js';
import { childRunner } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1462: the 60-minute worker no-submission bound, enforced. An attempt that holds its lease past
// the bound with no submission for its epoch is a stalled-gate fault however its lease renews (the
// fault and the loop's end at two bounds are GY-1460's, from the one declaration in
// attempt-bound.ts); ten minutes later the server refuses its renewals as the backstop, so the lease
// lapses into the containment and reclaim machinery, its work is kept on its branch, and the item
// goes to a fresh attempt.
// Each test is named for the proof it produces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  autoMerge: true, mergeMethod: 'merge', workers: [],
});
const clock = Date.parse('2026-10-07T15:00:00.000Z');
const iso = (offset: number) => new Date(clock + offset).toISOString();
const minute = 60_000;

/** GY-1457 epoch 1's shape: a renewing lease, a running session, no submission, no candidate, claimed `heldMs` ago. */
function held(heldMs: number, overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1457', key: 'GY-1457', title: 'GY-1457', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-heldMs - minute), updatedAt: iso(-10_000), stageEnteredAt: iso(-heldMs), ready: true, epoch: 1,
    lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: iso(110_000) },
    lastAssignment: { owner: 'graphyard-claude-1', epoch: 1, claimedAt: iso(-heldMs) },
    workspaces: [{ host: 'machine-a', path: '/srv/worktrees/GY-1457-1', epoch: 1, owner: 'graphyard-claude-1', branch: 'graphyard/gy-1457-1' }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as unknown as Work;
}
/**
 * The product's bound and its readers, imported when a case runs: against the base, where none is
 * declared, each case fails on its own rather than the file failing to load.
 */
async function bound() {
  const declared = await import('../src/model/attempt-bound.js');
  const backstop = await import('../src/model/escalation.js');
  assert.equal(typeof declared.workerSubmissionBoundMs, 'number', 'the product declares the worker no-submission bound');
  assert.equal(typeof backstop.noSubmissionRenewalRefused, 'function', 'the server reads the bound to refuse renewal');
  return { ...declared, ...backstop };
}
const unsubmittedFaults = <T extends { kind: string }>(faults: T[]) => faults.filter(fault => fault.kind === 'unsubmitted-attempt');

test('unit:unsubmitted-attempt-fault — an attempt past the no-submission bound with no submission is a stalled-gate fault naming the item and epoch, however recently its lease renewed', async () => {
  const { workerSubmissionBoundMs, unsubmittedAttempt } = await bound();
  assert.equal(workerSubmissionBoundMs, 60 * minute, 'the bound is 60 minutes');
  assert.equal(faultClassOf('unsubmitted-attempt'), 'stalled-gate', 'the kind is catalogued, not unclassified');
  // GY-1457 epoch 1: 60 m 11 s held, its lease renewed seconds ago.
  const late = held(60 * minute + 11_000);
  const [fault, ...rest] = unsubmittedFaults(workFaults(late, clock));
  assert.ok(fault && !rest.length, 'one fault for the attempt');
  assert.equal(fault.faultClass, 'stalled-gate');
  assert.equal(fault.subject, 'GY-1457');
  assert.match(fault.text, /GY-1457 epoch 1 \(graphyard-claude-1\) has held its lease 0 minutes past the 60-minute worker bound without a submission/);
  assert.match(fault.text, new RegExp(`lease renewed to ${late.lease!.expiresAt.replace(/[.]/g, '\\.')}`), 'the renewal does not hide it');
  // Inside the bound, no lease, or a claim the record cannot date: no fault.
  assert.deepEqual(unsubmittedFaults(workFaults(held(59 * minute), clock)), []);
  assert.deepEqual(unsubmittedFaults(workFaults(held(2 * 60 * minute, { lease: null }), clock)), []);
  assert.equal(unsubmittedAttempt(held(2 * 60 * minute, { lastAssignment: undefined }), clock), null);
  // The pipeline timeline dates the claim when the assignment does not name the epoch.
  const timeline = { ...held(0, { lastAssignment: undefined }), pipeline: { attempts: [{ epoch: 1, claimedAt: iso(-61 * minute) }] } } as unknown as Work;
  assert.equal(unsubmittedFaults(workFaults(timeline, clock)).length, 1);
  // An earlier epoch's candidate is no candidate for this epoch.
  const reworked = held(61 * minute, { epoch: 2, lease: { owner: 'graphyard-claude-1', epoch: 2, expiresAt: iso(110_000) }, lastAssignment: { owner: 'graphyard-claude-1', epoch: 2, claimedAt: iso(-61 * minute) },
    submission: { epoch: 1, pr: 40 } as Work['submission'], candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 40, branch: 'graphyard/gy-1457-1', author: 'graphyard-claude-1' } });
  assert.match(unsubmittedFaults(workFaults(reworked, clock))[0]?.text ?? '', /GY-1457 epoch 2/);
});

test('integration:cycle-faults-unsubmitted-attempt — the loop\'s faults step records the unsubmitted attempt while its lease renews and its session reports activity', async () => {
  await bound();
  const session = { id: 'graphyard-claude-1:1', kind: 'implementation', principal: 'graphyard-claude-1', epoch: 1, runtime: 'claude', host: 'machine-a', workspace: null, tab: null,
    pane: 'w1:p1', agentName: 'graphyard-claude-1', role: null, head: null, attach: 'herdr pane attach w1:p1', transcript: null, subject: 'GY-1457', state: 'running',
    observed: 'working', observedAt: iso(-5_000), outcome: null, startedAt: iso(-61 * minute), updatedAt: iso(-5_000), endedAt: null };
  const item = held(60 * minute + 11_000, { sessions: [session] } as Partial<Work>);
  const observed = unsubmittedFaults(cycleFaults(emptyDaemonState(config()), [item], clock, { config: config() }));
  assert.equal(observed.length, 1, 'the faults step records it');
  assert.equal(observed[0]!.faultClass, 'stalled-gate');
  assert.match(observed[0]!.text, /GY-1457 epoch 1/);
  // The same attempt a minute inside the bound is the ordinary pace of work.
  assert.deepEqual(unsubmittedFaults(cycleFaults(emptyDaemonState(config()), [held(59 * minute, { sessions: [session] } as Partial<Work>)], clock, { config: config() })), []);
});

test('unit:renew-lease-nosubmission-refusal — the server refuses renewal ten minutes past the loop\'s reclaim bound unsubmitted, not before, and not while submission progress is fresh', async () => {
  const { workerReclaimBoundMs, workerSubmissionBoundMs, workerNoSubmissionRefusalMs, noSubmissionRenewalRefused } = await bound();
  assert.equal(workerReclaimBoundMs, 2 * workerSubmissionBoundMs, 'the loop ends the attempt one further bound after the fault');
  assert.equal(workerNoSubmissionRefusalMs, 130 * minute, 'the server refuses its renewals ten minutes later');
  assert.equal(noSubmissionRenewalRefused(held(61 * minute), clock), false, 'one bound past: fault, still renewed');
  assert.equal(noSubmissionRenewalRefused(held(129 * minute), clock), false);
  assert.equal(noSubmissionRenewalRefused(held(130 * minute), clock), true, 'past the backstop: refused');
  // An attempt that pushed a new head within the progress cadence is still at work: renewed.
  const progressing = held(150 * minute, { sessions: [{ id: 'graphyard-claude-1:1', kind: 'implementation', principal: 'graphyard-claude-1', epoch: 1, head: 'c'.repeat(40), headAt: iso(-5 * minute) }] } as unknown as Partial<Work>);
  assert.equal(noSubmissionRenewalRefused(progressing, clock), false, 'fresh submission progress is not refused');
  // The lapse that refusal causes is explained by it; a worker that vanished inside the bound is still a lease-loss.
  const bounded = held(131 * minute), lapsedAt = (offset: number) => ({ epoch: 1, owner: 'graphyard-claude-1', expiresAt: iso(offset) });
  assert.equal(leaseLapseCause(bounded, lapsedAt(0))?.cause, 'no-submission-bound');
  assert.equal(leaseLapseCause(bounded, lapsedAt(-2 * minute)), null, 'a lease that ran out before the refusal was not refused by it');
  assert.equal(leaseLapseCause(bounded, { epoch: 1 }), null, 'an undated lapse is not judged by the bound');
  assert.equal(leaseLapseCause(progressing, lapsedAt(0)), null, 'a lapse with fresh progress was not the refusal\'s');
});

test('unit:nosubmission-bound-moot-after-submit — an epoch with a submission is never bounded', async () => {
  const { unsubmittedAttempt, noSubmissionRenewalRefused } = await bound();
  const submitted = held(5 * 60 * minute, { submission: { epoch: 1, pr: 41 } as Work['submission'] });
  assert.equal(unsubmittedAttempt(submitted, clock), null);
  assert.equal(noSubmissionRenewalRefused(submitted, clock), false);
  assert.deepEqual(unsubmittedFaults(workFaults(submitted, clock)), []);
  assert.equal(leaseLapseCause(submitted, { epoch: 1, expiresAt: iso(0) })?.cause, 'submitted', 'its lapse is the submission\'s, never the bound\'s');
});

test('unit:doctor-worker-bound-matches-product — the doctor\'s worker bound is the product bound, and its prompt names it', async () => {
  const { workerSubmissionBoundMs } = await bound();
  assert.equal(doctorBounds.workerMinutes * minute, workerSubmissionBoundMs);
  const prompt = doctorPrompt({ repository: 'owner/project', cliPath: launcher }, { items: [], faults: [] });
  assert.ok(prompt.includes(`more than ${workerSubmissionBoundMs / minute} min without a submission`), 'the doctor checklist names the product bound');
});

// The server side: renewal refused, lapse, reclaim, branch kept.
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'engineer-a', role: 'worker', sessionKind: 'ai' };
const replacement: Principal = { id: 'engineer-b', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
const id = () => randomUUID();
const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
async function overwrite(work: Work, mutate: (document: Work) => void) {
  const document = await reload(work); mutate(document);
  await store.pool.query('UPDATE work_items SET document=$2::jsonb WHERE id=$1', [document.id, JSON.stringify(document)]);
  return document;
}
async function claimed(title: string) {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  return engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/srv/worktrees/${work.key}-${work.epoch}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
}
/** Moves the attempt's claim `heldMs` into the past, as an attempt that has held that long reads. */
const age = (work: Work, heldMs: number) => overwrite(work, document => { document.lastAssignment = { ...document.lastAssignment!, claimedAt: new Date(Date.now() - heldMs).toISOString() }; });
const heartbeat = (work: Work, epoch = work.epoch) => engine.execute(worker, 'heartbeat', work.id, { epoch }, id());

before(async () => {
  const port = Number(process.env.GRAPHYARD_UNSUBMITTED_BOUND_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1462);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('unsubmitted-bound'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.principals = [operator, worker, replacement];
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:unsubmitted-attempt-reclaimed — past two bounds unsubmitted the server refuses renewal, the lease lapses, and the item goes to a fresh attempt', async () => {
  await bound();
  let work = await claimed('unsubmitted-reclaimed');
  const epoch = work.epoch;
  // One bound past: the fault stands, the lease still renews.
  work = await age(work, 61 * minute);
  work = await heartbeat(work);
  assert.equal(work.lease?.epoch, epoch, 'renewed inside the second bound');
  assert.equal(unsubmittedFaults(workFaults(work, Date.now())).length, 1);
  // Past the backstop: refused, as a renewal after submission is (a 409 the supervisor reads as definite).
  await age(work, 130 * minute + minute);
  await assert.rejects(heartbeat(work), (error: Error & { status?: number }) =>
    /is not renewed: no submission in 130 minutes, past the worker no-submission bound/.test(error.message) && error.status === 409);
  // The supervisor stops; the lease runs out. Reconcile ends the attempt on the record.
  await overwrite(work, document => { document.lease = { ...document.lease!, expiresAt: new Date(Date.now() - 1_000).toISOString() }; });
  await engine.reconcile();
  work = await reload(work);
  assert.equal(work.lease, null, 'the lapsed lease is gone');
  // The control plane's own refusal explains the lapse: recorded with its cause, never a lease-loss incident.
  assert.deepEqual(work.escalations?.filter(entry => entry.trigger === 'lease-loss') ?? [], [], 'no lease-loss escalation for a lapse the bound caused');
  const expired = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='lease.expired'`, [work.id])).rows.map(row => row.payload.details);
  assert.deepEqual(expired.map(details => [details.epoch, details.cause]), [[epoch, 'no-submission-bound']], 'the lapse is history with the bound as its cause');
  // The item is back in the queue: another worker claims a fresh epoch.
  work = await engine.execute(replacement, 'claim', work.id, {}, id());
  assert.equal(work.epoch, epoch + 1);
  assert.equal(work.lease?.owner, replacement.id);
  assert.deepEqual(unsubmittedFaults(workFaults(work, Date.now())), [], 'the fresh attempt starts its own clock');
});

test('integration:unsubmitted-end-keeps-branch — the ended attempt\'s work is committed on its branch by the existing preserve path and its workspace stays on the record', async () => {
  await bound();
  let work = await claimed('unsubmitted-keeps-branch');
  const epoch = work.epoch, branch = work.workspaces.find(entry => entry.epoch === epoch)!.branch;
  await age(work, 130 * minute + minute);
  await assert.rejects(heartbeat(work), /past the worker no-submission bound/);
  await overwrite(work, document => { document.lease = { ...document.lease!, expiresAt: new Date(Date.now() - 1_000).toISOString() }; });
  await engine.reconcile();
  work = await reload(work);
  assert.equal(work.lease, null);
  assert.equal(work.workspaces.find(entry => entry.epoch === epoch)?.branch, branch, 'the attempt\'s workspace and branch stay on the record');
  // The reclaim step's preserve path, over a real worktree on that branch holding uncommitted work.
  const run = childRunner({ timeoutMs: 30_000 });
  const tree = await temporaryDirectory('unsubmitted-worktree');
  const git = (...args: string[]) => run('git', ['-C', tree, ...args]);
  await git('init', '-q', '-b', branch); await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  await writeFile(join(tree, 'partial.ts'), 'export const partial = 1;\n');
  const reported: Record<string, unknown>[] = [];
  const state = emptyDaemonState(config()), performed: never[] = [];
  const effects = { persist: async () => {}, reportCapacity: async (_: Work, body: Record<string, unknown>) => { reported.push(body); },
    preserveWork: (_: Work, attempt: number, cause?: string) => preservePartialWork(tree, `${work.key} attempt ${attempt} ${cause}`, run) } as never;
  const recorded = await preserveInterruptedAttempt(state, effects, work, epoch, undefined, 'held its lease past the worker no-submission bound and was not renewed', () => Date.now(), performed);
  assert.equal(recorded?.state, 'done');
  const partial = reported[0]?.partialWork as { state: string; branch?: string; commit?: string };
  assert.equal(partial.state, 'committed');
  assert.equal(partial.branch, branch, 'the partial work is committed on the attempt branch');
  assert.equal((await git('log', '-1', '--format=%s', branch)).trim().startsWith('WIP:'), true);
});
