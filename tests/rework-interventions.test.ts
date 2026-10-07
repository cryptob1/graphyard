import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { decisionPrecondition } from '../src/model/approval.js';
import { decisionRace } from '../src/server/decision-ledger.js';
import { detectPatterns, foldInterventions, readInterventionLedger, type InterventionLedgerRow } from '../src/interventions.js';
import { routineReworkGround } from '../src/rework-grounds.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1386: 496 rework interventions at the build stage in seven days. Every listed instance is
// replayed from its own ledger rows (tests/fixtures/gy-1386-rework-instances.json: each instance's
// decision.requested and rework rows, trimmed to the fields the grounds read).
interface Instance {
  id: string; key: string; workId: string; stage: string; requestedAt: string; asks: string[];
  decision: { seq: string; at: string; id: string; binding: string | null; situation: { sha: string | null; baseSha: string | null } | null } | null;
  rework: { seq: string; at: string; actor: string; submission: { pr: number; epoch: number } | null; grounds: any };
}
const fixture: { window: { to: string }; instances: Instance[] } = JSON.parse(readFileSync(new URL('./fixtures/gy-1386-rework-instances.json', import.meta.url), 'utf8'));
/** The instances no routine ground explains: a coordinator's own judgement, or GY-1126's rework of a head it no longer described. */
const judged = ['GY-1104', 'GY-957', 'GY-1033', 'GY-1066', 'GY-853', 'GY-528', 'GY-1126'];

const rowsOf = (instance: Instance, grounds = instance.rework.grounds): InterventionLedgerRow[] => [
  ...(instance.decision ? [{ seq: Number(instance.decision.seq), workId: instance.workId, actor: instance.rework.actor, kind: 'decision.requested', at: instance.decision.at, details: null, stageBefore: instance.stage,
    payload: { id: instance.decision.id, action: 'rework', input: { previousWorkerStopped: true, ...(instance.decision.binding ? { binding: instance.decision.binding } : {}) } } }] : []),
  { seq: Number(instance.rework.seq), workId: instance.workId, actor: instance.rework.actor, kind: 'rework', at: instance.rework.at, details: { reason: 'replayed' }, stageBefore: instance.stage,
    work: { key: instance.key, stage: 'build', candidate: grounds.candidate, submission: instance.rework.submission }, grounds },
];
const itemsOf = (instances: Instance[]) => [...new Map(instances.map(instance => [instance.workId, { id: instance.workId, key: instance.key, title: instance.key, stage: 'build' } as unknown as Work])).values()];

test('unit:rework-instances-replayed — every listed instance is read from its own rows: a round answering a ground the loop acts on by itself is no intervention, and only the coordinator judgements remain', () => {
  assert.equal(fixture.instances.length, 493);
  const remaining = new Set<string>();
  for (const instance of fixture.instances) {
    const ground = routineReworkGround(instance.rework.grounds, instance.decision?.binding);
    const folded = foldInterventions(rowsOf(instance), itemsOf([instance]), fixture.window.to).interventions.filter(entry => entry.kind === 'rework');
    assert.equal(folded.length, ground ? 0 : 1, `${instance.id}: ground ${ground}`);
    if (!ground) remaining.add(`${instance.key}@${instance.requestedAt}`);
  }
  assert.deepEqual([...new Set([...remaining].map(entry => entry.split('@')[0]))].sort(), [...judged].sort(), [...remaining].join(', '));
  assert.equal(remaining.size, 7);

  // Folded as one ledger, the build-stage rework pattern keeps only those judgements, none since GY-1126's.
  const rows = fixture.instances.flatMap(instance => rowsOf(instance)).sort((a, b) => a.seq - b.seq);
  const { interventions } = foldInterventions(rows, itemsOf(fixture.instances), fixture.window.to);
  const reworks = interventions.filter(entry => entry.kind === 'rework' && entry.stage === 'build');
  assert.equal(reworks.length, 7);
  assert.ok(reworks.every(entry => entry.requestedAt < '2026-10-05T11:00:00Z'), reworks.map(entry => entry.requestedAt).join(', '));
  const pattern = detectPatterns(interventions, itemsOf(fixture.instances), { threshold: 3, windowDays: 7 }, '2026-10-12T11:00:00Z').find(entry => entry.kind === 'rework' && entry.stage === 'build');
  assert.ok(!pattern || pattern.count < 3, `a week after the last judgement the build-stage rework rate is ${pattern?.count}`);
});

