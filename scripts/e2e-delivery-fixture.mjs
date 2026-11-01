// A repository owned entirely by e2e-serve's scratch install. No remote or credential is used.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { defaultChildRun } from '../src/child-runner.ts';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.ts';

export async function deliveryFixture(directory) {
  const root = join(directory, 'repository'), origin = join(directory, 'origin.git');
  await mkdir(join(root, 'src/store'), { recursive: true });
  const git = (...args) => defaultChildRun('git', ['-C', root, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Scratch delivery');
  await git('config', 'user.email', 'delivery@example.invalid');
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, scripts: {
    build: 'node --check src/store/change.mjs', test: 'node --test --test-reporter=tap delivery.test.mjs',
  } }));
  await writeFile(join(root, 'src/store/change.mjs'), 'export const delivered = false;\n');
  await writeFile(join(root, 'delivery.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { delivered } from './src/store/change.mjs';\ntest('unit:scratch-delivery — the submitted change works', () => assert.equal(delivered, true));\n");
  const port = await new Promise((accept, reject) => {
    const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => accept(port));
    });
  });
  await writeFile(join(root, 'serve.mjs'), `import { createServer } from 'node:http';\nimport { delivered } from './src/store/change.mjs';\ncreateServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ delivered })); }).listen(${port}, '127.0.0.1');\n`);
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: {
    command: 'node serve.mjs', url: `http://127.0.0.1:${port}`, readySeconds: 10,
  } } }));
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeFile(join(root, 'e2e/cases/scratch-delivery.json'), JSON.stringify({
    id: 'scratch-delivery', title: 'The submitted change is served', target: 'uat',
    steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'delivered', equals: true }] }],
  }));
  await git('add', '.');
  await git('commit', '-q', '-m', 'Scratch base');
  await defaultChildRun('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  await git('remote', 'add', 'origin', origin);
  // Even fixture setup uses the merge writer's sole transport door.
  const writer = mergeWriterReads({ baseBranch: 'main', repository: 'scratch/delivery', run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } }, root, defaultChildRun, {
    merger: async () => 'control-plane', record: async () => {},
  });
  await writer.push((await git('rev-parse', 'HEAD')).trim(), '0'.repeat(40));
  await writer.fetch();
  return { root, origin };
}
