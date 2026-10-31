import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { buildStaticSite, groupBuildShell } from '../src/release-project.js';
import { confinedSession } from '../src/e2e/steps.js';
import { trialConfinement, trialHiddenPaths } from '../src/merge-writer/trial.js';
import { runCases } from '../src/e2e/runner.js';
import { parseCase } from '../src/e2e/case.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2997: the merge writer's trial children run the merge's code without reaching the deploy key or
// the coordinator's credentials, by $HOME or by absolute path; the push child still uses the key.

const proof = 'unit:trial-credential-isolation';
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const policy = { mode: 'local', mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fixture' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } };

test(`${proof} — a candidate whose test reads $HOME/.config/graphyard/<install>/deploy-key and the same absolute path finds neither inside the trial, while the merge writer's push authenticates with that key`, { timeout: 300_000 }, async () => {
  // The loop's host: a home whose config home holds the install's deploy key and coordinator credential.
  const host = await temporaryDirectory('trial-credential-host', tmpdir());
  const config = join(host, '.config', 'graphyard'), key = join(config, 'owner-project', 'deploy-key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-deploy-key\n', { mode: 0o600 });
  writeFileSync(join(config, 'coordinator.token'), 'coordinator-secret\n', { mode: 0o600 });

  // The candidate's test reads the key through its own $HOME and by the absolute path, and fails if either answers.
  const root = await temporaryDirectory('trial-credential-repo', tmpdir());
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node test.js' } }));
  write('graphyard.json', JSON.stringify({ delivery: policy }));
  write('test.js', `const fs = require('node:fs'), path = require('node:path');
const read = file => { try { return 'READ ' + fs.readFileSync(file, 'utf8').trim(); } catch (error) { return error.code; } };
const viaHome = read(path.join(process.env.HOME, '.config/graphyard/owner-project/deploy-key'));
const absolute = read(${JSON.stringify(key)});
const coordinator = read(${JSON.stringify(join(config, 'coordinator.token'))});
// Through the merge writer's own mount namespace: its /proc/<pid>/root.
const viaWriter = read(${JSON.stringify(`/proc/${process.pid}/root${key}`)});
console.log('home read: ' + viaHome + '; absolute read: ' + absolute + '; coordinator read: ' + coordinator + '; writer root read: ' + viaWriter);
process.exit([viaHome, absolute, coordinator, viaWriter].some(result => result.startsWith('READ')) ? 1 : 0);
`);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  const base = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach');
  write('src/change.txt', 'head\n');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'head');
  const head = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', 'main');

  // origin is reached over "ssh": a stand-in that admits the push only when -i names a file holding the deploy key.
  const remote = join(await temporaryDirectory('trial-credential-remote', tmpdir()), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', root, remote]);
  gitIn(root, 'remote', 'add', 'origin', `ssh://deploy-host${remote}`);
  const bin = await temporaryDirectory('trial-credential-bin', tmpdir()), authenticated = join(bin, 'authenticated');
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh
key=
while [ $# -gt 1 ]; do case "$1" in -i) key="$2"; shift 2;; -o|-p) shift 2;; -*) shift;; *) shift; break;; esac; done
[ "$(cat "$key" 2>/dev/null)" = fixture-deploy-key ] || { echo "Permission denied (publickey)" >&2; exit 255; }
echo "$key" > ${JSON.stringify(authenticated)}
exec sh -c "$1"
`);
  chmodSync(join(bin, 'ssh'), 0o755);

  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(config, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: key, retrials: 0 } } });
  const environment = { PATH: `${bin}:${process.env.PATH}`, HOME: host, GRAPHYARD_CONFIG_HOME: config };
  // git's own reads get an identity; every other child runs as the trial hands it over.
  const run: ChildRun = (command, args, options) => defaultChildRun(command, args, command === 'git' ? { ...options, env: { ...identity, ...(options?.env ?? process.env) } } : options);
  const reads = mergeWriterReads(master, root, run, { base: await temporaryDirectory('trial-credential-trials', tmpdir()), record: async () => {}, merger: async () => 'control-plane', environment });

  const merged = await reads.merge(head, base);
  assert.ok('mergeSha' in merged, JSON.stringify(merged));
  const work = { id: 'w-2997', key: 'GY-2997', type: 'feature', title: 'isolate the trial', criteria: [{ id: 'AC-1', text: 'no key in the trial', proofs: [proof] }] } as unknown as Work;
  const trial = await reads.trial(merged.mergeSha, merged.files, work, base);
  assert.match(trial.logTail, /home read: ENOENT; absolute read: ENOENT; coordinator read: ENOENT; writer root read: ENOENT/, 'both reads of the key, the coordinator credential and the merge writer\'s /proc root fail inside the trial');
  assert.deepEqual(trial.tests, { passed: 1, failed: [], files: 1 }, trial.logTail);

  // The push child is not the trial's: it reaches the key and origin admits the merge.
  assert.equal(await reads.push(merged.mergeSha, base), 'pushed');
  assert.equal(readFileSync(authenticated, 'utf8').trim(), key, 'the push authenticated with the deploy key');
  assert.equal(execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), merged.mergeSha);
});

test(`${proof} — a static application's build in the trial runs under the same confinement: it cannot read the deploy key by its absolute path or through the merge writer's /proc root`, async () => {
  const host = await temporaryDirectory('trial-credential-static', tmpdir());
  const key = join(host, '.config', 'graphyard', 'owner-project', 'deploy-key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-deploy-key\n', { mode: 0o600 });
  const checkout = await temporaryDirectory('trial-credential-static-checkout', tmpdir());
  const build = `cat ${key} || cat /proc/${process.pid}/root${key}`;
  assert.equal(await buildStaticSite(build, checkout, 30_000, groupBuildShell(30_000), undefined, { PATH: process.env.PATH! }), null, 'unconfined, the build reads the key');
  const confined = await buildStaticSite(build, checkout, 30_000, groupBuildShell(30_000, trialConfinement(trialHiddenPaths(key, { GRAPHYARD_CONFIG_HOME: join(host, '.config', 'graphyard') }), [checkout])), undefined, { PATH: process.env.PATH! });
  assert.match(confined ?? '', new RegExp(`/proc/${process.pid}/root.*No such file or directory`), 'confined, the key is not there, nor through the merge writer\'s /proc root');
  assert.doesNotMatch(confined ?? '', /fixture-deploy-key/);
});

test(`${proof} — an E2E command step in the trial runs under the same confinement: it cannot read the deploy key by its absolute path or through the merge writer's /proc root`, async () => {
  const host = await temporaryDirectory('trial-credential-e2e-cmd', tmpdir());
  const key = join(host, '.config', 'graphyard', 'owner-project', 'deploy-key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-deploy-key\n', { mode: 0o600 });
  const checkout = await temporaryDirectory('trial-credential-e2e-cmd-checkout', tmpdir());
  const probe = `cat ${key} || cat /proc/${process.pid}/root${key}`;
  const env = { PATH: process.env.PATH! };
  const open = await confinedSession().run(probe, [], { cwd: checkout, env, timeoutMs: 30_000, shell: true });
  assert.equal(open.code, 0, 'unconfined, the command step reads the key');
  assert.match(open.output, /fixture-deploy-key/);
  const wrapper = trialConfinement(trialHiddenPaths(key, { GRAPHYARD_CONFIG_HOME: join(host, '.config', 'graphyard') }), [checkout]);
  const session = confinedSession(wrapper);
  try {
    const closed = await session.run(probe, [], { cwd: checkout, env, timeoutMs: 30_000, shell: true });
    assert.notEqual(closed.code, 0, 'confined, the command step cannot read the key');
    assert.match(closed.output, new RegExp(`/proc/${process.pid}/root.*No such file or directory`), 'confined, the key is not there, nor through the merge writer\'s /proc root');
    assert.doesNotMatch(closed.output, /fixture-deploy-key/);
  } finally { await session.close(); }
});

test(`${proof} — a background process one agent-step invocation starts is still alive for the next invocation of the same confined session, and close ends it`, { timeout: 60_000 }, async () => {
  const host = await temporaryDirectory('trial-credential-agent', tmpdir());
  const key = join(host, '.config', 'graphyard', 'owner-project', 'deploy-key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-deploy-key\n', { mode: 0o600 });
  const checkout = await temporaryDirectory('trial-credential-agent-checkout', tmpdir());
  const env = { PATH: process.env.PATH! };
  const wrapper = trialConfinement(trialHiddenPaths(key, { GRAPHYARD_CONFIG_HOME: join(host, '.config', 'graphyard') }), [checkout]);
  // The host is the namespace's PID 1, whose /proc/1/environ every child can read: it carries the
  // caller's credential-free environment, never this process's own.
  process.env.COORDINATOR_SENTINEL = 'coordinator-secret';
  const session = confinedSession(wrapper, { ...env, HOST_SENTINEL: 'trial-env' });
  try {
    // An agent leg's `open` daemonizes a browser that must outlive the invocation: this is that
    // process — a background loop that stamps a heartbeat into the checkout every 0.3 s.
    const open = await session.run('(while :; do date +%s%N > heartbeat; sleep 0.3; done) < /dev/null > /dev/null 2>&1 & echo $! > alive.pid', [], { cwd: checkout, env, timeoutMs: 30_000, shell: true });
    assert.equal(open.code, 0, open.output);
    const next = await session.run(`kill -0 "$(cat alive.pid)" && echo alive; tr '\\0' '\\n' < /proc/1/environ; cat ${JSON.stringify(key)}`, [], { cwd: checkout, env, timeoutMs: 30_000, shell: true });
    assert.match(next.output, /\balive\b/, `the process one invocation started is alive for the next: ${JSON.stringify(next.output)}`);
    assert.match(next.output, /HOST_SENTINEL=trial-env/, 'the host carries the environment the caller handed it');
    assert.doesNotMatch(next.output, /coordinator-secret/, 'the host never carries this process\'s own environment, or /proc/1/environ leaks it');
    assert.doesNotMatch(next.output, /fixture-deploy-key/, 'the masks still hold across the session');
  } finally { await session.close(); delete process.env.COORDINATOR_SENTINEL; }
  // close ends the namespace: the heartbeat stops. A stamp that stands still for a second is a dead process.
  const beat = () => statSync(join(checkout, 'heartbeat')).mtimeMs;
  let last = beat(), still = 0;
  for (let waited = 200; waited < 5_000; waited += 200) {
    await new Promise(accept => setTimeout(accept, 200));
    const now = beat();
    if (now !== last) { last = now; still = 0; } else if ((still += 200) >= 1_000) break;
  }
  assert.ok(still >= 1_000, `close ends the namespace: the background process kept beating for ${still} ms after it`);
});

test(`${proof} — an agent step's leg through one confined session: the browser its open daemonizes is still there for chat and screenshot, the masks still hold, and close ends it`, { timeout: 60_000 }, async () => {
  const host = await temporaryDirectory('trial-credential-agent-leg', tmpdir());
  const key = join(host, '.config', 'graphyard', 'owner-project', 'deploy-key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-deploy-key\n', { mode: 0o600 });
  const checkout = await temporaryDirectory('trial-credential-agent-leg-checkout', tmpdir());
  // A fake agent-browser whose `open` daemonizes a browser (a heartbeat loop, its pid recorded) and
  // whose `chat` and `screenshot` answer PASS only while that process is still alive — the leg's
  // invocations share one `--session`, so each depends on the browser the previous one left.
  const bin = join(checkout, 'bin'), beat = join(checkout, 'beat'), pidFile = join(checkout, 'browser.pid');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agent-browser'), `#!/bin/sh
case "$3" in
  open)
    (while :; do date +%s%N > ${JSON.stringify(beat)}; sleep 0.3; done) < /dev/null > /dev/null 2>&1 &
    echo $! > ${JSON.stringify(pidFile)}
    exit 0 ;;
  chat)
    kill -0 "$(cat ${JSON.stringify(pidFile)})" 2>/dev/null || { echo 'VERDICT: FAIL - the browser open daemonized is gone'; exit 0; }
    cat ${JSON.stringify(key)} > /dev/null 2>&1 && echo 'VERDICT: FAIL - the deploy key was readable'
    echo 'VERDICT: PASS'; exit 0 ;;
  screenshot)
    kill -0 "$(cat ${JSON.stringify(pidFile)})" 2>/dev/null || exit 3
    printf 'png' > "$4"; exit 0 ;;
  close)
    kill "$(cat ${JSON.stringify(pidFile)} 2>/dev/null)" 2>/dev/null; exit 0 ;;
