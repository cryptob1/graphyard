import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { idleRefreshMs, launchedTailSources, runLogFile, SessionTailPublisher, SessionTails, sessionTailLines, tailLines, tailWatchMs, watchedRefreshMs, type PublishedTail } from '../src/session-tail.js';
import { workRoutes } from '../src/server/routes/work.js';
import { matchRoute } from '../src/server/routes.js';
import { masterRunSchema } from '../src/master/profiles.js';
import { researchSettings } from '../src/research.js';
import { roleSurface } from '../src/runner/payloads.js';
import { headlessSurface } from '../src/runner/surface.js';
import { herdrSurface, surfacePane } from '../src/runner/herdr-surface.js';
import { piRunner } from '../src/runner/pi.js';
import SessionViewer, { LiveSessions } from '../web/session-viewer.js';

// GY-713: watching any running agent session from the dashboard. The loop publishes a bounded,
// redacted tail of every session it launched (and of nothing else) at a cadence that follows the
// viewer; the dashboard's viewer is read-only; and a headless role may run inside a Herdr pane.

const HOST = 'host-a', T0 = Date.parse('2030-01-01T00:00:00Z');
const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const handle = (overrides: Record<string, unknown>) => ({ id: 'h', kind: 'review', principal: 'reviewer-a', epoch: null, runtime: 'claude', host: HOST, workspace: 'w1', tab: null, pane: 'p-review', agentName: 'gy-7-review',
  role: 'review', head: null, attach: 'herdr pane attach p-review', transcript: '/t/review.jsonl', subject: 'Review GY-7', startedAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), endedAt: null,
  state: 'running', outcome: null, launch: 'abcdef0123456789', ...overrides });
const item = (sessions: unknown[]) => ({ id: 'work-7', key: 'GY-7', sessions } as unknown as Work);

test('unit:session-tail-published — the tail is the last 200 lines, stripped of terminal control sequences and redacted by the evidence redaction', () => {
  const text = [...Array.from({ length: 250 }, (_, index) => `line ${index + 1}`), `\u001b[31mexport GH_TOKEN=${token}\u001b[0m`, `Authorization: Bearer ${token}`, ''].join('\r\n');
  const lines = tailLines(text);
  assert.equal(lines.length, sessionTailLines);
  assert.equal(lines[0], 'line 53', 'only the last 200 lines are kept');
  assert.ok(lines.every(line => !line.includes(token)), 'a token-shaped string never survives');
  assert.ok(lines.every(line => !line.includes('\u001b')), 'no control sequence survives');
  assert.match(lines.at(-2)!, /\[redacted\]/);
  assert.match(lines.at(-1)!, /^Authorization: Bearer \[redacted\]$/);
});

