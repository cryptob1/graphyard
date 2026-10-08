import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { daemonStateSchema, daemonSummary, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { daemonEffects } from '../src/daemon/effects.js';
import { emptyMergeWriterState, mergeRecordKey, mergeWriterIdle, mergeWriterReads, mergeWriterStateSchema, mergeWriterSummary, snapshotLedger, trialFailureRework, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { baseMovedReason, countProofCases, criterionProofs, deployKeySshCommand, mergeOne, mergeQueue, nextToMerge, proofTestFiles, pushArgs, pushEnvironment, reconcileIntents, runMergeTrial, trialFailureReason, unpushedIntentReason, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { defaultDeployKeyFile, defaultMergeWriterRetrials, mergeWriterSettings, mergeWriterSettingsSchema } from '../src/master/merge-writer-settings.js';
import { deliveredReason, unheldShaRefusal } from '../src/server/merge-record.js';
import { mergeWriterApprover, mergeWriterTrialGround, reworkGround, trialFailedGround, trialFailurePrefix } from '../src/model/rework-ground.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import { mergeLedgerRefusals, pushRefusal, trialRefusal, type Principal, type Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { MergerSettings } from '../src/merger-mode.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { completionBody } from '../src/cli/complete.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1524: the control-plane merge executor — one serial queue, intent before push, the trial on the
// exact merged tree, the deploy-key push leased on the tested tip, and the reconcile of what a crash left open.

const root = fileURLToPath(new URL('..', import.meta.url));
const start = Date.parse('2030-04-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip'), newerTip = sha('newer-tip');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const gates = (passed: Record<string, boolean>) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed[name] ?? false, reasons: passed[name] ?? false ? [] : [`${name} refused`] }));
const item = (fields: Record<string, unknown>) => ({
  description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works', 'integration:item-holds', 'manual:item-looks'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start),
  stageEnteredAt: iso(start), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: gates({ ready: true, build: true, review: true, test: true }), stage: 'build', ...fields,
}) as unknown as Work;
/** A control-plane candidate submitted `minutesAgo` minutes ago, its delta touching `files`. */
const submitted = (n: number, minutesAgo: number, files: string[] = ['src/app.ts'], fields: Record<string, unknown> = {}) => item({ id: `w${n}`, key: `GY-${n}`, stageEnteredAt: iso(start - minutesAgo * minute),
  submission: { epoch: 1, pr: n }, candidate: { sha: sha(`head${n}`), baseSha: tip, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' },
  observation: { source: 'control-plane', candidate: { sha: sha(`head${n}`), baseSha: tip, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, files, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) }, ...fields });
const ledgerState = (key: string, n: number, state: MergeLedgerState['state'], fields: Partial<MergeLedgerState> = {}): MergeLedgerState =>
  ({ key, state, head: sha(`head${n}`), baseTip: tip, mergeSha: sha(`merge${n}`), risk: 'normal', intentAt: iso(start), pushedAt: null, observedTip: null, refusal: null, events: 1, ...fields });

test('unit:executor-serial-oldest-first — nextToMerge takes the oldest-submitted control-plane candidate whose build gate passes, one at a time; an item with an open intent or an unreconciled push blocks the queue, and a done, unsubmitted, GitHub-observed, reworked or trial-refused head has no turn', () => {
  const late = submitted(1, 5), early = submitted(2, 50), latest = submitted(3, 1);
  assert.equal(nextToMerge([late, early, latest], {}, start)?.key, 'GY-2', 'the oldest submission goes first');
  const queue = mergeQueue([late, early, latest], {}, start);
  assert.deepEqual(queue.queue.map(entry => [entry.key, entry.waitingMs]), [['GY-2', 50 * minute], ['GY-1', 5 * minute], ['GY-3', minute]]);
  assert.equal(queue.blockedBy, null);
  // An open intent, or a push nobody reconciled, holds the queue until reconcileIntents settles it: never two merges in flight.
  for (const state of ['intent', 'pushed'] as const) {
    const blocked = mergeQueue([late, early], { 'GY-1': ledgerState('GY-1', 1, state) }, start);
    assert.deepEqual([blocked.next, blocked.blockedBy], [null, 'GY-1'], `an item in state ${state} blocks the queue`);
    assert.equal(blocked.queue.length, 2, 'the queue is still reported');
  }
  assert.equal(nextToMerge([late, early], { 'GY-1': ledgerState('GY-1', 1, 'reconciled') }, start)?.key, 'GY-2', 'a reconciled merge blocks nothing');
  assert.equal(nextToMerge([late, early], { 'GY-2': ledgerState('GY-2', 2, 'refused', { refusal: { kind: 'merge', reason: baseMovedReason(4) } }) }, start)?.key, 'GY-2', 'a head refused because the base moved is queued again');
  assert.equal(nextToMerge([late, early], { 'GY-2': ledgerState('GY-2', 2, 'refused', { refusal: { kind: 'merge', reason: `${trialFailurePrefix}: tests tests/x.test.ts` } }) }, start)?.key, 'GY-1', 'a head whose trial failed waits for its rework');
  assert.equal(nextToMerge([late, early], { 'GY-2': ledgerState('GY-2', 2, 'reconciled') }, start)?.key, 'GY-1', 'a head already reconciled has no turn');
  const github = submitted(4, 90, ['src/app.ts'], { observation: { candidate: { sha: sha('head4') }, checks: [], reviews: [], merged: false } });
  const reworked = submitted(5, 90, ['src/app.ts'], { reworkRequested: true }), done = submitted(6, 90, ['src/app.ts'], { stage: 'done' }), unsubmitted = item({ id: 'w7', key: 'GY-7' });
  const failing = submitted(8, 90, ['src/app.ts'], { gates: gates({ ready: true, review: true }) });
  assert.equal(nextToMerge([github, reworked, done, unsubmitted, failing, late], {}, start)?.key, 'GY-1', 'only a control-plane candidate with its build gate passed is owed a merge');
  assert.equal(nextToMerge([], {}, start), null);
});

test('unit:executor-sensitive-waits-for-review — a sensitive delta (riskOf) needs its review gate passed before the writer takes it, a normal one does not, and the sensitive head waits behind nothing once reviewed', () => {
  const sensitive = submitted(1, 60, ['src/store/schema.ts'], { gates: gates({ ready: true, build: true, test: true }) });
  const normal = submitted(2, 10, ['src/app.ts'], { gates: gates({ ready: true, build: true, test: true }) });
  assert.equal(nextToMerge([sensitive, normal], {}, start)?.key, 'GY-2', 'the older sensitive head waits for its review; the normal one needs none');
  assert.equal(nextToMerge([sensitive], {}, start), null);
  const reviewed = { ...sensitive, gates: gates({ ready: true, build: true, review: true, test: true }) } as Work;
  assert.equal(nextToMerge([reviewed, normal], {}, start)?.key, 'GY-1', 'reviewed, the older sensitive head goes first');
});

/** Ports that answer from memory and record every call in order. */
function fakePorts(options: { pushes?: ('pushed' | 'rejected')[]; holds?: (sha: string) => boolean; failTrial?: boolean; conflict?: string[]; recordFails?: (event: MergeRecordEvent) => boolean; tips?: string[] } = {}) {
  const calls: string[] = [], events: MergeRecordEvent[] = [], recorded: { key: string; event: MergeRecordEvent }[] = [];
  let fetches = 0, trials = 0, pushed = 0;
  const pushes = options.pushes ?? ['pushed'];
  const trialRun = (mergeSha: string): MergeTrialRun => ({ build: 'pass', tests: options.failTrial ? { passed: 1, failed: ['tests/item.test.ts'], files: 2 } : { passed: 2, failed: [], files: 2 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts', 'tests/other.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: options.failTrial ? 1 : 0 } } });
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 3, now: () => start,
    fetch: async () => { calls.push('fetch'); const tips = options.tips ?? [tip]; return tips[Math.min(fetches++, tips.length - 1)]!; },
    merge: async (head, baseTip) => { calls.push(`merge:${head.slice(0, 6)}:${baseTip.slice(0, 6)}`); return options.conflict ? { conflict: options.conflict } : { mergeSha: sha(`merge:${head}:${baseTip}`), files: ['src/app.ts'] }; },
    trial: async mergeSha => { calls.push(`trial:${mergeSha.slice(0, 6)}`); trials++; return trialRun(mergeSha); },
    push: async (mergeSha, baseTip) => { calls.push(`push:${mergeSha.slice(0, 6)}:${baseTip.slice(0, 6)}`); return pushes[Math.min(pushed++, pushes.length - 1)]!; },
    holds: async sha => { calls.push(`holds:${sha.slice(0, 6)}`); return options.holds?.(sha) ?? false; },
    record: async (target, event) => { calls.push(`record:${event.kind}`); if (options.recordFails?.(event)) throw new Error(`killed before ${event.kind} was recorded`); events.push(event); recorded.push({ key: target.key, event }); },
  };
  /** The snapshot as the control plane would show it after these records: a reconciled item is done. */
  const world = (work: Work[]) => work.map(entry => recorded.some(row => row.key === entry.key && row.event.kind === 'reconciled') ? { ...entry, stage: 'done' } as Work : entry);
  return { ports, calls, events, recorded, world, counts: () => ({ trials, pushes: pushed }) };
}

