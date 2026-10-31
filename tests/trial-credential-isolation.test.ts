import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { buildStaticSite, groupBuildShell } from '../src/release-project.js';
import { trialConfinement, trialHiddenPaths } from '../src/merge-writer/trial.js';
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
console.log('home read: ' + viaHome + '; absolute read: ' + absolute + '; coordinator read: ' + coordinator);
process.exit([viaHome, absolute, coordinator].some(result => result.startsWith('READ')) ? 1 : 0);
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
  assert.match(trial.logTail, /home read: ENOENT; absolute read: ENOENT; coordinator read: ENOENT/, 'both reads of the key, and the coordinator credential, fail inside the trial');
  assert.deepEqual(trial.tests, { passed: 1, failed: [], files: 1 }, trial.logTail);

  // The push child is not the trial's: it reaches the key and origin admits the merge.
  assert.equal(await reads.push(merged.mergeSha, base), 'pushed');
  assert.equal(readFileSync(authenticated, 'utf8').trim(), key, 'the push authenticated with the deploy key');
  assert.equal(execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), merged.mergeSha);
});

test(`${proof} — a static application's build in the trial runs under the same confinement: it cannot read the deploy key by its absolute path`, async () => {
  const host = await temporaryDirectory('trial-credential-static', tmpdir());
  const key = join(host, '.config', 'graphyard', 'owner-project', 'deploy-key');
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, 'fixture-deploy-key\n', { mode: 0o600 });
  const checkout = await temporaryDirectory('trial-credential-static-checkout', tmpdir());
  const build = `cat ${key}`;
  assert.equal(await buildStaticSite(build, checkout, 30_000, groupBuildShell(30_000), undefined, { PATH: process.env.PATH! }), null, 'unconfined, the build reads the key');
  const confined = await buildStaticSite(build, checkout, 30_000, groupBuildShell(30_000, trialConfinement(trialHiddenPaths(key, { GRAPHYARD_CONFIG_HOME: join(host, '.config', 'graphyard') }), [checkout])), undefined, { PATH: process.env.PATH! });
  assert.match(confined ?? '', /No such file or directory/, 'confined, the key is not there');
});
