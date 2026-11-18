import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { readRemoteShardRuns, readShardHosts, remoteShardSummary } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { shardHosts, shardRepository, sshdHost } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Real SSH from a user namespace: root-owned system includes look foreign, but the trial's
// generated config still resolves its user alias, port and key and reaches the restricted shim.
test('integration:remote-ssh-confined — shards reach the shim with foreign-owned system includes; a remote failure survives in master status', { timeout: 180_000 }, async () => {
  const image = 'graphyard-trial:confined-ssh';
  const hosts = await shardHosts('remote-ssh-confined', ['loopback'], { [image]: `sha256:${'98f889ed5f9e'.repeat(6).slice(0, 64)}` });
  const server = await sshdHost(hosts.root, hosts.shim, hosts.home('loopback'), join(hosts.root, 'hosts', 'loopback', 'bin'), hosts.bin);
  await writeFile(join(hosts.bin, 'ssh'), '#!/bin/sh\nexec /usr/bin/ssh "$@"\n');
  const home = await temporaryDirectory('remote-ssh-home'), includes = join(home, 'includes');
  await mkdir(join(home, '.ssh')); await mkdir(includes);
  // /etc/passwd is root-owned outside the namespace, hence overflow-owned inside it. SSH must
  // refuse its ownership before trying to parse it as configuration.
  await symlink('/etc/passwd', join(includes, 'foreign.conf'));
  const system = join(home, 'system-config');
  await writeFile(system, 'Include /etc/ssh/ssh_config.d/*.conf\n');
  await writeFile(join(home, '.ssh', 'config'), `Host shard-fixture\n HostName 127.0.0.1\n User ${server.user}\n Port ${server.port}\n IdentityFile ${join(hosts.root, 'sshd', 'client')}\n IdentitiesOnly yes\n StrictHostKeyChecking no\n UserKnownHostsFile /dev/null\n`);
  const wrapper = ['bwrap', '--unshare-user', '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
    '--ro-bind', system, '/etc/ssh/ssh_config', '--ro-bind', includes, '/etc/ssh/ssh_config.d'];
  const files = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts'];
  const fail = join(hosts.root, 'fail');
  const repository = await shardRepository('remote-ssh-confined-repo', files, { 'scripts/tests.mjs': `import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
if (process.cwd().includes('/.graphyard/runs/') && existsSync(${JSON.stringify(fail)})) { console.error('remote fixture: forced shard failure'); process.exit(137); }
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
` });
  const previous = { HOME: process.env.HOME, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE };
  process.env.HOME = home; process.env.GRAPHYARD_TRIAL_IMAGE = image;
  const run: ChildRun = async (program, args, options) => {
    if (program === 'npm') return '';
    if (program === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    return defaultChildRun(program, args, { ...options, wrapper, env: { ...process.env, ...options?.env, HOME: home, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  try {
    await assert.rejects(async () => run('ssh', ['-G', 'localhost']), /Bad owner or permissions/);
    const trial = async () => runTrial({ root: repository.root, base: await temporaryDirectory('remote-ssh-confined-base'), mergeSha: repository.sha,
      changedFiles: files, timeoutMs: 60_000, cores: 2, run, retries: 0,
      remote: { hosts: ['shard-fixture'], read: async targets => (await readShardHosts(targets, run, 2)).map(reading => ({ ...reading, cores: 2, busy: 0, steal: 0, celsius: null })) } });
    const passed = await trial();
    assert.equal(passed.build, 'pass', passed.logTail);
    assert.deepEqual(passed.tests.failed, [], passed.logTail);
    const ready = remoteShardSummary(readRemoteShardRuns(repository.root))!;
    assert.ok(parseInt(ready.shardsRemote) > 0, JSON.stringify(ready));
    assert.equal(ready.hosts.at(-1)!.state, 'ready');
    await writeFile(fail, 'fail');
    const failed = await trial();
    assert.equal(failed.build, 'pass', failed.logTail);
    assert.deepEqual(failed.tests.failed, [], failed.logTail);
    const away = remoteShardSummary(readRemoteShardRuns(repository.root))!.hosts.at(-1)!;
    assert.equal(away.state, 'away');
    assert.match(away.reason ?? '', /remote fixture: forced shard failure/);
    assert.ok(failed.logTail?.includes(away.reason!));
  } finally {
    server.kill();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
