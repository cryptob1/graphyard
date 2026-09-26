import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GitHub, ObservationPacer, budgetTight, firstObservationOwed, mergePathReserve, observationClaimOrder, observationPace, observationThroughputStatus, tightBudgetDecision, type GitHubBudget } from '../src/github.js';
import { githubBudgetAttention } from '../src/cli/github-budget-attention.js';
import { evaluate, type Work } from '../src/model.js';

// GY-567. Each test is named for the proof it produces: unit:observation-rate-paced,
// unit:observation-priority-under-budget, unit:budget-projection-reported,
// unit:first-observation-not-starved.

const CI = 15368;
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

// ---- The hour, simulated: workers, a shared budget, and a fleet of due jobs ----

interface Hour { minRemaining: number; maxHeadGapMs: number; headObservations: number; jobs: number; belowReserveAt: number | null }
/**
 * One budget hour at 100 ms resolution. `workers` loops each wait for the pacer (when `paced`),
 * claim the merge-queue head first when it is due (every 20 s after its last observation) and
 * otherwise the oldest due of `backlog` other jobs (due 60 s after theirs), and spend `cost`
 * requests spread across a 4-second job. The budget is what GitHub's headers would report.
 */
function simulateHour(workers: number, options: { paced: boolean; limit?: number; cost?: number; backlog?: number }): Hour {
  const limit = options.limit ?? 5000, cost = options.cost ?? 12, backlog = options.backlog ?? 30, hour = 3_600_000, step = 100, duration = 4_000;
  const resetAt = hour;
  let remaining = limit;
  const pacer = new ObservationPacer();
  const due = [0, ...Array.from({ length: backlog }, (_, index) => index * 1000)];
  const busy = new Set<number>();
  const state = Array.from({ length: workers }, () => ({ sleepUntil: 0, job: null as null | { index: number; startedAt: number; spent: number; settle?: (charged?: number, at?: number) => void } }));
  let lastHead = 0, maxHeadGapMs = 0, headObservations = 0, jobs = 0, minRemaining = remaining, belowReserveAt: number | null = null;
  for (let now = 0; now < hour; now += step) {
    for (const worker of state) {
      if (worker.job) {
        const job = worker.job;
        const owed = Math.min(cost, Math.floor((now - job.startedAt) / duration * cost) + 1);
        remaining -= owed - job.spent; job.spent = owed;
        if (now - job.startedAt >= duration) {
          busy.delete(job.index); due[job.index] = now + (job.index === 0 ? 20_000 : 60_000);
          if (job.index === 0) { maxHeadGapMs = Math.max(maxHeadGapMs, now - lastHead); lastHead = now; headObservations++; }
          job.settle?.(job.spent, now); worker.job = null; jobs++;
        }
        continue;
      }
      if (worker.sleepUntil > now) continue;
      const slot = options.paced ? pacer.start({ remaining, resetAt, reserve: mergePathReserve }, cost, now) : null;
      if (slot && !slot.settle) { worker.sleepUntil = now + Math.min(slot.wait, 5000); continue; }
      const candidates = due.map((at, index) => ({ at, index })).filter(entry => entry.at <= now && !busy.has(entry.index));
      const next = candidates.find(entry => entry.index === 0) ?? candidates.sort((a, b) => a.at - b.at)[0];
      if (!next) { slot?.settle(0, now); worker.sleepUntil = now + 1000; continue; }
      busy.add(next.index);
      worker.job = { index: next.index, startedAt: now, spent: 0, settle: slot?.settle };
    }
    minRemaining = Math.min(minRemaining, remaining);
    if (belowReserveAt === null && remaining < mergePathReserve) belowReserveAt = now;
  }
  maxHeadGapMs = Math.max(maxHeadGapMs, hour - lastHead);
  return { minRemaining, maxHeadGapMs, headObservations, jobs, belowReserveAt };
}

