import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeWriterIdle, mergeWriterReads, mergeWriterStep, mergeWriterSummary } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { baseFailureReason, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { ChildRun } from '../src/child-runner.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-3451: main e27e5826 failed its word-budget tests; GY-3449 merged on top without touching them,
// main stayed red, and the merge writer started trialling every queued head again because the tip had
// moved. Those trials held both host heavy-job slots for 50 minutes while the hotfix could not verify.
// A recorded base failure now stands until main changes the failing tests or the files they read.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const red = sha('red-main'), stillRed = sha('still-red-main'), green = sha('green-main');
const unrelated = sha('unrelated-head'), fix = sha('fix-head'), recorderHead = sha('recorder-head'), hotfix = sha('hotfix-head');
const failingTest = 'tests/budget.test.ts';

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });

const reason = baseFailureReason({ tip: red, files: [failingTest], tests: ['unit:budget'] });
const refusedOn = (key: string, head: string, why: string): MergeLedgerState => ({ key, state: 'refused', head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: why }, events: 1 });

const item = (id: string, key: string, head: string, created: number, extra: Partial<Work> = {}): Work => ({
  id, key, title: key, type: 'bug', description: '', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [], submission: { epoch: 1, pr: 7 },
  candidate: { sha: head, baseSha: red, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: red }, checks: [], reviews: [], merged: false, mergeSha: null, at: iso(start), baseTip: red } as unknown as Observation,
  blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
  createdAt: iso(created), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000), ...extra,
} as unknown as Work);

/**
 * A git host whose main tip is `tip.at`. The failing test reads docs/guide.md; the fix head changes
 * it, the unrelated and hotfix heads do not. Main's own changes since the red tip: `stillRed` touched
 * only src/app.ts, `green` changed docs/guide.md.
 */
function substitutedGit(tip: { at: string }): ChildRun {
  const sources: Record<string, string> = { [failingTest]: "import { readFileSync } from 'node:fs';\nreadFileSync('docs/guide.md', 'utf8');\n", 'docs/guide.md': 'guide\n', 'src/app.ts': 'export const app = 1;\n' };
  const heads: Record<string, string> = { [unrelated]: 'src/app.ts\n', [fix]: 'docs/guide.md\n', [hotfix]: 'src/app.ts\n' };
  const mainSince: Record<string, string> = { [stillRed]: 'src/app.ts\n', [green]: 'docs/guide.md\n' };
  return async (command, args) => {
    const argv = args.slice(args[0] === '-C' ? 2 : 0), [verb] = argv;
    if (verb === 'fetch' || verb === 'update-ref' || verb === 'push') return '';
    if (verb === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/main^{commit}') return `${tip.at}\n`;
    if (verb === 'rev-parse' && argv.at(-1)!.endsWith('^{commit}')) return `${argv.at(-1)!.slice(0, 40)}\n`;
    if (verb === 'rev-list') return '';
    if (verb === 'merge-tree') return `${sha('tree')}\0`;
    if (verb === 'commit-tree') return `${sha(`merge:${argv.at(-3)}`)}\n`;
    if (verb === 'ls-tree') return `${Object.keys(sources).join('\n')}\n`;
    if (verb === 'show' && argv[1] === '-s') return '1\n1\n';
    if (verb === 'show') return sources[argv[1]!.split(':')[1]!]!;
    if (verb === 'diff') { const range = argv.at(-1)!; return range.includes('...') ? heads[range.split('...')[1]!] ?? '' : mainSince[range] ?? ''; }
    throw new Error(`substituted git has no answer for: ${argv.join(' ')}`);
  };
}

function harness(work: Work[]) {
  const tip = { at: red }, trialled: string[] = [], recorded: { key: string; event: any }[] = [], performed: any[] = [];
  const reads = mergeWriterReads(config, '/repo/checkout', substitutedGit(tip), {
    base: 'main',
    record: async (target, event) => { recorded.push({ key: target.key, event }); return {}; },
    trial: async (input): Promise<MergeTrialRun> => { trialled.push(input.key!); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [failingTest], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }; },
  });
  const state = emptyDaemonState(config);
  let clock = start;
  const step = async () => { clock += 1000; await mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {}, rework: async () => {} }, now: () => clock, snapshot: { work }, performed } as unknown as Cycle); await mergeWriterIdle(state); };
  /** The writer's ledger as the control plane folds it: each recorded refusal or push replaces the item's state. */
  const settle = () => {
    for (const { key, event } of recorded.splice(0)) {
      const at = work.findIndex(entry => entry.key === key);
      if (at < 0) continue;
      if (event.kind === 'pushed') work.splice(at, 1);
      else if (event.kind === 'refused') work[at] = { ...work[at]!, mergeLedger: refusedOn(key, event.head, event.reason) };
    }
  };
  return { tip, trialled, recorded, state, step, settle, waiting: () => mergeWriterSummary(state.mergeWriter).queue.filter(entry => (entry as { waiting?: string }).waiting).map(entry => entry.key) };
}

