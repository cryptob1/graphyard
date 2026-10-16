import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { processJob, type GitHub } from '../src/github.js';
import { proofFailureRefusal } from '../src/merge-queue.js';
import { failedTestsMarker } from '../src/master/base-break-refresh.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { baseFailureStep } from '../src/daemon/cycle-base-failures.js';
import { flakeStep } from '../src/daemon/cycle-flakes.js';
import { attributeFailures, baseFailurePrefix, baseFailureReason, failureIsBase, parseBaseFailureReason, baseFailureHoldMs, mergeOne, mergeQueue, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { applyMainGuardRevert, runMainGuard, type CheckRun, type CommitVerdict, type FileChange, type MainCommit, type MainGuardPorts } from '../src/main-guard.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import { foldMergeLedger, type MergeLedgerEvent } from '../src/model/merge-ledger.js';
import type { FlakeLedger } from '../src/model/flake-ledger.js';
import type { FlakeLedgerStore } from '../src/flake-ledger.js';
import type { TrialRun } from '../src/merge-writer/trial.js';
import type { Observation, Principal, Work } from '../src/model.js';

// GY-1834. In the 30 CI runs before 2026-10-16T07:00Z about half failed, almost all on tests that
// were not the change's: GY-1831 and GY-1824 took six runs each, every one a full rework round, and
// the main guard filed a revert of GY-1831 whose own CI failed the very test main failed. A failure
// is now charged to who caused it: the base, a flake, or the head — and a criterion's proof always
// to the head. Nothing is skipped; only who is charged changes.

const clock = Date.parse('2030-02-01T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('head'), tip = sha('tip'), mergeSha = sha('merge');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const ownProof = 'unit:item-works';
const proofFile = 'tests/item-works.test.ts', shared = 'tests/locked-read.test.ts', flaky = 'tests/fleet-panel.test.ts';
const flakyName = 'unit:fleet-panel-renders — the fleet panel renders', sharedName = 'unit:reconcile-lock-hold-bounded — the lock hold is bounded';

function item(fields: Record<string, unknown> = {}): Work {
  return { id: 'w1', key: 'GY-1', title: 'Item 1', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: ['src/app.ts'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: [ownProof] }], policy: { checks: ['test'], review: true }, stage: 'test', ready: true, epoch: 1, lease: null,
    submission: { epoch: 1, pr: null }, candidate: { sha: head, baseSha: tip }, reworkRequested: false, evidence: [], blocker: null, violations: [],
    observation: { source: 'control-plane', candidate: { sha: head }, merged: false }, gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'merge', reasons: [] })),
    stageEnteredAt: iso(clock - 3_600_000), ...fields } as unknown as Work;
}
const tap = (...names: string[]) => names.map((name, index) => `not ok ${index + 1} - ${name}`).join('\n');
const verdict = (failed: string[]): TrialRun => ({ build: 'pass', tests: { passed: 10 - failed.length, failed, files: 10 }, durationMs: 1000, logTail: '', runnerExit: failed.length ? 1 : 0 });
const first = (failed: string[]): MergeTrialRun => ({ ...verdict(failed), files: [], proofs: {} });

/** A retest that answers, per commit, the files that fail there and the names its TAP reports. */
function retest(onHead: { failed: string[]; names?: string[] }, onBase: { failed: string[]; names?: string[] }) {
  const calls: { sha: string; files: string[] }[] = [];
  const fn = async (at: string, files: string[]) => {
    calls.push({ sha: at, files });
    const side = at === mergeSha ? onHead : onBase;
    const failed = files.filter(file => side.failed.includes(file));
    return { run: verdict(failed), tap: tap(...(side.names ?? [])) };
  };
  return { fn, calls };
}
const git = (async (_command: string, args: string[]) => args.includes(`${mergeSha}^1`) ? `${tip}\n` : '') as never;
const input = { root: '/repo', base: '/managed', mergeSha, changedFiles: [], timeoutMs: 60_000, proofs: [ownProof], proofFiles: [proofFile] };

