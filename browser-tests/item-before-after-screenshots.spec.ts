import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { trialShotServer } from '../tests/helpers/trial-shot-server';

// GY-3267: an item that changes the dashboard shows before and after screenshots of the changed
// page. Two fixture items go through real submissions and recorded merge trials on a real control
// plane and Postgres; the one whose trial ran a browser e2e case shows that case's before (base
// tip) and after (candidate) screenshots side by side on its page in the served dashboard, and the
// one whose cases drove no browser shows none.

const identity = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }, (error, stdout) => error ? reject(error) : resolve(String(stdout ?? '').trim())));
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
// Two 1x1 PNGs, one dark and one light, so the case's before and after are told apart by more than their bytes.
const dark = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPIzL8AAAAJAgH/iWAvMQAAAABJRU5ErkJggg==';
const light = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4/5+BgYGBAQAazQdPZAk4AAAAAElFTkSuQmCC';

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
  const mergeSha = sha(`merge-${filed.id}`);
  await call(url, 'test-merge-writer-operator', `work/${filed.id}/merge-record`, 'POST', { kind: 'intent', head, baseTip, mergeSha, risk: 'normal', at: new Date().toISOString() }, `gy-3267-${filedKey(title)}-intent`);
  await call(url, 'test-merge-writer-operator', `work/${filed.id}/merge-record`, 'POST', { kind: 'trial', head, baseTip, mergeSha, outcome: 'verdict', build: 'pass',
    tests: { passed: 1, failed: [], files: 1 }, files: ['src.ts'], proofs: { [proof]: { executed: 1, failed: 0 } }, durationMs: 100, attempts: [],
    e2e: [{ proof, case: trial.e2eCase ?? proof.slice(4), executed: 1, failed: 0 }], ...(trial.screenshots ? { screenshots: trial.screenshots } : {}) }, `gy-3267-${filedKey(title)}-trial`);
  return filed;
}
const filedKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

test('e2e:item-before-after-screenshots — the item page shows a browser case\'s before and after screenshots side by side; an item whose trial ran no browser case shows none', async ({ page }) => {
  test.setTimeout(180_000);
  const database = await signInDatabase();
  const { repo, baseTip, heads } = await fixtureRepo();
  const plane = await trialShotServer(database.url, repo);
  try {
    const withShots = await itemWithTrial(plane.url, 'Shows the changed page before and after', 'e2e:item-before-after-screenshots', heads.shots, baseTip,
      { screenshots: [{ case: 'item-before-after-screenshots', before: dark, after: light }] });
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
  } finally {
    await plane.close();
    await database.close();
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});
