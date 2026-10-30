import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
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
import { readFileSync } from 'node:fs';

// GY-2983 AC-2, on this head: on a served static fixture app with a required case, the dashboard's
// release line names the served commit and 'verified' after the serve pass runs its cases, and
// names the failing case once that case is broken. The case itself is
// e2e/cases/served-app-verified.json, run here the way the merge trial runs it: against a control
// plane whose serving root is a checkout, with the records the pass writes. The serving root is
// this test's own temporary checkout, so the records the case's command steps write are the ones
// this control plane reads.

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('unit:served-app-verified-case — the release line names the served commit verified, and the failing case once that case is broken', { timeout: 300_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2983;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('served-app-verified'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  // The checkout whose serving this control plane reports, and whose .graphyard the case's command
  // steps write the records into: the runner's root is the same checkout, exactly as in a trial.
  const root = await temporaryDirectory('served-app-verified-root');
  git(['init', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'served.txt'), 'the fixture app the record claims is served\n');
  git(['add', '.'], root); git(['commit', '-q', '-m', 'the fixture app'], root);
  const written = join(root, '.graphyard', 'served.json');
  let http: ReturnType<typeof server> | null = null, store: Store | null = null;
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  try {
    await database.initialise(); await database.start(); await database.createDatabase('served_app_verified');
    store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/served_app_verified`); await store.init();
    const engine = new Engine(store, 120, '');
    http = server(engine, [{ ...operator, token }], null, {});
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http!.address() as { port: number }).port}`;

    const file = 'e2e/cases/served-app-verified.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(root, token, { cases: [{ file, definition: parseCase(file, readFileSync(join(process.cwd(), file), 'utf8')) }], select: () => true,
      withholdSecrets: true, artifactsDirectory: await temporaryDirectory('served-app-verified-artifacts'), signal: AbortSignal.timeout(240_000), report: value => { report = value; } })
      .run(origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'served-app-verified');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));
  } finally {
    delete process.env.GRAPHYARD_REPOSITORY_ROOT;
    await rm(written, { force: true });
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await database.stop();
  }
});

after(async () => { /* temporaryDirectory's own hook removes the database directories */ });
