import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, runMergeTrial, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import { mergeBatch } from '../src/merge-writer/batch.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
import type { Principal, Work } from '../src/model.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The bound command case runs this same real regression inside the native private-root trial.
test('integration:merge-requires-executed-proofs — single and batch writers refuse absent, zero-count and failing proofs before pushing; explicit TAP lands through the ordinary control plane', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('required-proofs');
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 3070;
  const servePort = port + 1;
  const pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('required-proofs-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    await pg.initialise(); await pg.start(); await pg.createDatabase('required_proofs');
    store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/required_proofs`); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
    let branchNumber = 0;
    for (const batch of [false, true]) for (const mode of ['spec', 'missing', 'failed', 'tap'] as const) {
      const directory = join(root, `${batch}-${mode}`), origin = join(directory, 'origin.git'), checkout = join(directory, 'checkout');
      await mkdir(directory);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
      git(checkout, 'config', 'user.name', 'Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.com');
      const write = async (path: string, value: string) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), value); };
      const reporter = mode === 'spec' ? 'spec' : 'tap';
      // Even a command that exits successfully cannot turn a failing TAP case into accepted proof.
      await write('package.json', JSON.stringify({ scripts: { build: 'node --eval 0', test: `node --test --test-reporter=${reporter} proof.cjs${mode === 'failed' ? '; true' : ''}` } }));
      await write('proof.cjs', `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('unit:declared', () => { assert.equal(${mode === 'failed' ? '1, 2' : '1, 1'}); });\n`);
      // The trial serves the real head before running its bound command case.
      await write('serve.cjs', `require('node:http').createServer((q,s)=>s.end('ok')).listen(${servePort}, '127.0.0.1');\n`);
      await write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.cjs', url: `http://127.0.0.1:${servePort}`, readySeconds: 1 } } }));
      await write('e2e/cases/fixture.json', JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'served head command', run: 'node --eval 0' }] }));
      git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
      const baseTip = git(origin, 'rev-parse', 'main');
      engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
      const works: Work[] = [];
      for (let n = 0; n < (batch ? 2 : 1); n++) {
        const branch = `graphyard/gy-${++branchNumber}-1`;
        git(checkout, 'checkout', '-qb', branch, baseTip);
        await write(`change-${n}.txt`, 'change'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'change');
        const head = git(checkout, 'rev-parse', 'HEAD');
        const proof = mode === 'missing' ? 'integration:absent' : 'unit:declared';
        let work = await engine.execute(operator, 'create', null, { type: 'chore', title: `${batch}-${mode}-${n}`, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:fixture'] }, { id: 'AC-2', text: 'Observe after deployment', proofs: ['manual:post-deploy/observed'] }] }, randomUUID());
        work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
        work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
        await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: join(directory, branch), branch }, randomUUID());
        work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
        assert.equal(work.gates.find(gate => gate.name === 'build')?.passed, true);
        assert.equal(work.gates.find(gate => gate.name === 'review')?.passed, true);
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
      const reads = mergeWriterReads(masterConfigSchema.parse({ version: 1, repository: 'owner/proofs', baseBranch: 'main', url, credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key'), retrials: 0 } } }), checkout,
        fixtureRun, {
          base: join(directory, 'managed'),
          trial: input => runMergeTrial({ ...input, retries: 0, attribute: false }),
          record: async (work, event) => {
            records.push({ key: work.key, event });
            const answer = await fetch(`${url}/api/work/${work.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
            assert.equal(answer.status, 200, await answer.text());
          },
        });
      const results = batch ? await mergeBatch(reads, works) : [{ work: works[0]!, outcome: await mergeOne(reads, works[0]!) }];
      for (const result of results) {
        assert.ok('outcome' in result, JSON.stringify(result));
        assert.equal(result.outcome.outcome, mode === 'tap' ? 'merged' : 'refused', `${batch}-${mode}: ${JSON.stringify(result)}`);
        const work: Work = (await store.workDocument(result.work.id))!;
        assert.equal(!!work.delivery, mode === 'tap');
        const trials = records.filter(entry => entry.key === work.key && entry.event.kind === 'trial').map(entry => entry.event);
        assert.ok(trials.length >= (batch && mode !== 'tap' ? 2 : 1), 'failed batch and individual trial history retained');
        for (const trial of trials) {
          assert.ok(trial.kind === 'trial' && trial.outcome === 'verdict');
          assert.equal(trial.build, 'pass', JSON.stringify(result.outcome)); assert.deepEqual(trial.tests.failed, []);
          assert.deepEqual(trial.proofs[mode === 'missing' ? 'integration:absent' : 'unit:declared'], { executed: mode === 'spec' || mode === 'missing' ? 0 : 1, failed: mode === 'failed' ? 1 : 0 });
        }
        if (mode !== 'tap') assert.match(work.mergeLedger!.refusal!.reason, new RegExp(`${mode === 'missing' ? 'integration:absent' : 'unit:declared'}.*executed > 0.*failed = 0`));
      }
      assert.equal(pushes, mode === 'tap' ? 1 : 0, 'no refused trial invokes the leased push');
      assert.equal(git(origin, 'rev-parse', 'main') === baseTip, mode !== 'tap', 'remote main changes only for positive passing counts');
    }
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await pg.stop();
    await rm(root, { recursive: true, force: true });
  }
});