test('unit:observation-rate-paced — 4 workers sharing one paced budget of 5000 requests an hour at 12 requests a job keep it above the merge-path reserve all hour and observe the queue head at least every 2 minutes', () => {
  assert.equal(mergePathReserve, 500, 'the default reserve the simulation keeps');
  // The incident this replaces: four unpaced workers drained the budget in minutes (2026-09-26).
  const unpaced = simulateHour(4, { paced: false });
  assert.ok(unpaced.belowReserveAt !== null && unpaced.belowReserveAt < 1_800_000, `unpaced workers breach the reserve early (at ${unpaced.belowReserveAt} ms)`);
  const four = simulateHour(4, { paced: true });
  assert.ok(four.minRemaining > mergePathReserve, `paced, the budget never falls to the reserve (lowest ${four.minRemaining})`);
  assert.ok(four.maxHeadGapMs <= 120_000, `the queue head is observed at least every 2 minutes (longest gap ${four.maxHeadGapMs} ms)`);
  assert.ok(four.jobs * 12 >= (5000 - mergePathReserve) * 0.9, `pacing spends the budget above the reserve rather than starving (${four.jobs} jobs)`);
  // The same bound at every concurrency the installation may set.
  for (let workers = 1; workers <= 8; workers++) {
    const hour = simulateHour(workers, { paced: true });
    assert.ok(hour.minRemaining > mergePathReserve, `${workers} worker(s): lowest remaining ${hour.minRemaining}`);
    assert.ok(hour.maxHeadGapMs <= 120_000, `${workers} worker(s): longest head gap ${hour.maxHeadGapMs} ms`);
  }
});

test('unit:observation-rate-paced — the pace is the budget above the reserve, less what is in flight, over the time to the reset; a job it cannot afford waits for a near reset or spends from the reserve', () => {
  const now = 1_000_000;
  assert.deepEqual(observationPace({ remaining: null, resetAt: null, reserve: 500 }, 0, 12, now), { tier: 'unpaced', rate: null }, 'an unknown budget is never held against');
  assert.deepEqual(observationPace({ remaining: 5000, resetAt: now - 1, reserve: 500 }, 0, 12, now), { tier: 'unpaced', rate: null }, 'nor is one whose reset has passed');
  const spendable = observationPace({ remaining: 5000, resetAt: now + 3_600_000, reserve: 500 }, 100, 12, now);
  assert.equal(spendable.tier, 'spendable');
  assert.equal(spendable.rate, 4400 / 3_600_000);
  assert.deepEqual(observationPace({ remaining: 505, resetAt: now + 30_000, reserve: 500 }, 0, 12, now), { tier: 'reset', rate: 0, until: now + 31_000 }, 'a reset under a minute away is waited for');
  assert.deepEqual(observationPace({ remaining: 505, resetAt: now + 600_000, reserve: 500 }, 0, 12, now), { tier: 'reserve', rate: 505 / 600_000 }, 'further off, the merge path is paced from the reserve');
  // The shared pacer: a burst of about a tenth of the spendable budget, then one slot per
  // estimate / rate; a deferral gives its time back.
  const pacer = new ObservationPacer();
  const budget = { remaining: 4100, resetAt: now + 3_600_000, reserve: 500 };
  const slots: NonNullable<ReturnType<ObservationPacer['start']>['settle']>[] = [];
  let refused: ReturnType<ObservationPacer['start']> | null = null;
  while (!refused && slots.length < 1000) { const slot = pacer.start(budget, 12, now); if (slot.settle) slots.push(slot.settle); else refused = slot; }
  assert.ok(slots.length >= 20 && slots.length <= 31, `a burst of about 360 requests starts at once (${slots.length} jobs of 12)`);
  assert.equal(pacer.inFlight, slots.length * 12);
  assert.ok(refused && refused.wait > 0 && refused.wait <= 20_000, `past the burst a worker waits about one spacing (${refused?.wait} ms)`);
  slots[0](0, now);
  assert.equal(pacer.inFlight, (slots.length - 1) * 12);
  assert.ok(pacer.start(budget, 12, now).settle, 'a job that charged nothing returns its slot at once');
  assert.deepEqual(pacer.report().tier, 'spendable');
});

