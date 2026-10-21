import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStaticSite } from '../src/merge-writer/preview.js';
import { buildStaticSite, projectCaseSuite } from '../src/release-project.js';
import type { E2eLauncher, E2eReport } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1535: a managed repository's own required E2E cases run through src/e2e/runner.ts against a
 * static site's loopback server of its build output, as the merge preview runs them.
 */
const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });
const scratch = async (label: string) => { const directory = await realpath(await temporaryDirectory(label)); made.push(directory); return directory; };
const sha = 'a'.repeat(40);

/** A browser double that drives the static UAT over HTTP: `open` loads the page, `expectText` finds text in what it loaded. */
function httpBrowser(visits: string[]): E2eLauncher {
  return { launch: async () => ({ close: async () => {}, newPage: async () => {
    let body = '';
    const locator = (text: string): any => ({ first: () => locator(text), click: async () => {}, fill: async () => {},
      waitFor: async () => { if (!body.includes(text)) throw new Error(`"${text}" is not on the page`); } });
    return { on: () => {}, close: async () => {}, getByText: (text: string) => locator(text), getByRole: (_role: string, options: { name: string }) => locator(options.name), getByLabel: () => locator(''),
      goto: async (url: string) => { visits.push(url); const response = await fetch(url); if (!response.ok) throw new Error(`${url} answered ${response.status}`); body = await response.text(); } };
  } }) } as unknown as E2eLauncher;
}

test('unit:static-site-uat-server — a static site\'s UAT is a loopback server of its build output: /healthz names the candidate SHA, directories serve index.html, and nothing outside the output is served', async () => {
  const root = await scratch('static-uat');
  const output = join(root, 'dist');
  await mkdir(join(output, 'levels'), { recursive: true });
  await writeFile(join(output, 'index.html'), '<h1>Play the game</h1>');
  await writeFile(join(output, 'game.js'), 'export const start = () => {};');
  await writeFile(join(output, 'levels', 'index.html'), '<p>Level select</p>');
  await writeFile(join(root, 'secret.txt'), 'outside the build output');
  await symlink(join(root, 'secret.txt'), join(output, 'escape.txt'));
  const served = await serveStaticSite(output, sha);
  try {
    assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'served on loopback');
    const health = await fetch(`${served.url}/healthz`);
    assert.deepEqual(await health.json(), { ok: true, commit: sha }, '/healthz names the candidate it serves');
    const home = await fetch(`${served.url}/`);
    assert.equal(home.status, 200); assert.match(home.headers.get('content-type')!, /^text\/html/); assert.equal(await home.text(), '<h1>Play the game</h1>');
    const script = await fetch(`${served.url}/game.js?v=1`);
    assert.match(script.headers.get('content-type')!, /^text\/javascript/); assert.equal(await script.text(), 'export const start = () => {};');
    assert.equal(await (await fetch(`${served.url}/levels/`)).text(), '<p>Level select</p>', 'a directory serves its index.html');
    for (const path of ['/missing.html', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/escape.txt']) assert.equal((await fetch(`${served.url}${path}`)).status, 404, `${path} is not served`);
    assert.equal((await fetch(`${served.url}/`, { method: 'POST', body: '{}' })).status, 405, 'only GET and HEAD are answered');
  } finally { await served.close(); }
  // A build that produced nothing still answers its health, so the candidate fails on its cases rather than on a dead server.
  const empty = await serveStaticSite(join(root, 'never-built'), sha);
  try {
    assert.equal((await (await fetch(`${empty.url}/healthz`)).json()).commit, sha);
    assert.equal((await fetch(`${empty.url}/`)).status, 404);
  } finally { await empty.close(); }
  await assert.rejects(serveStaticSite(output, 'not-a-sha'), /full 40-character commit SHA/);
});

test('unit:project-cases-on-static-site — every required case and every uat case of a checkout runs on its built static site through the runner, each named with its result; a failing build names its command', { timeout: 120_000 }, async () => {
  const checkout = await scratch('project-cases');
  const write = async (path: string, content: unknown) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`); };
  const http = (path: string, expect: unknown[] = []) => ({ kind: 'http', name: `read ${path}`, method: 'GET', path, status: 200, expect });
  await write('site/index.html', '<h1>Play the game</h1>');
  await write('site/scores.json', { best: 42 });
  await write('site/credits.html', '<p>Credits</p>');
  await write('e2e/cases/home.json', { id: 'home', title: 'A player opens the game', tags: ['browser'], target: 'uat', required: true, steps: [{ kind: 'browser', action: 'open', path: '/' }, { kind: 'browser', action: 'expectText', text: 'Play the game' }] });
  await write('e2e/cases/scores.json', { id: 'scores', title: 'A player sees the best score', tags: ['api'], target: 'uat', required: true, steps: [http('/scores.json', [{ path: 'best', type: 'number' }])] });
  await write('e2e/cases/level-two.json', { id: 'level-two', title: 'A player reaches level two', tags: ['api'], target: 'any', required: true, steps: [http('/level-2.json', [{ path: 'level', equals: 2 }])] });
  await write('e2e/cases/credits.json', { id: 'credits', title: 'Credits are listed', tags: ['api'], target: 'uat', required: false, steps: [http('/credits.html')] });
  await write('e2e/cases/unit-only.json', { id: 'unit-only', title: 'Optional and not uat', tags: ['api'], target: 'any', required: false, steps: [http('/never.json')] });
  assert.equal(await buildStaticSite('mkdir -p dist && cp -R site/. dist/', checkout, 30_000), null, 'the build passes');
  assert.match((await buildStaticSite('exit 3', checkout, 30_000))!, /`exit 3` failed/, 'a failing build names its command');
  const visits: string[] = [];
  const served = await serveStaticSite(join(checkout, 'dist'), sha);
  try {
    let report: E2eReport | null = null;
    const result = await projectCaseSuite(checkout, 'uat-token', { launcher: httpBrowser(visits), stepTimeoutMs: 5_000, report: value => { report = value; } }).run(served.url, { id: 'x' });
    assert.equal(result.passed, false, 'the missing level two fails its required case');
    assert.deepEqual(Object.fromEntries(report!.cases.map(entry => [entry.id, entry.verdict])), { credits: 'passed', home: 'passed', 'level-two': 'failed', scores: 'passed' },
      'every required and uat case runs and is named, none left unrun by an earlier failure; an optional non-uat case does not run');
    assert.ok(visits.some(url => url.startsWith('http://127.0.0.1:')), `the browser case drove the loopback site: ${visits.join(', ')}`);
  } finally { await served.close(); }
});
