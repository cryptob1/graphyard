import { test, expect, type BrowserContext } from '@playwright/test';
import { withDatabase } from '../tests/helpers/postgres';
import { Engine } from '../src/engine';
import { server } from '../src/server';
import { encodeLoopCheckoutTrust, loopPresenceHeader, loopStallAlarmHeader, loopSupervisionHeader } from '../src/model/loop-presence';
import { coordinationViewHeader } from '../src/server/work-view';
import { emptyDaemonState } from '../src/daemon/state';
import { stallAlarm } from '../src/daemon/stall-alarm';
import { implementationWaiting } from '../src/daemon/cpu-pressure';
import type { Work } from '../src/model';
import { serveXterm } from './xterm';

// e2e:stall-alarm — GY-3432: a fixture install with a ready item and a free worker slot whose
// launches have been held for 10 minutes. The loop's coordination read names its stall alarm
// exactly as `master run` sends it, and the served Master page shows it first, with its cause; once
// a launch starts the loop names none and the page clears it.

async function plane(context: BrowserContext) {
  const store = await withDatabase('master_stall_alarm');
  await store.init();
  const engine = new Engine(store, 120, 'fixture/shop');
  engine.gitRunner = null;
  const http = server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'test-human-operator' },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: 'test-loop' },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await context.route('**/*', async route => {
    const { pathname, search } = new URL(route.request().url());
    await route.fetch(pathname.startsWith('/api/') ? { url: url + pathname + search } : {})
      .then(response => route.fulfill({ response }), () => route.abort('connectionrefused'));
  });
  const close = async () => { await context.unrouteAll(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  return { url, close };
}

/** The loop's coordination read, naming its stall alarm or `off`, as `master run` sends it. */
async function loopRead(url: string, alarm: string | null) {
  const read = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: 'Bearer test-loop',
    [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '15', [loopSupervisionHeader]: 'autonomous',
    [loopStallAlarmHeader]: alarm ? encodeLoopCheckoutTrust(alarm) : 'off' } });
  expect(read.status).toBe(200);
}

test('e2e:stall-alarm — the Master page shows the stall alarm with its cause while launches are held, and clears it once a launch starts', async ({ page, context }) => {
  test.setTimeout(90_000);
  const { url, close } = await plane(context);
  await serveXterm(context);
  try {
    // Launches held 11 minutes by CPU pressure (the sensor at 96C holds nothing, GY-3501), one free slot, one ready item: the loop's own check.
    const start = Date.parse('2026-11-16T08:00:00Z');
    const state = emptyDaemonState({ url: 'http://127.0.0.1:9', repository: 'fixture/shop' } as never);
    state.cpuPressure = { at: new Date(start).toISOString(), avg60: 96, steal: 0, stat: null, celsius: 96, samples: [], testBudget: null, trialCap: null };
    const item = { key: 'GY-1', stage: 'ready', ready: true, updatedAt: new Date(start).toISOString(), sessions: [] } as unknown as Work;
    // GY-3473: the cause is dispatch's own hold this cycle, as the loop passes it.
    const holds = [implementationWaiting(state)!];
    const alarm = stallAlarm({ now: start + 11 * 60_000, open: [item], ready: [item], freeSlots: 1, holds, state, registry: null, serving: null });
    expect(alarm).toContain('Cause: launches waiting: CPU pressure 96 percent');
    await loopRead(url, alarm);
    const signIn = await fetch(`${url}/api/sign-in-links`, { method: 'POST', headers: { Authorization: 'Bearer test-human-operator' } });
    const { code } = await signIn.json() as { code: string };
    await page.goto(`/#sign-in=${code}&master`);
    await expect(page.getByRole('heading', { name: 'Master', exact: true, level: 1 })).toBeVisible({ timeout: 15_000 });
    const banner = page.locator('.stall-alarm');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.page-heading + .stall-alarm')).toBeVisible();
    await expect(banner).toContainText('no launch since 2026-11-16T08:00:00.000Z');
    await expect(banner).toContainText('launches waiting: CPU pressure 96 percent');
    // A launch starts: the loop's next read names no alarm, and the page clears it.
    const running = { ...item, stage: 'build', sessions: [{ kind: 'implementation', state: 'running', startedAt: new Date(start + 12 * 60_000).toISOString() }] } as unknown as Work;
    const cleared = stallAlarm({ now: start + 12 * 60_000, open: [running], ready: [], freeSlots: 0, state, registry: null, serving: null });
    expect(cleared).toBeNull();
    await loopRead(url, cleared);
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
  } finally { await page.close(); await close(); }
});
