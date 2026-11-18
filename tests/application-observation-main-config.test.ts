import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { previewDemand } from '../src/project-previews.js';
import { declaredServe } from '../src/merge-writer/e2e-trial.js';
import { parseProjectDelivery } from '../src/model-boundary/project-applications.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Main's own app row (GY-3434) leads; the declared applications follow it.
const declaredApps = (report: { applications: readonly object[] }) => report.applications.filter((app): app is { id: string; serving: string; main: string; state: string } => 'state' in app);

// GY-3459: master status observes applications as main's graphyard.json declares them, not as a
// coordinator checkout behind origin/main does, and names a declaration that does not parse rather
// than reporting no applications. An externally deployed service (a Go service on Railway) is
// declared with only id, directory and versionUrl: observed, never previewed.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A health endpoint answering the commit it serves as JSON; resolves to its URL. */
const endpoint = (commit: () => string) => new Promise<{ url: string; close(): void }>(resolve => {
  const server = createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ commit: commit() })); }).listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}/healthz`, close: () => server.close() });
  });
});

/** An origin and a coordinator checkout cloned from it; `publish` commits graphyard.json on origin's main and fetches, leaving the checkout behind. */
async function staleCheckout(name: string, checkoutDelivery: unknown) {
  const origin = await temporaryDirectory(`${name}-origin`), checkout = await temporaryDirectory(`${name}-checkout`);
  git(origin, 'init', '-q', '-b', 'main');
  await writeFile(join(origin, 'graphyard.json'), JSON.stringify({ delivery: checkoutDelivery }));
  git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'old declaration');
  git(checkout, 'clone', '-q', origin, '.');
  const publish = async (delivery: unknown, raw?: string) => {
    await writeFile(join(origin, 'graphyard.json'), raw ?? JSON.stringify({ delivery }));
    git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'main declaration');
    git(checkout, 'fetch', '-q', 'origin');
    return git(origin, 'rev-parse', 'HEAD');
  };
  const credentials = await temporaryDirectory(`${name}-credentials`);
  const config = { url: 'http://127.0.0.1:5', repository: 'acme/lumina', credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const run = (command: string, args: string[]) => command === 'git' ? execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : '';
  const status = () => masterStatusReport(checkout, config, async () => ({ work: [], now: new Date().toISOString() }), run);
  return { checkout, publish, status };
}

test('integration:application-observation-main-config — master status observes main\'s declarations, including an observation-only Go service, from a checkout behind origin/main without touching it', async () => {
  let served = '';
  const api = await endpoint(() => served), old = await endpoint(() => 'no-such-commit');
  try {
    const { checkout, publish, status } = await staleCheckout('observation-main', { mode: 'local', applications: [{ id: 'old', kind: 'static', directory: 'site', versionUrl: old.url }] });
    // Main declares an externally deployed Go service: id, directory and versionUrl only.
    const main = await publish({ mode: 'local', applications: [{ id: 'api', directory: 'services/api', versionUrl: api.url }], cases: { 'api-health': 'api' } });
    served = main;
    const head = git(checkout, 'rev-parse', 'HEAD'), file = await readFile(join(checkout, 'graphyard.json'), 'utf8');
    assert.notEqual(head, main, 'the checkout is behind origin/main');

    const report = await status();
    assert.deepEqual(declaredApps(report).map(({ id, serving, state }) => ({ id, serving, state })), [{ id: 'api', serving: main.slice(0, 12), state: 'current' }],
      'main\'s declaration is observed through its versionUrl; the checkout\'s stale "old" app is not');
    assert.equal((report as { applicationsError?: string }).applicationsError, undefined);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), head, 'observation leaves the checkout where it was');
    assert.equal(await readFile(join(checkout, 'graphyard.json'), 'utf8'), file);
    assert.equal(git(checkout, 'status', '--porcelain'), '');

    // Observation-only: never launched as a local preview or served in a trial; local kinds keep previewing.
    const delivery = parseProjectDelivery(git(checkout, 'show', 'origin/main:graphyard.json'));
    assert.deepEqual(delivery.applications, [{ id: 'api', kind: 'external', directory: 'services/api', versionUrl: api.url }]);
    assert.equal(previewDemand({ criteria: [{ proofs: ['e2e:api-health'] }] } as never, delivery), null);
    git(checkout, 'checkout', '-q', 'origin/main');
    assert.deepEqual(declaredServe(checkout).applications, []);
    const local = parseProjectDelivery(JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }, { id: 'api', directory: 'services/api', versionUrl: api.url }], cases: { home: 'site' } } }));
    assert.equal(previewDemand({ criteria: [{ proofs: ['e2e:home'] }] } as never, local)?.application.id, 'site');
    // An observation-only service declares where it answers.
    assert.throws(() => parseProjectDelivery(JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'api', directory: 'services/api' }] } })), /applications\.0\.versionUrl/);
  } finally { api.close(); old.close(); }
});

test('e2e:application-observation-main-config — from a stale checkout, status reports the live commit main\'s application serves, names an invalid declaration, and keeps an empty one empty', async () => {
  let served = '';
  const health = await endpoint(() => served);
  try {
    const { publish, status } = await staleCheckout('observation-e2e', { mode: 'local' });
    served = await publish({ mode: 'local', applications: [{ id: 'lumina', directory: '.', versionUrl: health.url }] });
    const live = await status();
    assert.deepEqual(declaredApps(live).map(({ id, serving, main, state }) => ({ id, serving, main, state })), [{ id: 'lumina', serving: served.slice(0, 12), main: served.slice(0, 12), state: 'current' }]);

    await publish({ mode: 'local', applications: [{ id: 'Lumina', kind: 'static', directory: '/abs', versionUrl: 'ftp://x' }] });
    const invalid = await status();
    assert.deepEqual(declaredApps(invalid), []);
    const error = (invalid as { applicationsError?: string }).applicationsError ?? '';
    for (const field of ['applications.0.id', 'applications.0.directory', 'applications.0.versionUrl']) assert.ok(error.includes(field), `${field} is named: ${error}`);
    assert.ok(invalid.attention.some(item => item.subject === 'delivery.applications' && item.text.includes('applications.0.id')), 'the error is an attention line');

    await publish({ mode: 'local', applications: [] });
    const empty = await status();
    assert.deepEqual(declaredApps(empty), []);
    assert.equal((empty as { applicationsError?: string }).applicationsError, undefined);
    assert.ok(!empty.attention.some(item => item.subject === 'delivery.applications'));
  } finally { health.close(); }
});