test('unit:observation-rate-paced — the GitHub client paces its workers from the budget its responses report and reports the pace in force', () => {
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used' });
  const now = Date.now();
  Object.assign(github, { rate: { limit: 5000, remaining: 2300, used: 2700, resetAt: now + 1_800_000, observedAt: now } });
  const slot = github.paceObservation(now);
  assert.ok(slot.settle, 'the first worker starts');
  let waiting = github.paceObservation(now), started = 1;
  while (waiting.settle && started < 1000) { started++; waiting = github.paceObservation(now); }
  assert.ok(!waiting.settle && waiting.wait > 0 && started < 30, `past a burst of ${started} jobs the next waits for the pace`);
  const pace = github.budget(now).pace;
  assert.equal(pace.tier, 'spendable');
  assert.ok(pace.perMinute! > 0 && pace.perMinute! <= (2300 - mergePathReserve) / 30, 'the spendable budget less the estimate in flight, spread over the 30 minutes to the reset');
  assert.equal(pace.inFlight, started * 10);
});

// ---- Work items, as observation-throughput.test.ts builds them ----

const item = (key: string, pr: number, head: string, baseSha: string, overrides: Partial<Work> = {}): Work => ({
  id: randomUUID(), key, title: key, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven', proofs: [] }],
  policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'merge', revision: 3, policyRevision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  stageEnteredAt: new Date().toISOString(), ready: true, epoch: 1, lease: null, workspaces: [{ host: 'machine', path: `/w/${key}`, branch: `graphyard/${key.toLowerCase()}-1`, epoch: 1, owner: 'implementer' }],
  candidate: { sha: head, baseSha, pr, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [],
  evidence: [], observation: null, blocker: null, gates: [], violations: [], escalations: [], implementers: [], queueHistory: [], ...overrides } as unknown as Work);
const observed = (work: Work, approved = true) => ({
  candidate: work.candidate!, checks: ['test', 'typecheck'].map((name, index) => ({ name, result: 'success', appId: CI, id: index + 1 })),
  reviews: approved ? [{ reviewer: 'independent-reviewer', sha: work.candidate!.sha, state: 'APPROVED', id: 900, submittedAt: new Date().toISOString() }] : [],
  merged: false, mergeSha: null, mergeable: true, prState: 'open' as const, draft: false,
  baseTip: work.candidate!.baseSha, baseTipContained: true, protected: true, files: ['src/feature.ts'], at: new Date(Date.now() - 30_000).toISOString(),
  scopeFiles: [{ path: 'src/feature.ts', status: 'modified' as const, sha: sha(`scope-${work.key}`), additions: 3, deletions: 1, binary: false }],
}) as Work['observation'];
const settle = (work: Work, all: Work[], approved = true) => { const observation = observed(work, approved); return { ...work, observation, ...evaluate({ ...work, observation }, all, new Date(), [CI]) } as Work; };

const budgetOf = (overrides: Partial<GitHubBudget> = {}) => ({ belowReserve: false, exhaustsBeforeReset: false, steadyStateBudget: 2000, resetAt: new Date(Date.now() + 1_800_000).toISOString(),
  pace: { tier: 'spendable' as const, perMinute: 75, intervalMs: 9600, inFlight: 0, estimate: 12 }, ...overrides });

test('unit:observation-priority-under-budget — under a tight budget the queue head and in-flight merge are claimed first, then items with running sessions, then the rest; idle items wait for webhooks', () => {
  const base = sha('main-567');
  const queue = [0, 1, 2].map(index => item(`GY-Q${index}`, 300 + index, sha(`q${index}`), base, { queue: { sequence: index + 1, enqueuedAt: new Date(Date.now() - 3_600_000).toISOString(), policyRevision: 1, speculation: null } } as Partial<Work>));
  const settledQueue = queue.map(work => settle(work, queue));
  const flightWork = settle(item('GY-FLIGHT', 400, sha('flight'), base), settledQueue);
  const flight = { ...flightWork, stage: 'merge', gates: flightWork.gates.map(gate => ({ ...gate, passed: true, reasons: [] })), violations: [],
    mergeAuthorization: { sha: flightWork.candidate!.sha, baseSha: flightWork.candidate!.baseSha, policyRevision: 1, at: new Date().toISOString() } } as Work;
  // A worker still running has not submitted; an unsubmitted idle item is nothing to read.
  const running = item('GY-RUN', 401, sha('run'), base, { stage: 'build', candidate: null, observation: null, submission: null,
    sessions: [{ id: 'worker:1', state: 'running', endedAt: null, kind: 'implementation' }] } as unknown as Partial<Work>);
  const waiting = settle(item('GY-WAIT', 402, sha('wait'), base, { criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }] }), settledQueue, false);
  const idle = item('GY-IDLE', 403, sha('idle'), base, { stage: 'build', candidate: null, observation: null, submission: null });
  const all = [idle, waiting, running, flight, ...settledQueue];
  const keys = (order: string[]) => order.map(id => all.find(work => work.id === id)!.key);

  const tight = keys(observationClaimOrder(all, 1, Date.now(), true));
  // The authorized merge in flight is itself the predicted head; the head band and it come first.
  const mergePath = tight.slice(0, tight.indexOf('GY-RUN'));
  assert.ok(mergePath.includes('GY-FLIGHT') && mergePath.includes('GY-Q0') && mergePath.every(key => key === 'GY-FLIGHT' || key.startsWith('GY-Q')), `the head band and the in-flight merge come first: ${tight.join(', ')}`);
  assert.equal(tight.indexOf('GY-WAIT'), tight.indexOf('GY-RUN') + 1, `then the running session, then everything else: ${tight.join(', ')}`);
  assert.ok(!tight.includes('GY-IDLE'), 'an idle item is left to availability order');
  const relaxed = keys(observationClaimOrder(all, 1, Date.now(), false));
  assert.ok(relaxed.indexOf('GY-WAIT') < relaxed.indexOf('GY-RUN'), 'with budget to spare, the observation a review waits on stays ahead of running sessions');

  // What makes a budget tight, and what a tight budget does to an idle observation.
  assert.equal(budgetTight(budgetOf()), false, '75/min paced is above the steady-state share (2000/h)');
  assert.equal(budgetTight(budgetOf({ pace: { tier: 'spendable', perMinute: 20, intervalMs: 36_000, inFlight: 0, estimate: 12 } })), true, 'paced under the steady-state share per minute');
  assert.equal(budgetTight(budgetOf({ exhaustsBeforeReset: true })), true);
  assert.equal(budgetTight(budgetOf({ belowReserve: true })), true);
  const now = new Date();
  const tightBudget = budgetOf({ exhaustsBeforeReset: true });
  const deferral = tightBudgetDecision('idle', tightBudget, false, now);
  assert.ok(deferral && Date.parse(deferral.until) === Date.parse(tightBudget.resetAt!) + 2000 && /webhook wakes and conditional reads/.test(deferral.reason), 'an idle poll waits for the reset or a webhook');
  assert.equal(tightBudgetDecision('idle', tightBudget, true, now), null, 'a webhook wake is observed');
  assert.equal(tightBudgetDecision('merge', tightBudget, false, now), null);
  assert.equal(tightBudgetDecision('active', tightBudget, false, now), null);
  assert.equal(tightBudgetDecision('idle', budgetOf(), false, now), null, 'with budget to spare idle polling continues');
});

