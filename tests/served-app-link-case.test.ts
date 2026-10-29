import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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

// GY-2976 AC-3, on this head: the served control plane's status read — the master status serving
// block the dashboard uses — returns the serve fields over the API (url, served commit, atMain,
// last failure; null when nothing is declared), and the dashboard page shows the Served line with
// a link when a URL is present. The case itself is e2e/cases/served-app-link.json, run here the
// way the merge trial runs it: against a control plane whose serving root is this checkout, with
// the serve record a served main writes.

test('unit:served-app-link-case — the served head reports the declared serve over the API and the dashboard links it', { timeout: 300_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2978;
  const database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('served-app-link'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  const operator: Principal = { id: 'e2e-operator', role: 'admin' }, token = `trial-${randomUUID()}`;
  let http: ReturnType<typeof server> | null = null, store: Store | null = null;
  // The serve record the case's command step writes lives in this checkout's local .graphyard.
  const written = join(process.cwd(), '.graphyard', 'served.json');
  try {
    await database.initialise(); await database.start(); await database.createDatabase('served_app_link');
    store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/served_app_link`); await store.init();
    const engine = new Engine(store, 120, '');
    http = server(engine, [{ ...operator, token }], null, {});
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http!.address() as { port: number }).port}`;

    const file = 'e2e/cases/served-app-link.json';
    let report: E2eReport | null = null;
    await projectCaseSuite(process.cwd(), token, { cases: [{ file, definition: parseCase(file, readFileSync(join(process.cwd(), file), 'utf8')) }], select: () => true,
      withholdSecrets: true, artifactsDirectory: await temporaryDirectory('served-app-link-artifacts'), signal: AbortSignal.timeout(240_000), report: value => { report = value; } })
      .run(origin, null);
    const outcome = (report as E2eReport | null)?.cases.find(entry => entry.id === 'served-app-link');
    assert.equal(outcome?.verdict, 'passed', JSON.stringify(outcome?.failingStep ?? outcome));
  } finally {
    await rm(written, { force: true });
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
    await database.stop();
  }
});

after(async () => { /* temporaryDirectory's own hook removes the database directories */ });