esac
`);
  chmodSync(join(bin, 'agent-browser'), 0o755);
  const wrapper = trialConfinement(trialHiddenPaths(key, { GRAPHYARD_CONFIG_HOME: join(host, '.config', 'graphyard') }), [checkout]);
  const session = confinedSession(wrapper);
  try {
    const file = 'e2e/cases/leg.json';
    const cases = [{ file, definition: parseCase(file, JSON.stringify({ id: 'leg', title: 'One leg', target: 'any', required: false, steps: [{ kind: 'agent', goal: 'Show the change', success: ['The change is shown'], path: '/' }] })) }];
    const report = await runCases(cases, {
      url: 'http://target.test:4310', token: 'leg-token', fetcher: (async () => new Response('{}')) as typeof fetch,
      root: checkout, artifactsDirectory: join(checkout, 'shots'), hostEnvironment: { PATH: `${bin}:${process.env.PATH}` },
      processRunner: session.run,
    });
    const leg = report.cases[0]!;
    assert.equal(leg.outcome, 'pass', JSON.stringify(leg.failingStep));
    const steps = leg.attemptResults[0]!.steps ?? [];
    assert.match(steps[0]!.output.join('\n'), /VERDICT: PASS/, JSON.stringify(steps));
    assert.doesNotMatch(steps[0]!.output.join('\n'), /fixture-deploy-key/, 'the masks hold through the leg');
    assert.deepEqual(steps[0]!.screenshots?.map(shot => shot.endsWith('.png')), [true], 'the screenshot invocation saw the browser too');
  } finally { await session.close(); }
  // close ends the namespace: the daemonized browser stops beating.
  let last = statSync(beat).mtimeMs, still = 0;
  for (let waited = 200; waited < 5_000; waited += 200) {
    await new Promise(accept => setTimeout(accept, 200));
    const now = statSync(beat).mtimeMs;
    if (now !== last) { last = now; still = 0; } else if ((still += 200) >= 1_000) break;
  }
  assert.ok(still >= 1_000, `close ends the namespace: the browser kept beating for ${still} ms after it`);
});