test('integration:red-base-only-fix-trials — while main fails, only the base repair (here changing what the failing test reads) is trialled; the others wait for a green base, across a merge that leaves main red, and start once main changes what fails', async () => {
  // GY-3 recorded the base failure on the red tip and was returned to its worker; GY-1 (oldest) changes nothing the failing test reads.
  const recorder = item('w3', 'GY-3', recorderHead, start - 9_000, { mergeLedger: refusedOn('GY-3', recorderHead, reason), reworkRequested: true });
  const work = [item('w1', 'GY-1', unrelated, start - 5_000), recorder];
  const run = harness(work);

  await run.step();
  assert.deepEqual(run.trialled, [], 'the unrelated head starts no trial on the red base');
  assert.deepEqual(run.waiting(), ['GY-1'], 'it is shown waiting for a green base');
  assert.match((mergeWriterSummary(run.state.mergeWriter).queue[0] as { waiting?: string }).waiting!, /^a green main: base failure: tests tests\/budget\.test\.ts fail/);
  run.settle();

  // Another merge lands without touching the failing test or what it reads: main is still red, and nothing starts.
  run.tip.at = stillRed;
  await run.step();
  assert.deepEqual(run.trialled, [], 'a merge that leaves the failing test untouched frees nothing');
  assert.deepEqual(run.waiting(), ['GY-1']);
  assert.equal(run.recorded.length, 0, 'the waiting head is refused once, not again on every cycle or tip');

  // The fix arrives: it changes the file the failing test reads, so it alone is trialled and lands.
  work.push(item('w2', 'GY-2', fix, start - 1_000, { title: `Base branch main fails unit test: ${failingTest}` }));
  await run.step();
  assert.deepEqual(run.trialled, ['GY-2'], 'the head changing what the failing test reads gets a merge trial');
  assert.ok(run.recorded.some(entry => entry.key === 'GY-2' && entry.event.kind === 'pushed'));
  run.settle();

  // Main now carries the change to what failed: the waiting head starts again.
  run.tip.at = green;
  await run.step();
  assert.deepEqual(run.trialled, ['GY-2'], 'the cycle after a merge settles its flight');
  await run.step();
  assert.deepEqual(run.trialled, ['GY-2', 'GY-1'], 'once main changes what failed, the waiting head is trialled');
  assert.deepEqual(run.waiting(), []);
});

test('e2e:red-base-fix-first — with main red, the fixing item merges while other items wait, then the others merge after main is green', async () => {
  const recorder = item('w3', 'GY-3', recorderHead, start - 9_000, { mergeLedger: refusedOn('GY-3', recorderHead, reason), reworkRequested: true });
  // GY-4 is the master's hotfix for the base: it is trialled whatever it changes.
  const work = [item('w1', 'GY-1', unrelated, start - 5_000), item('w2', 'GY-2', fix, start - 2_000, { title: `Base branch main fails unit test: ${failingTest}` }), item('w4', 'GY-4', hotfix, start - 1_000, { title: 'Hotfix: main passes again' }), recorder];
  const run = harness(work);
  run.tip.at = stillRed; // main moved on and stayed red

  await run.step();
  assert.deepEqual([...run.trialled].sort(), ['GY-2', 'GY-4'], 'the fixing item and the master\'s hotfix are trialled; the unrelated head is not');
  assert.deepEqual(run.recorded.filter(entry => entry.event.kind === 'pushed').map(entry => entry.key).sort(), ['GY-2', 'GY-4'], 'the fixes merge');
  assert.deepEqual(run.waiting(), ['GY-1'], 'the unrelated item waits for a green base');
  run.settle();

  run.tip.at = green;
  await run.step(); // the cycle after a merge settles its flight
  await run.step();
  assert.deepEqual(run.trialled.at(-1), 'GY-1', 'once main is green the waiting item is trialled');
  assert.ok(run.recorded.some(entry => entry.key === 'GY-1' && entry.event.kind === 'pushed'), 'and merges');
});

// GY-3563: on 2026-11-20 main stayed red for an hour while ordinary heads that touched the failing
// tests' wide import scope held every trial slot, and the hotfix and base repair queued behind them.
// While a base failure stands, only hotfixes and base repairs start trials; every other head waits.
const repairTitle = `Base branch main fails unit test: ${failingTest}`;

test('integration:held-candidates-no-trial — while main fails, only hotfix and base-repair heads start trials; other due heads, even ones touching what fails, stay queued and start once the failure clears', async () => {
  const recorder = item('w3', 'GY-3', recorderHead, start - 9_000, { mergeLedger: refusedOn('GY-3', recorderHead, reason), reworkRequested: true });
  // GY-1 is an ordinary head that changes what the failing test reads; GY-5 is the filed base repair.
  const work = [item('w1', 'GY-1', fix, start - 5_000), item('w5', 'GY-5', sha('repair-head'), start - 1_000, { title: repairTitle }), recorder];
  const run = harness(work);
  run.tip.at = stillRed;

  await run.step();
  assert.deepEqual(run.trialled, ['GY-5'], 'only the base repair is trialled while main fails');
  assert.deepEqual(run.waiting(), ['GY-1'], 'the ordinary head waits for a green base');
  assert.ok(run.recorded.some(entry => entry.key === 'GY-1' && entry.event.kind === 'refused' && entry.event.reason === reason), 'it is held without a trial');
  run.settle();

  await run.step();
  assert.deepEqual(run.trialled, ['GY-5'], 'it stays queued while the failure stands');

  run.tip.at = green;
  await run.step();
  assert.deepEqual(run.trialled, ['GY-5', 'GY-1'], 'once the failure clears it starts normally');
  assert.deepEqual(run.waiting(), []);
});

test('e2e:held-candidates-no-trial — with main red, a base-repair head starts its trial before an ordinary head queued earlier', async () => {
  const recorder = item('w3', 'GY-3', recorderHead, start - 9_000, { mergeLedger: refusedOn('GY-3', recorderHead, reason), reworkRequested: true });
  const work = [item('w1', 'GY-1', fix, start - 5_000), item('w5', 'GY-5', sha('repair-head'), start - 1_000, { title: repairTitle }), recorder];
  const run = harness(work);
  run.tip.at = stillRed;
  await run.step();
  run.settle();
  run.tip.at = green;
  await run.step();
  await run.step();
  assert.deepEqual(run.trialled, ['GY-5', 'GY-1'], 'the repair is trialled first, the earlier ordinary head after main is green');
});
