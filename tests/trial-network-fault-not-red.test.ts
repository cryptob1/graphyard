import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge, trialHostFaultHost, networkFaultHost, TrialHostFaultError } from '../src/merge-writer/trial.js';
import { mergeOne, type MergePorts } from '../src/merge-writer/executor.js';
import { trialRefusalHeld } from '../src/model/merge-queue.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { reportTrialHostFault } from '../src/daemon/control-plane.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

// GY-3249: Huck's merge trials failed at next/font fetching from Google Fonts, each counted a red
// head, and Huck's master worked around it in Huck's repository. A trial step that fails fetching
// from an external host runs once more; failing so again it is a trial-host fault: no verdict, no
// refusal, no rework, and the loop reports it upstream once per host. The fixture's build fetches
// from an unresolvable host (.invalid never resolves).

const host = 'fonts.graphyard-fixture.invalid';
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
  await write(root, { 'build.mjs': `await fetch('https://${host}/css2?family=Inter');\nconsole.log("built");\n` });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fonts');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  return { base, head };
}

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };

test('e2e:trial-network-fault-not-red — a build failing on a network fetch reruns once, then records a trial-host fault naming the host; the head is neither refused nor reworked', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('trial-network-fault', tmpdir());
  const { base, head } = await repository(root);
  let builds = 0, attempts = 0;
  const trials: Parameters<MergePorts['record']>[1][] = [];
  // The trial's children run here directly, not in the trial container.
  const run: ChildRun = (command, args, { wrapper: _wrapper, ...options } = {}) => {
    if (args.includes('build')) builds++;
    return defaultChildRun(command, args, options);
  };
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    store = await withDatabase('trial-network-fault'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    engine.gitRunner = gitRunnerFor(root); engine.baseBranch = 'main';
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'fonts', criteria: [{ id: 'AC-1', text: 'Builds', proofs: ['unit:builds', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: root, branch: 'graphyard/gy-1-1' }, randomUUID());
    work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
    const ports: MergePorts = {
      baseBranch: 'main', now: Date.now,
      fetch: async () => base,
      merge: async headSha => {
        const merged = await trialMerge(async args => git(root, ...args), { head: headSha, baseTip: base });
        assert.ok('mergeSha' in merged);
        return { mergeSha: merged.mergeSha, files: ['build.mjs'] };
      },
      trial: async mergeSha => runTrial({ root, base: await temporaryDirectory('trial-network-fault-root', tmpdir()), mergeSha, baseTip: base, changedFiles: ['build.mjs'],
        timeoutMs: 120_000, environment: { PATH: process.env.PATH! }, run, onAttempt: () => { attempts++; } }) as never,
      push: async () => { throw new Error('a trial-host fault never pushes'); },
      holds: async () => false,
      record: async (item, event) => {
        if (event.kind === 'trial') trials.push(event);
        const answer = await fetch(`${url}/api/work/${item.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
        assert.equal(answer.status, 200, await answer.text());
      },
    };
    const failed = await mergeOne(ports, work).then(() => null, (error: unknown) => error);
    assert.ok(failed instanceof TrialHostFaultError, `a trial-host fault, not a red verdict: ${String(failed)}`);
    assert.equal(trialHostFaultHost(failed), host, 'the fault names the host');
    assert.equal(trialHostFaultHost(new Error(failed.message)), host, 'the host survives the detached run\'s process boundary as its message');
    assert.equal(builds, 2, 'the build step reran once');
    const recorded = trials.at(-1) as { outcome?: string; reason?: string } | undefined;
    assert.equal(recorded?.outcome, 'host-failure', 'the trial records no verdict on the head');
    assert.match(recorded?.reason ?? '', new RegExp(`^Trial-host fault: .*${host.replace(/\./g, '\\.')}`), 'the trial record names the host');
    assert.equal(attempts, 1, 'the whole trial is not retried on top of the step rerun');
    const current: Work = (await store.workDocument(work.id))!;
    assert.equal(current.reworkRequested, false, 'no new head is asked for');
    assert.equal(trialRefusalHeld(current.candidate, current.mergeLedger), null, 'the head is not refused as a failed trial');
    assert.notEqual(current.mergeLedger?.state, 'refused');
    assert.equal(current.blocker, null, 'nothing parks the item');
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
  }
});

test('e2e:trial-network-fault-not-red — the external host is read from resolver, socket and next/font failures; loopback and plain build errors are the head\'s', () => {
  assert.equal(networkFaultHost('TypeError: fetch failed\n  [cause]: Error: getaddrinfo ENOTFOUND fonts.googleapis.com'), 'fonts.googleapis.com');
  assert.equal(networkFaultHost('Error: getaddrinfo EAI_AGAIN registry.npmjs.org'), 'registry.npmjs.org');
  assert.equal(networkFaultHost('Error: connect ECONNREFUSED 142.250.72.10:443'), '142.250.72.10');
  assert.equal(networkFaultHost('Failed to fetch `Inter` from Google Fonts.'), 'fonts.googleapis.com');
  assert.equal(networkFaultHost(['Failed to compile.', '', 'src/app/layout.tsx', 'An error occurred in `next/font`.', '', 'TypeError: Cannot read properties of null (reading \'1\')'].map(line => `@hello-huck/sites:build: ${line}`).join('\n')), 'fonts.googleapis.com', 'Huck\'s turbo-prefixed next/font crash');
  assert.equal(networkFaultHost('An error occurred in `next/font`.\n\nUnknown font `Intr`'), null, 'a font the repository misnamed is the head\'s');
  assert.equal(networkFaultHost('Error: connect ECONNREFUSED 127.0.0.1:5432'), null, 'a loopback service is the build\'s own');
  assert.equal(networkFaultHost('src/index.ts(3,1): error TS2304: Cannot find name \'x\'.'), null);
});

const config = (repository: string, upstream = false) => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-game', workers: [], ...(upstream ? { upstream: { url: 'https://upstream.example', credentialFile: '/outside/upstream.token' } } : {}) });

test('e2e:trial-network-fault-not-red — a non-Graphyard install files the trial-host fault upstream once per host, or raises one attention line; never into the managed repository', async () => {
  const local: string[] = [], filed: { key: string; title: string }[] = [], lines: string[] = [];
  const mergeWriter = { createWork: async (_input: unknown, key: string) => { local.push(key); return { key: 'GY-1' }; } } as unknown as MergeWriterReads;
  const fileUpstream: DaemonEffects['fileUpstream'] = async (input, key) => { filed.push({ key, title: input.title }); return { key: 'GY-900' }; };
  const withUpstream = { state: emptyDaemonState(config('owner/game', true)), effects: { mergeWriter, fileUpstream } as unknown as DaemonEffects, clock: Date.now(), log: (line: string) => lines.push(line), config: config('owner/game', true) };
  for (let cycle = 0; cycle < 3; cycle++) await reportTrialHostFault(withUpstream, host);
  assert.deepEqual(filed.map(entry => entry.key), [`trial-host-fault:${host}`], 'filed once to the upstream install');
  assert.match(filed[0]!.title, new RegExp(`cannot fetch from ${host.replace(/\./g, '\\.')}`));
  const without = { ...withUpstream, state: emptyDaemonState(config('owner/game')), effects: { mergeWriter } as unknown as DaemonEffects, config: config('owner/game') };
  lines.length = 0;
  for (let cycle = 0; cycle < 3; cycle++) await reportTrialHostFault(without, host);
  assert.equal(lines.filter(line => /attention failed: Graphyard fault: merge trials cannot fetch from/.test(line)).length, 1, 'one attention line across cycles');
  assert.deepEqual(local, [], 'nothing is filed into owner/game');
});
