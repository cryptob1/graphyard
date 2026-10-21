import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { appendGoal, applyGoalCommand, recordGoal, type Goal } from '../src/model/goal.js';
import { gitRunnerFor, type GitRunner } from '../src/merge-writer/local-observation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1922. On a compose install the control plane's checkout is bind-mounted into the server container,
 * whose `git fetch origin` over SSH fails (no GitHub host key, no credential), while the loop fetches
 * into that same checkout from the host. The land route judges a merge-writer acceptance landing from
 * the checkout's refs/remotes/origin/BASE when its own fetch fails; GY-1661's
 * refusals still hold for a ref that does not show the merge of the approved head on its first-parent history.
 */
const admin: Principal = { id: 'gl-admin', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'gl-master', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'gl-operator-agent', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'gl-approver', role: 'admin', sessionKind: 'ai' };
const credentials = [admin, coordinator, author, approver].map(principal => ({ ...principal, token: `gl-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let fixture: string, origin: string, writer: string, plane: string, goals = 0;
const fetches: string[][] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
// The container's view of an SSH origin: every fetch fails as it did on the Snake install.
const sshOrigin = 'git@github.com:owner/project.git';
const unreachable = () => { git(plane, 'remote', 'set-url', 'origin', sshOrigin); git(plane, 'config', 'core.sshCommand', 'sh -c \'echo "Host key verification failed." >&2; exit 255\''); };
const reachable = () => { git(plane, 'remote', 'set-url', 'origin', origin); git(plane, 'config', '--unset', 'core.sshCommand'); };
/** The loop's own fetch on the host, into the same checkout. */
const loopFetches = () => execFileSync('git', ['-C', plane, 'fetch', '-q', '--no-tags', origin, '+refs/heads/main:refs/remotes/origin/main']);

before(async () => {
  fixture = await realpath(await temporaryDirectory('goal-land-no-fetch'));
  origin = join(fixture, 'origin.git'); writer = join(fixture, 'writer'); plane = join(fixture, 'plane');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, writer], { stdio: 'ignore' });
  git(writer, 'config', 'user.email', 't@example.com'); git(writer, 'config', 'user.name', 'T');
  await writeFile(join(writer, 'README.md'), '# base\n');
  git(writer, 'add', '-A'); git(writer, 'commit', '-q', '-m', 'base'); git(writer, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, plane], { stdio: 'ignore' });
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goal-land-no-fetch-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('goal_land_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/goal_land_test`); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  const runner = gitRunnerFor(plane);
  engine.gitRunner = ((args, options) => { if (args[0] === 'fetch') fetches.push([...args]); return runner(args, options); }) as GitRunner;
  engine.baseBranch = 'main';
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (fixture) await rm(fixture, { recursive: true, force: true }); });

async function call(principal: Principal, path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return text; } })() as any };
}
const readGoal = async (key: string) => (await call(coordinator, `goals/${key}`)).body.goal as Goal;

