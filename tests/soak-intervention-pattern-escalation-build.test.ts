import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { emptyDaemonState, retainedActions, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { Engine } from '../src/engine.js';
import { Store, save } from '../src/store.js';
import { systemInvariants } from '../src/model/invariants.js';
import { foldInterventions, readInterventionLedger } from '../src/interventions.js';
import { maxAutomaticClears } from '../src/model/blocker-class.js';
import { recordBlockerProbe } from '../src/server/blocker-probe.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1768. The loop's blocker step now clears a worker's `blocked` report on an item held for the
 * loop — loop-owned (GY-1760) or a post-deploy follow-up waiting for the loop's own reading
 * (GY-1762) — when the report's cause is only that a worker cannot take the reading the item owes.
 * The clear is a decision and write path executed for every open item on every cycle, so this soak
 * runs the real loop over a simulated day against the four linked build-stage escalations
 * (GY-1696, GY-1674, GY-1724, GY-1725) beside blockers that must stand on the very same shapes:
 * a master checkout configuration actually missing, an unrelated failure of the item itself, and
 * an item with code a worker can still write. Each eligible report is cleared within its first
 * cycles, returns once more mid-day when the report is recorded again, and is cleared again under
 * the automatic-clear cap; each ineligible one is handed to the master exactly once and never
 * cleared. After every cycle every system invariant holds; the cursor stays within its retention
 * bound with no failed step; the loop dispatches none of the held items; and the fold reads no
 * open build-stage escalation on an item the loop holds — nothing waits on a person for a report
 * that was moot — while the actionable ones stand for whoever can act on them.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-13T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const step = 2 * minute, days = 1;

const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/nonexistent/gy-1768-soak.token', cliPath: 'bin/graphyard.mjs',
  repository: 'owner/escalation-build', baseBranch: 'main', githubAppId: 15368, hostId: 'soak-host', masterAgentName: 'graphyard-master-soak', workers: [], run: { intervalSeconds: 120 } });

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'graphyard', role: 'coordinator', sessionKind: 'ai' };

const release = 'ba607f8a809ed20fea15387e1934425cacbfef9f';
// The four linked reports, as each worker's ledger row recorded its cause (see
// tests/intervention-pattern-escalation-build.test.ts, where each is replayed against the base),
// beside the two actionable causes and the code-bearing shape whose report must stand.
const reports = {
  'GY-1696': "blocked on epoch 3: AC-1 is a live observation (manual:checkout-restore-clears-drift-pin-on-serving-release) whose proof authority is operator/production-operator-admin/production-acceptance-producer, not a worker (graphyard diagnose GY-1696). The item has no plannedFiles and no diff, so there is no PR to submit. Blocked command: graphyard master status in this worktree, error: '.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'. A master-role session should record that proof from this reading.",
  'GY-1674': "AC-1 needs a doctor-issued master checkout-restore and a reading of master status (escalation:dirty-checkout cleared, daemon.upgrade.alignedRelease past ccc0a314). Blocked command: graphyard master status in this worktree (GY-1674-3), error: '.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'. The worker token holds no master role, so the restore cannot be issued or observed from a worker session; this needs a master session to observe and record the proof.",
  'GY-1724': "The 24h window has elapsed (07:34Z 10-12..10-13) but no 24h reading is obtainable from this sandbox: the App's advanced delivery log needs a GitHub browser sign-in, and gh api /app returns 401 (no App JWT). No code change is owed; a master/operator with an App-authenticated session must read the log for the window and record manual:webhook-deliveries-clean-24h-on-serving-release.",
  'GY-1725': "The reviewer's remaining AC-1 demands cannot be produced by a worker: a live raise-then-clear transition would need the App webhook failing for an hour, which must not be induced on the serving release, and GET /app/hook/deliveries needs the App JWT, which a worker does not hold. The note already states both limits; what AC-1 still owes is an operator-supplied delivery-log export for the window.",
  configuration: '.graphyard/master.json does not exist: run graphyard install --apply',
  failure: 'npm run build failed: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
} as const;

