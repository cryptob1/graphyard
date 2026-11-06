import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeWriterIdle, mergeWriterStep, mergeWriterReads, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { trialRunsDirectory, type TrialRunHandle } from '../src/merge-writer/trial-run.js';
import { mergeRecordKinds, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema } from '../src/master.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { Work } from '../src/model.js';

// GY-3159, end to end: the real merge writer's flight launches its trial as a real detached `node`
// child (its own session, its verdict in its own directory under the coordinator checkout). The
// loop restarts onto a new release while the trial is in progress — the watcher is dropped exactly
// as the process's death would — and the next loop adopts the run from the persisted state: the
// head lands on the trial's own verdict with no second run, no unpushed refusal, and none of the
// `Settled an open intent … refused` lines a discarded trial used to leave.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

test('e2e:pipeline-trial-survives-restart — a merge trial in progress when the loop restarts is adopted by the next loop and lands the head on its own verdict: one detached run, no unpushed refusal, no settled open intent', { timeout: 180_000 }, async () => {
  const directory = await temporaryDirectory('pipeline-trial-restart'), origin = join(directory, 'origin.git'), checkout = join(directory, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
  await writeFile(join(checkout, 'shared.txt'), 'base\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
  const baseTip = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-qb', 'graphyard/gy-1-1');
  await writeFile(join(checkout, 'item.txt'), 'the item\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'GY-1 change');
  const head = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '--detach', baseTip);

  const config = masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused',
    githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } });
  const candidate = { sha: head, baseSha: baseTip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' };
  const ledgerEvents: { kind: string; payload: unknown; work: string }[] = [], recorded: MergeRecordEvent[] = [];
  const work = { id: 'w1', key: 'GY-1', title: 'The item', type: 'feature', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'The pipeline survives a loop restart under a merge trial', proofs: ['manual:pipeline-trial-survives-restart'] }],
    policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(),
    ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: 1 }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [],
    observation: { source: 'control-plane', candidate, files: ['item.txt'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip, baseTipContained: true, at: new Date().toISOString() },
    gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })), stage: 'build' } as unknown as Work;
  const snapshot = () => {
    const ledger = foldMergeLedger(ledgerEvents as never)['GY-1'] ?? null, delivered = ledger?.state === 'reconciled';
    const item = { ...work, mergeLedger: ledger, ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt!, mergeSha: ledger!.mergeSha!, authorizationRevision: 1 },
      observation: { ...(work.observation as object), merged: true, mergeSha: ledger!.mergeSha } } : {}) } as unknown as Work;
    return { work: [structuredClone(item)], now: new Date().toISOString() };
  };

  /** The production reads over the real checkout: its merge flights launch real detached trial runs. */
  const readsOf = (): MergeWriterReads => {
    const production = mergeWriterReads(config, checkout, defaultChildRun, { base: join(directory, 'managed'),
      record: async (item, event) => { recorded.push(event); const { kind, ...fields } = event as typeof event & { kind: string };
        const payload = kind === 'intent' ? { key: item.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
        ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: item.key }); } });
    return production;
  };
  const launched: TrialRunHandle[] = [];
  const effectsOf = (reads: MergeWriterReads) => ({ mergeWriter: { ...reads, launchTrialRun: (request: Parameters<NonNullable<MergeWriterReads['launchTrialRun']>>[0]) => {
      const handle = reads.launchTrialRun!(request); launched.push(handle); return handle; } }, persist: async () => {}, rework: async () => {} });
  const step = async (state: DaemonState, reads: MergeWriterReads) => mergeWriterStep({ state, effects: effectsOf(reads), now: Date.now, snapshot: snapshot(), performed: [] } as never);

  // Loop one: the flight starts and its trial launches detached, still running when the loop restarts.
  const first = emptyDaemonState(config), firstReads = readsOf();
  await step(first, firstReads);
  for (let waited = 0; !launched.length && waited < 30_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(launched.length, 1, 'the flight launched exactly one detached trial run');
  assert.ok(first.mergeWriter.inFlights?.every(entry => entry.run), 'the run is on the persisted in-flight entry the restart carries');
  // The loop restarts: its watcher dies with the process; the run itself keeps running.
  launched[0]!.detach();

  // Loop two: a fresh process over the persisted state and the same checkout adopts the run.
  const next = structuredClone(first), nextReads = readsOf();
  await step(next, nextReads);
  assert.match(next.actions['merge-writer-trial-adoption']?.detail ?? '', /Adopted the merge trial\(s\) of GY-1/, 'the next loop journals the adoption');
  await mergeWriterIdle(next);
  await step(next, nextReads);
  assert.equal(launched.length, 1, 'the adopted trial answered its own run; no second trial ran');
  assert.ok(existsSync(join(launched[0]!.directory, 'result.json')), 'the run recorded the verdict the head settled on');

  const kinds = recorded.map(event => event.kind).filter(kind => kind !== 'trial-step');
  assert.ok(kinds.includes('trial') && kinds.includes('pushed') && kinds.includes('reconciled'), `the head landed on its own trial: ${kinds.join(', ')}`);
  assert.ok(!kinds.includes('refused'), 'no refusal anywhere in the flight: the restart settled nothing as refused');
  for (const action of Object.values(next.actions)) assert.ok(!action.detail || !/Settled an open intent/.test(action.detail), 'no open intent was settled as refused');
  assert.deepEqual(readdirSync(trialRunsDirectory(checkout)).length, 1, 'exactly one detached trial run exists for the whole restart');

  const landing = git(origin, 'rev-parse', 'main');
  const mergeSha = foldMergeLedger(ledgerEvents as never)['GY-1']?.mergeSha!;
  assert.equal(landing, mergeSha, 'the merge the trial verified is the merge that landed');
  assert.equal(snapshot().work[0]!.stage, 'done', 'the item is delivered');
});