test('unit:rework-instances-replayed — the grounds are read from the record, not from who asked: the same round without its binding is still routine, and a rework of a clean head is still an intervention', () => {
  // The binding alone: the head the rework sent back, without anything else its record shows.
  const bindingAlone = (instance: typeof fixture.instances[number]) => routineReworkGround({ candidate: instance.rework.grounds.candidate }, instance.decision?.binding);
  const bound = fixture.instances.filter(instance => routineReworkGround(instance.rework.grounds, instance.decision?.binding) && bindingAlone(instance));
  assert.equal(bound.length, 377, 'rounds the loop requested under its own situated binding');
  const byHand = fixture.instances.filter(instance => !bindingAlone(instance) && routineReworkGround(instance.rework.grounds));
  assert.equal(byHand.length, 109, 'rounds requested without one, on a ground the record shows');
  const conflicted = byHand.find(instance => routineReworkGround(instance.rework.grounds) === 'conflict')!;
  const clean = structuredClone(conflicted.rework.grounds);
  clean.baseRefresh = null; clean.mergeRefusal = null; clean.observation.conflicting = false; clean.observation.reviews = [];
  clean.observation.checks = clean.observation.checks.map((check: any) => ({ ...check, result: 'success' }));
  assert.equal(routineReworkGround(clean), null);
  assert.equal(foldInterventions(rowsOf(conflicted, clean), itemsOf([conflicted]), fixture.window.to).interventions.filter(entry => entry.kind === 'rework').length, 1);
  // A binding naming another head than the one reworked describes nothing about it.
  assert.equal(routineReworkGround(clean, `${'f'.repeat(40)}:conflict`), null);
  assert.equal(routineReworkGround(clean, `${clean.candidate.sha}:conflict`), 'conflict');
});

test('unit:rework-instances-replayed — a situated rework an approver declined or superseded binds nothing: a later rework of that head by hand is still an intervention, and the declined request is not left waiting', () => {
  const instance = fixture.instances.find(entry => entry.decision?.binding && routineReworkGround({ candidate: entry.rework.grounds.candidate }, entry.decision.binding))!;
  const grounds = { candidate: instance.rework.grounds.candidate };
  assert.ok(routineReworkGround(grounds, instance.decision!.binding), 'the binding alone grounds the round');
  for (const kind of ['decision.declined', 'decision.superseded']) {
    const [requested, rework] = rowsOf(instance, grounds);
    const closed: InterventionLedgerRow = { seq: requested.seq + 1, workId: instance.workId, actor: 'grounds-approver', kind, at: requested.at, details: null, stageBefore: instance.stage, payload: { id: instance.decision!.id, reason: 'a flake' } };
    const folded = (rows: InterventionLedgerRow[]) => foldInterventions(rows, itemsOf([instance]), fixture.window.to).interventions.filter(entry => entry.kind === 'rework');
    assert.equal(folded([requested, rework]).length, 0, 'the loop\'s own round');
    const [byHand] = folded([requested, closed, rework]);
    assert.ok(byHand && byHand.trigger === 'direct' && byHand.resolvedAt === rework.at, `${kind}: the hand rework is counted`);
    assert.equal(folded([requested, closed]).length, 0, `${kind}: nothing waits on a closed request`);
  }
});

