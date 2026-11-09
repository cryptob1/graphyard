// A repository owned entirely by e2e-serve's scratch install. No remote or credential is used.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { defaultChildRun } from '../src/child-runner.ts';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.ts';
import { runMergeTrial } from '../src/merge-writer/executor.ts';

/**
 * The scratch delivery's trial: the real one, every file under `trials`, and no secret scan. The
 * scan's pinned gitleaks binary is a download, and the diagnostics run this case inside a trial
 * whose network is unshared, so the scan could never be had there (GY-3196); the scan has its own tests.
 */
export const scratchTrial = trials => input => runMergeTrial({ ...input, checkoutRoots: [trials], temporaryRoots: [trials], retries: 0, secretScan: false });

export async function deliveryFixture(directory) {
  const root = join(directory, 'repository'), origin = join(directory, 'origin.git');
  await mkdir(join(root, 'src/store'), { recursive: true });
  const git = (...args) => defaultChildRun('git', ['-C', root, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Scratch delivery');
  await git('config', 'user.email', 'delivery@example.invalid');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'scratch-delivery', private: true, scripts: {
    build: 'node --check src/store/change.mjs', test: 'node --test --test-reporter=tap delivery.test.mjs',
  } }));
  // A lockfile without dependencies, so a node application's install is an npm ci that needs no network.
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'scratch-delivery', lockfileVersion: 3, requires: true, packages: { '': { name: 'scratch-delivery' } } }));
  await writeFile(join(root, 'src/store/change.mjs'), 'export const delivered = false;\n');
  await writeFile(join(root, 'delivery.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { delivered } from './src/store/change.mjs';\ntest('unit:scratch-delivery — the submitted change works', () => assert.equal(delivered, true));\n");
  const port = await new Promise((accept, reject) => {
    const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => accept(port));
    });
  });
  await writeFile(join(root, 'serve.mjs'), `import { createServer } from 'node:http';\nimport { delivered } from './src/store/change.mjs';\ncreateServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ delivered })); }).listen(${port}, '127.0.0.1');\n`);
  // GY-3193: the applications the preview cases' items preview, each with its fixture case: a static site whose build shows the change, the runnable Compose application, and a node application.
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public/index.html'), '<!doctype html><title>Fixture static site</title>\n<h1>Fixture static site</h1>\n');
  await writeFile(join(root, 'build.mjs'), 'import { appendFileSync } from "node:fs";\nconst title = process.env.GRAPHYARD_PREVIEW_TITLE;\nif (title) appendFileSync("public/index.html", `<p>${title.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>\\n`);\n');
  await cp('fixtures/preview-compose', join(root, 'compose'), { recursive: true });
  // GY-3201: a node application in its own directory, started on the PORT Graphyard gives it. Its page
  // shows the change's title; a change titled "broken" breaks it, so its bound case fails.
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/server.mjs'), 'import { createServer } from "node:http";\nconst title = (process.env.GRAPHYARD_PREVIEW_TITLE ?? "").replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);\nconst page = /broken/i.test(title) ? "<h1>Out of order</h1>" : `<h1>Fixture node app</h1>\\n<p>${title}</p>`;\ncreateServer((_request, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<!doctype html><title>Node fixture</title>\\n${page}\\n`); }).listen(Number(process.env.PORT), "127.0.0.1");\n');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: {
    command: 'node serve.mjs', url: `http://127.0.0.1:${port}`, readySeconds: 10,
  } }, delivery: { mode: 'local', previews: 'local',
    applications: [{ id: 'site', kind: 'static', directory: 'public', build: 'node build.mjs' }, { id: 'app', kind: 'compose', file: 'compose/compose.yml', service: 'web', port: 8080 },
      { id: 'web', kind: 'node', directory: 'web', build: 'node --check server.mjs', start: 'node server.mjs' }],
    cases: { 'fixture-static-home': 'site', 'fixture-compose-app': 'app', 'fixture-node-home': 'web' } } }));
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  for (const id of ['fixture-static-home', 'fixture-compose-app', 'fixture-node-home']) await cp(`e2e/cases/${id}.json`, join(root, `e2e/cases/${id}.json`));
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
