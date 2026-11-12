import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Work } from '../src/model.js';
// @ts-expect-error the checked-in dashboard fixture is plain JavaScript
import { fixtureApi, fixtureStatus, fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import WorkDetails from '../web/pages/work-details.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { keptScreenshot, runTrialE2eGroup, trialScreenshotBytesMax, trialScreenshotCasesMax } from '../src/merge-writer/e2e-trial.js';
import { commandApplication } from '../src/merge-writer/serve-head.js';
import { mergeOne, mergeTrialShots, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { mergeRecordBodySchema } from '../src/server/merge-record.js';
import { keepTrialScreenshots, readTrialScreenshot, trialScreenshotRetentionDays } from '../src/server/trial-screenshots.js';
import type { StepRecord } from '../src/e2e/steps.js';

// GY-3267: an item that changes the dashboard shows before and after screenshots of the changed
// page. The trial's e2e group keeps the last screenshot of each browser case it ran (after, on the
// candidate; before, on the base tip), the trial record carries them, the control plane stores and
// serves them beside the item, and the item page shows them side by side — an item whose cases
// drove no browser keeps none and shows none.

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shotOf = (screenshots: string[]): Pick<StepRecord, 'screenshots'> => ({ screenshots });

test('unit:trial-kept-screenshot — the last screenshot of a case\'s last attempt is kept as base64 when it is a PNG within the byte bound; a larger file, another format or none is kept not', async () => {
  const directory = await temporaryDirectory('trial-shot-kept');
  try {
    const png = join(directory, 'a.png'), text = join(directory, 'a.txt'), big = join(directory, 'big.png');
    await writeFile(png, Buffer.concat([pngSignature, Buffer.from('image-bytes')]));
    await writeFile(text, 'png');
    await writeFile(big, Buffer.concat([pngSignature, Buffer.alloc(trialScreenshotBytesMax + 1)]));
    const run = (screenshots: string[] | undefined) => ({ attemptResults: [{ attempt: 1, outcome: 'pass' as const, durationMs: 1, executed: 1, failingStep: null, steps: [
      { index: 0, name: 'earlier', kind: 'agent' as const, outcome: 'pass' as const, output: [], ...(screenshots ? shotOf(screenshots) : {}) }] }] });
    assert.equal(await keptScreenshot(run([join(directory, 'gone.png'), png])), Buffer.concat([pngSignature, Buffer.from('image-bytes')]).toString('base64'), 'the last screenshot of the last attempt wins');
    assert.equal(await keptScreenshot(run([text])), undefined, 'a file that is not a PNG is kept not');
    assert.equal(await keptScreenshot(run([big])), undefined, 'a PNG past the byte bound is kept not');
    assert.equal(await keptScreenshot(run([])), undefined);
    assert.equal(await keptScreenshot(run(undefined)), undefined);
    assert.equal(await keptScreenshot({ attemptResults: [] }), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** A fake `agent-browser` on PATH that answers every session with a pass and writes a PNG where the screenshot is asked for. */
async function fakeAgentBrowser(directory: string, reply: string) {
  const bin = join(directory, 'bin'); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'agent-browser'), `#!/bin/sh\ncase "$3" in\n  chat) printf '%b\\n' ${JSON.stringify(reply)} ;;\n  screenshot) printf '\\211PNG\\r\\n\\032\\nbody' > "$4" ;;\nesac\n`);
  await chmod(join(bin, 'agent-browser'), 0o755);
  return bin;
}

test('integration:trial-e2e-group-keeps-last-screenshot — the trial\'s e2e group keeps each agent case\'s last screenshot on its result, and a case that drove no browser keeps none', async () => {
  const directory = await temporaryDirectory('trial-shot-group');
  const served = (await import('node:http')).createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: 'served' })); });
  await new Promise<void>(resolve => served.listen(0, '127.0.0.1', resolve));
  try {
    const put = async (path: string, content: unknown) => { await mkdir(join(directory, 'e2e/cases', path, '..'), { recursive: true }); await writeFile(join(directory, 'e2e/cases', path), JSON.stringify(content)); };
    await put('plays.json', { id: 'plays', title: 'An agent plays', target: 'any', steps: [{ kind: 'agent', goal: 'Play the game', success: ['The board shows "You win"'] }] });
    await put('asks.json', { id: 'asks', title: 'The page answers', target: 'any', steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'served' }] }] });
    const bin = await fakeAgentBrowser(directory, 'The board says You win.\nVERDICT: PASS');
    const cases = await runTrialE2eGroup(commandApplication({ command: 'true', url: `http://127.0.0.1:${(served.address() as { port: number }).port}`, readySeconds: 1 }),
      ['e2e:plays', 'e2e:asks'], { worktree: directory, mergeSha: 'a'.repeat(40), proofs: [], env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME! }, scratch: directory, budgetMs: 120_000, holds: async () => true, log: () => {} },
      `http://127.0.0.1:${(served.address() as { port: number }).port}`);
    const plays = cases.find(entry => entry.case === 'plays')!, asks = cases.find(entry => entry.case === 'asks')!;
    assert.equal(plays.failed, 0, plays.failingStep ?? '');
    assert.equal(plays.screenshot, Buffer.concat([pngSignature, Buffer.from('body')]).toString('base64'), 'the agent case\'s last screenshot rides the result');
    assert.equal(asks.failed, 0, asks.failingStep ?? '');
    assert.equal(asks.screenshot, undefined, 'a case whose steps drove no browser keeps none');
  } finally { served.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unit:trial-case-shots — the candidate run\'s kept screenshots are the after side and the base tip\'s are added as the before, bounded as the trial record accepts', () => {
  const shots = mergeTrialShots([], [{ proof: 'e2e:plays', case: 'plays', executed: 1, failed: 0, screenshot: 'after-png' }], 'after');
  assert.deepEqual(shots, [{ case: 'plays', after: 'after-png' }]);
  assert.deepEqual(mergeTrialShots(shots, [{ proof: 'e2e:plays', case: 'plays', executed: 1, failed: 0, screenshot: 'before-png' }, { proof: 'e2e:asks', case: 'asks', executed: 1, failed: 0 }], 'before'),
    [{ case: 'plays', before: 'before-png', after: 'after-png' }], 'the base run adds the before side, and a case that kept none there stays as it was');
  assert.deepEqual(mergeTrialShots(shots, [{ proof: 'e2e:other', case: 'other', executed: 1, failed: 0, screenshot: 'other-png' }], 'before'),
    [{ case: 'plays', after: 'after-png' }, { case: 'other', before: 'other-png' }], 'a case only the base ran keeps its before alone');
  assert.equal(mergeTrialShots([], [{ proof: 'e2e:asks', case: 'asks', executed: 1, failed: 0 }], 'after').length, 0, 'a run that kept no screenshot adds nothing');
  const many = Array.from({ length: trialScreenshotCasesMax + 5 }, (_, index) => ({ proof: `e2e:case-${index}`, case: `case-${index}`, executed: 1, failed: 0, screenshot: `png-${index}` }));
  assert.equal(mergeTrialShots([], many, 'after').length, trialScreenshotCasesMax, 'the trial record accepts no more cases than its bound');
});