test('unit:executor-intent-recorded-before-push — mergeOne records intent, trial, pushed and reconciled in that order around the one push, the intent naming head, base tip, merge commit and risk; a conflict or a failed trial records a refusal naming the paths, build step or tests and pushes nothing; a head already pushed is only reconciled', async () => {
  const clean = fakePorts();
  const work = submitted(1, 10);
  const outcome = await mergeOne(clean.ports, work);
  const mergeSha = sha(`merge:${sha('head1')}:${tip}`);
  assert.deepEqual(outcome, { outcome: 'merged', mergeSha, baseTip: tip, observedTip: tip, pushes: 1 });
  assert.deepEqual(clean.calls, ['fetch', `merge:${sha('head1').slice(0, 6)}:${tip.slice(0, 6)}`, 'record:intent', `trial:${mergeSha.slice(0, 6)}`, 'record:trial', `push:${mergeSha.slice(0, 6)}:${tip.slice(0, 6)}`, 'record:pushed', 'fetch', 'record:reconciled']);
  assert.ok(clean.calls.indexOf('record:intent') < clean.calls.indexOf('trial:' + mergeSha.slice(0, 6)) && clean.calls.indexOf('record:intent') < clean.calls.findIndex(call => call.startsWith('push:')), 'the intent is on the ledger before the trial runs and before anything is pushed');
  assert.deepEqual(clean.events.map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled']);
  assert.deepEqual(clean.events[0], { kind: 'intent', head: sha('head1'), baseTip: tip, mergeSha, risk: 'normal', at: iso(start) });
  const trial = clean.events[1]!;
  assert.ok(trial.kind === 'trial' && trial.proofs['unit:item-works']?.executed === 1 && trial.files.length === 2, 'the trial record carries the per-proof counts and the files it ran');
  assert.deepEqual(clean.events[2], { kind: 'pushed', mergeSha, pushedAt: iso(start) });
  assert.deepEqual(clean.events[3], { kind: 'reconciled', mergeSha, observedTip: tip });
  // A sensitive delta is intended as such.
  const sensitive = fakePorts();
  await mergeOne(sensitive.ports, submitted(2, 10, ['src/store/schema.ts']));
  assert.equal((sensitive.events[0] as { risk: string }).risk, 'sensitive');
  // A failed trial: the refusal names the failing tests, nothing is pushed, and the trial record stands beside it.
  const failed = fakePorts({ failTrial: true });
  const refused = await mergeOne(failed.ports, work);
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(failed.events.map(event => event.kind), ['intent', 'trial', 'refused']);
  assert.deepEqual(failed.events[2], { kind: 'refused', head: sha('head1'), reason: `${trialFailurePrefix}: tests tests/item.test.ts` });
  assert.ok(!failed.calls.some(call => call.startsWith('push:')), 'a failed trial pushes nothing');
  assert.equal(trialFailureReason({ run: { build: 'fail', tests: { passed: 0, failed: [], files: 0 } } }), `${trialFailurePrefix}: build step npm run build`);
  assert.equal(trialFailureReason({ run: { build: 'pass', tests: { passed: 2, failed: [], files: 2 } } }), null);
  // A conflicting merge has no commit to intend: the refusal alone, naming the paths.
  const conflicted = fakePorts({ conflict: ['src/app.ts', 'docs/x.md'] });
  const conflict = await mergeOne(conflicted.ports, work);
  assert.deepEqual(conflict, { outcome: 'refused', reason: `${trialFailurePrefix}: the merge conflicts in src/app.ts, docs/x.md`, trial: null, conflict: ['src/app.ts', 'docs/x.md'] });
  assert.deepEqual(conflicted.events.map(event => event.kind), ['refused']);
  // Idempotent against the ledger: a head recorded pushed is fetched and reconciled, never pushed again; an open intent the base holds is recorded pushed then reconciled.
  const pushedBefore = fakePorts({ holds: () => true });
  const again = await mergeOne(pushedBefore.ports, { ...work, mergeLedger: ledgerState('GY-1', 1, 'pushed', { pushedAt: iso(start) }) } as Work);
  assert.deepEqual(again, { outcome: 'reconciled', mergeSha: sha('merge1'), observedTip: tip });
  assert.deepEqual(pushedBefore.calls, ['fetch', `holds:${sha('merge1').slice(0, 6)}`, 'fetch', 'record:reconciled']);
  const intended = fakePorts({ holds: () => true });
  await mergeOne(intended.ports, { ...work, mergeLedger: ledgerState('GY-1', 1, 'intent') } as Work);
  assert.deepEqual(intended.events.map(event => event.kind), ['pushed', 'reconciled']);
  const unheld = fakePorts({ holds: () => false });
  await mergeOne(unheld.ports, { ...work, mergeLedger: ledgerState('GY-1', 1, 'intent') } as Work);
  assert.deepEqual(unheld.events.map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled'], 'an open intent the base does not hold starts the merge over, with a new intent first');
  await assert.rejects(mergeOne(fakePorts({ holds: () => false }).ports, { ...work, mergeLedger: ledgerState('GY-1', 1, 'pushed', { pushedAt: iso(start) }) } as Work), /recorded pushed but main does not hold it/);
  await assert.rejects(mergeOne(clean.ports, item({ id: 'w9', key: 'GY-9' })), /no submitted candidate/);
});

test('unit:executor-stale-retrial-bounded — a push the tip moved under re-reads the tip and re-trials the head on it, at most run.mergeWriter.retrials times, then records merge.refused `base moved N times` and leaves the head queued; one rejection followed by a success merges on the second tip', async () => {
  const work = submitted(1, 10);
  const stale = fakePorts({ pushes: ['rejected'], tips: [tip, newerTip, sha('tip3'), sha('tip4'), sha('tip5')] });
  const outcome = await mergeOne(stale.ports, work);
  assert.deepEqual(outcome, { outcome: 'requeued', reason: baseMovedReason(4), pushes: 4 });
  assert.deepEqual(stale.counts(), { trials: 4, pushes: 4 }, 'the first trial and three re-trials, each on the tip just read');
  const merges = stale.calls.filter(call => call.startsWith('merge:'));
  assert.deepEqual(merges.map(call => call.split(':')[2]), [tip, newerTip, sha('tip3'), sha('tip4')].map(entry => entry.slice(0, 6)), 'every re-trial merges onto the newly read tip');
  assert.deepEqual(stale.events.filter(event => event.kind === 'intent').length, 4, 'each re-trial records its own intent before its trial');
  assert.deepEqual(stale.events.at(-1), { kind: 'refused', head: sha('head1'), reason: 'base moved 4 times' });
  // Refused this way the head is queued again, not reworked.
  const refusedState = ledgerState('GY-1', 1, 'refused', { refusal: { kind: 'merge', reason: baseMovedReason(4) } });
  assert.equal(nextToMerge([work], { 'GY-1': refusedState }, start)?.key, 'GY-1');
  assert.equal(trialFailedGround({ ...work, mergeLedger: refusedState } as Work), null, 'a base-moved refusal grounds no rework');
  // A bound of zero re-trials refuses on the first rejection.
  const none = fakePorts({ pushes: ['rejected'] }); none.ports.retrials = 0;
  assert.deepEqual(await mergeOne(none.ports, work), { outcome: 'requeued', reason: baseMovedReason(1), pushes: 1 });
  // One rejection then a success: the merge lands on the second tip, with its lease on that tip.
  const once = fakePorts({ pushes: ['rejected', 'pushed'], tips: [tip, newerTip] });
  const merged = await mergeOne(once.ports, work);
  assert.equal(merged.outcome, 'merged');
  assert.deepEqual([(merged as { baseTip: string }).baseTip, (merged as { pushes: number }).pushes], [newerTip, 2]);
  assert.ok(once.calls.includes(`push:${sha(`merge:${sha('head1')}:${newerTip}`).slice(0, 6)}:${newerTip.slice(0, 6)}`), 'the second push is leased on the second tip');
});

/** A child runner that records every call and answers git's reads; `answers` decides what each command returns or throws. */
function recordingRun(answers: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => string | Promise<string>) {
  const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run: ChildRun = async (command, args, options) => { calls.push({ command, args, env: options?.env }); return answers(command, args, options); };
  return { calls, run };
}
const childFailure = (status: number, stdout: string, stderr: string) => Object.assign(new Error(`exit ${status}`), { status, stdout, stderr });

test('unit:executor-push-leased-deploy-key-only — the push is `git push origin --force-with-lease=refs/heads/BASE:<baseTip> <mergeSha>:refs/heads/BASE` with GIT_SSH_COMMAND naming the deploy key alone (IdentitiesOnly, accept-new) and no other credential in the child environment; a stale-lease rejection answers rejected, any other failure throws', async () => {
  const mergeSha = sha('merge1');
  const environment = { PATH: '/usr/bin', HOME: '/home/loop', GH_TOKEN: 'gh', GITHUB_TOKEN: 'ghs', SSH_AUTH_SOCK: '/run/agent.sock', GIT_SSH_COMMAND: 'ssh -i /home/loop/.ssh/id_ed25519', GRAPHYARD_TOKEN_FILE: '/outside/token', GRAPHYARD_COORDINATOR_URL: 'https://x', HERDR_ENV: '1', GH_CONFIG_DIR: '/home/loop/.config/gh' };
  const env = pushEnvironment('/keys/deploy', environment);
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i /keys/deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new');
  assert.equal(deployKeySshCommand('/k'), 'ssh -i /k -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new');
  assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'HOME', 'PATH'], 'tokens, the agent socket, gh configuration and every Graphyard and Herdr variable are withheld');
  assert.deepEqual(pushArgs('main', tip, mergeSha), ['push', 'origin', `--force-with-lease=refs/heads/main:${tip}`, `${mergeSha}:refs/heads/main`]);
  let answer: 'ok' | 'stale' | 'broken' = 'ok';
  const git = recordingRun((command, args) => {
    if (args.includes('push')) { if (answer === 'stale') throw childFailure(1, '', ` ! [rejected]        ${mergeSha.slice(0, 7)} -> main (stale info)\nerror: failed to push some refs to 'origin'`); if (answer === 'broken') throw childFailure(128, '', 'fatal: Could not read from remote repository.'); return ''; }
    if (args.includes('rev-parse')) return `${tip}\n`;
    return '';
  });
  const reads = mergeWriterReads(config, '/coordinator', git.run, { base: '/worktrees', record: async () => {}, merger: async () => 'control-plane', environment });
  assert.equal(await reads.push(mergeSha, tip), 'pushed');
  const push = git.calls.find(call => call.args.includes('push'))!;
  assert.deepEqual([push.command, push.args], ['git', ['-C', '/coordinator', 'push', 'origin', `--force-with-lease=refs/heads/main:${tip}`, `${mergeSha}:refs/heads/main`]]);
  assert.deepEqual(push.env, env, 'the push child sees exactly the credential-free environment plus the deploy key');
  assert.equal(push.env!.GH_TOKEN, undefined); assert.equal(push.env!.SSH_AUTH_SOCK, undefined); assert.equal(push.env!.GRAPHYARD_TOKEN_FILE, undefined);
  answer = 'stale';
  assert.equal(await reads.push(mergeSha, tip), 'rejected', 'a lease the tip moved under is a rejection, not a failure');
  answer = 'broken';
  await assert.rejects(reads.push(mergeSha, tip), (error: { status?: number; stderr?: string }) => error.status === 128 && /Could not read from remote repository/.test(error.stderr ?? ''), 'any other failure is thrown as it came');
  assert.equal(reads.retrials, 3); assert.equal(reads.baseBranch, 'main');
  assert.equal(await reads.fetch(), tip);
  const fetch = git.calls.find(call => call.args.includes('fetch'))!;
  assert.deepEqual(fetch.args, ['-C', '/coordinator', 'fetch', '--no-tags', 'origin', 'main'], 'only the base is fetched: the head is already in the shared object store');
  // The deploy key defaults to the install's, under ~/.config/graphyard/<install>/deploy-key, and `~/` is the home directory.
  assert.deepEqual(mergeWriterSettings({}, 'owner-project', '/home/loop'), { deployKeyFile: '/home/loop/.config/graphyard/owner-project/deploy-key', retrials: defaultMergeWriterRetrials });
  assert.equal(defaultDeployKeyFile('owner-project', '/h'), '/h/.config/graphyard/owner-project/deploy-key');
  assert.deepEqual(mergeWriterSettings({ mergeWriter: { deployKeyFile: '~/keys/deploy', retrials: 1 } }, 'owner-project', '/home/loop'), { deployKeyFile: '/home/loop/keys/deploy', retrials: 1 });
  assert.throws(() => mergeWriterSettingsSchema.parse({ retrials: 11 }));
  assert.throws(() => mergeWriterSettingsSchema.parse({ deployKey: '/k' }), /unrecognized/i);
  assert.equal(masterConfigSchema.parse({ ...config, run: { mergeWriter: { deployKeyFile: '/k', retrials: 2 } } }).run.mergeWriter?.retrials, 2, 'run.mergeWriter is a master.json setting');
});

