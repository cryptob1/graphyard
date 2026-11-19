import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { readTrialCpu } from '../src/merge-writer/trial-cpu.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { type MergePorts } from '../src/merge-writer/executor.js';
import { mergeWriterStep, mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { trialRefusalHeld } from '../src/model/merge-queue.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

// GY-3535: a merge trial whose failing test timed out while its containers waited over a minute for
// the CPU to cool is inconclusive: the same head is trialled again, never reworked; the third heat
// failure stops the retries with one attention line. A shorter heat wait, or none, is a red head as before.

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
};
async function repository(root: string) {
  git(root, 'init', '-q', '-b', 'main');
  await write(root, { 'package.json': JSON.stringify({ name: 'site', private: true, scripts: { build: 'node build.mjs', test: 'node -e 0' } }), 'build.mjs': 'console.log("built");\n',
    'e2e/cases/fixture.json': JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'builds', run: 'node --eval 0' }] }) });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  await write(root, { 'build.mjs': 'console.log("changed");\n' });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  return { base, head };
}
// An idle host by its CPU counters: only heat can excuse the timeout.
function idleCpu() {
  let total = 0, idle = 0;
  return { read: () => readTrialCpu(() => `cpu  ${total - idle} 0 0 ${idle} 0 0 0 0 0 0\n`, 0, total), step: () => { total += 1000; idle += 900; } };
}
const heatWait = (seconds: number) => `graphyard trial container: waiting: a CPU sensor reads 97C, at or over its 85C limit\ngraphyard trial container: waiting: a CPU sensor held this start ${seconds}s\ngraphyard trial container: starting\n`;
const testTimeout = 'not ok - tests/one.test.ts\n  test at tests/one.test.ts:1:1\n  test file timed out after 300000ms';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };

async function trialWithHeat(heat: string, cycles: number) {
  const root = await temporaryDirectory('heat-wait-repo');
  const { base, head } = await repository(root);
  const scratch = await temporaryDirectory('heat-wait-root');
  const cpu = idleCpu();
  let attempts = 0;
  const run: ChildRun = async (command, args, { wrapper: _wrapper, ...options } = {}) => {
    if (command === 'npm' && args.includes('test')) { cpu.step(); throw Object.assign(new Error('test failed'), { status: 1, stdout: testTimeout, stderr: heat }); }
    if (command === 'npm') { cpu.step(); return ''; }
    return defaultChildRun(command, args, options);
  };
  const store = await withDatabase('heat-wait'); await store.init();
  const engine = new Engine(store, 120, 'owner/proofs');
  engine.gitRunner = gitRunnerFor(root); engine.baseBranch = 'main';
  const token = 'fixture-coordinator-' + 'x'.repeat(32);
  const http = server(engine, [{ ...coordinator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'heat', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: root, branch: 'graphyard/gy-1-1' }, randomUUID());
    work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
    const ports: MergePorts = {
      baseBranch: 'main', now: Date.now, fetch: async () => base,
      merge: async sha => {
        const merged = await trialMerge(async args => git(root, ...args), { head: sha, baseTip: base });
        assert.ok('mergeSha' in merged); return { mergeSha: merged.mergeSha, files: ['build.mjs'] };
      },
      trial: async mergeSha => ({ ...await runTrial({ root, base: scratch, mergeSha, baseTip: base, changedFiles: ['build.mjs'], timeoutMs: 120_000,
        run, cores: 8, cpu: cpu.read, environment: { PATH: process.env.PATH! }, onAttempt: () => { attempts++; } }), files: ['tests/one.test.ts'], proofs: {} }),
      push: async () => { throw new Error('a failed trial never pushes'); }, holds: async () => false,
      record: async (item, event) => {
        const answer = await fetch(`${url}/api/work/${item.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
        assert.equal(answer.status, 200, await answer.text());
      },
    };
    const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
      repository: 'owner/project', baseBranch: 'main', hostId: 'fixture', masterAgentName: 'master', workers: [] });
    const state = emptyDaemonState(config);
    const reworks: Work[] = [], after: { work: Work; queued: boolean; attempts: number }[] = [];
    const effects = { mergeWriter: ports as MergeWriterReads, persist: async () => {}, rework: async (item: Work) => { reworks.push(item); } };
    for (let cycle = 0; cycle < cycles; cycle++) {
      const current = (await store.workDocument(work.id))!;
      // Independent admission is granted in this fixture; the trial and its records are real.
      const admitted = { ...current, gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
        observation: { source: 'control-plane', candidate: current.candidate, files: ['build.mjs'], checks: [], reviews: [], merged: false,
          mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, at: new Date().toISOString() } } as Work;
      await mergeWriterStep({ state, effects, config, now: Date.now, snapshot: { work: [admitted], now: new Date().toISOString() }, performed: [] } as unknown as Cycle);
      await mergeWriterIdle(state);
      const document = (await store.workDocument(work.id))!;
      after.push({ work: document, queued: state.mergeWriter.queue.some(entry => entry.key === document.key), attempts });
    }
    return { key: work.key, after, reworks, attempts, state, trials: (await store.workDocument(work.id))!.mergeLedger };
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); }
}

test('integration:heat-wait-not-red — a test that timed out while its containers waited over a minute on heat is inconclusive: the same head is trialled again, never reworked, and the third heat failure raises one attention line', { timeout: 300_000 }, async () => {
  // Two heat waits adding up to 75s.
  const { key, after, reworks, attempts, state } = await trialWithHeat(heatWait(40) + heatWait(35), 6);
  assert.equal(reworks.length, 0, 'no rework is requested');
  for (const [cycle, entry] of after.entries()) {
    assert.equal(entry.work.reworkRequested, false);
    assert.equal(trialRefusalHeld(entry.work.candidate, entry.work.mergeLedger), null, 'the head is not refused as a failed trial');
    if (entry.attempts < 3) { assert.equal(entry.work.blocker, null, `cycle ${cycle}: the head stays available for its retrial`); assert.ok(entry.queued, `cycle ${cycle}: the item stays in the merge queue`); }
  }
  assert.equal(attempts, 3, 're-trialled twice for heat, then no more');
  assert.ok(after.at(-1)!.work.blocker, 'the third heat failure holds the head');
  const notes = Object.values(state.actions).filter(action => action.work === key && /trial slowed by heat, retried/.test(action.detail));
  assert.ok(notes.length > 0, 'the item carries the note "trial slowed by heat, retried"');
  const attention = Object.values(state.actions).filter(action => action.kind === 'attention');
  assert.equal(attention.length, 1, 'one attention line');
  assert.match(attention[0]!.detail, new RegExp(`^${key}: .*too hot`), 'the line names the item and the cause');
});

for (const [label, heat] of [['no heat wait', ''], ['a 50s heat wait', heatWait(50)]] as const) {
  test(`integration:heat-wait-not-red — a timed-out test with ${label} is the head's, exactly as before`, { timeout: 300_000 }, async () => {
    const { after, reworks, attempts, state } = await trialWithHeat(heat, 2);
    assert.equal(attempts, 1);
    assert.ok(reworks.length > 0, 'rework is requested');
    assert.match(after.at(-1)!.work.mergeLedger?.refusal?.reason ?? '', /^trial failed/);
    assert.equal(Object.values(state.actions).filter(action => action.kind === 'attention').length, 0);
  });
}