const shot64 = (bytes: string) => Buffer.from(bytes).toString('base64');

test('integration:trial-screenshots-kept-and-served — a trial record\'s screenshots are stored one row per case, replacing the earlier trial\'s, served by case and side, and taken back past their retention', async () => {
  const store = await withDatabase('trial-screenshots'); await store.init();
  try {
    const created = await store.pool.query(`INSERT INTO work_items (id, document) VALUES ('11111111-1111-4111-8111-111111111111', '{"key":"GY-3267","stage":"build"}') RETURNING id`);
    const id = created.rows[0].id as string;
    const keep = (shots: readonly { case: string; before?: string; after?: string }[]) => store.transaction(db => keepTrialScreenshots(db, id, shots));
    assert.deepEqual(await keep([{ case: 'plays', after: shot64('after-png') }]), [{ case: 'plays', after: true }], 'the names the item page reads');
    assert.deepEqual(await keep([{ case: 'plays', before: shot64('before-png'), after: shot64('after-png-2') }, { case: 'asks' }]),
      [{ case: 'plays', before: true, after: true }], 'each fresh trial replaces the item\'s set, and an entry keeping neither side names nothing');
    const services = { engine: { store } } as unknown as Parameters<typeof readTrialScreenshot>[0];
    assert.equal((await readTrialScreenshot(services, id, 'plays', 'before')).toString(), 'before-png');
    assert.equal((await readTrialScreenshot(services, 'GY-3267', 'plays', 'after')).toString(), 'after-png-2', 'the item answers by its key too');
    await assert.rejects(() => readTrialScreenshot(services, id, 'asks', 'before'), /No such trial screenshot/);
    // Retention: a row past its retention is taken back by the next trial's keep.
    await store.pool.query(`UPDATE trial_case_screenshots SET recorded_at = now() - make_interval(days => $1) WHERE case_name='plays'`, [trialScreenshotRetentionDays]);
    await keep([{ case: 'asks', after: shot64('after-asks') }]);
    assert.equal((await store.pool.query(`SELECT count(*) AS rows FROM trial_case_screenshots WHERE work_id=$1`, [id])).rows[0].rows, '1');
    assert.equal((await readTrialScreenshot(services, id, 'asks', 'after')).toString(), 'after-asks');
  } finally { await store.close(); }
});