/** The merge writer's acceptance change: a commit on its own branch off main, returned unmerged. */
async function acceptanceHead(name: string) {
  git(writer, 'checkout', '-q', '-B', name, 'main');
  await writeFile(join(writer, `${name}.json`), '{}\n');
  git(writer, 'add', '-A'); git(writer, 'commit', '-q', '-m', name);
  const head = git(writer, 'rev-parse', 'HEAD');
  git(writer, 'checkout', '-q', 'main');
  return head;
}
/** The merge writer lands `head` as a merge commit on main and pushes it. */
function land(head: string) {
  git(writer, 'merge', '-q', '--no-ff', '-m', `land ${head.slice(0, 12)}`, head);
  git(writer, 'push', '-q', 'origin', 'main');
  return git(writer, 'rev-parse', 'HEAD');
}
/** A goal the approver accepted at `head`, for the control-plane merge writer (no pull request). */
async function acceptedGoal(head: string): Promise<Goal> {
  const at = new Date(0).toISOString(), outcome = `outcome-${++goals}`;
  const recorded = recordGoal({ statement: `Customers are greeted (${outcome})`, users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, `GOAL-${goals}`, { actor: author, at });
  const outcomes = [{ id: outcome, title: `A customer is greeted (${outcome})`, criteria: ['The greeting names the customer'],
    case: { id: outcome, title: `${outcome} answers`, tags: ['api'], target: 'uat', required: true, steps: [{ kind: 'http', name: 'read the greeting', method: 'GET', path: '/', status: 200 }] } }];
  const drafted = applyGoalCommand(recorded, 'draft', { outcomes, pr: null, branch: `graphyard/goal-${goals}-acceptance-1`, head }, { actor: author, at });
  const accepted = applyGoalCommand(drafted, 'approve', { reason: 'what customers asked for' }, { actor: approver, at });
  await store.transaction(async db => {
    await appendGoal(db, author.id, 'record', recorded, {});
    await appendGoal(db, author.id, 'draft', drafted, {});
    await appendGoal(db, approver.id, 'approve', accepted, {});
  });
  return accepted;
}

test('unit:goal-land-without-server-fetch — with the server\'s fetch failing on host-key verification, a landing the checkout\'s origin ref already holds at the approved head is recorded merged and the goal plans', { timeout: 120_000 }, async () => {
  const head = await acceptanceHead('acceptance-1');
  const goal = await acceptedGoal(head);
  const mergeSha = land(head);
  loopFetches();
  unreachable();
  assert.throws(() => execFileSync('git', ['-C', plane, 'fetch', 'origin'], { stdio: 'pipe' }), /Host key verification failed/, 'the server\'s own fetch cannot succeed');
  assert.equal(git(plane, 'rev-parse', 'refs/remotes/origin/main'), mergeSha, 'the loop\'s fetch left the landing in the shared checkout');

  fetches.length = 0;
  const landed = await call(author, `goals/${goal.key}/land`, { mergeSha });
  assert.equal(landed.status, 200, landed.text);
  assert.equal(landed.body.landing.state, 'merged');
  assert.equal(fetches.length, 1, 'the route tried its fetch, and judged the checkout\'s ref once it failed');
  const merged = await readGoal(goal.key);
  assert.equal(merged.stage, 'planning');
  assert.equal(merged.merged!.pr, null); assert.equal(merged.merged!.mergeSha, mergeSha);
  // A retry answers merged without judging again.
  const again = await call(author, `goals/${goal.key}/land`, { mergeSha });
  assert.equal(again.status, 200, again.text); assert.equal(again.body.landing.state, 'merged');
});

test('unit:goal-land-stale-ref-refused — a landing neither the checkout\'s origin ref nor a fetch shows is refused with the retryable 503 and records nothing; a ref holding an obsolete merge is refused', { timeout: 120_000 }, async () => {
  reachable(); loopFetches();
  // The ref is stale (the writer pushed after the loop's last fetch) and the fetch fails: 503, nothing recorded.
  const head = await acceptanceHead('acceptance-2');
  const goal = await acceptedGoal(head);
  const mergeSha = land(head);
  unreachable();
  fetches.length = 0;
  const stale = await call(author, `goals/${goal.key}/land`, { mergeSha });
  assert.equal(stale.status, 503, stale.text);
  assert.match(stale.text, /could not fetch main from origin .*Host key verification failed.*nothing is recorded until it can/s);
  assert.equal(fetches.length, 1, 'the route fetched once the checkout\'s ref did not hold the landing');
  assert.equal((await readGoal(goal.key)).stage, 'accepted', 'nothing is recorded');
  assert.equal((await readGoal(goal.key)).merged ?? null, null);

  // An obsolete merge on the ref: main's first-parent history holds a merge of an earlier head, not the
  // approved one. Named as the landing, it is refused whether or not the fetch succeeds.
  const obsoleteHead = await acceptanceHead('acceptance-obsolete');
  const obsolete = land(obsoleteHead);
  const approvedHead = await acceptanceHead('acceptance-3');
  const current = await acceptedGoal(approvedHead);
  reachable(); loopFetches(); unreachable();
  assert.equal(git(plane, 'rev-parse', 'refs/remotes/origin/main'), obsolete, 'the checkout\'s ref holds the obsolete merge');
  const unreached = await call(author, `goals/${current.key}/land`, { mergeSha: obsolete });
  assert.equal(unreached.status, 503, unreached.text);
  reachable();
  const refused = await call(author, `goals/${current.key}/land`, { mergeSha: obsolete });
  assert.equal(refused.status, 422, refused.text); assert.match(refused.text, /is not a merge of the approved head/);
  // A merge of the approved head that the base's first-parent history does not hold is refused too.
  git(writer, 'checkout', '-q', '-b', 'side', 'main');
  git(writer, 'merge', '-q', '--no-ff', '-m', 'side merge', approvedHead);
  const offBase = git(writer, 'rev-parse', 'HEAD');
  git(writer, 'push', '-q', 'origin', 'side'); git(writer, 'checkout', '-q', 'main');
  execFileSync('git', ['-C', plane, 'fetch', '-q', origin, 'side']);
  const sideways = await call(author, `goals/${current.key}/land`, { mergeSha: offBase });
  assert.equal(sideways.status, 422, sideways.text); assert.match(sideways.text, /main's first-parent history does not hold/);
  assert.equal((await readGoal(current.key)).stage, 'accepted', 'nothing is recorded');
  // Once the base holds the approved landing, the goal is recorded merged.
  const landed = land(approvedHead);
  const recorded = await call(author, `goals/${current.key}/land`, { mergeSha: landed });
  assert.equal(recorded.status, 200, recorded.text);
  assert.equal((await readGoal(current.key)).stage, 'planning');
});
