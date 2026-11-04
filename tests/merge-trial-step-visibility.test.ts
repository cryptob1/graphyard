import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { mergePipeline, withMergePipeline } from '../src/pipeline-speed.js';
import { actionlessCards, stalledCards } from '../src/model/actionless.js';
import { mergeWriterIdle, mergeWriterStep, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { writeDaemonState, readDaemonState } from '../src/daemon/state.js';
import { timedMergePorts } from '../src/daemon/trial-timings.js';
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
    trial: async (_mergeSha, _files, _picked, _baseTip, onStep, onTiming) => {
      let current: string | undefined, began = clock;
      const close = () => { if (current) onTiming?.(current, clock - began); };
      made.report = step => { close(); current = step; began = clock; onStep?.(step); };
      await new Promise<void>(resolve => { made.finish = () => settle?.(); settle = resolve; });
      close();
      if (made.trialError) throw made.trialError;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
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
  const reads: MergeWriterReads = { ...ports};
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
    trial: async (mergeSha, files, picked, _baseTip, onStep, onTiming) => {
      const verdict = await runTrial({
        root: repo.root, base: managedBase, mergeSha, changedFiles: files, timeoutMs: 120_000, key: picked.key, run, secretScan: async () => ({ ok: true }),
        environment: { PATH: process.env.PATH! }, temporaryRoots: [temporary], checkoutRoots: [trials], retries: 0, ...(onStep ? { onStep } : {}), ...(onTiming ? { onTiming } : {}),
      });
      return { ...verdict, files: [...files], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
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
  const reads: MergeWriterReads = { ...ports};
  const cycle = { state, effects: { mergeWriter: reads, persist: async () => {} }, now: () => Date.now(), snapshot: { work }, performed: [] } as unknown as Cycle;
  await mergeWriterStep(cycle);
  await mergeWriterIdle(state);
  await mergeWriterStep(cycle);
  assert.ok(firstStepAt.at > 0, 'the trial reported its first step');
  assert.ok(firstStepAt.at - takenAt.at < 60_000, `the checkout began ${firstStepAt.at - takenAt.at}ms after the head was taken`);
  assert.ok(!existsSync(abandoned), 'the crashed trial\'s checkout was taken back beside this one, never before it');
  assert.equal(state.actions[`merge-writer:GY-1:${repo.head}`]?.state, 'done', JSON.stringify(state.actions));

  const credentials = await temporaryDirectory('trial-status-credentials');
  const savedConfig = { ...config, credentialFile: join(credentials, 'token') };
  await writeDaemonState(savedConfig, state);
  assert.deepEqual((await readDaemonState(repo.root, savedConfig))?.mergeWriter.trials, state.mergeWriter.trials);
  const report = await masterStatusReport(repo.root, savedConfig, async () => ({ work: [], now: iso(Date.now()) }), async () => repo.baseTip);
  assert.deepEqual(report.mergeWriter.trials[0]!.heads, [{ key: 'GY-1', head: repo.head }]);
  assert.deepEqual(report.mergeWriter.trials[0]!.steps.map(entry => entry.step), ['checkout', 'scan', 'install', 'build', 'tests: test', 'push']);
  for (const entry of report.mergeWriter.trials[0]!.steps) {
    assert.ok(entry.durationMs >= 0);
    assert.equal(report.mergeWriter.stepMedians[entry.step], entry.durationMs);
  }

  // Every step's duration is in the trial's log, the last one included.
  const steps: string[] = [];
  const verdict = await runTrial({
    root: repo.root, base: managedBase, mergeSha: repo.mergeSha, changedFiles: ['src.ts'], timeoutMs: 120_000, key: 'GY-1', run,
    environment: { PATH: process.env.PATH! }, temporaryRoots: [temporary], checkoutRoots: [trials], retries: 0, onStep: step => steps.push(step),
  });
  assert.deepEqual(steps, ['checkout', 'install', 'build', 'tests: test']);
  for (const step of steps) assert.match(verdict.logTail, new RegExp(`\\[step\\] ${step} took [0-9.]+s`), step);
});


test('integration:trial-step-timings — finished steps survive the flight and medians retain only the last 20 trials', async () => {
  const made = harness();
  await made.step();
  while (!made.report) await new Promise(resolve => setTimeout(resolve, 1));
  made.report('install'); made.advance(100);
  made.report('build'); made.advance(300);
  made.finish!(); await mergeWriterIdle(made.state); await made.step();
  assert.equal(made.state.mergeWriter.inFlight, null);
  const first = made.state.mergeWriter.trials![0]!;
  assert.deepEqual(first.heads, [{ key: 'GY-1', head }]);
  assert.deepEqual(first.steps, [{ step: 'install', durationMs: 100 }, { step: 'build', durationMs: 300 }, { step: 'push', durationMs: 0 }]);

  let clock = start, duration = 0;
  const ports = timedMergePorts({ baseBranch: 'main', retrials: 0, fetch: async () => base,
    merge: async () => ({ mergeSha: head, files: [] }), holds: async () => false, record: async () => {}, now: () => clock, trial: async (_sha, _files, _item, _base, step, timing) => {
    step?.('build'); duration += 10; clock += duration; timing?.('build', duration); timing?.('tests: shard 1', 7);
    return {} as never;
  }, push: async () => { clock += 20; return 'pushed'; }, preview: async () => { clock += 30; return null; } } as MergePorts,
  made.state.mergeWriter, async () => {});
  const heads = [{ key: 'GY-1', head }, { key: 'GY-2', head: sha('second') }];
  for (let index = 0; index < 21; index++) {
    await ports.trial(sha(String(index)), [], item(), base, undefined, undefined, heads);
    await ports.preview!(sha(String(index)), [], item());
    await ports.push(sha(String(index)), base);
  }
  const summary = mergeWriterSummary(made.state.mergeWriter);
  assert.equal(summary.trials!.length, 20);
  assert.equal(summary.trials![0]!.mergeSha, sha('1'));
  assert.deepEqual(summary.trials![0]!.heads, heads);
  assert.deepEqual(summary.stepMedians, { build: 115, 'tests: shard 1': 7, preview: 30, push: 20 });
});

test('integration:trial-step-timings — parallel test shards report their own durations', async () => {
  const repo = await fixtureRepo();
  await mkdir(join(repo.root, 'scripts'));
  await writeFile(join(repo.root, 'scripts/ci-tests.mjs'), '// fixture selection\n');
  gitIn(repo.root, 'add', 'scripts/ci-tests.mjs');
  gitIn(repo.root, 'commit', '-q', '-m', 'test selector');
  const mergeSha = gitIn(repo.root, 'rev-parse', 'HEAD');
  const scratch = await temporaryDirectory('timed-shards');
  const timings: { step: string; durationMs: number }[] = [];
  let clock = start;
  const run = (async (command: string, args: string[], options: never) => {
    if (command === 'npm') { clock += 10; return ''; }
    if (command === 'node') {
      clock += 20;
      return args[0] === 'scripts/ci-tests.mjs' ? 'tests/a.test.ts\ntests/b.test.ts\n' : '';
    }
    return defaultChildRun(command, args, options);
  }) as never;
  const result = await runTrial({ root: repo.root, base: scratch, mergeSha, changedFiles: ['scripts/ci-tests.mjs'],
    timeoutMs: 120_000, run, now: () => clock, groupSize: 1, cores: 2, retries: 0,
    environment: { PATH: process.env.PATH! }, temporaryRoots: [scratch], checkoutRoots: [scratch],
    onTiming: (step, durationMs) => timings.push({ step, durationMs }) });
  assert.equal(result.build, 'pass');
  assert.equal(result.groups?.length, 2);
  assert.deepEqual(timings.filter(entry => entry.step.startsWith('tests: shard')).map(entry => entry.step).sort(), ['tests: shard 1', 'tests: shard 2']);
  assert.ok(timings.filter(entry => entry.step.startsWith('tests: shard')).every(entry => entry.durationMs >= 20));
});


test('integration:trial-step-timings — bound E2E success and failure have separate persisted durations and a median', async () => {
  const repo = await fixtureRepo();
  await mkdir(join(repo.root, 'e2e/cases'), { recursive: true });
  await writeFile(join(repo.root, 'e2e/cases/timed.json'), '{}');
  await writeFile(join(repo.root, 'graphyard.json'), JSON.stringify({
    e2e: { serve: { command: 'node server.js', url: 'http://127.0.0.1:8080', readySeconds: 10 } },
    delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'npm run test' }], perCandidate: [] } },
  }));
  gitIn(repo.root, 'add', '-A');
  gitIn(repo.root, 'commit', '-q', '-m', 'bound E2E fixture');
  const mergeSha = gitIn(repo.root, 'rev-parse', 'HEAD');
  const scratch = await temporaryDirectory('timed-e2e');
  const state = emptyDaemonState(config);
  let clock = start, failed = false;
  const run = (async (command: string, args: string[], options: never) => {
    if (command === 'npm') { clock += 10; return ''; }
    if (command === 'node' && args.at(-1)?.endsWith('/run.mjs')) {
      clock += failed ? 900 : 300;
      if (failed) throw new Error('E2E runner failed');
      await writeFile(join(dirname(args.at(-1)!), 'result.json'), JSON.stringify([
        { proof: 'e2e:timed', case: 'timed', executed: 1, failed: 0 },
      ]));
      return '';
    }
    return defaultChildRun(command, args, options);
  }) as never;
  const ports = timedMergePorts({ now: () => clock,
    trial: async (_sha, files, _item, _base, onStep, onTiming) => ({
      ...await runTrial({ root: repo.root, base: scratch, mergeSha, changedFiles: files,
        timeoutMs: 120_000, run, now: () => clock, retries: 0, e2eProofs: ['e2e:timed'],
        environment: { PATH: process.env.PATH! }, temporaryRoots: [scratch], checkoutRoots: [scratch],
        ...(onStep ? { onStep } : {}), ...(onTiming ? { onTiming } : {}),
      }), files: [...files],
    }),
  } as MergePorts, state.mergeWriter, async () => {});
  const heads = [{ key: 'GY-1', head: mergeSha }];
  for (const failure of [false, true]) {
    failed = failure;
    const result = await ports.trial(mergeSha, ['src.ts'], item(mergeSha), repo.baseTip, undefined, undefined, heads);
    assert.equal(result.e2e?.[0]?.failed, failure ? 1 : 0);
  }
  const credentials = await temporaryDirectory('timed-e2e-status');
  const savedConfig = { ...config, credentialFile: join(credentials, 'token') };
  await writeDaemonState(savedConfig, state);
  const report = await masterStatusReport(repo.root, savedConfig, async () => ({ work: [], now: iso(clock) }), async () => repo.baseTip);
  assert.equal(report.mergeWriter.trials.length, 2);
  for (const [index, trial] of report.mergeWriter.trials.entries()) {
    assert.deepEqual(trial.heads, heads);
    assert.deepEqual(trial.steps, [
      { step: 'checkout', durationMs: 0 }, { step: 'install', durationMs: 0 },
      { step: 'build', durationMs: 10 }, { step: 'tests: e2e', durationMs: index === 0 ? 300 : 900 },
      { step: 'tests: test', durationMs: 10 },
    ]);
  }
  assert.equal(report.mergeWriter.stepMedians['tests: e2e'], 600);
  assert.equal(report.mergeWriter.stepMedians.build, 10);
});