test('unit:executor-trial-runs-criterion-tests — the trial\'s selection is the affected pre-merge files plus every test file whose cases carry one of the item\'s unit:/integration: proof ids (found by git grep at the merge commit), the run is read as TAP, and the record stores per-proof executed and failed counts beside the failing files', async () => {
  const mergeSha = sha('merge1');
  const grep = recordingRun((_command, args) => { if (args.includes('grep')) return `${mergeSha}:tests/proof.test.ts\n${mergeSha}:tests/a.test.ts\n`; return ''; });
  assert.deepEqual(await proofTestFiles(grep.run, '/coordinator', mergeSha, ['unit:alpha-works', 'integration:beta-holds']), ['tests/a.test.ts', 'tests/proof.test.ts']);
  assert.deepEqual(grep.calls[0]!.args, ['-C', '/coordinator', 'grep', '-l', '-F', '-e', 'unit:alpha-works', '-e', 'integration:beta-holds', mergeSha, '--', 'tests/*.test.ts']);
  assert.deepEqual(await proofTestFiles(recordingRun(() => { throw childFailure(1, '', ''); }).run, '/c', mergeSha, ['unit:none']), [], 'no match is no file');
  assert.deepEqual(await proofTestFiles(grep.run, '/c', mergeSha, []), []);
  assert.deepEqual(criterionProofs(item({})), ['unit:item-works', 'integration:item-holds'], 'manual proofs have no test file to run');
  // The trial itself, over a runner that answers each phase; the run-tests call gets the TAP reporter and the widened list.
  const base = await temporaryDirectory('merge-trial-base');
  const tap = ['TAP version 13', '# Subtest: tests/a.test.ts', '    ok 1 - unit:alpha-works — the thing', '    not ok 2 - integration:beta-holds — more', '    1..2', 'not ok 1 - tests/a.test.ts', '# Subtest: tests/proof.test.ts', '    ok 1 - unit:alpha-works — again', '    ok 2 - unit:alpha-works-not-this — a longer title is another proof', '    1..2', 'ok 2 - tests/proof.test.ts', '1..2', ''].join('\n');
  let listed: string[] = [], runnerArgs: string[] = [];
  const runner = recordingRun(async (command, args) => {
    if (command === 'node' && args[0] === 'scripts/ci-tests.mjs') { assert.deepEqual(args.slice(1), ['affected', 'src/app.ts']); return 'affected: 1 of 5 test files are affected by 1 changed file(s)\ntests/a.test.ts\n'; }
    if (command === 'node' && args.includes('tests/helpers/run-tests.ts')) {
      runnerArgs = args;
      listed = (await readFile(args[args.indexOf('--files-from') + 1]!, 'utf8')).split('\n').filter(Boolean);
      throw childFailure(1, tap, '');
    }
    return '';
  });
  const verdict = await runMergeTrial({ root: '/coordinator', base, mergeSha, changedFiles: ['src/app.ts'], proofs: ['unit:alpha-works', 'integration:beta-holds', 'unit:never-ran'], proofFiles: ['tests/a.test.ts', 'tests/proof.test.ts'], timeoutMs: 60_000, key: 'GY-1', run: runner.run, remove: async () => {} });
  assert.deepEqual(listed, ['tests/a.test.ts', 'tests/proof.test.ts'], 'the affected file once, plus the proof file the selection lacked');
  assert.deepEqual(runnerArgs.slice(runnerArgs.indexOf('tests/helpers/run-tests.ts') + 1, runnerArgs.indexOf('--files-from')), ['--test-reporter=tap', '--test-reporter-destination=stdout'], 'the run is read as TAP');
  assert.deepEqual(verdict.proofs, { 'unit:alpha-works': { executed: 2, failed: 0 }, 'integration:beta-holds': { executed: 1, failed: 1 }, 'unit:never-ran': { executed: 0, failed: 0 } }, 'cases are attributed by title prefix, a proof whose name is a prefix of another counts only its own');
  assert.deepEqual([verdict.build, verdict.tests], ['pass', { passed: 1, failed: ['tests/a.test.ts'], files: 2 }]);
  assert.deepEqual(verdict.files, ['tests/a.test.ts', 'tests/proof.test.ts']);
  assert.equal(trialFailureReason({ run: verdict }), `${trialFailurePrefix}: tests tests/a.test.ts`);
  assert.deepEqual(countProofCases(tap, 'integration:beta-holds'), { executed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(countProofCases('ok 1 - unit:x # SKIP later\n', 'unit:x'), { executed: 0, failed: 0, skipped: 1 });
  const phases = runner.calls.map(call => `${call.command} ${call.args.slice(0, 2).join(' ')}`);
  assert.ok(phases.some(phase => phase.startsWith('npm run')) && phases.some(phase => phase.startsWith('git -C')), `build and checkout ran: ${phases.join('; ')}`);
  await rm(base, { recursive: true, force: true });
});

// ——— The step in a cycle, over injected reads ———
/** The key of the merge in flight, read without narrowing the state for the assertions that follow. */
const inFlightKey = (state: DaemonState) => (state.mergeWriter.inFlight as { key: string } | null)?.key ?? null;
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
function effectsFor(world: { work: () => Work[] | Promise<Work[]>; now: () => number; mergeWriter: MergeWriterReads | null | undefined; decide?: DaemonEffects['decide'] }) {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: await world.work(), now: iso(world.now()) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(world.now()), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: null, mergeWriter: world.mergeWriter, ...(world.decide ? { decide: world.decide } : {}),
  } as unknown as DaemonEffects;
}
/** Reads over fake ports, switched by `merger`. */
const fakeReads = (ports: MergePorts, merger: () => Promise<'github' | 'control-plane'>): MergeWriterReads => ({ ...ports, merger });

test('unit:merge-writer-step-off-in-github-mode — the step runs right after the merge step and does nothing while the recorded merger is github (no git, no push, an emptied queue) or without its reads; under control-plane it reconciles open intents, reports the queue and merges one head beside the cycle, then requests the rework a failed trial grounds', async () => {
  const work = [submitted(2, 5), submitted(1, 30)], now = () => start;
  const off = fakePorts();
  const state = emptyDaemonState(config);
  state.mergeWriter.queue = [{ key: 'GY-9', id: 'w9', head: sha('h'), submittedAt: iso(start), waitingMs: 1 }];
  const { metrics } = await runCycle(config, state, effectsFor({ work: () => work, now, mergeWriter: fakeReads(off.ports, async () => 'github') }), now);
  assert.deepEqual([off.calls, state.mergeWriter.queue, state.mergeWriter.inFlight], [[], [], null], 'under the github merger the step reads nothing and merges nothing');
  const steps = (metrics.timings?.steps ?? []).map(step => step.step);
  assert.ok(steps.indexOf('merge writer') > steps.indexOf('merges') && steps.indexOf('merge writer') < steps.indexOf('shadow gate'), `the step runs right after the merge step: ${steps.join(', ')}`);
  const bare = emptyDaemonState(config);
  await runCycle(config, bare, effectsFor({ work: () => work, now, mergeWriter: null }), now);
  assert.deepEqual(bare.mergeWriter, emptyMergeWriterState());
  // Under control-plane: the queue is reported oldest first, the oldest head is merged beside the cycle, and the next cycle records it.
  const on = fakePorts();
  const live = emptyDaemonState(config);
  const effects = effectsFor({ work: () => on.world(work), now, mergeWriter: fakeReads(on.ports, async () => 'control-plane') });
  await runCycle(config, live, effects, now);
  assert.deepEqual(live.mergeWriter.queue.map(entry => entry.key), ['GY-1', 'GY-2']);
  assert.equal(inFlightKey(live), 'GY-1');
  await mergeWriterIdle(live);
  const recorded = await runCycle(config, live, effects, now);
  assert.equal(live.mergeWriter.lastMergeAt, iso(start));
  assert.ok(recorded.actions.some(action => action.state === 'done' && /^Merged GY-1 head/.test(action.detail)), JSON.stringify(recorded.actions.map(action => action.detail)));
  assert.deepEqual(on.events.slice(0, 4).map(event => event.kind), ['intent', 'trial', 'pushed', 'reconciled']);
  assert.deepEqual([live.mergeWriter.queue.map(entry => entry.key), inFlightKey(live)], [['GY-2'], 'GY-2'], 'the delivered head leaves the queue and the next one is merged, one at a time');
  await mergeWriterIdle(live);
  await runCycle(config, live, effects, now);
  assert.deepEqual([live.mergeWriter.queue, live.mergeWriter.inFlight, on.recorded.filter(row => row.event.kind === 'reconciled').map(row => row.key)], [[], null, ['GY-1', 'GY-2']]);
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(live))).mergeWriter, live.mergeWriter, 'the state round-trips through the daemon state schema');
  // An open intent on the snapshot is reconciled before any new merge: nothing starts that cycle.
  const crashed = fakePorts({ holds: () => true });
  const reconcile = emptyDaemonState(config);
  const withIntent = [{ ...work[1]!, mergeLedger: ledgerState('GY-1', 1, 'intent') } as Work, work[0]!];
  const settled = await runCycle(config, reconcile, effectsFor({ work: () => withIntent, now, mergeWriter: fakeReads(crashed.ports, async () => 'control-plane') }), now);
  assert.deepEqual(crashed.events.map(event => event.kind), ['pushed', 'reconciled'], 'the held intent is recorded pushed and reconciled, without a push');
  assert.equal(reconcile.mergeWriter.inFlight, null, 'no new merge starts in the cycle that reconciled');
  assert.ok(settled.actions.some(action => /^Reconciled an open intent of GY-1/.test(action.detail)));
  assert.equal(reconcile.mergeWriter.lastMergeAt, iso(start));
  // A trial that fails: the refusal is kept, and the rework it grounds is requested with the writer's binding.
  const failing = fakePorts({ failTrial: true });
  const decided: { key: string; action: string; reason: string; input: unknown }[] = [];
  const reworked = emptyDaemonState(config);
  const failingEffects = effectsFor({ work: () => work, now, mergeWriter: fakeReads(failing.ports, async () => 'control-plane'), decide: async (target, action, reason, input) => { decided.push({ key: target.key, action, reason, input }); return { id: randomUUID() }; } });
  await runCycle(config, reworked, failingEffects, now); await mergeWriterIdle(reworked);
  const refusedCycle = await runCycle(config, reworked, failingEffects, now);
  assert.deepEqual(reworked.mergeWriter.refusals.map(entry => [entry.key, entry.reason]), [['GY-1', `${trialFailurePrefix}: tests tests/item.test.ts`]]);
  assert.deepEqual(decided, [{ key: 'GY-1', action: 'rework', ...trialFailureRework(work[1]!, sha('head1'), `${trialFailurePrefix}: tests tests/item.test.ts`) } as unknown as typeof decided[number]]);
  assert.equal(decided[0]!.input && (decided[0]!.input as { binding: string }).binding, `${sha('head1')}:${mergeWriterTrialGround}`);
  assert.ok(refusedCycle.actions.some(action => action.state === 'failed' && /refused: trial failed: tests tests\/item\.test\.ts/.test(action.detail)));
  // A base that moved past the bound leaves the head queued and asks for no rework.
  const moved = fakePorts({ pushes: ['rejected'] });
  const requeued = emptyDaemonState(config); decided.length = 0;
  const movedEffects = effectsFor({ work: () => work, now, mergeWriter: fakeReads(moved.ports, async () => 'control-plane'), decide: async (target, action, reason, input) => { decided.push({ key: target.key, action, reason, input }); return { id: randomUUID() }; } });
  await runCycle(config, requeued, movedEffects, now); await mergeWriterIdle(requeued); await runCycle(config, requeued, movedEffects, now);
  assert.deepEqual([decided, requeued.mergeWriter.refusals[0]?.reason], [[], baseMovedReason(4)]);
});

