import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { e2eSuite } from '../src/e2e/runner.js';
import type { CaseFile } from '../src/e2e/case.js';

/**
 * GY-2216 AC-1: after deployedE2e runs cases against a control plane — every case passing or one
 * failing — no work item the run created is left open: each is closed as obsolete with a reason
 * naming the run. The cases were written for a disposable UAT and each POST /api/work they make
 * would otherwise leave another batch on the live board, as the 2026-10-19 deploy did.
 *
 * The tests run the real runner and suite against a fake test control plane (a fetcher holding the
 * items) with case files that create work items, the way the repository's own cases do.
 */

const url = 'http://127.0.0.1:4311';

interface PlaneItem { id: string; key: string; title: string; stage: string; closure: { kind: string; reason: string } | null }

/**
 * A control plane that answers the reads and writes the suite and the cleanup make: /healthz, the
 * delivery probe, POST /api/work, GET /api/work/ID and POST /api/work/ID/close. A close of an
 * already-closed item answers 409, the way the real one refuses an already-settled item.
 */
function controlPlane(options: { failClose?: boolean } = {}) {
  const state = { nextId: 0, items: new Map<string, PlaneItem>(), closes: [] as { id: string; body: { kind?: string; reason?: string } }[] };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/healthz') return Response.json({ commit: '0'.repeat(40) });
    if (path === '/api/merger') return Response.json({ mode: 'control-plane' });
    if (path === '/api/work' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { title: string };
      const item: PlaneItem = { id: `item-${++state.nextId}`, key: `GY-${900 + state.nextId}`, title: body.title, stage: 'backlog', closure: null };
      state.items.set(item.id, item);
      return Response.json(item);
    }
    const read = /^\/api\/work\/([^/]+)$/.exec(path);
    if (read) { const item = state.items.get(read[1]); return item ? Response.json(item) : new Response('no such item', { status: 404 }); }
    const close = /^\/api\/work\/([^/]+)\/close$/.exec(path);
    if (close) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { kind?: string; reason?: string };
      state.closes.push({ id: close[1], body });
      const item = state.items.get(close[1]);
      if (!item) return new Response('no such item', { status: 404 });
      if (options.failClose) return new Response('the close was refused', { status: 500 });
      if (item.closure) return Response.json({ error: 'already closed' }, { status: 409 });
      item.closure = { kind: body.kind ?? 'obsolete', reason: body.reason ?? '' };
      item.stage = 'done';
      return Response.json(item);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, state };
}

/** A case that creates one work item the way the repository's own cases do: POST /api/work, then read it back. */
const createSteps = (id: string) => [
  {
    kind: 'http', name: 'create the item', method: 'POST', path: '/api/work',
    body: { title: `E2E case ${id} run {{run}}`, description: `Created by the ${id} E2E case.`, type: 'chore', priority: 3,
      criteria: [{ id: 'AC-1', text: 'The target accepts work created by an E2E case', proofs: ['manual:e2e-case'] }], policy: { checks: ['test'], review: true } },
    status: 200, expect: [{ path: 'key', type: 'string' }], save: { id: 'id', key: 'key' },
  },
  { kind: 'http', name: 'read the item back', method: 'GET', path: '/api/work/{{id}}', status: 200, expect: [{ path: 'key', equals: '{{key}}' }] },
];

const writeCase = async (root: string, definition: object) => {
  const id = (definition as { id: string }).id;
  await writeFile(join(root, 'e2e/cases', `${id}.json`), `${JSON.stringify(definition, null, 2)}\n`);
};

/** deployedE2e over the real suite against the fake plane, with a manual clock so no wall time passes. */
const deployedAgainst = async (plane: ReturnType<typeof controlPlane>, root: string) => {
  const { deployedE2e, e2eSuite: realSuite } = await import('../src/e2e/runner.js') as Record<string, any>;
  let clock = 0;
  const suite = ((_cases: readonly CaseFile[], token: string, options: Parameters<typeof e2eSuite>[2] = {}) =>
    realSuite(_cases, token, { ...options, fetcher: plane.fetcher, now: () => clock, sleep: async (ms: number) => { clock += ms; } })) as typeof e2eSuite;
  return deployedE2e(root, url, 'e2e-token', suite, { fetcher: plane.fetcher });
};

/** The run id a case baked into its created item's title (`... run <runId>-<attempt>`). */
const runOf = (item: PlaneItem) => /run (.+)-\d+$/.exec(item.title)![1];
/** The case id a created item's title names (`E2E case <caseId> run ...`). */
const caseOf = (item: PlaneItem) => /case ([a-z0-9.-]+) run /.exec(item.title)![1];

