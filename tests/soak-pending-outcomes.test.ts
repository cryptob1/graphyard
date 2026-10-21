import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contractPendingCases, cutCandidate, type CommitSummary, type ReleaseCandidate } from '../src/release-candidate.js';
import { pendingFromPlane, readPlane, servingStage, type PlaneSnapshot } from '../src/release-pending.js';

/**
 * GY-1802: a simulated run of release candidates across days. A merged goal's plan is delivered
 * item by item while main keeps moving; every candidate is cut with the outcomes the plane then
 * holds pending. Asserts the pending state never sticks: it clears on the first candidate cut
 * after the serving item is done, an unreadable plane names none (blocks as before), and an item
 * merged after the candidate's SHA is still undelivered there.
 */
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const source = JSON.stringify({ outcomes: [{ id: 'goal-outcome', title: 'Goal', cases: ['goal-case'] }, { id: 'plain-outcome', title: 'Plain', cases: ['plain-case'] }] });
const day = 24 * 3_600_000;
const start = Date.parse('2030-06-01T00:00:00Z');

test('unit:soak-pending-outcomes — pending outcomes recorded per candidate clear once the serving item is done and never stick', async () => {
  const goals = [{ merged: true, protected: { outcomes: ['goal-outcome'] }, plan: { items: [{ ref: 'a', outcomes: ['goal-outcome'] }] }, items: [{ ref: 'a', key: 'GY-9001' }] }] as any;
  let stage: string | undefined = 'ready';
  let planeUp = true;
  const read = () => readPlane({ goals: async () => { if (!planeUp) throw new Error('403'); return goals; }, stage: async () => stage });
  let latest: ReleaseCandidate | null = null;
  const log: { day: number; pending: string[] | undefined; cases: string[] }[] = [];
  let tip = sha('main-0');
  for (let n = 1; n <= 24; n += 1) {
    tip = sha(`main-${n}`);
    if (n === 9) stage = 'done';
    planeUp = n !== 4 && n !== 5;
    const commits: CommitSummary[] = [{ sha: tip, parents: [sha(`main-${n - 1}`)], subject: `Merge pull request #${n} from graphyard/gy-${9000 + n}-1`, body: '' } as CommitSummary];
    const plane: PlaneSnapshot | null = await read();
    const result = cutCandidate({ tip, now: new Date(start + n * day), trigger: 'schedule', latest, promoted: null, commits, pendingOutcomes: pendingFromPlane(plane, source, { undelivered: new Set() }) });
    assert.ok(result.cut, `candidate ${n} is cut`);
    if (!result.cut) continue;
    latest = result.candidate;
    log.push({ day: n, pending: latest.pendingOutcomes, cases: contractPendingCases(JSON.parse(source), latest.pendingOutcomes) });
  }
  for (const entry of log) {
    const expectPending = entry.day < 9 && entry.day !== 4 && entry.day !== 5;
    assert.deepEqual(entry.pending, expectPending ? ['goal-outcome'] : undefined, `day ${entry.day}`);
    assert.deepEqual(entry.cases, expectPending ? ['goal-case'] : [], `day ${entry.day} cases`);
  }
  assert.equal(log.at(-1)!.pending, undefined, 'the pending state is cleared at the end of the run');
  // An item merged after the candidate's SHA is undelivered there, whatever the plane says.
  stage = 'done';
  assert.deepEqual(pendingFromPlane(await read(), source, { undelivered: new Set(['GY-9001']) }), ['goal-outcome']);
});

test('unit:soak-pending-outcomes — an item closed without delivery does not deliver its outcome', async () => {
  const goals = [{ merged: true, protected: { outcomes: ['goal-outcome'] }, plan: { items: [{ ref: 'a', outcomes: ['goal-outcome'] }] }, items: [{ ref: 'a', key: 'GY-9001' }] }] as any;
  const pendingFor = async (work: any) => pendingFromPlane(await readPlane({ goals: async () => goals, stage: async () => servingStage(work) }), source, { undelivered: new Set() });
  assert.deepEqual(await pendingFor({ stage: 'done', closure: { kind: 'duplicate' } }), ['goal-outcome']);
  assert.deepEqual(await pendingFor({ stage: 'done' }), []);
});

