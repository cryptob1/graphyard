import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { docsHeadroom, docsTrimItem, docsTrimLatitude, docsWordBudgetOf } from '../src/model/documentation.js';
import { defaultChoices, parkRefusal, parkedOnHuman } from '../src/model/human-request.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1395 names this file for its proof: manual:intervention-pattern-human-only-decision-build. Six
// human-only decisions were needed at the build stage between 2026-09-30 and 2026-10-07. Each, as the
// ledger records it (`graphyard events GY-N --kind human.requested --kind human.answered`), judged:
//
//   - GY-1070 (a6485107) and GY-1292 (0ae1de16), goals-and-priorities: the loop's docs-trim item
//     demanded both its target and full retention. Removed by GY-1366: the item carries the
//     operator's answer, so it never asks again (asserted below as the base for this item).
//   - GY-1113 (a8b29a21), goals-and-priorities: "master scope to widen plannedFiles…". A scope
//     widening is an approver's decision through scope-request, never a human's. The park is refused.
//   - GY-1384 (6097f31f) and GY-1365 (b9b064b3), money-or-accounts: necessary account actions, each
//     answered within seconds with the bare default "Approve", which recorded "provided" while
//     nothing had been set up. GY-1384's resumed worker found the repository still 404 and asked
//     again. The default Approve now takes the operator's words, so a press says what exists.
//   - GY-1384 (601f62a1), money-or-accounts: that second ask, which said the later human steps "will
//     each park once more, one at a time". A park that defers steps is refused: one request names them all.

const asked = {
  'GY-1113': 'master scope to widen plannedFiles to include src/master/profiles.ts, src/master.ts, src/master/config.ts, src/daemon/effects.ts, src/cli/master/operations.ts, tests/role-concurrency.test.ts, tests/fault-class-capacity.test.ts',
  'GY-1384-1': 'Operator-run pilot access for cryptob1/graphyard-install-proof: (1) make the repository reachable (it returns 404 to the public API and to this worker\'s repo-scoped App token) and run the pilot under a gh login with ADMIN viewerPermission on it (setup-from-zero step 1 HUMAN); (2) create and install the Graphyard GitHub App and the reviewer App on that repository, approving any GitHub Mobile Confirm access prompt (steps 4-5 HUMAN); (3) finish /login for the fresh Claude/Codex agent environments (step 8 HUMAN). Alternatively, re-scope AC-1 to a walk an agent identity can complete.',
  'GY-1384-2': 'Step 1 of docs/setup-from-zero.md for cryptob1/graphyard-install-proof, in two parts. (a) On GitHub, create the repository cryptob1/graphyard-install-proof (it returns 404 today; empty is fine, the worker pushes its default branch, test suite and CI workflow). (b) Press the button below and paste a GitHub token of an admin of that repository, with scopes repo, workflow and admin:repo_hook (or a fine-grained token for that one repository with Administration, Contents, Pull requests, Workflows and Webhooks read-and-write). It is sealed to host vishrog: the resumed worker reads it with `graphyard unseal GY-1384` into a scratch GH_CONFIG_DIR and never prints it. The later HUMAN steps (4-5: Create GitHub App and the reviewer App at http://127.0.0.1:4311 on vishrog; 8: /login in the fresh Claude and Codex environments; 10: a Chrome profile signed in to GitHub) will each park once more, one at a time, when the walk reaches them.',
  'GY-1365': 'Register or choose the revert approver GitHub App (the reviewer App serves; it must differ from the control-plane App), install it on the repository, set GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID and GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY (or _PRIVATE_KEY_FILE) on the production control plane via scripts/provision-railway.mjs operator input, and redeploy',
} as const;

