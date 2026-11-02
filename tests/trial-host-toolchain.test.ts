import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChildProcessError, defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialHomeVariables, trialHiddenPaths, trialAttempts, TrialRunnerError } from '../src/merge-writer/trial.js';
import { mergeOne, trialFailureReason, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const identity = { GIT_AUTHOR_NAME: 'Trial', GIT_AUTHOR_EMAIL: 'trial@example.com', GIT_COMMITTER_NAME: 'Trial', GIT_COMMITTER_EMAIL: 'trial@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
async function fixture(build = "console.log('build passed')", lockfile = false) {
  const root = await temporaryDirectory('toolchain-repo');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs', test: 'node -e "console.log(123)"' } }));
  writeFileSync(join(root, 'build.cjs'), build);
  if (lockfile) writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, ...identity }, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, base: await temporaryDirectory('toolchain-trials'), mergeSha: git('rev-parse', 'HEAD'), changedFiles: ['build.cjs'], timeoutMs: 30_000, temporaryRoots: [], checkoutRoots: [], environment: { PATH: process.env.PATH!, HOME: process.env.HOME! } };
}

test('unit:trial-finds-host-toolchain — mise directories follow host HOME/XDG defaults and explicit MISE values win', () => {
  const defaults = trialHomeVariables('/fresh', { HOME: '/host' });
  for (const [kind, suffix] of [['CONFIG', '.config'], ['CACHE', '.cache'], ['DATA', '.local/share'], ['STATE', '.local/state']]) {
    const name = `MISE_${kind}_DIR`;
    assert.equal(defaults[name], `/host/${suffix}/mise`);
    assert.equal(trialHomeVariables('/fresh', { HOME: '/host', [`XDG_${kind}_HOME`]: `/xdg/${kind}` })[name], `/xdg/${kind}/mise`);
    assert.equal(trialHomeVariables('/fresh', { HOME: '/host', [`XDG_${kind}_HOME`]: '/xdg', [name]: '/explicit' })[name], '/explicit');
  }
  assert.equal(defaults.HOME, '/fresh');
  assert.equal(defaults.XDG_CONFIG_HOME, '/fresh/.config');
  assert.equal(defaults.npm_config_cache, '/fresh/.npm');
  assert.equal(defaults.PLAYWRIGHT_BROWSERS_PATH, '/fresh/.cache/ms-playwright');
});

test('unit:trial-finds-host-toolchain — private container toolchain builds with host shims and credentials absent', async () => {
  const host = await temporaryDirectory('toolchain-host');
  const config = join(host, '.config', 'graphyard'), key = join(host, 'key', 'deploy-key'), runtime = join(host, 'runtime');
  for (const directory of [config, join(host, 'key'), runtime]) mkdirSync(directory, { recursive: true });
  const secrets = [join(config, 'credential'), key, join(runtime, 'socket-token')];
  for (const file of secrets) writeFileSync(file, 'private');
  const input = await fixture(`const fs = require('node:fs');
if (process.env.HOME === ${JSON.stringify(host)}) throw Error('host HOME leaked');
if (fs.existsSync(${JSON.stringify(host)})) throw Error('host toolchain directory mounted');
for (const file of ${JSON.stringify(secrets)}) { let readable = false; try { fs.readFileSync(file); readable = true; } catch {} if (readable) throw Error('credential readable: ' + file); }
console.log('confined build passed');`);
  const shims = join(host, 'shims'); mkdirSync(shims);
  // Host shims must not be mounted into the private root; its own toolchain runs instead.
  const npm = realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
  for (const [name, target] of [['npm', `${JSON.stringify(process.execPath)} ${JSON.stringify(npm)}`], ['node', JSON.stringify(process.execPath)]]) {
    writeFileSync(join(shims, name), `#!/bin/sh
for directory in "$MISE_CONFIG_DIR" "$MISE_DATA_DIR" "$MISE_STATE_DIR" "$MISE_CACHE_DIR"; do
  [ -f "$directory/host-marker" ] || { echo 'mise ERROR Config files are not trusted' >&2; exit 1; }
done
exec ${target} "$@"
`);
    chmodSync(join(shims, name), 0o755);
  }
  const environment = { HOME: host, PATH: `${shims}:${process.env.PATH}`, GRAPHYARD_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime };
  const homes = trialHomeVariables('/unused', environment);
  for (const name of ['MISE_CONFIG_DIR', 'MISE_DATA_DIR', 'MISE_STATE_DIR', 'MISE_CACHE_DIR']) {
    mkdirSync(homes[name]!, { recursive: true }); writeFileSync(join(homes[name]!, 'host-marker'), 'present');
  }
  const result = await runTrial({ ...input, environment, hidden: trialHiddenPaths(key, environment) });
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.match(result.logTail, /confined build passed/);
});

