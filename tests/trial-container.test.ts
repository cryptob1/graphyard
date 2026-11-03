import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun } from '../src/child-runner.js';
import { confinedSession } from '../src/e2e/steps.js';
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

test('integration:worker-host-filesystem-isolation — a real nested trial preserves linked checkout dependencies without binding onto their symlink', { timeout: 60_000 }, async () => {
  const base = await temporaryDirectory('linked-trial', process.cwd());
  const allocation = await temporaryDirectory('allocation', base);
  const checkout = await temporaryDirectory('checkout', allocation);
  const modules = await temporaryDirectory('installed-modules', base);
  const linked = join(checkout, 'node_modules'), externalAlias = join(base, 'external-modules');
  await writeFile(join(modules, 'fixture.cjs'), 'module.exports = "installed dependency";');
  await symlink(modules, linked);
  await symlink(modules, externalAlias);
  const output = await defaultChildRun('node', ['--import', '/graphyard-harness/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { trialContainerWords } from '/graphyard-harness/src/merge-writer/trial-container.ts';
    const wrapper = trialContainerWords(${JSON.stringify([allocation, checkout])}, ${JSON.stringify([linked, externalAlias])});
    assert.equal(wrapper[0], 'bwrap', 'exercise the real nested private-root backend');
    // Reproduce the old composition first, retaining the exact child diagnostic.
    const old = [...wrapper];
    old.splice(old.indexOf('--remount-ro'), 0, '--ro-bind', ${JSON.stringify(modules)}, ${JSON.stringify(linked)});
    const failed = spawnSync(old[0], [...old.slice(1), 'true'], { encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.ok(failed.stderr.includes('Cannot mount on symlink destination ' + ${JSON.stringify(linked)}), failed.stderr);
    const child = spawnSync(wrapper[0], [...wrapper.slice(1), 'node', '-e', ${JSON.stringify(`
      const fs = require('node:fs'), assert = require('node:assert/strict');
      assert.ok(fs.lstatSync(${JSON.stringify(linked)}).isSymbolicLink());
      assert.equal(fs.readlinkSync(${JSON.stringify(linked)}), ${JSON.stringify(modules)});
      for (const path of ${JSON.stringify([linked, modules, externalAlias])}) {
        assert.equal(require(path + '/fixture.cjs'), 'installed dependency');
        assert.throws(() => fs.writeFileSync(path + '/forbidden', 'bad'), { code: 'EROFS' });
      }
      assert.ok(fs.existsSync('/graphyard-harness/node_modules/tsx/package.json'));
      assert.throws(() => fs.writeFileSync('/graphyard-harness/src/forbidden', 'bad'), { code: 'EROFS' });
      assert.throws(() => fs.writeFileSync('/outside', 'bad'), { code: 'EROFS' });
      fs.writeFileSync('edit', 'allowed');
      fs.writeFileSync(${JSON.stringify(join(allocation, 'profile'))}, 'private');
      fs.writeFileSync('/var/tmp/scratch', 'private');
      console.log('linked nested trial passed');
    `)}], { encoding: 'utf8', cwd: ${JSON.stringify(checkout)} });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    console.log(child.stdout);
  `], { cwd: checkout, wrapper: trialContainerWords([allocation, checkout], [linked, externalAlias]), timeoutMs: 50_000,
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  assert.match(output, /linked nested trial passed/);
  assert.equal(await readFile(join(checkout, 'edit'), 'utf8'), 'allowed');
  assert.equal(await readFile(join(allocation, 'profile'), 'utf8'), 'private');
  assert.equal(existsSync(join(modules, 'forbidden')), false);
});

for (const signal of ['SIGTERM', 'SIGKILL'] as const) test(`integration:worker-home-deletion-regression — ${signal} stops trial background writers before scratch is reclaimed`, async () => {
  const allocation = await temporaryDirectory('cancel-trial', process.cwd());
  const beat = join(allocation, 'heartbeat');
  const [command, ...wrapper] = trialContainerWords([allocation]);
  const child = spawn(command!, [...wrapper, 'node', '-e', `
    require('node:fs').writeFileSync('container-id', require('node:os').hostname());
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
  } finally { child.kill(signal); await closed; }
  await assertWriterStopped(beat);
  if (!existsSync('/etc/graphyard-trial')) {
    const id = await readFile(join(allocation, 'container-id'), 'utf8');
    const deadline = Date.now() + 10_000;
    let removed = false;
    while (Date.now() < deadline && !removed) {
      try { await defaultChildRun('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', id]); }
      catch (error) { assert.match(String(error), /no such/i); removed = true; }
      if (!removed) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(removed, 'the supervisor removed its named container after launcher death');
  }
});

async function assertWriterStopped(beat: string) {
  const deadline = Date.now() + 10_000;
  let stopped = await readFile(beat, 'utf8');
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const next = await readFile(beat, 'utf8');
    if (next === stopped) return;
    stopped = next;
  }
  assert.fail('background writer survived the cancelled boundary');
}

test('integration:worker-home-deletion-regression — output overflow forcibly kills the launcher and removes its running container', { timeout: 30_000 }, async () => {
  const allocation = await temporaryDirectory('overflow-trial', process.cwd());
  const beat = join(allocation, 'heartbeat');
  await assert.rejects(defaultChildRun('node', ['-e', `
    const fs = require('node:fs');
    setInterval(() => { fs.writeFileSync(process.argv[1], String(Date.now())); console.log('x'.repeat(8192)); }, 50);
  `, beat], { cwd: allocation, wrapper: trialContainerWords([allocation]), maxBuffer: 1024, timeoutMs: 20_000,
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' },
  }), /exceeded 1024 bytes/);
  await assertWriterStopped(beat);
});

test('integration:worker-home-deletion-regression — closing an E2E session removes its container and detached writers', { timeout: 30_000 }, async () => {
  const allocation = await temporaryDirectory('session-trial', process.cwd());
  const beat = join(allocation, 'heartbeat');
  const env = { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' };
  const session = confinedSession(trialContainerWords([allocation]), env);
  try {
    const result = await session.run('node', ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e',
        "setInterval(() => require('node:fs').writeFileSync(process.argv[1], String(Date.now())), 50)", process.argv[1]],
        { detached: true, stdio: 'ignore' }).unref();
    `, beat], { cwd: allocation, env, timeoutMs: 20_000, shell: false });
    assert.equal(result.code, 0, result.output);
    const deadline = Date.now() + 5000;
    while (!existsSync(beat) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(beat));
  } finally { await session.close(); }
  await assertWriterStopped(beat);
});

test('integration:worker-home-deletion-regression — real Chromium launches and renders inside the private-root trial image', { timeout: 60_000 }, async () => {
  const allocation = await temporaryDirectory('browser-trial', process.cwd());
  const output = await defaultChildRun('node', ['--input-type=module', '-e', `
    import { chromium } from '/graphyard-harness/node_modules/playwright/index.mjs';
    import assert from 'node:assert/strict';
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<h1>Trial browser works</h1>');
      assert.equal(await page.locator('h1').textContent(), 'Trial browser works');
      await page.screenshot({ path: 'browser.png' });
      console.log('real Chromium rendered');
    } finally { await browser.close(); }
  `], { cwd: allocation, wrapper: trialContainerWords([allocation]), timeoutMs: 50_000,
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation, process.env, true), PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  assert.match(output, /real Chromium rendered/);
  assert.ok((await readFile(join(allocation, 'browser.png'))).length > 100);
});
