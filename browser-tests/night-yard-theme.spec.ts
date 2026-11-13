import { test, expect, type Page } from '@playwright/test';
import { boardFromStatus } from '../src/model/board';
import { boardStatus, boardWork, NOW } from './ui-board';

// GY-3272 AC-1: Night Yard is the default look, Daylight is selectable and remembered, both hold
// WCAG AA for text (the audit below walks every visible text element), and with reduced motion the
// rain, glitch and pulse animations do not run — with motion on, they do, and Fun off skips the
// glitch and the pulse.
const ledger = (item: any, state: string) => ({ key: item.key, state, head: item.candidate.sha, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, refusal: null, events: 1 });
/** The board fixture with one row whose merge trial failed on its own head: the glitch row. */
const auditWork = () => boardWork().map(item => item.key === 'GY-15' ? { ...item, mergeLedger: ledger(item, 'refused') } : item);
const merged = (item: any) => ({ ...item, stage: 'done', lease: undefined, gates: [], delivery: { mergedAt: new Date(NOW).toISOString(), mergeSha: 'a'.repeat(40) } });

async function serve(page: Page, work: any[]) {
  const state = { work };
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

/** Every visible text element, measured against the background it actually sits on: WCAG AA or it fails. */
const audit = (page: Page) => page.evaluate(() => {
  type Colour = [number, number, number];
  const parse = (value: string): { rgb: Colour; alpha: number } | null => {
    const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(value.trim());
    if (srgb) return { rgb: [Math.round(+srgb[1] * 255), Math.round(+srgb[2] * 255), Math.round(+srgb[3] * 255)], alpha: srgb[4] ? +srgb[4] : 1 };
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!rgb) return null;
    const parts = rgb[1].split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string) => part.endsWith('%') ? parseFloat(part) * 2.55 : parseFloat(part);
    return { rgb: [channel(parts[0]), channel(parts[1]), channel(parts[2])], alpha: parts[3] !== undefined ? parseFloat(parts[3]) : 1 };
  };
  const luminance = ([r, g, b]: Colour) => {
    const channel = (value: number) => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a: Colour, b: Colour) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const blend = (top: { rgb: Colour; alpha: number }, bottom: Colour): Colour => top.rgb.map((value, at) => value * top.alpha + bottom[at] * (1 - top.alpha)) as Colour;
  const backgroundOf = (element: Element): Colour => {
    const stack: { rgb: Colour; alpha: number }[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const colour = parse(getComputedStyle(node).backgroundColor);
      if (!colour) continue;
      if (colour.alpha >= 1) { let base = colour.rgb; for (const layer of stack.reverse()) base = blend(layer, base); return base; }
      if (colour.alpha > 0) stack.push(colour);
    }
    return [0, 0, 0];
  };
  const failures: { tag: string; className: string; text: string; measured: number; size: number; weight: number }[] = [];
  for (const element of document.querySelectorAll('body *')) {
    const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('');
    if (!/\S/.test(text)) continue;
    if (element.closest('[aria-hidden="true"]')) continue;
    if (!element.getClientRects().length) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const colour = parse(style.color);
    if (!colour) continue;
    const background = backgroundOf(element);
    const rgb = colour.alpha >= 1 ? colour.rgb : blend(colour, background);
    const size = parseFloat(style.fontSize), weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const measured = ratio(rgb, background);
    if (measured < (large ? 3 : 4.5)) failures.push({ tag: element.tagName, className: String((element as HTMLElement).className), text: text.trim().slice(0, 40), measured: Math.round(measured * 100) / 100, size, weight });
  }
  return failures;
});
const expectAA = async (page: Page, where: string) => expect(await audit(page), `${where}: no text below WCAG AA`).toEqual([]);

