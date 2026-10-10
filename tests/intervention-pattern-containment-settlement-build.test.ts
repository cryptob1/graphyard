import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containmentGraceMs, containmentSettleWaitBoundMs, handSettlementRefusal } from '../src/model/containment.js';
import { routineDecision } from '../src/daemon/decisions.js';
import { workAttentionOwner } from '../src/master/attention.js';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import type { Work } from '../src/model.js';
import type { SessionHandle } from '../src/model/sessions.js';
import { fenced as fencedItem, host, iso, loop, minute, running as runningHandle, scopeOf, world as fleet } from './helpers/containment-settlement-world.js';

// GY-1633 names this file for its proof: manual:intervention-pattern-containment-settlement-build.
// Three containment settlements were needed at the build stage between 2026-10-03 and 2026-10-10,
// each a fence somebody other than the loop's own in-bound settlement lowered. Each, judged from the
// ledger rows it names:
//
//   - GY-1627 (quarantine#2474443, recover#2474736): the item was closed as a duplicate while its
//     epoch-1 worker still ran. The fence outlived the closure, and the loop's reclaim step settled
//     only open items' fences, so its decisions step put a hand `recover` to the approver instead.
//     The reclaim step now settles a delivered item's verified-dead fence too, and the `recover`
//     decision is asked only of a fence still standing past the settle bound.
//   - GY-1520 (quarantine#2406390, autosettle#2408518): epoch 4 submitted PR #1004 at 07:27 and its
//     supervisor left the fence standing. The loop closed a submitted attempt's session only once the
//     item left build, so the fence stood 2.5 hours until CI moved the item to review at 09:58, when
//     that close settled it at once. The loop now closes a submitted attempt's session as soon as its
//     fence is past the grace window with no lease, and settles the fence in that action.
//   - GY-1410 (quarantine#2343388, autosettle#2345723): the master settled the fence by hand, five
//     minutes after its lease lapsed, because master status told it to ("run master settle-containment").
//     Inside the settle bound the fence is the loop's: master status now names the loop's step, not the
//     command, and `master settle-containment` refuses a fence still in motion.

const scope = scopeOf('GY-1520');
const fenced = (lapsedMs: number, overrides: Partial<Work> = {}) => fencedItem('GY-1520', lapsedMs, overrides);
const running = (pane: string) => runningHandle('GY-1520', pane);
/** One item's world: its plane record, its supervisor and the panes the loop closed. */
function world(initial: Work, supervisorRunning: boolean) {
  const built = fleet([initial], supervisorRunning ? [initial.key] : []);
  return { plane: { get item() { return built.plane.items.get(initial.id)!; }, settles: built.plane.settles }, supervisor: { panesClosed: built.panesClosed }, effects: built.effects };
}
const clone = <T>(value: T): T => structuredClone(value);

