import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { daemonStateSchema, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { mergeRecordKey, mergeWriterIdle, mergeWriterKeptQueue, mergeWriterKeptUnconfirmed, mergeWriterUnconfirmedReplays, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeRecordEvent } from '../src/merge-writer/executor.js';
import { systemInvariants } from '../src/model/invariants.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1852: the merge writer's record retries over a simulated day of the real loop's cycles. The
 * coordinator keeps the receipt rule (a key answers its own input and refuses any other). Some
 * writes reach the server but their replies are lost; for a stretch every reply is lost though the
 * server keeps the write; some keys are refused as reused with different input, in flight and on a
 * replay; and the record route is down for an hour, longer than the replay bound. Some heads fail
 * their trial and the refusal's reply is lost, or its request never arrives until the replay. The
 * writer must request each such rework once, deliver every item (a failed one on its reworked head), push each merge commit once, never send a refused key again, replay each lost
 * write at most the bound, keep its state bounded, keep other items moving once the route is back,
 * and hold every system invariant docs/master-agent.md#system-invariants names.
 */
const minute = 60_000;
const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 3 } } });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the merge writer step called GitHub (${String(name)})`); } });
const docs = fileURLToPath(new URL('../docs/master-agent.md', import.meta.url));
const reused = 'Idempotency key reused with different input';

/** The day's script, by item ordinal and cycle. */
const items = 60, submitEveryMs = 12 * minute, cycleMs = 2 * minute, cycles = (24 * 60) / 2;
const reusedInFlight = (n: number) => n % 13 === 0;
const reusedOnReplay = (n: number) => n % 19 === 0;
const lostReply = (n: number, kind: string) => (n % 17 === 0 && n % 2 === 1 && kind === 'refused') || (n % 7 === 0 && kind === 'trial') || (reusedOnReplay(n) && kind === 'pushed') || (n % 9 === 0 && kind === 'pushed') || (n % 11 === 0 && kind === 'intent');
const repliesLost = (cycle: number) => cycle >= 150 && cycle < 153;
const routeDown = (cycle: number) => cycle >= 300 && cycle < 330;
/** Items whose first head fails its trial: the refusal's reply is lost (odd multiples) or its request first arrives on replay (even). */
const failsTrial = (n: number) => n % 17 === 0;

class World {
  main = [sha('base')];
  pushes: string[] = [];
  receipts = new Map<string, string>();
  stored = new Map<number, MergeRecordEvent[]>();
  sends = new Map<string, number>();
  refusedKeys = new Map<string, number>();
  resent: string[] = [];
  injected = new Set<string>();
  submittedAt = new Map<number, number>();
  reworked = new Map<number, number>();
  merges = new Map<string, string>();
  cycle = 0; lost = 0; down = 0;
  constructor(readonly now: () => number) {}
  tip() { return this.main[0]!; }
  head(n: number) { return sha(this.reworked.has(n) ? `head${n}:rework` : `head${n}`); }
  ledger(n: number) {
    let ledger = null as MergeLedgerState | null;
    for (const event of this.stored.get(n) ?? []) {
      if (event.kind === 'intent') ledger = { key: `GY-${n}`, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (ledger?.events ?? 0) + 1 };
      else if (event.kind === 'pushed' && ledger) ledger = { ...ledger, state: 'pushed', pushedAt: event.pushedAt, events: ledger.events + 1 };
      else if (event.kind === 'reconciled' && ledger) ledger = { ...ledger, state: 'reconciled', observedTip: event.observedTip, events: ledger.events + 1 };
      else if (event.kind === 'refused') ledger = { key: `GY-${n}`, head: event.head, baseTip: null, mergeSha: null, risk: null, intentAt: null, pushedAt: null, observedTip: null, events: 1, ...ledger, state: 'refused', refusal: { kind: 'merge', reason: event.reason } };
    }
    return ledger;
  }
  snapshot(): Work[] {
    const now = this.now();
    return [...this.submittedAt].filter(([, at]) => at <= now).map(([n, at]) => {
      const ledger = this.ledger(n), head = this.head(n), delivered = ledger?.state === 'reconciled' && ledger.head === head;
      const candidate = { sha: head, baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return {
        id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(at),
        ready: true, epoch: 1, lease: null, workspaces: [], submission: { epoch: 1, pr: n }, candidate, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, violations: [], mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.tip(), baseTipContained: true, at: iso(now) },
        gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'merge', reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt ?? iso(now), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as unknown as Work;
    });
  }
  ports(): MergeWriterReads {
    const world = this;
    return {
      baseBranch: 'main', retrials: 3, now: this.now, merger: async () => 'control-plane',
      fetch: async () => world.tip(),
      merge: async (head, baseTip) => { const mergeSha = sha(`merge:${head}:${baseTip}`); world.merges.set(mergeSha, head); return { mergeSha, files: ['src/app.ts'] }; },
      trial: async mergeSha => ({ build: [...world.submittedAt.keys()].some(n => failsTrial(n) && world.merges.get(mergeSha) === sha(`head${n}`)) ? 'fail' : 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: mergeSha, files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }),
      push: async (mergeSha, baseTip) => { if (baseTip !== world.tip()) return 'rejected'; world.main.unshift(mergeSha); world.pushes.push(mergeSha); return 'pushed'; },
      holds: async mergeSha => world.main.includes(mergeSha),
      record: async (item, event) => {
        const n = Number(item.key.slice(3)), key = mergeRecordKey(item, event), input = JSON.stringify(event);
        world.sends.set(key, (world.sends.get(key) ?? 0) + 1);
        if (world.refusedKeys.has(key)) world.resent.push(key);
        const refuse = () => { world.refusedKeys.set(key, world.cycle); throw Object.assign(new Error(`Graphyard refused work/${item.id}/merge-record (409): ${reused}`), { status: 409 }); };
        if (routeDown(world.cycle)) { world.down += 1; throw Object.assign(new Error('merge-record: route down (HTTP 503)'), { status: 503 }); }
        // A merge in flight whose intent key the server already holds with other input.
        if (event.kind === 'intent' && reusedInFlight(n) && !world.injected.has(`flight:${n}`)) { world.injected.add(`flight:${n}`); refuse(); }
        // A failed trial's refusal that never reaches the server the first time: nothing stored, no reply.
        if (event.kind === 'refused' && failsTrial(n) && n % 2 === 0 && !world.injected.has(`dropped:${n}`)) { world.injected.add(`dropped:${n}`); world.lost += 1; throw new Error('connect ECONNREFUSED'); }
        const held = world.receipts.get(key);
        if (held !== undefined) {
          if (held !== input) refuse();
          if (repliesLost(world.cycle)) { world.lost += 1; throw new Error('socket hang up'); }
          return { receipt: key };
        }
        world.receipts.set(key, input);
        world.stored.set(n, [...(world.stored.get(n) ?? []), event]);
        const scripted = lostReply(n, event.kind) && !world.injected.has(`lost:${n}:${event.kind}`);
        if (scripted || repliesLost(world.cycle)) {
          if (scripted) world.injected.add(`lost:${n}:${event.kind}`);
          // Another writer's input now holds this key, so its replay is refused as reused.
          if (scripted && reusedOnReplay(n) && event.kind === 'pushed') world.receipts.set(key, JSON.stringify({ ...event, pushedAt: iso(start) }));
          world.lost += 1;
          throw new Error('socket hang up');
        }
        return { stored: key };
      },
    };
  }
}

test('unit:soak-merge-record-retry — a simulated day of lost record replies, a stretch of kept-but-unanswered writes, reused-key refusals in flight and on replay, failed-trial refusals whose reply is lost or which first arrive on replay, and an hour-long record outage past the replay bound: each such rework requested once, every item delivered with one push of its merge commit, no refused key sent again, each lost write replayed at most the bound, state bounded, other items moving once the route is back, and every system invariant holding', { timeout: 300_000 }, async () => {
  let now = start;
  const world = new World(() => now);
  for (let n = 1; n <= items; n++) world.submittedAt.set(n, start + n * submitEveryMs);
  const reads = world.ports();
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: world.snapshot(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
    rework: async (item: Work) => { const n = Number(item.key.slice(3)); world.reworked.set(n, (world.reworked.get(n) ?? 0) + 1); },
    github: githubDouble, merge: githubDouble, mergeWriter: reads } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const invariantNames = new Set<string>();
  const details: string[] = [];
  let heldDuringOutage = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * cycleMs; world.cycle = cycle;
    const result = await runCycle(config, state, effects, () => now);
    details.push(...result.actions.filter(action => action.kind === 'merge').map(action => action.detail));
    await mergeWriterIdle(state);
    const unconfirmed = state.mergeWriter.unconfirmed ?? [];
    if (routeDown(cycle) && unconfirmed.length) heldDuringOutage += 1;
    assert.ok(unconfirmed.length <= mergeWriterKeptUnconfirmed && state.mergeWriter.queue.length <= mergeWriterKeptQueue, `cycle ${cycle}: the state is bounded`);
    assert.ok(unconfirmed.every(entry => entry.replays < mergeWriterUnconfirmedReplays), `cycle ${cycle}: no write is kept past the replay bound`);
    for (const check of state.invariants.report) { invariantNames.add(check.invariant); assert.ok(check.holds, `cycle ${cycle}: invariant ${check.invariant} is violated: ${check.line}`); }
  }
  const final = world.snapshot();
  assert.equal(final.length, items);
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => item.key), [], `every item is delivered by the end of the day: ${details.slice(-5).join(' | ')}`);
  const delivered = final.map(item => item.delivery!.mergeSha);
  assert.equal(new Set(world.pushes).size, world.pushes.length, 'no merge commit was pushed twice');
  assert.deepEqual([...delivered].sort(), [...world.pushes].sort(), 'what was pushed is exactly what was delivered');
  // Every scripted fault happened and was recovered from.
  assert.ok(world.lost > 0 && world.down > 0, 'replies were lost and the route was down');
  assert.ok(details.some(detail => /^Replayed the \w+ record of GY-\d+ .* with its exact input; the server answered its receipt/.test(detail)), 'a lost write was answered its stored receipt on replay');
  assert.ok(details.some(detail => /was refused as a key reused with different input; it is never sent again/.test(detail)), 'a replay refused as reused adopted the ledger');
  assert.ok(details.some(detail => /was refused a record key reused with different input; that key is never sent again/.test(detail)), 'a merge in flight refused as reused was tried again under a new attempt id');
  assert.ok(details.some(detail => new RegExp(`was still unanswered after ${mergeWriterUnconfirmedReplays} replays`).test(detail)), 'the outage outlasted the replay bound and the write was abandoned for the ledger');
  assert.ok(heldDuringOutage > 0, 'new merges were held while a write was owed');
  assert.ok(world.refusedKeys.size > 0, 'keys were refused as reused');
  // Every failed trial's refusal, its reply lost or first stored on replay, had its rework requested exactly once, and the reworked head was delivered.
  const failed = [...world.submittedAt.keys()].filter(failsTrial);
  assert.ok(failed.some(n => n % 2 === 0) && failed.some(n => n % 2 === 1), 'both refusal faults were injected');
  assert.deepEqual(failed.map(n => [n, world.reworked.get(n)]), failed.map(n => [n, 1]), 'each failed trial grounded exactly one rework');
  assert.deepEqual([...world.reworked.keys()].sort((a, b) => a - b), failed, 'no other item was reworked');
  for (const n of failed) assert.equal(final.find(item => item.key === `GY-${n}`)!.candidate!.sha, sha(`head${n}:rework`), `GY-${n} was delivered on its reworked head`);
  assert.deepEqual(world.resent, [], 'no key was sent again after the server refused it as reused');
  for (const [key, count] of world.sends) assert.ok(count <= 1 + mergeWriterUnconfirmedReplays, `${key} was sent ${count} times, past the replay bound`);
  // Other items kept moving: no head waited more than three hours, and items submitted during the outage were delivered after it.
  for (const item of final) { const waited = Date.parse(item.delivery!.mergedAt) - Date.parse(item.stageEnteredAt); assert.ok(waited <= 180 * minute, `${item.key} waited ${waited / minute} minutes`); }
  assert.ok(final.some(item => Date.parse(item.delivery!.mergedAt) >= start + 330 * cycleMs), 'items were delivered once the route was back');
  assert.equal(state.mergeWriter.unconfirmed, undefined, 'no write is still owed');
  assert.deepEqual(daemonStateSchema.parse(JSON.parse(JSON.stringify(state))).mergeWriter, state.mergeWriter);
  const guide = readFileSync(docs, 'utf8');
  const section = guide.slice(guide.indexOf('### System invariants'), guide.indexOf('## Research and diagnosis'));
  for (const invariant of systemInvariants) { assert.ok(section.includes(`\`${invariant}\``), `docs/master-agent.md#system-invariants names ${invariant}`); assert.ok(invariantNames.has(invariant), `${invariant} was judged over the day`); }
});