test('unit:rework-instances-replayed — GY-1126: a rework bound to a head the item moved past is refused, and its approval settles stale', () => {
  const instance = fixture.instances.find(entry => entry.key === 'GY-1126' && entry.decision?.binding && entry.decision.situation?.sha !== entry.rework.grounds.candidate.sha)!;
  assert.ok(instance, 'the listed GY-1126 instance');
  const work = { stage: 'build', submission: instance.rework.submission, candidate: instance.rework.grounds.candidate } as unknown as Work;
  const input = { previousWorkerStopped: true, binding: instance.decision!.binding };
  assert.match(decisionPrecondition('rework', input, work)!, /bound to 7fccc013ccc5 but the current candidate is 29b1d6974111/);
  assert.deepEqual(decisionRace({ action: 'rework', input } as never, work), { expected: { sha: instance.decision!.binding!.slice(0, 40) }, current: { sha: work.candidate!.sha } });
  // On the head it was bound to, the same request applies as before; a request with no situated binding is judged as before.
  assert.equal(decisionPrecondition('rework', input, { ...work, candidate: { ...work.candidate!, sha: instance.decision!.binding!.slice(0, 40) } } as Work), null);
  assert.equal(decisionPrecondition('rework', { previousWorkerStopped: true, binding: 'build:7:e2f4d2c72a80' }, work), null);
  assert.equal(decisionRace({ action: 'rework', input: { previousWorkerStopped: true } } as never, work), null);
});

// The ledger read resolves a rework row's grounds whether the row stores its document whole or as a delta.
const operator: Principal = { id: 'grounds-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'grounds-worker', role: 'worker', sessionKind: 'ai' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1386;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('rework-grounds'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('rework_grounds_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/rework_grounds_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/grounds'); engine.submissionObserver = null;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('integration:rework-grounds-ledger — a rework of a head GitHub reports conflicting is read with its grounds and is no intervention; a rework of a clean head still is', async () => {
  const head = (seed: string) => seed.repeat(40).slice(0, 40), base = 'b'.repeat(40);
  const submitted = async (name: string, conflicting: boolean) => {
    let work = await engine.execute(operator, 'create', null, { title: name, plannedFiles: [`src/${name}.ts`], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'grounds-host', path: `/tmp/grounds/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
    work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: name.length }, randomUUID());
    const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head(conflicting ? 'c' : 'd'), baseSha: base, pr: name.length, branch: work.workspaces[0].branch, author: worker.id },
      checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: !conflicting, conflicting, merged: false, mergeSha: null,
      baseTip: 'e'.repeat(40), baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString() };
    work = await engine.observe(work.id, work.revision, observation);
    return engine.execute(operator, 'rework', work.id, { reason: `send ${name} back`, previousWorkerStopped: true }, randomUUID());
  };
  const conflicted = await submitted('conflicted', true), clean = await submitted('clean', false);
  const { rows } = await readInterventionLedger(store.pool);
  const reworkRow = (work: Work) => rows.find(row => row.kind === 'rework' && row.workId === work.id)!;
  assert.equal(reworkRow(conflicted).grounds?.observation?.conflicting, true);
  assert.equal(reworkRow(conflicted).grounds?.candidate?.sha, conflicted.candidate!.sha);
  assert.equal(routineReworkGround(reworkRow(conflicted).grounds), 'sync');
  assert.equal(routineReworkGround(reworkRow(clean).grounds), null);
  const { interventions } = foldInterventions(rows, [conflicted, clean], new Date().toISOString());
  assert.deepEqual(interventions.filter(entry => entry.kind === 'rework').map(entry => entry.work?.key), [clean.key]);
  // A second round at the same stage is stored as a delta on the item's full snapshot; the read resolves the same grounds.
  await engine.execute(operator, 'rework', conflicted.id, { reason: 'send it back again', previousWorkerStopped: true }, randomUUID());
  const stored = (await store.pool.query(`SELECT seq, payload ? 'delta' AS delta FROM events WHERE kind='rework' AND work_id=$1 ORDER BY seq DESC LIMIT 1`, [conflicted.id])).rows[0];
  assert.equal(stored.delta, true, 'the second rework row is a delta');
  const again = (await readInterventionLedger(store.pool)).rows.find(row => row.seq === Number(stored.seq))!;
  assert.equal(again.grounds?.candidate?.sha, conflicted.candidate!.sha);
  assert.equal(routineReworkGround(again.grounds), 'sync');
});
