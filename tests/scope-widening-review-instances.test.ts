import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { foldInterventions, readInterventionLedger, type InterventionLedgerRow } from '../src/interventions.js';
import { readAbsorbedPlans } from '../src/interventions/ledger.js';
import { exemption } from '../src/intervention-exemptions.js';
import { impliedWidening } from '../src/interventions/implied-widening.js';
import type { Principal, Work } from '../src/model.js';
import type { Intervention } from '../src/model/interventions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1719: at 06:24:18Z on 2026-10-12 the pattern scan counted 3 review-stage scope widenings in 7
// days and opened the item. Each was a requirements revision the master wrote at review that added a
// criterion, and the paths it added were ones the revised record already implies — what
// `master requirements` derives from the criteria it posts and what the engine's own rule
// (decideScopeRequest) grants a worker who asks, with nobody stepping in:
//
//   - GY-1717, requirements#2521296 (2026-10-12T06:23:49Z): AC-3 (a reviewer-found symlink case) was
//     added, and the re-derivation added only tests/docs-budget.test.ts — the docs-budget gate beside
//     docs/master-agent-sessions.md, which the engine had granted at 06:07Z without its companion.
//   - GY-1700, requirements#2507845 (2026-10-11T15:04:52Z): the approved decision declaring AC-1..3
//     post-deploy added AC-0 (unit:webhook-soft-accept-no-5xx) and only the test its proof names,
//     tests/webhook-soft-accept.test.ts.
//   - GY-1662, requirements#2485668 (2026-10-10T17:46:44Z): AC-4 was folded in from duplicate GY-1664
//     with the timing baseline and docs-budget gate beside the planned test and page, and
//     tests/master-harness-remedy.test.ts — which GY-1664, closed as GY-1662's duplicate at 18:02Z,
//     had planned at its own create.
//
// Each test replays the instance's rows (AC-2) first against the base — this change's base, whose
// fold still counts the revision, extracted and run as it was — and then against the candidate,
// whose fold reads it as the revision's own implied scope (`criteria-implied-widening`).

const operator = 'graphyard-master-graphyard-operator', approver = 'graphyard-approver-graphyard';
const now = '2026-10-12T06:24:18.445Z';
const docs = { paths: ['docs/', 'AGENTS.md', 'README.md'], changelog: null };
const widenings = (fold: typeof foldInterventions, rows: InterventionLedgerRow[], work: unknown[]) =>
  fold(rows, work as Work[], now).interventions.filter((entry: Intervention) => entry.kind === 'scope-widening');
/** One instance as the scan writes it onto the pattern item's origin (interventions/patterns.ts). */
const asRecorded = (entry: Intervention) => ({ id: entry.id, work: entry.work?.key ?? null, stage: entry.stage, trigger: entry.trigger, blocked: entry.blocked, sources: entry.sources });

// ---- The base ---------------------------------------------------------------------------------------

