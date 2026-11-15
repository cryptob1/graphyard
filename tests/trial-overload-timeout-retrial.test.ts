import { readTrialCpu, trialCpuMonitor, usableTrialCores } from '../src/merge-writer/trial-cpu.js';
import { trialContainerCap } from '../src/merge-writer/trial-load.js';
import { mergeWriterStep, mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge } from '../src/merge-writer/trial.js';
import { type MergePorts } from '../src/merge-writer/executor.js';
import { trialRefusalHeld } from '../src/model/merge-queue.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

const proof = 'e2e:trial-overload-timeout-retrial';
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

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };

// /proc/stat counters move only while the stubbed step runs. Prior load must not excuse
// a timeout during a healthy step, and idle time before a slow step must not hide its steal.
function cpuFixture(steal: number) {
  let total = 0, stolen = 0, idle = 0;
  return {
    read: () => readTrialCpu(() => `cpu  ${total - stolen - idle} 0 0 ${idle} 0 0 0 ${stolen} 0 0\n`, 0, total),
    step: () => { total += 1000; stolen += steal * 1000; idle += (1 - steal) * 900; },
  };
}
const testTimeout = '  1) browser-tests/one.spec.ts:3:1 › one test\n\n    Test timeout of 120000ms exceeded.\n\n  1 failed';
const webTimeout = 'Error: Timed out waiting 60000ms from config.webServer.';
const serveTimeout = 'the serve command did not answer http://127.0.0.1:8080/healthz within 180s';

