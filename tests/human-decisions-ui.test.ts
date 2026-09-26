import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { HumanSignIn, signInLinkTtlMs, signInSessionTtlMs } from '../src/server/routes/sign-in.js';
import { hostSealKey, loginCommand, parkArgs, parkCommand, unsealOnHost } from '../src/cli/session-commands.js';
import { defaultChoices, requestChoices, resolveHumanAnswer, type HumanRequestRow } from '../src/model/human-request.js';
import type { Principal, Work } from '../src/model.js';
import HumanRequestsPage, { signInAction } from '../web/pages/human-requests.js';
import { redeemSignIn, signInCode } from '../web/pages/login.js';
import type { Dashboard } from '../web/pages/dashboard.js';

/**
 * GY-738: the decisions only a human may make are the easiest thing in the product. The operator
 * signs in as a human from a one-time link, never by pasting a token, and each request offers the
 * requester's ready-made choices as buttons. Each test is named for the proof it produces and
 * runs the real routes, the real answer transaction and the real page on a disposable Postgres.
 */
const repository = 'owner/human-decisions';
// As an installation provisions them: an admin operator credential that is not itself declared
// human, a worker, and a read-only dashboard credential.
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker', sessionKind: 'ai' };
const reader: Principal = { id: 'dashboard', role: 'reader' };
const credentials = [operator, worker, reader].map(principal => ({ ...principal, token: `human-decisions-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, sealHome: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_HUMAN_DECISIONS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 738);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-human-decisions-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('human_decisions_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/human_decisions_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  sealHome = await mkdtemp(join(tmpdir(), 'graphyard-seal-'));
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); if (sealHome) await rm(sealHome, { recursive: true, force: true }); });

const call = async (credential: string | null, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string | null, path: string, body?: unknown) => { const result = await call(credential, path, body); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
/** A human session, opened exactly as the browser opens it: the link `graphyard login` prints, redeemed without a token. */
async function signIn() {
  const printed: any[] = [];
  await loginCommand.run({ api: (path: string, data?: unknown) => ok(token(operator), path, data), base: `${url}/`, print: (value: unknown) => printed.push(value) } as any, undefined);
  const code = signInCode(new URL(printed[0].signIn).hash)!;
  const redeemed = await redeemSignIn(code, (input, init) => fetch(`${url}${input}`, init));
  assert.equal(redeemed.kind, 'signed-in');
  return { link: printed[0], code, token: (redeemed as { token: string }).token };
}
/** An item a worker holds at epoch 1, as the launcher leaves it. */
async function claimed() {
  const n = ++serial;
  let work = await engine.execute(operator, 'create', null, { title: `Human decision ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  return engine.execute(worker, 'claim', work.id, {}, randomUUID());
}
/** The worker's own `park` command, run under its own credential on a host whose Graphyard home is `sealHome`. */
async function park(work: Work, args: string[]) {
  const previous = process.env.GRAPHYARD_CONFIG_HOME; process.env.GRAPHYARD_CONFIG_HOME = sealHome;
  try { await parkCommand.run({ args: ['1', ...args], print: () => {}, api: (path: string, data?: unknown) => ok(token(worker), path, data), individualHostId: () => 'worker-host' } as any, work); }
  finally { if (previous === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = previous; }
  return reload(work.id);
}
const page = (actor: Principal, rows: HumanRequestRow[], work: Work[], sent?: (id: string, command: string, body: unknown) => void) => renderToStaticMarkup(createElement(HumanRequestsPage, {
  work, status: { actor, humanOnly: rows }, observedAt: Date.now(), busy: false, signOut: () => {}, setSelected: () => {},
  action: async (id: string, command: string, body: unknown) => { sent?.(id, command, body); } } as unknown as Dashboard));

test('unit:operator-sign-in-link — graphyard login prints a one-time link that opens a human admin session bound to the operator; the link is single use and expires, and only the operator credential issues one', async () => {
  const { link, code, token: session } = await signIn();
  assert.match(link.signIn, new RegExp(`^${url}/#sign-in=[A-Za-z0-9_-]{40,}$`), 'the link carries its code in the fragment, which no server log sees');
  assert.equal(link.principal, operator.id); assert.equal(link.singleUse, true);
  assert.ok(Date.parse(link.expiresAt) - Date.now() <= signInLinkTtlMs, 'the link is short-lived');

  // Single use: the same link never opens a second session.
  assert.equal((await call(null, 'sign-in', { code })).status, 401);
  assert.equal((await redeemSignIn(code, (input, init) => fetch(`${url}${input}`, init))).kind, 'refused');
  // The session is the operator's, declared human, and the dashboard reads which identity it is.
  const status = await ok(session, 'status');
  assert.deepEqual([status.actor.id, status.actor.role, status.actor.sessionKind], [operator.id, 'admin', 'human']);
  // Nobody but the operator's own admin credential issues a link; nothing unauthenticated does.
  for (const other of [worker, reader]) assert.equal((await call(token(other), 'sign-in-links', {})).status, 403, other.id);
  assert.equal((await call(null, 'sign-in-links', {})).status, 401);
  assert.equal((await call(null, 'sign-in', { code: 'x'.repeat(43) })).status, 401, 'a code never issued opens nothing');

  // Expiry, on a clock this test moves: an unopened link lapses in minutes, a session in hours.
  let now = Date.parse('2026-09-26T12:00:00Z');
  const table = new HumanSignIn(() => now);
  const late = table.issue(operator, true);
  now += signInLinkTtlMs + 1;
  assert.throws(() => table.redeem(late.code), /expired or was already used/);
  const fresh = table.redeem(table.issue(operator, true).code);
  assert.deepEqual(table.authenticate(fresh.token), { id: operator.id, role: 'admin', sessionKind: 'human' });
  now += signInSessionTtlMs + 1;
  assert.equal(table.authenticate(fresh.token), null, 'the session expires');
  assert.throws(() => table.issue(operator, false), /Only the operator's own admin credential/, 'an unconfigured identity issues none');
  assert.throws(() => table.issue({ id: 'master', role: 'operator-agent' }, true), /Only the operator's own admin credential/);

  // A request the admin credential itself cannot answer, because it is not a human session; the sign-in session can.
  const work = await park(await claimed(), ['money-or-accounts', 'A', 'hosting', 'plan', '--', 'Staging needs a paid plan']);
  const rows = (await ok(token(operator), 'human-requests')).requests as HumanRequestRow[];
  const row = rows.find(entry => entry.id === work.id)!;
  assert.equal((await call(token(operator), `work/${work.id}/answer`, { ...row.choices![0].body })).status, 403, 'the admin token is not a human session');
  // A reader, an agent or the admin credential sees why it cannot answer and the sign-in action, never a command.
  for (const actor of [reader, worker, { id: 'master', role: 'operator-agent', sessionKind: 'ai' } as Principal, operator]) {
    const markup = page(actor, rows, [work]);
    assert.ok(markup.includes(signInAction), `${actor.id} is offered ${signInAction}`);
    assert.ok(markup.includes('This session cannot answer it'), `${actor.id} is told why`);
    assert.ok(!markup.includes('graphyard answer') && !markup.includes(row.answer.cli), `${actor.id} is shown no command`);
    assert.ok(!markup.includes(row.choices![0].label + '</button>'), `${actor.id} is shown no answer buttons`);
  }
  const human = page(status.actor, rows, [work]);
  assert.ok(!human.includes(signInAction) && human.includes('human operator'), 'the human session sees who it is and the choices');
  await ok(session, `work/${work.id}/answer`, { ...row.choices![0].body });
  assert.equal((await reload(work.id)).humanRequests!.at(-1)!.answer!.by, operator.id, 'the answer is the operator\'s');
});

test('unit:human-request-choices — every human-only request carries its requester\'s choices as buttons; one click answers, and the answer records the choice and the note; a credential is sealed to the requesting host', async () => {
  // The requester chooses the buttons with park; Decline is always there.
  assert.deepEqual(parkArgs(['A', 'plan', '--choice', 'Approve up to €50/month', '--choice-text', 'Approve with a different cap…']), {
    needed: 'A plan', choices: [{ id: 'choice-1', label: 'Approve up to €50/month', outcome: 'provided', input: 'none' }, { id: 'choice-2', label: 'Approve with a different cap…', outcome: 'provided', input: 'text' }] });
  assert.throws(() => parkArgs(['A', 'plan', '--choice']), /needs a LABEL/);
  for (const kind of ['money-or-accounts', 'credentials-for-people', 'goals-and-priorities'] as const) assert.equal(defaultChoices(kind).at(-1)!.outcome, 'declined', `${kind} always offers Decline`);
  assert.deepEqual(defaultChoices('credentials-for-people', true)[0], { id: 'provide', label: 'Provide now', outcome: 'provided', input: 'secret' });

  const session = (await signIn()).token;
  const work = await park(await claimed(), ['money-or-accounts', 'A', 'Hetzner', 'Cloud', 'project', '--choice', 'Approve up to €50/month', '--choice-text', 'Approve with a different cap…', '--', 'The', 'live-install', 'proofs', 'provision', 'servers']);
  assert.deepEqual(requestChoices(work.humanRequest!).map(choice => choice.label), ['Approve up to €50/month', 'Approve with a different cap…', 'Decline']);
  const rows = (await ok(session, 'human-requests')).requests as HumanRequestRow[];
  const row = rows.find(entry => entry.id === work.id)!;

  // The card: each choice a button, the note optional, the terminal folded away and never the primary path.
  const sent: { id: string; command: string; body: any }[] = [];
  const markup = page({ id: operator.id, role: 'admin', sessionKind: 'human' }, rows, [work], (id, command, body) => sent.push({ id, command, body }));
  for (const label of ['Approve up to €50/month</button>', 'Approve with a different cap…</button>', 'Decline</button>']) assert.ok(markup.includes(label), label);
  assert.match(markup, /<details><summary class="muted">From a terminal<\/summary><code>graphyard answer/);
  assert.ok(markup.indexOf('Approve up to €50/month</button>') < markup.indexOf('From a terminal'), 'the buttons come first');

  // A choice that asks for words is refused without them; one click with a note is the whole answer.
  const [cap, other] = row.choices!;
  assert.equal((await call(session, `work/${work.id}/${row.answer.post.command}`, other.body)).status, 422);
  const answered = await ok(session, `work/${work.id}/${row.answer.post.command}`, { ...cap.body, [cap.note!]: 'Cancel it after the proofs' });
  assert.equal(answered.humanRequest, null); assert.equal(answered.blocker, null);
  const record = (await reload(work.id)).humanRequests!.at(-1)!.answer!;
  assert.deepEqual([record.outcome, record.choice, record.note, record.text, record.by], ['provided', { id: 'choice-1', label: 'Approve up to €50/month' }, 'Cancel it after the proofs', 'Approve up to €50/month: Cancel it after the proofs', operator.id]);

  // Declining is a button too, and keeps the item parked on the human's words.
  const declined = await park(await claimed(), ['goals-and-priorities', 'Ship', 'the', 'beta', '--', 'Priorities']);
  const declineRow = ((await ok(session, 'human-requests')).requests as HumanRequestRow[]).find(entry => entry.id === declined.id)!;
  assert.deepEqual(declineRow.choices!.map(choice => choice.label), ['Go ahead as asked', 'Go ahead differently…', 'Decline']);
  const after = await ok(session, `work/${declined.id}/answer`, declineRow.choices!.at(-1)!.body);
  assert.match(after.blocker, /A human declined goals and priorities for this item: Decline$/);

  // A credential: provided now in a secret input, sealed to the requesting host, never written in the clear.
  const secret = `hcloud-${randomUUID()}`;
  const credential = await park(await claimed(), ['credentials-for-people', 'An', 'API', 'token', 'for', 'the', 'staging', 'project', '--', 'The', 'deploy', 'needs', 'it']);
  assert.equal(credential.humanRequest!.sealTo, await hostSealKey('worker-host', sealHome), 'the request carries the requesting host\'s key');
  const credentialRow = ((await ok(session, 'human-requests')).requests as HumanRequestRow[]).find(entry => entry.id === credential.id)!;
  const provide = credentialRow.choices![0];
  assert.deepEqual([provide.label, provide.input], ['Provide now', 'secret']);
  assert.ok(page({ id: operator.id, role: 'admin', sessionKind: 'human' }, [credentialRow], [credential]).includes('type="password"'), 'the value is typed into a secret input');
  await ok(session, `work/${credential.id}/answer`, { ...provide.body, secret });
  const sealed = (await reload(credential.id)).humanRequests!.at(-1)!.answer!;
  assert.equal(sealed.text, 'Provide now');
  assert.equal(await unsealOnHost(sealed.sealed!, 'worker-host', sealHome), secret, 'the requesting host opens it');
  const written = JSON.stringify((await store.pool.query('SELECT document FROM work_items')).rows) + JSON.stringify((await store.pool.query('SELECT payload FROM events')).rows) + JSON.stringify((await store.pool.query('SELECT result, fingerprint FROM receipts')).rows);
  assert.ok(!written.includes(secret), 'the value is written nowhere in the clear');
  assert.throws(() => resolveHumanAnswer(credential.humanRequest!, { request: randomUUID(), outcome: 'provided', choice: 'decline', secret }), /sent only with the choice that asks for it/);
});
