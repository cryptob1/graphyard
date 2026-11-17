import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import type { LifecycleExec } from '../src/app-environments.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3296: app test environments — where the app under test runs. A case naming a declared
// environment gets an instance provisioned by the batch gate through the environment's up command
// (from the trusted base commit, with the install's 0600 secrets), its URL handed to the case, and
// torn down with the same identity; limits, waits, faults, restarts and leaks never condemn a
// candidate, while a real assertion failure stays a test failure. The module is loaded by the test,
// so a tree without it fails here as a test case.
const environments = () => import('../src/app-environments.js').catch(() => assert.fail('src/app-environments.ts is missing: no app test environment lifecycle'));

const made: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const server of servers) server.close();
  for (const directory of made) await rm(directory, { recursive: true, force: true });
});

const sentinel = 'sentinel-install-secret-3296';
const git = (repo: string, args: string[], env?: Record<string, string>) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

const upScript = `echo "up $GRAPHYARD_COMMIT $GRAPHYARD_RUN_ID base" >> "$PROVIDER_DIR/calls.log"
if [ -e "$PROVIDER_DIR/outage" ]; then echo "provider outage for token $PROVIDER_TOKEN" >&2; exit 1; fi
echo "$GRAPHYARD_RUN_ID" > "$PROVIDER_DIR/instances/inst-$GRAPHYARD_RUN_ID"
echo "provisioning"
echo "{\\"url\\":\\"$APP_URL\\",\\"instance\\":\\"inst-$GRAPHYARD_RUN_ID\\"}"
`;
const downScript = `echo "down $GRAPHYARD_COMMIT $GRAPHYARD_RUN_ID $GRAPHYARD_INSTANCE" >> "$PROVIDER_DIR/calls.log"
if [ -e "$PROVIDER_DIR/fail-down" ]; then echo "teardown refused for $PROVIDER_TOKEN" >&2; exit 1; fi
rm -f "$PROVIDER_DIR/instances/$GRAPHYARD_INSTANCE"
`;
const listScript = `printf '['; sep=''; for f in "$PROVIDER_DIR"/instances/*; do [ -e "$f" ] || continue; printf '%s{"instance":"%s","runId":"%s"}' "$sep" "$(basename "$f")" "$(cat "$f")"; sep=','; done; echo ']'
`;
// The candidate rewrites the lifecycle to leak the install secret: none of it may ever run.
const candidateUp = `echo "up $GRAPHYARD_COMMIT $GRAPHYARD_RUN_ID candidate" >> "$PROVIDER_DIR/calls.log"
echo "$PROVIDER_TOKEN" > "$PROVIDER_DIR/leaked"
echo '{"url":"http://127.0.0.1:9"}'
`;
const httpCase = (id: string, environment?: string) => JSON.stringify({ id, title: `The ${id} app answers`, target: 'any', ...(environment ? { environment } : {}),
  steps: [{ kind: 'http', name: 'the app answers', method: 'GET', path: '/app', status: 200, expect: [{ path: 'ok', equals: true }] }] });
const policy = (environment: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ featureMap: [{ name: 'App', url: '/app', traps: [] }], e2e: { serve: { command: 'true', url: 'http://127.0.0.1:1', readySeconds: 1 }, environments: { staging: environment, ...extra } } });

