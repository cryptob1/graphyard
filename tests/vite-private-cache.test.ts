import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun } from '../src/child-runner.js';
import { trialContainerDependencies, trialContainerWords } from '../src/merge-writer/trial-container.js';
import { trialEnvironment, trialHomeVariables } from '../src/merge-writer/trial.js';

test('integration:vite-private-cache — actual project config starts cold and warm with read-only dependencies; prior config fails on the read-only cache', { timeout: 90_000 }, async () => {
  const root = join(import.meta.dirname, '..');
  const allocation = await temporaryDirectory('vite-trial', root);
  const checkout = await temporaryDirectory('checkout', allocation);
  for (const file of ['vite.config.ts', 'package.json', 'package-lock.json', 'web', 'src', 'README.md', 'docs']) {
    await cp(join(root, file), join(checkout, file), { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'));
  // The previous config kept Vite's cache inside the dependencies tree. A shared install may
  // already hold a node_modules/.vite this lockfile can read without writing, so point the
  // prior config at a cache no run has ever filled: Vite must create it, as on a fresh
  // install. Everything except cacheDir stays identical.
  const config = await readFile(join(checkout, 'vite.config.ts'), 'utf8');
  await writeFile(join(checkout, 'vite.previous.config.ts'),
    config.replace(/^(\s*)cacheDir:.*$/m, "$1cacheDir: '../node_modules/.vite-prior-config',"));
  const script = join(checkout, 'startup.mjs');
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { writeFile, readdir } from 'node:fs/promises';
    import { createServer, createLogger } from 'vite';
    // Each startup runs in its own process: Vite's optimizer reruns on a timer after close,
    // and a closed prior-config server's late cache failure must not fail the next startup.
    if (!process.argv[2]) {
      await assert.rejects(writeFile('node_modules/graphyard-forbidden', 'bad'), { code: 'EROFS' });
      const run = configFile => spawnSync(process.execPath, [process.argv[1], configFile], { encoding: 'utf8' });
      const prior = run('vite.previous.config.ts');
      assert.equal(prior.status, 1, 'prior config must fail on the read-only cache, not serve: ' + prior.stdout.slice(-1500) + prior.stderr.slice(-1500));
      assert.match(prior.stdout, /^startup failed (EROFS|EACCES|EPERM|ENOENT)$/m, prior.stdout.slice(-1500) + prior.stderr.slice(-1500));
      for (const attempt of ['cold', 'warm']) {
        const current = run('vite.config.ts');
        assert.equal(current.status, 0, attempt + ': ' + current.stdout.slice(-1500) + current.stderr.slice(-1500));
      }
      assert.ok((await readdir('.graphyard/vite/deps')).includes('_metadata.json'));
      console.log('prior config failed read-only; cold and warm Vite served client and entry');
      process.exit(0);
    }
    // Read-only dependencies surface the failed cache write as a thrown error, a logged
    // error, or an unhandled late rejection; on a fresh install the code is EROFS, or
    // ENOENT naming the cache directory the run tried to create. Any of those proves the
    // prior config cannot hold its cache in the dependencies tree; anything else fails.
    const cachePath = /deps_temp|vite-prior-config/;
    const thrown = value => ['EROFS', 'EACCES', 'EPERM'].includes(value?.code) ||
      (value?.code === 'ENOENT' && cachePath.test(String(value?.message ?? '')));
    const logged = text => /EROFS|EACCES|EPERM/.test(text) || /ENOENT[\\s\\S]{0,200}(?:deps_temp|vite-prior-config)/.test(text);
    let readOnly, server, failure;
    process.on('unhandledRejection', thrown_ => { if (!thrown(thrown_)) { console.error(thrown_); process.exit(3); } readOnly ??= thrown_; });
    const logger = createLogger(), error = logger.error;
    logger.error = (message, options) => { if (!readOnly && typeof message === 'string' && logged(message)) readOnly = message; error(message, options); };
    try {
      server = await createServer({ configFile: process.argv[2], configLoader: 'runner', customLogger: logger,
        server: { host: '127.0.0.1', port: 0 } });
      await server.listen();
      const origin = server.resolvedUrls.local[0];
      for (const [path, content] of [['/', /main.tsx/], ['/@vite/client', /WebSocket/], ['/main.tsx', /react/]]) {
        const response = await fetch(new URL(path, origin));
        assert.equal(response.status, 200, path);
        const body = await response.text();
        assert.match(body, content, path);
        if (path === '/main.tsx') {
          const dependencies = [...body.matchAll(/from "([^"]+\\/deps\\/[^"]+)"/g)];
          assert.ok(dependencies.length, 'entry imports optimized dependencies');
          for (const [, dependency] of dependencies) {
            const optimized = await fetch(new URL(dependency, origin));
            assert.equal(optimized.status, 200, dependency);
            assert.ok((await optimized.text()).length > 0);
          }
        }
      }
    } catch (thrown_) { failure = thrown_; }
    try {
      // Pending import transforms can add watched files after watcher.close(),
      // reopening filesystem handles. Drain Vite's crawl before closing it.
      await server?.waitForRequestsIdle();
      await server?.close();
    } catch (thrown_) { failure ??= thrown_; }
    // A logged cache failure counts only alongside a failed startup: the current config
    // serves fully with a writable cache, and an unrelated failure must not pass as read-only.
    if (thrown(failure) || (readOnly && failure)) {
      console.log('startup failed ' + (thrown(failure) ? failure.code : String(readOnly).match(/EROFS|EACCES|EPERM/)?.[0] ?? 'ENOENT'));
      process.exit(1);
    }
    if (failure) { console.error(failure); process.exit(2); }
    process.exit(0);
  `);
  const output = await defaultChildRun('node', [script], {
    cwd: checkout,
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' },
    wrapper: trialContainerWords([allocation], trialContainerDependencies(root)), timeoutMs: 80_000,
  });
  assert.match(output, /prior config failed read-only; cold and warm Vite served client and entry/);
});
