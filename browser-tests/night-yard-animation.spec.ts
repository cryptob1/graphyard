import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';

// This spec proves motion, so it asks for it over the suite's reduced-motion default.
test.use({ reducedMotion: 'no-preference' });

// GY-3272 AC-4: the yard moves. A one-second boot sequence plays once per browser session and any
// key or click skips it; a stage change glides the row to its new group instead of jumping; an
// item in trial carries a light streak along its row; the rain falls in two parallax sheets, the
// headings flicker in and the top line types itself out. Reduced motion — or Fun off — stills all
// of it, and the boot never runs.
const ledger = (item: any, state: string) => ({ key: item.key, state, head: item.candidate.sha, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: null, events: 1 });
/** The board fixture with one merge trial out (GY-21 pushed, the streak) and one refused on its own head (GY-15, the glitch). */
const movingWork = () => boardWork().map(item => {
  if (item.key === 'GY-21') return { ...item, mergeLedger: ledger(item, 'pushed') };
  if (item.key === 'GY-15') return { ...item, mergeLedger: ledger(item, 'refused') };
  return item;
});

async function serve(page: Page) {
  const state = { work: movingWork() };
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
  await expect(page.locator('.work-row').first()).toBeVisible();
  return state;
}

/** One element's (or pseudo-element's) running animation, so a test can say it moves — or that it does not. */
const animationOf = (page: Page, selector: string, pseudo = '') =>
  page.evaluate(([sel, ps]) => getComputedStyle(document.querySelector(sel)!, ps ? (ps as any) : undefined).animationName, [selector, pseudo]);
const live = { timeout: 15_000 };

/**
 * The boot's own timers run on the page clock, held still until the test moves it: a loaded
 * trial machine can spend the veil's whole real second between the page's script and the first
 * look, and a held clock makes "inside its second" exact instead of a race against the load.
 */
async function bootHeld(page: Page) {
  // The signed-out page answers from a fixture, so no proxy to a control plane that is not there sits in the way.
  await page.route('**/api/**', route => route.fulfill({ status: 401, json: { error: 'unauthorized' } }));
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.goto('/');
  const boot = page.locator('[data-boot="run"]');
  await expect(boot).toBeVisible({ timeout: 10_000 });
  return boot;
}

test('e2e:night-yard-animation — the boot sequence plays once per browser session, and any key skips it', async ({ page }) => {
  test.setTimeout(60_000);
  const boot = await bootHeld(page);
  // The readout types out: a quarter second in, it holds some of its characters but not all.
  await page.clock.runFor(250);
  const typed = (await page.locator('.boot-readout').textContent())!.length;
  expect(typed).toBeGreaterThan(0);
  await page.clock.runFor(10);
  expect((await page.locator('.boot-readout').textContent())!.length).toBeGreaterThan(typed);
  // Any key skips it at once — no clock time passes before the page arrives.
  await page.keyboard.press('Escape');
  await expect(boot).toHaveCount(0, live);
  // Once per browser session: a reload goes straight to the page.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open control plane' })).toBeVisible(live);
  await expect(page.locator('[data-boot]')).toHaveCount(0);
});

test('e2e:night-yard-animation — left alone, the boot hands the page over inside its second', async ({ page }) => {
  test.setTimeout(60_000);
  const boot = await bootHeld(page);
  // A loaded machine: more than the veil's real second passes before the next look. The veil
  // answers to the page clock alone, so it is still up until the clock moves.
  await page.waitForTimeout(1_500);
  await page.clock.runFor(900);
  await expect(boot).toBeVisible();
  await page.clock.runFor(200);
  await expect(boot).toHaveCount(0, live);
  await expect(page.getByRole('button', { name: 'Open control plane' })).toBeVisible(live);
});

test('e2e:night-yard-animation — a stage change glides the row to its new group instead of jumping', async ({ page }) => {
  test.setTimeout(60_000);
  const state = await serve(page);
  const row = page.locator('[data-row="GY-20"]');
  await expect(row).toHaveAttribute('data-group', 'needs-you');
  // The glide lasts under 600 ms, shorter than a loaded machine's gap between two looks, so the page
  // itself records the moment it starts: the row transitioning on transform alone to where it belongs.
  await page.evaluate(() => new MutationObserver(() => {
    const el = document.querySelector<HTMLElement>('[data-row="GY-20"].glide');
    if (el) (window as any).glided ??= el.style.transition;
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] }));
  // The operator's decision lands: the row leaves Needs you for the group the board now puts it in.
  state.work = state.work.map(item => item.key === 'GY-20' ? { ...item, humanRequest: null, blocker: null } : item);
  await expect(row).not.toHaveAttribute('data-group', 'needs-you', live);
  await expect.poll(() => page.evaluate(() => (window as any).glided ?? null), live).toMatch(/^transform /);
  await expect.poll(() => row.evaluate(el => el.classList.contains('glide')), { timeout: 3_000 }).toBe(false);
  expect(await row.evaluate(el => el.style.transform)).toBe('');
});

