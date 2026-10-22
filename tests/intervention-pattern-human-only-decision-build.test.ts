import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { defaultChoices, hostDoableAsk, parkRefusal, parkedOnHuman } from '../src/model/human-request.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1395 names this file for its proof: manual:intervention-pattern-human-only-decision-build. Six
// human-only decisions were needed at the build stage between 2026-09-30 and 2026-10-07. Each, as the
// ledger records it (`graphyard events GY-N --kind human.requested --kind human.answered`), judged:
//
//   - GY-1070 (a6485107) and GY-1292 (0ae1de16), goals-and-priorities: the loop's docs-trim item
//     demanded both its target and full retention. Removed by GY-1366; the whole budget behind that
//     item is gone since GY-2515, so no docs-trim ask can stand again.
//   - GY-1113 (a8b29a21), goals-and-priorities: "master scope to widen plannedFiles…". No file
//     needs permission, so a scope widening is never a human's decision. The park is refused.
//   - GY-1384 (6097f31f) and GY-1365 (b9b064b3), money-or-accounts: necessary account actions, each
//     answered within seconds with the bare default "Approve", which recorded "provided" while
//     nothing had been set up. GY-1384's resumed worker found the repository still 404 and asked
//     again. The default Approve now takes the operator's words, so a press says what exists. Since
//     GY-1416 neither parks: the host's gh login administers the repository, and install derives the
//     revert approver variables from the reviewer App saved on the host (`master setup --apply`).
//   - GY-1384 (601f62a1), money-or-accounts: that second ask, which said the later human steps "will
//     each park once more, one at a time". A park that defers steps is refused: one request names them all.

const asked = {
  'GY-1113': 'master scope to widen plannedFiles to include src/master/profiles.ts, src/master.ts, src/master/config.ts, src/daemon/effects.ts, src/cli/master/operations.ts, tests/role-concurrency.test.ts, tests/fault-class-capacity.test.ts',
  'GY-1384-1': 'Operator-run pilot access for cryptob1/graphyard-install-proof: (1) make the repository reachable (it returns 404 to the public API and to this worker\'s repo-scoped App token) and run the pilot under a gh login with ADMIN viewerPermission on it (setup-from-zero step 1 HUMAN); (2) create and install the Graphyard GitHub App and the reviewer App on that repository, approving any GitHub Mobile Confirm access prompt (steps 4-5 HUMAN); (3) finish /login for the fresh Claude/Codex agent environments (step 8 HUMAN). Alternatively, re-scope AC-1 to a walk an agent identity can complete.',
  'GY-1384-2': 'Step 1 of docs/setup-from-zero.md for cryptob1/graphyard-install-proof, in two parts. (a) On GitHub, create the repository cryptob1/graphyard-install-proof (it returns 404 today; empty is fine, the worker pushes its default branch, test suite and CI workflow). (b) Press the button below and paste a GitHub token of an admin of that repository, with scopes repo, workflow and admin:repo_hook (or a fine-grained token for that one repository with Administration, Contents, Pull requests, Workflows and Webhooks read-and-write). It is sealed to host vishrog: the resumed worker reads it with `graphyard unseal GY-1384` into a scratch GH_CONFIG_DIR and never prints it. The later HUMAN steps (4-5: Create GitHub App and the reviewer App at http://127.0.0.1:4311 on vishrog; 8: /login in the fresh Claude and Codex environments; 10: a Chrome profile signed in to GitHub) will each park once more, one at a time, when the walk reaches them.',
  'GY-1365': 'Register or choose the revert approver GitHub App (the reviewer App serves; it must differ from the control-plane App), install it on the repository, set GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID and GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY (or _PRIVATE_KEY_FILE) on the production control plane via scripts/provision-railway.mjs operator input, and redeploy',
} as const;