/** A repository with the verified base B declaring `staging`, the candidate C on it, an app the case hits, and the install's provider and secrets. */
async function fixture(options: { maxConcurrent?: number; secretsMode?: number } = {}) {
  const home = await temporaryDirectory('app-environments'); made.push(home);
  const repo = join(home, 'repo'), provider = join(home, 'provider'), configHome = join(home, 'config');
  await mkdir(join(repo, 'env'), { recursive: true }); await mkdir(join(repo, 'e2e/cases'), { recursive: true });
  await mkdir(join(provider, 'instances'), { recursive: true }); await mkdir(join(configHome, 'fixture-app'), { recursive: true });
  const app = { healthy: true, hits: 0 };
  const server = createServer((request, response) => { app.hits++; response.writeHead(app.healthy ? 200 : 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: app.healthy, path: request.url })); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const secretsFile = join(configHome, 'fixture-app', 'app-environments.env');
  await writeFile(secretsFile, `PROVIDER_TOKEN=${sentinel}\nPROVIDER_DIR=${provider}\nAPP_URL="${url}"\n`, { mode: options.secretsMode ?? 0o600 });
  await chmod(secretsFile, options.secretsMode ?? 0o600);
  git(home, ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'fixture@example.test']); git(repo, ['config', 'user.name', 'fixture']);
  const staging = { up: 'sh env/up.sh', down: 'sh env/down.sh', list: 'sh env/list.sh', maxConcurrent: options.maxConcurrent ?? 1 };
  await writeFile(join(repo, 'graphyard.json'), policy(staging));
  await writeFile(join(repo, 'env/up.sh'), upScript); await writeFile(join(repo, 'env/down.sh'), downScript); await writeFile(join(repo, 'env/list.sh'), listScript);
  await writeFile(join(repo, 'e2e/cases/staged-app.json'), httpCase('staged-app', 'staging'));
  await writeFile(join(repo, 'e2e/cases/local-app.json'), httpCase('local-app'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  // The candidate: lifecycle scripts and config rewritten to read and emit the secret, a case naming
  // an environment nobody declares, and one naming an environment only the candidate declares.
  await writeFile(join(repo, 'env/up.sh'), candidateUp);
  await writeFile(join(repo, 'graphyard.json'), policy({ ...staging, up: `cat ${secretsFile}; sh env/up.sh` }, { preview: { up: 'sh env/up.sh', down: 'sh env/down.sh' } }));
  await writeFile(join(repo, 'e2e/cases/ghost-app.json'), httpCase('ghost-app', 'ghost'));
  await writeFile(join(repo, 'e2e/cases/preview-app.json'), httpCase('preview-app', 'preview'));
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'candidate']);
  const candidate = git(repo, ['rev-parse', 'HEAD']).trim();
  const { environmentLifecycle, environmentStatePath } = await environments();
  const lines: string[] = [];
  const stateFile = environmentStatePath(repo);
  const lifecycle = (log = (line: string) => { lines.push(line); }, exec?: LifecycleExec) => environmentLifecycle({ stateFile, secretsFile: () => secretsFile, log, exec });
  const calls = async () => existsSync(join(provider, 'calls.log')) ? (await readFile(join(provider, 'calls.log'), 'utf8')).trim().split('\n') : [];
  return { home, repo, provider, configHome, secretsFile, app, url, base, candidate, stateFile, lifecycle, lines, calls };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The merge writer's reads over the fixture: real git, and a trial that runs the cases with the real E2E runner — a provisioned case against its environment's URL, a local one recorded as served by the trial's own serve. */
async function readsFor(fx: Fixture, lifecycle: ReturnType<Fixture['lifecycle']>, hold?: Promise<void>) {
  const { runTrialE2eCases, runTrialE2eGroup } = await import('../src/merge-writer/e2e-trial.js');
  const trials: { item: unknown; groups: { target: string; origin: string | undefined; proofs: readonly string[] }[]; log: string[] }[] = [];
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => fx.candidate,
    git: async (args: string[], env?: Record<string, string>) => git(fx.repo, args, env),
    gate: { root: fx.repo, repository: 'fixture/app', environments: lifecycle },
    createWork: async () => ({ key: 'GY-9' }),
    trial: async (commit: string, _files: readonly string[], item: Pick<Work, 'key' | 'criteria'> & { environments?: Record<string, string> }) => {
      await hold;
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      const record = { item, groups: [] as { target: string; origin: string | undefined; proofs: readonly string[] }[], log: [] as string[] };
      trials.push(record);
      const e2e = await runTrialE2eCases({ worktree: fx.repo, mergeSha: commit, proofs, env: { PATH: process.env.PATH ?? '' }, scratch: fx.home, budgetMs: 60_000,
        holds: async path => existsSync(join(fx.repo, path)), log: line => record.log.push(line), origins: item.environments,
        runGroup: async (target, groupProofs, input, origin) => {
          record.groups.push({ target: target.id, origin, proofs: groupProofs });
          return origin ? runTrialE2eGroup(target, groupProofs, input, origin) : groupProofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 }));
        } });
      return { build: 'pass', tests: { passed: 0, failed: [], files: 0 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e } as unknown as MergeTrialRun;
    },
  } as unknown as MergeWriterReads;
  return { reads, trials };
}

const runIdOf = (line: string | undefined) => line?.split(' ')[2] ?? '';

