import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priorityServer } from '../tests/helpers/priority-server';

const settled = { timeout: 15_000 };
const descriptionLead = 'Compose trial container ran out of shared memory during migration checks on compose.yaml with shm_size=64m and failed the third retry loop.';
const descriptionTail = 'TAIL_MARKER_900_CHAR_DESCRIPTION';
const longDescription = `${descriptionLead} ${'Implementation detail about container limits, trial ids, shm_size, and compose file names. '.repeat(9)}${descriptionTail}`;
const question = 'Approve a $50 monthly cap for the staging cloud account?';

test('e2e:rows-are-one-line — work rows stay one short line (<=110 chars, <=120px tall) and Needs you leads with the asked decision in normal text', async ({ page }) => {
  test.setTimeout(180_000);
  expect(longDescription.length).toBeGreaterThanOrEqual(900);
  const f = await priorityServer();
  try {
    const operator = f.engine.principals.find(p => p.id === 'operator')!;
    const criteria = [{ id: 'AC-1', text: 'Rows stay compact', proofs: ['e2e:rows-are-one-line'] }];

    // AC-1: an item with a 900-character description and no summary (and no why/simplest).
    const noSummary = await f.engine.execute(operator, 'create', null, {
      type: 'bug', title: 'Fix trial shared memory', description: longDescription, criteria,
    }, randomUUID());
    await f.ok(`work/${noSummary.id}/ready`, { reason: 'Ready' });

    // AC-1: an item with a 900-character description, long why/simplest, and no summary.
    const longLead = await f.ok('work', {
      type: 'bug', title: 'Trim long lead sentences', description: longDescription,
      why: 'The Work page currently wraps very long why and simplest fields into many lines so the owner has to scroll past paragraphs of text to see what is going on in the factory.',
      simplest: 'Cut the row sentence to one short line of at most 110 characters with an ellipsis so every row stays compact.',
      criteria,
    });
    await f.ok(`work/${longLead.id}/ready`, { reason: 'Ready' });

    // AC-1: an item with summary set shows summary instead of description.
    const withSummary = await f.ok('work', {
      type: 'feature', title: 'Show explicit summary', summary: 'Short explicit summary for the row.',
      description: longDescription, why: 'Owners read the summary.', simplest: 'Show summary when set.', criteria,
    });
    await f.ok(`work/${withSummary.id}/ready`, { reason: 'Ready' });

    // AC-2: a Needs you item with a human request and a 900-character description (plus summary).
    const needsYou = await f.ok('work', {
      type: 'feature', title: 'Staging cloud budget', summary: 'Hidden summary on Needs you row.',
      description: longDescription, why: 'Staging proofs need a cloud project.', simplest: 'Ask the owner once.', criteria,
    });
    await f.ok(`work/${needsYou.id}/ready`, { reason: 'Ready' });
    const claimed = await f.ok(`work/${needsYou.id}/claim`, {}, f.tokens.worker);
    await f.ok(`work/${needsYou.id}/park`, {
      epoch: claimed.epoch, kind: 'money-or-accounts', ask: question, needed: question,
      recommendation: 'Approve $50/month', why: 'A capped staging account keeps test spend bounded.',
      reason: 'Staging tests need a dedicated cloud project.',
      choices: [{ id: 'approve', label: 'Approve $50/month', outcome: 'provided', input: 'none' }],
    }, f.tokens.worker);

    await page.route('**/api/**', async route => {
      const { pathname, search } = new URL(route.request().url());
      const response = await route.fetch({ url: f.url + pathname + search }).catch(() => null);
      await (response ? route.fulfill({ response }) : route.abort()).catch(() => {});
    });
    const { code } = await f.ok('sign-in-links', {});
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#sign-in=' + code);
    await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(settled);

    // Check both 1280 px and 390 px viewports.
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(page.locator(`[data-row="${noSummary.key}"]`)).toBeVisible(settled);

      // AC-1: every row's text under the title is at most 110 characters and never shows the full description.
      for (const item of [noSummary, longLead, withSummary]) {
        const row = page.locator(`[data-row="${item.key}"]`);
        const lead = row.locator('[data-lead]');
        await expect(lead).toBeVisible(settled);
        const text = (await lead.textContent())!.trim();
        expect(text.length, `${item.key} at ${viewport.width}px: "${text}"`).toBeGreaterThan(0);
        expect(text.length, `${item.key} at ${viewport.width}px: "${text}"`).toBeLessThanOrEqual(110);
        await expect(row).not.toContainText(descriptionTail);
        if (viewport.width === 1280) {
          const box = await row.boundingBox();
          expect(box!.height, `${item.key} height at 1280px`).toBeLessThanOrEqual(120);
        }
      }
      await expect(page.locator(`[data-row="${withSummary.key}"] [data-lead]`)).toHaveText('Short explicit summary for the row.');
      expect((await page.locator(`[data-row="${noSummary.key}"] [data-lead]`).textContent())!.trim().endsWith('…')).toBe(true);
      expect((await page.locator(`[data-row="${longLead.key}"] [data-lead]`).textContent())!.trim().endsWith('…')).toBe(true);

      // AC-2: Needs you row shows title -> asked decision (normal text colour & size) -> waiting time -> Decide,
      // and never shows summary or description.
      const needsRow = page.locator(`[data-group-section="needs-you"] [data-row="${needsYou.key}"]`);
      await expect(needsRow).toBeVisible(settled);
      await expect(needsRow).toContainText(question);
      await expect(needsRow).not.toContainText('Hidden summary on Needs you row.');
      await expect(needsRow).not.toContainText('Compose trial container');
      await expect(needsRow).not.toContainText(descriptionTail);
      await expect(needsRow.locator('[data-lead]')).toHaveCount(0);

      const needsCheck = await needsRow.evaluate(el => {
        const title = el.querySelector('[data-title]')!;
        const decision = el.querySelector('.row-sub')!;
        const waited = el.querySelector('.waited')!;
        const decide = el.querySelector('.decide')!;
        const bodyStyle = getComputedStyle(document.body);
        const decisionStyle = getComputedStyle(decision);
        const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          order: before(title, decision) && before(decision, waited) && before(waited, decide),
          decisionColor: decisionStyle.color, bodyColor: bodyStyle.color,
          decisionSize: decisionStyle.fontSize, bodySize: bodyStyle.fontSize,
          decisionText: decision.textContent!.trim(),
        };
      });
      expect(needsCheck.order, `Needs you DOM order at ${viewport.width}px`).toBe(true);
      expect(needsCheck.decisionText).toBe(question);
      expect(needsCheck.decisionColor, `Needs you decision colour at ${viewport.width}px`).toBe(needsCheck.bodyColor);
      expect(needsCheck.decisionSize, `Needs you decision font size at ${viewport.width}px`).toBe(needsCheck.bodySize);

      if (viewport.width === 1280) {
        const box = await needsRow.boundingBox();
        expect(box!.height, 'Needs you row height at 1280px').toBeLessThanOrEqual(120);
      }
      if (viewport.width === 390) {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'no horizontal scroll at 390px').toBeLessThanOrEqual(0);
      }
    }

    // AC-1: the full description still appears on the item page (under Details).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(`[data-row="${noSummary.key}"]`).getByRole('button', { name: /open/ }).click();
    const details = page.locator('article.item-page .item-details-fold');
    await details.locator('> summary').click();
    await expect(details).toContainText(descriptionTail, settled);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await f.close();
  }
});
