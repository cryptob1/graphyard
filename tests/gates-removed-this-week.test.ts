import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { lessonsToCode } from '../src/daemon/lessons-to-code.js';
import { lessonCommand } from '../src/master/lessons.js';
import { masterLessons, readProjectMemory, writeProjectMemory } from '../src/project-memory.js';
import type { Principal, Work } from '../src/model.js';
import TopBar from '../web/components/top-bar';

// GY-3399: after a lesson-to-code item is delivered and its lesson removed, the dashboard header
// shows gates removed this week beside reverts this week, each count linking to its items — read
// from the real control plane's /api/status over the checkout's gate record and project memory.

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
let store: Store, http: ReturnType<typeof server>, url: string, root: string;

before(async () => {
  root = await temporaryDirectory('gates-removed-root');
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  store = await withDatabase('gates-removed-this-week'); await store.init();
  http = server(new Engine(store, 120, 'owner/game'), [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
  delete process.env.GRAPHYARD_REPOSITORY_ROOT;
});

const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${path}-${Math.random()}` }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json() as any;
  assert.ok(response.ok, `${path}: ${json?.error}`);
  return json;
};
const header = (status: unknown, work: Work[], opened: string[] = []) =>
  renderToStaticMarkup(createElement(TopBar, { view: 'work', setView: () => {}, setSelected: (id: string) => opened.push(id), status, selected: null, features: {}, work, observedAt: Date.now() } as unknown as Parameters<typeof TopBar>[0]));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('e2e:gates-removed-this-week — a delivered lesson-to-code item removes its lesson and the header shows gates removed this week beside reverts this week, linking to the items', async () => {
  // Before anything: both counts read zero, beside each other.
  let status = await api('status');
  assert.deepEqual(status.thisWeek, { reverts: 0, revertedItems: [], gatesRemoved: 0, gatesRemovedItems: [] });
  assert.match(text(header(status, [])), /Reverts this week: 0 · Gates removed this week: 0/);

  // The master marks a lesson enforceable; the loop's pass files its item through the real control plane.
  const deps = { status: async () => ({ actor: { id: 'graphyard-master', role: 'coordinator' } }) };
  const lesson = (await lessonCommand(root, 'graphyard-master', ['add', 'Never import from src/server inside src/model', '--enforceable'], deps) as { recorded: { id: string } }).recorded;
  const memory = await readProjectMemory(root);
  await lessonsToCode(memory, [], Date.now(), async (input, key) => {
    const response = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) });
    return response.json() as Promise<{ key?: string }>;
  }, () => {});
  const filed = masterLessons(memory).find(entry => entry.id === lesson.id)!.filedAs!;
  assert.match(filed, /^GY-\d+$/, 'the pass filed a real item');

  // A batch-gate revert this week, of another real item.
  const culprit = await api('work', { type: 'chore', title: 'A change the batch gate reverted', criteria: [{ id: 'AC-1', text: 'Kept', proofs: ['unit:kept', 'e2e:smoke'] }] });
  await writeGateRecord(gateRecordPath(root), { ...bootstrapGate('owner/game', 'c'.repeat(40)), reverts: [{ item: culprit.key, at: new Date().toISOString() }] });

  // The item is delivered: the next pass removes the lesson, and the loop mirrors its memory to the file.
  const delivered = { id: 'delivered', key: filed, stage: 'done', delivery: { mergedAt: new Date().toISOString(), mergeSha: 'a'.repeat(40) } } as unknown as Work;
  await lessonsToCode(memory, [delivered], Date.now(), undefined, () => {});
  assert.equal(masterLessons(memory).length, 0, 'the lesson left memory');
  await writeProjectMemory(root, memory);

  status = await api('status');
  assert.deepEqual(status.thisWeek, { reverts: 1, revertedItems: [culprit.key], gatesRemoved: 1, gatesRemovedItems: [filed] });
  const work = (await api('work-snapshot')).work as Work[];
  const html = header(status, work);
  assert.match(text(html), new RegExp(`Reverts this week: 1 ${culprit.key} · Gates removed this week: 1 ${filed}`), 'the two counts sit side by side, each naming its items');
  const line = /<p class="week-line" data-reverts="1" data-gates-removed="1">(.*?)<\/p>/.exec(html);
  assert.ok(line, 'the header carries the week line');
  assert.ok(line![1].includes(`href="#${filed}"`) && line![1].includes(`href="#${culprit.key}"`), 'each item is a link');
  assert.ok(work.some(item => item.key === filed) && work.some(item => item.key === culprit.key), 'the linked items are the real items the dashboard opens');
});
