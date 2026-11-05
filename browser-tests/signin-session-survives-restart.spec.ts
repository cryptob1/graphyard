import { test, expect } from '@playwright/test';
import { signInDatabase } from '../tests/helpers/sign-in-database';
import { signInProcess } from '../tests/helpers/sign-in-process';

test('e2e:signin-session-survives-restart — login link remains signed in after server restart and sign-out revokes it', async ({ page }) => {
  const database = await signInDatabase();
  let http = await signInProcess(database.url);
  // The dashboard first renders only after the sign-in link is redeemed and the status, work
  // snapshot and board reads have answered — four sequential round trips behind a dev server that
  // transforms the app on first load. On a loaded host that takes more than Playwright's 5 s
  // expect default (the batch gate's flaky failure), so each wait gets half the test's own budget.
  const settled = { timeout: 15_000 };
  try {
    // The UI is served by Vite; all API requests reach the real, restartable control plane. The
    // dashboard keeps polling while the plane is replaced below, so a request can arrive while no
    // server is listening: answer as the down server would (the dashboard holds its session and
    // retries the poll) instead of letting the fetch failure escape the handler, which hangs the
    // page's request and can take the Playwright worker down with it.
    await page.route('**/api/**', async route => {
      const target = http.url + new URL(route.request().url()).pathname;
      await route.fetch({ url: target }).then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
    });
    const response = await fetch(http.url + '/api/sign-in-links', { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
    const { code } = await response.json() as { code: string };
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(settled);
    const token = await page.evaluate(() => localStorage.getItem('graphyard-token'));
    expect(token).toMatch(/^gyh_/);
    await http.close();
    http = await signInProcess(database.url);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(settled);
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBe(token);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeHidden(settled);
    expect(await page.evaluate(() => localStorage.getItem('graphyard-token'))).toBeNull();
    expect((await fetch(http.url + '/api/status', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rowCount).toBe(0);
  } finally { await http.close(); await database.close(); }
});