test('unit:merge-record-accepts-screenshots — the trial record takes each browser case\'s before and after within the capture bound, and no more cases than the trial keeps', () => {
  const sha = 'a'.repeat(40), base = { kind: 'trial' as const, head: sha, baseTip: sha, mergeSha: sha, outcome: 'verdict' as const, build: 'pass' as const,
    tests: { passed: 0, failed: [], files: 0 }, files: [], proofs: {}, durationMs: 1, attempts: [] };
  const shot = shot64('x').repeat(1000);
  assert.ok(mergeRecordBodySchema.safeParse({ ...base, screenshots: [{ case: 'plays', before: shot, after: shot }] }).success);
  assert.ok(!mergeRecordBodySchema.safeParse({ ...base, screenshots: Array.from({ length: trialScreenshotCasesMax + 1 }, (_, index) => ({ case: `case-${index}`, after: shot })) }).success);
  const oversized = 'x'.repeat(Math.ceil(trialScreenshotBytesMax / 3) * 4 + 1);
  assert.ok(!mergeRecordBodySchema.safeParse({ ...base, screenshots: [{ case: 'plays', after: oversized }] }).success);
});

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const start = Date.parse('2030-04-01T00:00:00Z');

/** One merge whose trial kept a browser case's screenshots, answered from memory: what mergeOne records is the case. */
test('integration:merge-one-posts-trial-screenshots — the trial record carries the kept screenshots once, in their own field, never inside the e2e results', async () => {
  const recorded: MergeRecordEvent[] = [];
  const tip = sha('main-tip');
  const ports: MergePorts = {
    baseBranch: 'main', now: () => start,
    fetch: async () => tip,
    merge: async () => ({ mergeSha: sha('merge'), files: ['src/app.ts'] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 100, logTail: '', files: ['src/app.ts'], proofs: { 'e2e:plays': { executed: 1, failed: 0 } },
      e2e: [{ proof: 'e2e:plays', case: 'plays', executed: 1, failed: 0, screenshot: 'after-png' }], screenshots: [{ case: 'plays', after: 'after-png' }] } as MergeTrialRun),
    push: async () => 'pushed', holds: async () => true,
    record: async (_item, event) => { recorded.push(event); },
  };
  const work = { id: 'w1', key: 'GY-1', stage: 'build', type: 'chore', epoch: 1, lease: null, reworkRequested: false, workspaces: [], ready: true,
    submission: { epoch: 1, pr: 1 }, candidate: { sha: sha('head'), baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:plays'] }] } as unknown as Work;
  assert.equal((await mergeOne(ports, work)).outcome, 'merged');
  const trial = recorded.find(event => event.kind === 'trial');
  assert.ok(trial && trial.kind === 'trial' && trial.outcome === 'verdict');
  assert.deepEqual(trial.e2e, [{ proof: 'e2e:plays', case: 'plays', executed: 1, failed: 0 }], 'the e2e results carry no screenshot bytes');
  assert.deepEqual(trial.screenshots, [{ case: 'plays', after: 'after-png' }]);
});

const noop = () => {};
function dashboard(work: Work[], overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    token: 'fixture', work, status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {} as any, events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop,
    sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop, ...overrides,
  } as Dashboard;
}

test('unit:item-page-trial-screenshots — the item page shows each browser case\'s before and after screenshots side by side, and an item whose trial kept none shows no screenshots section', () => {
  const board = () => (fixtureWork() as any[]).map(live) as unknown as Work[];
  const withShots = (item: Work): Work => ({ ...item, trialScreenshots: { mergeSha: 'c'.repeat(40), baseTip: 'd'.repeat(40), at: new Date(NOW).toISOString(), cases: [{ case: 'plays', before: true, after: true }] } });
  const all = board(), item = withShots(all[0]!);
  const html = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard([...all, item] as Work[], { selected: item.id } as Partial<Dashboard>), item }));
  const section = html.indexOf('aria-label="Screenshots"');
  assert.ok(section > 0, 'the page has a Screenshots section');
  const within = html.slice(section);
  assert.ok(within.includes('>plays<'), 'the case is named');
  assert.ok(within.includes('Before'), 'the before side is labelled');
  assert.ok(within.includes('After'), 'the after side is labelled');
  assert.ok(within.includes('dddddddd'), 'the before label names the base tip it served');
  assert.ok(within.includes('cccccccc'), 'the after label names the merge commit it served');
  const bare = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard(all), item: all[0]! }));
  assert.ok(!bare.includes('aria-label="Screenshots"'), 'an item whose trial ran no browser case shows no screenshots section');
});
