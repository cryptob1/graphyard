import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import { parseCase } from '../src/e2e/case.js';
import { projectCaseSuite } from '../src/release-project.js';
import type { E2eReport } from '../src/e2e/runner.js';

// GY-2988 AC-2 on this head: the Work page shows an item in review as 'In review' and a merged,
// served, verified item as 'Live and verified'. The case itself is e2e/cases/plain-status-words.json,
// run here the way the merge trial runs it: its command step seeds the two items and the verified
// serve record into the control plane it runs against. Cases before it in the catalog merge items of
// their own on the same control plane (delivery-pipeline does), so such a merge lands before each run.

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** An earlier case's delivery: merged moments ago, of another commit than the one served. */
function earlierMerge(n: number) {
  const at = new Date().toISOString(), other = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const candidate = { sha: other, baseSha: other, pr: n, branch: `graphyard/gy-earlier-${n}`, author: 'w', createdAt: at };
  return {
    id: randomUUID(), key: `GY-EARLIER-${n}`, title: 'An earlier case merged this', description: 'Merged by an earlier case.',
    type: 'chore', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, policyRevision: 1, revision: 1, stageEnteredAt: at,
    ready: true, epoch: 1, lease: null, workspaces: [], evidence: [], violations: [], createdAt: at, updatedAt: at,
    stage: 'done', candidate, submission: { epoch: 1, pr: n },
    observation: { candidate, checks: [], reviews: [], protected: true, mergeable: true, merged: true, mergeSha: other, mergedAt: at, files: [], scopeFiles: [], at },
    delivery: { mergeSha: other, mergedAt: at, authorizationRevision: 1, pr: n },
    gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
  };
}

/** Runs the case `runs` times in a row on one control plane, an earlier case's merge landing before each run; each run's verdict. */
async function runCase(runs: number) {
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  const root = await temporaryDirectory('plain-status-words-root');
  git(['init', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), 'plain status words\n');
  git(['add', '.'], root); git(['commit', '-q', '-m', 'fixture'], root);
  let http: ReturnType<typeof server> | null = null, store: Store | null = null;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  try {
    // One database, migrated by the store the case's seed step then writes to, as the trial's
    // e2e-serve runtime hands the case a clone of the migrated template.
    const connection = await databaseUrl('plain-status-words-case');
    store = new Store(connection); await store.init();
    const engine = new Engine(store, 120, '');
    http = server(engine, [{ ...operator, token }], {});
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http!.address() as { port: number }).port}`;

    // The case seeds its own items through the database URL scripts/e2e-serve.mjs records, as in the trial.
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard', 'e2e-serve.json'), JSON.stringify({ databaseUrl: connection }));
    await symlink(join(process.cwd(), 'scripts'), join(root, 'scripts'));

    const file = 'e2e/cases/plain-status-words.json';
    const definition = parseCase(file, await readFile(join(process.cwd(), file), 'utf8'));
    const verdicts: string[] = [];
    for (let n = 1; n <= runs; n++) {
      const pool = new pg.Pool({ connectionString: connection }), earlier = earlierMerge(n);
      try { await pool.query('INSERT INTO work_items(id, document) VALUES($1, $2)', [earlier.id, JSON.stringify(earlier)]); } finally { await pool.end(); }
      let report: E2eReport | null = null;
      await projectCaseSuite(root, token, {
        cases: [{ file, definition }], select: () => true, withholdSecrets: true,
        artifactsDirectory: await temporaryDirectory('plain-status-words-artifacts'),
        signal: AbortSignal.timeout(240_000), report: value => { report = value; },
      }).run(origin, null);
      const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'plain-status-words');
      verdicts.push(outcome?.verdict === 'passed' ? 'passed' : `run ${n}: ${JSON.stringify(outcome?.failingStep ?? outcome)}`);
    }
    return verdicts;
  } finally {
    delete process.env.GRAPHYARD_REPOSITORY_ROOT;
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
  }
}

test('unit:plain-status-words-case — the Work page shows In review and Live and verified for the seeded items', { timeout: 300_000 }, async () => {
  assert.deepEqual(await runCase(1), ['passed']);
});

test('integration:plain-status-words-stable — the case passes 5 runs in a row, other merges landing between them', { timeout: 900_000 }, async () => {
  assert.deepEqual(await runCase(5), Array(5).fill('passed'));
});
