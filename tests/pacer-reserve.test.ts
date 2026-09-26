import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, ObservationPacer, TokenBudgets, mergePathReserve, observationPace, observationThroughputStatus, tokenIdentity } from '../src/github.js';
import { githubBudgetAttention } from '../src/cli/github-budget-attention.js';

// GY-690. Each test is named for the proof it produces: unit:pacer-holds-reserve-per-token,
// unit:per-token-budget-projection.

const minute = 60_000;

interface TokenState { remaining: number; resetAt: number; min: number }
/**
 * Two hours at 100 ms resolution with two installation tokens whose budgets reset at different
 * times (A at 25 minutes with 3000 left, B at 55 minutes with a full 5000; each refills to 5000
 * for another hour at its reset). Four observation workers alternate between the tokens and wait
 * for the pace of the token they spend on; each job spends `cost` requests over four seconds.
 * Callers outside the pace — review and producer launches, merges, protection reads — spend
 * `otherPerMinute` on each token throughout. Every request reports the token's budget, as
 * GitHub's headers would. With `accountOthers` false the workers pace as GY-567 did: on the
 * budget alone, blind to what the other callers will spend before the reset.
 */
function simulate(options: { accountOthers: boolean; workers?: number; cost?: number; otherPerMinute?: number }) {
  const workers = options.workers ?? 4, cost = options.cost ?? 12, otherEvery = minute / (options.otherPerMinute ?? 30), step = 100, duration = 4_000, end = 120 * minute;
  const tokens: Record<string, TokenState> = { A: { remaining: 3000, resetAt: 25 * minute, min: 3000 }, B: { remaining: 5000, resetAt: 55 * minute, min: 5000 } };
  const ledger = new TokenBudgets();
  const blind: Record<string, ObservationPacer> = { A: new ObservationPacer(), B: new ObservationPacer() };
  let jobs = 0;
  const spend = (name: string, now: number, paced: boolean) => {
    const token = tokens[name];
    assert.ok(token.remaining > 0, `token ${name} exhausted at ${now} ms`);
    token.remaining--; token.min = Math.min(token.min, token.remaining);
    ledger.charge(name, now, paced);
    ledger.read(name, { limit: 5000, remaining: token.remaining, used: 5000 - token.remaining, resetAt: token.resetAt, at: now });
  };
  const state = Array.from({ length: workers }, (_, index) => ({ token: index % 2 ? 'B' : 'A', sleepUntil: 0, job: null as null | { startedAt: number; spent: number; settle: (charged?: number, at?: number) => void } }));
  let nextOther = 0;
  for (let now = 0; now < end; now += step) {
    for (const [name, token] of Object.entries(tokens)) if (token.resetAt <= now) { token.remaining = 5000; token.resetAt += 60 * minute; }
    if (now >= nextOther) { for (const name of Object.keys(tokens)) spend(name, now, false); nextOther += otherEvery; }
    for (const worker of state) {
      if (worker.job) {
        const job = worker.job, owed = Math.min(cost, Math.floor((now - job.startedAt) / duration * cost) + 1);
        while (job.spent < owed) { spend(worker.token, now, true); job.spent++; }
        if (now - job.startedAt >= duration) { job.settle(job.spent, now); worker.job = null; jobs++; }
        continue;
      }
      if (worker.sleepUntil > now) continue;
      const token = tokens[worker.token];
      const slot = options.accountOthers ? ledger.pace(worker.token, cost, now, mergePathReserve)
        : blind[worker.token].start({ remaining: token.remaining, resetAt: token.resetAt, reserve: mergePathReserve }, cost, now);
      if (!slot.settle) { worker.sleepUntil = now + Math.min(slot.wait, 5000); continue; }
      worker.job = { startedAt: now, spent: 0, settle: slot.settle };
    }
  }
  return { minA: tokens.A.min, minB: tokens.B.min, jobs };
}

