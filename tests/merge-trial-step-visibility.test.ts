import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldMergeLedger, mergeStallMs } from '../src/model/merge-ledger.js';
import { mergePipeline, withMergePipeline } from '../src/pipeline-speed.js';
import { actionlessCards, stalledCards } from '../src/model/actionless.js';
import { mergeWriterIdle, mergeWriterStep, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { defaultChildRun } from '../src/child-runner.js';
import { firstParentHolds, runTrial, trialCheckoutPrefix, trialMerge } from '../src/merge-writer/trial.js';
import { mergeRecordKinds, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';
import type { ActionlessCard } from '../src/model/actionless.js';
import WorkCard from '../web/components/work-card.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { processPidNamespace, tempOwnerMarker } from '../src/tmp-reclaim.js';

// GY-2963: a merge in flight names where its trial is and how long the step has run — on master
// status, on the item's pipeline and on the Work page — and the item sits in no Blocked lane while
// the trial advances. A trial that exits with no verdict reads as stalled, with the last step
// named. And the trial's checkout begins within a minute of the writer taking the head, whatever
// crashed trial leftovers await removal on the checkout root.

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
const minute = 60_000;
const head = sha('head:GY-1');

/** The submitted item, its control-plane observation carrying no pull request and its merge gate held by the writer. */
const item = (candidate = head, baseTip = base): Work => ({
  id: 'w-GY-1', key: 'GY-1', title: 'GY-1', type: 'feature', description: '', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [], submission: { epoch: 1, pr: 7 }, nextAction: null,
  candidate: { sha: candidate, baseSha: baseTip, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: { source: 'control-plane', candidate: { sha: candidate, baseSha: baseTip, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, checks: [], reviews: [], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/app.ts'], at: iso(start), baseTip } as unknown as Observation,
  blocker: null,
  gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'test', passed: true, reasons: [] }, { name: 'merge', passed: false, reasons: [`merge writer has not pushed ${candidate.slice(0, 12)}`] }],
  violations: [], createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 30 * minute),
  pipeline: { attempts: [], submittedAt: iso(start - 30 * minute), resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
}) as unknown as Work;

interface StepHarness {
  work: Work[];
  state: ReturnType<typeof emptyDaemonState>;
  events: { key: string; event: MergeRecordEvent }[];
  /** Set once the flight's trial is entered; reports a step through the flight's own onStep. */
  report: ((step: string) => void) | null;
  /** Set once the flight's trial is entered; settles it, throwing `trialError` when one is set. */
  finish: (() => void) | null;
  trialError: unknown;
  advance: (ms: number) => void;
  step: () => Promise<void>;
}

/**
 * The step against the one item, with a trial the test drives: it reports its steps through the
 * flight's own `onStep` whenever `report` says so, and settles when `finish` is called. The
 * records fold onto the item exactly as the control plane's ledger would.
 */
function harness(): StepHarness {
  const work: Work[] = [item()];
  const made: StepHarness = { work, state: emptyDaemonState(config), events: [], report: null, finish: null, trialError: null, advance: () => {}, step: async () => {} };
  const ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  const fold = () => { const folded = foldMergeLedger(ledgerEvents as never); for (const entry of work) (entry as { mergeLedger?: unknown }).mergeLedger = folded[entry.key] ?? null; };
  let clock = start, settle: (() => void) | null = null;
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 0, now: () => clock,
    fetch: async () => base,
    merge: async () => ({ mergeSha: sha('merge'), files: ['src/app.ts'] }),
    trial: async (_mergeSha, _files, _picked, _baseTip, onStep) => {
      made.report = step => onStep?.(step);
      await new Promise<void>(resolve => { made.finish = () => settle?.(); settle = resolve; });
      if (made.trialError) throw made.trialError;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: {} };
    },
    push: async () => 'pushed', holds: async () => false,
    record: async (target, event) => {
      made.events.push({ key: target.key, event });
      const { kind, ...fields } = event as typeof event & { kind: string };
      const payload = kind === 'intent' ? { key: target.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
      ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: target.key });
      if (kind === 'reconciled') { const observed = target as Work; observed.stage = 'done'; if (observed.observation) observed.observation = { ...observed.observation, merged: true, mergeSha: (event as { mergeSha: string }).mergeSha }; }
      fold();
      return {};
    },
  };
  const reads: MergeWriterReads = { ...ports, merger: async () => 'control-plane' };
  const effects = { mergeWriter: reads, persist: async () => {} };
  made.advance = ms => { clock += ms; };
  made.step = async () => { clock += 1000; await mergeWriterStep({ state: made.state, effects, now: () => clock, snapshot: { work }, performed: [] } as unknown as Cycle); };
  return made;
}

