import { test, expect } from '@playwright/test';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { signInProcess } from '../tests/helpers/sign-in-process';

test('e2e:signin-session-survives-restart — login link remains signed in after server restart and sign-out revokes it', async ({ page }) => {
  const database = await signInDatabase();
  let http = await signInProcess(database.url);
  try {
    // The UI is served by Vite; all API requests reach the real, restartable control plane.
    await page.route('**/api/**', async route => {
      const target = http.url + new URL(route.request().url()).pathname;
      await route.fulfill({ response: await route.fetch({ url: target }) });
    });
    const response = await fetch(http.url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
    const { code } = await response.json() as { code: string };
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('graphyard-token'));
    expect(token).toMatch(/^gyh_/);
    await http.close();
    http = await signInProcess(database.url);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBe(token);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBeNull();
    expect((await fetch(http.url + '/api/status', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rowCount).toBe(0);
  } finally { await http.close(); await database.close(); }
});
