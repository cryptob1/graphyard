import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, realDeliveredWork, NOW } from './ui-board';

// GY-3395: the header's strip is a trust strip — three numbers for the last seven days computed
// from the records Graphyard already keeps (deliveries, proofs, send-backs and the batch gate's
// reverts), replacing the agent counts. Each number links to the items behind it on the Shipped
// page. The seeded week: four deliveries, one verified by running, one sent back, one reverted,
// and one delivery eight days old that counts for none of them.
const hour = 3_600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

/** One passing proof that ran the real app: trusted `e2e:` evidence that executed cases. */
const ranTheApp = { id: 'evidence-e2e', proof: 'e2e:checkout-pays', sha: sha('a'), baseSha: sha('b'), policyRevision: 1,
  producer: 'e2e-producer', trusted: true, result: 'pass', executed: 4, skipped: 0, at: at(-3 * hour) };

/** The batch gate's revert of one item, as its own merge ledger records it. */
const revertedByGate = { serve: sha('s'), mergeSha: sha('m'), at: at(-2 * hour), outcome: 'reverted', revertSha: sha('r'),
  reason: 'reverted GY-165 for failing e2e:checkout-pays', reland: 'Re-land GY-165', failingCase: 'checkout-pays', failingStep: null, failingReason: null };

/** The week's records: delivered items two hours to eight days old, with the proofs, send-backs and revert above. */
const seededWork = () => realDeliveredWork().map(item => {
  if (item.key === 'GY-163') return { ...item, criteria: [{ id: 'AC-1', text: 'Checkout takes payment.', proofs: ['integration:gy-163', 'e2e:checkout-pays'] }], evidence: [ranTheApp] };
  if (item.key === 'GY-164') return { ...item, lastRework: { reason: 'the product review requested changes on the head', binding: null, at: at(-10 * hour) } };
  if (item.key === 'GY-165') return { ...item, mergeLedger: { key: 'GY-165', state: 'pushed', head: sha('a'), baseTip: null, mergeSha: sha('m'), risk: null, intentAt: null, pushedAt: at(-30 * hour), observedTip: null, refusal: null, events: 3, serveReverts: [revertedByGate] } };
  return item;
}).concat([{ ...realDeliveredWork()[0], id: '00000000-0000-4000-8000-000000000167', key: 'GY-167', title: 'Delivered eight days ago', description: 'Delivered eight days ago.', observation: null,
  delivery: { mergeSha: sha('m167'), mergedAt: at(-8 * 24 * hour), evidenceAsOf: at(-8 * 24 * hour), mergedAtRepository: at(-8 * 24 * hour), authorizationRevision: 1, repositoryClockOffsetMs: 0 },
  stageEnteredAt: at(-8 * 24 * hour), evidence: [ranTheApp] }]);

async function serve(page: Page) {
  const state = { work: seededWork() };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) return route.fulfill({ json: boardStatus('admin') });
    if (path.endsWith('/work-snapshot')) return route.fulfill({ json: { work: state.work, now: new Date(NOW).toISOString() } });
    if (path.endsWith('/board')) return route.fulfill({ json: boardFromStatus(state.work, NOW, null) });
    if (path.endsWith('/events')) return route.fulfill({ json: [] });
    if (path.includes('/work/')) return route.fulfill({ json: state.work.find(w => path.endsWith(w.id)) ?? {} });
    return route.fulfill({ json: [] });
  });
  await page.goto('/?sign-in');
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  return state;
}

test('e2e:trust-strip — the header shows the week’s trust numbers, no agent counts, and each number links to its items', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  const strip = page.locator('.trust-strip');
  // The three numbers, matching the seeded records: four deliveries this week, one whose proof ran
  // the real app, one sent back, one reverted by the batch gate. The delivery eight days old and
  // the untrusted integration proofs count for none of them.
  await expect(strip).toHaveAttribute('data-delivered', '4');
  await expect(strip).toHaveAttribute('data-verified-by-running', '1');
  await expect(strip).toHaveAttribute('data-sent-back', '1');
  await expect(strip).toHaveAttribute('data-reverts', '1');
  await expect(strip).toContainText('1/4 verified by running');
  await expect(strip).toContainText('1/4 sent back');
  await expect(strip).toContainText('1 reverted');
  // The header carries no agent counts.
  await expect(strip).not.toContainText('agents working');
  await expect(strip).not.toContainText('in trial');

  // Each number opens the items behind it, on the Shipped page.
  const list = page.locator('.shipped-page');
  await page.locator('[data-trust="verified-by-running"]').click();
  await expect(page.getByRole('heading', { name: 'Shipped', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('[data-trust-note="verified-by-running"]')).toContainText('Showing 1 of 4 delivered this week');
  await expect(list).toContainText('GY-163');
  await expect(list).not.toContainText('GY-164');
  await expect(list).not.toContainText('GY-167');
  // The item itself opens from the list.
  await page.locator('.shipped-page').getByRole('button', { name: /GY-163/ }).click();
  await expect(page.locator('article.item-page')).toContainText('Resolve review threads the reviewer listed');

  await page.locator('[data-trust="sent-back"]').click();
  await expect(list).toContainText('GY-164');
  await expect(list).not.toContainText('GY-163');
  await page.locator('[data-trust="reverts"]').click();
  await expect(page.locator('[data-trust-note="reverts"]')).toContainText('Showing 1 reverted this week');
  await expect(list).toContainText('GY-165');
  await expect(list).not.toContainText('GY-163');
  // Clearing the filter shows every delivered item, the eight-day-old one back on the list.
  await page.getByRole('button', { name: 'Show every delivered item' }).click();
  await expect(list).toContainText('GY-167');
  await expect(list).toContainText('GY-163');
});