const text = (screen: string) => screen.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('unit:merge-trial-step-and-elapsed-reported — a trial advancing between steps names its current step and its elapsed time on master status, on the item\'s pipeline and on the Work page, and sits in no Blocked lane', async () => {
  const made = harness();
  const { state, step } = made;
  await step();
  while (!made.report) await new Promise(resolve => setTimeout(resolve, 1));
  // The trial advances: install, build, then the tests — the whole test step outlasting the stall
  // bound while the steps keep advancing inside it.
  made.report!('install');
  made.report!('build');
  made.advance(5 * minute);
  made.report!('tests: test');
  made.advance(15 * minute);
  made.report!('tests: test:browser');
  await Promise.resolve();
  const now = start + 45 * minute + 1000;
  // Master status names the current step, its elapsed time, and no stall: 40 minutes of tests, the last advance 25 minutes ago.
  const inFlight = mergeWriterSummary(state.mergeWriter, now).inFlight!;
  assert.equal(inFlight.step, 'tests: test:browser');
  assert.equal(inFlight.stepMs, 25 * minute);
  assert.equal(inFlight.stalled, false);
  // The item's pipeline names the same step and its elapsed time.
  const work = made.work[0]!;
  assert.deepEqual(mergePipeline(work, now), { step: 'tests: test:browser', at: iso(start + 20 * minute + 1000), atMs: start + 20 * minute + 1000, fresh: true, stepMs: 25 * minute });
  assert.deepEqual(withMergePipeline(work, now).pipeline!.merge, mergePipeline(work, now));
  // The Work page: the item is in no Blocked lane, the row names the merge's step, and no PR number appears.
  assert.deepEqual(stalledCards([work], now), [], 'an advancing trial is never stalled');
  assert.deepEqual(actionlessCards([work], now).flatMap(card => card.movedBy ? [card.movedBy] : []), ['the merge writer\'s trial (tests: test:browser)']);
  const screen = text(renderToStaticMarkup(createElement(WorkCard, { item: work, now, onOpen: () => {} })));
  assert.match(screen, /Merging: tests: test:browser, 25m/);
  assert.doesNotMatch(screen, /PR #\d+/, 'a control-plane candidate names no pull request');
});

test('unit:merge-trial-step-and-elapsed-reported — a trial whose process exits without a verdict is reported as stalled with the last step named', async () => {
  const made = harness();
  const { step } = made;
  await step();
  while (!made.report) await new Promise(resolve => setTimeout(resolve, 1));
  made.report!('checkout');
  made.advance(3 * minute);
  made.report!('tests: test');
  // The trial's process exits with no verdict; no step will ever advance again.
  made.trialError = new Error('the runner died');
  made.finish!();
  await mergeWriterIdle(made.state);
  const now = start + 50 * minute;
  const work = made.work[0]!;
  assert.equal(mergeWriterSummary(made.state.mergeWriter, now).inFlight?.stalled, true, 'master status reads the flight as stalled past the bound');
  const stalled = stalledCards([work], now);
  assert.deepEqual(stalled.map(card => card.item.key), ['GY-1'], 'a trial that exited with no verdict is stalled once no step has advanced for the bound');
  assert.match(stalled[0]!.missing, /its trial last ran tests: test/);
  const screen = text(renderToStaticMarkup(createElement(WorkCard, { item: work, now, stall: stalled[0] as ActionlessCard, onOpen: () => {} })));
  assert.match(screen, /its trial last ran tests: test/);
});

// ---- AC-2: the checkout starts promptly, and every step's duration reaches the trial's log --------

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/** A fixture repository with a build and one preMerge test check, a base tip and a head to merge. */
async function fixtureRepo() {
  const root = await temporaryDirectory('trial-step-repo', tmpdir());
  gitIn(root, 'init', '-q', '-b', 'main');
  const write = (path: string, content: string) => writeFileSync(join(root, path), content);
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'node -e ""' } }));
  write('graphyard.json', JSON.stringify({ delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'npm run test' }], perCandidate: [] } } }));
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const baseTip = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach', baseTip);
  write('src.ts', 'export {};\n');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'change');
  const committed = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');
  const git = (args: string[]) => defaultChildRun('git', ['-C', root, ...args], { env: { ...process.env, ...identity } }).then(String);
  const merged = await trialMerge(git, { head: committed, baseTip });
  if (!('mergeSha' in merged)) throw new Error('the fixture head conflicts with its own base');
  return { root, baseTip, head: committed, mergeSha: merged.mergeSha, git };
}

