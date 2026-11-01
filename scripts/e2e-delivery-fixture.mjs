// A repository owned entirely by e2e-serve's scratch install. No remote or credential is used.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
