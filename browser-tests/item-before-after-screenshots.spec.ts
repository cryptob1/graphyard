import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { trialShotServer } from '../tests/helpers/trial-shot-server';
import { runTrialE2eGroup } from '../src/merge-writer/e2e-trial';
import { commandApplication } from '../src/merge-writer/serve-head';
import { mergeTrialShots } from '../src/merge-writer/executor';

// GY-3267: an item that changes the dashboard shows before and after screenshots of the changed
// page. The merge trial's e2e group runs a fixture browser case — a command step driving a real
// browser, as this repository's Playwright cases do — against the base tip's page and the
// candidate's; the screenshots it keeps ride the trial record of a real submission on a real
// control plane and Postgres, and the item page in the served dashboard shows them side by side.
// An item whose cases drove no browser shows none, and a later trial that kept none clears them.

const identity = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }, (error, stdout) => error ? reject(error) : resolve(String(stdout ?? '').trim())));
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

// The fixture browser case: one command step that opens the served page in a real browser and leaves
// its screenshot where the trial asks (E2E_SCREENSHOTS_DIR), as a Playwright run does.
const browserStep = `node --input-type=module -e "import { chromium } from '@playwright/test'; const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 320, height: 200 } }); await page.goto(process.env.TARGET_URL); await page.screenshot({ path: process.env.E2E_SCREENSHOTS_DIR + '/last.png' }); await browser.close();"`;

/** The trial's e2e group run of the fixture browser case against a page served with `colour`, as the merge trial runs it on one side. */
async function trialRun(worktree: string, colour: string) {
  const page = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(`<body style="background:${colour}">${colour}</body>`); });
  await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  try {
    const env = Object.fromEntries(['PATH', 'HOME', 'PLAYWRIGHT_BROWSERS_PATH'].filter(name => process.env[name]).map(name => [name, process.env[name]!]));
    return await runTrialE2eGroup(commandApplication({ command: 'true', url: origin, readySeconds: 1 }), ['e2e:item-before-after-screenshots'],
      { worktree, mergeSha: sha(colour), proofs: [], env, scratch: join(worktree, `scratch-${colour}`), budgetMs: 120_000, holds: async () => true, log: () => {} }, origin);
  } finally { page.close(); }
}

const call = async (url: string, token: string, path: string, method: 'GET' | 'POST', body?: unknown, key?: string) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} /api/${path} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

/** A fixture repository holding main and one change branch per item, its head the worker submits. */
async function fixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'gy-3267-repo-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'src.ts'), 'export const a = 1;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  const headOn = async (branch: string, change: string) => {
    await git(repo, 'checkout', '-q', '-b', branch, 'main');
    await writeFile(join(repo, 'src.ts'), `export const a = ${change};\n`);
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', `change ${branch}`);
    const head = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'checkout', '-q', 'main');
    return head;
  };
  return { repo, baseTip: await git(repo, 'rev-parse', 'HEAD'), heads: { shots: await headOn('graphyard/gy-3267-a-1', '2'), none: await headOn('graphyard/gy-3267-b-1', '3') } };
}

/** One fixture item submitted as a real worker submits it, with its trial recorded as the merge writer records it. */
async function itemWithTrial(url: string, title: string, proof: string, head: string, baseTip: string, trial: { e2eCase?: string; screenshots?: { case: string; before?: string; after?: string }[] }) {
  const filed = await call(url, 'test-human-operator', 'work', 'POST', { title, type: 'feature', priority: 3, criteria: [{ id: 'AC-1', text: 'The change is proven', proofs: [proof] }] }, `gy-3267-${filedKey(title)}-create`);
  await call(url, 'test-human-operator', `work/${filed.id}/ready`, 'POST', {}, `gy-3267-${filedKey(title)}-ready`);
  const claimed = await call(url, 'test-worker-operator', `work/${filed.id}/claim`, 'POST', {}, `gy-3267-${filedKey(title)}-claim`);
  await call(url, 'test-worker-operator', `work/${filed.id}/workspace`, 'POST', { epoch: claimed.epoch, host: 'machine-a', path: `/tmp/${filed.key}`, branch: `graphyard/${filed.key.toLowerCase()}-1` }, `gy-3267-${filedKey(title)}-workspace`);
  await call(url, 'test-worker-operator', `work/${filed.id}/submit`, 'POST', { epoch: claimed.epoch, head }, `gy-3267-${filedKey(title)}-submit`);
  await call(url, 'test-merge-writer-operator', `work/${filed.id}/merge-record`, 'POST', { kind: 'intent', head, baseTip, mergeSha: sha(`merge-${filed.id}`), risk: 'normal', at: new Date().toISOString() }, `gy-3267-${filedKey(title)}-intent`);
  await recordTrial(url, filed, head, baseTip, proof, trial, 'trial');
  return filed;
}
/** A verdict trial record of `filed`, as the merge writer posts it. */
async function recordTrial(url: string, filed: { id: string }, head: string, baseTip: string, proof: string, trial: { e2eCase?: string; screenshots?: { case: string; before?: string; after?: string }[] }, label: string) {
  await call(url, 'test-merge-writer-operator', `work/${filed.id}/merge-record`, 'POST', { kind: 'trial', head, baseTip, mergeSha: sha(`merge-${filed.id}`), outcome: 'verdict', build: 'pass',
    tests: { passed: 1, failed: [], files: 1 }, files: ['src.ts'], proofs: { [proof]: { executed: 1, failed: 0 } }, durationMs: 100, attempts: [],
    e2e: [{ proof, case: trial.e2eCase ?? proof.slice(4), executed: 1, failed: 0 }], ...(trial.screenshots ? { screenshots: trial.screenshots } : {}) }, `gy-3267-${filed.id}-${label}`);
}
const filedKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