test('unit:trial-checkout-starts-promptly — the trial\'s checkout step starts within a minute of the writer taking a head, even with a crashed trial\'s checkout awaiting removal, and the trial\'s log records every step\'s duration', async () => {
  const repo = await fixtureRepo();
  const managedBase = await temporaryDirectory('trial-step-managed', tmpdir());
  const temporary = await temporaryDirectory('trial-step-temp', tmpdir());
  const trials = await temporaryDirectory('trial-step-trials', tmpdir());
  // A crashed trial's leftover checkout, its owner naming a process long gone: exactly the kind of
  // removal that stood between GY-101's head and its checkout for eleven minutes.
  const abandoned = join(trials, `${trialCheckoutPrefix}dead`);
  await mkdir(join(abandoned, 'checkout'), { recursive: true });
  await writeFile(tempOwnerMarker(abandoned), `${JSON.stringify({ pid: 2 ** 22 + 5, startedAt: 1, pidNamespace: processPidNamespace(), at: '' })}\n`);
  // npm children answer at once; git runs for real, so the checkout is made against this test's own clock.
  const run = (async (command: string, args: string[], options: never) => command === 'npm' ? '' : defaultChildRun(command, args, options)) as never;
  const takenAt = { at: 0 }, firstStepAt = { at: 0 };
  const work: Work[] = [item(repo.head, repo.baseTip)];
  const state = emptyDaemonState(config);
  const ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  const fold = () => { const folded = foldMergeLedger(ledgerEvents as never); for (const entry of work) (entry as { mergeLedger?: unknown }).mergeLedger = folded[entry.key] ?? null; };
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 0, now: () => Date.now(),
    fetch: async () => repo.baseTip,
    merge: (mergeHead, mergeBase) => trialMerge(repo.git, { head: mergeHead, baseTip: mergeBase }).then(merged => ('conflict' in merged ? merged : { mergeSha: merged.mergeSha, files: ['src.ts'] })),
    trial: async (mergeSha, files, picked, _baseTip, onStep) => {
      const verdict = await runTrial({
        root: repo.root, base: managedBase, mergeSha, changedFiles: files, timeoutMs: 120_000, key: picked.key, run,
        environment: { PATH: process.env.PATH! }, temporaryRoots: [temporary], checkoutRoots: [trials], retries: 0, ...(onStep ? { onStep } : {}),
      });
      return { ...verdict, files: [...files], proofs: {} };
    },
    push: async () => 'pushed', holds: candidate => firstParentHolds(repo.git, 'refs/heads/main', candidate),
    record: async (target, event) => {
      if (event.kind === 'intent') takenAt.at = Date.parse(state.mergeWriter.inFlight?.startedAt ?? event.at);
      if (event.kind === 'trial-step' && !firstStepAt.at) firstStepAt.at = Date.parse(event.at);
      const { kind, ...fields } = event as typeof event & { kind: string };
      const payload = kind === 'intent' ? { key: target.key, ...fields } : fields;
      ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: target.key });
      if (kind === 'reconciled') { const observed = target as Work; observed.stage = 'done'; }
      fold();
      return {};
    },
  };
  const reads: MergeWriterReads = { ...ports, merger: async () => 'control-plane' };
  const cycle = { state, effects: { mergeWriter: reads, persist: async () => {} }, now: () => Date.now(), snapshot: { work }, performed: [] } as unknown as Cycle;
  await mergeWriterStep(cycle);
  await mergeWriterIdle(state);
  await mergeWriterStep(cycle);
  assert.ok(firstStepAt.at > 0, 'the trial reported its first step');
  assert.ok(firstStepAt.at - takenAt.at < 60_000, `the checkout began ${firstStepAt.at - takenAt.at}ms after the head was taken`);
  assert.ok(!existsSync(abandoned), 'the crashed trial\'s checkout was taken back beside this one, never before it');
  assert.equal(state.actions[`merge-writer:GY-1:${repo.head}`]?.state, 'done', JSON.stringify(state.actions));

  // Every step's duration is in the trial's log, the last one included.
  const steps: string[] = [];
  const verdict = await runTrial({
    root: repo.root, base: managedBase, mergeSha: repo.mergeSha, changedFiles: ['src.ts'], timeoutMs: 120_000, key: 'GY-1', run,
    environment: { PATH: process.env.PATH! }, temporaryRoots: [temporary], checkoutRoots: [trials], retries: 0, onStep: step => steps.push(step),
  });
  assert.deepEqual(steps, ['checkout', 'install', 'build', 'tests: test']);
  for (const step of steps) assert.match(verdict.logTail, new RegExp(`\\[step\\] ${step} took [0-9.]+s`), step);
});
