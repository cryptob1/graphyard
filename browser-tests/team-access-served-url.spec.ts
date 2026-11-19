import { test, expect } from '@playwright/test';
import { servedInstall, servedUrl } from '../tests/helpers/served-install';

test.use({ actionTimeout: 15_000 });

// GY-3480: Tailscale serves this install over HTTPS on :8447; Invite names that address, with no warning.
test('e2e:team-access-served-url — Invite lists the https address Tailscale serves this install at, and no warning', async ({ browser, baseURL }) => {
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
    await page.goto(`${baseURL}/#sign-in=${code}`);
    // GY-3486: the top bar's Invite dialog lists this install at its served address.
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite' });
    await expect(dialog.getByRole('checkbox', { name: new RegExp(servedUrl.replace(/[.:/]/g, '\\$&')) })).toBeChecked({ timeout: 15_000 });
    await expect(dialog).not.toContainText('Tailscale is not serving');
  } finally {
    await context.close();
    await install.close();
  }
});