test('unit:merge-writer-status — master status and the daemon summary show mergeWriter.queue (oldest first), inFlight, lastMergeAt and refusals; the loop\'s own effects wire the reads with the merge-record post under one key per step; docs/delivery-redesign.md Merge writer states the sequence and the reconcile rule within 80 net words', async () => {
  const state = emptyDaemonState(config);
  state.mergeWriter = { lastMergeAt: iso(start), queue: [{ key: 'GY-2', id: 'w2', head: sha('head2'), submittedAt: iso(start - minute), waitingMs: minute }], inFlight: { key: 'GY-1', id: 'w1', head: sha('head1'), startedAt: iso(start) }, refusals: [{ key: 'GY-3', head: sha('head3'), reason: baseMovedReason(4), at: iso(start) }] };
  const summary = daemonSummary(state, start, config.run.intervalSeconds * 1000, config.hostId);
  assert.deepEqual(summary.mergeWriter, mergeWriterSummary(state.mergeWriter));
  assert.deepEqual(summary.mergeWriter.queue.map(entry => entry.key), ['GY-2']);
  assert.equal(summary.mergeWriter.inFlight?.key, 'GY-1');
  assert.deepEqual(mergeWriterSummary(undefined), { queue: [], inFlight: null, lastMergeAt: null, refusals: [] });
  assert.match(readFileSync(`${root}src/cli/master/operations.ts`, 'utf8'), /mergeWriter: mergeWriterSummary\(state\?\.mergeWriter\)/, 'master status prints the section beside shadowGate');
  assert.throws(() => mergeWriterStateSchema.parse({ queue: Array.from({ length: 51 }, () => state.mergeWriter.queue[0]) }), 'the queue keeps at most 50');
  assert.deepEqual(emptyDaemonState(config).mergeWriter, { lastMergeAt: null, queue: [], inFlight: null, refusals: [] });
  // The loop's effects: the reads over the coordinator checkout, each step posted as the coordinator under its own key.
  const posted: { path: string; data: unknown; key?: string }[] = [];
  const git = recordingRun(() => `${tip}\n`);
  const credentialFile = join(await temporaryDirectory('merge-writer-credential'), 'coordinator.token');
  await writeFile(credentialFile, `${'c'.repeat(48)}\n`, { mode: 0o600 });
  const wired = daemonEffects('/coordinator', { ...config, credentialFile }, { snapshot: async () => ({ work: [], now: iso(start) }), mutate: async (path, data, key) => { posted.push({ path, data, key }); return {}; }, run: git.run, fetcher: (async () => new Response(JSON.stringify({ mergeWriter: { merger: 'control-plane' } }), { status: 200 })) as typeof fetch });
  assert.ok(wired.mergeWriter, 'the loop wires the merge writer reads');
  assert.equal(await wired.mergeWriter!.merger(), 'control-plane');
  const event: MergeRecordEvent = { kind: 'pushed', mergeSha: sha('merge1'), pushedAt: iso(start) };
  await wired.mergeWriter!.record(item({ id: 'w1', key: 'GY-1' }), event);
  assert.deepEqual(posted, [{ path: 'work/w1/merge-record', data: event, key: mergeRecordKey({ id: 'w1' }, event) }]);
  assert.equal(mergeRecordKey({ id: 'w1' }, event), `merge-record:w1:pushed:${sha('merge1')}`);
  assert.equal(mergeRecordKey({ id: 'w1' }, { kind: 'refused', head: sha('head1'), reason: 'x' }), `merge-record:w1:refused:${sha('head1')}:refused`);
  assert.equal(wired.mergeWriter!.retrials, 3);
  // The docs: the Merge writer section names the sequence and the reconcile rule, and grew by at most 80 words.
  const docs = readFileSync(`${root}docs/delivery-redesign.md`, 'utf8');
  const section = docs.split(/^## Merge writer\s*$/m)[1]!.split(/\n## /)[0]!;
  for (const phrase of ['`merge.intent`', '`merge.pushed`', '`merge.reconciled`', '`git push --force-with-lease`', '`run.mergeWriter.deployKeyFile`', 'Reconcile rule', '`mergeWriter.queue`']) assert.ok(section.includes(phrase), `Merge writer names ${phrase}`);
  const base = ['origin/main', 'HEAD^1'].map(ref => { try { return execFileSync('git', ['show', `${ref}:docs/delivery-redesign.md`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } }).find(text => text !== null) ?? null;
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  const mainSection = base?.split(/^## Merge writer\s*$/m)[1]?.split(/\n## /)[0];
  if (mainSection) assert.ok(words(section) - words(mainSection) <= 80, `Merge writer grew by ${words(section) - words(mainSection)} words, at most 80`);
});

// ——— Against a real control plane and a bare origin ———
const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [admin, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let pg: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixtureRoot: string, origin: string, checkout: string, worktreeBase: string, baseTip: string;
const heads: Record<number, string> = {};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('merge-executor'));
  origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout'); worktreeBase = join(fixtureRoot, 'managed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  await commit(checkout, 'src/app.ts', 'export const app = 1;\n', 'app');
  await commit(checkout, 'tests/app.test.ts', "import { test } from 'node:test';\ntest('unit:app-works — the app answers', () => {});\n", 'test');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  // Each worker's branch is a linked worktree of the checkout: its commit lands in the shared object store, nothing is pushed (GY-1523).
  for (const [n, file] of [[1, 'src/app.ts'], [2, 'src/other.ts'], [3, 'src/third.ts'], [4, 'src/fourth.ts'], [5, 'src/fifth.ts'], [6, 'src/sixth.ts'], [7, 'src/seventh.ts']] as const) {
    const worktree = join(checkout, '.graphyard', 'worktrees', `GY-${n}-1`);
    git(checkout, 'worktree', 'add', '-q', '-b', `graphyard/gy-${n}-1`, worktree, baseTip);
    git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
    heads[n] = await commit(worktree, file, `export const value = ${n};\n`, `change ${n}`);
  }
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1524;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('merge-executor-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('merge_executor_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/merge_executor_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await new MergerSettings(store).change(admin, { merger: 'control-plane', reason: 'the executor is under test' }, randomUUID());
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

async function request(credential: string, path: string, body?: unknown, key: string = randomUUID(), method = 'POST') {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
/** An item the worker claimed, registered on its branch and submitted with `complete --head`, as GY-1523 submits it. */
async function submittedItem(n: number) {
  let w = await engine.execute(admin, 'create', null, { title: `Executor fixture ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:app-works'] }] }, randomUUID());
  w = await engine.execute(admin, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused)); w = pulled.assigned!;
  await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/exec-${n}`, branch: `graphyard/gy-${n}-1` }, randomUUID());
  const body = completionBody(['1', '--head', heads[n]!], () => heads[n]!);
  assert.deepEqual(body, { epoch: 1, head: heads[n] });
  return engine.execute(worker, 'submit', w.id, body, randomUUID());
}
const document = async (id: string) => (await store.workDocument(id))!;
const ledgerKinds = async (id: string) => (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND kind LIKE 'merge%' ORDER BY seq", [id])).rows.map(row => row.kind as string);
/** The coordinator's record port: the route, under the step's own key, as effects.ts posts it. */
const record: MergePorts['record'] = async (work, event) => {
  const answer = await request(token(coordinator), `work/${work.id}/merge-record`, event, mergeRecordKey(work, event));
  if (answer.status !== 200) throw new Error(`merge-record ${event.kind} refused (${answer.status}): ${JSON.stringify(answer.body)}`);
  return answer.body;
};
/** The real reads over the fixture checkout, with the trial stubbed to pass and every git call counted. */
function fixtureReads(options: { record?: MergePorts['record']; trial?: (input: Parameters<typeof runMergeTrial>[0]) => Promise<MergeTrialRun> } = {}) {
  const pushes: { args: string[]; env?: NodeJS.ProcessEnv }[] = [], trials: Parameters<typeof runMergeTrial>[0][] = [];
  const run: ChildRun = (command, args, runOptions) => { if (command === 'git' && args.includes('push')) pushes.push({ args, env: runOptions?.env }); return defaultChildRun(command, args, runOptions); };
  const trial = options.trial ?? (async (input: Parameters<typeof runMergeTrial>[0]): Promise<MergeTrialRun> => { trials.push(input); return { build: 'pass', tests: { passed: input.proofFiles.length, failed: [], files: input.proofFiles.length }, durationMs: 5, logTail: 'ok', files: [...input.proofFiles], proofs: Object.fromEntries(input.proofs.map(proof => [proof, { executed: 1, failed: 0 }])) }; });
  const fixtureConfig = masterConfigSchema.parse({ ...config, run: { mergeWriter: { deployKeyFile: join(fixtureRoot, 'deploy-key'), retrials: 3 } } });
  const reads = mergeWriterReads(fixtureConfig, checkout, run, { base: worktreeBase, record: options.record ?? record, merger: async () => 'control-plane', trial });
  return { reads, pushes, trials };
}
const firstParents = () => git(origin, 'rev-list', '--first-parent', 'main').split('\n');

test('integration:control-plane-merge-end-to-end — a worker commit under a lease, complete --head, the executor merges in a cycle: main\'s first parent is the exact tested merge commit, the item is done with that mergeSha, the ledger holds intent, pushed and reconciled in order, and the trial ran the file carrying the item\'s proof', async () => {
  const w = await submittedItem(1);
  assert.equal(w.observation?.source, 'control-plane');
  assert.deepEqual(w.gates.find(gate => gate.name === 'test')!.reasons, [trialRefusal(heads[1]!, baseTip)]);
  assert.ok(w.gates.find(gate => gate.name === 'build')!.passed, JSON.stringify(w.gates.find(gate => gate.name === 'build')));
  const { reads, pushes, trials } = fixtureReads();
  const state = emptyDaemonState(config), now = () => start;
  const effects = effectsFor({ work: async () => [await document(w.id)], now, mergeWriter: reads });
  await runCycle(config, state, effects, now);
  assert.equal(inFlightKey(state), w.key, 'the submitted head is the queue\'s one entry and is merged beside the cycle');
  await mergeWriterIdle(state);
  const recorded = await runCycle(config, state, effects, now);
  assert.equal(state.mergeWriter.inFlight, null);
  const merged = recorded.actions.find(action => action.work === w.key && action.state === 'done');
  assert.ok(merged && /^Merged GY-\d+ head/.test(merged.detail), JSON.stringify(recorded.actions.map(action => action.detail)));
  const done = await document(w.id);
  assert.equal(done.stage, 'done');
  const mergeSha = done.delivery!.mergeSha;
  assert.equal(firstParents()[0], mergeSha, 'main\'s first parent is the exact merge commit the trial tested');
  assert.equal(git(origin, 'rev-parse', `${mergeSha}^1`), baseTip); assert.equal(git(origin, 'rev-parse', `${mergeSha}^2`), heads[1]);
  assert.equal(git(origin, 'show', '-s', '--format=%an', mergeSha), 'graphyard-merge-writer', 'the merge commit is the trial\'s own');
  assert.deepEqual(await ledgerKinds(w.id), ['merge.intent', 'merge-writer.intent', 'merge.trial', 'merge-writer.trial', 'merge.pushed', 'merge-writer.pushed', 'merge.reconciled', 'merge-writer.delivered']);
  assert.deepEqual(done.mergeLedger && [done.mergeLedger.state, done.mergeLedger.head, done.mergeLedger.baseTip, done.mergeLedger.mergeSha, done.mergeLedger.observedTip], ['reconciled', heads[1], baseTip, mergeSha, mergeSha]);
  assert.equal(done.delivery!.authorizationRevision, done.revision - 1);
  assert.deepEqual([done.observation?.merged, done.observation?.mergeSha], [true, mergeSha]);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM jobs WHERE work_id=$1', [w.id])).rows[0].n, 0, 'the jobs row is gone');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0]!.args.slice(2), ['push', 'origin', `--force-with-lease=refs/heads/main:${baseTip}`, `${mergeSha}:refs/heads/main`]);
  assert.equal(pushes[0]!.env?.GIT_SSH_COMMAND, deployKeySshCommand(join(fixtureRoot, 'deploy-key')));
  assert.equal(pushes[0]!.env?.GRAPHYARD_TEST_PORT, undefined, 'no Graphyard variable reaches the push child');
  assert.equal(trials.length, 1);
  assert.deepEqual([trials[0]!.mergeSha, trials[0]!.changedFiles, trials[0]!.proofs, trials[0]!.proofFiles], [mergeSha, ['src/app.ts'], ['unit:app-works'], ['tests/app.test.ts']], 'the trial runs on the exact merge commit with the file carrying the item\'s proof');
  const trialRow = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='merge.trial'", [w.id])).rows[0].payload;
  assert.deepEqual(trialRow.proofs, { 'unit:app-works': { executed: 1, failed: 0 } });
  // Delivered, the item is out of the queue; the gates passed through the ledger.
  assert.equal(nextToMerge([done], snapshotLedger([done]), start), null);
  assert.equal(state.mergeWriter.lastMergeAt, iso(start));
});

test('integration:executor-reconcile-after-crash — killed between the push and its record, the executor leaves an intent on the ledger that blocks the queue; the next cycle reconciles it against main\'s first-parent history and delivers the item without a second push, and an intent main does not hold is re-queued', async () => {
  const w = await submittedItem(2);
  let killed = false;
  const crashing = fixtureReads({ record: async (work, event) => { if (event.kind === 'pushed' && !killed) { killed = true; throw new Error('killed between the push and the record'); } return record(work, event); } });
  await assert.rejects(mergeOne(crashing.reads, await document(w.id)), /killed between the push and the record/);
  assert.equal(crashing.pushes.length, 1, 'the push happened');
  let open = await document(w.id);
  assert.notEqual(open.stage, 'done', 'the item is not delivered: nothing recorded the push');
  assert.equal(open.mergeLedger?.state, 'intent');
  const mergeSha = open.mergeLedger!.mergeSha!;
  assert.equal(firstParents()[0], mergeSha, 'main holds the merge commit the ledger only intends');
  assert.deepEqual(await ledgerKinds(w.id), ['merge.intent', 'merge-writer.intent', 'merge.trial', 'merge-writer.trial']);
  const other = await submittedItem(3);
  const blocked = mergeQueue([open, other], snapshotLedger([open, other]), start);
  assert.deepEqual([blocked.next?.key ?? null, blocked.blockedBy], [null, open.key], 'the open intent blocks the queue');
  // The next cycle: reconciled before anything new, delivered without a second push.
  const healthy = fixtureReads();
  const state = emptyDaemonState(config), now = () => start;
  const effects = effectsFor({ work: async () => [await document(w.id), await document(other.id)], now, mergeWriter: healthy.reads });
  const settled = await runCycle(config, state, effects, now);
  assert.ok(settled.actions.some(action => /^Reconciled an open intent of GY-\d+: main holds/.test(action.detail)), JSON.stringify(settled.actions.map(action => action.detail)));
  assert.equal(state.mergeWriter.inFlight, null, 'nothing new starts in the reconciling cycle');
  const done = await document(w.id);
  assert.equal(done.stage, 'done'); assert.equal(done.delivery?.mergeSha, mergeSha);
  assert.deepEqual(await ledgerKinds(w.id), ['merge.intent', 'merge-writer.intent', 'merge.trial', 'merge-writer.trial', 'merge.pushed', 'merge-writer.pushed', 'merge.reconciled', 'merge-writer.delivered']);
  assert.equal(healthy.pushes.length, 0, 'no second push');
  assert.equal(crashing.pushes.length, 1);
  // The cycle after merges the next head onto the reconciled main.
  await runCycle(config, state, effects, now);
  assert.equal(inFlightKey(state), other.key);
  await mergeWriterIdle(state);
  await runCycle(config, state, effects, now);
  const third = await document(other.id);
  assert.equal(third.stage, 'done');
  assert.deepEqual(firstParents().slice(0, 2), [third.delivery!.mergeSha, mergeSha]);
  assert.equal(git(origin, 'rev-parse', `${third.delivery!.mergeSha}^1`), mergeSha, 'the second merge is leased on the first merge as its tip');
  assert.equal(healthy.pushes.length, 1);
  // An intent main does not hold (a crash before the push) is refused as never pushed and the head queued again.
  const w4 = await submittedItem(4);
  const fakeMerge = sha('never-pushed');
  await record(w4, { kind: 'intent', head: heads[4]!, baseTip: third.delivery!.mergeSha, mergeSha: fakeMerge, risk: 'normal', at: iso(start) });
  let w4doc = await document(w4.id);
  assert.equal(w4doc.mergeLedger?.state, 'intent');
  assert.deepEqual(w4doc.gates.find(gate => gate.name === 'test')!.reasons, [], 'the intent passes the test gate');
  assert.deepEqual(w4doc.gates.find(gate => gate.name === 'merge')!.reasons.filter(reason => reason === pushRefusal(heads[4]!)), [pushRefusal(heads[4]!)]);
  const outcomes = await reconcileIntents(healthy.reads, [w4doc], snapshotLedger([w4doc]));
  assert.deepEqual(outcomes, [{ key: w4.key, mergeSha: fakeMerge, outcome: 'requeued' }]);
  w4doc = await document(w4.id);
  assert.deepEqual([w4doc.mergeLedger?.state, w4doc.mergeLedger?.refusal?.reason], ['refused', unpushedIntentReason(fakeMerge, 'main')]);
  assert.equal(nextToMerge([w4doc], snapshotLedger([w4doc]), start)?.key, w4.key, 're-queued');
  assert.equal(trialFailedGround(w4doc), null, 'and not reworked');
  assert.deepEqual(w4doc.gates.find(gate => gate.name === 'test')!.reasons, [trialRefusal(heads[4]!, third.delivery!.mergeSha)], 'the refusal reopens the test gate');
});

test('integration:merge-record-delivers-in-one-transaction — POST /api/work/:id/merge-record is the coordinator\'s alone; intent and pushed re-fold the ledger onto the item and move its gates, and reconciled sets stage done and the delivery, settles the delivered item, deletes its jobs row and saves as merge-writer.delivered, in one transaction, replaying under its key', async () => {
  const w = await submittedItem(5);
  const body: MergeRecordEvent = { kind: 'intent', head: heads[5]!, baseTip: baseTip, mergeSha: sha('m5'), risk: 'normal', at: iso(start) };
  for (const credential of [token(admin), token(worker)]) assert.equal((await request(credential, `work/${w.id}/merge-record`, body)).status, 403);
  assert.deepEqual(await ledgerKinds(w.id), [], 'a refused identity writes nothing');
  assert.ok([400, 422].includes((await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'intent', head: 'main' })).status));
  assert.equal((await request(token(coordinator), `work/${randomUUID()}/merge-record`, body)).status, 404);
  // The real merge of head 5 onto the current tip, pushed by hand so main holds it.
  const { reads } = fixtureReads();
  const currentTip = await reads.fetch();
  const merged = await reads.merge(heads[5]!, currentTip);
  assert.ok('mergeSha' in merged);
  const mergeSha = (merged as { mergeSha: string }).mergeSha;
  const intent = await request(token(coordinator), `work/${w.id}/merge-record`, { ...body, baseTip: currentTip, mergeSha }, 'k-intent');
  assert.equal(intent.status, 200, JSON.stringify(intent.body));
  assert.deepEqual([intent.body.recorded, intent.body.kind, intent.body.stage, intent.body.mergeLedger.state], [true, 'intent', 'review', 'intent'], 'the intent passes the test gate, so the item moves on to review');
  let doc = await document(w.id);
  assert.deepEqual(doc.gates.find(gate => gate.name === 'test')!.reasons, [], 'the intent on this head and tip is the passing trial the test gate wants');
  assert.ok(doc.gates.find(gate => gate.name === 'merge')!.reasons.includes(pushRefusal(heads[5]!)));
  assert.equal((await request(token(coordinator), `work/${w.id}/merge-record`, { ...body, baseTip: currentTip, mergeSha }, 'k-intent')).status, 200, 'a retried key replays');
  assert.equal((await request(token(coordinator), `work/${w.id}/merge-record`, { ...body, baseTip: currentTip, mergeSha: sha('other') }, 'k-intent')).status, 409, 'a key reused with other input is refused');
  assert.equal((await ledgerKinds(w.id)).filter(kind => kind === 'merge.intent').length, 1);
  assert.equal(await reads.push(mergeSha, currentTip), 'pushed');
  assert.equal(await reads.fetch(), mergeSha);
  assert.equal((await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'pushed', mergeSha, pushedAt: iso(start + minute) })).status, 200);
  doc = await document(w.id);
  assert.deepEqual([doc.mergeLedger?.state, doc.mergeLedger?.pushedAt, doc.stage], ['pushed', iso(start + minute), 'review'], 'pushed but not reconciled, the item is not yet done');
  await store.pool.query('INSERT INTO jobs(work_id) VALUES($1) ON CONFLICT (work_id) DO NOTHING', [w.id]);
  const before = (await store.pool.query('SELECT count(*)::int AS n FROM events WHERE work_id=$1', [w.id])).rows[0].n as number;
  const reconciled = await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'reconciled', mergeSha, observedTip: mergeSha }, 'k-reconciled');
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.deepEqual([reconciled.body.stage, reconciled.body.delivery.mergeSha, reconciled.body.delivery.mergedAt], ['done', mergeSha, iso(start + minute)]);
  doc = await document(w.id);
  assert.equal(doc.stage, 'done');
  assert.deepEqual(doc.delivery, { mergedAt: iso(start + minute), mergeSha, authorizationRevision: doc.revision - 1 });
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM jobs WHERE work_id=$1', [w.id])).rows[0].n, 0, 'the jobs row is deleted');
  const rows = (await store.pool.query('SELECT kind FROM events WHERE work_id=$1 ORDER BY seq', [w.id])).rows.map(row => row.kind as string);
  assert.deepEqual(rows.slice(before), ['merge.reconciled', deliveredReason], 'the ledger row and the delivered save are the one transaction\'s only writes');
  assert.equal(doc.mergeLedger?.state, 'reconciled');
  assert.deepEqual(mergeLedgerRefusals(doc.mergeLedger, doc.candidate!), { test: [], merge: [] }, 'the ledger now answers both control-plane gates');
  assert.equal((await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'reconciled', mergeSha, observedTip: mergeSha }, 'k-reconciled')).status, 200, 'replayed under its key');
  assert.equal((await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'reconciled', mergeSha, observedTip: mergeSha })).body.stage, 'done', 'a lost receipt is answered as the item stands, delivering nothing twice');
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE work_id=$1 AND kind='merge.reconciled'", [w.id])).rows[0].n, 1);
});