/** The body's background as [r, g, b], whichever way the browser serialises the colour. */
const background = (page: Page) => page.evaluate(() => { const match = /([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(getComputedStyle(document.body).backgroundColor)!; return [+match[1], +match[2], +match[3]]; });
const rain = (page: Page) => page.evaluate(() => getComputedStyle(document.body, '::after').animationName);
const grain = (page: Page) => page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage);
const live = { timeout: 15_000 };

test('e2e:night-yard-theme — Night Yard serves by default with rain over grain, Daylight is selectable and remembered, and both themes hold WCAG AA', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await serve(page, auditWork());
  // A fresh browser gets Night Yard: near-black blue, the rain drifting, the grain still.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  expect(await background(page)).toEqual([7, 11, 20]);
  expect(await rain(page)).toBe('gy-rain');
  expect(await grain(page)).toContain('svg');
  // AC-5: the playful copy names the master the Chief and the agents runners; plain labels keep their words.
  await expect(page.locator('.city-strip')).toContainText('runners on shift');
  await expect(page.locator('[data-row="GY-14"] .row-who')).toContainText('Theo is running GY-14');
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search commands').fill('Master');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'The Chief', exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('w');
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  // The audit covers the page an operator reads most: the Work board, an item page, the palette, the shortcut sheet.
  await expectAA(page, 'the Work page at night');
  await page.locator('[data-row="GY-15"] .card-open').click();
  await expect(page.locator('article.item-page')).toBeVisible();
  await expectAA(page, 'the item page at night');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Command palette (Ctrl K)' }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expectAA(page, 'the palette at night');
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expectAA(page, 'the shortcut sheet at night');
  await page.keyboard.press('Escape');
  // Daylight: the same dashboard on paper-white, no rain and no grain.
  await page.getByRole('button', { name: 'Switch theme to Daylight' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  expect(await background(page)).toEqual([243, 244, 239]);
  expect(await rain(page)).toBe('none');
  expect(await grain(page)).toBe('none');
  await expectAA(page, 'the Work page in daylight');
  await page.locator('[data-row="GY-15"] .card-open').click();
  await expect(page.locator('article.item-page')).toBeVisible();
  await expectAA(page, 'the item page in daylight');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Command palette (Ctrl K)' }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expectAA(page, 'the palette in daylight');
  await page.keyboard.press('Escape');
  // The choice is this browser's: a reload serves Daylight again, and Night Yard is one button away.
  expect(await page.evaluate(() => localStorage.getItem('graphyard.theme'))).toBe('daylight');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Work', exact: true, level: 1 })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  expect(await background(page)).toEqual([243, 244, 239]);
  await page.getByRole('button', { name: 'Switch theme to Night Yard' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  expect(await background(page)).toEqual([7, 11, 20]);
});

test('e2e:night-yard-theme — with reduced motion the rain, the glitch flicker and the ship pulse do not run', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const state = await serve(page, auditWork());
  const glitch = page.locator('.work-row.glitch');
  await expect(glitch).toHaveCount(1);
  await expect(glitch).toHaveAttribute('data-row', 'GY-15');
  expect(await glitch.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  expect(await rain(page)).toBe('none');
  // The grain holds still — it is a texture, not a movement — and the beacons do not breathe.
  expect(await grain(page)).toContain('svg');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.city-strip .beacon')!).animationName)).toBe('none');
  // A merge still brings the toast, but no pulse runs on it.
  state.work = state.work.map(item => item.key === 'GY-15' ? merged(item) : item);
  const toast = page.locator('[data-toast="GY-15"]');
  await expect(toast).toBeVisible(live);
  await expect(toast).toHaveClass(/pulse/);
  expect(await toast.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.locator('.confetti')).toHaveCount(0);
});

test('e2e:night-yard-theme — with motion on a failed trial glitches and a ship pulses; Fun off skips both', async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const state = await serve(page, auditWork());
  const glitch = page.locator('.work-row.glitch');
  await expect(glitch).toHaveCount(1);
  expect(await glitch.evaluate(element => getComputedStyle(element).animationName)).toBe('gy-glitch');
  expect(await rain(page)).toBe('gy-rain');
  state.work = state.work.map(item => item.key === 'GY-14' ? merged(item) : item);
  const toast = page.locator('[data-toast="GY-14"]');
  await expect(toast).toBeVisible(live);
  expect(await toast.evaluate(element => getComputedStyle(element).animationName)).toBe('gy-neon');
  await toast.click();
  // Fun off: the row stops flickering and the ship carries no pulse.
  await page.getByRole('button', { name: 'Fun', exact: true }).click();
  await expect(page.locator('.work-row.glitch')).toHaveCount(0);
  state.work = state.work.map(item => item.key === 'GY-16' ? merged(item) : item);
  const plain = page.locator('[data-toast="GY-16"]');
  await expect(plain).toBeVisible(live);
  expect(await plain.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.locator('.confetti')).toHaveCount(0);
});
