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
  // Exercise the previous config itself, without depending on a new helper that
  // would be missing on the baseline. Everything except cacheDir stays identical.
  const config = await readFile(join(checkout, 'vite.config.ts'), 'utf8');
  await writeFile(join(checkout, 'vite.previous.config.ts'), config.replace(/^.*cacheDir:.*\n/m, ''));
  const script = join(checkout, 'startup.mjs');
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { writeFile, readdir } from 'node:fs/promises';
    import { createServer } from 'vite';
    await assert.rejects(writeFile('node_modules/graphyard-forbidden', 'bad'), { code: 'EROFS' });
    async function start(configFile) {
      let server;
      try {
        server = await createServer({ configFile, configLoader: 'runner',
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
      } finally { await server?.close(); }
    }
    await assert.rejects(start('vite.previous.config.ts'), { code: 'EROFS' });
    await start('vite.config.ts');
    assert.ok((await readdir('.graphyard/vite/deps')).includes('_metadata.json'));
    await start('vite.config.ts');
    console.log('prior config EROFS; cold and warm Vite served client and entry');
  `);
  const output = await defaultChildRun('node', [script], {
    cwd: checkout,
    env: { ...trialEnvironment(), ...trialHomeVariables(allocation), PATH: '/usr/local/bin:/usr/bin:/bin' },
    wrapper: trialContainerWords([allocation], trialContainerDependencies(root)), timeoutMs: 80_000,
  });
  assert.match(output, /prior config EROFS; cold and warm Vite served client and entry/);
});