test('manual:intervention-pattern-human-only-decision-build — GY-1070 and GY-1292: the docs-trim item carries the answer they parked on', () => {
  const budget = docsWordBudgetOf({ paths: ['docs/', 'README.md'], wordBudget: { total: 12_000, perPage: 1_200 } })!;
  const item = docsTrimItem(docsHeadroom({ 'docs/master-agent.md': 959, 'README.md': 10_753 }, budget), 'origin/main');
  assert.ok(item.criteria[0].text.endsWith(docsTrimLatitude), 'the trade-off both items asked about is the criterion\'s own');
  assert.doesNotMatch(item.criteria[0].text, /every behaviour, command, configuration and API documented before the change is still documented/);
});

test('manual:intervention-pattern-human-only-decision-build — each request is judged: a scope widening and a deferred ask are refused, the account actions may park', () => {
  assert.match(parkRefusal({ needed: asked['GY-1113'] })!, /scope widening is not a human-only decision: ask for it with graphyard scope-request/);
  assert.match(parkRefusal({ needed: asked['GY-1384-2'] })!, /every human step the item still needs in this one request/);
  assert.equal(parkRefusal({ needed: asked['GY-1384-1'] }), null, 're-scoping a criterion is not a scope widening');
  assert.equal(parkRefusal({ needed: asked['GY-1365'] }), null);
  assert.deepEqual(defaultChoices('money-or-accounts')[0], { id: 'approve', label: 'Approve, saying what you approved or set up…', outcome: 'provided', input: 'text' });
});

const repository = 'owner/human-only-build';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, worker].map(principal => ({ ...principal, token: `human-only-build-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_HUMAN_ONLY_BUILD_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1395);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('human-only-build'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('human_only_build_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/human_only_build_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function call(credential: string, path: string, body: unknown, status: number) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, status, `POST ${path}: ${text}`);
  return JSON.parse(text) as any;
}
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
async function claimed(subject: string) {
  let work: Work = await engine.execute(operator, 'create', null, { title: `${subject} replay`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  return engine.execute(worker, 'claim', work.id, {}, randomUUID());
}

test('manual:intervention-pattern-human-only-decision-build — GY-1113 and GY-1384 (601f62a1): the server refuses each park as recorded, and the worker keeps its lease', async () => {
  for (const [subject, kind, needed] of [['GY-1113', 'goals-and-priorities', asked['GY-1113']], ['GY-1384', 'money-or-accounts', asked['GY-1384-2']]] as const) {
    const work = await claimed(subject);
    const refused = await call(token(worker), `work/${work.key}/park`, { epoch: work.epoch, kind, needed, reason: 'as recorded' }, 422);
    assert.equal(refused.error, parkRefusal({ needed }), `${subject} is told where the ask belongs`);
    const after = await reload(work.id);
    assert.equal(parkedOnHuman(after), false, `${subject} never reaches the human`);
    assert.equal(after.lease?.owner, worker.id, 'the attempt continues');
  }
});

test('manual:intervention-pattern-human-only-decision-build — GY-1384 (6097f31f) and GY-1365: the bare Approve that resumed them with nothing set up is refused; the operator\'s words resume them', async () => {
  for (const [subject, needed] of [['GY-1384', asked['GY-1384-1']], ['GY-1365', asked['GY-1365']]] as const) {
    const work = await claimed(subject);
    await call(token(worker), `work/${work.key}/park`, { recommendation: 'Approve', why: 'Nothing else unblocks the item.', epoch: work.epoch, kind: 'money-or-accounts', needed, reason: 'an account action only the operator may take' }, 200);
    const request = (await reload(work.id)).humanRequest!;
    const bare = await call(token(operator), `work/${work.key}/answer`, { request: request.id, choice: 'approve' }, 422);
    assert.match(bare.error, /needs your words in the note/);
    assert.ok(parkedOnHuman(await reload(work.id)), `${subject} still waits: nothing was said to be set up`);
    await call(token(operator), `work/${work.key}/answer`, { request: request.id, choice: 'approve', note: 'Repository created; App installed' }, 200);
    const answered = (await reload(work.id)).humanRequests!.at(-1)!.answer!;
    assert.equal(answered.text, 'Approve, saying what you approved or set up…: Repository created; App installed', 'the resumed worker reads what exists');
  }
});
