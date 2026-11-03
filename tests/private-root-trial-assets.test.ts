import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChildProcessError, defaultChildRun } from '../src/child-runner.js';
import { trialEnvironment, trialHomeVariables, failureTail } from '../src/merge-writer/trial.js';
import { trialContainerWords } from '../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('integration:private-root-trial-assets — empty HOME reproduces the browser-cache fault, installed Chromium renders and declared Postgres libraries start a real database', { timeout: 90_000 }, async () => {
  const allocation = await temporaryDirectory('trial-assets', process.cwd());
  const home = join(allocation, 'home');
  await mkdir(home);
  const scratch = await temporaryDirectory('scratch', allocation);
  const database = await temporaryDirectory('postgres', allocation);
  const outerScratch = await temporaryDirectory('outer-scratch', '/var/tmp');
  await writeFile(join(outerScratch, 'sentinel'), 'outside this boundary');
  const environment = { ...trialEnvironment(), ...trialHomeVariables(home, process.env, true), TMPDIR: scratch, TMP: scratch, TEMP: scratch, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const wrapper = trialContainerWords([allocation]);
  const emptyCache = join(home, '.cache/ms-playwright');
  // Playwright resolves its registry at import time: reproduce the old environment in a fresh process.
  await assert.rejects(defaultChildRun('node', ['--input-type=module', '-e', `
    import { chromium } from '/graphyard-harness/node_modules/playwright/index.mjs';
    await chromium.launch({ headless: true });
  `], { cwd: allocation, wrapper, timeoutMs: 20_000, env: { ...environment, PLAYWRIGHT_BROWSERS_PATH: emptyCache } }),
  (error: any) => /Executable doesn't exist/.test(error.stderr) && error.stderr.includes(emptyCache));
  const output = await defaultChildRun('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readFile, realpath, lstat, stat, statfs, writeFile, access } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import { createRequire } from 'node:module';
    import { execFileSync } from 'node:child_process';
    import { createServer } from 'node:net';
    import { chromium } from '/graphyard-harness/node_modules/playwright/index.mjs';
    import EmbeddedPostgres from '/graphyard-harness/node_modules/embedded-postgres/dist/index.js';
    import pg from '/graphyard-harness/node_modules/pg/lib/index.js';
    await assert.rejects(access(${JSON.stringify(join(outerScratch, 'sentinel'))}), error => error.code === 'ENOENT');
    assert.match(execFileSync('rg', ['--version'], { encoding: 'utf8' }), /^ripgrep /);
    const varTmp = await stat('/var/tmp');
    assert.equal(varTmp.uid, process.getuid());
    assert.ok(varTmp.mode & 0o1000, 'private durable scratch is sticky');
    assert.notEqual((await statfs('/var/tmp')).type, 0x01021994, 'managed checkout scratch is disk-backed');
    await writeFile('/var/tmp/owned-scratch', 'writable');
    const installed = process.env.PLAYWRIGHT_BROWSERS_PATH;
    assert.equal(installed, '/opt/graphyard-browsers');
    assert.ok(chromium.executablePath().startsWith(installed + '/'));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<h1>Installed pinned browser</h1>');
      assert.equal(await page.locator('h1').textContent(), 'Installed pinned browser');
      await page.screenshot({ path: 'browser.png' });
    } finally { await browser.close(); }
    const require = createRequire('/graphyard-harness/node_modules/embedded-postgres/dist/index.js');
    const packageRoot = dirname(dirname(require.resolve('@embedded-postgres/linux-' + process.arch)));
    const links = JSON.parse(await readFile(join(packageRoot, 'native/pg-symlinks.json'), 'utf8'));
    assert.ok(links.length > 0, 'the installed native package declares library links');
    for (const { source, target } of links) {
      assert.equal((await lstat(join(packageRoot, target))).isSymbolicLink(), true, target);
      assert.equal(await realpath(join(packageRoot, target)), await realpath(join(packageRoot, source)), target);
    }
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const database = new EmbeddedPostgres({ databaseDir: ${JSON.stringify(database)}, user: 'graphyard', password: 'testing-only', port,
      persistent: false, onLog: () => {}, onError: line => console.error(line), postgresFlags: ['-h', '127.0.0.1'] });
    try {
      await database.initialise(); await database.start();
      const client = new pg.Client({ host: '127.0.0.1', port, user: 'graphyard', password: 'testing-only', database: 'postgres' });
      await client.connect();
      try { assert.equal((await client.query('select 3061::integer as value')).rows[0].value, 3061); }
      finally { await client.end(); }
    } finally { await database.stop(); }
    console.log('installed Chromium and native Postgres passed with private HOME and scratch');
  `], { cwd: allocation, wrapper, timeoutMs: 60_000, env: environment });
  assert.match(output, /installed Chromium and native Postgres passed/);
  assert.ok((await readFile(join(allocation, 'browser.png'))).length > 100);
});

test('integration:private-root-trial-assets — bounded failure diagnostics retain the test and first child error before long stacks', () => {
  const output = '$ node tests/child.test.ts\n✖ failing tests:\n\ntest at tests/child.test.ts:12:1\n✖ child launches installed assets\n  Error: Executable does not exist in allocated-home cache\n' + '    at child (runner.ts:1:1)\n'.repeat(1000) + '\n[exit 1]\n';
  const diagnostic = failureTail([output], 1000);
  assert.ok(diagnostic.length <= 1000);
  assert.match(diagnostic, /test at tests\/child.test.ts:12:1/);
  assert.match(diagnostic, /child launches installed assets/);
  assert.match(diagnostic, /Executable does not exist in allocated-home cache/);
  assert.match(diagnostic, /\[exit 1\]/);
});

test('integration:private-root-trial-assets — a raw child startup error survives a long trailing stack', () => {
  const output = 'AssertionError [ERR_ASSERTION]: installed browser path differs\n' + '    at child (runner.ts:1:1)\n'.repeat(1000) + '\n[exit status 1]\n';
  const diagnostic = failureTail([output], 1000);
  assert.ok(diagnostic.length <= 1000);
  assert.match(diagnostic, /AssertionError \[ERR_ASSERTION\]: installed browser path differs/);
  assert.match(diagnostic, /\[exit status 1\]/);
});

test('integration:private-root-trial-assets — multiple long child commands retain each stderr and assertion in bounded reporter output', async () => {
  const directory = await temporaryDirectory('failure-reporter');
  const fixture = join(directory, 'failures.mjs');
  const runner = new URL('../src/child-runner.ts', import.meta.url).href;
  await writeFile(fixture, `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import { defaultChildRun } from ${JSON.stringify(runner)};
    for (const [name, message] of [
      ['installed browser', 'browserType.launch: Executable does not exist in allocated-home cache'],
      ['native Postgres', 'initdb: error: could not load library libicui18n.so.77']
    ]) test(name, async () => {
      const source = '// long inline asset setup\\n'.repeat(200) +
        'process.stderr.write(' + JSON.stringify(message + '\\n') + '); process.exit(1);';
      await defaultChildRun(process.execPath, ['-e', source]);
    });
    test('owned scratch assertion', () => {
      assert.equal('wrong owner', 'allocated owner', 'scratch must belong to the allocation');
    });
  `);
  let output = '';
  await assert.rejects(defaultChildRun(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', fixture], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, FORCE_COLOR: '0', NODE_DISABLE_COLORS: '1' },
  }), (error: unknown) => {
    assert.ok(error instanceof ChildProcessError);
    assert.equal(error.status, 1);
    output = error.stdout;
    return true;
  });
  assert.ok(output.length > 20_000, 'the real reporter includes long invocations and inspected args');
  for (const outputs of [[output], [output, output]]) {
    const diagnostic = failureTail(outputs);
    assert.ok(diagnostic.length <= 4000);
    assert.equal(diagnostic.match(/test at /g)?.length, 3 * outputs.length);
    for (const name of ['installed browser', 'native Postgres', 'owned scratch assertion']) assert.ok(diagnostic.includes(name), name);
    for (const message of ['browserType.launch: Executable does not exist', 'initdb: error: could not load library',
      'scratch must belong to the allocation']) {
      assert.equal(diagnostic.split(message).length - 1, outputs.length, message);
    }
  }
});