test('manual:intervention-pattern-containment-settlement-build — GY-1520: a submitted attempt whose fence outlived its grace window has its session closed and its fence settled by the loop while the item is still in build', async () => {
  // Three minutes past the lease: past the two-minute grace window, well inside the settle bound.
  const submitted = fenced(3 * minute, { submission: { epoch: 4, pr: 1004 }, sessions: [running('w1:pM68')] });
  const { plane, supervisor, effects } = world(submitted, true);
  const harness = await loop(effects, () => [clone(plane.item)]);
  try {
    const cycle = await harness.run();
    assert.equal(plane.item.stage, 'build', 'the item never left build');
    assert.deepEqual(supervisor.panesClosed, ['w1:pM68'], 'the loop closed the submitted attempt\'s pane');
    const handle = plane.item.sessions?.find(entry => entry.id === 'worker-a:4');
    assert.equal(handle?.state, 'finished');
    assert.match(handle?.outcome ?? '', /^closed by the loop: GY-1520 epoch 4 submitted pull request #1004 and holds no lease, yet its containment fence still stands past the grace window/);
    assert.equal(plane.item.containmentQuarantine, null, 'and settled the fence in that action');
    assert.deepEqual(plane.settles, ['GY-1520'], 'once, by the loop');
    assert.match(cycle.actions.find(action => action.kind === 'close' && action.work === 'GY-1520')?.detail ?? '', /its containment fence was settled/);
  } finally { await harness.cleanup(); }
});

test('manual:intervention-pattern-containment-settlement-build — GY-1520: inside its grace window a submitted attempt\'s supervisor is left to settle its own fence', async () => {
  const submitted = fenced(30_000, { submission: { epoch: 4, pr: 1004 }, sessions: [running('w1:pM68')] });
  const { plane, supervisor, effects } = world(submitted, true);
  const harness = await loop(effects, () => [clone(plane.item)]);
  try {
    await harness.run();
    assert.deepEqual(supervisor.panesClosed, []);
    assert.equal(plane.item.sessions?.find(entry => entry.id === 'worker-a:4')?.state, 'running');
    assert.notEqual(plane.item.containmentQuarantine, null);
  } finally { await harness.cleanup(); }
  // A live lease is an attempt still at work, whatever its submission says.
  const leased = fenced(-10 * minute, { lease: { owner: 'worker-a', epoch: 4, expiresAt: iso(10 * minute) }, submission: { epoch: 4, pr: 1004 }, sessions: [running('w1:pM68')] });
  const live = world(leased, true);
  const again = await loop(live.effects, () => [clone(live.plane.item)]);
  try {
    await again.run();
    assert.deepEqual(live.supervisor.panesClosed, []);
  } finally { await again.cleanup(); }
});

test('manual:intervention-pattern-containment-settlement-build — GY-1627: a delivered item\'s verified-dead fence is settled by the loop\'s reclaim step, and no recover decision is asked of it inside the settle bound', async () => {
  const closed = fenced(3 * minute, { stage: 'done', sessions: [{ ...running('w1:pN5F'), state: 'finished', outcome: 'closed by the loop: GY-1627 has left build, the stage this implementation session was launched for, and is now in done; pane w1:pN5F closed', endedAt: iso(-5 * minute) } as unknown as SessionHandle] });
  const { plane, effects } = world(closed, false);
  const harness = await loop(effects, () => [clone(plane.item)]);
  try {
    await harness.run();
    assert.equal(plane.item.containmentQuarantine, null, 'the loop settled the delivered item\'s fence');
    assert.deepEqual(plane.settles, ['GY-1520']);
    assert.equal(harness.state.actions['settle:work-GY-1520:4']?.state, 'done');
  } finally { await harness.cleanup(); }

  // The decision the loop would otherwise ask: none while the reclaim step is settling it, a
  // recovery only for a fence the loop could not settle within its bound.
  const config = (await loop({}, () => [])).config;
  const assessment = { key: 'GY-1520', epoch: 4, settleable: true, refusals: [], host, scope, verification: null, attestation: '' } as any;
  assert.equal(routineDecision(closed, config, Date.now(), assessment), null);
  const stranded = fenced(containmentGraceMs + containmentSettleWaitBoundMs + minute, { stage: 'done' });
  assert.equal(routineDecision(stranded, config, Date.now(), assessment)?.action, 'recover');
});

test('manual:intervention-pattern-containment-settlement-build — GY-1410: inside the settle bound master status names the loop\'s step and a hand settlement is refused; past it the command is the master\'s', () => {
  const now = Date.now();
  const settling = fenced(5 * minute);
  assert.match(handSettlementRefusal(settling, now) ?? '', /^GY-1520's containment fence of epoch 4 is the loop's to settle: its reclaim step verifies the host and settles it within 10 minutes of its grace window ending/);
  for (const cause of ['containment-settleable', 'containment-grace'] as const) {
    const owner = workAttentionOwner(settling, cause, now);
    assert.equal(owner.role, 'control plane', `${cause} inside the bound is the loop's`);
    assert.match(owner.next, /^Nothing to run by hand: the loop's reclaim step verifies the host and settles GY-1520's fence itself/);
  }
  const stranded = fenced(containmentGraceMs + containmentSettleWaitBoundMs + minute);
  assert.equal(handSettlementRefusal(stranded, now), null);
  assert.deepEqual([workAttentionOwner(stranded, 'containment-settleable', now).role, workAttentionOwner(stranded, 'containment-settleable', now).next], ['master', 'graphyard master settle-containment GY-1520 REASON']);
  // A fence with no deadline to date it was never the loop's to time, so the command stays the master's.
  assert.equal(handSettlementRefusal(fenced(0, { containmentQuarantine: { owner: 'worker-a', epoch: 4, at: iso(0), settlementHash: 'a'.repeat(64) } as Work['containmentQuarantine'] }), now), null);
});

test('manual:intervention-pattern-containment-settlement-build — the loop\'s settlement of each instance inside its bound is no containment-settlement intervention', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 3, minutes)).toISOString();
  let seq = 0;
  const rows: InterventionLedgerRow[] = [];
  const work = ['GY-1627', 'GY-1520', 'GY-1410'].map(key => ({ id: `work-${key}`, key, title: key, stage: key === 'GY-1627' ? 'done' : 'build' } as unknown as Work));
  for (const item of work) {
    const row = (kind: string, minutes: number, actor: string, details: unknown) => rows.push({ seq: ++seq, workId: item.id, actor, kind, at: at(minutes), details, stageBefore: 'build', work: { key: item.key, stage: item.stage, epoch: 1 } });
    row('quarantine', 0, 'graphyard-claude-1', { epoch: 1 });
    // Lapsed at minute 8; the loop settles it at minute 11, a minute past the grace window.
    row('autosettle', 11, 'graphyard-master', { epoch: 1, origin: 'loop', lapsedAt: at(8), reason: 'The master loop verified on vishrog that the supervisor of epoch 1 is gone' });
  }
  const { interventions } = foldInterventions(rows, work, at(30));
  assert.deepEqual(interventions.filter(entry => entry.kind === 'containment-settlement'), []);
});
