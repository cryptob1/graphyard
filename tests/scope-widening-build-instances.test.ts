import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { derivedIntent } from '../src/cli/master.js';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { scopeRoutineDecision } from '../src/master-daemon.js';
import { Refusal, type Principal, type Work } from '../src/model.js';
import { quarantinedRevisionRefusal } from '../src/model/approval.js';
import { derivePlannedFiles, describedAsNew, misnamedTest, plannedFilesRefusal } from '../src/model/planned-files.js';
import { scopeDecisionReason } from '../src/model/scope.js';
import { collapseArea, collapsePlannedFiles } from '../src/model/scope-collapse.js';
import { groundedWideningReason, routedScopeJudgement, wideningSettlement } from '../src/model/scope-provenance.js';
import { heldOutcome } from '../src/server/held-decisions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1684: at 01:24:11Z on 2026-10-11 the pattern scan counted 3 build-stage scope widenings in 7 days
// and opened the item, linking three instances. Each test replays one instance from the ledger rows
// the item names, through the real fold and the real planning and routing code (AC-2): the record as
// the base read it, and why the candidate can no longer produce it.
//
//   - GY-1617, requirements#2470341 (2026-10-09T23:48:58Z): `master create` had planned
//     tests/orphan-supervisors.test.ts — a plural the base never held — beside the real
//     tests/orphan-supervisor.test.ts, because describedAsNew read any missing test path as the new test
//     a criterion saying "a test …" describes. The master added the real file 1.7 seconds after the
//     first claim, a hand widening the fold counts (operator-widening). The candidate refuses that plan
//     at create, naming the file the base holds, so the widening is never needed.
//   - GY-1675, requirements#2489179 (2026-10-10T23:12:05Z): the loop folded a one-file ask into a
//     root-level src/ the approver refused twice (GY-1676 keeps the exact path), and the exact-path
//     decision the master then requested was approved but failed under the attempt's containment fence
//     (GY-1687 holds it and applies it when the attempt ends); the master widened by hand 13 minutes
//     later. Both fixes landed on main after the instance; the test pins them against its shape.
//   - GY-1680, scope#2491588 + autoscope#2491597 (2026-10-11T01:23:21Z): the rule refused
//     src/cli/master.ts, the loop routed the ask to the approver at 01:23:47Z with the ask's identity,
//     and the approver approved it at 01:25:06Z. The scan ran at 01:24:11Z, 50 seconds into that hold,
//     on a fold that did not yet know the route; GY-1682's rule (on main since) reads a routed ask as
//     the approver's while the approver holds it, and the approval as the control plane's own settlement.

const uuid = (name: string) => { const hex = createHash('sha256').update(name).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };
const operator = 'graphyard-master-graphyard-operator', approver = 'graphyard-approver-graphyard';
const widenings = (rows: InterventionLedgerRow[], work: Work[], now: string) => foldInterventions(rows, work, now).interventions.filter(entry => entry.kind === 'scope-widening');
/** An approved decision applied under its requester: the row's reason is the decision's with the audit suffix (server/held-decisions.ts applicationOf). */
const applied = (id: string, reason: string, approval: string) => `${reason} [decision ${id}, requested by ${operator}, approved by ${approver}: ${approval}]`.slice(0, 2000);

// ---- GY-1617 ----------------------------------------------------------------------------------------

