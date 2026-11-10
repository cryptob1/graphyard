import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';

// GY-3245: the scheduled full run failed e2e:fixture-node-home. GY-3201 added the case with its node
// application only in the scratch delivery fixture, so this repository bound it to nothing and the
// run served it Graphyard's own e2e.serve, whose page never says "Fixture node app". The repository
// now declares the fixture node application and binds the case to it; its page carries the text.
test('unit:e2e-fixture-node-home-pinned — the repository runs e2e:fixture-node-home against its declared fixture node application, whose page carries the expected text', async () => {
  const worktree = process.cwd();
  const targets: unknown[] = [];
  await runTrialE2eCases({
    worktree, mergeSha: 'a'.repeat(40), proofs: ['e2e:fixture-node-home'], env: {}, scratch: worktree, budgetMs: 1_000,
    holds: async path => existsSync(join(worktree, path)), log: () => {},
    runGroup: async (target, proofs) => { targets.push(target); return proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })); },
  });
  assert.deepEqual(targets, [{ id: 'fixture-node', kind: 'node', directory: 'fixtures/node-app', build: null, start: 'node server.mjs', versionPath: '/api/meta/version' }]);

  const expected = JSON.parse(readFileSync(join(worktree, 'e2e/cases/fixture-node-home.json'), 'utf8')).steps.find((step: { action: string }) => step.action === 'expectText').text;
  const port = await new Promise<number>((accept, reject) => {
    const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => accept(port)); });
  });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: join(worktree, 'fixtures/node-app'), env: { PATH: process.env.PATH, PORT: String(port), GRAPHYARD_PREVIEW_SHA: 'b'.repeat(40) }, stdio: 'ignore' });
  try {
    let page = '';
    for (let attempt = 0; attempt < 50 && !page; attempt += 1) {
      page = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text(), async () => { await new Promise(resolve => setTimeout(resolve, 100)); return ''; });
    }
    assert.ok(page.includes(expected), `the fixture node app's page carries "${expected}": ${page}`);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/meta/version`)).json(), { version: 'b'.repeat(40) });
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
});