test('unit:deployed-e2e-closes-created-items — a passing run closes every work item its cases created, as obsolete with a reason naming the run', async () => {
  const root = await temporaryDirectory('deployed-e2e-cleanup');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeCase(root, { id: 'alpha-create', title: 'Alpha creates an item', target: 'uat', required: true, tags: [], secrets: [], steps: createSteps('alpha-create') });
  await writeCase(root, { id: 'beta-create', title: 'Beta creates an item', target: 'uat', required: true, tags: [], secrets: [], steps: createSteps('beta-create') });
  const plane = controlPlane();

  const result = await deployedAgainst(plane, root);

  assert.equal(result.passed, true);
  assert.equal(plane.state.items.size, 2, 'each case created its item');
  for (const item of plane.state.items.values()) {
    assert.ok(item.closure, `${item.key} is closed when the run ended`);
    assert.equal(item.closure!.kind, 'obsolete', `${item.key} is closed as obsolete`);
    assert.ok(item.closure!.reason.includes(runOf(item)), `the closure reason names the run: ${item.closure!.reason}`);
    assert.ok(item.closure!.reason.includes(caseOf(item)), `the closure reason names the case that created it: ${item.closure!.reason}`);
    const close = plane.state.closes.find(entry => entry.id === item.id)!;
    assert.equal(close.body.kind, 'obsolete');
  }
});

test('unit:deployed-e2e-closes-created-items — a failing run still closes every item it created (its failing case\'s retry made a second one), and still throws', async () => {
  const root = await temporaryDirectory('deployed-e2e-cleanup');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  // The failing case creates an item, then asserts the impossible: its one retry creates another item, and both must be closed.
  await writeCase(root, { id: 'gamma-fails', title: 'Gamma fails after creating', target: 'uat', required: true, tags: [], secrets: [],
    steps: [...createSteps('gamma-fails'), { kind: 'http', name: 'the impossible', method: 'GET', path: '/api/work', status: 599, expect: [] }] });
  await writeCase(root, { id: 'delta-create', title: 'Delta creates an item', target: 'uat', required: true, tags: [], secrets: [], steps: createSteps('delta-create') });
  const plane = controlPlane();

  await assert.rejects(deployedAgainst(plane, root), /E2E case.*failed/s, 'the failing case is still the end-to-end failure');

  assert.equal(plane.state.items.size, 3, 'the failing case created one item per attempt, the passing case one');
  const open = [...plane.state.items.values()].filter(item => !item.closure);
  assert.deepEqual(open, [], `no work item the run created is left open: ${open.map(item => item.key).join(', ')}`);
  for (const item of plane.state.items.values()) assert.ok(item.closure!.reason.includes(runOf(item)), `the reason names the run: ${item.closure!.reason}`);
});

test('unit:deployed-e2e-closes-created-items — an item the run already settled counts as closed: a case that closes its own item does not fail the cleanup', async () => {
  const root = await temporaryDirectory('deployed-e2e-cleanup');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeCase(root, { id: 'epsilon-settles', title: 'Epsilon settles its own item', target: 'uat', required: true, tags: [], secrets: [],
    steps: [...createSteps('epsilon-settles'),
      { kind: 'http', name: 'settle the change', method: 'POST', path: '/api/work/{{id}}/close', body: { kind: 'obsolete', reason: 'the case settles its own change' }, status: 200, expect: [{ path: 'stage', equals: 'done' }] }] });
  const plane = controlPlane();

  const result = await deployedAgainst(plane, root);

  assert.equal(result.passed, true, 'the run passes: its cleanup close of the settled item was refused with 409 and that is not an open item');
  const [item] = [...plane.state.items.values()];
  assert.equal(item.closure!.reason, 'the case settles its own change', 'the case\'s own closure stands; the run\'s close did not overwrite it');
});

test('unit:deployed-e2e-closes-created-items — a close that cannot settle an item fails a passing run, naming the item left open', async () => {
  const root = await temporaryDirectory('deployed-e2e-cleanup');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeCase(root, { id: 'zeta-create', title: 'Zeta creates an item', target: 'uat', required: true, tags: [], secrets: [], steps: createSteps('zeta-create') });
  const plane = controlPlane({ failClose: true });

  await assert.rejects(deployedAgainst(plane, root), /1 work item the run created could not be closed: GY-901/,
    'a run that cannot clean up after itself does not pass');
});