test('unit:pacer-holds-reserve-per-token — two tokens with different resets, four workers and 30 requests a minute spent outside the pace: neither token falls below the merge-path reserve before its reset', () => {
  assert.equal(mergePathReserve, 500, 'the default reserve the simulation keeps');
  // The incident: paced on the budget alone, the callers outside the pace spend what the workers
  // were told was theirs, and the hour ends below the reserve.
  const blind = simulate({ accountOthers: false });
  assert.ok(Math.min(blind.minA, blind.minB) < mergePathReserve, `paced blind to the other callers, a token falls below the reserve (A ${blind.minA}, B ${blind.minB})`);
  const held = simulate({ accountOthers: true });
  assert.ok(held.minA >= mergePathReserve, `token A never falls below the reserve (lowest ${held.minA})`);
  assert.ok(held.minB >= mergePathReserve, `token B never falls below the reserve (lowest ${held.minB})`);
  // Holding the reserve is not starving: the workers still spend most of what is above it.
  assert.ok(held.jobs * 12 >= blind.jobs * 12 * 0.5, `the workers still observe (${held.jobs} jobs, ${blind.jobs} blind)`);
  // The same bound at every concurrency, and against heavier outside spend.
  for (const workers of [1, 2, 8]) {
    const hour = simulate({ accountOthers: true, workers });
    assert.ok(Math.min(hour.minA, hour.minB) >= mergePathReserve, `${workers} worker(s): lowest A ${hour.minA}, B ${hour.minB}`);
  }
  const heavy = simulate({ accountOthers: true, otherPerMinute: 60 });
  assert.ok(Math.min(heavy.minA, heavy.minB) >= mergePathReserve, `60/min outside the pace: lowest A ${heavy.minA}, B ${heavy.minB}`);
});

test('unit:pacer-holds-reserve-per-token — the pace holds back what callers outside it will spend before the reset', () => {
  const now = 1_000_000;
  // 4400 above the reserve over an hour, of which others will spend 30/min × 60 = 1800.
  const pace = observationPace({ remaining: 5000, resetAt: now + 3_600_000, reserve: 500, otherRate: 30 / minute }, 100, 12, now);
  assert.equal(pace.tier, 'spendable');
  assert.ok(Math.abs(pace.rate! - (4400 - 1800) / 3_600_000) < 1e-12);
  // When the others alone will spend what is above the reserve, observation waits for the reset.
  assert.equal(observationPace({ remaining: 1400, resetAt: now + 30 * minute, reserve: 500, otherRate: 30 / minute }, 0, 12, now).tier, 'reserve');
});

test('unit:pacer-holds-reserve-per-token — the client charges every request to the token that made it and paces on the current token alone', () => {
  const budgets = new TokenBudgets();
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used' }, budgets);
  const now = Date.now();
  const response = (remaining: number, reset: number, status = 200) => new Response(status === 304 ? null : '{}', { status, headers: {
    'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-used': String(5000 - remaining), 'x-ratelimit-reset': String(Math.floor(reset / 1000)), 'x-ratelimit-resource': 'core' } });
  const record = (token: string, remaining: number, reset: number, at: number, status = 200) => (github as any).record('/repos/owner/project/pulls/1', response(remaining, reset, status), true, at, true, tokenIdentity(token));
  const resetA = Math.ceil((now + 5 * minute) / 1000) * 1000, resetB = Math.ceil((now + 50 * minute) / 1000) * 1000;
  // Token B answers last, with plenty left: the pace on A must not read B's budget.
  for (let index = 0; index <= 60; index++) record('token-a', 1800 - index * 20, resetA, now - 2 * minute + index * 2000);
  record('token-a', 600, resetA, now, 304);
  record('token-b', 4800, resetB, now);
  Object.assign(github, { token: 'token-a' });
  const budget = github.budget(now);
  const [a, b] = [tokenIdentity('token-a'), tokenIdentity('token-b')].map(id => budget.tokens.find(token => token.token === id)!);
  assert.equal(a.current, true, 'token A is the one the client now holds');
  assert.equal(a.remaining, 600);
  assert.equal(a.resetAt, new Date(resetA).toISOString());
  assert.equal(b.remaining, 4800);
  assert.equal(b.resetAt, new Date(resetB).toISOString(), 'each token keeps its own reset');
  assert.equal(a.perMinute, 600, 'A has been spending 20 requests every 2 s');
  assert.equal(a.otherPerMinute, 600, 'none of it inside a paced observation job');
  assert.equal(a.belowReserveAtReset, true);
  // Paced on A's own budget: A cannot afford an observation above its reserve, whatever B has left.
  const slot = github.paceObservation(now);
  assert.ok(!slot.settle, 'on token A the workers wait');
  assert.notEqual(github.budget(now).pace.tier, 'spendable');
  Object.assign(github, { token: 'token-b' });
  assert.ok(github.paceObservation(now).settle, 'on token B they start');
  // A request made inside a measured (paced) observation job is not counted as outside spend.
  const before = github.budget(now).tokens.find(token => token.token === tokenIdentity('token-b'))!.otherPerMinute;
  return github.measured(async () => { record('token-b', 4799, resetB, now + 1); }).then(() => {
    assert.equal(github.budget(now + 1).tokens.find(token => token.token === tokenIdentity('token-b'))!.otherPerMinute, before);
  });
});