test('e2e:app-test-environments — a declared environment is provisioned from the trusted base for the exact commit, its URL reaches the case, down gets the same identity, and local cases are unchanged', async () => {
  const fx = await fixture();
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const { reads, trials } = await readsFor(fx, fx.lifecycle());
  const ports = batchGatePorts({ ...reads, git: reads.git! }, [], () => fx.base);
  const failed = await ports.run(fx.candidate, ['e2e:staged-app', 'e2e:local-app', 'e2e:ghost-app', 'e2e:preview-app'], [], 120_000);

  assert.deepEqual(failed, ['e2e:ghost-app'], 'only the case naming an undeclared environment fails: a configuration error, named');
  const [up, down, ...rest] = await fx.calls();
  assert.equal(rest.length, 0, 'one up and one down');
  assert.match(up!, new RegExp(`^up ${fx.candidate} gy-[0-9a-f-]{36} base$`), 'up runs the trusted base script and receives the exact requested commit and a unique run id');
  assert.equal(down, `down ${fx.candidate} ${runIdOf(up)} inst-${runIdOf(up)}`, 'down receives the same commit, run id and the instance up printed');
  assert.ok(fx.app.hits >= 1, 'the case reached the app at the URL up printed');
  const trial = trials[0]!;
  assert.deepEqual((trial.item as { environments: Record<string, string> }).environments, { 'staged-app': fx.url }, 'the provisioned URL is handed to its case alone');
  assert.deepEqual(trial.groups, [{ target: 'environment', origin: fx.url, proofs: ['e2e:staged-app'] }, { target: 'serve', origin: undefined, proofs: ['e2e:local-app'] }], 'an undeclared case still runs on local through the trial\'s own serve');
  assert.ok(!JSON.stringify(trial.item).includes('preview-app'), 'a case naming an environment only the candidate declares waits for that declaration to be verified');

  // AC-2: the candidate's rewritten lifecycle never ran; the secret reached no candidate path, record or log.
  assert.ok(!existsSync(join(fx.provider, 'leaked')), 'the candidate\'s up script never executed');
  for (const [what, text] of [['trial input', JSON.stringify(trials)], ['state file', await readFile(fx.stateFile, 'utf8')], ['loop log', fx.lines.join('\n')]] as const)
    assert.ok(!text.includes(sentinel), `the install secret is absent from the ${what}`);
  const state = JSON.parse(await readFile(fx.stateFile, 'utf8'));
  assert.deepEqual(state.instances, [], 'the torn-down instance no longer counts');
  assert.equal(state.runs.staging.outcome, 'passed');
  assert.equal(state.runs.staging.commit, fx.candidate);
  assert.equal(state.runs.staging.url, '[redacted]', 'a URL made of a secrets-file value is redacted in the record, though the case got the real one');
});

test('e2e:app-test-environments — max-concurrent holds across competing gate runs: exhaustion waits, failing and reverting nothing', async () => {
  const fx = await fixture({ maxConcurrent: 1 });
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const { bootstrapGate, runGate } = await import('../src/batch-gate.js');
  const lifecycle = fx.lifecycle();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = await readsFor(fx, lifecycle, held);
  const running = batchGatePorts({ ...first.reads, git: first.reads.git! }, [], () => fx.base).run(fx.candidate, ['e2e:staged-app'], [], 120_000);
  while ((await fx.calls()).length < 1) await new Promise(resolve => setTimeout(resolve, 20));

  // A second gate competes for the one instance while the first holds it.
  const second = await readsFor(fx, lifecycle);
  let reverted = false; const filed: string[] = [];
  const item = { key: 'GY-1', criteria: [{ id: 'AC-1', text: 'staged', proofs: ['e2e:staged-app'] }] } as unknown as Work;
  const ports = { ...batchGatePorts({ ...second.reads, git: second.reads.git! }, [], () => fx.base),
    landings: async () => [{ sha: fx.candidate, before: fx.base, subject: 'Merge GY-1', item }],
    revert: async () => { reverted = true; return { revertSha: 'f'.repeat(40) }; },
    file: async (input: { key: string }) => { filed.push(input.key); return { item: null }; } };
  const record = bootstrapGate('fixture/app', fx.base);
  const outcome = await runGate(ports as never, record);
  assert.equal(outcome.outcome, 'retry', 'capacity exhaustion is an environment wait: the next cycle gates again');
  assert.match((outcome as { reason: string }).reason, /environment staging: waiting for capacity: 1 of 1/);
  assert.equal(reverted, false, 'nothing is reverted');
  assert.deepEqual(filed, [], 'nothing is filed');
  assert.equal(record.held, null, 'the gate is not held');
  assert.equal(record.verified, fx.base, 'nothing is verified or condemned');
  assert.equal((await fx.calls()).filter(line => line.startsWith('up')).length, 1, 'the waiting gate never provisioned');

  release();
  assert.deepEqual(await running, [], 'the first gate finishes');
  const again = await runGate(ports as never, record);
  assert.equal(again.outcome, 'verified', 'with capacity back the queued batch runs and verifies');
});