/** Ports whose trial answers `run`; pushes land. The records fold as the coordinator folds them. */
function ports(run: MergeTrialRun) {
  const events: MergeLedgerEvent[] = [], recorded: MergeRecordEvent[] = [];
  const merge: MergePorts = {
    baseBranch: 'main', retrials: 1, now: () => clock, fetch: async () => tip,
    merge: async () => ({ mergeSha, files: ['src/app.ts'] }), trial: async () => run,
    push: async () => 'pushed', holds: async () => true,
    record: async (target, event) => {
      recorded.push(event);
      const kind = ({ intent: 'merge.intent', pushed: 'merge.pushed', reconciled: 'merge.reconciled', refused: 'merge.refused', trial: 'merge.trial' } as const)[event.kind];
      const payload = event.kind === 'intent' ? { key: target.key, head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, at: event.at }
        : event.kind === 'refused' ? { head: event.head, reason: event.reason, kind: 'merge' } : event;
      events.push({ kind, payload, work: target.key });
    },
  };
  return { merge, events, recorded, ledger: () => foldMergeLedger(events)['GY-1'] ?? null };
}
function cycleOf(work: Work[], effects: Partial<DaemonEffects>, state = emptyDaemonState(config), at = clock): Cycle {
  return { config, state, effects: { persist: async () => {}, ...effects } as DaemonEffects, snapshot: { work, now: iso(at) }, clock: at, now: () => at, performed: [], open: work.filter(entry => entry.stage !== 'done'),
    isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle;
}
function filer() {
  const filed: { title: string; description: string; key: string }[] = [];
  const file = async (body: { title: string; description: string }, key: string) => { filed.push({ title: body.title, description: body.description, key }); return { key: `GY-${900 + filed.length}` } as Work; };
  return { filed, file };
}
function memoryStore(): FlakeLedgerStore & { ledger: FlakeLedger } {
  const store = { ledger: { version: 1, entries: [], read: {}, filed: {} } as FlakeLedger, read: async () => structuredClone(store.ledger), write: async (ledger: FlakeLedger) => { store.ledger = structuredClone(ledger); } };
  return store;
}

test('unit:failure-attributed-to-base-or-flake — a head whose failing tests also fail on the base tip is held with the base failure named, never sent to rework, and its fix item filed at once', async () => {
  // The trial fails a test file on the head; it fails again on its rerun and on the base tip.
  const rerun = retest({ failed: [shared], names: [sharedName] }, { failed: [shared], names: [sharedName] });
  const run = await attributeFailures(first([shared]), tap(sharedName), input, git, rerun.fn);
  assert.deepEqual(rerun.calls, [{ sha: mergeSha, files: [shared] }, { sha: tip, files: [shared] }], 'rerun on the same merge commit, then on the base tip (its first parent)');
  assert.deepEqual(run.base, { tip, files: [shared], tests: [sharedName], cases: [sharedName] });

  const work = item(), fake = ports(run);
  const outcome = await mergeOne(fake.merge, work);
  assert.equal(outcome.outcome, 'requeued', 'a base failure is held, not refused: the merge writer requests rework only for a refused outcome');
  assert.ok(outcome.outcome === 'requeued' && outcome.reason.startsWith(baseFailurePrefix) && !outcome.reason.startsWith(trialFailurePrefix));
  assert.ok(outcome.outcome === 'requeued' && outcome.reason.includes(tip) && outcome.reason.includes(sharedName), 'the hold names the base tip and the failing test');
  assert.ok(!fake.recorded.some(event => event.kind === 'pushed'), 'nothing is pushed');

  // The ledger shows the hold; the queue keeps the head out for the hold, then trials it again.
  work.mergeLedger = foldMergeLedger(fake.events)[work.key];
  assert.equal(work.mergeLedger!.state, 'refused');
  assert.equal(mergeQueue([work], { [work.key]: work.mergeLedger! }, clock + 60_000).next, null, 'held: not trialled again on every cycle');
  assert.equal(mergeQueue([work], { [work.key]: work.mergeLedger! }, clock + baseFailureHoldMs + 1).next?.key, work.key, 'after the hold it is trialled again on the then tip');

  // The loop files the fix item at once, naming the test and the base tip; one item however many cycles.
  const { filed, file } = filer(), state = emptyDaemonState(config);
  await baseFailureStep(cycleOf([work], { fileBaseFailure: file as never }, state));
  await baseFailureStep(cycleOf([work], { fileBaseFailure: file as never }, state, clock + 60_000));
  assert.equal(filed.length, 1);
  assert.match(filed[0].title, /^Base branch main fails trial test: unit:reconcile-lock-hold-bounded/);
  assert.ok(filed[0].description.includes(tip) && filed[0].description.includes('GY-1'));
  // Test A fixed, test B of the same file broken on a later tip, same head: a new failure, filed afresh, never the stale one's item.
  const otherName = 'unit:reconcile-lock-other — another case', later = sha('later');
  work.mergeLedger = { ...work.mergeLedger!, refusal: { kind: 'merge', reason: `${baseFailurePrefix}: tests ${shared} fail on the base tip ${later} too: ${otherName}` } };
  await baseFailureStep(cycleOf([work], { fileBaseFailure: file as never }, state, clock + 120_000));
  assert.equal(filed.length, 2);
  assert.match(filed[1].title, /unit:reconcile-lock-other/);
  assert.ok(filed[1].description.includes(later));

  // A file that fails on the head and passes on the base is the head's: refused, and the rework it grounds follows.
  const own = await attributeFailures(first([shared]), tap(sharedName), input, git, retest({ failed: [shared] }, { failed: [] }).fn);
  assert.equal(own.base, undefined);
  const refused = await mergeOne(ports(own).merge, item());
  assert.ok(refused.outcome === 'refused' && refused.reason.startsWith(trialFailurePrefix));

  // Attributed by test, not by file: the rerun fails case A of the file while the base fails only case B of it, so A is the head's.
  const caseB = 'unit:reconcile-lock-other — another case';
  const byFile = await attributeFailures(first([shared]), tap(sharedName), input, git, retest({ failed: [shared], names: [sharedName] }, { failed: [shared], names: [caseB] }).fn);
  assert.equal(byFile.base, undefined, 'case A passes on the base: the head is not held as a base failure');
  const caseRefused = await mergeOne(ports(byFile).merge, item());
  assert.ok(caseRefused.outcome === 'refused' && caseRefused.reason.startsWith(trialFailurePrefix), 'and its rework follows');
  assert.equal(failureIsBase({ build: 'pass', tests: { passed: 9, failed: [shared], files: 10 }, base: { tip, files: [shared], tests: [caseB], cases: [sharedName] } }), false, 'a recorded base run judges cases too');
  // A rerun that names no failing case attributes nothing to the base.
  const unnamed = await attributeFailures(first([shared]), tap(sharedName), input, git, retest({ failed: [shared] }, { failed: [shared], names: [sharedName] }).fn);
  assert.equal(unnamed.base, undefined);

  // Long paths never cut the base tip or the test names: the reason still parses and its fix item is filed.
  const longFiles = Array.from({ length: 20 }, (_, index) => `tests/${'deeply-nested/'.repeat(12)}case-${index}.test.ts`);
  const longReason = baseFailureReason({ tip, files: longFiles, tests: [sharedName] });
  assert.ok(longReason.length <= 2000);
  const parsed = parseBaseFailureReason(longReason);
  assert.ok(parsed && parsed.tip === tip && parsed.tests.includes(sharedName) && parsed.files.length > 0 && parsed.files.every(file => longFiles.includes(file)), 'tip and tests survive; only whole paths are kept');
});

test('unit:failure-attributed-to-base-or-flake — a failing test that passes on an immediate rerun of the same head is judged on the rerun and its first flake files one fix item', async () => {
  const rerun = retest({ failed: [] }, { failed: [] });
  const run = await attributeFailures(first([flaky]), tap(flakyName), input, git, rerun.fn);
  assert.deepEqual(rerun.calls, [{ sha: mergeSha, files: [flaky] }], 'a file that passes on its rerun is never run on the base');
  assert.deepEqual(run.tests.failed, [], 'the verdict is the rerun\'s');
  assert.deepEqual(run.flaked, { files: [flaky], tests: [flakyName] });

  const fake = ports(run), landed = item();
  const outcome = await mergeOne(fake.merge, landed);
  assert.equal(outcome.outcome, 'merged', 'the head lands on its rerun');
  // The flake rides on the trial record, before the push: the item's merge ledger keeps it, durable across any restart.
  assert.ok(fake.recorded.findIndex(event => event.kind === 'trial' && event.outcome === 'verdict' && event.flaked) < fake.recorded.findIndex(event => event.kind === 'pushed'));
  landed.mergeLedger = fake.ledger();
  assert.deepEqual(landed.mergeLedger!.flakes!.map(flake => [flake.mergeSha, flake.tests]), [[mergeSha, [flakyName]]]);

  // The flake ledger reads it from the item and files the fix item on its first flake: the test is no proof of GY-1.
  // Each step runs on a fresh store, as a loop restarted after the merge would: the record is the item's, not the process's.
  const store = memoryStore(), { filed, file } = filer();
  await flakeStep(cycleOf([landed], { flakeLedger: store, fileFaultClass: file as never }));
  assert.deepEqual(filed.map(entry => entry.title), [`Flaky test: ${flakyName}`]);
  assert.match(filed[0].description, /first flake/);
  const restarted = memoryStore();
  restarted.ledger = structuredClone(store.ledger);
  await flakeStep(cycleOf([landed], { flakeLedger: restarted, fileFaultClass: file as never }, emptyDaemonState(config), clock + 60_000));
  assert.equal(filed.length, 1, 'one fix item, read once by its merge commit');

  // A flake beside a failure that still holds the head is kept too: the refused trial's record carries it.
  const beside = await attributeFailures(first([shared, flaky]), tap(sharedName, flakyName), input, git, retest({ failed: [shared], names: [sharedName] }, { failed: [] }).fn);
  assert.deepEqual([beside.tests.failed, beside.flaked], [[shared], { files: [flaky], tests: [flakyName] }]);
  const held = ports(beside), refusedItem = item();
  assert.equal((await mergeOne(held.merge, refusedItem)).outcome, 'refused');
  refusedItem.mergeLedger = held.ledger();
  const besideFiled = filer();
  await flakeStep(cycleOf([refusedItem], { flakeLedger: memoryStore(), fileFaultClass: besideFiled.file as never }));
  assert.deepEqual(besideFiled.filed.map(entry => entry.title), [`Flaky test: ${flakyName}`]);

  // A proof file whose failing case is not one of the item's proofs is attributed like any other file: rerun, and excused when it passes.
  const unrelated = 'unit:item-works-elsewhere-helper — an unrelated case in the proof file';
  const loose = await attributeFailures(first([proofFile]), tap(unrelated), { ...input, proofs: [ownProof] }, git, retest({ failed: [] }, { failed: [] }).fn);
  assert.deepEqual([loose.tests.failed, loose.flaked], [[], { files: [proofFile], tests: [unrelated] }]);

  // A supported test name longer than 300 characters keeps its name through the trial record, so its first flake files its fix item.
  const longName = `unit:fleet-panel-long — ${'the fleet panel renders every row of a long list '.repeat(8)}`.trim();
  assert.ok(longName.length > 301 && longName.length <= 500);
  const long = await attributeFailures(first([flaky]), tap(longName), input, git, retest({ failed: [] }, { failed: [] }).fn);
  const longPorts = ports(long), longItem = item();
  assert.equal((await mergeOne(longPorts.merge, longItem)).outcome, 'merged');
  longItem.mergeLedger = longPorts.ledger();
  assert.deepEqual(longItem.mergeLedger!.flakes!.map(flake => flake.tests), [[longName]], 'the long name is kept on the merge ledger, never dropped to its file path');
  const longFiled = filer();
  await flakeStep(cycleOf([longItem], { flakeLedger: memoryStore(), fileFaultClass: longFiled.file as never }));
  assert.deepEqual(longFiled.filed.map(entry => entry.title), [`Flaky test: ${longName}`.slice(0, 200)]);

  // A PR check rerun that passed: the first flake of a test that is no proof of its item files too; a flake of the item's own proof waits for the threshold.
  const rerunOf = (n: number, proofs: string[]) => ({ ...item({ id: `w${n}`, key: `GY-${n}`, criteria: [{ id: 'AC-1', text: 'Works', proofs }], submission: { epoch: 1, pr: n } }),
    checkReruns: [{ sha: sha(`h${n}`), check: 'test', failedRunId: 500 + n, state: 'passed', at: iso(clock - 120_000), rerunId: 600 + n, resolvedAt: iso(clock - 60_000) }] }) as unknown as Work;
  const pr = filer(), prStore = memoryStore();
  const logs: Record<number, string[]> = { 502: ['unit:other-thing — another'], 503: ['unit:own-proof — the item\'s own proof'] };
  await flakeStep(cycleOf([rerunOf(2, [ownProof]), rerunOf(3, ['unit:own-proof'])], { flakeLedger: prStore, fileFaultClass: pr.file as never, failedTests: async (job: number) => logs[job] ?? [] }));
  assert.deepEqual(pr.filed.map(entry => entry.title), ['Flaky test: unit:other-thing — another']);
});

test('unit:failure-attributed-to-base-or-flake — a failing test that is a criterion\'s proof always holds the item, even when it passes on rerun or fails on the base too', async () => {
  // The proof file passes on its rerun and fails on the base: neither sets it aside.
  const rerun = retest({ failed: [] }, { failed: [proofFile] });
  const run = await attributeFailures(first([proofFile]), tap(`${ownProof} — works`), input, git, rerun.fn);
  assert.deepEqual(rerun.calls, [], 'a proof file whose proof case failed is never rerun to excuse it');
  assert.deepEqual(run.tests.failed, [proofFile]);
  assert.equal(run.flaked, undefined);
  assert.equal(run.base, undefined);
  const outcome = await mergeOne(ports(run).merge, item());
  assert.ok(outcome.outcome === 'refused' && outcome.reason.startsWith(trialFailurePrefix), 'the head is refused and the rework it grounds follows');

  // With a flaky non-proof file beside it, the flake is excused but the proof still holds the head.
  const mixed = await attributeFailures(first([proofFile, flaky]), tap(`${ownProof} — works`, flakyName), input, git, retest({ failed: [] }, { failed: [] }).fn);
  assert.deepEqual(mixed.tests.failed, [proofFile]);
  assert.deepEqual(mixed.flaked, { files: [flaky], tests: [flakyName] }, 'the proof case is never named a flake');
  // A proof file whose proof case failed beside an unrelated case: still rerun, so the head stays held for the
  // proof while the unrelated case that passed on its rerun is the flake whose first fix item is filed.
  const unrelatedCase = 'unit:fleet-panel-helper — an unrelated case beside the proof';
  const both = retest({ failed: [proofFile], names: [`${ownProof} — works`] }, { failed: [proofFile] });
  const besideProof = await attributeFailures(first([proofFile]), tap(`${ownProof} — works`, unrelatedCase), input, git, both.fn);
  assert.deepEqual(both.calls, [{ sha: mergeSha, files: [proofFile] }], 'rerun on the same merge commit, never on the base');
  assert.deepEqual([besideProof.tests.failed, besideProof.flaked, besideProof.base], [[proofFile], { files: [], tests: [unrelatedCase] }, undefined]);
  const proofHeld = ports(besideProof), heldItem = item();
  const heldOutcome = await mergeOne(proofHeld.merge, heldItem);
  assert.ok(heldOutcome.outcome === 'refused' && heldOutcome.reason.startsWith(trialFailurePrefix), 'the proof still holds the head');
  heldItem.mergeLedger = proofHeld.ledger();
  const besideFiled = filer();
  await flakeStep(cycleOf([heldItem], { flakeLedger: memoryStore(), fileFaultClass: besideFiled.file as never }));
  assert.deepEqual(besideFiled.filed.map(entry => entry.title), [`Flaky test: ${unrelatedCase}`]);
  // A file that fails again with one of the item's proofs on its rerun is the head's, wherever else it fails.
  const proofAgain = await attributeFailures(first([shared]), tap(sharedName), input, git, retest({ failed: [shared], names: [`${ownProof} — works`] }, { failed: [shared] }).fn);
  assert.deepEqual([proofAgain.tests.failed, proofAgain.base], [[shared], undefined]);
  assert.equal((await mergeOne(ports(mixed).merge, item())).outcome, 'refused');

  // Under GitHub delivery, a base failure that names the candidate's own proof is never set aside.
  const observed = item({ submission: { epoch: 1, pr: 7 }, candidate: { sha: head, baseSha: tip },
    observation: { candidate: { sha: head }, checks: [{ name: 'test', result: 'failure', appId: 15368, id: 70, attempt: 1 }], merged: false, prState: 'open' } });
  const effects = { failedTests: async () => [`${ownProof} — works`], baseCheck: async () => ({ check: 'test', baseSha: tip, state: 'failed' as const, jobId: 80, url: null, tests: [`${ownProof} — works`] }) };
  const setAside = await baseFailureStep(cycleOf([observed], effects as never));
  assert.equal(setAside.has(observed.id), false, 'the failure stays the candidate\'s: its rework proceeds');
  const other = { ...effects, failedTests: async () => [sharedName], baseCheck: async () => ({ check: 'test', baseSha: tip, state: 'failed' as const, jobId: 80, url: null, tests: [sharedName] }) };
  assert.deepEqual([...(await baseFailureStep(cycleOf([observed], other as never))).get(observed.id) ?? []], ['test'], 'a shared failure of a non-proof test is set aside as before');
});

// ---- AC-1 under GitHub delivery: the PR gate's one rerun -------------------------------------------

let database: EmbeddedPostgres | null = null, store: Store | null = null;
after(async () => { if (store) await store.close(); if (database) await database.stop(); });
async function engineOnPostgres() {
  const port = Number(process.env.GRAPHYARD_FLAKE_ATTRIBUTION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1834);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('flake-attribution'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
  return engine;
}

test('unit:failure-attributed-to-base-or-flake — under GitHub delivery a failed check that failed a criterion proof is never rerun past: the failure stands as the head\'s, while any other failure is rerun once', async () => {
  assert.match(proofFailureRefusal(item(), { check: 'test', failedRunId: 41 }, [`${ownProof} — works`, sharedName]) ?? '', /criterion proof unit:item-works — works/);
  assert.equal(proofFailureRefusal(item(), { check: 'test', failedRunId: 41 }, [sharedName]), null);

  const engine = await engineOnPostgres(), db = store!;
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: 'agent-a', role: 'worker' };
  const at = (label: string) => label.padEnd(40, '0');
  let number = 1833;
  async function submitted() {
    let work = await engine.execute(operator, 'create', null, { title: `Head ${number}`, plannedFiles: ['src/app.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: [ownProof] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/attribution/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
    return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++number }, randomUUID());
  }
  const seen = (work: Work, candidate: { sha: string; baseSha: string }): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'failure', appId: 15368, id: 41 }], reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: at('7'), baseTipContained: true, files: ['src/app.ts'], scopeFiles: [], at: iso(clock) } as Observation);
  // `failed` null is a run whose failed tests cannot be read: it published no record, or (`'throws'`) the read fails.
  async function reconcile(failed: string[] | null | 'throws', observations = 1) {
    let work = await submitted();
    const candidate = { sha: at(`a${number}`), baseSha: at('b') };
    work = await engine.observe(work.id, work.revision, seen(work, candidate));
    assert.deepEqual(work.checkReruns!.map(entry => entry.state), ['owed']);
    const reruns: number[] = [];
    let reads = 0;
    for (let pass = 0; pass < observations; pass++) {
      await db.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour'");
      await db.pool.query('UPDATE jobs SET available_at=now(),locked_until=NULL,token=NULL WHERE work_id=$1', [work.id]);
      await processJob(engine, { observe: async (target: Work) => seen(target, candidate), rerunFailedJobs: async (id: number) => { reruns.push(id); return { runId: 9001 }; },
        checkRunAnnotations: async () => { reads++; if (failed === 'throws') throw new Error('annotations unavailable'); return failed ? [{ message: `${failedTestsMarker}${JSON.stringify({ failed })}` }] : [{ message: 'Process completed with exit code 1.' }]; },
        requestCodex: async () => { throw new Error('no review request expected'); }, publish: async () => {} } as unknown as GitHub);
    }
    return { reruns, reads, work: (await db.list()).find(entry => entry.id === work.id)! };
  }
  const proof = await reconcile([`${proofFile} › ${ownProof} — works`]);
  assert.deepEqual(proof.reruns, [], 'the failed proof is never rerun');
  assert.equal(proof.work.checkReruns!.at(-1)!.state, 'refused');
  assert.match(proof.work.checkReruns!.at(-1)!.detail ?? '', /criterion proof tests\/item-works.test.ts › unit:item-works/);
  const other = await reconcile([`${shared} › ${sharedName}`]);
  assert.deepEqual(other.reruns, [41], 'a failure of no proof is rerun once, as before');
  // A run whose failed tests cannot be read may have failed a proof: on every observation it stays owed,
  // never rerun, holding the failure until the owed rerun lapses and the failure stands as the head's.
  for (const unreadable of [null, 'throws'] as const) {
    const unknown = await reconcile(unreadable, 3);
    assert.deepEqual(unknown.reruns, [], `an unreadable failed run (${unreadable ?? 'no record'}) is never rerun`);
    assert.equal(unknown.reads, 3, 'each observation reads the failed tests again');
    assert.deepEqual(unknown.work.checkReruns!.map(entry => entry.state), ['owed'], 'the rerun stays owed, holding the failure');
  }
});

