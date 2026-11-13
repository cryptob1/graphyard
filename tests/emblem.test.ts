import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { emblemByteLimit, readEmblem, validateEmblem } from '../src/model/emblem.js';
import TopBar from '../web/components/top-bar';
import type { Principal } from '../src/model.js';

// GY-3273: each project has an SVG emblem its master draws, shown in the dashboard header and as
// the favicon. The control plane judges the drawing and records it on the event ledger; the
// dashboard's top bar and favicon read it at /favicon.svg, rendered as an image.
const valid = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Night yard</title><rect width="64" height="64" rx="12" fill="#173625"/><path d="M14 32 27 45 50 18" stroke="#c5e69b" stroke-width="7" fill="none"/></svg>';

test('unit:emblem-validation — an emblem is one <svg> root at most 8 KB with no script, no event attribute and no reference outside itself', () => {
  assert.deepEqual(validateEmblem(`  ${valid}  `), { ok: true, svg: valid }, 'a valid emblem is accepted, trimmed');
  assert.deepEqual(validateEmblem('<?xml version="1.0" encoding="UTF-8"?>' + valid), { ok: true, svg: '<?xml version="1.0" encoding="UTF-8"?>' + valid }, 'an XML declaration before the root is accepted');
  const refusals: [string, RegExp][] = [
    ['', /empty/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><script>alert(1)</script></svg>', /script element/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><foreignObject><p>x</p></foreignObject></svg>', /foreignObject/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" onload="alert(1)"><rect width="4" height="4"/></svg>', /onload/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" onclick="alert(1)"/></svg>', /onclick/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><image href="https://example.invalid/x.png"/></svg>', /outside itself/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><use xlink:href="https://example.invalid/x.svg#y"/></svg>', /outside itself/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/>' + '<circle cx="1" cy="1" r="0.5" fill="#c5e69b"/>'.repeat(200) + '</svg>', /8 KB/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg><svg xmlns="http://www.w3.org/2000/svg"/>', /single <svg> root/],
    ['<rects xmlns="http://www.w3.org/2000/svg"/>', /single <svg> root/],
    ['<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>', /namespace/],
  ];
  for (const [svg, reason] of refusals) {
    const checked = validateEmblem(svg);
    assert.equal(checked.ok, false, `refused: ${svg.slice(0, 60)}`);
    assert.match((checked as { reason: string }).reason, reason, 'the refusal names the reason');
  }
  assert.ok(Buffer.byteLength('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/>' + '<circle cx="1" cy="1" r="0.5" fill="#c5e69b"/>'.repeat(200) + '</svg>', 'utf8') > emblemByteLimit, 'the oversize fixture really is over the limit');
});

test('unit:emblem-header — the top bar renders the emblem as an image beside the project name', () => {
  const html = renderToStaticMarkup(createElement(TopBar, { view: 'work', setView: () => {}, status: { repository: 'owner/night-yard' }, selected: null, features: {} } as unknown as Parameters<typeof TopBar>[0]));
  const name = /<p class="project-name"[^>]*>(.*?)<\/p>/.exec(html)![1];
  assert.equal(name, '<img class="project-emblem" src="/favicon.svg" alt=""/>owner/night-yard', 'the emblem img rides beside the project name text, and adds no text of its own');
});

// The route side: POST /api/emblem with the master's identity, GET /favicon.svg with the result.
let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const operator: Principal = { id: 'operator', role: 'admin' };
const master: Principal = { id: 'master', role: 'coordinator' };
const reader: Principal = { id: 'reader', role: 'reader' };
const worker: Principal = { id: 'worker', role: 'worker' };
const principals = [operator, master, reader, worker];
const token = (actor: Principal) => `${actor.id}-${'t'.repeat(32)}`;
const request = async (path: string, actor: Principal, body?: unknown) => {
  const response = await fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token(actor)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
};

before(async () => {
  store = await withDatabase('emblem'); await store.init();
  engine = new Engine(store, 120, 'owner/night-yard');
  http = server(engine, principals.map(entry => ({ ...entry, token: token(entry) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); });

test('integration:emblem-route — master emblem set records the emblem, serves it at /favicon.svg and refuses bad drawings with the reason', async () => {
  assert.equal(await readEmblem(store.pool), null, 'an install with no emblem event serves none');
  const denied = await request('/api/emblem', reader, { svg: valid });
  assert.equal(denied.status, 403, 'a reader identity cannot draw the emblem');
  assert.match(denied.text, /drawn by the master/);
  assert.equal((await request('/api/emblem', worker, { svg: valid })).status, 403, 'a worker identity cannot draw the emblem');
  const refused = await request('/api/emblem', master, { svg: valid.replace('/2000/svg"', '/2000/svg" onload="x"') });
  assert.equal(refused.status, 400, 'an event-attribute drawing is refused');
  assert.match(refused.text, /onload/);
  const set = await request('/api/emblem', master, { svg: valid });
  assert.equal(set.status, 200);
  assert.deepEqual(JSON.parse(set.text), { set: true, bytes: Buffer.byteLength(valid, 'utf8') }, 'the set names what it stored');
  const again = await request('/api/emblem', operator, { svg: valid });
  assert.equal(JSON.parse(again.text).set, false, 'setting the same emblem again appends nothing');
  const events = (await store.pool.query(`SELECT count(*)::int AS count FROM events WHERE work_id IS NULL AND kind='emblem.set'`)).rows[0].count;
  assert.equal(events, 1, 'exactly one emblem event, with the actor that drew it');
  const drawn = (await store.pool.query(`SELECT actor FROM events WHERE kind='emblem.set'`)).rows[0].actor;
  assert.equal(drawn, 'master');
  const favicon = await request('/favicon.svg', reader);
  assert.equal(favicon.status, 200);
  assert.match(favicon.contentType!, /image\/svg\+xml/);
  assert.equal(favicon.text, valid, '/favicon.svg serves the emblem the master drew');
});
