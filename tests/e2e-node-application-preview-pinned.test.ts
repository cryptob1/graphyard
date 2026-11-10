import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3246: the batch gate's diagnostics run the whole catalog in one trial. A release run shares one
// 1800 s wait budget among its cases, so node-application-preview, about the seventieth of ~135, had
// seconds to wait for a node preview that takes a minute to come up: what was left, split among the
// ~65 cases still to run and halved for its retry. Alone it passes. Here one case whose state turns
// running 15 s after it is first asked has 200 cases after it: a shared budget leaves it ~9 s, and
// the trial's own budget lets it wait as it would alone.

const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });
const freePort = () => new Promise<number>((accept, reject) => {
  const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => accept(port)); });
});

test('unit:e2e-node-application-preview-pinned — a case with a whole catalog after it in one trial waits as its steps declare, not a share of a release run\'s wait budget', { timeout: 120_000 }, async () => {
  const worktree = await temporaryDirectory('catalog-waits'); made.push(worktree);
  const port = await freePort();
  await mkdir(join(worktree, 'e2e/cases'), { recursive: true });
  await writeFile(join(worktree, 'serve.mjs'), `import { createServer } from 'node:http';
let asked = null;
createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/state') { asked ??= Date.now(); return response.end(JSON.stringify({ state: Date.now() - asked >= 15000 ? 'running' : 'starting' })); }
  response.end('{}');
}).listen(${port}, '127.0.0.1');
`);
  await writeFile(join(worktree, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve.mjs', url: `http://127.0.0.1:${port}/`, readySeconds: 20 } } }));
  const quick = Array.from({ length: 200 }, (_, index) => `quick-${String(index).padStart(3, '0')}`);
  for (const id of quick) await writeFile(join(worktree, `e2e/cases/${id}.json`), JSON.stringify({ id, title: `Quick case ${id}`, tags: ['api'], target: 'any', required: false,
    steps: [{ kind: 'http', name: 'answers', method: 'GET', path: '/', status: 200 }] }));
  await writeFile(join(worktree, 'e2e/cases/slow-preview.json'), JSON.stringify({ id: 'slow-preview', title: 'A preview that takes a while comes up', tags: ['api'], target: 'any', required: true,
    steps: [{ kind: 'http', name: 'the preview runs', method: 'GET', path: '/state', status: 200, expect: [{ path: 'state', equals: 'running' }], waitSeconds: 60 }] }));
  const proofs = ['slow-preview', ...quick].map(id => `e2e:${id}`);
  const cases = await runTrialE2eCases({ worktree, mergeSha: 'a'.repeat(40), proofs, env: { PATH: process.env.PATH!, HOME: worktree }, scratch: worktree, budgetMs: 100_000,
    holds: async path => existsSync(join(worktree, path)), log: () => {} });
  assert.equal(cases.filter(entry => entry.failed).length, 0, JSON.stringify(cases.filter(entry => entry.failed)));
  assert.deepEqual(cases.find(entry => entry.case === 'slow-preview'), { proof: 'e2e:slow-preview', case: 'slow-preview', executed: 1, failed: 0 });
});