const gy1617 = {
  id: uuid('GY-1617'), key: 'GY-1617', title: 'master status names an orphaned watch supervisor only once the loop\'s two-observation rule establishes it',
  criteria: [
    { id: 'AC-1', text: 'A single master status snapshot in which Herdr does not list a freshly launched worker\'s session while its lease advances raises no orphan-supervisor attention and names no stop command; a test drives that snapshot and finds none', proofs: ['unit:orphan-status-two-observations'] },
    { id: 'AC-2', text: 'Once the loop has recorded the orphan and seen its lease advance past the first-seen expiry with the session still absent, master status raises the attention with the stop command as today', proofs: ['unit:orphan-status-two-observations'] },
  ],
  /** The plan `master create` recorded at 23:47:26Z: the plural test file the base never held. */
  planned: ['src/cli/orphan-supervisors.ts', 'tests/orphan-supervisors.test.ts', 'tests/helpers/timing-baseline.json'],
  /** The plan after requirements#2470341: the existing singular file added by hand, the plural left standing. */
  widened: ['src/cli/orphan-supervisors.ts', 'tests/orphan-supervisors.test.ts', 'tests/orphan-supervisor.test.ts', 'tests/helpers/timing-baseline.json'],
  /** The base of 2026-10-09 where it matters: the module, its real test, the baseline, and the tests beside them. */
  tree: new Set(['src/cli/orphan-supervisors.ts', 'src/cli/master-status-pipeline.ts', 'tests/orphan-supervisor.test.ts', 'tests/orphan-supervisors-status.test.ts', 'tests/helpers/timing-baseline.json', 'tests/master-status.test.ts']),
};
/** requirements#2470341 as the ledger holds it: an operator agent's row records the whole document as `before` — epoch 1 claimed 1.7 s earlier, no workspace yet, nothing asked. */
const rows1617: InterventionLedgerRow[] = [
  { seq: 2470337, workId: gy1617.id, actor: 'graphyard-claude-1', kind: 'claim', at: '2026-10-09T23:48:57.204Z', details: {}, work: { key: 'GY-1617', stage: 'build', title: gy1617.title, epoch: 1, plannedFiles: gy1617.planned, blocker: null } },
  { seq: 2470341, workId: gy1617.id, actor: operator, kind: 'requirements', at: '2026-10-09T23:48:58.898Z', work: { key: 'GY-1617', stage: 'build', title: gy1617.title, epoch: 1, plannedFiles: gy1617.widened, blocker: null },
    details: { before: { epoch: 1, stage: 'build', plannedFiles: gy1617.planned, scopeRequest: null, lease: { epoch: 1, owner: 'graphyard-claude-1', expiresAt: '2026-10-09T23:50:58.032Z' }, blocker: null, pipeline: { attempts: [{ end: null, epoch: 1, owner: 'graphyard-claude-1', endedAt: null, claimedAt: '2026-10-09T23:48:57.168Z' }], submittedAt: null, reworkRounds: 0 }, workspaces: [] },
      intent: { reason: 'Add the existing tests/orphan-supervisor.test.ts to plannedFiles', criteria: gy1617.criteria, plannedFiles: gy1617.widened }, reason: 'Add the existing tests/orphan-supervisor.test.ts to plannedFiles', plannedFiles: gy1617.widened, liveScopeWidening: true } },
];

test('manual:intervention-pattern-scope-widening-build — GY-1617: the record counts the master\'s hand widening 1.7 s after the first claim; the base accepted the misnamed test the widening had to correct, and the candidate refuses that plan at create naming the file the base holds', () => {
  // The instance as the scan read it: one build-stage widening, by the operator, no ask before it.
  const counted = widenings(rows1617, [], '2026-10-11T01:24:11.774Z');
  assert.deepEqual(counted.map(entry => ({ id: entry.id, trigger: entry.trigger, stage: entry.stage, blocked: entry.blocked, resolvedBy: entry.resolvedBy, waitedMs: entry.waitedMs })),
    [{ id: `scope-widening:${gy1617.id}:2470341`, trigger: 'operator-widening', stage: 'build', blocked: 'files outside plannedFiles: tests/orphan-supervisor.test.ts', resolvedBy: operator, waitedMs: 0 }]);
  // Why the plan needed correcting: the base read the plural as the new test AC-1's "a test drives that snapshot" describes, with no tree to say otherwise.
  assert.equal(describedAsNew('tests/orphan-supervisors.test.ts', gy1617.criteria), 'AC-1', 'the base\'s reading: any missing test path is the criterion\'s new test');
  assert.deepEqual(derivePlannedFiles({ plannedFiles: gy1617.planned, criteria: gy1617.criteria }, new Set([...gy1617.tree].filter(file => !file.startsWith('tests/orphan-supervisor.')))).missing, [], 'with no near-named test on the base the plural is still a new test the criterion describes');
  // The candidate: against the base that holds tests/orphan-supervisor.test.ts, the plural misnames it and is refused by name.
  assert.equal(misnamedTest('tests/orphan-supervisors.test.ts', gy1617.tree), 'tests/orphan-supervisor.test.ts');
  assert.equal(describedAsNew('tests/orphan-supervisors.test.ts', gy1617.criteria, gy1617.tree), null);
  const derived = derivePlannedFiles({ plannedFiles: gy1617.planned, criteria: gy1617.criteria }, gy1617.tree);
  assert.deepEqual({ missing: derived.missing, misnamed: derived.misnamed }, { missing: ['tests/orphan-supervisors.test.ts'], misnamed: [{ path: 'tests/orphan-supervisors.test.ts', existing: 'tests/orphan-supervisor.test.ts' }] });
  assert.equal(plannedFilesRefusal(derived.missing, 'origin/main', derived.misnamed),
    'plannedFiles names a path that origin/main does not hold and no criterion describes creating: tests/orphan-supervisors.test.ts (origin/main holds tests/orphan-supervisor.test.ts). Correct the path, or state in a criterion that the item creates it');
  // The corrected plan — the file the master added by hand — is accepted as the item should have been created, and so is a plan that states the new test by name.
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['src/cli/orphan-supervisors.ts', 'tests/orphan-supervisor.test.ts', 'tests/helpers/timing-baseline.json'], criteria: gy1617.criteria }, gy1617.tree).missing, []);
  assert.deepEqual(derivePlannedFiles({ plannedFiles: gy1617.planned, criteria: [...gy1617.criteria, { id: 'AC-3', text: 'A new tests/orphan-supervisors.test.ts drives the two-observation snapshot.', proofs: ['unit:x'] }] }, gy1617.tree).missing, [], 'a criterion naming the new path beside a creation word still plans it');
});