/** The day's items: the four eligible ones first (their reports the loop clears), then the three that must stand. */
const backlog: { label: string; report: string; input: Record<string, unknown> }[] = [
  { label: 'GY-1696', report: reports['GY-1696'], input: { title: 'Post-deploy verification: the checkout-restore clears the drift pin', type: 'chore', systemDriven: true, plannedFiles: [], criteria: [{ id: 'AC-1', text: 'From this head against the serving release: the doctor-issued master checkout-restore against a clean drifted checkout clears escalation:dirty-checkout, observed in master status', proofs: ['manual:checkout-restore-clears-drift-pin-on-serving-release'] }] } },
  { label: 'GY-1674', report: reports['GY-1674'], input: { title: 'Post-deploy verification: the checkout-restore completes end to end', type: 'chore', systemDriven: true, plannedFiles: [], criteria: [{ id: 'AC-1', text: 'From this head against the serving release: a doctor-issued master checkout-restore completes end to end, observed in master status', proofs: ['manual:checkout-restore-clears-dirty-checkout-on-serving-release'] }] } },
  { label: 'GY-1724', report: reports['GY-1724'], input: { title: 'Post-deploy follow-up: the delivery log reads clean over 24h', type: 'chore', systemDriven: true, plannedFiles: [], description: `Post-deploy follow-up: post-deploy:9e0cf7a2-4b1d-4c18-9d55-2af6b0f4e1a1:AC-2:manual:post-deploy/webhook-deliveries-clean-24h:${release}`,
      criteria: [{ id: 'AC-1', text: 'From this head against the serving release: the App delivery log shows the hour clean over the window', proofs: ['manual:webhook-deliveries-clean-24h-on-serving-release'] }] } },
  { label: 'GY-1725', report: reports['GY-1725'], input: { title: 'Post-deploy follow-up: the github-budget attention row clears', type: 'chore', systemDriven: true, plannedFiles: ['verification/post-deploy-github-budget-row.md'], description: `Post-deploy follow-up: post-deploy:4c7b18e3-92da-4f60-8b31-c75de9a04f02:AC-2:manual:post-deploy/github-budget-attention-row:${release}`,
      criteria: [{ id: 'AC-1', text: 'From this head against the serving release: the github-budget row raises and clears on the serving release', proofs: ['manual:github-budget-attention-row-clears-on-serving-release'] }] } },
  { label: 'configuration', report: reports.configuration, input: { title: 'Post-deploy verification: the master checkout answers (configuration standing)', type: 'chore', systemDriven: true, plannedFiles: [], criteria: [{ id: 'AC-1', text: 'From this head against the serving release: master status reads the aligned release', proofs: ['manual:checkout-restore-clears-dirty-checkout-on-serving-release'] }] } },
  { label: 'failure', report: reports.failure, input: { title: 'Post-deploy verification: the throughput claim is verified (build failing)', type: 'chore', systemDriven: true, plannedFiles: [], criteria: [{ id: 'AC-1', text: 'From this head against the serving release: the throughput claim is verified', proofs: ['manual:throughput-claim-verified'] }] } },
  { label: 'code', report: reports['GY-1724'], input: { title: 'Post-deploy follow-up with code: the delivery-log export is written', type: 'chore', systemDriven: true, plannedFiles: ['src/verify/delivery-export.ts'], description: `Post-deploy follow-up: post-deploy:7d2a55c0-8e34-4a17-b0c9-6f4a29d8b3e1:AC-2:manual:post-deploy/webhook-deliveries-clean-24h:${release}`,
      criteria: [{ id: 'AC-1', text: 'From this head against the serving release: the App delivery log shows the hour clean over the window', proofs: ['manual:webhook-deliveries-clean-24h-on-serving-release'] }, { id: 'AC-2', text: 'The export command behaves', proofs: ['integration:behaves'] }] } },
];
const eligible = backlog.slice(0, 4).map(entry => entry.label), ineligible = backlog.slice(4).map(entry => entry.label);