for (const mode of ['serve', 'test', 'file', 'web-server', 'deadline'] as const) for (const steal of mode === 'deadline' ? [0.7] : [0.7, 0]) {
  test(`${proof} — ${mode} timeout with ${steal * 100}% steal`, { timeout: 120_000 }, async () => {
    const root = await temporaryDirectory('trial-overload-repo');
    const { base, head } = await repository(root);
    const scratch = await temporaryDirectory('trial-overload-root');
    const cpu = cpuFixture(steal);
    const run: ChildRun = async (command, args, { wrapper: _wrapper, ...options } = {}) => {
      if (command === 'npm' && args.includes('test')) {
        cpu.step();
        throw Object.assign(new Error('test failed'), { status: 1, ...(mode === 'deadline' ? { timedOut: true } : {}), stdout: mode === 'test' ? testTimeout : mode === 'file' ? 'not ok - tests/one.test.ts\n  test at tests/one.test.ts:1:1\n  test file timed out after 300000ms' : webTimeout, stderr: '' });
      }
      if (command === 'npm') { cpu.step(); return ''; }
      // The E2E container returns the serve-ready timeout in its normal result file.
      if (command === 'node' && args.at(-1)?.endsWith('/run.mjs')) {
        const script = await readFile(args.at(-1)!, 'utf8');
        const path = /writeFileSync\(("[^"\n]+")/.exec(script)![1]!;
        cpu.step();
        await writeFile(JSON.parse(path), JSON.stringify([{ proof: 'e2e:fixture', case: 'fixture', executed: 0, failed: 1, failingStep: serveTimeout }]));
        return '';
      }
      return defaultChildRun(command, args, options);
    };
    // Serving is declared so the real E2E orchestration reaches the stubbed container.
    git(root, 'checkout', '-q', '--detach', head);
    await write(root, { 'graphyard.json': JSON.stringify({ e2e: { serve: { command: 'node server.js', url: 'http://127.0.0.1:8080', readySeconds: 180 } } }) });
    git(root, 'add', 'graphyard.json'); git(root, 'commit', '-q', '-m', 'serve declaration');
    const candidate = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--detach', base);
    const store = await withDatabase('trial-overload'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    engine.gitRunner = gitRunnerFor(root); engine.baseBranch = 'main';
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    const http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    try {
      let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'overload', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, randomUUID());
      work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
      work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
      await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: root, branch: 'graphyard/gy-1-1' }, randomUUID());
      work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head: candidate }, randomUUID());
      let attempts = 0;
      const ports: MergePorts = {
        baseBranch: 'main', now: Date.now, fetch: async () => base,
        merge: async sha => {
          const merged = await trialMerge(async args => git(root, ...args), { head: sha, baseTip: base });
          assert.ok('mergeSha' in merged); return { mergeSha: merged.mergeSha, files: ['build.mjs'] };
        },
        trial: async mergeSha => ({ ...await runTrial({ root, base: scratch, mergeSha, baseTip: base, changedFiles: ['build.mjs'], timeoutMs: 120_000,
          run, cores: 8, cpu: cpu.read, environment: { PATH: process.env.PATH! }, onAttempt: () => { attempts++; },
          ...(mode === 'serve' ? { e2eProofs: ['e2e:fixture'] } : {}) }), files: ['browser-tests/one.spec.ts'], proofs: {} }),
        push: async () => { throw new Error('never pushes a timeout'); }, holds: async () => false,
        record: async (item, event) => {
          const answer = await fetch(`${url}/api/work/${item.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
          assert.equal(answer.status, 200, await answer.text());
        },
      };
      const config = masterConfigSchema.parse({ version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
        repository: 'owner/project', baseBranch: 'main', hostId: 'fixture', masterAgentName: 'master', workers: [] });
      const state = emptyDaemonState(config);
      const reworks: Work[] = [];
      const effects = { mergeWriter: ports as MergeWriterReads, persist: async () => {}, rework: async (item: Work) => { reworks.push(item); } };
      for (let cycle = 0; cycle < 8; cycle++) {
        const current = (await store.workDocument(work.id))!;
        // Independent admission is already granted in this fixture; the trial and records are real.
        const admitted = { ...current, gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
          observation: { source: 'control-plane', candidate: current.candidate, files: ['build.mjs'], checks: [], reviews: [], merged: false,
            mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, at: new Date().toISOString() } } as Work;
        await mergeWriterStep({ state, effects, config, now: Date.now, snapshot: { work: [admitted], now: new Date().toISOString() }, performed: [] } as unknown as Cycle);
        await mergeWriterIdle(state);
        const after = (await store.workDocument(work.id))!;
        assert.equal(after.candidate?.sha, candidate);
        if (steal) {
          assert.equal(after.reworkRequested, false);
          assert.equal(trialRefusalHeld(after.candidate, after.mergeLedger), null);
          if (attempts < 3) assert.equal(after.blocker, null, 'the same head stays available for retrial');
        }
      }
      const current = (await store.workDocument(work.id))!;
      if (steal) {
        assert.equal(attempts, 3, 'three trials, then no further retries across loop cycles');
        assert.match(current.blocker!, /three trials.*master.*70% CPU steal/i);
        assert.equal(reworks.length, 0);
        const attention = Object.values(state.actions).filter(action => action.kind === 'attention');
        assert.equal(attention.length, 1, 'one attention line across trials and cycles');
        assert.match(attention[0]!.detail, /70% CPU steal/);
      } else {
        assert.equal(attempts, 1);
        assert.ok(reworks.length > 0, 'an idle-host timeout requests rework');
        assert.match(current.mergeLedger?.refusal?.reason ?? '', /^trial failed/);
      }
    } finally { await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); }
  });
}

for (const steal of [0.7, 0]) test(`${proof} — eight cores with ${steal * 100}% steal run in ${steal ? 2 : 8} lanes`, async () => {
  const root = await temporaryDirectory('trial-overload-lanes');
  const { head } = await repository(root);
  git(root, 'checkout', '-q', '--detach', head);
  const policy = JSON.parse(await readFile(new URL('../graphyard.json', import.meta.url), 'utf8'));
  policy.delivery.mergeGate.preMerge = policy.delivery.mergeGate.preMerge.filter((check: { check: string }) => check.check === 'test');
  await write(root, { 'graphyard.json': JSON.stringify(policy) });
  git(root, 'add', 'graphyard.json'); git(root, 'commit', '-q', '-m', 'selected test shards');
  const mergeSha = git(root, 'rev-parse', 'HEAD');
  const cpu = cpuFixture(steal), timings: string[] = [];
  const files = Array.from({ length: 8 }, (_, n) => `tests/t${n}.test.ts`);
  let running = 0, maximum = 0;
  const seen: string[] = [];
  const run: ChildRun = async (command, args, { wrapper: _wrapper, ...options } = {}) => {
    if (command === 'npm') { cpu.step(); return ''; }
    if (args.includes('scripts/ci-tests.mjs')) { cpu.step(); return files.join('\n'); }
    if (args.includes('--files-from')) {
      running++; maximum = Math.max(maximum, running);
      const shard = (await readFile(args[args.indexOf('--files-from') + 1]!, 'utf8')).trim().split('\n');
      seen.push(...shard);
      await new Promise(resolve => setTimeout(resolve, 30));
      await writeFile(args[args.indexOf('--durations') + 1]!, shard.map(file => JSON.stringify({ file, passed: true, durationMs: 1 })).join('\n'));
      cpu.step(); running--;
      return shard.map(file => `ok - ${file}`).join('\n');
    }
    return defaultChildRun(command, args, options);
  };
  const verdict = await runTrial({ root, base: await temporaryDirectory('trial-overload-lanes-root'), mergeSha, changedFiles: files,
    timeoutMs: 60_000, cores: 8, cpu: cpu.read, memory: async () => null, run, environment: { PATH: process.env.PATH! }, onTiming: step => timings.push(step) });
  assert.deepEqual(verdict.tests, { passed: 8, failed: [], files: 8 });
  assert.equal(maximum, steal ? 2 : 8, 'actual concurrent runner children');
  assert.deepEqual(seen.sort(), files, 'every test still runs exactly once');
  assert.ok(timings.some(line => line.startsWith(`tests: ${steal ? 2 : 8} lanes`)));
  assert.equal(trialContainerCap(8, usableTrialCores(8, steal)), steal ? 2 : 6, 'the machine-wide cap scales too');
});

test(`${proof} — CPU attribution uses the timed-out step, and sizing forgets samples older than a minute`, () => {
  let at = 0, total = 0, stolen = 0, load = 0, idle = 0;
  const read = () => readTrialCpu(() => `cpu ${total - stolen - idle} 0 0 ${idle} 0 0 0 ${stolen}`, load, at);
  const monitor = trialCpuMonitor(read, 8);
  try {
    total = 1000; stolen = 700; at = 1000;
    assert.ok(Math.abs(monitor.cores() - 2.4) < 0.001);
    const healthy = monitor.sample();
    total += 1000; idle += 900; at += 1000;
    assert.doesNotThrow(() => monitor.finish('healthy step', healthy, true, () => {}));
    const busy = monitor.sample();
    total += 1000; stolen += 700; at += 1000;
    assert.throws(() => monitor.finish('test', busy, true, () => {}), /70% CPU steal/);
    const loaded = monitor.sample();
    total += 1000; load = 20; at += 1000;
    assert.throws(() => monitor.finish('test', loaded, true, () => {}), /load 20.0 on 8 cores/);
    total += 1000; idle += 900; at += 61_000; monitor.sample();
    total += 1000; idle += 900; at += 1000;
    assert.equal(monitor.cores(), 8, 'old steal ages out');
  } finally { monitor.close(); }
});