test('manual:intervention-pattern-scope-widening-build — a planned test misnames an existing one within an edit or two of its stem, same directory and suffix, the closest first; anything farther, elsewhere or of another suffix is a new test', () => {
  const tree = ['tests/scope-request.test.ts', 'tests/scope-requests-carry.test.ts', 'tests/held-decisions.test.ts', 'tests/helpers/timing-baseline.json', 'browser-tests/board.spec.ts', 'tests/db.test.ts', 'tests/scope-request.spec.ts'];
  assert.equal(misnamedTest('tests/scope-requests.test.ts', tree), 'tests/scope-request.test.ts', 'a plural');
  assert.equal(misnamedTest('tests/scop-request.test.ts', tree), 'tests/scope-request.test.ts', 'a dropped letter');
  assert.equal(misnamedTest('tests/held-decisionss.test.ts', tree), 'tests/held-decisions.test.ts', 'a doubled letter');
  assert.equal(misnamedTest('tests/scope-reqeust.test.ts', tree), 'tests/scope-request.test.ts', 'two edits in a sixteen-character stem');
  assert.equal(misnamedTest('tests/scope-request-carry.test.ts', tree), 'tests/scope-requests-carry.test.ts', 'the closest when more than one is near');
  assert.equal(misnamedTest('tests/scope-reques.spec.ts', tree), 'tests/scope-request.spec.ts', 'matched within its own suffix');
  assert.equal(misnamedTest('tests/scope-decision.test.ts', tree), null, 'a different name is a new test');
  assert.equal(misnamedTest('tests/scope-reqeusts.test.ts', tree), null, 'three edits are a different name');
  assert.equal(misnamedTest('tests/scope-request.spec.tsx', tree), null, 'another suffix is another file');
  assert.equal(misnamedTest('tests/unit/scope-request.test.ts', tree), null, 'another directory is another file');
  assert.equal(misnamedTest('tests/dbs.test.ts', tree), null, 'a stem too short to misspell is a name of its own');
  assert.equal(misnamedTest('tests/scope-request.test.ts', tree), null, 'a path the tree holds misnames nothing');
  assert.equal(misnamedTest('src/scope-request.ts', tree), null, 'only test files are judged');
  assert.equal(misnamedTest('browser-tests/boards.spec.ts', tree), 'browser-tests/board.spec.ts');
});

let root: string, dir: string;
before(async () => {
  root = await temporaryDirectory('gy1684');
  dir = await temporaryDirectory('gy1684-intent');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '--quiet', '--initial-branch=main');
  for (const file of gy1617.tree) { await mkdir(join(root, dirname(file)), { recursive: true }); await writeFile(join(root, file), `// ${file}\n`); }
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });

