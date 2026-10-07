import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { HumanSignIn, maxSignInLinks, maxSignInSessions, signInLinkTtlMs, signInSessionTtlMs } from '../src/server/auth.js';
import { hostSealKey, loginCommand, parkArgs, parkCommand, unsealOnHost } from '../src/cli/session-commands.js';
import { defaultChoices, requestChoices, resolveHumanAnswer, type HumanRequestRow } from '../src/model/human-request.js';
import type { Principal, Work } from '../src/model.js';
import HumanRequestsPage, { signInAction } from '../web/pages/human-requests.js';
import { redeemSignIn, signInCode } from '../web/pages/login.js';
import { sealToHost } from '../src/server/waits.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { buildPlan, coreEnv, materializeInstall, prepareInstall } from '../src/install/index.js';
import { principalSchema } from '../src/server/principals.js';
import { previewPrincipalRotation, readProposedRoster } from '../src/master/autonomy.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-738: the decisions only a human may make are the easiest thing in the product. The operator
 * signs in as a human from a one-time link, never by pasting a token, and each request offers the
 * requester's ready-made choices as buttons. Each test is named for the proof it produces and
 * runs the real routes, the real answer transaction and the real page on a disposable Postgres.
 */
const repository = 'owner/human-decisions';
// As an installation provisions them: an admin operator credential declared a human session, a
// worker, and a read-only dashboard credential; and an admin credential that declares no session
// kind, which the server never treats as human (GY-1186).
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const undeclaredAdmin: Principal = { id: 'undeclared-admin', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker', sessionKind: 'ai' };
const reader: Principal = { id: 'dashboard', role: 'reader' };
const credentials = [operator, undeclaredAdmin, worker, reader].map(principal => ({ ...principal, token: `human-decisions-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, sealHome: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_HUMAN_DECISIONS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 738);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('human-decisions'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('human_decisions_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/human_decisions_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  sealHome = await temporaryDirectory('seal');
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

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
  for (const other of [worker, reader, undeclaredAdmin]) assert.equal((await call(token(other), 'sign-in-links', {})).status, 403, other.id);
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
  // An admin declared an AI session issues none: redeeming would declare that agent's session human (GY-1041).
  assert.throws(() => table.issue({ id: 'operator-bot', role: 'admin', sessionKind: 'ai' }, true), /operator-bot is declared an AI session and issues none/);
  // Nor does an admin that declares nothing: the link would open a human session for it (GY-1186).
  assert.throws(() => table.issue(undeclaredAdmin, true), /undeclared-admin is not declared "sessionKind": "human" and issues none/);

  // A request an admin credential not declared human cannot answer, because it is not a human session; the sign-in session can.
  const work = await park(await claimed(), ['money-or-accounts', 'A', 'hosting', 'plan', '--ask', 'Approve the staging hosting plan', '--', 'Staging needs a paid plan']);
  const rows = (await ok(token(operator), 'human-requests')).requests as HumanRequestRow[];
  const row = rows.find(entry => entry.id === work.id)!;
  assert.equal((await call(token(undeclaredAdmin), `work/${work.id}/answer`, { ...row.choices![0].body })).status, 403, 'an undeclared admin token is not a human session');
  // A reader, an agent or an undeclared admin credential sees why it cannot answer and the sign-in action, never a command.
  for (const actor of [reader, worker, { id: 'master', role: 'operator-agent', sessionKind: 'ai' } as Principal, undeclaredAdmin]) {
    const markup = page(actor, rows, [work]);
    assert.ok(markup.includes(signInAction), `${actor.id} is offered ${signInAction}`);
    assert.ok(markup.includes('This session cannot answer it'), `${actor.id} is told why`);
    assert.ok(!markup.includes('graphyard answer') && !markup.includes(row.answer.cli), `${actor.id} is shown no command`);
    assert.ok(!markup.includes(row.choices![0].label + '</button>'), `${actor.id} is shown no answer buttons`);
  }
  const human = page(status.actor, rows, [work]);
  assert.ok(!human.includes(signInAction) && human.includes('human operator'), 'the human session sees who it is and the choices');
  // The default Approve takes the operator's words (GY-1395): a bare press resumed items with nothing set up.
  await ok(session, `work/${work.id}/answer`, { ...row.choices![0].body, [row.choices![0].note!]: 'Bought the staging plan' });
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
  const work = await park(await claimed(), ['money-or-accounts', 'A', 'Hetzner', 'Cloud', 'project', '--ask', 'Approve a Hetzner Cloud project for the install proofs', '--choice', 'Approve up to €50/month', '--choice-text', 'Approve with a different cap…', '--', 'The', 'live-install', 'proofs', 'provision', 'servers']);
  assert.deepEqual(requestChoices(work.humanRequest!).map(choice => choice.label), ['Approve up to €50/month', 'Approve with a different cap…', 'Decline']);
  const rows = (await ok(session, 'human-requests')).requests as HumanRequestRow[];
  const row = rows.find(entry => entry.id === work.id)!;

  // The card: each choice a button, the note optional, the terminal folded away and never the primary path.
  const sent: { id: string; command: string; body: any }[] = [];
  const markup = page({ id: operator.id, role: 'admin', sessionKind: 'human' }, rows, [work], (id, command, body) => sent.push({ id, command, body }));
  for (const label of ['Approve up to €50/month</button>', 'Approve with a different cap…</button>', 'Decline</button>']) assert.ok(markup.includes(label), label);
  assert.match(markup, /<details class="agent-details"><summary class="muted">Details for agents<\/summary>.*<dt>From a terminal<\/dt><dd><code>graphyard answer/);
  assert.ok(markup.indexOf('Approve up to €50/month</button>') < markup.indexOf('From a terminal'), 'the buttons come first');

  // A choice that asks for words is refused without them; one click with a note is the whole answer.
  const [cap, other] = row.choices!;
  assert.equal((await call(session, `work/${work.id}/${row.answer.post.command}`, other.body)).status, 422);
  const answered = await ok(session, `work/${work.id}/${row.answer.post.command}`, { ...cap.body, [cap.note!]: 'Cancel it after the proofs' });
  assert.equal(answered.humanRequest, null); assert.equal(answered.blocker, null);
  const record = (await reload(work.id)).humanRequests!.at(-1)!.answer!;
  assert.deepEqual([record.outcome, record.choice, record.note, record.text, record.by], ['provided', { id: 'choice-1', label: 'Approve up to €50/month' }, 'Cancel it after the proofs', 'Approve up to €50/month: Cancel it after the proofs', operator.id]);

  // Declining is a button too, and keeps the item parked on the human's words.
  const declined = await park(await claimed(), ['goals-and-priorities', 'Ship', 'the', 'beta', '--ask', 'Decide whether to ship the beta', '--', 'Priorities']);
  const declineRow = ((await ok(session, 'human-requests')).requests as HumanRequestRow[]).find(entry => entry.id === declined.id)!;
  assert.deepEqual(declineRow.choices!.map(choice => choice.label), ['Go ahead as asked', 'Go ahead differently…', 'Decline']);
  const after = await ok(session, `work/${declined.id}/answer`, declineRow.choices!.at(-1)!.body);
  assert.match(after.blocker, /A human declined goals and priorities for this item: Decline$/);

  // A credential: provided now in a secret input, sealed to the requesting host, never written in the clear.
  const secret = `hcloud-${randomUUID()}`;
  const credential = await park(await claimed(), ['credentials-for-people', 'An', 'API', 'token', 'for', 'the', 'staging', 'project', '--ask', 'Provide an API token for the staging project', '--', 'The', 'deploy', 'needs', 'it']);
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

test('unit:sign-in-tables-bounded — the sign-in link and session tables stay bounded however often an admin asks for a link: the oldest entry goes first and the newest still works (GY-1041)', async () => {
  // Bounded: the oldest link and session go first once the cap is reached; the newest still work.
  const now = Date.parse('2026-10-02T12:00:00Z');
  const table = new HumanSignIn(() => now);
  const links = Array.from({ length: maxSignInLinks + 5 }, () => table.issue(operator, true));
  assert.throws(() => table.redeem(links[0].code), /expired or was already used/, 'the oldest link was dropped at the cap');
  assert.equal(table.redeem(links.at(-1)!.code).actor.id, operator.id, 'the newest link still opens');
  const sessions = Array.from({ length: maxSignInSessions + 3 }, () => table.redeem(table.issue(operator, true).code));
  assert.equal(table.authenticate(sessions[0].token), null, 'the oldest session was dropped at the cap');
  assert.ok(table.authenticate(sessions.at(-1)!.token), 'the newest session stands');
  const held = table as unknown as { links: Map<string, unknown>; sessions: Map<string, unknown> };
  assert.ok(held.links.size <= maxSignInLinks && held.sessions.size <= maxSignInSessions, `${held.links.size} links, ${held.sessions.size} sessions`);
});

test('unit:host-seal-key-recovers-interrupted-write — a sealing key a killed first use left truncated is replaced, a whole key missing its public half keeps its key, and either way the host opens what is sealed to it (GY-1186)', async () => {
  const home = await temporaryDirectory('seal-recovery');
  await mkdir(join(home, 'seal'), { recursive: true });
  // The private key file was created, then the process died before every byte or the public half was written.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await writeFile(join(home, 'seal', 'cut-host.pem'), privateKey.slice(0, privateKey.indexOf('\n') + 5), { mode: 0o600 });
  const replaced = await hostSealKey('cut-host', home);
  assert.match(replaced, /^-----BEGIN PUBLIC KEY-----/);
  const secret = `sealed-${randomUUID()}`;
  assert.equal(await unsealOnHost(sealToHost(replaced, secret), 'cut-host', home), secret, 'the replaced key opens what is sealed to its public half');
  assert.equal(await hostSealKey('cut-host', home), replaced, 'the next use reads the same key');
  // A whole private key whose public half never landed: the key stays, and the public half is derived from it.
  await rm(join(home, 'seal', 'cut-host.pem.pub'));
  assert.equal(await hostSealKey('cut-host', home), replaced, 'the existing key is kept');
  // A public half an older version left truncated: the original key comes back and the copy is rewritten (GY-1211).
  await writeFile(join(home, 'seal', 'cut-host.pem.pub'), replaced.slice(0, 40));
  assert.equal(await hostSealKey('cut-host', home), replaced, 'a truncated public half is derived again from the kept key');
  assert.equal((await readFile(join(home, 'seal', 'cut-host.pem.pub'), 'utf8')).trim(), replaced, 'the public half on disk is whole again');
  // A whole public half of some other key, as a lost concurrent first use could leave: the private key wins.
  const { publicKey: stranger } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await writeFile(join(home, 'seal', 'cut-host.pem.pub'), stranger);
  assert.equal(await hostSealKey('cut-host', home), replaced, 'a public half of another key is never returned');
  assert.equal((await readFile(join(home, 'seal', 'cut-host.pem.pub'), 'utf8')).trim(), replaced);
  assert.equal(await unsealOnHost(sealToHost(await hostSealKey('cut-host', home), secret), 'cut-host', home), secret);
  assert.deepEqual((await readdir(join(home, 'seal'))).sort(), ['cut-host.pem', 'cut-host.pem.pub'], 'no scratch file is left behind');
});

test('unit:host-seal-key-without-hard-links-keeps-first-key — concurrent first uses on a filesystem without hard links all return the one key that landed, and a stale lock is cleared (GY-1211)', async () => {
  const home = await temporaryDirectory('seal-no-links');
  const noLinks = async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  const keys = await Promise.all(Array.from({ length: 6 }, () => hostSealKey('fuse-host', home, noLinks)));
  assert.equal(new Set(keys).size, 1, 'every concurrent first use returns the same public half');
  assert.equal((await readFile(join(home, 'seal', 'fuse-host.pem.pub'), 'utf8')).trim(), keys[0], 'the public half on disk matches what was returned');
  const secret = `sealed-${randomUUID()}`;
  assert.equal(await unsealOnHost(sealToHost(keys[0], secret), 'fuse-host', home), secret, 'the private key opens what is sealed to the returned public half');
  assert.deepEqual((await readdir(join(home, 'seal'))).sort(), ['fuse-host.pem', 'fuse-host.pem.pub'], 'no scratch or lock file is left behind');
  // A lock a killed first use left behind, long enough ago, does not keep the next first use waiting.
  const lock = join(home, 'seal', 'stale-host.pem.lock');
  await writeFile(lock, '1\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  const recovered = await hostSealKey('stale-host', home, noLinks);
  assert.equal(await unsealOnHost(sealToHost(recovered, secret), 'stale-host', home), secret);
  assert.deepEqual((await readdir(join(home, 'seal'))).filter(name => name.startsWith('stale-host')).sort(), ['stale-host.pem', 'stale-host.pem.pub']);
  // Concurrent first uses behind one stale lock still take turns: none removes a lock another took (GY-1219).
  const raced = join(home, 'seal', 'raced-host.pem.lock');
  await writeFile(raced, '1\n');
  await utimes(raced, old, old);
  const racedKeys = await Promise.all(Array.from({ length: 6 }, () => hostSealKey('raced-host', home, noLinks)));
  assert.equal(new Set(racedKeys).size, 1, 'every first use behind a stale lock returns the same public half');
  assert.equal(await unsealOnHost(sealToHost(racedKeys[0], secret), 'raced-host', home), secret);
  assert.deepEqual((await readdir(join(home, 'seal'))).filter(name => name.startsWith('raced-host')).sort(), ['raced-host.pem', 'raced-host.pem.pub']);
  // The turn after a stale lock is a lock of its own: while another first use holds it, a waiter
  // neither publishes a key nor removes either lock, and it takes its turn once the holder lets go.
  const passed = join(home, 'seal', 'turn-host.pem.lock'), turn = `${passed}.1`;
  await writeFile(passed, '1\n');
  await utimes(passed, old, old);
  await writeFile(turn, '2\n');
  const waiting = hostSealKey('turn-host', home, noLinks);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await readdir(join(home, 'seal'))).filter(name => name.startsWith('turn-host.pem') && !name.endsWith('.tmp')).sort(), ['turn-host.pem.lock', 'turn-host.pem.lock.1'], 'the waiter publishes nothing and removes no lock while the turn is held');
  await rm(turn);
  assert.equal(await unsealOnHost(sealToHost(await waiting, secret), 'turn-host', home), secret);
  assert.deepEqual((await readdir(join(home, 'seal'))).filter(name => name.startsWith('turn-host')).sort(), ['turn-host.pem', 'turn-host.pem.pub']);
});

test('unit:operator-principal-declared-human — the install plan declares its operator principal a human session and no agent principal; a roster rotation keeps it so', async () => {
  const fixture = await harness({ provider: 'railway' });
  try {
    const session = await materializeInstall(await prepareInstall(fixture.root, { repository: 'owner/project', provider: 'railway', workers: 2, producerProofs: ['integration:claim-safety'] }, fixture.deps, 'apply'));
    const plan = await buildPlan(session);
    assert.deepEqual(plan.principals.filter(principal => principal.sessionKind === 'human').map(principal => principal.id), ['owner-project-operator'], 'the plan declares the operator, and only it, human');
    // What the deployment authenticates: GRAPHYARD_PRINCIPALS as the server parses it.
    const deployed = principalSchema.parse(JSON.parse(coreEnv(session).find(value => value.name === 'GRAPHYARD_PRINCIPALS')!.value));
    assert.deepEqual(deployed.map(principal => [principal.id, principal.role, principal.sessionKind]), [
      ['owner-project-operator', 'admin', 'human'], ['owner-project-master', 'coordinator', 'ai'], ['owner-project-worker-1', 'worker', 'ai'], ['owner-project-worker-2', 'worker', 'ai'],
      ['owner-project-dashboard', 'reader', 'ai'], ['owner-project-ci', 'producer', 'ai']]);

    // `master principals` reads the proposed roster from .graphyard/credentials.json and previews it
    // against the live one: adding a worker keeps the operator human and applies.
    const live = deployed.map(({ token: _token, ...principal }) => principal);
    const roster = async (entries: object[]) => {
      await mkdir(join(fixture.root, '.graphyard'), { recursive: true });
      await writeFile(join(fixture.root, '.graphyard/credentials.json'), JSON.stringify(entries), { mode: 0o600 });
      return previewPrincipalRotation(live, await readProposedRoster(fixture.root));
    };
    const rotated = await roster([...deployed, { id: 'owner-project-worker-3', role: 'worker', sessionKind: 'ai', token: 'w'.repeat(43) }]);
    assert.equal(rotated.applicable, true, rotated.refusals.join('; '));
    assert.deepEqual(rotated.humans, ['owner-project-operator']);
    // A rotation that drops the declaration (the 2026-09-26 roster: nobody human) is refused.
    const undeclared = await roster(deployed.map(({ sessionKind: _kind, ...principal }) => principal));
    assert.equal(undeclared.applicable, false);
    assert.ok(undeclared.refusals.includes('owner-project-operator would stop being a declared human session'));
    assert.ok(undeclared.refusals.some(refusal => /no admin principal is declared "sessionKind": "human"; declare the operator's \(owner-project-operator\)/.test(refusal)));
    // An agent principal declared human is refused too: it could answer a human-only request itself.
    const agentHuman = await roster(deployed.map(principal => principal.role === 'worker' ? { ...principal, sessionKind: 'human' } : principal));
    assert.deepEqual(agentHuman.refusals, ['owner-project-worker-1 (worker) is an agent role and may not be declared human', 'owner-project-worker-2 (worker) is an agent role and may not be declared human']);
    // An unknown session kind is refused before apply: the deployment parses `human` or `ai` and
    // nothing else, and a typo'd kind beside a valid human admin would fail the redeployed server
    // at start-up after the preview had already called the roster applicable.
    for (const sessionKind of ['a1', 42, null]) {
      await assert.rejects(roster(deployed.map(principal => principal.role === 'worker' ? { ...principal, sessionKind } : principal)), /sessionKind is "human" or "ai"/);
    }
    await assert.doesNotReject(roster(deployed.map(principal => ({ ...principal, sessionKind: undefined }))), 'an absent declaration stays allowed: the preview reports it');
  } finally { await fixture.cleanup(); }
});
