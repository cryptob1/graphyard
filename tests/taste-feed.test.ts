import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { isDelivered, type Principal, type Work } from '../src/model.js';
import OverviewPage from '../web/pages/overview.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { boardFromStatus } from '../src/model/board.js';
// @ts-expect-error Dependency-free dashboard fixtures (scripts/dashboard-fixture.mjs).
import { fixtureStatus } from '../scripts/dashboard-fixture.mjs';

// The fixtures file items, and every item owes an e2e proof; they declare the serve one needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3393: the Taste feed. A delivered item appears on the Work page with its why sentence and its
// evidence; Looks good records the taste and the card leaves; Send back with a note files the note
// as a follow-up item's reason beside a proposed master lesson carrying it; and no taste reopens or
// holds the delivery — all against a real Postgres and the real routes.
const repository = 'owner/taste-feed';
const operator: Principal = { id: 'taste-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'taste-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, worker].map(principal => ({ ...principal, token: `taste-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const call = async (principal: Principal, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (principal: Principal, path: string, body?: unknown) => {
  const result = await call(principal, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const snapshot = async (): Promise<Work[]> => (await ok(operator, 'work-snapshot')).work;

/** A delivered item as the control plane leaves one after its merge: create it, then settle the delivery directly. */
async function delivered(title: string, why: string): Promise<Work> {
  const created = await ok(operator, 'work', { title, type: 'feature', summary: why, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }] }) as Work;
  const sha = 'abcdef1234567890abcdef1234567890abcdef12', mergedAt = new Date().toISOString();
  const candidate = { sha, baseSha: sha, pr: 42, branch: 'graphyard/gy-delivery', author: 'w' };
  const document = {
    ...await reload(created.id), stage: 'done', candidate, submission: { epoch: 1, pr: 42 },
    observation: { candidate, checks: [], reviews: [], protected: true, mergeable: true, merged: true, mergeSha: sha, mergedAt, files: [], at: mergedAt },
    delivery: { mergeSha: sha, mergedAt, authorizationRevision: 1, pr: 42 },
    evidence: [{ id: randomUUID(), proof: 'e2e:fixture', sha, baseSha: sha, policyRevision: 1, producer: 'taste-producer', trusted: true, result: 'pass', executed: 1, skipped: 0, at: mergedAt }],
    gates: ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] })),
  };
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [created.id, JSON.stringify(document)]);
  return reload(created.id);
}

/** The Work page rendered over the snapshot the dashboard polls, as the browser draws it. */
function page(work: Work[]) {
  const noop = () => {};
  const dashboard = { token: 'fixture', work, board: boardFromStatus(work, Date.now(), null), status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: null, view: 'work', setView: noop,
    filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: Date.now(), jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {}, events: [], editingRequirements: false, setEditingRequirements: noop, sessionEpoch: { current: 0 }, api: async () => ({}),
    refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop } as unknown as Dashboard;
  return renderToStaticMarkup(createElement(OverviewPage, dashboard));
}
/** The Taste section's cards, as `data-taste-card` marks them. */
const cards = (html: string) => [...html.matchAll(/data-taste-card="([^"]+)"/g)].map(match => match[1]);

before(async () => {
  store = await withDatabase('taste-feed'); await store.init();
  engine = new Engine(store, 300, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('integration:taste-looks-good — a delivered item shows in Taste with its why and evidence, and the taste records without touching the delivery', async () => {
  const work = await delivered('A shipped thing', 'The delivery’s why sentence.');
  assert.ok(isDelivered(work));
  // The served snapshot carries the summary a delivery becomes, its why sentence beside the marker…
  const served = (await snapshot()).find(item => item.id === work.id)!;
  assert.equal((served as any).summary, true);
  assert.equal((served as any).plainSummary, 'The delivery’s why sentence.');
  // …and the Work page shows its card with both.
  const html = page(await snapshot());
  assert.deepEqual(cards(html), [work.key]);
  assert.match(html, /The delivery’s why sentence\./);
  assert.match(html, /e2e:fixture · 1 executed/);
  // Looks good records the taste.
  const tasted = await ok(operator, `work/${work.id}/taste`, { verdict: 'good' }) as Work;
  assert.equal(tasted.taste?.verdict, 'good');
  assert.equal(tasted.taste?.by, operator.id);
  assert.equal(tasted.taste?.note, undefined);
  // The delivery never waited: the item stays delivered, its record and delivery untouched.
  const afterTaste = await reload(work.id);
  assert.equal(afterTaste.stage, 'done');
  assert.equal(afterTaste.delivery?.mergedAt, work.delivery?.mergedAt);
  assert.ok(isDelivered(afterTaste));
  assert.equal((await store.pool.query('SELECT actor, kind FROM events WHERE work_id=$1 AND kind=\'taste\'', [work.id])).rows[0]?.actor, operator.id);
  // The card leaves the feed: the snapshot's summary carries the taste and the page shows none.
  const servedAfter = (await snapshot()).find(item => item.id === work.id)!;
  assert.equal((servedAfter as any).taste?.verdict, 'good');
  assert.deepEqual(cards(page(await snapshot())), []);
  // A taste is once.
  assert.equal((await call(operator, `work/${work.id}/taste`, { verdict: 'good' })).status, 409);
});

test('integration:taste-send-back — the note files a follow-up whose reason it is, beside a proposed lesson, and only the owner tastes', async () => {
  const work = await delivered('Another shipped thing', 'The second delivery’s why sentence.');
  const note = 'The empty state wording reads like an error.';
  // Taste is the owner's own action.
  assert.equal((await call(worker, `work/${work.id}/taste`, { verdict: 'good' })).status, 403);
  assert.equal((await call(operator, `work/${work.id}/taste`, { verdict: 'send-back' })).status, 400, 'a send-back carries its note');
  const tasted = await ok(operator, `work/${work.id}/taste`, { verdict: 'send-back', note }) as Work;
  assert.equal(tasted.taste?.verdict, 'send-back');
  assert.equal(tasted.taste?.note, note);
  // The follow-up: the note is its reason, and the proposed lesson carries it.
  const followUpKey = tasted.taste!.followUp!.key;
  const followUp = await ok(operator, `work/${followUpKey}`);
  assert.equal(followUp.stage, 'backlog');
  assert.equal(followUp.type, 'bug');
  assert.match(followUp.description, new RegExp(note));
  assert.deepEqual(followUp.origin?.proposedLesson, { text: note, from: work.key, by: operator.id, at: followUp.origin?.proposedLesson?.at });
  assert.ok(followUp.origin?.proposedLesson?.at);
  assert.deepEqual(followUp.criteria[0].proofs, ['unit:taste-follow-up', 'e2e:fixture'], 'the follow-up reuses the delivered item’s e2e case');
  assert.match(followUp.criteria[0].text, new RegExp(note));
  // The delivered item stays delivered and tasted; the follow-up is its own item, never a reopening.
  const after = await reload(work.id);
  assert.equal(after.stage, 'done');
  assert.equal(after.reworkRequested, false);
  assert.equal(after.taste?.followUp?.key, followUpKey);
  assert.ok(isDelivered(after));
  // And nothing waits: the follow-up sits in the backlog like any filed item.
  const board = await ok(operator, 'board');
  assert.ok(board.groups.backlog.some((entry: any) => entry.key === followUpKey));
  assert.deepEqual(cards(page(await snapshot())), [], 'both deliveries are tasted, so the feed is empty');
});

test('integration:taste-refuses-what-has-not-shipped — Taste tastes delivered work only', async () => {
  const open = await ok(operator, 'work', { title: 'Not shipped yet', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }] }) as Work;
  const refused = await call(operator, `work/${open.id}/taste`, { verdict: 'good' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /has not shipped/);
  assert.equal((await reload(open.id)).taste ?? null, null);
});