test('e2e:app-test-environments — a provisioning outage and a teardown failure are environment faults; a real assertion failure stays a test failure', async () => {
  const fx = await fixture({ maxConcurrent: 1 });
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const { EnvironmentFault, readEnvironmentState } = await environments();
  const { reads } = await readsFor(fx, fx.lifecycle());
  const ports = batchGatePorts({ ...reads, git: reads.git! }, [], () => fx.base);
  const run = () => ports.run(fx.candidate, ['e2e:staged-app'], [], 120_000);

  // Provider outage: up fails, the case never runs, the gate gets an environment fault with the secret redacted.
  await writeFile(join(fx.provider, 'outage'), '');
  const outage = await run().then(() => null, error => error);
  assert.ok(outage instanceof EnvironmentFault && outage.kind === 'fault', `an outage is an environment fault: ${outage}`);
  assert.match(outage.message, /environment staging: provisioning failed: .*provider outage for token \[redacted\]/);
  assert.ok(!outage.message.includes(sentinel));
  assert.equal(fx.app.hits, 0, 'no case ran against a failed environment');
  assert.equal(readEnvironmentState(fx.stateFile).runs.staging?.outcome, 'fault');
  assert.deepEqual(readEnvironmentState(fx.stateFile).instances, [], 'whatever up started was torn down');
  // The scheduled diagnostics leave the faulted environment's cases out and run the rest, rather than failing and rerunning the whole suite every cycle.
  const diagnosed = await ports.diagnose(fx.candidate);
  assert.ok(!diagnosed.failed.includes('e2e:staged-app'), 'an outage condemns no case in the diagnostics either');
  assert.ok(diagnosed.failed.includes('e2e:ghost-app'), 'the rest of the catalog still ran and judged');
  await rm(join(fx.provider, 'outage'));

  // Teardown failure: the check's own pass stands; the fault is recorded and the instance stays counted.
  await writeFile(join(fx.provider, 'fail-down'), '');
  assert.deepEqual(await run(), [], 'a teardown failure never fails the check');
  let state = readEnvironmentState(fx.stateFile);
  assert.equal(state.runs.staging?.outcome, 'fault');
  assert.match(state.runs.staging?.detail ?? '', /teardown failed: .*teardown refused for \[redacted\]/);
  assert.equal(state.instances.length, 1, 'an instance down could not remove still counts against the limit');
  const stranded = state.instances[0]!.runId;
  await rm(join(fx.provider, 'fail-down'));

  // A real app failure against a ready environment is the candidate's test failure; the stranded instance is reaped first.
  fx.app.healthy = false;
  assert.deepEqual(await run(), ['e2e:staged-app'], 'an assertion failure against a ready environment is a failed check');
  state = readEnvironmentState(fx.stateFile);
  assert.equal(state.runs.staging?.outcome, 'failed');
  assert.deepEqual(state.instances, []);
  assert.ok((await fx.calls()).some(line => line.startsWith(`down ${fx.candidate} ${stranded} `)), 'the stranded instance was torn down before the next provisioning');
  assert.ok(fx.lines.every(line => !line.includes(sentinel)));
});

/** A deferred made before the run that awaits it: its release exists whenever the body starts, however late. */
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

/** A loop dies with an instance running; the restarted loop reaps it and an unrecorded owned one, keeps its own active instance, and tears it down when done. */
async function restartScenario(exec?: LifecycleExec) {
  const fx = await fixture({ maxConcurrent: 3 });
  const { declaredEnvironments, trustedCheckout, readEnvironmentState } = await environments();
  const definition = declaredEnvironments(git(fx.repo, ['show', `${fx.base}:graphyard.json`])).staging!;
  const cwd = await trustedCheckout(async (args, env) => git(fx.repo, args, env), fx.repo, fx.base);

  // The old loop provisioned an instance and died with it running.
  const crashed = fx.lifecycle(undefined, exec), never = deferred();
  void crashed.use('staging', definition, fx.candidate, cwd, () => never.promise, () => true);
  while (!readEnvironmentState(fx.stateFile).instances[0]?.url) await new Promise(resolve => setTimeout(resolve, 20));
  const leaked = readEnvironmentState(fx.stateFile).instances[0]!.runId;
  // And an owned instance the state file never recorded (the loop died before writing it).
  await writeFile(join(fx.provider, 'instances', 'inst-orphan'), 'gy-orphan');

  // The restarted loop reaps both before it provisions its own instance. Its body may start well
  // after up logs its first line (GY-3359: under load it had not when finish() ran), so the run is
  // released through a deferred that exists before use() is called, never one the body assigns.
  const restarted = fx.lifecycle(undefined, exec), finish = deferred();
  const active = restarted.use('staging', definition, fx.candidate, cwd, () => finish.promise, () => true);
  while ((await fx.calls()).filter(line => line.startsWith('up')).length < 2) await new Promise(resolve => setTimeout(resolve, 20));
  const calls = await fx.calls();
  const mine = runIdOf(calls.filter(line => line.startsWith('up'))[1]);
  const second = calls.findIndex(line => line.startsWith(`up ${fx.candidate} ${mine}`));
  assert.ok(calls.slice(0, second).some(line => line === `down ${fx.candidate} ${leaked} inst-${leaked}`), 'the crashed loop\'s instance is torn down with its own identity');
  assert.ok(calls.slice(0, second).some(line => line === 'down  gy-orphan inst-orphan'), 'the owned instance only list named is torn down');
  // A later reconcile while the restarted loop's instance runs leaves it alone.
  assert.deepEqual(await restarted.reconcile('staging', definition, cwd, { PROVIDER_DIR: fx.provider, PROVIDER_TOKEN: sentinel, APP_URL: fx.url }), [], 'nothing left to reap');
  assert.deepEqual(await readdir(join(fx.provider, 'instances')), [`inst-${mine}`], 'the active instance is preserved');
  assert.deepEqual(readEnvironmentState(fx.stateFile).instances.map(entry => entry.runId), [mine]);
  finish.release(); await active; never.release();
  assert.deepEqual(await readdir(join(fx.provider, 'instances')), [], 'the active run tears down its own instance when done');
}

