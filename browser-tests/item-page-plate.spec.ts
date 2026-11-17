import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { trialShotServer } from '../tests/helpers/trial-shot-server';

// GY-3392, owner direction 2026-11-15 (kitchen, not factory): an item's page leads with why, the
// evidence from the real app and who acts next — not pipeline mechanics. A real control plane and
// Postgres carry a fixture item whose recorded merge trial kept a browser case's screenshots, and a
// real browser holds the served dashboard open: the page opens on the item's why sentence, then the
// proof screenshot, then one plain line on what changed for the user, then one who-acts-next line —
// with no "What is left" count, no pull request wording, and the gate detail one click down inside a
// collapsed Details block. The case fails on the base tip, which opens on the summary and pipeline
// state instead.

const identity = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }, (error, stdout) => error ? reject(error) : resolve(String(stdout ?? '').trim())));
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

const why = 'Owners judge an item by tasting it, not by reading its pipeline.';
const simplest = 'Reorder what the item page already keeps.';
const summary = 'The item page opens on why, the proof and who acts next.';

/** A small real PNG of one flat colour, so the served screenshot loads as an image in the browser. */
const pngShots = (() => {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const shot = ([r, g, b]: [number, number, number]) => {
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
      return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(24, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
    const rows = Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(24 * 3).fill(0).map((_, i) => [r, g, b][i % 3]!)])));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  };
  return { before: shot([22, 34, 48]), after: shot([64, 160, 96]) };
})();

/** A fixture repository holding main and one change branch, its head the worker submits. */
async function fixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'gy-3392-repo-'));
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'src.ts'), 'export const a = 1;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  await git(repo, 'checkout', '-q', '-b', 'graphyard/gy-3392-1');
  await writeFile(join(repo, 'src.ts'), 'export const a = 2;\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'the plate');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'checkout', '-q', 'main');
  return { repo, baseTip: await git(repo, 'rev-parse', 'HEAD'), head };
}

const call = async (url: string, token: string, path: string, method: 'GET' | 'POST', body?: unknown, key?: string) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} /api/${path} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

test('e2e:item-page-plate — the item page opens on why, the proof screenshot and what changed, then one who-acts-next line; no count, no pull request wording, gate detail one click down; at 1440 and at 390 wide', async ({ page }) => {
  test.setTimeout(180_000);
  const database = await signInDatabase();
  const { repo, baseTip, head } = await fixtureRepo();
  const plane = await trialShotServer(database.url, repo);
  try {
    // One fixture item submitted as a real worker submits it, its recorded trial keeping a browser
    // case's screenshots, as the merge writer records them.
    const filed = await call(plane.url, 'test-human-operator', 'work', 'POST',
      { title: 'Taste a shipped change from its page', type: 'feature', priority: 3, why, simplest, summary,
        criteria: [{ id: 'AC-1', text: 'The page opens on why, the evidence and who acts next', proofs: ['e2e:item-page-plate'] }] }, 'gy-3392-create');
    await call(plane.url, 'test-human-operator', `work/${filed.id}/ready`, 'POST', {}, 'gy-3392-ready');
    const claimed = await call(plane.url, 'test-worker-operator', `work/${filed.id}/claim`, 'POST', {}, 'gy-3392-claim');
    await call(plane.url, 'test-worker-operator', `work/${filed.id}/workspace`, 'POST', { epoch: claimed.epoch, host: 'machine-a', path: `/tmp/${filed.key}`, branch: 'graphyard/gy-3392-1' }, 'gy-3392-workspace');
    await call(plane.url, 'test-worker-operator', `work/${filed.id}/submit`, 'POST', { epoch: claimed.epoch, head }, 'gy-3392-submit');
    await call(plane.url, 'test-merge-writer-operator', `work/${filed.id}/merge-record`, 'POST',
      { kind: 'intent', head, baseTip, mergeSha: sha(`merge-${filed.id}`), risk: 'normal', at: new Date().toISOString() }, 'gy-3392-intent');
    await call(plane.url, 'test-merge-writer-operator', `work/${filed.id}/merge-record`, 'POST',
      { kind: 'trial', head, baseTip, mergeSha: sha(`merge-${filed.id}`), outcome: 'verdict', build: 'pass',
        tests: { passed: 1, failed: [], files: 1 }, files: ['web/pages/work-details.tsx'], proofs: { 'e2e:item-page-plate': { executed: 1, failed: 0 } }, durationMs: 100, attempts: [],
        e2e: [{ proof: 'e2e:item-page-plate', case: 'item-page-plate', executed: 1, failed: 0 }],
        screenshots: [{ case: 'item-page-plate', before: pngShots.before, after: pngShots.after }] }, 'gy-3392-trial');

    // The served dashboard reads the same control plane through the test, as in item-before-after-screenshots.
    await page.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch(pathname.startsWith('/api/') ? { url: plane.url + pathname + search } : {}).catch(() => null);
      if (!response) return route.abort('connectionrefused').catch(() => {});
      await route.fulfill({ response }).catch(() => {});
    });
    const { code } = await (await fetch(`${plane.url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } })).json() as { code: string };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });

    await page.locator(`[data-row="${filed.key}"]`).click();
    const article = page.locator('article.item-page');
    const heading = article.locator('h1[data-why="true"]');
    const shots = article.locator('section[aria-label="Screenshots"]');
    const changed = article.locator('[data-what-changed]');
    const next = article.locator('.next-line');

    // Why first: the item's own why sentence is the page's heading, and everything the proof kept
    // follows it — the screenshot before the what-changed line, and one who-acts-next line after.
    await expect(heading).toHaveText(why, { timeout: 15_000 });
    await expect(shots).toBeVisible();
    await expect(changed).toHaveText(`What changed: ${summary}`);
    await expect(article.locator('[data-simplest]')).toHaveText(`Simplest: ${simplest}`);
    const top = async (locator: typeof heading) => (await locator.boundingBox())!.y;
    expect(await top(heading)).toBeLessThan(await top(shots));
    expect(await top(shots)).toBeLessThan(await top(changed));
    expect(await top(changed)).toBeLessThan(await top(next));

    // The evidence is the proof that ran the real app: both sides load as images, and they differ.
    const images = shots.locator('img.artifact-preview');
    await expect(images).toHaveCount(2);
    const loaded = await images.evaluateAll(entries => (entries as HTMLImageElement[]).map(image => [image.naturalWidth, image.currentSrc] as const));
    expect(loaded.every(([width]) => width > 0)).toBe(true);
    expect(loaded[0]![1]).not.toBe(loaded[1]![1]);

    // One who-acts-next line, no "What is left" count, and no pull request wording anywhere.
    await expect(next).toHaveCount(1);
    await expect(next).toContainText('Who acts next:');
    await expect(article).not.toContainText(/\d+ things?/);
    await expect(article).not.toContainText(/pull request/i);

    // The gate detail sits inside a collapsed Details block: hidden until it is opened.
    const technical = article.locator('details[aria-label="Technical details"]');
    await expect(technical).not.toHaveAttribute('open');
    const gateDetail = technical.locator('[aria-label="What is left"]');
    await expect(gateDetail).toBeHidden();
    await technical.locator('> summary').click();
    await expect(gateDetail).toBeVisible();
    await expect(gateDetail).toContainText('cleared by');

    // The same plate reads on a phone's width (AC-2's live check covers the served release; this
    // holds the layout itself to it).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(heading).toBeVisible();
    await expect(shots).toBeVisible();
    await expect(changed).toBeVisible();
    await expect(next).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
    await plane.close();
    await database.close();
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  }
});