test('manual:intervention-pattern-scope-widening-build — GY-1617 end to end: `master create` with the item\'s own intent file is refused against a real base branch, records nothing, and names the file the master later added by hand', async () => {
  const file = join(dir, 'gy1617.json');
  await writeFile(file, JSON.stringify({ type: 'bug', title: gy1617.title, priority: 3, criteria: gy1617.criteria, plannedFiles: gy1617.planned, policy: { checks: ['test', 'typecheck'], review: true } }));
  const sent: unknown[] = [];
  const deps = { coordinator: async () => ({ work: [] }), token: async () => 'operator-agent-token', mutate: async (_path: string, data: unknown) => { sent.push(data); return {}; } };
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'Three false orphan-supervisor attentions this session for live, freshly dispatched workers'], deps),
    /plannedFiles names a path that main does not hold and no criterion describes creating: tests\/orphan-supervisors\.test\.ts \(main holds tests\/orphan-supervisor\.test\.ts\)\. Correct the path, or state in a criterion that the item creates it/);
  assert.equal(sent.length, 0, 'nothing is recorded for a refused item: no release, no claim, no widening to make');
});

// ---- GY-1675 ----------------------------------------------------------------------------------------

const gy1675 = {
  id: uuid('GY-1675'), key: 'GY-1675', title: 'Land the 14 operator commits stranded on the coordinator checkout',
  criteria: [
    { id: 'AC-1', text: 'One PR off origin/main carries the behaviour of commits ccc0a31494..cc2145b2e3 and passes npm run build and npm test on its head', proofs: ['unit:land-coordinator-commits'] },
    { id: 'AC-2', text: 'No test coverage of graphyard up or herdr install instance is removed without a replacing test that covers the changed behaviour', proofs: ['unit:land-coordinator-commits'] },
  ],
  /** The 31 planned paths as the item held them at 22:57Z, after the loop's own grounded widening of docs/install.md, src/install/units.ts and five tests. */
  planned: ['Dockerfile', 'scripts/graphyard-executor.mjs', 'src/auto-dispatch.ts', 'src/engine.ts', 'src/executor.ts', 'src/install/adapters.ts', 'src/install/index.ts', 'src/master/config.ts', 'src/master/dispatch.ts', 'src/master/herdr.ts', 'src/merge-writer/local-observation.ts', 'src/merge-writer/trial.ts', 'src/model/review.ts', 'src/model/work.ts', 'src/onboarding.ts', 'src/repository-setup.ts', 'src/server/main.ts', 'src/server/merge-record.ts', 'src/server/review-verdict.ts', 'src/server/shadow-verdict.ts', 'src/up.ts', 'tests/graphyard-up.test.ts', 'tests/herdr-install-instance.test.ts', 'tests/helpers/timing-baseline.json', 'docs/install.md', 'src/install/units.ts', 'tests/install-adapters.test.ts', 'tests/install-plan.test.ts', 'tests/shadow-gate.test.ts', 'tests/worker-launch-control-plane.test.ts', 'tests/zero-touch-onboarding.test.ts'],
  newFile: 'src/server/control-plane-observation.ts',
  askReason: 'New module holding the control-plane observation job moved out of src/server/main.ts, which the landed commits pushed past its 320-line module budget (tests/hotspots.test.ts); AC-1 requires npm test to pass. Exact path only, no broad scope.',
};
/** The hand-requested exact-path decision 016ad8f4 (22:58:37Z), approved at 22:59:16Z and refused by the engine under the containment fence of epoch 1. */
const decision1675 = { id: '016ad8f4-6c97-4d82-99fd-31b59d58bc6b', action: 'requirements' as const, requestedBy: operator, reason: 'GY-1675: add the exact path src/server/control-plane-observation.ts and AC-3 naming its creation: the observation job moves out of src/server/main.ts to keep its module budget' };

