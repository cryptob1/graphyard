import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
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
// serve record into the control plane it runs against.

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();


test('unit:plain-status-words-case — the Work page shows In review and Live and verified for the seeded items', { timeout: 300_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2988;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('plain-status-words'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  const root = await temporaryDirectory('plain-status-words-root');
  git(['init', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), 'plain status words\n');
  git(['add', '.'], root); git(['commit', '-q', '-m', 'fixture'], root);
  let http: ReturnType<typeof server> | null = null, store: Store | null = null;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  try {
    await database.initialise(); await database.start(); await database.createDatabase('plain_status_words');
    store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/plain_status_words`); await store.init();
    const engine = new Engine(store, 120, '');
    http = server(engine, [{ ...operator, token }], null, {});
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http!.address() as { port: number }).port}`;

    // The case seeds its own items through the database URL scripts/e2e-serve.mjs records, as in the trial.
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard', 'e2e-serve.json'), JSON.stringify({ databaseUrl: `postgres://graphyard:testing-only@127.0.0.1:${port}/plain_status_words` }));
    await symlink(join(process.cwd(), 'scripts'), join(root, 'scripts'));

    const file = 'e2e/cases/plain-status-words.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(root, token, {
      cases: [{ file, definition: parseCase(file, await readFile(join(process.cwd(), file), 'utf8')) }],
      select: () => true, withholdSecrets: true,
      artifactsDirectory: await temporaryDirectory('plain-status-words-artifacts'),
      signal: AbortSignal.timeout(240_000), report: value => { report = value; },
    }).run(origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'plain-status-words');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));
  } finally {
    delete process.env.GRAPHYARD_REPOSITORY_ROOT;
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await database.stop();
  }
});