test('e2e:app-test-environments — after a loop restart, list reaps a leaked owned instance and preserves the active one', () => restartScenario());

test('unit:app-test-environments-pinned — the restart case holds when the restarted run\'s body starts long after up has logged', async () => {
  // The loaded host's timing, made certain: every up returns 300 ms after its script finished, so
  // the body starts after the case has already asserted on the running instance and released it.
  const { shellExec } = await environments();
  await restartScenario(async (command, options) => {
    const out = await shellExec(command, options);
    if (command.includes('up.sh')) await new Promise(resolve => setTimeout(resolve, 300));
    return out;
  });
});

test('e2e:app-test-environments — secrets are 0600 and masked from candidate, worker and reviewer paths; merge trials leave environment cases to the gate', async () => {
  const loose = await fixture({ secretsMode: 0o644 });
  const { batchGatePorts } = await import('../src/daemon/cycle-batch-gate.js');
  const { EnvironmentFault } = await environments();
  const { reads } = await readsFor(loose, loose.lifecycle());
  const refused = await batchGatePorts({ ...reads, git: reads.git! }, [], () => loose.base).run(loose.candidate, ['e2e:staged-app'], [], 60_000).then(() => null, error => error);
  assert.ok(refused instanceof EnvironmentFault, 'a group- or world-readable secrets file is an environment fault');
  assert.match(refused.message, /must be a regular file with mode 0600/);
  assert.deepEqual(await loose.calls(), [], 'nothing ran with a loose secrets file');

  // The secrets live under the install's config home, which every trial child and agent session masks.
  const { trialHiddenPaths } = await import('../src/merge-writer/trial.js');
  const { credentialMaskWords } = await import('../src/master/confinement.js');
  assert.ok(trialHiddenPaths(undefined, { GRAPHYARD_CONFIG_HOME: loose.configHome }).some(path => loose.secretsFile.startsWith(`${path}/`)), 'candidate trial children never read it');
  const words = credentialMaskWords({ configHome: loose.configHome, extraPaths: [], own: [], cli: [] } as never, []);
  assert.ok(words.some((word, index) => word === loose.configHome && words[index - 1] === '--tmpfs'), 'worker and reviewer sessions see an empty config home');

  // A merge trial provisions nothing: a case naming a declared environment is left out for the gate; an undeclared name fails naming the fix.
  const { runTrialE2eCases } = await import('../src/merge-writer/e2e-trial.js');
  const log: string[] = [];
  const cases = await runTrialE2eCases({ worktree: loose.repo, mergeSha: loose.candidate, proofs: ['e2e:staged-app', 'e2e:ghost-app'], env: {}, scratch: loose.home, budgetMs: 10_000,
    holds: async () => true, log: line => log.push(line), runGroup: async () => assert.fail('no group runs') });
  assert.deepEqual(cases.map(entry => [entry.proof, entry.failed]), [['e2e:ghost-app', 1]]);
  assert.match(cases[0]!.failingStep ?? '', /names environment "ghost", which graphyard.json e2e.environments does not declare/);
  assert.ok(log.some(line => /left out e2e:staged-app: it runs in environment staging/.test(line)));
});
