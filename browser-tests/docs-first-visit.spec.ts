import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// e2e:docs-first-visit — GY-3295: a newcomer opens Docs (Help at the foot of the sidebar) on the served
// dashboard at desktop and phone widths, follows the page's own links from the overview through the first
// item, the two diagrams, the FAQ and the reference, by pointer and by keyboard, and finds concrete
// answers. The page never scrolls sideways, diagram labels are at least 14 CSS px, and no card or label
// overlaps another. A full-page screenshot per width is kept for an independent look.

const now = '2026-01-01T00:00:00Z';
const shots = 'test-results/screenshots/docs-first-visit';

async function signedIn(page: Page) {
  await page.route('**/api/**', async route => {
    if (route.request().headers().authorization !== 'Bearer browser-fixture') return route.fulfill({ status: 401, json: { error: 'Rejected' } });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: { actor: { id: 'fixture', role: 'admin', sessionKind: 'human' }, github: true, reviewProviders: ['github'], repository: 'fixture/repository', jobs: [] } });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: [], now } });
    if (path.endsWith('/board')) return route.fulfill({ json: { groups: [], now } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('browser-fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible({ timeout: 15_000 });
}

/** The page never scrolls sideways: neither the document nor the Docs article is wider than its box. */
async function noSidewaysScroll(page: Page) {
  const widths = await page.evaluate(() => {
    const doc = document.scrollingElement!, guide = document.querySelector('.guide')!;
    return { doc: doc.scrollWidth - doc.clientWidth, guide: guide.scrollWidth - guide.clientWidth };
  });
  expect(widths, 'no page-level horizontal overflow').toEqual({ doc: 0, guide: 0 });
}

/** In each diagram: every label at least 14 CSS px, no two cards overlapping, and every label inside its own card. */
async function readableDiagrams(page: Page) {
  for (const name of ['How a change ships', 'Where things run']) {
    const figure = page.getByRole('figure', { name, exact: true });
    await expect(figure).toBeVisible();
    const problems = await figure.evaluate(root => {
      const found: string[] = [];
      const box = (el: Element) => el.getBoundingClientRect();
      const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      const inside = (inner: DOMRect, outer: DOMRect) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
      const labels = [...root.querySelectorAll('strong, span, code, h3')];
      if (labels.length < 10) found.push(`only ${labels.length} labels`);
      for (const label of labels) {
        const size = parseFloat(getComputedStyle(label).fontSize);
        if (size < 14) found.push(`"${label.textContent}" is ${size}px`);
      }
      const cards = [...root.querySelectorAll('.guide-card')];
      if (cards.length < 6) found.push(`only ${cards.length} cards`);
      cards.forEach((card, i) => {
        for (const label of card.querySelectorAll('strong, span, code')) {
          if (!inside(box(label), box(card))) found.push(`"${label.textContent}" spills out of its card`);
          if (label.scrollWidth > label.clientWidth + 1) found.push(`"${label.textContent}" is clipped`);
        }
        cards.slice(i + 1).forEach(other => { if (overlap(box(card), box(other))) found.push(`"${card.textContent}" overlaps "${other.textContent}"`); });
        // The flow's arrow sits in the gap after its card, never on a card.
        const arrow = getComputedStyle(card, '::after');
        if (arrow.content !== 'none' && arrow.content !== 'normal' && arrow.position === 'absolute') {
          // Positioned, so every offset resolves to pixels from the card's padding box.
          const c = box(card), border = parseFloat(getComputedStyle(card).borderLeftWidth);
          const at = new DOMRect(c.left + border + parseFloat(arrow.left), c.top + border + parseFloat(arrow.top), parseFloat(arrow.width), parseFloat(arrow.height));
          if (![at.x, at.y, at.width, at.height].every(Number.isFinite)) found.push(`the arrow after "${card.querySelector('strong')?.textContent}" has no measurable box`);
          if (overlap(at, c)) found.push(`the arrow after "${card.querySelector('strong')?.textContent}" sits on its card`);
          for (const other of cards) if (other !== card && overlap(at, box(other))) found.push(`the arrow after "${card.querySelector('strong')?.textContent}" sits on "${other.querySelector('strong')?.textContent}"`);
        }
      });
      return found;
    });
    expect(problems, `${name}: readable, no overlap`).toEqual([]);
  }
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`e2e:docs-first-visit — a newcomer follows Docs from overview to FAQ and reference at ${viewport.width}px, with readable diagrams and no overflow`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signedIn(page);
    // On a phone the sidebar folds behind Menu; Help is at its foot.
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const docs = page.locator('article.guide');
    await expect(docs.getByRole('heading', { name: 'How Graphyard works', level: 1 })).toBeVisible();
    await expect(docs).toContainText('coding factory');

    // Every link on the page that stays on the page lands on something that exists.
    const targets = await docs.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute('href')!.slice(1)));
    expect(targets.length).toBeGreaterThanOrEqual(6);
    for (const id of targets) expect(await page.locator(`[id="${id}"]`).count(), `#${id} exists`).toBe(1);

    // The contents links walk the newcomer through the page by pointer.
    const contents = page.getByRole('navigation', { name: 'On this page' });
    for (const [link, heading] of [['Who decides what', 'Who decides what'], ['Your first item', 'Your first item'], ['How a change ships', 'How a change ships'], ['Where things run', 'Where things run'], ['Reference', 'Reference']]) {
      await contents.getByRole('link', { name: link, exact: true }).click();
      await expect(docs.getByRole('heading', { name: heading, level: 2, exact: true })).toBeInViewport();
    }
    const overview = docs.locator('#docs-overview');
    for (const role of ['You, the owner', 'The Master', 'The loop']) await expect(overview).toContainText(role);
    const journey = docs.locator('#docs-first-item ol');
    await expect(journey.locator('li')).toHaveCount(7);
    for (const step of ['npx @cryptob1/graphyard doctor', 'npx @cryptob1/graphyard up --repo OWNER/NAME', 'http://127.0.0.1:4310', 'New work item', 'Shipped', 'Blocked', 'Needs you']) await expect(journey).toContainText(step);

    // By keyboard: the FAQ link, then Tab to the first question and open it with Enter.
    await contents.getByRole('link', { name: 'FAQ', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(docs.getByRole('heading', { name: 'FAQ', level: 2, exact: true })).toBeInViewport();
    const first = docs.locator('#faq-what');
    for (let i = 0; i < 12 && !(await first.locator('summary').evaluate(summary => summary === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(first.locator('summary')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('open', '');
    await expect(first.locator('p')).toBeVisible();

    // Concrete answers to what a new engineer asks first.
    const answers: [string, string[]][] = [
      ['faq-context', ['product brief', 'AGENTS.md', 'work item', 'committed work']],
      ['faq-delivery', ['reviews it', 'proof', 'latest main', 'batch', 'reverts', 'rolls back']],
      ['faq-deploy', ['Railway', 'AWS', 'delivery.applications', 'versionUrl']],
      ['faq-access', ['http://127.0.0.1:4310', 'first free port', '--port N', 'graphyard login', 'Invite someone', 'each install']],
    ];
    for (const [id, says] of answers) {
      const faq = docs.locator(`#${id}`);
      await faq.locator('summary').click();
      for (const text of says) await expect(faq.locator('p')).toContainText(text);
    }
    // A link inside an answer goes where it says.
    await docs.locator('#faq-where summary').click();
    await docs.locator('#faq-where').getByRole('link', { name: 'Where things run' }).click();
    await expect(docs.getByRole('figure', { name: 'Where things run' })).toBeInViewport();

    // The advanced reference is folded and opens on demand, carrying the log commands.
    await contents.getByRole('link', { name: 'Reference', exact: true }).click();
    const parts = docs.locator('#docs-reference details', { hasText: 'Every part, with its log command' });
    await parts.locator('summary').click();
    await expect(parts).toContainText('journalctl --user -u graphyard-master-OWNER-NAME.service');

    await readableDiagrams(page);
    await noSidewaysScroll(page);

    mkdirSync(shots, { recursive: true });
    const path = `${shots}/docs-${viewport.name}.png`;
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`docs-${viewport.name}`, { path, contentType: 'image/png' });
  });
}