test('unit:budget-projection-reported — master status reports remaining, reset, rate per minute and projected exhaustion, and raises attention when exhaustion comes before the reset', () => {
  const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1, installationId: 2, privateKey: 'not-used' });
  const now = Date.now();
  Object.assign(github, { rate: { limit: 5000, remaining: 2545, used: 2455, resetAt: now + 1_800_000, observedAt: now },
    charges: Array.from({ length: 6130 }, (_, index) => ({ at: now - (index % 600) * 1000, kind: 'pulls' })) });
  const budget = github.budget(now);
  assert.equal(budget.perMinute, 613, 'the incident\'s 613 requests a minute');
  assert.equal(budget.exhaustsBeforeReset, true);
  assert.ok(Date.parse(budget.projectedExhaustionAt!) < Date.parse(budget.resetAt!));

  const report = observationThroughputStatus({ githubBudget: budget }, { work: [], now: new Date(now).toISOString(), jobs: [] }, now);
  assert.deepEqual(report.budget && { remaining: report.budget.remaining, resetAt: report.budget.resetAt, perMinute: report.budget.perMinute, projectedExhaustionAt: report.budget.projectedExhaustionAt, exhaustsBeforeReset: report.budget.exhaustsBeforeReset },
    { remaining: 2545, resetAt: budget.resetAt, perMinute: 613, projectedExhaustionAt: budget.projectedExhaustionAt, exhaustsBeforeReset: true });
  assert.equal(report.budget!.pacedPerMinute, budget.pace.perMinute, 'the pace in force is reported beside the spend rate');
  assert.equal(observationThroughputStatus(null, { work: [], now: new Date(now).toISOString() }, now).budget, null, 'no reading, no budget');

  github.paceObservation(now);
  const [item] = githubBudgetAttention({ githubBudget: github.budget(now) }, now);
  assert.equal(item.subject, 'github');
  assert.match(item.text, /2545 of 5000 requests remain and the spend rate is 613\/min/);
  assert.match(item.text, /exhausted at .* before it resets at/);
  assert.match(item.text, /observation workers are paced to [\d.]+\/min \(spendable\)/);
  assert.deepEqual(githubBudgetAttention({ githubBudget: { ...github.budget(now), exhaustsBeforeReset: false } }, now), [], 'no attention while the budget lasts to the reset');

  const docs = readFileSync(new URL('../docs/operations-reference.md', import.meta.url), 'utf8');
  assert.match(docs, /GRAPHYARD_OBSERVATION_CONCURRENCY/);
  assert.match(docs, /pace/i, 'the pacing rule is documented');
});

