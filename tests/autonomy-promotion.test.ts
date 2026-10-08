import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMasterStatus, loadMasterConfig, loadStoredMasterConfig, type MasterConfig } from '../src/master.js';
import { masterCommands } from '../src/cli/master.js';
import { emptyDispatchCursor, runDispatchTick, selectReviewerProfile, supervisedReview } from '../src/auto-dispatch.js';
import { fleet, requested } from './helpers/review-fleet.js';

// GY-1502: a supervised install becomes autonomous only through `graphyard master promote
// --admin-token-stdin` — precondition-checked, provisioned through the existing autonomy apply, and
// audited. Each test is named for the proof it produces: unit:promotion-preconditions,
// unit:promotion-audited and unit:promotion-enables-reviewer. The module is imported inside each
// test, so on a base without it every proof fails as a test case rather than as a file load.
const promotion = () => import('../src/master/promotion.js');

const OPERATOR = 'octo-operator';
const ADMIN = `admin-${'a'.repeat(40)}`;
/** The login gh holds now, injected so no test reaches the real gh. */
const current = (login: string | null = OPERATOR) => () => login;

/** A control plane that answers the admin and the identities it provisions, recording every write. */
function controlPlane() {
  const agents = new Map<string, any>(), tokens = new Map<string, { id: string; role: string }>([[ADMIN, { id: 'human-operator', role: 'admin' }]]);
  const writes: { path: string; body: any }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, actor = tokens.get(String((init?.headers as Record<string, string>)?.Authorization ?? '').replace(/^Bearer /, ''));
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (!actor) return reply({ error: 'unauthenticated' }, 401);
    if (path === '/api/status') return reply({ actor });
    if (init?.method !== 'POST') return path === '/api/operator-agents' ? reply([...agents.values()]) : reply({ error: 'not found' }, 404);
    const body = JSON.parse(String(init.body)); writes.push({ path, body });
    const [, , , id, verb] = path.split('/');
    if (!id) { agents.set(body.id, { id: body.id, capabilities: body.capabilities, scope: body.scope, revision: 1, lastMutation: { kind: 'setup', reason: body.reason } }); tokens.set(body.token, { id: body.id, role: 'operator-agent' }); }
    else if (verb === 'rotate') tokens.set(body.token, { id: decodeURIComponent(id), role: 'operator-agent' });
    return reply({});
  }) as typeof fetch;
  return { fetcher, writes, agents };
}

