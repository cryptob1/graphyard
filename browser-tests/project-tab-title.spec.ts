import { test, expect, type Page } from '@playwright/test';
import { boardApi, boardStatus } from './ui-board';

// GY-3306: the browser tab names the project the dashboard serves, so an operator's tabs tell
// installs apart. Two distinct configured identities each keep gh · OWNER/REPO as the document
// title through navigation and reload; Graphyard stands until the identity loads — and returns
// after sign-out — never undefined and never a stale other project's name.
async function install(page: Page, repository: () => string) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/status') ? { ...boardStatus(), repository: repository() } : boardApi(path.slice(1)) });
  });
}

const open = async (page: Page) => {
  // The sign-in page is the pre-identity state: the plain fallback every install shares.
  await page.goto('/?sign-in');
  await expect(page).toHaveTitle('Graphyard');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
};

/** What one install's tab owes everywhere: its own project's title, on every page and after a reload. */
async function tabNamesTheProject(page: Page, repository: string) {
  const title = `gh · ${repository}`;
  await expect(page.locator('.top-bar .project-name')).toHaveText(repository);
  await expect(page).toHaveTitle(title);
  for (const entry of ['Workers', 'Work']) {
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: entry, exact: true }).click();
    await expect(page.getByRole('heading', { name: entry, level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(title);
  }
  const item = 'Cut the documentation to a short set';
  await page.getByRole('button', { name: item }).first().click();
  await expect(page.getByRole('heading', { name: item, level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(title);
  await page.getByRole('button', { name: '← Back' }).click();
  // A reload restarts from the page's own Graphyard fallback and lands on the same project again.
  await page.reload();
  await expect(page.locator('.top-bar .project-name')).toHaveText(repository);
  await expect(page).toHaveTitle(title);
}

for (const repository of ['cryptob1/graphyard', 'cryptob1/hello-huck']) {
  test(`the tab names ${repository} through navigation and reload`, async ({ page }) => {
    await install(page, () => repository);
    await open(page);
    await tabNamesTheProject(page, repository);
  });
}

test('the title follows the served identity, never a stale project, and sign-out returns to the fallback', async ({ page }) => {
  let repository = 'cryptob1/graphyard';
  await install(page, () => repository);
  await open(page);
  await expect(page).toHaveTitle('gh · cryptob1/graphyard');
  // The same tab, served the other install's identity: the title replaces the old project.
  repository = 'cryptob1/hello-huck';
  await page.reload();
  await expect(page.locator('.top-bar .project-name')).toHaveText(repository);
  await expect(page).toHaveTitle('gh · cryptob1/hello-huck');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Access token')).toBeVisible();
  await expect(page).toHaveTitle('Graphyard');
});
