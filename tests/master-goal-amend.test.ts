import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import type { Goal } from '../src/model/goal.js';
import { intentCommand } from '../src/cli/master/intent.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2705: the master applies the operator's answered goals-and-priorities request to a goal under its
// operator-agent identity, since its plain CLI authenticates as a worker the goal route refuses.
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'owner/amend';
const operator: Principal = { id: 'amend-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'amend-coordinator', role: 'coordinator', sessionKind: 'ai' };
const author: Principal = { id: 'amend-author', role: 'admin', sessionKind: 'ai' };
const approver: Principal = { id: 'amend-approver', role: 'admin', sessionKind: 'ai' };
const worker: Principal = { id: 'amend-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, author, approver, worker].map(principal => ({ ...principal, token: `amend-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const agent = { id: 'amend-master-agent', token: `amend-master-agent-${'m'.repeat(32)}` };
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('goal-amend'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('goal_amend_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/goal_amend_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const post = async (credential: string, path: string, body: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
};
const ok = (principal: Principal, path: string, body: unknown) => post(token(principal), path, body);
const outcome = (id: string) => ({ id, title: `An operator sees ${id}`, criteria: [`The ${id} page answers`], case: { id, title: `The ${id} outcome is reachable`, description: 'An operator reads the board.', tags: ['api'], target: 'uat', required: true,
  steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] } });

test('unit:master-goal-amend — `graphyard master goal-amend GOAL-N REQUEST_ID` posts the amendment under the master\'s operator-agent credential, not its worker one, and prints the goal without the retired outcomes', async () => {
  // A landed goal protecting two outcomes; the acceptance commit is merged on the base's history.
  engine.gitRunner = (async (args: string[]) => {
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${'8'.repeat(40)}\n`, stderr: '' };
    if (args[0] === 'rev-list') return { status: 0, stdout: '9'.repeat(40), stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  }) as never;
  engine.baseBranch = 'main';
  const recorded: Goal = await ok(coordinator, 'goals', { statement: 'Operators can promote a release candidate', users: ['Operators running Graphyard'], constraints: ['No new third-party service'], deployTarget: 'uat then production' });
  await ok(author, `goals/${recorded.key}/draft`, { outcomes: [outcome('promotion'), outcome('promotion-audit')], pr: null, branch: 'graphyard/promotion', head: '8'.repeat(40) });
  await ok(approver, `goals/${recorded.key}/approve`, { reason: 'Both cases check what the customer asked for' });
  const goal: Goal = (await ok(coordinator, `goals/${recorded.key}/land`, { mergeSha: '9'.repeat(40) })).goal;
  assert.deepEqual(goal.protected, { cases: ['promotion', 'promotion-audit'], outcomes: ['promotion', 'promotion-audit'] });

  // An item parked on the operator's goals-and-priorities request, answered "Go ahead as asked".
  let work: Work = await engine.execute(operator, 'create', null, { title: 'retire promotion', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await ok(worker, `work/${work.key}/park`, { epoch: work.epoch, kind: 'goals-and-priorities', needed: `A decision to amend ${goal.key}: retire its protected outcome promotion (case promotion)`,
    reason: 'Deleting the case is a goal change', ask: 'Choose whether to retire the outcome.', recommendation: 'Go ahead as asked', why: 'The promotion flow is being removed.' });
  const request = (await store.list()).find(item => item.id === work.id)!.humanRequest!;
  await ok(operator, `work/${work.key}/answer`, { request: request.id, choice: 'agree' });

  await ok(operator, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: ['intent:create'], scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions the master operator agent' });
  // The master session: its own credential is the worker's, its operator-agent credential a private file outside the repository.
  const credentialFile = join(await temporaryDirectory('goal-amend-agent'), 'operator-agent.token');
  await writeFile(credentialFile, agent.token, { mode: 0o600 });
  const used: string[] = [], printed: unknown[] = [];
  const session = { id: 'goal-amend', args: [goal.key, request.id], print: (value: unknown) => printed.push(value), root, master: { operatorAgent: { credentialFile } }, masterToken: token(worker),
    masterMutation: (path: string, data: unknown, key: string, credential: string) => { used.push(credential); return post(credential, path, data, key); } } as unknown as MasterSession;
  await assert.rejects(post(token(worker), `goals/${goal.key}/amend`, { decision: request.id }), /is a worker/, 'the worker credential is refused the goal route');
  await intentCommand(session);
  assert.deepEqual(used, [agent.token], 'posted as the operator agent');
  const amended = printed[0] as Goal;
  assert.deepEqual(amended.protected, { cases: ['promotion-audit'], outcomes: ['promotion-audit'] }, 'the retired outcome and its case leave the protected set');
  assert.equal(amended.amendments?.[0]?.by, agent.id);
  await assert.rejects(intentCommand({ ...session, args: [goal.key] } as MasterSession), /Use master goal-amend GOAL-N REQUEST_ID/);
});