/** A master bound to a reviewer App with a reviewer profile (tests/helpers/review-fleet.ts), recorded supervised. */
async function supervisedHost(edit: (config: any) => void = () => {}) {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  const file = join(host.root, '.graphyard/master.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(config, { supervision: 'supervised', operatorLogin: OPERATOR });
  edit(config);
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { ...host, file };
}

test('unit:promotion-preconditions — master promote refuses, naming each missing step and its command, unless a reviewer App is registered, a reviewer profile exists and the reviewer bot is neither the operator nor any worker', async () => {
  const { assertPromotionRoute, promoteToAutonomy, promotionAuditFile, promotionPreconditions, PromotionRefusedError } = await promotion();
  const reviewer = { appId: 5678, installationId: 1, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: '2026-10-08T00:00:00.000Z' };
  const profile = { name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' } as MasterConfig['reviewers'][number];
  const worker = { name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token' } as MasterConfig['workers'][number];
  const ready = { reviewer, reviewers: [profile], workers: [worker], githubAppId: 1234 };
  assert.deepEqual(promotionPreconditions(ready, OPERATOR), [], 'an independent reviewer App with a profile may be promoted');

  // Nothing registered: every missing step is named with the command that takes it.
  const bare = promotionPreconditions({ ...ready, reviewer: undefined, reviewers: [] }, null);
  assert.deepEqual(bare.map(step => step.command), ['graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin)', 'graphyard master reviewer add PROFILE.json', 'gh auth login']);
  assert.match(bare[0].missing, /no reviewer App is registered/); assert.match(bare[1].missing, /no reviewer profile/);
  // The reviewer bot is the operator's own login, the worker App, or a worker's identity: each refused.
  assert.match(promotionPreconditions(ready, 'Graphyard-Reviewer[bot]')[0].missing, /is the operator's own GitHub login/);
  assert.match(promotionPreconditions({ ...ready, githubAppId: 5678 }, OPERATOR)[0].missing, /is the worker App every worker pushes with/);
  assert.match(promotionPreconditions({ ...ready, workers: [{ ...worker, principal: 'graphyard-reviewer[bot]' }] }, OPERATOR)[0].missing, /is the identity of worker claude-primary/);
  // The login up recorded is checked too, never instead of the current one.
  assert.match(promotionPreconditions(ready, OPERATOR, 'graphyard-reviewer[bot]')[0].missing, /is the operator's own GitHub login graphyard-reviewer\[bot\]/);
  assert.deepEqual(promotionPreconditions(ready, null, OPERATOR).map(step => step.command), ['gh auth login'], 'a recorded login never stands in for an unknown current one');

  // The command refuses before it reads the admin credential or writes anything.
  const host = await supervisedHost(config => { delete config.reviewer; config.reviewers = []; });
  try {
    const before = await readFile(host.file, 'utf8'), plane = controlPlane();
    const refused = await promoteToAutonomy(host.root, ADMIN, { fetcher: plane.fetcher, operatorLogin: current() }).catch(error => error);
    assert.ok(refused instanceof PromotionRefusedError);
    assert.match(refused.message, /no reviewer App is registered \(run graphyard master reviewer setup .*\); no reviewer profile is configured \(run graphyard master reviewer add PROFILE\.json\)/);
    assert.deepEqual(plane.writes, [], 'no identity is provisioned');
    assert.equal(await readFile(host.file, 'utf8'), before, 'master.json is unchanged: still supervised');
    await assert.rejects(stat(promotionAuditFile(host.root)), /ENOENT/, 'a refusal is not a promotion');
  } finally { await host.cleanup(); }

  // gh's current login decides even when up recorded another: after a gh switch to the reviewer bot, or with gh unreadable, it refuses.
  const switched = await supervisedHost();
  try {
    const plane = controlPlane();
    const asBot = await promoteToAutonomy(switched.root, ADMIN, { fetcher: plane.fetcher, operatorLogin: current('graphyard-reviewer[bot]') }).catch(error => error);
    assert.ok(asBot instanceof PromotionRefusedError); assert.match(asBot.message, /is the operator's own GitHub login graphyard-reviewer\[bot\]/);
    const unknown = await promoteToAutonomy(switched.root, ADMIN, { fetcher: plane.fetcher, operatorLogin: current(null) }).catch(error => error);
    assert.ok(unknown instanceof PromotionRefusedError); assert.match(unknown.message, /current GitHub login is unknown, .* \(run gh auth login\)/);
    assert.deepEqual(plane.writes, []);
    assert.equal((await loadStoredMasterConfig(switched.root)).supervision, 'supervised');
    // master autonomy --apply no longer bypasses these checks on a supervised install; its preview, and autonomous installs, are unchanged.
    const stored = await loadStoredMasterConfig(switched.root);
    assert.throws(() => assertPromotionRoute(stored, ['--admin-token-stdin', '--apply']), /supervised; it becomes autonomous only through graphyard master promote --admin-token-stdin/);
    assertPromotionRoute(stored, []); assertPromotionRoute({ supervision: 'autonomous' }, ['--admin-token-stdin', '--apply']);
  } finally { await switched.cleanup(); }

  // Routed and documented as an operator command with the admin credential on stdin, and no demotion.
  const help = JSON.stringify(masterCommands);
  assert.match(help, /master promote --admin-token-stdin/);
  assert.ok(!/demot/i.test(help), 'no demotion is offered');
});

test('unit:promotion-audited — promotion provisions the operator-agent and approver through the autonomy apply with a reason naming it, sets supervision autonomous and appends an audit entry; a rerun changes nothing', async () => {
  const { promoteToAutonomy, promotionAuditFile, promotionReason } = await promotion();
  const host = await supervisedHost();
  try {
    const plane = controlPlane();
    await assert.rejects(promoteToAutonomy(host.root, undefined, { fetcher: plane.fetcher, operatorLogin: current() }), /needs the admin credential once, on stdin/);
    const now = new Date('2026-10-08T04:00:00.000Z');
    // The audit entry is written first: one that cannot be written changes nothing, so the install is never autonomous without it, and a rerun promotes.
    const file = promotionAuditFile(host.root);
    await mkdir(file, { recursive: true });
    const unaudited = await readFile(host.file, 'utf8');
    await assert.rejects(promoteToAutonomy(host.root, ADMIN, { fetcher: plane.fetcher, operatorLogin: current(), now: () => now }), /EISDIR/);
    assert.equal(await readFile(host.file, 'utf8'), unaudited, 'still supervised, no identity recorded');
    assert.equal(plane.writes.length, 0, 'no identity is provisioned without its audit entry');
    await rmdir(file);
    const result = await promoteToAutonomy(host.root, ADMIN, { fetcher: plane.fetcher, operatorLogin: current(), now: () => now });
    assert.equal(result.promoted, true);
    // Both identities are created by the existing apply, each with the promotion as its reason.
    const created = plane.writes.filter(write => write.path === '/api/operator-agents');
    assert.deepEqual(created.map(write => write.body.id), ['graphyard-master-project-operator', 'graphyard-approver-project']);
    for (const write of plane.writes) assert.ok(write.body.reason.startsWith(`${promotionReason}: Master autonomy onboarding`), `${write.path} names the promotion`);
    assert.deepEqual(result.changes, ['graphyard-master-project-operator: provisioned', 'graphyard-approver-project: provisioned']);

    const stored = await loadStoredMasterConfig(host.root);
    assert.equal(stored.supervision, 'autonomous');
    assert.equal(stored.operatorAgent!.id, 'graphyard-master-project-operator'); assert.equal(stored.approver!.id, 'graphyard-approver-project');
    assert.equal(stored.reviewer!.slug, 'graphyard-reviewer', 'the registered reviewer App is kept');

    // One audit entry under .graphyard/master-actions: who ran it, the reviewer identity, the time.
    assert.equal(file, join(host.root, '.graphyard/master-actions/promotions.jsonl'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.action, 'promote'); assert.equal(entry.at, now.toISOString());
    assert.deepEqual([entry.from, entry.to], ['supervised', 'autonomous']);
    assert.equal(entry.by.actor, 'human-operator'); assert.equal(entry.by.githubLogin, OPERATOR); assert.ok(entry.by.user && entry.by.host);
    assert.equal(entry.reviewer.app, 'graphyard-reviewer[bot]'); assert.equal(entry.reviewer.appId, 5678);
    assert.deepEqual(entry.identities, { operatorAgent: 'graphyard-master-project-operator', approver: 'graphyard-approver-project' });
    assert.ok(!(await readFile(file, 'utf8')).includes(ADMIN), 'the admin credential is never recorded');

    // A rerun on the now autonomous install changes nothing: no write, no new audit entry, same master.json.
    const config = await readFile(host.file, 'utf8'), writes = plane.writes.length;
    const rerun = await promoteToAutonomy(host.root, ADMIN, { fetcher: plane.fetcher, operatorLogin: current() });
    assert.equal(rerun.promoted, false); assert.deepEqual(rerun.changes, []);
    assert.equal(plane.writes.length, writes);
    assert.equal(await readFile(host.file, 'utf8'), config);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1);
  } finally { await host.cleanup(); }
});

test('unit:promotion-enables-reviewer — after promotion the loop launches the registered reviewer for the next build-passing candidate, and master status no longer shows the supervised line', async () => {
  const { promoteToAutonomy } = await promotion();
  const host = await supervisedHost();
  try {
    const item = requested(1);
    assert.ok(item.gates.find(gate => gate.name === 'build')!.passed, 'the candidate passed the build gate');
    const status = (config: MasterConfig) => buildMasterStatus({ work: [item], now: new Date().toISOString() }, [], [], {}, {}, undefined, 'main', undefined, undefined, undefined, undefined, 'graphyard', null, { mode: config.supervision, operatorLogin: config.operatorLogin }).supervision;

    // Supervised: no reviewer session, and master status names the promotion command.
    let config = await loadMasterConfig(host.root);
    assert.deepEqual(selectReviewerProfile(config), { profile: null, reason: supervisedReview });
    const before = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [item], () => config), Date.now);
    assert.deepEqual(before.launched.filter(entry => entry.kind === 'review'), []);
    assert.match(status(config)!, /^Supervised: .*graphyard master promote --admin-token-stdin/);

    await promoteToAutonomy(host.root, ADMIN, { fetcher: controlPlane().fetcher, operatorLogin: current() });
    config = await loadMasterConfig(host.root);
    assert.equal(config.reviewer!.slug, 'graphyard-reviewer');
    const after = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [item], () => config), Date.now);
    assert.deepEqual(after.launched.filter(entry => entry.kind === 'review').map(entry => [entry.work, entry.profile]), [['GY-501', 'claude-reviewer']], 'the registered reviewer launches');
    assert.equal(status(config), null, 'master status no longer shows the supervised line');
  } finally { await host.cleanup(); }
});