test('e2e:night-yard-animation — a row in trial carries the streak, the rain falls in two sheets, headings flicker in and the line types itself out', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  // The streak: exactly the row whose merge trial is out.
  const streak = page.locator('.work-row.trial');
  await expect(streak).toHaveCount(1);
  await expect(streak).toHaveAttribute('data-row', 'GY-21');
  expect(await streak.evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('gy-streak');
  // Parallax rain: a near sheet and a far one, at their own speeds.
  expect(await animationOf(page, 'body', '::after')).toBe('gy-rain');
  expect(await animationOf(page, 'html', '::after')).toBe('gy-rain-far');
  // Atmosphere paints above the root background but below content, palettes and ship toasts.
  for (const [selector, pseudo] of [['body', '::after'], ['html', '::after'], ['body', '::before']]) {
    const layer = await page.locator(selector).evaluate((el, ps) => {
      const style = getComputedStyle(el, ps);
      return { z: Number(style.zIndex), background: style.backgroundImage, pointerEvents: style.pointerEvents };
    }, pseudo);
    expect(layer.z, `${selector}${pseudo} stays behind the page`).toBeLessThan(0);
    expect(layer.background).not.toBe('none');
    expect(layer.pointerEvents).toBe('none');
  }
  // Headings and rows flicker in like a neon sign switching on.
  expect(await animationOf(page, 'h1')).toBe('gy-flicker-in');
  expect(await animationOf(page, '.work-row')).toBe('gy-flicker-in');
  // The top line types itself out — a clip-path wipes it open a character step at a time — and finishes open.
  const typed = page.locator('.build-line .typed');
  expect(await typed.evaluate(el => getComputedStyle(el).animationName)).toBe('gy-type');
  await expect.poll(() => typed.evaluate(el => getComputedStyle(el).clipPath), { timeout: 4_000 }).toBe('none');
});

test('e2e:night-yard-animation — with reduced motion every animation stills and the boot never runs', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await serve(page);
  // The boot never ran on this load.
  await expect(page.locator('[data-boot]')).toHaveCount(0);
  // Rain (both sheets), streak, glitch, beacons, the flicker-in and the typing line: all still.
  for (const [selector, pseudo] of [['body', '::after'], ['html', '::after'], ['.work-row.trial', '::after'], ['.work-row.glitch', ''], ['.city-strip .beacon', ''], ['h1', ''], ['.build-line .typed', '']] as const)
    expect(await animationOf(page, selector, pseudo), `${selector}${pseudo}`).toBe('none');
  // A stage change still happens — the row lands at once, with no glide.
  state.work = state.work.map(item => item.key === 'GY-20' ? { ...item, humanRequest: null, blocker: null } : item);
  const row = page.locator('[data-row="GY-20"]');
  await expect(row).not.toHaveAttribute('data-group', 'needs-you', live);
  expect(await row.evaluate(el => el.classList.contains('glide'))).toBe(false);
});

test('e2e:night-yard-animation — Fun off turns every animation off, on this page and the next', async ({ page }) => {
  test.setTimeout(60_000);
  await serve(page);
  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-fun', 'off');
  // Rain (both sheets), streak, beacons and the flicker-in: all still. The line is gone with its
  // Fun, and so is the glitch's own class — no row claims it any more.
  for (const [selector, pseudo] of [['body', '::after'], ['html', '::after'], ['.work-row.trial', '::after'], ['.city-strip .beacon', ''], ['h1', '']] as const)
    expect(await animationOf(page, selector, pseudo), `${selector}${pseudo}`).toBe('none');
  await expect(page.locator('.build-line')).toHaveCount(0);
  await expect(page.locator('.work-row.glitch')).toHaveCount(0);
  // A fresh load with Fun remembered off brings the page straight up, boot and all.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible(live);
  await expect(page.locator('[data-boot]')).toHaveCount(0);
  expect(await animationOf(page, 'body', '::after')).toBe('none');
});