test('unit:soak-intervention-pattern-escalation-build — a simulated day of the real loop: every loop-held report is cleared within its first cycles and again when it returns, the actionable ones stand for the master, and no escalation recurs', { timeout: 600_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1768;
  const directory = await temporaryDirectory('gy-1768-soak');
  const database = new EmbeddedPostgres({ databaseDir: directory, user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('gy_1768_soak');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/gy_1768_soak`); await store.init();
  try {
    const engine = new Engine(store, 120, 'owner/escalation-build'); engine.submissionObserver = null;
    // The day's items, each carrying its blocked report as the ledger row left it when the release guards landed. The labels map to the keys the control plane assigns.
    const items = new Map<string, Work>(), keyOf = new Map<string, string>();
    for (const entry of backlog) {
      const created = await engine.execute(operator, 'create', null, entry.input, randomUUID()) as Work;
      await store.transaction(async (db, now) => save(db, { ...created, blocker: entry.report }, implementer.id, 'blocked', now, { epoch: created.epoch, reason: entry.report }));
      const held = (await store.list()).find(item => item.id === created.id)!;
      items.set(held.key, structuredClone(held));
      keyOf.set(entry.label, held.key);
    }
    const key = (label: string) => keyOf.get(label)!;

    let now = start;
    const state = emptyDaemonState(config());
    const dispatched: string[] = [], clearedAt = new Map<string, number>(), standingSince = new Map<string, number>();
    const effects = {
      agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
      snapshot: async () => ({ work: [...items.values()].map(entry => structuredClone(entry)), now: iso(now) }),
      closeSession: () => {}, dispatch: async (work: Work) => { dispatched.push(work.key); }, persist: async () => {},
      observeDeployment: async () => ({ source: 'endpoint', sha: release, at: iso(now), reason: null, deployed: [], pending: [] }),
      recordDeployment: async () => {},
      // The loop's pass is judged by the control plane's own route, as in production, and the cleared item is mirrored back into the day's snapshot.
      recordBlockerProbe: async (work: Work, body: Record<string, unknown>) => {
        const updated = await recordBlockerProbe({ engine } as never, coordinator, work.id, body, randomUUID()) as Work;
        items.set(updated.key, structuredClone(updated));
        if (updated.blocker === null && !clearedAt.has(updated.key)) clearedAt.set(updated.key, now);
        return updated;
      },
    } as unknown as DaemonEffects;

    // Mid-day the linked reports are recorded again on their items, as a returning class does; the clear is capped at `maxAutomaticClears` in a row.
    let returned = false;
    const violations: string[] = [];
    for (let cycle = 0; now < start + days * 24 * hour; cycle++, now += step) {
      if (!returned && now >= start + 3 * hour) {
        returned = true;
        for (const entry of backlog.slice(0, 4)) {
          const current = items.get(key(entry.label))!;
          if (current.blocker) continue;
          // The `blocked` command leaves the probe record on the item: its clears count runs across reports until the item submits.
          await store.transaction(async (db, at) => save(db, { ...current, blocker: entry.report }, implementer.id, 'blocked', at, { epoch: current.epoch, reason: entry.report }));
          items.set(key(entry.label), structuredClone((await store.list()).find(item => item.id === current.id)!));
        }
      }
      await runCycle(config(), state, effects, () => now);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);
      assert.deepEqual(Object.keys(state.actions).filter(isolatedKey => isolatedKey.startsWith('isolated:')), [], `cycle ${cycle}: a failure reached an isolation record`);
      // No held item is ever dispatched: the board withholds it before and after the clear.
      assert.deepEqual(dispatched.filter(dispatchedKey => [...keyOf.values()].includes(dispatchedKey)), [], `cycle ${cycle}: a held item was dispatched`);
      // A report stands only inside its episode, and no episode outlasts ten minutes of the loop's cycles.
      for (const entry of backlog) {
        const item = items.get(key(entry.label))!;
        if (item.blocker) { if (!standingSince.has(item.key)) standingSince.set(item.key, now); continue; }
        const since = standingSince.get(item.key);
        if (since === undefined) continue;
        standingSince.delete(item.key);
        assert.ok(now - since <= 10 * minute, `cycle ${cycle}: ${entry.label} carried its report from +${(since - start) / minute} to +${(now - start) / minute} min`);
      }
    }

    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(dispatched, [], 'nothing was dispatched on a day of held items');
    // The eligible items: cleared, then cleared again after the report returned, under the cap.
    for (const label of eligible) {
      const item = items.get(key(label))!;
      assert.equal(item.blocker, null, `${label}: the report does not stand at the day's end`);
      assert.ok((item.blockerProbe?.clears ?? 0) >= 2, `${label}: the report was cleared when first recorded and again when it returned`);
      assert.ok((item.blockerProbe?.clears ?? 0) < maxAutomaticClears, `${label}: within the automatic-clear cap`);
      assert.ok((clearedAt.get(item.key) ?? start + days * 24 * hour) - start <= 10 * minute, `${label}: cleared within its first cycles`);
      const folded = foldInterventions((await readInterventionLedger(store.pool, { workId: item.id })).rows, [item], iso(start + days * 24 * hour)).interventions;
      assert.deepEqual(folded.filter(entry => entry.kind === 'escalation' && entry.resolvedAt === null).map(entry => entry.blocked), [], `${label}: no open escalation stands, so the instance cannot recur`);
    }
    // The ineligible items: handed to the master exactly once, never cleared, still standing, and the fold reads each as the open escalation it is.
    for (const label of ineligible) {
      const item = items.get(key(label))!;
      assert.equal(item.blocker, backlog.find(entry => entry.label === label)!.report, `${label}: the actionable cause is preserved, not discarded`);
      assert.equal(item.blockerProbe?.clears ?? 0, 0, `${label}: the loop never cleared it`);
      assert.ok(standingSince.get(item.key) !== undefined, `${label}: its report stands at the day's end`);
      const folded = foldInterventions((await readInterventionLedger(store.pool, { workId: item.id })).rows, [item], iso(start + days * 24 * hour)).interventions;
      assert.equal(folded.filter(entry => entry.kind === 'escalation' && entry.resolvedAt === null).length, 1, `${label}: the fold reads its standing escalation for the master`);
    }
    // Each actionable cause was handed over exactly once, and nothing else was.
    const handedKeys = Object.values(state.actions).filter(action => action.kind === 'blocker' && /it needs someone/.test(action.detail ?? '')).map(action => action.work);
    assert.deepEqual([...new Set(handedKeys)].sort(), ineligible.map(key).sort(), 'each actionable cause was handed over, and nothing else was');
    assert.equal(handedKeys.length, ineligible.length, 'each hand-over was recorded once');
    // The records stay bounded: the cursor within its retention bound, no failed step, and the fault instances filed once per episode at most — never once per cycle.
    if (process.env.SOAK_TRACE) console.error(`faults: ${JSON.stringify(state.faults.instances.map(instance => ({ subject: instance.subject, kind: instance.kind, faultClass: instance.faultClass })))}`);
    assert.ok(Object.keys(state.actions).length <= retainedActions, `no action backlog past the retention bound: ${Object.keys(state.actions).length}`);
    assert.deepEqual(Object.entries(state.actions).filter(([, action]) => action.state === 'failed').map(([actionKey, action]) => `${actionKey}: ${action.detail}`), [], 'no step failed');
    const pairs = new Map<string, number>();
    for (const instance of state.faults.instances) pairs.set(`${instance.subject}|${instance.kind}`, (pairs.get(`${instance.subject}|${instance.kind}`) ?? 0) + 1);
    assert.deepEqual([...pairs.values()].filter(count => count > 2), [], 'each fault instance is filed at most once per episode, not once per cycle');
    assert.ok(state.faults.instances.length <= 3 * backlog.length, `the day files one reading per item and one attention instance per blocked episode at most: ${state.faults.instances.length}`);
  } finally {
    await store.close();
    await database.stop();
  }
});
