import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';

// GY-3245: the scheduled full run failed e2e:fixture-node-home. GY-3201 added the case for the
// fixture project's node application, which only the scratch delivery fixture declares; this
// repository binds it to nothing, so the run served it Graphyard's own e2e.serve, whose page never
// says "Fixture node app". Declaring the app here is no fix: the install's serve pass serves the
// first node application graphyard.json declares. The trial leaves an unbound fixture case out,
// and node-application-preview runs it against the fixture's node app.
test('unit:e2e-fixture-node-home-pinned — the trial leaves out e2e:fixture-node-home, which this repository binds to no application, instead of running it against e2e.serve; node-application-preview runs it in the fixture project', async () => {
  const worktree = process.cwd(), groups: { target: unknown; proofs: readonly string[] }[] = [], log: string[] = [];
  const cases = await runTrialE2eCases({
    worktree, mergeSha: 'a'.repeat(40), proofs: ['e2e:fixture-node-home', 'e2e:fixture-static-home'], env: {}, scratch: worktree, budgetMs: 1_000,
    holds: async path => existsSync(join(worktree, path)), log: line => log.push(line),
    runGroup: async (target, proofs) => { groups.push({ target, proofs }); return proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })); },
  });
  assert.deepEqual(groups.map(group => group.proofs), [['e2e:fixture-static-home']], 'the bound fixture case still runs; the unbound one is never served e2e.serve');
  assert.deepEqual(cases.map(entry => entry.proof), ['e2e:fixture-static-home']);
  assert.ok(log.some(line => line.startsWith('left out e2e:fixture-node-home')), log.join('\n'));
  assert.match(readFileSync(join(worktree, 'e2e/cases/node-application-preview.json'), 'utf8'), /"e2e:fixture-node-home"/);
});
