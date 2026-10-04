import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import {
  browserSuite, cut, deployToUat, gitIn, uatBranch, uatValidationWindowMs, validateAndRecord, type BrowserLauncher, type ReleaseCandidate, type Suite,
} from '../src/release-candidate.js';

// Follow-ups from the review of GY-1094 (GY-1167): UAT is never moved under a running validation,
// and a browser suite drives the UAT deployment itself.

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const remoteRef = (origin: string, ref: string) => { try { return run(origin, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };

/** A bare origin and a working clone of it whose main gains one Graphyard branch merge per call. */
async function repository() {
  const root = await temporaryDirectory('uat-deploy');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  run(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run(work, 'config', key, value);
  run(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  run(work, 'push', '-q', 'origin', 'HEAD:main');
  const merge = (key: string, pr: number) => {
    const branch = `graphyard/${key.toLowerCase()}-1`;
    run(work, 'checkout', '-q', '-b', branch, 'origin/main');
    run(work, 'commit', '-q', '--allow-empty', '-m', `${key} change`);
    run(work, 'checkout', '-q', '--detach', 'origin/main');
    run(work, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${pr} from owner/${branch}`, '-m', `${key}: the change`);
    run(work, 'push', '-q', 'origin', 'HEAD:main');
    run(work, 'fetch', '-q', 'origin');
    return run(work, 'rev-parse', 'HEAD');
  };
  return { origin, work, git: gitIn(work), merge };
}
/** A deployment whose /healthz reports `sha` as the commit it serves. */
const deployment = (sha: string) => ({ fetcher: (async () => new Response(JSON.stringify({ ok: true, revision: 'unknown', commit: sha }))) as typeof fetch });
const someCandidate = (): ReleaseCandidate => ({ id: '20261001T120000Z', sha: 'c'.repeat(40), cutAt: '2026-10-01T12:00:00.000Z', trigger: 'manual', since: null, items: [] });
const recordingSuite = (name: string, passed: boolean, urls: string[]): Suite => ({ name, run: async url => { urls.push(url); return { name, passed, detail: passed ? 'ok' : `${name} failed` }; } });

test('a deploy never moves UAT under another candidate\'s running validation, and is leased on the tip it observed', async () => {
  const repo = await repository();
  const first = repo.merge('GY-51', 501);
  const a = (cut(repo.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any).candidate;
  deployToUat(repo.git, a.id, 'main', new Date('2026-10-01T12:50:00Z'));
  const second = repo.merge('GY-52', 502);
  const b = (cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T13:00:00Z'), push: true }) as any).candidate;

  // A manual deploy while the scheduled run validates A is refused, and UAT keeps serving A.
  assert.throws(() => deployToUat(repo.git, b.id, 'main', new Date('2026-10-01T13:10:00Z')), new RegExp(`UAT serves candidate ${a.id}.*no verdict yet`));
  assert.equal(remoteRef(repo.origin, `refs/heads/${uatBranch}`), first);
  assert.deepEqual(deployToUat(repo.git, a.id, 'main', new Date('2026-10-01T13:10:00Z')), { candidate: a.id, sha: first, branch: uatBranch }, 're-deploying the candidate under validation is a no-op');

  // Once A has a verdict, B deploys.
  await validateAndRecord(repo.git, a.id, 'https://uat.example.test', [recordingSuite('long', true, [])], { base: 'main', push: true, timeoutMs: 0, fetcher: deployment(first).fetcher });
  deployToUat(repo.git, b.id, 'main', new Date('2026-10-01T13:20:00Z'));
  assert.equal(remoteRef(repo.origin, `refs/heads/${uatBranch}`), second);

  // A validation abandoned without a verdict blocks the next deploy only within the window.
  const third = repo.merge('GY-53', 503);
  const c = (cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T14:00:00Z'), push: true }) as any).candidate;
  assert.throws(() => deployToUat(repo.git, c.id, 'main', new Date(Date.parse(b.cutAt) + uatValidationWindowMs - 1)), /no verdict yet/);
  deployToUat(repo.git, c.id, 'main', new Date(Date.parse(b.cutAt) + uatValidationWindowMs));
  assert.equal(remoteRef(repo.origin, `refs/heads/${uatBranch}`), third);

  // The push is leased: a branch moved after it was observed is refused, not overwritten.
  const handMoved = run(repo.work, 'rev-list', '--max-parents=0', 'HEAD');
  const racing = gitIn(repo.work);
  let moved = false;
  const lagging = ((args: string[]) => {
    const out = racing(args);
    if (args[0] === 'ls-remote' && !moved) { moved = true; run(repo.work, 'push', '-q', '--force', 'origin', `${handMoved}:refs/heads/${uatBranch}`); }
    return out;
  });
  assert.throws(() => deployToUat(lagging, b.id, 'main', new Date('2026-10-02T12:00:00Z')), /stale info|rejected/);
  assert.equal(remoteRef(repo.origin, `refs/heads/${uatBranch}`), handMoved);
});

/** A Playwright-shaped browser over a scripted dashboard: what renders, and what the page reports. */
function fakeBrowser(options: { renders?: boolean; pageError?: string; failing?: { url: string; status: number } } = {}) {
  const steps: string[] = []; let closed = false;
  const listeners: Record<string, (value: any) => void> = {};
  const locator = (what: string): any => ({
    click: async () => { steps.push(`click ${what}`); },
    waitFor: async () => { steps.push(`wait ${what}`); if (options.renders === false) throw new Error(`Timeout 60000ms exceeded waiting for ${what}\n  call log`); },
    getByRole: (role: string, named: { name: string }) => locator(`${what} > ${role} ${named.name}`),
  });
  const page: any = {
    on: (event: string, listener: (value: any) => void) => { listeners[event] = listener; },
    goto: async (url: string) => {
      steps.push(`goto ${url}`);
      if (options.pageError) listeners.pageerror(new Error(options.pageError));
      if (options.failing) listeners.response({ url: () => options.failing!.url, status: () => options.failing!.status });
      listeners.response({ url: () => 'https://cdn.example.test/font.css', status: () => 503 });
    },
    getByLabel: (label: string) => ({ fill: async (value: string) => { steps.push(`fill ${label}=${value}`); } }),
    getByRole: (role: string, named: { name: string }) => locator(`${role} ${named.name}`),
  };
  const launcher: BrowserLauncher = { launch: async () => ({ newPage: async () => page, close: async () => { closed = true; } }) };
  return { launcher, steps, closed: () => closed };
}

test('the browser suite signs in to the UAT deployment\'s dashboard and opens the Work view, failing on page errors and server errors', async () => {
  const passing = fakeBrowser();
  const result = await browserSuite('uat-token', passing.launcher).run('https://uat.example.test', someCandidate());
  assert.equal(result.passed, true, result.detail);
  assert.deepEqual(passing.steps, ['goto https://uat.example.test', 'fill Access token=uat-token', 'click button Open control plane', 'wait navigation Primary',
    'click navigation Primary > button Work', 'wait heading Work']);
  assert.ok(passing.closed(), 'the browser is closed');

  const crashed = await browserSuite('uat-token', fakeBrowser({ pageError: 'Cannot read properties of undefined' }).launcher).run('https://uat.example.test', someCandidate());
  assert.equal(crashed.passed, false); assert.match(crashed.detail, /page error: Cannot read properties/);
  const broken = await browserSuite('uat-token', fakeBrowser({ failing: { url: 'https://uat.example.test/api/status', status: 502 } }).launcher).run('https://uat.example.test', someCandidate());
  assert.equal(broken.passed, false); assert.match(broken.detail, /\/api\/status answered 502/);
  assert.doesNotMatch(broken.detail, /font\.css/, 'only the UAT origin\'s answers count');
  const blank = fakeBrowser({ renders: false });
  const unrendered = await browserSuite('uat-token', blank.launcher).run('https://uat.example.test', someCandidate());
  assert.equal(unrendered.passed, false); assert.match(unrendered.detail, /^could not render the primary navigation after sign-in: Timeout 60000ms exceeded waiting for navigation Primary$/);
  assert.ok(blank.closed());

  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /--suite 'browser=node --import tsx --eval "import\(\\"\.\/src\/release-candidate\.ts\\"\)\.then\(m => m\.runBrowserSuite\(\)\)"'/, 'the uat job runs the browser suite against GRAPHYARD_UAT_URL');
});
