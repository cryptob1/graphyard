import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { signInProcess } from '../tests/helpers/sign-in-process';

test.use({ reducedMotion: 'no-preference' });
test('e2e:work-replay — recorded stages, windows, playback and motion preferences on a fixture install', async ({ page }) => {
  const store = await withDatabase('work_replay'); await store.init();
  const http = await signInProcess((store.pool as any).options.connectionString);
  const end = Date.now(), hour = 3_600_000;
  try {
    const create = async (title: string) => {
      const item = { id: randomUUID(), key: '', title, type: 'feature', stage: 'ready', createdAt: new Date(end - 80 * hour).toISOString(), updatedAt: new Date(end).toISOString(), stageEnteredAt: new Date(end).toISOString(), revision: 1, policyRevision: 1, priority: 2, ready: true, epoch: 0, lease: null, criteria: [], dependencies: [], policy: { review: true, checks: [] }, workspaces: [], scenarioRequirements: [], evidence: [], gates: [], violations: [], sessions: [], implementers: [] };
      const inserted = await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2) RETURNING number', [item.id, JSON.stringify(item)]);
      item.key = `GY-${inserted.rows[0].number}`;
      await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [item.id, JSON.stringify(item)]);
      return item;
    };
    const first = await create('Recent journey'), older = await create('Two days ago');
    // Immutable fixture history, including an initial snapshot before the window and a rework.
    const snapshot = async (item: any, ago: number, stage: string, extra = {}) => {
      const work = { ...item, stage, implementers: ['graphyard-codex-2'], ...extra };
      await store.pool.query('INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ($1,$2,$3,$4,$5)', [item.id, 'fixture', 'fixture.stage', JSON.stringify({ work }), new Date(end - ago * hour)]);
    };
    await snapshot(first, 30, 'ready');
    await snapshot(first, 20, 'build');
    await snapshot(first, 14, 'review');
    await snapshot(first, 13, 'build');
    await snapshot(first, 10, 'review');
    await snapshot(first, 8, 'merge');
    await snapshot(first, 4, 'done', { delivery: { mergedAt: new Date(end - 4 * hour).toISOString() } });
    await snapshot(first, 2, 'done', { delivery: { mergedAt: new Date(end - 4 * hour).toISOString(), deployment: { observedAt: new Date(end - 2 * hour).toISOString() } } });
    await snapshot(older, 80, 'ready'); await snapshot(older, 48, 'build');
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      // A poll still in flight when the server closes must not fail the run.
      const response = await route.fetch({ url: http.url + url.pathname + url.search }).catch(() => null);
      if (!response) return route.abort('connectionrefused').catch(() => {});
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto('/?sign-in'); await page.getByLabel('Access token').fill('test-human-operator');
    await page.getByRole('button', { name: 'Open control plane' }).click();
    await page.locator('.replay-panel > summary').click();
    const replay = page.getByRole('region', { name: 'Replay', exact: true });
    const dot = replay.locator(`[data-replay-item="${first.key}"]`), oldDot = replay.locator(`[data-replay-item="${older.key}"]`);
    const scrub = replay.getByRole('slider', { name: 'Replay time' });
    const seek = async (value: string) => {
      await scrub.evaluate((element, next) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, next);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    };
    await expect(dot).toHaveAttribute('data-column', 'Shipped');
    await seek('0'); await expect(dot).toHaveAttribute('data-column', 'Up next');
    await seek('500'); await expect(dot).toHaveAttribute('data-column', 'Building');
    await seek('650'); await expect(dot).toHaveAttribute('data-column', 'Review');
    await seek('750'); await expect(dot).toHaveAttribute('data-column', 'Trial');
    await seek('900'); await expect(dot).toHaveAttribute('data-column', 'Merged');
    await seek('1000'); await expect(dot).toHaveAttribute('data-column', 'Shipped');
    await expect(dot.locator('[data-agent]')).toHaveAttribute('title', 'graphyard-codex-2');
    await expect(oldDot).toHaveCount(0);
    await replay.getByRole('button', { name: '3 days', exact: true }).click();
    await expect(scrub).toHaveValue('1000');
    await seek('500'); await expect(oldDot).toHaveAttribute('data-column', 'Building');
    await replay.getByRole('button', { name: '24 h', exact: true }).click();
    await expect(scrub).toHaveValue('1000');
    await replay.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(dot).toHaveAttribute('data-column', 'Up next');
    await expect(dot).toHaveAttribute('data-column', 'Building', { timeout: 7000 });
    expect(await dot.evaluate(element => getComputedStyle(element).transitionProperty)).toContain('left');
    await replay.getByRole('button', { name: 'Pause', exact: true }).click();
    const stopped = await scrub.inputValue(); await page.waitForTimeout(180); await expect(scrub).toHaveValue(stopped);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(scrub).toBeDisabled(); await expect(dot).toHaveAttribute('data-column', 'Shipped');
    await expect(replay.locator('[data-replay-column="Shipped"] .count')).toHaveText('1');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Fun', exact: true }).click();
    await expect(scrub).toBeDisabled(); await expect(dot).toHaveAttribute('data-column', 'Shipped');
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await http.close(); await store.close(); }
});