test('unit:session-tail-published — only sessions this loop launched are sources: an unlaunched pane, another host\'s and an ended session are never read', () => {
  const agents = [{ name: 'gy-7-review', pane_id: 'p-review' }, { name: 'graphyard-claude-1', pane_id: 'p-worker' }, { name: 'operator-shell', pane_id: 'p-operator' }, { name: 'other-host', pane_id: 'p-other' }, { name: 'no-token', pane_id: 'p-no-token' }];
  const work = [item([
    handle({}),
    // A worker's handle carries no Herdr coordinates; its pane is the loop's launch profile's.
    handle({ id: 'graphyard-claude-1:3', kind: 'implementation', principal: 'graphyard-claude-1', agentName: null, pane: null, role: null, attach: null, transcript: null }),
    handle({ id: 'other', agentName: 'other-host', pane: 'p-other', host: 'host-b' }),
    handle({ id: 'no-token', agentName: 'no-token', pane: 'p-no-token', launch: undefined }),
    handle({ id: 'ended', agentName: 'operator-shell', pane: 'p-operator', state: 'finished' }),
  ])];
  const sources = launchedTailSources(work, agents, HOST, [{ name: 'gy-7-approver', work: 'GY-7', role: 'approver', runtime: 'pi', startedAt: new Date(T0).toISOString(), log: '/logs/approver.log' },
    { name: 'gy-9-producer', work: 'GY-9', role: 'producer', runtime: 'pi', startedAt: new Date(T0).toISOString(), log: '/logs/other.log' }], [{ principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1' }]);
  assert.deepEqual(sources.map(source => [source.session, source.role, source.surface]), [
    ['gy-7-review', 'reviewer', { kind: 'herdr', pane: 'p-review' }],
    ['graphyard-claude-1', 'worker', { kind: 'herdr', pane: 'p-worker' }],
    ['gy-7-approver', 'approver', { kind: 'headless', log: '/logs/approver.log' }],
  ]);
  const panes = sources.flatMap(source => source.surface.kind === 'herdr' ? [source.surface.pane] : []);
  for (const pane of ['p-operator', 'p-other', 'p-no-token']) assert.ok(!panes.includes(pane), `${pane} is not a launched session`);
  // A handle whose pane Herdr now lists under another name is not read either.
  assert.deepEqual(launchedTailSources([item([handle({})])], [{ name: 'someone-else', pane_id: 'p-review' }], HOST), []);
});

test('unit:session-tail-published — the publisher reads panes and logs, publishes redacted tails, refreshes a watched session every 3 s and any other every 30 s, and never reads an unlaunched pane', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-tail-'));
  try {
    const log = runLogFile(directory, 'gy-7-approver', T0);
    await writeFile(log, `approver starting\nGRAPHYARD_TOKEN=${token}\n`);
    let now = T0;
    const read: string[] = [], batches: PublishedTail[][] = [];
    const plane = new SessionTails(() => now);
    const publisher = new SessionTailPublisher(HOST, {
      now: () => now,
      readPane: async pane => { read.push(pane); return `pane ${pane} at ${now - T0}\nsecret: ${token}`; },
      publish: async (host, tails) => { batches.push(tails); return plane.publish(JSON.parse(JSON.stringify({ host, tails }))); },
      watched: async () => plane.watched(),
    });
    const agents = [{ name: 'gy-7-review', pane_id: 'p-review' }, { name: 'gy-7-worker', pane_id: 'p-worker' }, { name: 'operator-shell', pane_id: 'p-operator' }];
    publisher.observe(launchedTailSources([item([handle({}), handle({ id: 'w', kind: 'implementation', agentName: 'gy-7-worker', pane: 'p-worker' })])], agents, HOST,
      [{ name: 'gy-7-approver', work: 'work-7', role: 'approver', runtime: 'pi', startedAt: new Date(T0).toISOString(), log }]));
    const published = (at: number) => batches.at(-1)!.map(tail => tail.session).sort();

    // First tick: every launched session is published once; the headless one from its log.
    await publisher.tick();
    assert.deepEqual(published(0), ['gy-7-approver', 'gy-7-review', 'gy-7-worker']);
    const approver = batches[0].find(tail => tail.session === 'gy-7-approver')!;
    assert.deepEqual(approver.lines, ['approver starting', 'GRAPHYARD_TOKEN=[redacted]']);
    assert.equal(approver.surface, 'headless');
    for (const tail of batches[0]) assert.ok(tail.lines.every(line => !line.includes(token)), `${tail.session} is redacted`);

    // A viewer opens the reviewer: from then on it is refreshed every 3 s, the others every 30 s.
    const viewed = plane.read('work-7', 'gy-7-review');
    assert.ok(viewed && viewed.lines.some(line => line.startsWith('pane p-review')), 'the viewer reads the published tail');
    let count = batches.length;
    for (let step = 1; step <= 9; step++) {
      now = T0 + step * watchedRefreshMs;
      if (step % 3 === 0) plane.read('work-7', 'gy-7-review'); // the open viewer keeps reading it
      await publisher.tick();
      if (batches.length > count) { assert.deepEqual(published(step), ['gy-7-review'], `at ${step * 3}s only the watched session is due`); count = batches.length; }
    }
    assert.equal(batches.length - 1, 9, 'the watched session was published on every 3 s tick');
    now = T0 + idleRefreshMs;
    await publisher.tick();
    assert.deepEqual(published(10), ['gy-7-approver', 'gy-7-review', 'gy-7-worker'], 'after 30 s every session is refreshed');
    // Once no viewer has read it for the watch window, the reviewer falls back to the 30 s cadence.
    now += tailWatchMs + watchedRefreshMs;
    const before = batches.length;
    await publisher.tick();
    assert.equal(batches.length, before, 'no session is due while nobody watches');
    assert.ok(!read.includes('p-operator'), 'the unlaunched pane was never read');
    assert.ok(read.every(pane => pane === 'p-review' || pane === 'p-worker'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:session-tail-published — the control plane stores tails only from the coordinator, redacts them again, and marks a session watched when a viewer reads it', async () => {
  const engine = {};
  const tailRoutes = workRoutes.routes.filter(entry => String(entry.path).includes('session-tails'));
  const route = (method: string, path: string) => { for (const entry of tailRoutes) { const params = matchRoute(entry, method, path); if (params) return { entry, params }; } throw new Error(`no route ${method} ${path}`); };
  const call = async (role: string, method: string, path: string, body?: unknown) => {
    const url = new URL(`http://x${path}`), { entry, params } = route(method, url.pathname);
    let status = 200, sent: unknown;
    const context = { actor: { id: role, role }, services: { engine }, url, body: async () => Buffer.from(JSON.stringify(body ?? {})), send: (code: number, data: unknown) => { status = code; sent = data; return Symbol.for('sent'); } } as any;
    try { const result = await entry.handle(context, params); return { status, body: (sent ?? result) as any }; }
    catch (error: any) { return { status: error.status ?? 500, body: { error: error.message } as any }; }
  };
  const tail = { work: 'work-7', session: 'gy-7-review', role: 'reviewer', runtime: 'claude', account: null, principal: 'reviewer-a', startedAt: new Date(T0).toISOString(), surface: 'herdr', attach: 'herdr pane attach p-review', transcript: null,
    lines: [`token=${token}`, 'working'], readAt: new Date(T0).toISOString(), error: null };
  assert.equal((await call('worker', 'POST', '/api/session-tails', { host: HOST, tails: [tail] })).status, 403, 'a worker cannot publish');
  assert.deepEqual((await call('coordinator', 'POST', '/api/session-tails', { host: HOST, tails: [tail] })).body, { watched: [] });
  assert.equal((await call('reader', 'GET', '/api/session-tails?work=work-7')).body.tails[0].session, 'gy-7-review');
  assert.equal((await call('reader', 'GET', '/api/work/work-7/session-tails/missing')).status, 404);
  const read = await call('reader', 'GET', '/api/work/work-7/session-tails/gy-7-review');
  assert.deepEqual(read.body.lines, ['token=[redacted]', 'working']);
  assert.deepEqual(((await call('coordinator', 'GET', '/api/session-tails/watched')).body as any).watched.sort(), ['work-7/gy-7-review', 'work-7/missing']);
  assert.equal((await call('reader', 'GET', '/api/session-tails/watched')).status, 403);
  // No route accepts input for a session: the only write is the coordinator's publish.
  assert.deepEqual(tailRoutes.filter(entry => entry.method !== 'GET').map(entry => entry.path), ['/api/session-tails']);
});

test('unit:session-viewer-read-only — the viewer and the session list render no input control, only text, a log region, the attach command and the transcript path', () => {
  const api = async () => ({ tails: [] });
  const viewer = renderToStaticMarkup(createElement(SessionViewer, { api, work: 'work-7', session: 'gy-7-review', onClose: () => {} }));
  const list = renderToStaticMarkup(createElement(LiveSessions, { api, work: 'work-7' }));
  for (const html of [viewer, list]) {
    assert.doesNotMatch(html, /<(input|textarea|select|form)\b/i);
    assert.doesNotMatch(html, /contenteditable/i);
  }
  assert.match(viewer, /role="log"/);
  assert.match(viewer, /Attach locally/);
  assert.match(viewer, /Transcript/);
  assert.match(viewer, /Read-only live view/);
});

test('unit:headless-surface-configurable — run.<role>.surface is headless by default, accepts herdr, and refuses anything else', () => {
  const run = masterRunSchema.parse({});
  for (const role of ['approver', 'producer', 'research'] as const) assert.equal(roleSurface(run, role), 'headless', role);
  assert.equal(researchSettings(run).surface, 'headless');
  const herdr = masterRunSchema.parse({ approver: { surface: 'herdr' }, producer: { surface: 'herdr' }, research: { surface: 'herdr' } });
  for (const role of ['approver', 'producer', 'research'] as const) assert.equal(roleSurface(herdr, role), 'herdr', role);
  assert.equal(researchSettings(herdr).surface, 'herdr');
  assert.throws(() => masterRunSchema.parse({ producer: { surface: 'tmux' } }));
  // Either surface writes the per-run log the live view reads; only herdr runs in a pane.
  const headless = headlessSurface('/repo', { run }, 'producer', 'gy-7-producer');
  assert.equal(headless.surface, undefined);
  assert.equal(typeof headless.log, 'function');
  assert.equal(typeof headlessSurface('/repo', { run: herdr, herdrWorkspace: 'w1' }, 'producer', 'gy-7-producer').surface, 'function');
});

const fakePi = `const tool = 'graphyard_decide';
process.stdout.write(JSON.stringify({ type: 'session', id: 's-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'judging in a pane' }] } }) + '\\n');
process.stderr.write('a warning on stderr\\n');
process.stdout.write(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'c', toolName: tool, result: { content: [], details: { ok: true, account: process.env.FAKE_ACCOUNT ?? null, leaked: Object.keys(process.env).filter(name => /^GRAPHYARD_/.test(name)) } } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
`;

test('unit:headless-surface-configurable — with surface herdr the run starts in a new Herdr tab, is read back through its log, and still resolves to its payload; the log feeds the live view either way', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-surface-'));
  try {
    const script = join(directory, 'fake-pi.mjs');
    await writeFile(script, fakePi);
    const calls: string[][] = [];
    let paneEnv: Record<string, string> = {}, paneCwd = directory;
    // Herdr, stubbed: a tab is a pane whose `pane run` executes the line in a shell, as a pane would.
    const herdr = async (command: string, args: string[]) => {
      assert.equal(command, 'herdr');
      calls.push(args);
      if (args[0] === 'tab' && args[1] === 'create') {
        paneCwd = args[args.indexOf('--cwd') + 1];
        paneEnv = Object.fromEntries(args.flatMap((arg, index) => args[index - 1] === '--env' ? [arg.split(/=(.*)/s).slice(0, 2)] : []));
        return JSON.stringify({ result: { tab: { tab_id: 't-1' }, root_pane: { pane_id: 'p-run' } } });
      }
      if (args[0] === 'pane' && args[1] === 'run') { spawn('sh', ['-c', args[3]], { cwd: paneCwd, env: { ...process.env, GRAPHYARD_LEAK: 'loop-identity', ...paneEnv }, stdio: 'ignore' }); return '{}'; }
      return '{}';
    };
    const log = join(directory, 'run.log');
    const runner = piRunner({ command: process.execPath, commandArgs: [script], model: 'm', environment: { FAKE_ACCOUNT: 'pi-a' }, log: () => log,
      surface: herdrSurface({ run: herdr, workspace: 'w1', label: 'Approver · gy-7-approver', pollMs: 50 }) });
    const run = runner.start('Judge', { cwd: directory, tool: 'graphyard_decide', validate: payload => payload as any, timeoutMs: 15_000 });
    const result = await run.result();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.ok && result.payload, { ok: true, account: 'pi-a', leaked: [] }, 'the pane run has the account environment and none of the loop identity');
    const created = calls.find(args => args[0] === 'tab')!;
    assert.deepEqual([created[created.indexOf('--workspace') + 1], created[created.indexOf('--label') + 1]], ['w1', 'Approver · gy-7-approver']);
    assert.ok(created.includes('FAKE_ACCOUNT=pi-a'), 'the environment travels on Herdr\'s command line, not typed into the pane');
    assert.deepEqual(calls.filter(args => args[0] === 'pane' && args[1] === 'run').map(args => args[2]), ['p-run']);
    assert.equal(surfacePane(run.id), 'p-run');
    assert.equal(run.log, log);
    assert.match(await readFile(log, 'utf8'), /judging in a pane/, 'the pane tees its output into the per-run log');
    assert.ok(run.events.some(event => event.kind === 'stderr' && /a warning on stderr/.test(event.text)));
    assert.ok(calls.some(args => args[0] === 'pane' && args[1] === 'close' && args[2] === 'p-run'), 'the pane is closed once the run has exited');
    // The live view reads it: a run in a pane is a Herdr source, a child run a headless one.
    const sources = launchedTailSources([item([])], [], HOST, [{ name: 'gy-7-approver', work: 'GY-7', role: 'approver', runtime: 'pi', startedAt: new Date(T0).toISOString(), log, pane: surfacePane(run.id) }]);
    assert.deepEqual(sources.map(source => [source.surface, source.attach]), [[{ kind: 'herdr', pane: 'p-run' }, 'herdr pane attach p-run']]);

    // The default surface: a child of the loop, writing the same log.
    const childLog = join(directory, 'child.log');
    const child = piRunner({ command: process.execPath, commandArgs: [script], model: 'm', log: () => childLog }).start('Judge', { cwd: directory, tool: 'graphyard_decide', validate: payload => payload as any, timeoutMs: 15_000 });
    assert.equal((await child.result()).ok, true);
    assert.match(await readFile(childLog, 'utf8'), /judging in a pane[\s\S]*a warning on stderr/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
