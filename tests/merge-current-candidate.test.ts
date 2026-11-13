import { freePort } from '../src/cli/test-isolation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, reconcileIntents, runMergeTrial, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { defaultRepositoryPolicy } from '../src/model/repository-policy.js';
import { setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { Principal, Work } from '../src/model.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('integration:merge-current-candidate — typed rework and replacement ownership stop pending trials; unchanged candidates land', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('current-candidate');
  const servePort = await freePort();
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    store = await withDatabase('merge-current-candidate'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
    let branchNumber = 0;
    for (const mode of ['pending', 'unchanged', 'review-held'] as const) {
      const directory = join(root, mode), origin = join(directory, 'origin.git'), checkout = join(directory, 'checkout');
      await mkdir(directory);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
      git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
      const write = async (path: string, value: string) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), value); };
      await write('package.json', JSON.stringify({ scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs' } }));
      await write('proof.cjs', `const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('unit:declared', () => assert.ok(!(fs.existsSync('change-0.txt') && fs.existsSync('change-1.txt'))));
`);
      // The trial serves the real head before running its bound command case.
      await write('serve.cjs', `require('node:http').createServer((q,s)=>s.end('ok')).listen(${servePort}, '127.0.0.1');\n`);
      await write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.cjs', url: `http://127.0.0.1:${servePort}`, readySeconds: 1 } } }));
      await write('e2e/cases/fixture.json', JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'served head command', run: 'node --eval 0' }] }));
      git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
      const baseTip = git(origin, 'rev-parse', 'main');
      engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
      const works: Work[] = [];
      for (let n = 0; n < 1; n++) {
        const branch = `graphyard/gy-${++branchNumber}-1`;
        git(checkout, 'checkout', '-qb', branch, baseTip);
        await write(`change-${n}.txt`, 'change'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'change');
        const head = git(checkout, 'rev-parse', 'HEAD');
        const proof = 'unit:declared';
        let work = await engine.execute(operator, 'create', null, { type: mode === 'review-held' ? 'feature' : 'chore', title: `${mode}-${n}`, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:fixture'] }, { id: 'AC-2', text: 'Observe after deployment', proofs: ['manual:post-deploy/observed'] }] }, randomUUID());
        work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
        work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
        await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: join(directory, branch), branch }, randomUUID());
        work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
        assert.equal(work.gates.find(gate => gate.name === 'build')?.passed, true);
        assert.equal(work.gates.find(gate => gate.name === 'review')?.passed, mode !== 'review-held');
        works.push(work);
      }
      git(checkout, 'checkout', '-q', 'main');
      let pushes = 0;
      const records: { key: string; event: MergeRecordEvent }[] = [];
      // The bound E2E runs in the normal private root, including nested trial wrappers.
      // A worker has no Docker socket and already inherits confinement: fixture commands run
      // directly there, with the same real output and the trusted harness resolved locally.
      const fixtureRun: ChildRun = async (command, args, options) => {
        if (command === 'git' && args.includes('push')) pushes++;
        if (!existsSync('/etc/graphyard-trial') && options?.wrapper?.length) {
          if (args.includes('/graphyard-harness/node_modules/tsx/dist/loader.mjs')) {
            const script = args.at(-1)!;
            const harness = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
            await writeFile(script, (await readFile(script, 'utf8')).replaceAll('/graphyard-harness', harness));
            args = args.map(arg => arg === '/graphyard-harness/node_modules/tsx/dist/loader.mjs' ? fileURLToPath(new URL(import.meta.resolve('tsx'))) : arg);
          }
          return defaultChildRun(command, args, { ...options, wrapper: [] });
        }
        return defaultChildRun(command, args, options);
      };
      const config = masterConfigSchema.parse({ version: 1, repository: 'owner/proofs', baseBranch: 'main', url, credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } });
      const production = daemonEffects(checkout, config, { snapshot: async () => ({ work: await Promise.all(works.map(async work => (await store!.workDocument(work.id))!)), now: new Date().toISOString() }), mutate: async () => { throw new Error('unused'); } });
      let started!: () => void, release!: () => void, trials = 0;
      const pending = new Promise<void>(resolve => { started = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const reads = mergeWriterReads(config, checkout, fixtureRun, {
          base: join(directory, 'managed'),
          hold: production.mergeWriter!.hold,
          holdOpening: production.mergeWriter!.holdOpening,
          trial: async input => {
            trials++;
            if (trials === 1) { started(); await resume; }
            return runMergeTrial({ ...input, retries: 0, attribute: false });
          },
          record: async (work, event) => {
            records.push({ key: work.key, event });
            const answer = await fetch(`${url}/api/work/${work.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
            assert.equal(answer.status, 200, await answer.text());
          },
        });
      if (mode === 'review-held') {
        // Trial history belongs to a current candidate even while product review holds landing.
        const target = works[0]!, head = target.candidate!.sha;
        // GY-3164: the build gate alone opens a flight, so the held review does not stop the trial;
        // the landing hold names the settle that keeps the passing trial for the head.
        assert.equal(await production.mergeWriter!.holdOpening!(target), null);
        assert.match((await production.mergeWriter!.hold!(target))!, /^trial passed ahead of review/);
        const merged = await reads.merge(head, baseTip, target);
        assert.ok('mergeSha' in merged);
        const { mergeSha } = merged;
        await reads.record(target, { kind: 'intent', head, baseTip, mergeSha, risk: 'normal', at: new Date().toISOString() });
        release();
        const run = await reads.trial(mergeSha, merged.files, target, baseTip);
        assert.deepEqual(run.proofs['e2e:fixture'], { executed: 1, failed: 0 });
        await reads.record(target, { kind: 'trial', head, baseTip, mergeSha, outcome: 'verdict', build: run.build,
          tests: run.tests, files: run.files, proofs: run.proofs, durationMs: run.durationMs, attempts: [], e2e: run.e2e });
        const current: Work = (await store.workDocument(target.id))!;
        assert.ok(current.evidence.some(entry => entry.proof === 'e2e:fixture' && entry.sha === mergeSha && entry.result === 'pass'), 'current trial retains trusted case history while review is pending');
        assert.equal(current.gates.find(gate => gate.name === 'review')?.passed, false);
        assert.match((await production.mergeWriter!.hold!(target))!, /^trial passed ahead of review/, 'the held review still refuses the landing, keeping the trial that passed');
        assert.equal(pushes, 0);
        assert.equal(current.delivery ?? null, null);
        continue;
      }
      const running = mergeOne(reads, works[0]!).then(outcome => [{ work: works[0]!, outcome }]);
      await Promise.race([pending, running.then(result => { throw new Error(`writer ended before pending trial: ${JSON.stringify(result, (_key, value) => value instanceof Error ? value.message : value)}`); })]);
      const target = works[0]!;
      const eventsBefore: { seq: string }[] = (await store.pool.query('SELECT seq FROM events WHERE work_id=$1 ORDER BY seq', [target.id])).rows;
      let replacement: Work | undefined;
      try {
        if (mode !== 'unchanged') {
          await engine.execute(operator, 'rework', target.id, { reason: 'Return obsolete candidate for correction', previousWorkerStopped: true }, randomUUID());
          replacement = await engine.execute(worker, 'claim', target.id, {}, randomUUID());
          assert.ok(replacement.lease);
          // A native caller that lacks the fresh read still cannot open an intent under rework.
          const denied = await fetch(`${url}/api/work/${target.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
            body: JSON.stringify({ kind: 'intent', head: target.candidate!.sha, baseTip, mergeSha: target.candidate!.sha, risk: 'normal', at: new Date().toISOString() }) });
          assert.equal(denied.status, 409, await denied.text());
        } else {
          await reads.record(target, { kind: 'trial-step', head: target.candidate!.sha, step: 'tests', at: new Date().toISOString() });
          const current: Work = (await store.workDocument(target.id))!;
          assert.ok(current.revision > target.revision);
          assert.equal(await production.mergeWriter!.hold?.(target), null, 'incidental revisions do not invalidate a candidate');
        }
      } finally { release(); }
      const results = await running;
      assert.ok(results.every(result => 'outcome' in result), JSON.stringify(results));
      if (mode !== 'unchanged') {
        const unsettled = (await store.workDocument(target.id))!;
        await reconcileIntents(reads, [unsettled], { [target.key]: unsettled.mergeLedger! });
      }
      const current: Work = (await store.workDocument(target.id))!;
      assert.deepEqual((await store.pool.query('SELECT seq FROM events WHERE work_id=$1 ORDER BY seq LIMIT $2', [target.id, eventsBefore.length])).rows, eventsBefore, 'original history retained');
      if (mode === 'unchanged') {
        assert.equal(current.stage, 'done');
        assert.equal(pushes, 1);
        assert.equal(git(origin, 'rev-parse', 'main'), current.delivery!.mergeSha);
      } else {
        assert.notEqual(current.stage, 'done');
        assert.equal(current.delivery ?? null, null);
        assert.deepEqual(current.lease, replacement!.lease);
        assert.equal(current.epoch, replacement!.epoch);
        assert.equal(current.reworkRequested, true);
        assert.equal(git(origin, 'rev-list', 'main').split('\n').includes(target.candidate!.sha), false);
        assert.equal(pushes, 0);
        assert.equal(trials, 1, 'a stale candidate never opens another trial');
        assert.equal(results.filter(result => 'outcome' in result).find(result => result.work.id === target.id)?.outcome.outcome, 'requeued');
        assert.ok(records.some(row => row.key === target.key && row.event.kind === 'intent'));
        assert.ok(records.some(row => row.key === target.key && row.event.kind === 'trial'), 'original measured trial retained');
        assert.deepEqual(current.evidence, replacement!.evidence, 'obsolete trial supplies no replacement evidence');
        assert.equal(current.mergeLedger?.state, 'refused', 'cancelled flight retains its refusal');
      }

    }
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
