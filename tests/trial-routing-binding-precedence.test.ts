import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';

// GY-3145 AC-1: beside a declared e2e.serve, a case delivery.cases binds to an application runs
// against that application, and every unbound case runs against the serve.
test('integration:trial-routing-binding-precedence — a bound case runs against its application beside a declared serve; unbound cases run against the serve', async () => {
  const checkout = await temporaryDirectory('trial-routing-binding', tmpdir());
  const put = (path: string, content: string) => { mkdirSync(dirname(join(checkout, path)), { recursive: true }); writeFileSync(join(checkout, path), content); };
  const serve = { command: 'true', url: 'http://127.0.0.1:4391/healthz?ready', readySeconds: 1 };
  put('graphyard.json', JSON.stringify({
    e2e: { serve },
    delivery: { mode: 'local',
      applications: [{ id: 'app', kind: 'static', directory: 'site', build: null }],
      cases: { 'bound-case': 'app' } },
  }));
  for (const name of ['bound-case', 'smoke', 'create-work-item']) put(`e2e/cases/${name}.json`, '{}');
  const ran: { target: string; proofs: readonly string[] }[] = [];
  const cases = await runTrialE2eCases({
    worktree: checkout, mergeSha: 'a'.repeat(40), proofs: ['e2e:smoke', 'e2e:bound-case', 'e2e:create-work-item'],
    env: {}, scratch: checkout, budgetMs: 60_000, log: () => {},
    holds: async path => existsSync(join(checkout, path)),
    runGroup: async (target, proofs) => {
      ran.push({ target: target.kind === 'command' ? `serve:${target.url}` : `application:${target.id}`, proofs });
      return proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 }));
    },
  });
  assert.deepEqual(ran, [
    { target: `serve:${serve.url}`, proofs: ['e2e:smoke', 'e2e:create-work-item'] },
    { target: 'application:app', proofs: ['e2e:bound-case'] },
  ]);
  assert.ok(cases.every(entry => entry.failed === 0), JSON.stringify(cases));
});