test('manual:intervention-pattern-human-only-decision-build — each request is judged: a scope widening and a deferred ask are refused, and (GY-1416) so are the account actions the host could do itself', () => {
  assert.match(parkRefusal({ needed: asked['GY-1113'] })!, /scope widening is not a human-only decision: no file needs permission/);
  assert.match(parkRefusal({ needed: asked['GY-1384-2'] })!, /every human step the item still needs in this one request/);
  // GY-1416: re-scoping a criterion is no scope widening, but the repository is the host's gh login's to make reachable,
  // and the revert approver variables are derived from the reviewer App saved on the host: both are the master's.
  assert.match(parkRefusal({ needed: asked['GY-1384-1'] })!, /a repository the host's gh login can create or administer.*the master's owed action/);
  assert.match(parkRefusal({ needed: asked['GY-1365'] })!, /a deployment variable derived from credentials saved on this host.*graphyard master setup --apply/);
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
  let work: Work = await engine.execute(operator, 'create', null, { title: `${subject} replay`, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
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

// GY-1384 (6097f31f) and GY-1365 are no longer parks at all (GY-1416, above); the bare Approve that resumed
// them is still refused for every account action that does park, such as a paid server.
test('manual:intervention-pattern-human-only-decision-build — GY-1384 (6097f31f) and GY-1365: the bare Approve that resumed them with nothing set up is refused; the operator\'s words resume them', async () => {
  for (const [subject, needed] of [['GY-1384', 'Approve a Hetzner cx22 server at 4.51 EUR a month for the install proof'], ['GY-1365', 'Open a paid Railway team plan for the production control plane']] as const) {
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

// GY-1692 names this file for its proof too: three more human-only decisions were parked at the build stage
// between 2026-10-07 and 2026-10-11, each asking a person for work an agent identity on the host can do. Each
// NEEDED below is the ledger's own (`graphyard status GY-N` → humanRequest.needed); against the base rule
// `parkRefusal` returned null for all three and the parks stood (GY-1470 waited 3.4 days). Each is judged:
//
//   - GY-1470 (1ff00e1c), credentials-for-people: a recording of GitHub's authenticator Confirm-access form
//     "made in the operator's own signed-in GitHub admin browser session". The browser profile the operator
//     lent the master (master init --browser-profile) is that session; `master browser capture` (GY-1686)
//     records every Confirm-access view there, redacted, submitting nothing.
//   - GY-1666 (ad35ed84), goals-and-priorities: "decide what happens to" fifteen unpushed operator commits
//     the coordinator checkout stood detached on, and run `master init` to record the install's units.
//     `master checkout-restore` now keeps a moved HEAD under a ref, discarding nothing, and returns the
//     checkout to the commit the loop runs (tests/master-session-confinement.test.ts); the loop records its
//     own units from the unit serving it (tests/harness-apply-checkout.test.ts).
//   - GY-1691 (a7d8557a), credentials-for-people: issue the operator agent graphyard-release-follow-up and
//     store its token as the uat GRAPHYARD_RELEASE_TOKEN. The identity is an agent's, the install's admin
//     credential is saved on the host and the host's gh login administers the repository: `master setup
//     --apply`, which the loop runs itself, keeps it current (tests/setup-self-provision.test.ts).
const asked1692 = {
  'GY-1470': ['credentials-for-people', 'A recording, made in the operator\'s own signed-in GitHub admin browser session, of GitHub\'s authenticator Confirm-access form saved as /home/vish/code/graphyard/.graphyard/sudo-totp-capture.html, plus one line stating page URL, capture time and browser profile. Steps: (1) open https://github.com/settings/apps/graphyard-cryptob1-graphyard/permissions in your normal GitHub admin browser; (2) on the Confirm access page click \'Use your authenticator app\' and do NOT enter a code; (3) in DevTools console run copy(document.querySelector(\'form[action*=sudo]\').closest(\'main\').outerHTML) and paste the clipboard into that file; (4) add an HTML comment at its top: <!-- captured from <URL> at <ISO time> in <browser/profile> -->. No code or password is captured; the form holds only field markup.', 'browser-capture', 'graphyard master browser capture'],
  'GY-1666': ['goals-and-priorities', 'Two operator steps on vishrog, both before the item resumes. (1) The coordinator checkout /home/vish/code/graphyard is detached at 98070f353857 on 15 unpushed operator commits (9e6bfc4ba3..98070f353857, authored 2026-10-10 19:10Z-23:43Z, on no local or remote branch, based on ccc0a31494bd) that do not contain GY-1662\'s merge 483e7eb07107, so the master loop (pid 3992137, running ccc0a31494bd since 18:59:05Z) refuses to self-upgrade or restart from it (escalation:dirty-checkout, state failed, attempts 25, last 02:09:15Z) and a plain restart would load code without the fix. Decide what happens to those commits: keep them (git -C /home/vish/code/graphyard branch operator-wip 98070f353857, push it and open a pull request if they are to land), then put the checkout on the base tip (git -C /home/vish/code/graphyard checkout --detach origin/main, at or past 483e7eb07107) so the loop self-upgrades between cycles, or systemctl --user restart graphyard-master to load it now. (2) Run graphyard master init in /home/vish/code/graphyard so .graphyard/units.json records this install\'s units: it is absent today, and the served GY-1662 code (applyHarnessContract in src/daemon/doctor.ts calling harnessApplyCheckout in src/master/harness.ts) refuses a units-less checkout and records remedy:harness:claude as waiting on master init instead of applying (docs/master-agent-reference.md says the same), so AC-1 cannot be observed without it. After both, the resumed worker observes one master cycle through graphyard master status: daemon.actions remedy:harness:claude done without an action:config fault and harnessDrift null, and submits that observation.', 'coordinator-checkout', 'graphyard master checkout-restore REASON'],
  'GY-1691': ['credentials-for-people', 'Two human steps, both with the installation administrator credential, which no agent here holds. (1) Issue the release filing identity: write FILE as {"id":"graphyard-release-follow-up","displayName":"Release follow-up","scope":{"repositories":["cryptob1/graphyard"],"workItems":["*"]},"capabilities":["intent:create"],"reason":"A failed release candidate files its follow-up"} and run `graphyard operator-agent setup FILE --token-stdin`, which prints the identity token once. (2) Store that printed token as the GitHub Actions environment secret GRAPHYARD_RELEASE_TOKEN of the uat environment of cryptob1/graphyard (gh secret set GRAPHYARD_RELEASE_TOKEN --env uat --repo cryptob1/graphyard), replacing the secret last updated 2026-10-05T04:08:40Z, which predates this identity and is refused with Operator permission required. Then graphyard doctor against the served release prints PASS release-filing, and the next failed release candidate files its follow-up or holds as graphyard-release-follow-up (its rc-uat record shows filingError null). Nothing else is needed from a person.', 'agent-identity', 'graphyard master setup --apply'],
} as const;

test('manual:intervention-pattern-human-only-decision-build — GY-1470, GY-1666 and GY-1691 (GY-1692): each recorded ask is host-doable, refused naming the master\'s route, and the server never parks it; the human\'s own three decisions still park', async () => {
  for (const [subject, [kind, needed, cls, command]] of Object.entries(asked1692)) {
    assert.equal(hostDoableAsk(needed, kind)?.class, cls, `${subject} is judged ${cls}`);
    const refusal = parkRefusal({ needed, kind })!;
    assert.match(refusal, /^Not a human-only decision: .*the master's owed action, not the human's\. Agent route: /, subject);
    assert.ok(refusal.includes(command), `${subject}: the refusal names ${command}`);
    const work = await claimed(subject);
    const refused = await call(token(worker), `work/${work.key}/park`, { epoch: work.epoch, kind, needed, reason: 'as recorded', ask: 'Do it for me', recommendation: kind === 'goals-and-priorities' ? 'Go ahead as asked' : 'Provided it', why: 'Only you can.' }, 422);
    assert.equal(refused.error, refusal, `${subject} is told the agent route`);
    const after = await reload(work.id);
    assert.equal(parkedOnHuman(after), false, `${subject} never reaches the human`);
    assert.equal(after.lease?.owner, worker.id, 'the attempt continues');
  }
  // What the three classes must never claim: a person's identity or sign-in, a goal about the same commits, a paid account beside a capture,
  // the operator's own browser profile (master init --browser-profile lends their signed-in session, which checkout-restore cannot provide),
  // and a recording of a person's authenticator enrolment, which is no GitHub Confirm-access view.
  for (const [kind, needed] of [
    ['credentials-for-people', 'Give the new teammate an operator-agent identity so they can file tickets'],
    ['credentials-for-people', 'Issue a dashboard sign-in for the new contractor who reviews releases'],
    ['goals-and-priorities', 'Decide whether the operator-wip commits in the coordinator checkout are still a goal for this quarter'],
    ['money-or-accounts', 'Open a paid GitHub Team account, then capture the Confirm-access markup there'],
    ['credentials-for-people', 'Lend the master your signed-in Chrome profile: run graphyard master init --token-stdin --browser-profile PROFILE on vishrog, naming the profile GitHub is signed into'],
    ['credentials-for-people', 'Record the authenticator enrollment screen for the new teammate and save the recording as enrolment.html so their sign-in can be set up'],
    ['credentials-for-people', 'A recording of the authenticator app pairing screen on the operator\'s phone, as markup'],
  ] as const) assert.equal(parkRefusal({ needed, kind }), null, `${needed} stays the human's`);
  // The unit record alone is the loop's; a GitHub Confirm-access authenticator view recorded in its session is the master's.
  assert.equal(hostDoableAsk('Run graphyard master init in the coordinator directory so this install\'s units are recorded there')?.class, 'coordinator-checkout');
  assert.equal(hostDoableAsk('A capture of the GitHub Confirm access page after choosing Use your authenticator app, as outerHTML')?.class, 'browser-capture');
  assert.equal(hostDoableAsk('In the GitHub sudo prompt pick the authenticator option and save the page markup')?.class, 'browser-capture');
});