// ---- AC-2: the main guard ----------------------------------------------------------------------

const ci = 15368, required = ['test', 'typecheck'], at = iso(clock);
const mergeDiff: FileChange[] = [{ filename: 'src/added.ts', status: 'added', patch: '@@ -0,0 +1,1 @@\n+export const a = 1;' }];
function delivered(key: string, merge: string, pr: number): Work {
  return { ...item({ id: `id-${key}`, key, stage: 'done', delivery: { mergedAt: at, mergeSha: merge, authorizationRevision: 1 }, submission: { epoch: 1, pr } }) } as Work;
}

test('unit:revert-closed-when-base-fails — the main guard closes, without landing, a revert whose own CI fails the same tests as main, and one fix item names those tests', async () => {
  const failing = [`tests/locked-read.test.ts › ${sharedName}`];
  const [base, A, B] = ['base', 'a', 'b'].map(sha);
  const history: MainCommit[] = [{ sha: B, parent: A }, { sha: A, parent: base }, { sha: base, parent: null }];
  const culprit = delivered('GY-2', B, 702), items = [delivered('GY-1', A, 701), culprit];
  const named = (id: number, tests?: string[]): CheckRun[] => [{ name: 'test', result: tests ? 'failure' : 'success', appId: ci, id }, { name: 'typecheck', result: 'success', appId: ci, id: id + 1 }];
  const checks = new Map<string, CheckRun[]>([[base, named(100)], [A, named(200)], [B, named(300, failing)]]);
  const annotations = new Map<number, string[]>([[300, failing]]);
  const pulls = new Map<number, { merged: boolean; mergeSha: string | null; open: boolean; mergeable: boolean | null; head: string }>();
  const calls = { opened: [] as string[], merged: [] as number[], closed: [] as number[], approved: [] as number[] };
  const guard: MainGuardPorts = {
    reverting: async () => items.filter(work => work.mainGuardReverts?.some(revert => revert.state === 'opened')),
    culprit: async merge => items.find(work => work.delivery?.mergeSha === merge || work.mainGuardReverts?.some(revert => revert.mergeSha === merge)) ?? null,
    history: async () => history, checks: async commit => checks.get(commit) ?? [],
    openRevert: async (_work, merge) => { calls.opened.push(merge); pulls.set(900, { merged: false, mergeSha: null, open: true, mergeable: true, head: sha('revert') }); return { pr: 900, head: sha('revert') }; },
    pull: async pr => pulls.get(pr)!, mergeChanges: async () => mergeDiff,
    revertChanges: async () => mergeDiff.map(change => ({ ...change, status: 'removed', patch: change.patch!.replace('+export', '-export') })),
    approveRevert: async pr => { calls.approved.push(pr); return 'approved'; },
    mergeRevert: async (_work, revert) => { calls.merged.push(revert.pr); return sha('landed'); },
    closeRevert: async pr => { calls.closed.push(pr); pulls.set(pr, { ...pulls.get(pr)!, open: false }); },
    failedTests: async run => annotations.get(run) ?? null,
    standingBaseFailures: async () => items.flatMap(work => (work.mainGuardReverts ?? []).filter(revert => revert.cause === 'base-failure' && revert.baseFailure && !revert.baseFailure.cleared).map(revert => ({ work, revert }))),
    record: async (snapshot, revert) => { applyMainGuardRevert(items.find(work => work.id === snapshot.id)!, revert, new Date(at)); },
  };
  const options = { required, ciAppIds: [ci], now: new Date(at), verdicts: new Map<string, CommitVerdict>(), reruns: new Map(), runIds: new Map<string, Record<string, number | null>>(), testNames: new Map<number, string[] | null>() };

  await runMainGuard(guard, options);
  assert.deepEqual(calls.opened, [B], 'B broke main: its revert is opened');
  // The revert's own CI fails the same test main fails: the failure holds without B, so it is main's.
  checks.set(sha('revert'), named(400, failing)); annotations.set(400, failing);
  await runMainGuard(guard, options);
  const revert = culprit.mainGuardReverts![0];
  assert.deepEqual(calls.closed, [900], 'the revert is closed');
  assert.deepEqual(calls.merged, [], 'it never lands');
  assert.deepEqual(calls.approved, [], 'nor is it approved');
  assert.equal(revert.state, 'abandoned');
  assert.equal(revert.cause, 'base-failure');
  assert.equal(culprit.stage, 'done', 'the merge keeps its delivery: no rework');

  // The loop files one fix item naming those tests, at once, and no second one on later cycles.
  const { filed, file } = filer(), state = emptyDaemonState(config);
  for (let n = 0; n < 3; n++) await baseFailureStep(cycleOf(items, { fileBaseFailure: file as never }, state, clock + n * 60_000));
  assert.equal(filed.length, 1);
  assert.ok(filed[0].title.includes(failing[0]), filed[0].title);
  assert.ok(filed[0].description.includes(B) && filed[0].description.includes('GY-2'));
  // Main passes again: the guard clears the shared failure and the loop drops its record.
  culprit.mainGuardReverts = [{ ...revert, baseFailure: { ...revert.baseFailure!, cleared: { at, sha: sha('fixed') } } }];
  await baseFailureStep(cycleOf(items, { fileBaseFailure: file as never }, state, clock + 5 * 60_000));
  assert.deepEqual(Object.keys(state.baseFailures), []);
  assert.equal(filed.length, 1);
});