test('e2e:item-before-after-screenshots — the item page shows a browser case\'s before and after screenshots side by side; an item whose trial ran no browser case shows none', async ({ page }) => {
  test.setTimeout(180_000);
  const database = await signInDatabase();
  const { repo, baseTip, heads } = await fixtureRepo();
  const plane = await trialShotServer(database.url, repo);
  // The case's checkout sits inside this repository, so its browser step resolves Playwright from it.
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const cases = await mkdtemp(join(process.cwd(), '.graphyard', 'gy-3267-cases-'));
  try {
    await mkdir(join(cases, 'e2e/cases'), { recursive: true });
    await writeFile(join(cases, 'e2e/cases/item-before-after-screenshots.json'), JSON.stringify({ id: 'item-before-after-screenshots', title: 'The changed page', target: 'any',
      steps: [{ kind: 'command', name: 'open the page in a browser', run: browserStep, timeoutSeconds: 60 }] }));
    // The base tip's run and the candidate's, each keeping the browser case's last screenshot, merged as the trial merges them.
    const after = await trialRun(cases, 'white'), before = await trialRun(cases, 'black');
    expect(after[0]!.screenshot, after[0]!.failingStep ?? '').toBeTruthy();
    expect(before[0]!.screenshot, before[0]!.failingStep ?? '').toBeTruthy();
    const screenshots = mergeTrialShots(mergeTrialShots([], after, 'after'), before, 'before');
    expect(screenshots).toHaveLength(1);
    const withShots = await itemWithTrial(plane.url, 'Shows the changed page before and after', 'e2e:item-before-after-screenshots', heads.shots, baseTip, { screenshots });
    const without = await itemWithTrial(plane.url, 'Shows nothing without a browser case', 'e2e:sign-in', heads.none, baseTip,
      { e2eCase: 'sign-in' });

    // The served dashboard reads the same control plane through the test, as in dashboard-live-new-item.
    await page.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch(pathname.startsWith('/api/') ? { url: plane.url + pathname + search } : {}).catch(() => null);
      if (!response) return route.abort('connectionrefused').catch(() => {});
      await route.fulfill({ response }).catch(() => {});
    });
    const { code } = await (await fetch(`${plane.url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });

    // The item whose trial ran a browser case: its page shows the case's screenshots side by side.
    await page.locator(`[data-row="${withShots.key}"]`).click();
    const shots = page.locator('section[aria-label="Screenshots"]');
    await expect(shots).toBeVisible();
    await expect(shots).toContainText('item-before-after-screenshots');
    await expect(shots.locator('figure', { hasText: 'Before' })).toBeVisible();
    await expect(shots.locator('figure', { hasText: 'After' })).toBeVisible();
    const images = shots.locator('img.artifact-preview');
    await expect(images).toHaveCount(2);
    const loaded = await images.evaluateAll(entries => (entries as HTMLImageElement[]).map(image => [image.naturalWidth, image.currentSrc] as const));
    expect(loaded.length).toBe(2);
    expect(loaded.every(([width]) => width > 0)).toBe(true);
    expect(loaded[0]![1]).not.toBe(loaded[1]![1]);

    // An item whose trial ran no browser case: its page shows no screenshots at all.
    await page.getByRole('button', { name: '← Back' }).click();
    await page.locator(`[data-row="${without.key}"]`).click();
    await expect(page.locator('article.item-page')).toContainText(without.key);
    await expect(page.locator('section[aria-label="Screenshots"]')).toHaveCount(0);

    // A later trial of the first item that kept no screenshot replaces its panel: none is shown.
    await recordTrial(plane.url, withShots, heads.shots, baseTip, 'e2e:item-before-after-screenshots', {}, 'retrial');
    await page.getByRole('button', { name: '← Back' }).click();
    await page.locator(`[data-row="${withShots.key}"]`).click();
    await expect(page.locator('article.item-page')).toContainText(withShots.key);
    await expect(page.locator('section[aria-label="Screenshots"]')).toHaveCount(0);
  } finally {
    await rm(cases, { recursive: true, force: true }).catch(() => {});
    await plane.close();
    await database.close();
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});
