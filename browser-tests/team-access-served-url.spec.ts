import { test, expect } from '@playwright/test';
import { servedInstall, servedUrl } from '../tests/helpers/served-install';

test.use({ actionTimeout: 15_000 });

// GY-3480: Tailscale serves this install over HTTPS on :8447; Setup names that address, with no warning.
test('e2e:team-access-served-url — Setup shows the https address Tailscale serves this install at, and no warning', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const install = await servedInstall('team_access_served_browser');
  const context = await browser.newContext();
  try {
    await install.call('/api/team-access/share-link', { url: 'https://login.tailscale.com/admin/invite/served-share-browser' });
    await install.sync();
    await context.route('**/*', async route => {
      const { pathname, search } = new URL(route.request().url());
      await route.fetch(pathname.startsWith('/api/') ? { url: install.base + pathname + search } : {}).then(response => route.fulfill({ response }), () => route.abort('connectionrefused')).catch(() => { /* the page navigated away meanwhile */ });
    });
    const page = await context.newPage();
    const { code } = await (await fetch(install.base + '/api/sign-in-links', { method: 'POST', headers: { Authorization: `Bearer ${install.operator}` } })).json() as { code: string };
    await page.goto(`${baseURL}/#sign-in=${code}&setup`);
    const section = page.getByRole('region', { name: 'Invite someone', exact: true });
    await expect(section).toContainText(`This install: ${servedUrl}`, { timeout: 15_000 });
    await expect(section.getByRole('link', { name: servedUrl })).toBeVisible();
    await expect(section.locator('[data-share-state="missing"]')).toHaveCount(0);
    await expect(section).not.toContainText('Tailscale is not serving');
  } finally {
    await context.close();
    await install.close();
  }
});