for (const phase of ['install', 'build'] as const) test(`unit:trial-build-failure-names-cause — ${phase} startup errors retry as host failures without refusing an item`, async () => {
  const hidden = await temporaryDirectory('toolchain-hidden');
  const input = { ...await fixture(undefined, phase === 'install'), hidden: [hidden] };
  const work = { id: 'work', key: 'GY-3044', candidate: { sha: input.mergeSha }, submission: {}, criteria: [], risk: 'normal' } as unknown as Work;
  for (const diagnostic of [
    'mise ERROR Config files in /host/.config/mise/config.toml are not trusted',
    'mise ERROR No version is set for tool node',
    '/usr/bin/env: ‘node’: No such file or directory',
    "/usr/bin/env: 'npm': No such file or directory",
    '/bin/sh: 1: npm: not found',
    '/bin/bash: line 1: npx: command not found',
    'bwrap: execvp npm: No such file or directory',
  ]) {
    const events: MergeRecordEvent[] = [];
    const invocations: string[][] = [];
    const run: ChildRun = async (command, args, options) => {
      if (command === 'npm') {
        invocations.push(args);
        if (diagnostic === "/usr/bin/env: 'npm': No such file or directory") {
          // The private-root backend starts, then its entrypoint cannot find npm.
          assert.ok(options?.wrapper?.length);
          try {
            await defaultChildRun('/usr/bin/env', ['LC_ALL=C', 'PATH=/missing-toolchain', command, ...args], options);
          } catch (error) {
            assert.ok(error instanceof ChildProcessError);
            assert.equal(error.cause, undefined);
            assert.equal(error.signal, null);
            assert.equal(error.timedOut, false);
            assert.ok(error.status !== null && error.status > 0);
            assert.match(error.stderr, /(?:env:.*npm.*No such file or directory|bwrap: execvp npm: No such file or directory)/);
            throw error;
          }
          assert.fail('the real trial wrapper must fail to exec missing npm');
        }
        throw Object.assign(new Error('cannot start'), { status: diagnostic.includes('mise ERROR') ? 1 : 127, stderr: diagnostic });
      }
      return defaultChildRun(command, args, options);
    };
    const ports: MergePorts = {
      baseBranch: 'main', retrials: 0, now: Date.now, fetch: async () => input.mergeSha,
      merge: async () => ({ mergeSha: input.mergeSha, files: input.changedFiles }),
      trial: async () => ({ ...await runTrial({ ...input, run, retries: 1 }), files: [], proofs: {} }),
      holds: async () => false, push: async () => { throw Error('must not push'); },
      record: async (_work, event) => { events.push(event); },
    };
    await assert.rejects(mergeOne(ports, work), (error: unknown) => {
      assert.ok(error instanceof TrialRunnerError);
      assert.equal(error.phase, phase);
      assert.ok(error.outputTail.includes(diagnostic), error.outputTail);
      assert.deepEqual(trialAttempts(error).map(attempt => attempt.outcome), ['host-failure', 'host-failure']);
      return true;
    }, diagnostic);
    assert.equal(invocations.length, 2);
    assert.ok(invocations.every(args => phase === 'install' ? args[0] === 'ci' : args.join(' ') === 'run build'));
    assert.deepEqual(events.map(event => event.kind), ['intent', 'trial']);
    const last = events.at(-1);
    assert.equal(last?.kind === 'trial' && last.outcome, 'host-failure');
  }
});

