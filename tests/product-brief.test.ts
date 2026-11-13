import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { server } from '../src/server.js';
import { runBriefCommand } from '../src/master/brief.js';
import { masterRequest } from '../src/master/master-session.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { reviewPrompt } from '../src/reviewer.js';
import { emptyProjectMemory, recordMasterLesson, reconcileMasterMemory } from '../src/model/project-memory.js';
import { readProjectMemory, recordedMasterMemory } from '../src/project-memory.js';
import { ProductView } from '../web/pages/product';
import type { MasterConfig } from '../src/master/profiles.js';
import type { Principal } from '../src/model.js';

// GY-3274 AC-2: `master brief set FILE REASON` and `master brief show` keep one product brief per
// install in project memory (Markdown, at most 800 words, the five sections), each change kept in
// history with who and why. Every master launch prompt includes the brief before the lessons;
// worker and reviewer prompts carry its problem, users and success sections; the dashboard shows it
// on a Product page, read-only, from the control plane's mirror.

const briefMarkdown = (problem: string) => `## Problem
Teams lose the plot between rounds of automated delivery: nobody remembers what the product is for.

## Users
Small product teams running Graphyard on one repository, and their operator.

## What success looks like
- Sign-up to first delivered item within a day (measured weekly, dashboard cohort)
- At least 3 of 4 shipped items each month trace to a brief goal (item page label)

## Current bets
The master's own brief, kept current and read at every launch, beats a stale wiki page.

## Open questions
Which signal moves first when the brief is wrong?
${problem}`;

const config = { repository: 'owner/project', cliPath: '/bin/graphyard.mjs', url: 'https://graphyard.example', credentialFile: '/credentials/master.token', hostId: 'host', baseBranch: 'main', masterAgentName: 'graphyard-master-project', workers: [], reviewers: [], producers: [], run: {} } as unknown as MasterConfig;
const briefDeps = (publishes: unknown[], actors: Record<string, { id: string; role: string }> = {}) => ({
  status: async (credential: string) => ({ actor: actors[credential] ?? { id: 'graphyard-master', role: 'coordinator' } }),
  publish: async (brief: unknown) => { publishes.push(brief); },
});