test('manual:intervention-pattern-scope-widening-build — GY-1675: the record counts the master\'s hand widening once the fence settled; on the candidate the one-file ask routes as its exact path, its approval is the control plane\'s own settlement, and an approval the fence refuses is held, not failed', () => {
  // The instance as the scan read it: requirements#2489179, by the operator, after the attempt had ended — no ask stood, so it is a widening nobody asked for.
  const hand: InterventionLedgerRow = { seq: 2489179, workId: gy1675.id, actor: operator, kind: 'requirements', at: '2026-10-10T23:12:05.804Z', work: { key: 'GY-1675', stage: 'build', title: gy1675.title, epoch: 1, plannedFiles: [...gy1675.planned, gy1675.newFile], blocker: null, candidate: { sha: '6defae905bcd547ac2febbefb3093e264d4677b4', pr: 1112 }, submission: { epoch: 1, pr: 1112 } },
    details: { before: { epoch: 1, stage: 'build', plannedFiles: gy1675.planned, scopeRequest: null, lease: null, blocker: null, submission: { epoch: 1, pr: 1112 }, candidate: { sha: '6defae905bcd547ac2febbefb3093e264d4677b4', pr: 1112 }, pipeline: { attempts: [{ end: 'settled', epoch: 1 }] } },
      intent: { reason: 'Add exact path src/server/control-plane-observation.ts and AC-3 naming its creation (approved as exact path by approvers bccd33e4/5e9f7452/016ad8f4; applied now that no lease or quarantine stands): the observation job moves out of src/server/main.ts to keep its module budget', plannedFiles: [...gy1675.planned, gy1675.newFile] },
      reason: 'Add exact path src/server/control-plane-observation.ts and AC-3 naming its creation (approved as exact path by approvers bccd33e4/5e9f7452/016ad8f4; applied now that no lease or quarantine stands): the observation job moves out of src/server/main.ts to keep its module budget', plannedFiles: [...gy1675.planned, gy1675.newFile], liveScopeWidening: true } };
  assert.deepEqual(widenings([hand], [], '2026-10-11T01:24:11.774Z').map(entry => ({ id: entry.id, trigger: entry.trigger, stage: entry.stage, blocked: entry.blocked, resolvedBy: entry.resolvedBy })),
    [{ id: `scope-widening:${gy1675.id}:2489179`, trigger: 'operator-widening', stage: 'build', blocked: `files outside plannedFiles: ${gy1675.newFile}`, resolvedBy: operator }]);

  // GY-1676: the ask of 22:57:02Z — one new file beside 21 planned src paths — routes as that exact path, never as src/ (decisions bccd33e4 and 5e9f7452 proposed src/ and were refused for it).
  const askedAt = '2026-10-10T22:57:02.161Z', refusedAt = '2026-10-10T22:57:05.907Z', now = Date.parse('2026-10-10T22:57:18.629Z');
  const request = { epoch: 1, paths: [gy1675.newFile], reason: gy1675.askReason, requestedBy: 'graphyard-claude-1', at: askedAt,
    decision: { state: 'refused' as const, reason: `${gy1675.newFile} is outside what this item's own criteria and the repository's documentation rule imply; an operator decides scope the item does not already carry`, at: refusedAt, decidedBy: 'graphyard', waitedMs: 3746, paths: [gy1675.newFile], requestedBy: 'graphyard-claude-1', requestedAt: askedAt } };
  const item = { id: gy1675.id, key: 'GY-1675', stage: 'build', epoch: 1, criteria: gy1675.criteria, plannedFiles: gy1675.planned, scopeRequest: request, lease: { epoch: 1, owner: 'graphyard-claude-1', expiresAt: '2026-10-10T22:59:02.000Z' } } as unknown as Work;
  assert.deepEqual(collapsePlannedFiles(gy1675.planned, [gy1675.newFile], collapseArea(item)), { plannedFiles: [...gy1675.planned, gy1675.newFile], collapsed: [] });
  const routed = scopeRoutineDecision(item, now, true)!;
  assert.deepEqual({ action: routed.action, plannedFiles: routed.input!.plannedFiles, answers: routed.input!.answers }, { action: 'requirements', plannedFiles: [...gy1675.planned, gy1675.newFile], answers: { epoch: 1, at: askedAt } });
  assert.ok(!(routed.input!.plannedFiles as string[]).includes('src/'), 'no root-level src/ is proposed');
  assert.match(routed.reason, new RegExp(routedScopeJudgement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // That decision, approved, applies as the control plane's own settlement: the fold reads the ask, the refusal, the route and the application as no intervention.
  const id = '5e9f7452-5a84-4c89-abc3-660606bf04f2', after = [...gy1675.planned, gy1675.newFile];
  const work = (plannedFiles: string[], blocker: string | null = null) => ({ key: 'GY-1675', stage: 'build', title: gy1675.title, epoch: 1, plannedFiles, blocker });
  const candidate: InterventionLedgerRow[] = [
    { seq: 2488910, workId: gy1675.id, actor: 'graphyard-claude-1', kind: 'scope', at: '2026-10-10T22:57:02.186Z', details: { epoch: 1, paths: [gy1675.newFile], reason: gy1675.askReason }, work: work(gy1675.planned) },
    { seq: 2488912, workId: gy1675.id, actor: 'graphyard-master', kind: 'autoscope', at: refusedAt, details: { epoch: 1, before: { blocker: null, plannedFiles: gy1675.planned }, decision: { ...request.decision, epoch: 1 } }, work: work(gy1675.planned, `Scope request refused: ${request.decision.reason}`) },
    { seq: 2488917, workId: gy1675.id, actor: operator, kind: 'decision.requested', at: '2026-10-10T22:57:18.629Z', details: null, payload: { id, action: 'requirements', input: routed.input, reason: routed.reason, requester: { id: operator, role: 'operator-agent' } }, work: work(gy1675.planned, `Scope request refused: ${request.decision.reason}`) },
    { seq: 2488941, workId: gy1675.id, actor: approver, kind: 'decision.approved', at: '2026-10-10T22:57:57.184Z', details: null, payload: { id, action: 'requirements', reason: 'Approved: the exact path AC-1 requires', approver: { id: approver, role: 'operator-agent' } }, work: work(gy1675.planned, `Scope request refused: ${request.decision.reason}`) },
    { seq: 2488942, workId: gy1675.id, actor: operator, kind: 'requirements', at: '2026-10-10T22:57:57.300Z', details: { before: { plannedFiles: gy1675.planned }, reason: applied(id, routed.reason, 'Approved: the exact path AC-1 requires'), answers: { epoch: 1, at: askedAt }, plannedFiles: after, liveScopeWidening: true }, work: work(after) },
    { seq: 2488943, workId: gy1675.id, actor: approver, kind: 'decision.applied', at: '2026-10-10T22:57:57.320Z', details: null, payload: { id, outcome: 'Requirements revised' }, work: work(after) },
  ];
  assert.equal(wideningSettlement(candidate[4].details, [routed.reason]), 'routed-approver');
  assert.deepEqual(widenings(candidate, [item], '2026-10-11T01:24:11.774Z'), []);

  // GY-1687: the exact-path decision the master requested by hand, approved at 22:59:16Z, was refused only by the containment fence of epoch 1 — the candidate holds it for the transaction that ends the attempt instead of failing it, so no hand application follows the settle.
  const approving: Principal = { id: approver, role: 'operator-agent', sessionKind: 'ai' };
  const held = heldOutcome(decision1675, approving, 'Approved. This is the exact-path re-filing that refusals bccd33e4 and 5e9f7452 asked for.', new Refusal(quarantinedRevisionRefusal(1)), { kind: 'quarantine', epoch: 1 });
  assert.equal(held?.kind, 'decision.held');
  assert.equal(held?.details.reason, `${quarantinedRevisionRefusal(1)}; the approved decision is held and applied when the attempt ends`);
  assert.deepEqual(held?.details.attempt, { kind: 'quarantine', epoch: 1 });
  assert.equal(held?.details.application.actor.id, operator, 'applied as the requester under the two-party decision, never by a master session');
  assert.equal(heldOutcome(decision1675, approving, 'approved', new Refusal('Merged work requires a follow-up task'), { kind: 'quarantine', epoch: 1 }), null, 'any other refusal still fails the decision');
});

// ---- GY-1680 ----------------------------------------------------------------------------------------

const gy1680 = {
  id: uuid('GY-1680'), key: 'GY-1680', title: 'escalation:dirty-checkout\'s remedy runs only from the loop\'s loaded code',
  criteria: [
    { id: 'AC-1', text: 'Serving a checkout-restore request runs the quiesce-and-restore from the verified serving release (the release the deployment step serves, falling back to origin/main) materialized as a detached shared-clone snapshot, so a fix delivered to the serve path reaches the executor without the loop having loaded it', proofs: ['integration:checkout-restore-release-pinned-serve', 'unit:serve-uses-verified-release'] },
    { id: 'AC-2', text: 'When the request finds no dirty path but the checkout\'s HEAD differs from the commit the loop loaded, the serve path settles escalation:dirty-checkout and restarts the loop through its supervising unit onto that HEAD', proofs: ['unit:clean-drift-settles-and-restarts', 'integration:soak-checkout-restore-drift'] },
  ],
  planned: ['src/cli/master-checkout-restore.ts', 'src/daemon/run.ts', 'src/daemon/upgrade.ts', 'tests/loop-faults.test.ts', 'tests/soak-checkout-restore.test.ts', 'tests/checkout-writers-unreadable-cwd.test.ts'],
  paths: ['docs/operations.md', 'src/cli/master.ts'],
  askReason: 'AC-1 requires the serving release\'s own CLI to answer the serve entry (master checkout-restore --serve ROOT REASON): src/cli/master.ts is the master subcommand dispatcher and the only place the entry can be answered before a session is opened, so it imports the new module src/cli/checkout-restore-release.ts (a module-import companion); docs/operations.md documents the recipe and the resources section for the standard documentation criterion, trimmed to its base word count because the docs set is saturated',
  askedAt: '2026-10-11T01:23:21.145Z', refusedAt: '2026-10-11T01:23:30.608Z', detectedAt: '2026-10-11T01:24:11.774Z',
};
const refusal1680 = 'src/cli/master.ts is outside what this item\'s own criteria and the repository\'s documentation rule imply; an operator decides scope the item does not already carry';
const decision1680 = { ...gy1680, scopeDecision: { at: gy1680.refusedAt, epoch: 1, paths: gy1680.paths, state: 'refused' as const, reason: refusal1680, waitedMs: 9463, decidedBy: 'graphyard', requestedAt: gy1680.askedAt, requestedBy: 'graphyard-opencode-1' } }.scopeDecision;
const request1680 = { at: gy1680.askedAt, epoch: 1, paths: gy1680.paths, reason: gy1680.askReason, requestedBy: 'graphyard-opencode-1', decision: decision1680 };
const withDocs = [...gy1680.planned, 'docs/operations.md'], withMaster = [...withDocs, 'src/cli/master.ts'];
/** GY-1680 as the snapshot held it at 01:24:11Z: the refused ask standing, its attempt's lease live until 01:25:30Z, docs/operations.md already widened by the loop's rule. */
const item1680 = { id: gy1680.id, key: 'GY-1680', title: gy1680.title, stage: 'build', epoch: 1, criteria: gy1680.criteria, plannedFiles: withDocs, scopeRequest: request1680, scopeDecision: decision1680, blocker: `Scope request refused: ${refusal1680}`, lease: { epoch: 1, owner: 'graphyard-opencode-1', expiresAt: '2026-10-11T01:25:30.690Z' } } as unknown as Work;
const routedReason1680 = scopeDecisionReason('GY-1680', request1680, gy1680.criteria, ['src/cli/master.ts'], null);
const work1680 = (plannedFiles: string[], blocker: string | null = null) => ({ key: 'GY-1680', stage: 'build', title: gy1680.title, epoch: 1, plannedFiles, blocker });
const groundedReason1680 = `${groundedWideningReason('GY-1680')}a review finding names it, it succeeds a planned file the base branch split, renamed or re-exports, a test pins text a planned file holds or a criterion changes, it defines or calls a symbol a criterion names, or it is a companion the change inevitably carries: docs/operations.md (docs/operations.md (docs/ is documentation this repository requires updating when behaviour changes)). graphyard-opencode-1 asked because ${gy1680.askReason}`;
const decisionId1680 = 'b9548d39-b850-4126-9ef1-e1bf5856cc5d';
/** The rows the scan at 01:24:11Z had: the ask, the rule's refusal, the loop's grounded widening of the docs path, and the route to the approver naming the ask's identity (events#2491588–#2491610). */
const held1680: InterventionLedgerRow[] = [
  { seq: 2491588, workId: gy1680.id, actor: 'graphyard-opencode-1', kind: 'scope', at: '2026-10-11T01:23:21.333Z', details: { epoch: 1, paths: gy1680.paths, reason: gy1680.askReason }, work: work1680(gy1680.planned) },
  { seq: 2491597, workId: gy1680.id, actor: 'graphyard-master', kind: 'autoscope', at: '2026-10-11T01:23:30.658Z', details: { epoch: 1, before: { blocker: null, plannedFiles: gy1680.planned }, decision: decision1680 }, work: work1680(gy1680.planned, `Scope request refused: ${refusal1680}`) },
  { seq: 2491609, workId: gy1680.id, actor: operator, kind: 'requirements', at: '2026-10-11T01:23:45.209Z', details: { before: { epoch: 1, stage: 'build', plannedFiles: gy1680.planned, scopeRequest: request1680, lease: item1680.lease, blocker: `Scope request refused: ${refusal1680}` }, intent: { reason: groundedReason1680, answers: { at: gy1680.askedAt, sha: null, epoch: 1 }, criteria: gy1680.criteria, plannedFiles: withDocs }, reason: groundedReason1680, plannedFiles: withDocs, liveScopeWidening: true }, work: work1680(withDocs, `Scope request refused: ${refusal1680}`) },
  { seq: 2491610, workId: gy1680.id, actor: operator, kind: 'decision.requested', at: '2026-10-11T01:23:47.325Z', details: null, payload: { id: decisionId1680, action: 'requirements', input: { answers: { at: gy1680.askedAt, epoch: 1 }, criteria: gy1680.criteria, plannedFiles: withMaster, expectedPolicyRevision: 2 }, reason: routedReason1680, requester: { id: operator, role: 'operator-agent' } }, work: work1680(withDocs, `Scope request refused: ${refusal1680}`) },
];
/** The approver's answer 55 seconds after the scan (events#2491645–#2491647): the widening applied under the requester with the routed reason. */
const answered1680: InterventionLedgerRow[] = [
  { seq: 2491645, workId: gy1680.id, actor: approver, kind: 'decision.approved', at: '2026-10-11T01:25:06.913Z', details: null, payload: { id: decisionId1680, action: 'requirements', reason: 'Approved: AC-1 requires the dispatcher to answer the serve entry', approver: { id: approver, role: 'operator-agent' } }, work: work1680(withDocs, `Scope request refused: ${refusal1680}`) },
  { seq: 2491646, workId: gy1680.id, actor: operator, kind: 'requirements', at: '2026-10-11T01:25:07.002Z', details: { before: { plannedFiles: withDocs }, reason: applied(decisionId1680, routedReason1680, 'Approved: AC-1 requires the dispatcher to answer the serve entry'), answers: { at: gy1680.askedAt, epoch: 1 }, plannedFiles: withMaster, liveScopeWidening: true }, work: work1680(withMaster) },
  { seq: 2491647, workId: gy1680.id, actor: approver, kind: 'decision.applied', at: '2026-10-11T01:25:07.045Z', details: null, payload: { id: decisionId1680, outcome: 'Requirements revised' }, work: work1680(withMaster) },
];

test('manual:intervention-pattern-scope-widening-build — GY-1680: at the scan\'s instant the refused ask was the approver\'s, routed 24 seconds before with the ask\'s own identity; the fold reads the 50-second hold as no intervention, the approval as the control plane\'s settlement, and the same ask unrouted as the signal it was', () => {
  // The hold: the ask stands refused, the route names its epoch and instant, the lease is live and the ask is 50 s old — well inside the bound the loop promises.
  assert.deepEqual(widenings(held1680, [item1680], gy1680.detectedAt), [], 'the approver holds the ask: nobody is waited on');
  // The answer: the approver approved and the widening applied as the loop's routed decision; the fold reads the settlement as the control plane's own.
  assert.equal(wideningSettlement(answered1680[1].details, [routedReason1680]), 'routed-approver');
  const settled = { ...item1680, plannedFiles: withMaster, scopeRequest: { ...request1680, decision: { ...decision1680, state: 'approved' as const, decidedBy: approver } }, blocker: null } as unknown as Work;
  assert.deepEqual(widenings([...held1680, ...answered1680], [settled], '2026-10-11T01:30:00.000Z'), []);
  // The loop's grounded widening of docs/operations.md answered only that path; the ask stayed open for src/cli/master.ts, and a deployment that routes nothing leaves it counted from its own instant.
  assert.deepEqual(widenings(held1680.slice(0, 3), [item1680], gy1680.detectedAt).map(entry => ({ trigger: entry.trigger, blocked: entry.blocked, waitedMs: entry.waitedMs, resolvedAt: entry.resolvedAt })),
    [{ trigger: 'refused-by-loop', blocked: 'files outside plannedFiles: docs/operations.md, src/cli/master.ts', waitedMs: Date.parse(gy1680.detectedAt) - Date.parse('2026-10-11T01:23:21.333Z'), resolvedAt: null }]);
  // A route naming another ask — a later instant of the same epoch — holds nothing: the identity is the ask's epoch and instant, as the engine matches it.
  const other = { ...held1680[3], payload: { ...held1680[3].payload, input: { ...held1680[3].payload.input, answers: { at: '2026-10-11T01:23:50.000Z', epoch: 1 } } } };
  assert.equal(widenings([...held1680.slice(0, 3), other], [item1680], gy1680.detectedAt).length, 1);
});
