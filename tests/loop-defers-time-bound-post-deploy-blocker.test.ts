import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { blockerStep } from '../src/daemon/cycle-blockers.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { dispatchable } from '../src/coordination.js';
import { groupOf } from '../src/model/board.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1740 AC-2: each cycle the loop holds a blocked, unleased post-deploy follow-up whose recorded blocker names a
// future not-before instant on that instant (`window`), so it is not dispatched before it and leaves Blocked
// without a worker launch. Five of six Blocked rows on 2026-10-12 (GY-1689, GY-1721, GY-1722, GY-1724, GY-1725) were these.

const day = 86_400_000, repository = 'owner/loop-defer';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const loop: Principal = { id: 'graphyard', role: 'coordinator', sessionKind: 'ai' };
const followUp = { id: 'AC-1', text: 'From this head against the serving release f1984c118352: the intervention report shows the escalation rate at the build stage below 3 per 7 days after the change ships', proofs: ['manual:intervention-pattern-escalation-build-on-serving-release'] };
const ordinary = { id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] };

let database: EmbeddedPostgres | undefined;
const stores: Store[] = [];
after(async () => { for (const store of stores) await store.close(); if (database) await database.stop(); });

const config = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/nonexistent/loop-defer.token', cliPath: 'bin/graphyard.mjs',
  repository, baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'master', workers: [] }) as MasterConfig;
function cycleOf(open: Work[], effects: Record<string, unknown>, clock: number) {
  const performed: { detail: string; state: string }[] = [];
  const cycle = { config: config(), state: emptyDaemonState(config()), effects: { persist: async () => {}, ...effects }, now: () => clock, clock, performed, open, agents: [], credentials: {}, snapshot: { work: open },
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), launcher: { busy: () => false } } as unknown as Cycle;
  return { cycle, performed };
}

test('integration:loop-defers-time-bound-post-deploy-blocker — the loop holds a blocked follow-up on the instant its blocker names and clears the blocker: not dispatched before it, out of Blocked, no worker launched', { timeout: 300_000 }, async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1741;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('loop-defer'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('loop_defer');
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/loop_defer`); await store.init(); stores.push(store);
  const engine = new Engine(store, 120, repository); engine.submissionObserver = null;
  const now = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  const blocked = async (criteria: unknown[], reason: string) => {
    let work = await engine.execute(admin, 'create', null, { title: `Item ${randomUUID().slice(0, 8)}`, type: 'chore', criteria }, randomUUID());
    work = await engine.execute(worker, 'claim', (await engine.execute(admin, 'ready', work.id, {}, randomUUID())).id, {}, randomUUID());
    return engine.execute(worker, 'blocked', work.id, { epoch: work.epoch, reason }, randomUUID());
  };

  const start = await now(), until = new Date(start + 2 * day).toISOString();
  // GY-1724's shape: a reading whose 24-hour window has not elapsed on the serving release.
  const waiting = await blocked([followUp], `AC-1's reading cannot exist yet: the 24h window on the serving release ends; not before ${until} can it be observed`);
  // The same words on an item owing no post-deploy reading, a follow-up whose instant has passed, and one too far off to be a wait.
  const notFollowUp = await blocked([ordinary], `Cannot run the proof; not before ${until} can it be observed`);
  const passed = await blocked([followUp], `The observation cannot exist before ${new Date(start - day).toISOString()}`);
  const farOff = await blocked([followUp], `The observation cannot exist before ${new Date(start + 40 * day).toISOString()}`);
  // An operational fault that names an instant is its class's to clear (the quota probe may find another
  // account at once), and a genuine blocker that never speaks of the owed observation is not a wait for it.
  const quota = await blocked([followUp], `worker account quota is exhausted until ${until}`);
  const unrelated = await blocked([followUp], `The vendor sandbox is offline until ${until}`);
  // A leased item is its worker's to defer (`defer GY-N EPOCH …`), never the loop's.
  const leased = { ...waiting, key: 'GY-leased', lease: { owner: 'implementer', epoch: 2, expiresAt: new Date(start + day).toISOString() } } as Work;
  const open = [waiting, notFollowUp, passed, farOff, quota, unrelated, leased];
  assert.equal(groupOf(waiting, start), 'blocked', 'the row the operator saw: Blocked');

  const held: string[] = [], launched: string[] = [];
  const { cycle, performed } = cycleOf(open, {
    deferWindow: async (item: Work, body: { expectedRevision: number; notBefore: string; reason: string }) => { held.push(item.key); return engine.execute(loop, 'window', item.id, body, randomUUID()); },
    recordBlockerProbe: async (item: Work) => item, probeBlocker: async () => null,
    dispatch: async (item: Work) => { launched.push(item.key); }, approver: async (item: Work) => { launched.push(item.key); return { agentName: 'approver' }; },
  }, start);
  await blockerStep(cycle);

  assert.deepEqual(held, [waiting.key], 'only the unleased follow-up whose blocker names a future instant within the bound is held');
  const after = (await store.workDocument(waiting.id))!;
  assert.deepEqual([after.blocker, after.lease, after.observationWindow?.notBefore, after.observationWindow?.basis], [null, null, until, 'operator-hold']);
  assert.ok(performed.some(entry => entry.state === 'done' && entry.detail.startsWith(`Held ${waiting.key} until ${until}`)), 'the cycle reports what it did');
  assert.deepEqual(launched, [], 'no worker launch was spent to call defer');
  for (const untouched of [notFollowUp, passed, farOff, quota, unrelated]) assert.ok((await store.workDocument(untouched.id))!.blocker, `${untouched.key} keeps its blocker`);

  assert.equal(dispatchable(after, start), false, 'not dispatched before the instant');
  assert.equal(dispatchable(after, Date.parse(until) + 1), true, 'dispatched once it passes');
  assert.notEqual(groupOf(after, start), 'blocked', 'it left the Blocked group');

  // The next cycle reads the item unblocked and does nothing more.
  const again = cycleOf([after], { deferWindow: async (item: Work) => { held.push(item.key); return item; }, recordBlockerProbe: async (item: Work) => item }, start + 60_000);
  await blockerStep(again.cycle);
  assert.deepEqual(held, [waiting.key]);

  // A blocker the master clears after the loop read it is never followed by a hold: the write names the revision read.
  const raced = await blocked([followUp], `AC-1's reading cannot exist yet: the 24h window on the serving release ends; not before ${until} can it be observed`);
  await engine.execute(admin, 'unblock', raced.id, { expectedRevision: raced.revision, reason: 'the master took the reading another way' }, randomUUID());
  const stale = cycleOf([raced], { deferWindow: async (item: Work, body: { expectedRevision: number; notBefore: string; reason: string }) => engine.execute(loop, 'window', item.id, body, randomUUID()),
    recordBlockerProbe: async (item: Work) => item, probeBlocker: async () => null }, start);
  await blockerStep(stale.cycle);
  const unblocked = (await store.workDocument(raced.id))!;
  assert.deepEqual([unblocked.blocker, unblocked.observationWindow], [null, undefined], 'the cleared item is not put back on hold');
  assert.ok(stale.performed.some(entry => entry.state === 'failed' && /Task revision changed/.test(entry.detail)), 'the refused hold is reported');
});