/** This change's stated base (main at 652be40, PR #1151's landing base), whose fold produced all three instances. */
const baseSha = '652be40af8c48dc7a048467359d929a3d0ceabff';
const git = (...args: string[]) => execFileSync('git', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const nodeModules = (() => { for (let at = process.cwd(); ; at = dirname(at)) { if (existsSync(join(at, 'node_modules'))) return join(at, 'node_modules'); if (dirname(at) === at) throw new Error(`no node_modules above ${process.cwd()}`); } })();
let baseFold: typeof foldInterventions;
before(async () => {
  // A concurrent shallow fetch in the same shard can fail ours ("shallow file has changed since we
  // read it"), so a failed fetch re-checks for the commit and retries before giving up.
  const present = () => { try { git('cat-file', '-e', `${baseSha}^{commit}`); return true; } catch { return false; } };
  for (let attempt = 1; !present(); attempt++) {
    try { git('fetch', '--no-tags', '--depth=1', '--quiet', 'origin', baseSha); } catch (error) { if (attempt >= 3 && !present()) throw error; }
  }
  const directory = await temporaryDirectory(`gy1719-base-${baseSha.slice(0, 7)}`);
  execFileSync('tar', ['-x', '-C', directory], { input: git('archive', '--format=tar', baseSha, 'src') });
  await symlink(nodeModules, join(directory, 'node_modules'), 'dir');
  baseFold = (await import(join(directory, 'src', 'interventions.ts'))).foldInterventions;
});

// ---- GY-1717 ----------------------------------------------------------------------------------------

const gy1717 = {
  id: '1bcc13b1-2a75-484e-b1b2-a262c2eac819', title: 'A Codex session must not fail to start because .agents or .codex is absent',
  criteria: [
    { id: 'AC-1', text: 'Before a codex launch in a directory lacking .agents or .codex, both exist afterwards; ones already present, including a file or symlink, are left untouched', proofs: ['unit:codex-protected-paths-created'] },
    { id: 'AC-2', text: 'Other runtimes\' launches create nothing; the item creates tests/codex-protected-paths.test.ts holding these tests', proofs: ['unit:codex-protected-paths-codex-only'] },
  ],
  added: { id: 'AC-3', text: 'A codex launch where .agents or .codex exists as a symlink, dangling or not, is refused with a LaunchRefusedError naming the path and saying to remove the symlink, and the symlink is not modified', proofs: ['unit:codex-protected-paths-symlink-refused'] },
  before: ['src/harness.ts', 'tests/codex-protected-paths.test.ts', 'tests/helpers/timing-baseline.json', 'docs/master-agent-sessions.md', 'tests/managed-worktree-root.test.ts'],
  after: ['src/harness.ts', 'tests/codex-protected-paths.test.ts', 'docs/master-agent-sessions.md', 'tests/helpers/timing-baseline.json', 'tests/managed-worktree-root.test.ts', 'tests/docs-budget.test.ts'],
};
const reason1717 = 'Add AC-3: the reviewer found an existing symlink makes bubblewrap fail the same way; refuse the launch naming the path. Additive; AC-1 and AC-2 unchanged.';
/** requirements#2521296: an operator agent's row records the whole document as `before` — attempt 3 submitted, no lease, nothing asked. */
const rows1717: InterventionLedgerRow[] = [
  { seq: 2521296, workId: gy1717.id, actor: operator, kind: 'requirements', at: '2026-10-12T06:23:49.849Z', stageBefore: 'review',
    work: { key: 'GY-1717', stage: 'review', title: gy1717.title, epoch: 3, plannedFiles: gy1717.after, blocker: null },
    details: { before: { key: 'GY-1717', epoch: 3, stage: 'review', lease: null, blocker: null, scopeRequest: null, plannedFiles: gy1717.before, criteria: gy1717.criteria, documentation: docs },
      intent: { reason: reason1717, criteria: [...gy1717.criteria, gy1717.added], dependencies: [], producerProofs: [], exclusiveResources: [], expectedPolicyRevision: 3 }, reason: reason1717, liveScopeWidening: false } },
];
const recorded1717 = { id: `scope-widening:${gy1717.id}:2521296`, work: 'GY-1717', stage: 'review', trigger: 'operator-widening', blocked: 'files outside plannedFiles: tests/docs-budget.test.ts', sources: [{ seq: 2521296, kind: 'requirements' }] };

test('manual:intervention-pattern-scope-widening-review — GY-1717 against the base: the AC-3 revision that added only the docs-budget gate counts as a review-stage widening', () => {
  assert.deepEqual(widenings(baseFold, rows1717, []).map(asRecorded), [recorded1717]);
});

test('manual:intervention-pattern-scope-widening-review — GY-1717 against the candidate: the docs-budget gate it rode in on is gone (GY-2515), so the revision reads as a widening again', () => {
  assert.deepEqual(widenings(foldInterventions, rows1717, []).map(asRecorded), [recorded1717]);
  assert.equal(impliedWidening({ added: ['tests/docs-budget.test.ts'], before: gy1717.before, criteria: [...gy1717.criteria, gy1717.added], documentation: docs }), false,
    'the gate was the only ground for that path, and GY-2515 removed it');
});

// ---- GY-1700 ----------------------------------------------------------------------------------------

const gy1700 = {
  id: 'e03bc94f-82f4-481d-a443-4b4e6abe9eb6', title: 'GitHub App webhook deliveries failing with HTTP 500: receiver endpoint erroring while safety-net polling compensates',
  criteria: [
    { id: 'AC-0', text: 'From this head, a verified webhook delivery soft-accepts with HTTP 202 and a logged ignore reason when readiness is false or the wake transaction fails, and refuses with 403 (not HTTP 500) when the managed App repository is unset.', proofs: ['unit:webhook-soft-accept-no-5xx'] },
    { id: 'AC-1', text: 'Each delivery listed as failed with status 500 in the GitHub App\'s advanced delivery log, when redelivered via Redeliver, receives a non-5xx response and is recorded by the control plane (the event reaches the work snapshot or is durably and deliberately ignored with a logged reason).', proofs: ['manual:post-deploy/webhook-failed-deliveries-replay-clean'] },
    { id: 'AC-2', text: 'A 24-hour window of live GitHub activity on cryptob1/graphyard shows zero failed webhook deliveries (no 5xx, no connection failures) in the App\'s advanced delivery log at github.com/settings/apps/graphyard-cryptob1-graphyard/advanced.', proofs: ['manual:post-deploy/webhook-deliveries-clean-24h'] },
    { id: 'AC-3', text: 'The github-budget attention row in graphyard master status clears when a delivery arrives and does not re-fire during 24h of live repository activity while at least one pull request is open.', proofs: ['manual:post-deploy/github-budget-attention-row-clears'] },
  ],
  before: ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md'],
  after: ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md', 'tests/webhook-soft-accept.test.ts'],
};
const reason1700 = 'GY-1700 AC-1/AC-2/AC-3 are live App-delivery-log and github-budget observations that no head can show before merge (AC-2/AC-3 need a 24h window; AC-1 needs Redeliver against the serving webhook URL). [decision 9a6095d9-c3e5-4357-93d6-48b8ccc61e5e, requested by graphyard-master-graphyard-operator, approved by graphyard-approver-graphyard: Justified]';
const work1700 = (plannedFiles: string[], blocker: string | null) => ({ key: 'GY-1700', stage: 'review', title: gy1700.title, epoch: 4, plannedFiles, blocker });
/**
 * The rows the instance stands on: the worker's ask for the test (scope#2507595), the rule's refusal
 * (autoscope#2507600), the master's unblock that answered the ask as an escalation (unblock#2507778),
 * and the approved decision applied with no ask left open (requirements#2507845, a decision row whose
 * `before` holds only the plan).
 */
const rows1700: InterventionLedgerRow[] = [
  { seq: 2507595, workId: gy1700.id, actor: 'graphyard-claude-1', kind: 'scope', at: '2026-10-11T14:47:50.740Z', stageBefore: 'review', details: { epoch: 4, paths: ['tests/webhook-soft-accept.test.ts'], reason: 'Pending requirements decision 9a6095d9 adds AC-0 naming this file' } },
  { seq: 2507600, workId: gy1700.id, actor: 'graphyard-master', kind: 'autoscope', at: '2026-10-11T14:47:59.738Z', stageBefore: 'review', work: work1700(gy1700.before, 'Scope request refused: tests/webhook-soft-accept.test.ts is outside what this item\'s own criteria and the repository\'s documentation rule imply'),
    details: { epoch: 4, before: { blocker: null, plannedFiles: gy1700.before }, decision: { at: '2026-10-11T14:47:59.601Z', epoch: 4, paths: ['tests/webhook-soft-accept.test.ts'], state: 'refused', decidedBy: 'graphyard', requestedAt: '2026-10-11T14:47:50.488Z', requestedBy: 'graphyard-claude-1' } } },
  { seq: 2507778, workId: gy1700.id, actor: operator, kind: 'unblock', at: '2026-10-11T15:01:08.686Z', stageBefore: 'review', work: work1700(gy1700.before, null), details: { reason: 'Cleared the scope refusal; the pending requirements decision carries the file' } },
  { seq: 2507845, workId: gy1700.id, actor: operator, kind: 'requirements', at: '2026-10-11T15:04:52.590Z', stageBefore: 'review', work: work1700(gy1700.after, null),
    details: { criteria: gy1700.criteria, plannedFiles: gy1700.after, dependencies: [], producerProofs: [], exclusiveResources: [], expectedPolicyRevision: 4, reason: reason1700, liveScopeWidening: false, before: { plannedFiles: gy1700.before },
      heldDecision: { id: '9a6095d9-c3e5-4357-93d6-48b8ccc61e5e', approvedBy: approver, heldSince: '2026-10-11T14:49:14.768Z', appliedWhen: 'settle ended attempt 4', resume: 'rereview' } } },
];
const snapshot1700 = [{ id: gy1700.id, key: 'GY-1700', title: gy1700.title, stage: 'done', documentation: docs }];
const recorded1700 = { id: `scope-widening:${gy1700.id}:2507845`, work: 'GY-1700', stage: 'review', trigger: 'operator-widening', blocked: 'files outside plannedFiles: tests/webhook-soft-accept.test.ts', sources: [{ seq: 2507845, kind: 'requirements' }] };

test('manual:intervention-pattern-scope-widening-review — GY-1700 against the base: the decision adding AC-0 and the test its proof names counts as a review-stage widening', () => {
  assert.deepEqual(widenings(baseFold, rows1700, snapshot1700).map(asRecorded), [recorded1700]);
});

test('manual:intervention-pattern-scope-widening-review — GY-1700 against the candidate: the test AC-0\'s proof lives in is the revised record\'s own scope, so nothing is counted; the unblock stays an escalation', () => {
  assert.deepEqual(widenings(foldInterventions, rows1700, snapshot1700), []);
  const escalations = foldInterventions(rows1700, snapshot1700 as unknown as Work[], now).interventions.filter(entry => entry.kind === 'escalation');
  assert.deepEqual(escalations.map(entry => entry.sources.map(source => source.seq)), [[2507595, 2507600, 2507778]], 'the master\'s unblock of the refused ask is still read as the escalation it was');
});

// ---- GY-1662 ----------------------------------------------------------------------------------------

const gy1662 = {
  id: 'a006add4-b46b-41e1-8341-56026e297db1', title: 'Loop cannot apply the Claude harness contract from its own process: apply resolves a units-less scratch worktree and the legacy systemd unit runs a different checkout',
  criteria: [
    { id: 'AC-1', text: 'The loop\'s remedy:harness:claude apply resolves a checkout that records units (.graphyard/units.json present) and applies the Claude harness contract from the loop\'s own process without raising the action:config failure; when the resolved checkout records no units the act refuses naming that checkout and the \'graphyard master init\' remedy instead of failing opaquely, and the failure does not repeat on the next cycle', proofs: ['unit:harness-apply-checkout-resolution'] },
    { id: 'AC-2', text: 'When the serving user systemd unit (e.g. /home/vish/.config/systemd/user/graphyard-master.service) runs a checkout different from the one the apply targets, the apply reports the mismatch and names the unit to update rather than applying against the wrong checkout; a test pins the detection for both the units-less-worktree case and the legacy-unit-points-elsewhere case', proofs: ['unit:harness-apply-checkout-resolution', 'integration:harness-contract-apply'] },
    { id: 'AC-3', text: 'After the fix ships and is served, one master cycle on the installation applies the Claude harness contract without an action:config fault on remedy:harness:claude and the following master status reports no harness attention row for it', proofs: ['manual:harness-contract-applied-on-install'] },
  ],
  added: { id: 'AC-4', text: '(from duplicate GY-1664) The loop\'s harness remedy resolves its checkout from the loop\'s managed state (coordinatorCheckoutRoot(config.cliPath), with effects.doctor?.cwd as fallback) and never from effects.research.cwd: with research.cwd pointing at a scratch worktree that records no units, the remedy still applies the Claude harness contract to the managed checkout and journals the done action', proofs: ['integration:harness-remedy-ignores-research-scratch'] },
  before: ['src/master/harness.ts', 'src/cli/master.ts', 'src/cli/master/operations.ts', 'docs/master-agent.md', 'src/daemon/doctor.ts', 'tests/harness-apply-checkout.test.ts', 'docs/master-agent-reference.md', 'src/daemon/effects.ts', 'src/daemon/run.ts'],
  after: ['docs/master-agent-reference.md', 'docs/master-agent.md', 'src/cli/master.ts', 'src/cli/master/operations.ts', 'src/daemon/doctor.ts', 'src/daemon/effects.ts', 'src/daemon/run.ts', 'src/master/harness.ts', 'tests/harness-apply-checkout.test.ts', 'tests/master-harness-remedy.test.ts', 'tests/helpers/timing-baseline.json', 'tests/docs-budget.test.ts'],
};
const gy1664 = { id: '3a3bfc24-bccd-444d-aa00-28c1da7b3ddf', planned: ['src/daemon/doctor.ts', 'tests/master-harness-remedy.test.ts', 'docs/master-agent-reference.md'] };
const reason1662 = 'Fold in duplicate GY-1664\'s precise root cause (doctor.ts:726 resolves from effects.research.cwd, the scratch) as an added criterion; additive';
/** GY-1664's own refusal of its worker's ask (autoscope#2485655), which records its plan, then GY-1662's revision (requirements#2485668): attempt 1 submitted, no lease, nothing asked. */
const rows1662: InterventionLedgerRow[] = [
  { seq: 2485655, workId: gy1664.id, actor: 'graphyard-master', kind: 'autoscope', at: '2026-10-10T17:46:31.883Z', stageBefore: 'build', work: { key: 'GY-1664', stage: 'build', title: 'harness remedy resolves research scratch', epoch: 1, plannedFiles: gy1664.planned, blocker: null },
    details: { epoch: 1, before: { blocker: null, plannedFiles: gy1664.planned }, decision: { epoch: 1, paths: ['tests/soak-harness-remedy.test.ts'], state: 'refused', decidedBy: 'graphyard' } } },
  { seq: 2485668, workId: gy1662.id, actor: operator, kind: 'requirements', at: '2026-10-10T17:46:44.904Z', stageBefore: 'review',
    work: { key: 'GY-1662', stage: 'review', title: gy1662.title, epoch: 1, plannedFiles: gy1662.after, blocker: null },
    details: { before: { key: 'GY-1662', epoch: 1, stage: 'review', lease: null, blocker: null, scopeRequest: null, plannedFiles: gy1662.before, criteria: gy1662.criteria, documentation: docs },
      intent: { reason: reason1662, criteria: [...gy1662.criteria, gy1662.added], plannedFiles: gy1662.after, dependencies: [], producerProofs: [], exclusiveResources: [], expectedPolicyRevision: 3 }, reason: reason1662, liveScopeWidening: false } },
];
/** GY-1664 as the snapshot holds it once closed into GY-1662 (18:02:27Z): a settled summary, without its plan. */
const closed1664 = { id: gy1664.id, key: 'GY-1664', title: 'harness remedy resolves research scratch', stage: 'done', summary: true, closure: { kind: 'duplicate', ref: 'GY-1662', at: '2026-10-10T18:02:27.502Z', by: operator, from: 'build', reason: 'Same fault and file as GY-1662' } };
const snapshot1662 = [{ id: gy1662.id, key: 'GY-1662', title: gy1662.title, stage: 'done', documentation: docs }, closed1664];
const recorded1662 = { id: `scope-widening:${gy1662.id}:2485668`, work: 'GY-1662', stage: 'review', trigger: 'operator-widening', blocked: 'files outside plannedFiles: tests/master-harness-remedy.test.ts, tests/helpers/timing-baseline.json, tests/docs-budget.test.ts', sources: [{ seq: 2485668, kind: 'requirements' }] };

test('manual:intervention-pattern-scope-widening-review — GY-1662 against the base: folding in duplicate GY-1664\'s criterion with its test and the companions counts as a review-stage widening', () => {
  assert.deepEqual(widenings(baseFold, rows1662, snapshot1662).map(asRecorded), [recorded1662]);
});

test('manual:intervention-pattern-scope-widening-review — GY-1662 against the candidate: the duplicate\'s planned test and the timing companion still imply, but the docs-budget gate path no longer does (GY-2515), so the revision counts', () => {
  assert.deepEqual(widenings(foldInterventions, rows1662, snapshot1662).map(asRecorded), [recorded1662]);
  const added = gy1662.after.filter(path => !gy1662.before.includes(path));
  assert.equal(impliedWidening({ added, before: gy1662.before, criteria: [...gy1662.criteria, gy1662.added], documentation: docs, absorbed: gy1664.planned }), false,
    'the one dead path is the docs-budget gate, whose ground GY-2515 removed');
  assert.equal(impliedWidening({ added: ['tests/master-harness-remedy.test.ts', 'tests/helpers/timing-baseline.json'], before: gy1662.before, criteria: [...gy1662.criteria, gy1662.added], documentation: docs, absorbed: gy1664.planned }), true,
    'the duplicate\'s plan and the timing companion are still the revised record\'s own scope');
  assert.equal(impliedWidening({ added: ['tests/master-harness-remedy.test.ts', 'tests/helpers/timing-baseline.json'], before: gy1662.before, criteria: [...gy1662.criteria, gy1662.added], documentation: docs, absorbed: [] }), false,
    'without the duplicate\'s plan its test is a widening');
});

test('manual:intervention-pattern-scope-widening-review — a duplicate\'s plan is read as its rows held it at the revision, so a later plan or closure never erases an earlier widening', () => {
  // A plan the snapshot holds but no row recorded before the revision was not yet absorbed.
  assert.deepEqual(widenings(foldInterventions, rows1662.slice(1), [snapshot1662[0], { ...closed1664, summary: undefined, plannedFiles: gy1664.planned }]).map(asRecorded), [recorded1662]);
  // The duplicate gaining the test only after the revision leaves the revision a widening.
  const later = { ...rows1662[0], seq: 2485700, at: '2026-10-10T17:50:00.000Z' };
  const earlier = { ...rows1662[0], work: { ...rows1662[0].work, plannedFiles: ['src/daemon/doctor.ts'] }, details: { ...rows1662[0].details, before: { blocker: null, plannedFiles: ['src/daemon/doctor.ts'] } } };
  assert.deepEqual(widenings(foldInterventions, [earlier, rows1662[1], later], snapshot1662).map(asRecorded), [recorded1662]);
});

// ---- A duplicate's plan from before the window --------------------------------------------------------

// The report reads only the window's rows of the kinds the fold reads, and a settled duplicate's
// snapshot summary carries no plan: GY-1664's plan was set by its `create`, which no window holds.
// The ledger read carries every closed duplicate's plan onto the revision, as the duplicate's own
// newest document before the row held it, from the whole ledger.
let database: EmbeddedPostgres | undefined, store: Store | undefined;
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

test('manual:intervention-pattern-scope-widening-review — a duplicate planned before the report window, by its create alone, is read from the ledger at the revision, and a path it gained after the revision is not', async () => {
  const port = Number(process.env.GRAPHYARD_SCOPE_WIDENING_REVIEW_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1719);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('scope-widening-review'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('scope_widening_review_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/scope_widening_review_test`); await store.init();
  const engine = new Engine(store, [15368], 120, 'owner/scope-widening-review'); engine.submissionObserver = null;
  const master: Principal = { id: operator, role: 'admin', sessionKind: 'ai' };
  const revise = (work: Work, plannedFiles: string[], criteria: { id: string; text: string; proofs: string[] }[], reason: string) =>
    engine.execute(master, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, reason, criteria, dependencies: [], plannedFiles, exclusiveResources: [], producerProofs: [] }, randomUUID());

  const duplicate = await engine.execute(master, 'create', null, { title: 'harness remedy resolves research scratch', plannedFiles: gy1664.planned, criteria: [{ id: 'AC-1', text: 'Resolves from managed state', proofs: ['integration:harness-remedy-ignores-research-scratch'] }] }, randomUUID());
  const criteria = [{ id: 'AC-1', text: 'The harness apply resolves a checkout that records units', proofs: ['unit:harness-apply-checkout-resolution'] }];
  let target = await engine.execute(master, 'create', null, { title: gy1662.title, plannedFiles: gy1662.before, criteria }, randomUUID());
  // The window opens after both items were created.
  const since = new Date((await store.pool.query('SELECT clock_timestamp() AS at')).rows[0].at).toISOString();
  target = await revise(target, gy1662.after, [...criteria, gy1662.added], reason1662);
  // After the revision the duplicate plans a path the revision never carried, then is closed into the target.
  await revise(duplicate, [...gy1664.planned, 'tests/later.test.ts'], duplicate.criteria, 'a later plan');
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{closure}', $2::jsonb) WHERE id = $1`, [duplicate.id, JSON.stringify({ ...closed1664.closure, ref: target.key })]);

  const { rows } = await readInterventionLedger(store.pool, { since });
  await readAbsorbedPlans(store.pool, rows);
  const revision = rows.find(row => row.kind === 'requirements' && row.workId === target.id)!;
  assert.deepEqual(revision.absorbed, gy1664.planned, 'the duplicate\'s plan as its create set it, before the window and the revision; not the path it gained later');
  assert.equal(rows.some(row => row.workId === duplicate.id && row.seq < revision.seq), false, 'no row of the duplicate before the revision is in the window');
  assert.equal((await store.pool.query(`SELECT count(*)::int AS n FROM events WHERE work_id = $1 AND created_at < $2`, [duplicate.id, since])).rows[0].n > 0, true, 'its plan was set before the window');

  // GY-1662's instance with no in-window duplicate row: the plan the ledger carries absorbs the duplicate's test;
  // the docs-budget gate path GY-2515 ungrounded, the revision reads as a widening either way, so the absorption
  // is judged directly on the paths that remain live.
  const replayed = { ...rows1662[1], absorbed: revision.absorbed };
  assert.deepEqual(widenings(foldInterventions, [replayed], snapshot1662).map(asRecorded), [recorded1662]);
  assert.deepEqual(widenings(foldInterventions, [rows1662[0], { ...replayed, absorbed: [] }], snapshot1662).map(asRecorded), [recorded1662], 'a ledger read that found no plan absorbs nothing, whatever the folded rows hold');
  assert.deepEqual(widenings(baseFold, [replayed], snapshot1662).map(asRecorded), [recorded1662], 'the base counted it');
});

// ---- What still counts ------------------------------------------------------------------------------

test('manual:intervention-pattern-scope-widening-review — a revision adding a path the record does not imply, or one no duplicate closed into the item planned, is still the master\'s widening', () => {
  // Without the closure, GY-1664's test is a path GY-1662's own record does not imply.
  assert.deepEqual(widenings(foldInterventions, rows1662, [snapshot1662[0]]).map(asRecorded), [recorded1662]);
  // A duplicate of another item carries nothing into this one.
  assert.deepEqual(widenings(foldInterventions, rows1662, [snapshot1662[0], { ...closed1664, closure: { ...closed1664.closure, ref: 'GY-9999' } }]).map(asRecorded), [recorded1662]);
  // A source file no criterion names keeps GY-1717's revision a widening, beside the docs-budget path whose ground GY-2515 removed.
  const wider = rows1717.map(row => ({ ...row, work: { ...row.work, plannedFiles: [...gy1717.after, 'src/launch.ts'] } }));
  assert.deepEqual(widenings(foldInterventions, wider, []).map(entry => entry.blocked), ['files outside plannedFiles: tests/docs-budget.test.ts, src/launch.ts']);
  // A row that carries no criteria to judge by, or adds nothing, is never read as implied.
  assert.equal(impliedWidening({ added: ['tests/docs-budget.test.ts'], before: gy1717.before, criteria: 'AC-3' }), false);
  assert.equal(impliedWidening({ added: [], before: gy1717.before, criteria: gy1717.criteria, documentation: docs }), false);
});

test('manual:intervention-pattern-scope-widening-review — a path only a review follow-up\'s finding or description names is implied as the engine implies it, from the record\'s origin', () => {
  const wider = rows1717.map(row => ({ ...row, work: { ...row.work, plannedFiles: [...gy1717.after, 'src/launch.ts'] } }));
  const followUp = (origin: unknown, description: string | null) => ({ id: gy1717.id, key: 'GY-1717', stage: 'review', title: gy1717.title, criteria: gy1717.criteria, plannedFiles: gy1717.after, documentation: docs, origin, description });
  const finding = { reviewFollowUps: { parent: 'GY-1600', findings: [{ path: 'src/launch.ts', text: 'the launch refuses nothing', ref: 'abc123' }] } };
  const described = { reviewFollowUps: { parent: 'GY-1600', findings: [{ text: 'the launch refuses nothing', ref: 'abc123' }] } };
  // The docs-budget gate the wider revision also added is gone (GY-2515), so the revision counts as a widening
  // whatever grounds src/launch.ts; the follow-up ground itself is judged by the engine below.
  assert.equal(widenings(foldInterventions, wider, [followUp(finding, null)]).length, 1);
  assert.equal(widenings(foldInterventions, wider, [followUp(described, 'Fix the refusal in src/launch.ts.')]).length, 1);
  // The same description on an item that is no review follow-up implies nothing.
  assert.equal(widenings(foldInterventions, wider, [followUp(null, 'Fix the refusal in src/launch.ts.')]).length, 1);
  assert.equal(impliedWidening({ added: ['src/launch.ts'], before: gy1717.after, criteria: gy1717.criteria, documentation: docs, origin: finding as Work['origin'] }), true);
  assert.equal(impliedWidening({ added: ['src/launch.ts'], before: gy1717.after, criteria: gy1717.criteria, documentation: docs }), false);
});

test('manual:intervention-pattern-scope-widening-review — an implied widening that answers a worker\'s ask is judged as that ask\'s answer, not exempted', () => {
  const moment = { at: 'requirements' as const, details: {}, reason: 'r', widened: true, implied: true, routed: [], stage: 'review' as const, work: null, blockerBefore: null };
  assert.equal(exemption({ ...moment, asked: false }), 'criteria-implied-widening');
  assert.equal(exemption({ ...moment, asked: true }), null);
  assert.equal(exemption({ ...moment, asked: false, implied: false }), null);
});