test('e2e:product-brief — brief set keeps one brief per install in project memory with history of who and why, validates its shape, and show prints it', async () => {
  const root = await temporaryDirectory('product-brief');
  const publishes: unknown[] = [];
  const deps = briefDeps(publishes);
  const first = join(root, 'brief-1.md');
  await writeFile(first, briefMarkdown(''));
  const set = await runBriefCommand(root, 'graphyard-master', ['set', first, 'first', 'brief'], deps) as { set: { by: string; why: string; words: number }; history: number };
  assert.equal(set.set.by, 'graphyard-master');
  assert.equal(set.set.why, 'first brief');
  assert.ok(set.set.words > 0 && set.set.words <= 800);

  let memory = await readProjectMemory(root);
  assert.equal(memory.brief!.by, 'graphyard-master');
  assert.match(memory.brief!.markdown, /^## Problem$/m);
  assert.equal(memory.brief!.history.length, 1);

  const second = join(root, 'brief-2.md');
  await writeFile(second, briefMarkdown('\nA second revision tightens the problem.'));
  await runBriefCommand(root, 'graphyard-master', ['set', second, 'sharper', 'problem'], deps);
  memory = await readProjectMemory(root);
  assert.equal(memory.brief!.history.length, 2, 'each change is kept in history');
  assert.match(memory.brief!.history[0].why, /sharper problem/);
  assert.match(memory.brief!.markdown, /A second revision tightens the problem\./);
  assert.deepEqual(publishes.length, 2, 'each set publishes the brief to the control plane');

  // The loop adopts the file's brief, so its next write of project memory keeps it.
  assert.deepEqual(reconcileMasterMemory(emptyProjectMemory('2026-11-13T00:00:00Z'), await recordedMasterMemory(root)).brief, memory.brief);

  const shown = await runBriefCommand(root, 'graphyard-master', ['show'], deps) as { markdown: string };
  assert.equal(shown.markdown, memory.brief!.markdown);

  // The brief's shape is enforced: a missing section, an over-long brief and a missing reason are refused.
  const missing = join(root, 'missing.md');
  await writeFile(missing, '## Problem\nx\n## Users\ny\n## What success looks like\nz\n## Open questions\nw\n');
  await assert.rejects(runBriefCommand(root, 'graphyard-master', ['set', missing, 'no', 'bets'], deps), /The product brief needs a ## Current bets section/);
  const long = join(root, 'long.md');
  await writeFile(long, briefMarkdown(`${'\n' + 'filler word '.repeat(400)}`));
  await assert.rejects(runBriefCommand(root, 'graphyard-master', ['set', long, 'too', 'long'], deps), new RegExp(`over the 800-word limit`));
  await assert.rejects(runBriefCommand(root, 'graphyard-master', ['set', second], deps), /Use master brief set FILE REASON/);
  // A worker identity is refused, as for lessons.
  const workerDeps = briefDeps([], { 'worker-token': { id: 'implementer-1', role: 'worker' } });
  await assert.rejects(runBriefCommand(root, 'graphyard-master', ['set', second, 'a', 'worker'], { ...workerDeps, callerCredential: async () => 'worker-token' }),
    /A worker identity \(implementer-1\) cannot write the product brief/);
});

test('e2e:product-brief — every master launch prompt includes the brief before the lessons, and worker and reviewer prompts carry problem, users and success', async () => {
  const root = await temporaryDirectory('product-brief-prompts');
  const deps = briefDeps([]);
  const file = join(root, 'brief.md');
  await writeFile(file, briefMarkdown(''));
  await runBriefCommand(root, 'graphyard-master', ['set', file, 'the', 'standing', 'brief'], deps);
  const memory = await readProjectMemory(root);
  recordMasterLesson(memory, { id: randomUUID(), text: 'Read the gate record before filing a batch item', by: 'graphyard-master', forWorkers: true });

  const request = masterRequest(config, 'Handover: continue from master status.', memory);
  assert.match(request, /Product brief for this install \(updated [^)]+ by graphyard-master\): ## Problem/, 'the launch prompt carries the whole brief');
  assert.ok(request.indexOf('Product brief for this install') < request.indexOf('Master lessons, your own recorded experience'), 'the brief comes before the lessons');
  assert.ok(request.indexOf('Master lessons') < request.indexOf('Handover: continue'), 'the lessons still come before the task handover');
  assert.ok(request.indexOf('Product brief') < request.indexOf('Handover: continue'), 'the brief comes before the task handover');

  const worker = workerPrompt({ cliPath: '/bin/graphyard.mjs' }, { key: 'GY-9', title: 'Any item' }, { principal: 'graphyard-worker-1' }, 1, null, memory);
  assert.match(worker, /Product brief — Problem: /);
  assert.match(worker, /Users: /);
  assert.match(worker, /What success looks like: /);
  assert.ok(!worker.includes('Current bets'), 'a worker judges for the user; the bets stay with the master');
  assert.ok(!worker.includes('Which signal moves first'), 'nor the open questions');

  const reviewer = reviewPrompt({ repository: 'owner/project', cliPath: '/bin/graphyard.mjs' }, { key: 'GY-9', pr: 9, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1 }, undefined, undefined, undefined, undefined, undefined, null, memory);
  assert.match(reviewer, /Product brief — Problem: /, 'a reviewer judges the work against the same product');
  assert.ok(!reviewer.includes('Current bets'), 'the bets stay with the master');

  const producer = workerPrompt({ cliPath: '/bin/graphyard.mjs' }, { key: 'GY-9', title: 'Any item' }, { principal: 'graphyard-worker-1' }, 1, null, { ...memory, brief: null });
  assert.ok(!producer.includes('Product brief —'), 'a memory without a brief changes no prompt');
});

let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const admin: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator', sessionKind: 'ai' };
const principals = [admin, worker, coordinator];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(32)}`]));

before(async () => {
  store = await withDatabase('product-brief'); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); });

test('e2e:product-brief — the control plane serves the mirrored brief and the Product page shows it read-only', async () => {
  const call = async (actor: Principal, method: string, body?: unknown) => {
    const response = await fetch(`${url}/api/product-brief`, { method, headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  };
  assert.deepEqual(await call(admin, 'GET'), { status: 200, body: { brief: null } }, 'no brief yet is an honest empty page');

  const brief = { markdown: briefMarkdown(''), updatedAt: '2026-11-13T08:00:00Z', by: 'graphyard-master', why: 'the standing brief', history: [{ at: '2026-11-13T08:00:00Z', by: 'graphyard-master', why: 'the standing brief', words: 80 }] };
  const published = await call(coordinator, 'POST', brief);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const read = await call(admin, 'GET');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.brief, brief, 'the dashboard reads what the master published');

  // Only the install's own identities publish it; a worker cannot, and a malformed brief is refused.
  assert.equal((await call(worker, 'POST', brief)).status, 403);
  assert.equal((await call(coordinator, 'POST', { markdown: 'not a brief' })).status, 400);

  // The Product page renders the brief read-only: the sections, who kept it and why, no editing control in sight.
  const html = renderToStaticMarkup(createElement(ProductView, { brief: read.body.brief, error: '', loading: false, retry: () => {} }));
  for (const heading of ['Problem', 'Users', 'What success looks like', 'Current bets', 'Open questions']) assert.ok(html.includes(`>${heading}</h2>`), heading);
  assert.match(html, /read-only/);
  assert.match(html, /the standing brief/);
  assert.ok(!html.includes('<button'), 'the page edits nothing');
  const empty = renderToStaticMarkup(createElement(ProductView, { brief: null, error: '', loading: false, retry: () => {} }));
  assert.match(empty, /No product brief yet/);
});

test('e2e:product-brief — the CLI publishes through the control-plane route the Product page reads', async () => {
  const root = await temporaryDirectory('product-brief-publish');
  const file = join(root, 'brief.md');
  await writeFile(file, briefMarkdown(''));
  await runBriefCommand(root, 'graphyard-master', ['set', file, 'through', 'the', 'route'], {
    status: async () => ({ actor: { id: 'graphyard-master', role: 'coordinator' } }),
    publish: async (published: unknown) => {
      const response = await fetch(`${url}/api/product-brief`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(coordinator.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(published) });
      assert.equal(response.status, 200);
    },
  });
  const read = await (await fetch(`${url}/api/product-brief`, { headers: { Authorization: `Bearer ${tokens.get(admin.id)}` } })).json() as { brief: { markdown: string } };
  assert.match(read.brief.markdown, /^## Problem$/m, 'what the master set is what the Product page shows');
});