test('unit:trial-build-failure-names-cause — a real build failure refuses with bounded output', async () => {
  const work = { id: 'work', key: 'GY-3044', submission: {}, criteria: [], risk: 'normal' } as unknown as Work;
  const broken = await fixture("console.log('earlier output '.repeat(1000)); console.error('Type error: the merge broke the build'); process.exit(1)");
  const result = await runTrial(broken);
  assert.equal(result.build, 'fail');
  const reason = trialFailureReason({ run: result })!;
  assert.match(reason, /^trial failed: build step npm run build\n/);
  assert.match(reason, /Type error: the merge broke the build/);
  assert.ok(reason.length <= 2000);
  const events: MergeRecordEvent[] = [];
  const refused = await mergeOne({
    baseBranch: 'main', retrials: 0, now: Date.now, fetch: async () => broken.mergeSha,
    merge: async () => ({ mergeSha: broken.mergeSha, files: broken.changedFiles }),
    trial: async () => ({ ...result, files: [], proofs: {} }),
    holds: async () => false, push: async () => { throw Error('must not push'); },
    record: async (_work, event) => { events.push(event); },
  }, { ...work, candidate: { ...work.candidate!, sha: broken.mergeSha } });
  assert.equal(refused.outcome, 'refused');
  const refusal = events.at(-1);
  assert.equal(refusal?.kind === 'refused' && refusal.reason, reason);
  // Project dependencies and mise task definitions still fail the merge after npm/node starts.
  for (const diagnostic of [
    ...['tsc', 'node-gyp', 'npm-run-all', 'node-sass'].map(executable => `sh: 1: ${executable}: not found`),
    'mise ERROR task not found: lint',
    'mise ERROR No version is set for tool python',
    'mise ERROR failed to parse task config',
  ]) {
    const missing = await fixture(`console.error(${JSON.stringify(diagnostic)}); process.exit(1)`);
    const missingResult = await runTrial(missing);
    assert.equal(missingResult.build, 'fail', diagnostic);
    const missingEvents: MergeRecordEvent[] = [];
    const missingRefusal = await mergeOne({
      baseBranch: 'main', retrials: 0, now: Date.now, fetch: async () => missing.mergeSha,
      merge: async () => ({ mergeSha: missing.mergeSha, files: missing.changedFiles }),
      trial: async () => ({ ...missingResult, files: [], proofs: {} }),
      holds: async () => false, push: async () => { throw Error('must not push'); },
      record: async (_work, event) => { missingEvents.push(event); },
    }, { ...work, candidate: { ...work.candidate!, sha: missing.mergeSha } });
    assert.equal(missingRefusal.outcome, 'refused', diagnostic);
    const event = missingEvents.at(-1);
    assert.ok(event?.kind === 'refused' && event.reason.includes(diagnostic), diagnostic);
  }
});

test('unit:trial-build-failure-names-cause — a genuine npm ci failure remains a merge failure', async () => {
  const input = await fixture(undefined, true);
  const commands: string[][] = [];
  const run: ChildRun = (command, args, options) => {
    if (command === 'npm') {
      commands.push(args);
      throw Object.assign(new Error('install failed'), { status: 1, stderr: 'npm error code EUSAGE\nnpm error package.json and package-lock.json are not in sync' });
    }
    return defaultChildRun(command, args, options);
  };
  const result = await runTrial({ ...input, run });
  assert.equal(result.build, 'fail');
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'ci');
  assert.match(trialFailureReason({ run: result })!, /package.json and package-lock.json are not in sync/);
});
