import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun } from '../src/child-runner.js';
import { trialContainerDependencies, trialContainerWords } from '../src/merge-writer/trial-container.js';
import { trialEnvironment, trialHomeVariables } from '../src/merge-writer/trial.js';

test('integration:vite-private-cache — actual project config starts cold and warm with read-only dependencies; prior config fails EROFS', { timeout: 90_000 }, async () => {
  const root = join(import.meta.dirname, '..');
  const allocation = await temporaryDirectory('vite-trial', root);
  const checkout = await temporaryDirectory('checkout', allocation);
  for (const file of ['vite.config.ts', 'package.json', 'package-lock.json', 'web', 'src']) {
    await cp(join(root, file), join(checkout, file), { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'));
  // The previous config kept Vite's cache in node_modules. A shared install may already hold a
  // fresh node_modules/.vite that Vite reads without writing, so give it one no run has filled:
  // Vite must create it, as on a fresh install. Everything except cacheDir stays identical.
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
    // and a closed prior-config server's late EROFS must not land in the next startup.
    if (!process.argv[2]) {
      await assert.rejects(writeFile('node_modules/graphyard-forbidden', 'bad'), { code: 'EROFS' });
      const run = configFile => spawnSync(process.execPath, [process.argv[1], configFile], { encoding: 'utf8' });
      const prior = run('vite.previous.config.ts');
      assert.match(prior.stdout, /^startup failed EROFS$/m, prior.stderr.slice(-1500));
      for (const attempt of ['cold', 'warm']) {
        const current = run('vite.config.ts');
        assert.equal(current.status, 0, attempt + ': ' + current.stderr.slice(-1500));
        assert.ok((await readdir('.graphyard/vite/deps')).includes('_metadata.json'));
      }
      console.log('prior config EROFS; cold and warm Vite served client and entry');
      process.exit(0);
    }
    // Vite logs the failed cache write and serves 504s, throws, or leaves the optimizer's
    // rejection unhandled, so an EROFS it throws, logs or drops counts.
    let readOnly, server, failure;
    process.on('unhandledRejection', thrown => { if (thrown?.code !== 'EROFS') throw thrown; readOnly ??= thrown; });
    const logger = createLogger(), error = logger.error;
    logger.error = (message, options) => { if (/EROFS/.test(message)) readOnly ??= message; error(message, options); };
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
    } catch (thrown) { failure = thrown; }
    try {
      // Pending import transforms can add watched files after watcher.close(),
      // reopening filesystem handles. Drain Vite's crawl before closing it.
      await server?.waitForRequestsIdle();
      await server?.close();
    } catch (thrown) { failure ??= thrown; }
    // A broken optimizer can fail the drain as well: the read-only write is the cause either way.
    if (readOnly || failure?.code === 'EROFS') { console.log('startup failed EROFS'); process.exit(1); }
    if (failure) throw failure;
    process.exit(0);
  `);
  const output = await defaultChildRun('node', [script], {
    cwd: checkout,
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' },
    wrapper: trialContainerWords([allocation], trialContainerDependencies(root)), timeoutMs: 80_000,
  }).catch((failure: { stderr?: string }) => {
    // The orchestrator's assertion leads its stderr and already carries the failed startup's tail.
    assert.fail(String(failure.stderr ?? failure).slice(0, 3000));
  });
  assert.match(output, /prior config EROFS; cold and warm Vite served client and entry/);
});
