import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun } from '../src/child-runner.js';
import { trialContainerWords } from '../src/merge-writer/trial-container.js';
import { trialEnvironment, trialHomeVariables } from '../src/merge-writer/trial.js';

test('integration:worker-host-filesystem-isolation integration:worker-control-socket-isolation — the real outer container excludes host home, unrelated projects and launch sockets while nested sandboxes work', async () => {
  const base = await temporaryDirectory('outer-trial', process.cwd());
  const allocation = join(base, 'allocation'), home = join(base, 'home'), other = join(base, 'project');
  for (const path of [allocation, home, other]) { await mkdir(path); await writeFile(join(path, 'sentinel'), 'protected'); }
  const socket = join(home, 'executor.sock');
  const abstract = '\0graphyard-outer-trial-' + process.pid;
  let reached = 0;
  const servers = [createServer(connection => { reached++; connection.end(); }), createServer(connection => { reached++; connection.end(); })];
  await Promise.all(servers.map((server, index) => new Promise<void>(resolve => server.listen(index ? abstract : socket, resolve))));
  await symlink(socket, join(allocation, 'executor-alias'));
  const namespaces = await Promise.all(['pid', 'net', 'mnt'].map(name => readlink('/proc/self/ns/' + name)));
  // A linked dependency also names its canonical path. Repeated dependencies
  // must not duplicate Docker targets or turn the assigned allocation read-only.
  const alias = join(base, 'linked-allocation');
  await symlink(allocation, alias);
  const wrapper = trialContainerWords([allocation], [allocation, alias, alias]);
  try {
    const output = await defaultChildRun('node', ['-e', `
      const fs = require('node:fs'), assert = require('node:assert/strict'), net = require('node:net');
      const { execFileSync } = require('node:child_process');
      for (const path of ${JSON.stringify([home, other])}) {
        assert.equal(fs.existsSync(path + '/sentinel'), false);
        for (const operation of [() => fs.writeFileSync(path + '/created', 'bad'), () => fs.writeFileSync(path + '/sentinel', 'bad'),
          () => fs.renameSync(path + '/sentinel', path + '/moved'),
          () => fs.renameSync(path + '/sentinel', 'stolen'), () => fs.unlinkSync(path + '/sentinel')]) {
          assert.throws(operation, error => ['EROFS', 'ENOENT', 'EACCES', 'EXDEV'].includes(error.code));
        }
        fs.writeFileSync('source', 'own');
        assert.throws(() => fs.renameSync('source', path + '/sentinel'),
          error => ['EROFS', 'ENOENT', 'EACCES', 'EXDEV'].includes(error.code));
        assert.equal(fs.readFileSync('source', 'utf8'), 'own');
        fs.unlinkSync('source');
      }
      assert.throws(() => fs.writeFileSync('/outside', 'bad'), { code: 'EROFS' });
      assert.equal(fs.existsSync('/var/run/docker.sock'), false);
      assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\n/);
      assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\\s+1/);
      ['pid', 'net', 'mnt'].forEach((name, index) => assert.notEqual(fs.readlinkSync('/proc/self/ns/' + name), ${JSON.stringify(namespaces)}[index]));
      execFileSync('bwrap', ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--bind', process.cwd(), process.cwd(), '--', 'sh', '-ec',
        'echo edit > edit; git init -q; git add edit; git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm edit']);
      execFileSync('sh', ['-c', 'export HOME="$1"; HOME=$(mktemp -d) sh -c true; rm -rf "$HOME"', 'incident', ${JSON.stringify(home)}]);
      Promise.all(${JSON.stringify([socket, abstract, join(allocation, 'executor-alias')])}.map(path => new Promise((resolve, reject) => {
        const socket = net.connect(path); socket.on('connect', () => { socket.destroy(); reject(new Error('host executor reached')); }); socket.on('error', resolve);
      }))).then(() => console.log('private root, nested mounts and socket isolation passed'), error => { console.error(error); process.exitCode = 1; });
    `], { cwd: allocation, env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' }, wrapper, timeoutMs: 60_000 });
    assert.match(output, /socket isolation passed/);
    for (const path of [home, other]) assert.equal(await readFile(join(path, 'sentinel'), 'utf8'), 'protected');
    assert.equal(await readFile(join(allocation, 'edit'), 'utf8'), 'edit\n');
    assert.equal(reached, 0);
  } finally { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
});

test('integration:worker-home-deletion-regression — cancelling a trial stops its background writers before scratch is reclaimed', async () => {
  const allocation = await temporaryDirectory('cancel-trial', process.cwd());
  const beat = join(allocation, 'heartbeat');
  const [command, ...wrapper] = trialContainerWords([allocation]);
  const child = spawn(command!, [...wrapper, 'node', '-e', `
    require('node:child_process').spawn(process.execPath, ['-e',
      "setInterval(() => require('node:fs').writeFileSync(process.argv[1], String(Date.now())), 50)", process.argv[1]],
      { detached: true, stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `, beat], { cwd: allocation, stdio: 'ignore',
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' } });
  const closed = new Promise<void>((resolve, reject) => { child.on('close', () => resolve()); child.on('error', reject); });
  try {
    // Cancel a running writer, rather than racing Docker startup against a short timeout.
    const deadline = Date.now() + 30_000;
    while (!existsSync(beat) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(beat), 'the background writer started before cancellation');
  } finally { child.kill('SIGTERM'); await closed; }
  const stopped = await readFile(beat, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(beat, 'utf8'), stopped, 'no background writer survives the cancelled boundary');
});