test('unit:per-token-budget-projection — master status shows each token\'s remaining, reset and projected remaining at reset, and raises attention when the projection is below the reserve (the 15:18-15:28 series)', () => {
  const budgets = new TokenBudgets();
  const at = (clock: string) => Date.parse(`2026-09-26T${clock}Z`);
  const reset = at('15:28:57');
  // 2026-09-26: the token read from 14:48 to 15:28, spending 100-133 paid requests a minute.
  const series: [string, number][] = [['15:18:00', 1330], ['15:19:00', 1210], ['15:20:00', 1090], ['15:21:00', 973], ['15:22:00', 840], ['15:23:00', 728],
    ['15:24:00', 610], ['15:25:00', 490], ['15:26:00', 360], ['15:27:00', 240], ['15:28:00', 120]];
  for (const [clock, remaining] of series) budgets.read('incident', { limit: 5000, remaining, used: 5000 - remaining, resetAt: reset, at: at(clock) });
  // A second token on its own reset, spending slowly.
  const other = at('15:50:00');
  budgets.read('healthy', { limit: 5000, remaining: 4000, used: 1000, resetAt: other, at: at('15:18:00') });
  budgets.read('healthy', { limit: 5000, remaining: 3900, used: 1100, resetAt: other, at: at('15:28:00') });

  const now = at('15:28:00');
  const tokens = budgets.report(now, mergePathReserve, 'incident');
  const incident = tokens.find(token => token.token === 'incident')!, healthy = tokens.find(token => token.token === 'healthy')!;
  // 1210 requests over 10 minutes is 121/min; 57 s to the reset leaves 120 − 121 × 0.95 ≈ 5.
  assert.deepEqual({ remaining: incident.remaining, resetAt: incident.resetAt, perMinute: incident.perMinute, projectedAtReset: incident.projectedAtReset, belowReserveAtReset: incident.belowReserveAtReset },
    { remaining: 120, resetAt: '2026-09-26T15:28:57.000Z', perMinute: 121, projectedAtReset: 5, belowReserveAtReset: true });
  assert.deepEqual({ remaining: healthy.remaining, resetAt: healthy.resetAt, perMinute: healthy.perMinute, projectedAtReset: healthy.projectedAtReset, belowReserveAtReset: healthy.belowReserveAtReset },
    { remaining: 3900, resetAt: '2026-09-26T15:50:00.000Z', perMinute: 10, projectedAtReset: 3680, belowReserveAtReset: false });

  const githubBudget = { limit: 5000, remaining: 120, resetAt: incident.resetAt, observedAt: incident.observedAt, perMinute: 121, projectedExhaustionAt: null, exhaustsBeforeReset: false,
    reserve: mergePathReserve, belowReserve: true, paused: null, lastHour: { requests: 0, byKind: [] }, tokens };
  // master status carries every token's reading beside the budget it reports.
  const report = observationThroughputStatus({ githubBudget }, { work: [], now: new Date(now).toISOString(), jobs: [] }, now);
  assert.deepEqual(report.budget!.tokens.map(token => [token.token, token.remaining, token.resetAt, token.projectedAtReset]),
    [['incident', 120, '2026-09-26T15:28:57.000Z', 5], ['healthy', 3900, '2026-09-26T15:50:00.000Z', 3680]]);
  const items = githubBudgetAttention({ githubBudget }, now).filter(item => /GitHub token/.test(item.text));
  assert.equal(items.length, 1, 'only the token projected below the reserve is raised');
  assert.match(items[0].text, /GitHub token incident \(the one observation is paced on\): 120 requests remain until 2026-09-26T15:28:57.000Z, spent at 121\/min .* 5 remain at the reset, below the 500-request merge-path reserve/);
  assert.equal(githubBudgetAttention({ githubBudget: { ...githubBudget, tokens: [healthy] } }, now).filter(item => /GitHub token/.test(item.text)).length, 0, 'a token that keeps its reserve raises nothing');
});
