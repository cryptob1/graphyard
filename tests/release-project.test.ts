import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cut, gitIn, readLedger, serveStaticSite, syncLedger } from '../src/release-candidate.js';
import { projectCaseSuite, validateProjectCandidate } from '../src/release-project.js';
import { failingRequiredCases } from '../src/release-revert.js';
import type { E2eLauncher, E2eReport } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1535 AC-3: a managed repository's release candidate runs its own required E2E cases through
 * src/e2e/runner.ts against its UAT, a failing required case fails the candidate and the record
 * names each case's result; a static site's UAT is a loopback server of its build output.
 */
const made: string[] = [];
after(async () => { for (const directory of made) await rm(directory, { recursive: true, force: true }); });
const scratch = async (label: string) => { const directory = await realpath(await temporaryDirectory(label)); made.push(directory); return directory; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

test('unit:candidate-runs-project-cases — every required case of a managed repository runs on its candidate\'s UAT through the runner; a failing required case fails the candidate, the record names each case and feeds the revert, and a static site is driven in a browser on its loopback UAT', { timeout: 120_000 }, async () => {
  const root = await scratch('project-cases');
  const origin = join(root, 'origin.git'), checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  const write = async (path: string, content: unknown) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`); };
  const http = (path: string, expect: unknown[] = []) => ({ kind: 'http', name: `read ${path}`, method: 'GET', path, status: 200, expect });
  // The game's source and the cases the acceptance role merged: home (browser), scores (http), level-two (required, any target), credits (optional).
  await write('site/index.html', '<h1>Play the game</h1>');
  await write('site/scores.json', { best: 42 });
  await write('site/credits.html', '<p>Credits</p>');
  await write('e2e/cases/home.json', { id: 'home', title: 'A player opens the game', tags: ['browser'], target: 'uat', required: true, steps: [{ kind: 'browser', action: 'open', path: '/' }, { kind: 'browser', action: 'expectText', text: 'Play the game' }] });
  await write('e2e/cases/scores.json', { id: 'scores', title: 'A player sees the best score', tags: ['api'], target: 'uat', required: true, steps: [http('/scores.json', [{ path: 'best', type: 'number' }])] });
  await write('e2e/cases/level-two.json', { id: 'level-two', title: 'A player reaches level two', tags: ['api'], target: 'any', required: true, steps: [http('/level-2.json', [{ path: 'level', equals: 2 }])] });
  await write('e2e/cases/credits.json', { id: 'credits', title: 'Credits are listed', tags: ['api'], target: 'uat', required: false, steps: [http('/credits.html')] });
  await write('e2e/cases/unit-only.json', { id: 'unit-only', title: 'Optional and not uat', tags: ['api'], target: 'any', required: false, steps: [http('/never.json')] });
  // The contract binds level two to its customer outcome, so its failure is held per outcome (src/release-holds.ts).
  await write('e2e/contract.json', { outcomes: [{ id: 'progress', title: 'A player progresses', criteria: ['Level two opens'], cases: ['level-two'] }] });
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-q', '-m', 'game and its cases'); git(checkout, 'push', '-q', 'origin', 'main');
  const ledger = gitIn(checkout);
  const filed: { item: any; requestId: string }[] = [];
  const file = async (item: object, requestId: string) => { filed.push({ item, requestId }); return 'GY-901'; };
  const visits: string[] = [];
  let tick = 0;
  const validateTip = async (label: string) => {
    const result = cut(ledger, { base: 'main', trigger: 'manual', now: new Date(Date.parse('2026-10-08T10:00:00Z') + tick++ * 60_000), push: true });
    assert.ok(result.cut, JSON.stringify(result));
    const candidate = result.candidate;
    const tree = join(root, `candidate-${label}`);
    git(checkout, 'worktree', 'add', '-q', '--detach', tree, candidate.sha);
    const run = await validateProjectCandidate(ledger, candidate.id, { checkout: tree, uat: { static: { directory: 'dist', build: 'mkdir -p dist && cp -R site/. dist/' } }, token: '', base: 'main', push: true,
      timeoutMs: 30_000, file, launcher: httpBrowser(visits), stepTimeoutMs: 5_000 });
    return { candidate, run };
  };

  // 1. Level two is missing: its required case fails, so the candidate fails; every required case after it still runs and records its own result.
  const first = await validateTip('one');
  assert.equal(first.run.record.result, 'failed', JSON.stringify(first.run.record.suites));
  assert.equal(first.run.record.deployedSha, first.candidate.sha, 'the verdict is bound to the candidate the loopback UAT served');
  const e2e = first.run.record.e2e!;
  assert.ok(e2e, 'the record keeps the case verdicts');
  assert.equal(e2e.sha, first.candidate.sha);
  assert.deepEqual(Object.fromEntries(e2e.cases.map(entry => [entry.case, entry.verdict])), { credits: 'passed', home: 'passed', 'level-two': 'failed', scores: 'passed' },
    'every required and uat case runs and is named with its result, none left unrun by an earlier failure; an optional non-uat case does not run');
  assert.deepEqual(e2e.blocking, ['level-two']);
  assert.equal(e2e.cases.find(entry => entry.case === 'level-two')!.failingStep!.name, 'read /level-2.json');
  assert.deepEqual(failingRequiredCases(first.run.record).map(entry => entry.case), ['level-two'], 'the failing required case is what the related-item revert reads');
  assert.ok(visits.some(url => url.startsWith('http://127.0.0.1:')), `the browser case drove the loopback UAT: ${visits.join(', ')}`);
  // The failed bound case opens its outcome's hold, filed as one item and recorded as a hold tag through the loop's async git; the hold answers the e2e failure, so no follow-up is filed.
  assert.deepEqual(first.run.record.holds!.map(entry => [entry.kind, entry.outcome, entry.item]), [['open', 'progress', 'GY-901']]);
  assert.equal(first.run.followUp, null);
  assert.equal(filed.length, 1); assert.match(JSON.stringify(filed[0]!.item), /level-two/);
  assert.match(git(origin, 'tag', '--list', 'rc-hold/*'), new RegExp(`rc-hold/progress/${first.candidate.id}`), 'the hold record is pushed beside the candidate');
  // The verdict is the candidate's record, in the ledger every later step reads.
  syncLedger(ledger, 'main');
  assert.equal(readLedger(ledger).uat.find(record => record.id === first.candidate.id)!.result, 'failed');

  // 2. The fix lands: the next candidate runs every required case again and passes.
  await write('site/level-2.json', { level: 2 });
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-q', '-m', 'level two'); git(checkout, 'push', '-q', 'origin', 'main');
  const second = await validateTip('two');
  assert.equal(second.run.record.result, 'passed', JSON.stringify(second.run.record.suites));
  assert.deepEqual(Object.fromEntries(second.run.record.e2e!.cases.map(entry => [entry.case, entry.verdict])), { credits: 'passed', home: 'passed', 'level-two': 'passed', scores: 'passed' });
  assert.deepEqual(second.run.record.e2e!.blocking, []);
  assert.deepEqual(second.run.record.holds!.map(entry => [entry.kind, entry.outcome]), [['clear', 'progress']], 'its bound case passing on the newer candidate clears the hold');

  // 3. A build that fails fails the candidate as its own suite.
  await write('README.md', 'next\n');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-q', '-m', 'readme'); git(checkout, 'push', '-q', 'origin', 'main');
  const broken = cut(ledger, { base: 'main', trigger: 'manual', now: new Date('2026-10-09T10:00:00Z'), push: true });
  assert.ok(broken.cut);
  const tree = join(root, 'candidate-three');
  git(checkout, 'worktree', 'add', '-q', '--detach', tree, broken.candidate.sha);
  const third = await validateProjectCandidate(ledger, broken.candidate.id, { checkout: tree, uat: { static: { directory: 'dist', build: 'exit 3' } }, token: '', base: 'main', push: true, timeoutMs: 30_000, file, launcher: httpBrowser(visits), stepTimeoutMs: 5_000 });
  assert.equal(third.record.result, 'failed');
  assert.deepEqual(third.record.suites.filter(suite => !suite.passed).map(suite => suite.name).sort(), ['build', 'e2e']);

  // The suite alone, against a deployed UAT: every required case (whatever its target) and every uat case, nothing else.
  const deployed = await serveStaticSite(join(tree, 'site'), sha);
  try {
    let report: E2eReport | null = null;
    const result = await projectCaseSuite(tree, 'uat-token', { launcher: httpBrowser([]), stepTimeoutMs: 5_000, report: value => { report = value; } }).run(deployed.url, { id: 'x' } as never);
    assert.equal(result.passed, true, result.detail);
    assert.deepEqual(report!.cases.map(entry => entry.id), ['credits', 'home', 'level-two', 'scores']);
  } finally { await deployed.close(); }
});