test('integration:merge-record-refuses-unheld-sha — a reconciled naming a merge commit main does not hold is refused naming the base branch, with nothing written and the item unchanged; the refusal is read from the checkout\'s refs/remotes/origin/BASE', async () => {
  const w = await submittedItem(6);
  const before = await document(w.id), events = await ledgerKinds(w.id);
  const unheld = await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'reconciled', mergeSha: heads[4], observedTip: heads[4] });
  assert.equal(unheld.status, 409, JSON.stringify(unheld.body));
  assert.equal(unheld.body.error, unheldShaRefusal(heads[4]!, 'main'));
  assert.match(unheld.body.error, /^main does not hold/);
  const after = await document(w.id);
  assert.deepEqual([after.stage, after.delivery ?? null, after.revision], [before.stage, null, before.revision], 'nothing changed');
  assert.deepEqual(await ledgerKinds(w.id), events, 'nothing was written');
  // A commit that exists only in the object store, never on main, is refused the same way; an unknown sha too.
  assert.equal((await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'reconciled', mergeSha: 'a'.repeat(40), observedTip: 'a'.repeat(40) })).status, 409);
});

test('integration:executor-trial-failure-rework-no-approver — a merge.refused naming a failed trial of the current head folds onto the item, reopens its test gate and is the rework\'s ground: the server applies the rework with graphyard-merge-writer as its approver and no approver decision, the loop\'s request carrying the head:merge-writer-trial-failed binding', async () => {
  const w = await submittedItem(7);
  const head = heads[7]!;
  const reason = `${trialFailurePrefix}: tests tests/app.test.ts`;
  const refused = await request(token(coordinator), `work/${w.id}/merge-record`, { kind: 'refused', head, reason });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  let doc = await document(w.id);
  assert.deepEqual([doc.mergeLedger?.state, doc.mergeLedger?.head, doc.mergeLedger?.refusal], ['refused', head, { kind: 'merge', reason }]);
  assert.ok(doc.gates.find(gate => gate.name === 'test')!.reasons.includes(trialRefusal(head, doc.candidate!.baseSha)), 'the refusal stands where the trial would');
  assert.equal(trialFailedGround(doc), `the merge writer's trial of candidate ${head.slice(0, 12)} failed (${reason})`);
  assert.equal(reworkGround(doc, []), trialFailedGround(doc), 'the ground the lane rework reads');
  assert.equal(nextToMerge([doc], snapshotLedger([doc]), start), null, 'the refused head waits for its rework, not a second trial');
  const rework = trialFailureRework(doc, head, reason);
  const decided = await request(token(admin), `work/${w.id}/decide`, { action: 'rework', reason: rework.reason, input: rework.input });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.deepEqual([decided.body.state, decided.body.approvedBy], ['applied', mergeWriterApprover]);
  assert.match(decided.body.approvalReason, /the merge writer is the rework's approver and no approver decision is needed \(GY-1524\)/);
  const listed = await request(token(admin), `work/${w.id}/decisions`, undefined, randomUUID(), 'GET');
  const decision = listed.body.decisions.find((entry: { id: string }) => entry.id === decided.body.id);
  assert.deepEqual([decision.state, decision.approvedBy, decision.input.binding], ['applied', mergeWriterApprover, `${head}:${mergeWriterTrialGround}`]);
  const approval = (await store.pool.query("SELECT actor, payload FROM events WHERE work_id=$1 AND kind='decision.approved'", [w.id])).rows[0];
  assert.deepEqual([approval.actor, approval.payload.approver, approval.payload.groundKind], [mergeWriterApprover, { id: mergeWriterApprover, role: 'merge-writer' }, mergeWriterTrialGround]);
  assert.equal((await store.pool.query("SELECT count(*)::int AS n FROM events WHERE work_id=$1 AND kind='decision.requested' AND payload->>'action'='rework'", [w.id])).rows[0].n, 1);
  doc = await document(w.id);
  assert.equal(doc.reworkRequested, true, 'the item returns to a worker');
  assert.equal(doc.lease, null);
  // A refusal for another head, or because the base moved, grounds nothing.
  assert.equal(trialFailedGround({ ...doc, candidate: { ...doc.candidate!, sha: heads[5]! } } as Work), null);
  assert.equal(trialFailedGround({ ...doc, mergeLedger: { ...doc.mergeLedger!, refusal: { kind: 'merge', reason: baseMovedReason(4) } } } as Work), null);
});
