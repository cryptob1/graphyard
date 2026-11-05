import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeWriterIdle, mergeWriterReads, mergeWriterStep } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { baseFailureReason, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { ChildRun } from '../src/child-runner.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-3140: main failed unit:model-purity and the merge writer kept trialling unrelated heads for
// 20-30 minutes each, only to refuse every one with the base failure. While a base failure is
// recorded on main's current tip, a head that touches neither the failing tests nor the files they
// select starts no trial: it is refused at once with the base failure and trialled once main moves on.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const broken = sha('broken-main'), repaired = sha('repaired-main');
const unrelated = sha('unrelated-head'), repair = sha('repair-head'), earlier = sha('earlier-head');
const failingTest = 'tests/failing.test.ts';

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });

const reason = baseFailureReason({ tip: broken, files: [failingTest], tests: ['unit:failing'] });
const refusedOn = (key: string, head: string, why: string): MergeLedgerState => ({ key, state: 'refused', head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: why }, events: 1 });

const item = (id: string, key: string, head: string, created: number, extra: Partial<Work> = {}): Work => ({
  id, key, title: key, type: 'feature', description: '', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [], submission: { epoch: 1, pr: 7 },
  candidate: { sha: head, baseSha: broken, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: broken }, checks: [], reviews: [], merged: false, mergeSha: null, at: iso(start), baseTip: broken } as unknown as Observation,
  blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
  createdAt: iso(created), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000), ...extra,
} as unknown as Work);

/** A git host whose main tip is `tip.at`; the failing test imports src/lib.ts, which the repair head changes and the unrelated head does not. */
function substitutedGit(tip: { at: string }): ChildRun {
  const sources: Record<string, string> = { [failingTest]: "import { value } from '../src/lib.js';\n", 'src/lib.ts': 'export const value = 1;\n', 'src/app.ts': 'export const app = 1;\n' };
  const changes: Record<string, string> = { [unrelated]: 'src/app.ts\n', [repair]: 'src/lib.ts\n' };
  return async (command, args) => {
    const argv = args.slice(args[0] === '-C' ? 2 : 0), [verb] = argv;
    if (verb === 'fetch' || verb === 'update-ref' || verb === 'push') return '';
    if (verb === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/main^{commit}') return `${tip.at}\n`;
    if (verb === 'rev-parse' && argv.at(-1)!.endsWith('^{commit}')) return `${argv.at(-1)!.slice(0, 40)}\n`;
    if (verb === 'rev-list') return '';
    if (verb === 'merge-tree') return `${sha('tree')}\0`;
    if (verb === 'commit-tree') return `${sha(`merge:${argv.at(-3)}`)}\n`;
    if (verb === 'ls-tree') return `${Object.keys(sources).join('\n')}\n`;
    if (verb === 'show') return sources[argv[1]!.split(':')[1]!]!;
    if (verb === 'diff') { const range = argv.at(-1)!; return range.includes('...') ? changes[range.split('...')[1]!] ?? '' : 'src/lib.ts\n'; }
    throw new Error(`substituted git has no answer for: ${argv.join(' ')}`);
  };
}

test('unit:base-failure-holds-unrelated-trials — while main fails, only the head touching the failing test is trialled; the rest are refused at once and trialled once main moves on', async () => {
  const tip = { at: broken }, trialled: string[] = [], recorded: { key: string; event: any }[] = [], performed: any[] = [];
  const reads = mergeWriterReads(config, '/repo/checkout', substitutedGit(tip), {
    base: 'main',
    record: async (target, event) => { recorded.push({ key: target.key, event }); return {}; },
    trial: async (input): Promise<MergeTrialRun> => { trialled.push(input.key!); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [failingTest], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }; },
  });
  const state = emptyDaemonState(config);
  // GY-3 is the head whose trial found the base failure (since returned to its worker); GY-1 (older, so first in the queue) touches nothing the failing test selects; GY-2 is the repair.
  const recorder = item('w3', 'GY-3', earlier, start - 9_000, { mergeLedger: refusedOn('GY-3', earlier, reason), reworkRequested: true });
  const work = [item('w1', 'GY-1', unrelated, start - 5_000), item('w2', 'GY-2', repair, start - 1_000), recorder];
  let clock = start;
  const step = async () => { clock += 1000; await mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {}, rework: async () => {} }, now: () => clock, snapshot: { work }, performed } as unknown as Cycle); await mergeWriterIdle(state); };

  await step();
  assert.deepEqual(trialled, ['GY-2'], 'only the repair head is trialled while main fails');
  const held = recorded.filter(entry => entry.key === 'GY-1');
  assert.deepEqual(held.map(entry => entry.event), [{ kind: 'refused', head: unrelated, reason }], 'the unrelated head is refused at once with the base failure, no intent and no trial');
  assert.match(state.actions[`merge-writer-base-hold:GY-1:${unrelated}`]!.detail, /touches neither the failing tests nor the files they select/);
  assert.ok(recorded.some(entry => entry.key === 'GY-2' && entry.event.kind === 'pushed'), 'the repair head is trialled and lands');

  // The ledger now holds the refusal; a second cycle on the same broken tip neither trials nor refuses it again.
  work[0] = { ...work[0]!, mergeLedger: refusedOn('GY-1', unrelated, reason) };
  work.splice(1, 1);
  const before = recorded.length;
  await step();
  assert.deepEqual(trialled, ['GY-2']);
  assert.equal(recorded.length, before, 'a held head is refused once, not on every cycle');

  // Main moves on (the repair landed and passes): the held head is queued again and trialled.
  tip.at = repaired;
  await step();
  assert.deepEqual(trialled, ['GY-2', 'GY-1'], 'once main moves past the failure, the held head is trialled');
});