/**
 * A fleet's observation hour with the real claim order (GY-567 AC-4): `workers` paced workers
 * claim the first due job the order names, else the oldest due one (what `Store.takeJob` does).
 * The queue head comes due every 20 s, the rest of its band every 60 s, queued entries behind it
 * every 5 minutes, and review-waiting items every 30 s — the load that, ranked ahead of them,
 * kept one worker from ever reading a new submission. Submissions arrive at `arrivals` and are
 * observed once; returns how long each waited for that first reading.
 */
function firstReadWaits(all: Work[], submissions: Work[], arrivals: number[], options: { workers: number; order: (works: Work[]) => string[] }) {
  const hour = 3_600_000, step = 1000, duration = 4000, cost = 12, resetAt = hour;
  let remaining = 5000;
  const pacer = new ObservationPacer();
  const works = new Map(all.map(work => [work.id, work]));
  const queued = all.filter(work => (work as Work & { queue?: unknown }).queue);
  const cadence = new Map<string, number>(all.map(work => [work.id, firstObservationOwed(work) ? Infinity : 30_000]));
  queued.forEach((work, index) => cadence.set(work.id, index === 0 ? 20_000 : index === 1 ? 60_000 : 300_000));
  const due = new Map<string, number>(all.map((work, index) => [work.id, index * 500]));
  const arrival = new Map(submissions.map((work, index) => [work.id, arrivals[index]]));
  const waits = new Map<string, number>();
  const busy = new Set<string>();
  const state = Array.from({ length: options.workers }, () => ({ sleepUntil: 0, job: null as null | { id: string; startedAt: number; settle: (charged?: number, at?: number) => void } }));
  for (let now = 0; now < hour; now += step) {
    for (const [id, at] of arrival) if (at === now) { works.set(id, submissions.find(work => work.id === id)!); due.set(id, now); }
    for (const worker of state) {
      if (worker.job && now - worker.job.startedAt >= duration) {
        const { id, settle } = worker.job;
        remaining -= cost; settle(cost, now); busy.delete(id); worker.job = null;
        const work = works.get(id)!;
        if (firstObservationOwed(work)) {
          waits.set(id, now - arrival.get(id)!);
          // Read once, it holds a candidate and is observed like any review-waiting item after.
          works.set(id, { ...work, observation: { at: new Date().toISOString() }, candidate: { sha: sha(id), baseSha: sha('base'), pr: 1, branch: 'b', author: 'a' } } as unknown as Work);
          cadence.set(id, 30_000);
        }
        due.set(id, now + cadence.get(id)!);
      }
      if (worker.job || worker.sleepUntil > now) continue;
      const slot = pacer.start({ remaining, resetAt, reserve: mergePathReserve }, cost, now);
      if (!slot.settle) { worker.sleepUntil = now + Math.min(slot.wait, 5000); continue; }
      const dueNow = [...due].filter(([id, at]) => at <= now && !busy.has(id));
      const named = options.order([...works.values()]).find(id => dueNow.some(([due]) => due === id));
      const next = named ?? dueNow.sort((a, b) => a[1] - b[1])[0]?.[0];
      if (!next) { slot.settle(0, now); worker.sleepUntil = now + 1000; continue; }
      busy.add(next); due.set(next, Infinity);
      worker.job = { id: next, startedAt: now, settle: slot.settle };
    }
  }
  return submissions.map(work => waits.get(work.id) ?? Infinity);
}

test('unit:first-observation-not-starved — with 13 queued entries and review-waiting items due every cycle, 3 new submissions each get their first observation within 5 minutes, ranked behind only the queue head band and in-flight merges; master status reports the oldest unobserved submission', () => {
  const base = sha('main-first-read');
  const raw = Array.from({ length: 13 }, (_, index) => item(`GY-Q${String(index).padStart(2, '0')}`, 600 + index, sha(`fq${index}`), base,
    { queue: { sequence: index + 1, enqueuedAt: new Date(Date.now() - 3_600_000).toISOString(), policyRevision: 1, speculation: null } } as Partial<Work>));
  const queue = raw.map(work => settle(work, raw));
  const waiting = Array.from({ length: 6 }, (_, index) => settle(item(`GY-W${index}`, 700 + index, sha(`fw${index}`), base, { criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['manual:budget'] }] }), queue, false));
  const submissions = [0, 1, 2].map(index => item(`GY-NEW${index}`, 800 + index, sha(`fn${index}`), base, { stage: 'build', candidate: null, observation: null,
    documentation: { submission: { epoch: 1, pr: 800 + index, at: new Date(Date.now() - (3 - index) * 60_000).toISOString(), files: null, statement: null, satisfiedBy: null } } } as unknown as Partial<Work>));
  const fleet = [...queue, ...waiting];
  assert.ok(submissions.every(firstObservationOwed) && !fleet.some(firstObservationOwed), 'only the new submissions owe a first reading');

  // The claim order: the head band first, then every never-observed submission, then the
  // review-waiting items — whether or not the budget is tight.
  for (const tight of [false, true]) {
    const all = [...fleet, ...submissions];
    const order = observationClaimOrder(all, 1, Date.now(), tight).map(id => all.find(work => work.id === id)!.key);
    assert.deepEqual(order.slice(0, 5), ['GY-Q00', 'GY-Q01', 'GY-NEW0', 'GY-NEW1', 'GY-NEW2'], `tight=${tight}: ${order.join(', ')}`);
  }

  // An hour of load: submissions arriving at 10, 25 and 40 minutes, four paced workers and one.
  const arrivals = [600_000, 1_500_000, 2_400_000];
  const claimOrder = (works: Work[]) => observationClaimOrder(works, 1, Date.now());
  for (const workers of [1, 4]) {
    const waits = firstReadWaits(fleet, submissions, arrivals, { workers, order: claimOrder });
    assert.ok(waits.every(wait => wait <= 300_000), `${workers} worker(s): each submission is first observed within 5 minutes (waits ${waits.join(', ')} ms)`);
  }
  // Without the first-read ranking (the order before this fix), the review-waiting items that
  // come due every cycle keep the submissions from ever being read.
  const unranked = (works: Work[]) => claimOrder(works).filter(id => !submissions.some(work => work.id === id));
  const starved = firstReadWaits(fleet, submissions, arrivals, { workers: 1, order: unranked });
  assert.ok(starved.some(wait => wait > 300_000), `unranked, a submission waits past the bound (waits ${starved.join(', ')} ms)`);

  // master status names the oldest submission still unread, with its age and how many there are.
  const now = Date.now();
  const report = observationThroughputStatus(null, { work: [...fleet, ...submissions], now: new Date(now).toISOString(), jobs: [] }, now);
  assert.equal(report.oldestUnobservedSubmission?.key, 'GY-NEW0');
  assert.equal(report.oldestUnobservedSubmission?.pr, 800);
  assert.equal(report.oldestUnobservedSubmission?.count, 3);
  assert.ok(Math.abs(report.oldestUnobservedSubmission!.ageMs - 180_000) < 5_000, `aged from its submission (${report.oldestUnobservedSubmission!.ageMs} ms)`);
  assert.equal(observationThroughputStatus(null, { work: fleet, now: new Date(now).toISOString(), jobs: [] }, now).oldestUnobservedSubmission, null, 'none unread, none reported');
});
