import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { derivedIntent } from '../src/cli/master.js';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import { scopeRoutineDecision } from '../src/master-daemon.js';
import { Refusal, type Principal, type Work } from '../src/model.js';
import { foldDecisions, liveLeaseRevisionRefusal, quarantinedRevisionRefusal } from '../src/model/approval.js';
import type { Intervention } from '../src/model/interventions.js';
import { derivePlannedFiles, describedAsNew, misnamedTest, plannedFilesRefusal } from '../src/model/planned-files.js';
import { scopeDecisionReason } from '../src/model/scope.js';
import { collapseArea, collapsePlannedFiles } from '../src/model/scope-collapse.js';
import { groundedWideningReason, routedScopeJudgement, wideningSettlement } from '../src/model/scope-provenance.js';
import { heldOutcome } from '../src/server/held-decisions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1684: at 01:24:11Z on 2026-10-11 the pattern scan counted 3 build-stage scope widenings in 7 days
// and opened the item, linking three instances. Each test replays one instance from the ledger rows
// the item names (AC-2): first against the base — the source of the commit main's tip stood at when
// the instance was recorded, extracted from that commit and run as it was, so the base's own fold
// returns the instance exactly as GY-1684's origin records it — and then against the candidate, which
// reads or produces a different record.
//
//   - GY-1617, requirements#2470341 (2026-10-09T23:48:58Z): `master create` had planned
//     tests/orphan-supervisors.test.ts — a plural the base never held — beside the real
//     tests/orphan-supervisor.test.ts, because describedAsNew read any missing test path as the new test
//     a criterion saying "a test …" describes. The master added the real file 1.7 seconds after the
//     first claim, a hand widening the fold counts (operator-widening). This change's own base,
//     4c8f455765 (GY-1684's recorded baseSha), still accepts that plan; the candidate refuses it at
//     create, naming the file the base holds, so the widening is never needed.
//   - GY-1675, requirements#2489179 (2026-10-10T23:12:05Z): on 215bf18e64 (main from 21:43Z to 23:31Z
//     that day) the loop collapsed a one-file ask into a root-level src/ the approver refused twice, and
//     the exact-path decision the master then requested by hand was approved but refused by the
//     engine's attempt guard and recorded failed; the master widened by hand 13 minutes later, after
//     the attempt had submitted. GY-1676 (merged 23:31Z) keeps the exact path and GY-1687 (04:47Z next
//     day) holds the approval until the attempt ends; both are on this change's base, which the
//     candidate pins against the instance's own shape.
//   - GY-1680, scope#2491588 + autoscope#2491597 (2026-10-11T01:23:21Z): the rule refused
//     src/cli/master.ts, the loop routed the ask to the approver at 01:23:47Z with the ask's identity,
//     and the approver approved it at 01:25:06Z. The scan ran at 01:24:11Z, 50 seconds into that hold,
//     on c531a1d726 (main from 01:02Z to 03:09Z), whose fold did not read the route; GY-1682 (merged
//     04:12Z, on this change's base) reads a routed ask as the approver's while the approver holds it,
//     and the approval as the control plane's own settlement.

const operator = 'graphyard-master-graphyard-operator', approver = 'graphyard-approver-graphyard';
const widenings = (rows: InterventionLedgerRow[], work: Work[], now: string) => foldInterventions(rows, work, now).interventions.filter(entry => entry.kind === 'scope-widening');
/** An approved decision applied under its requester: the row's reason is the decision's with the audit suffix (server/held-decisions.ts applicationOf). */
const applied = (id: string, reason: string, approval: string) => `${reason} [decision ${id}, requested by ${operator}, approved by ${approver}: ${approval}]`.slice(0, 2000);
/** One instance as the scan writes it onto the pattern item's origin (interventions/patterns.ts openPatternItems). */
const asRecorded = (entry: Intervention) => ({ id: entry.id, work: entry.work?.key ?? null, requestedAt: entry.requestedAt, resolvedAt: entry.resolvedAt, waitedMs: entry.waitedMs, sources: entry.sources.slice(0, 20) });

// ---- The base of each instance ------------------------------------------------------------------

/** The commit whose code produced each instance: main's tip at the instant it was recorded, and for GY-1617 this change's own base, which still holds the cause. */
const bases = {
  'GY-1617': '4c8f455765549576b0879d92473223cf28ba38f1',
  'GY-1675': '215bf18e6492ff804dd21f1fd706b8342ec8e5f7',
  'GY-1680': 'c531a1d7264d71fca41458918e50ad70ff3169a1',
};
type BaseSource = (module: string) => Promise<any>;
const git = (...args: string[]) => execFileSync('git', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
/** The install this suite resolves packages from: the nearest node_modules at or above the checkout (a worktree under the repository resolves to the repository's). */
const nodeModules = (() => { for (let at = process.cwd(); ; at = dirname(at)) { if (existsSync(join(at, 'node_modules'))) return join(at, 'node_modules'); if (dirname(at) === at) throw new Error(`no node_modules above ${process.cwd()}`); } })();
/**
 * The repository's source as `sha` holds it, importable under the suite's loader: the commit's src/
 * tree extracted beside a link to this checkout's node_modules. A shallow checkout (CI fetches two
 * commits) fetches the one commit first. The code runs as the base ran it, not a rendering of it.
 */
async function baseSource(sha: string): Promise<BaseSource> {
  try { git('cat-file', '-e', `${sha}^{commit}`); } catch { git('fetch', '--no-tags', '--depth=1', '--quiet', 'origin', sha); }
  const directory = await temporaryDirectory(`gy1684-base-${sha.slice(0, 7)}`);
  execFileSync('tar', ['-x', '-C', directory], { input: git('archive', '--format=tar', sha, 'src') });
  await symlink(nodeModules, join(directory, 'node_modules'), 'dir');
  return module => import(join(directory, 'src', module));
}
const base = {} as Record<keyof typeof bases, BaseSource>;
let root: string, dir: string;
before(async () => {
  for (const key of Object.keys(bases) as (keyof typeof bases)[]) base[key] = await baseSource(bases[key]);
  root = await temporaryDirectory('gy1684');
  dir = await temporaryDirectory('gy1684-intent');
  const repo = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  repo('init', '--quiet', '--initial-branch=main');
  for (const file of gy1617.tree) { await mkdir(join(root, dirname(file)), { recursive: true }); await writeFile(join(root, file), `// ${file}\n`); }
  repo('add', '.'); repo('commit', '--quiet', '-m', 'base');
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });

// ---- GY-1617 ----------------------------------------------------------------------------------------

const gy1617 = {
  id: '5774672f-ec67-4890-b556-f04744a9f2d4', key: 'GY-1617', title: 'master status names an orphaned watch supervisor only once the loop\'s two-observation rule establishes it',
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
  /** The instance as GY-1684's origin records it. */
  recorded: { id: 'scope-widening:5774672f-ec67-4890-b556-f04744a9f2d4:2470341', work: 'GY-1617', requestedAt: '2026-10-09T23:48:58.838Z', resolvedAt: '2026-10-09T23:48:58.838Z', waitedMs: 0, sources: [{ seq: 2470341, kind: 'requirements' }] },
};
/** requirements#2470341 as the ledger holds it: an operator agent's row records the whole document as `before` — epoch 1 claimed 1.7 s earlier, no workspace yet, nothing asked. */
const rows1617: InterventionLedgerRow[] = [
  { seq: 2470337, workId: gy1617.id, actor: 'graphyard-claude-1', kind: 'claim', at: '2026-10-09T23:48:57.204Z', details: {}, work: { key: 'GY-1617', stage: 'build', title: gy1617.title, epoch: 1, plannedFiles: gy1617.planned, blocker: null } },
  { seq: 2470341, workId: gy1617.id, actor: operator, kind: 'requirements', at: '2026-10-09T23:48:58.838Z', work: { key: 'GY-1617', stage: 'build', title: gy1617.title, epoch: 1, plannedFiles: gy1617.widened, blocker: null },
    details: { before: { epoch: 1, stage: 'build', plannedFiles: gy1617.planned, scopeRequest: null, lease: { epoch: 1, owner: 'graphyard-claude-1', expiresAt: '2026-10-09T23:50:58.032Z' }, blocker: null, pipeline: { attempts: [{ end: null, epoch: 1, owner: 'graphyard-claude-1', endedAt: null, claimedAt: '2026-10-09T23:48:57.168Z' }], submittedAt: null, reworkRounds: 0 }, workspaces: [] },
      intent: { reason: 'Add the existing tests/orphan-supervisor.test.ts to plannedFiles', criteria: gy1617.criteria, plannedFiles: gy1617.widened }, reason: 'Add the existing tests/orphan-supervisor.test.ts to plannedFiles', plannedFiles: gy1617.widened, liveScopeWidening: true } },
];

test('manual:intervention-pattern-scope-widening-build — GY-1617 against the base: 4c8f455765 plans the misnamed test as the criterion\'s new test with the real file beside it, and its fold counts the hand widening that corrected the plan as the record holds it', async () => {
  // The base's `master create` derivation (then in model/work.ts): with the tree holding tests/orphan-supervisor.test.ts, the plural is still read as AC-1's "a test drives that snapshot", so nothing is missing and the plan is accepted.
  const work = await base['GY-1617']('model/work.ts');
  assert.equal(work.describedAsNew('tests/orphan-supervisors.test.ts', gy1617.criteria), 'AC-1', 'the base reads any missing test path as the criterion\'s new test');
  assert.deepEqual(work.derivePlannedFiles({ plannedFiles: gy1617.planned, criteria: gy1617.criteria }, gy1617.tree).missing, [], 'the base accepts the plural beside the real file: the plan is recorded and the widening has to follow');
  // The base's fold over the rows the instance names returns it as GY-1684's origin records it: one build-stage widening by the operator, no ask before it.
  const fold = await base['GY-1617']('interventions.ts');
  const counted = fold.foldInterventions(rows1617, [], '2026-10-11T01:24:11.774Z').interventions.filter((entry: Intervention) => entry.kind === 'scope-widening');
  assert.deepEqual(counted.map(asRecorded), [gy1617.recorded]);
  assert.deepEqual(counted.map((entry: Intervention) => ({ trigger: entry.trigger, stage: entry.stage, blocked: entry.blocked, resolvedBy: entry.resolvedBy })), [{ trigger: 'operator-widening', stage: 'build', blocked: 'files outside plannedFiles: tests/orphan-supervisor.test.ts', resolvedBy: operator }]);
  // The candidate reads that record the same way — a hand widening is a signal — and removes the need for it below.
  assert.deepEqual(widenings(rows1617, [], '2026-10-11T01:24:11.774Z').map(asRecorded), [gy1617.recorded]);
});

test('manual:intervention-pattern-scope-widening-build — GY-1617 against the candidate: the same plan is refused at create naming the file the base holds, the corrected plan is accepted, and a criterion naming the new path still plans it', () => {
  // Without a near-named test on the tree the base's reading stands: the plural is a new test the criterion describes.
  assert.deepEqual(derivePlannedFiles({ plannedFiles: gy1617.planned, criteria: gy1617.criteria }, new Set([...gy1617.tree].filter(file => !file.startsWith('tests/orphan-supervisor.')))).missing, []);
  // Against the base that holds tests/orphan-supervisor.test.ts, the plural misnames it and is refused by name.
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

/** GY-1617's plan naming only its module (a planned path under tests/, the baseline included, keeps the proofs' file off the plan) with its one proof (both criteria carried the same) named a letter from the base's test: the route the review of 3908fbed93 named, which reaches the same plural through the companion rule. */
const gy1617ByProof = { plannedFiles: ['src/cli/orphan-supervisors.ts'], criteria: gy1617.criteria.map(criterion => ({ ...criterion, proofs: ['unit:orphan-supervisors'] })) };
const baseline = 'tests/helpers/timing-baseline.json';
test('manual:intervention-pattern-scope-widening-build — GY-1617 by the companion route: with no test planned, 4c8f455765 names the proofs\' file from the proof\'s words after the missing paths are judged, so the same plural is planned unrefused; the candidate refuses it naming the criterion and the file the base holds, and accepts each plan that answers it', async () => {
  const work = await base['GY-1617']('model/work.ts');
  const onBase = work.derivePlannedFiles(gy1617ByProof, gy1617.tree);
  assert.deepEqual({ missing: onBase.missing, planned: onBase.plannedFiles }, { missing: [], planned: [...gy1617ByProof.plannedFiles, 'tests/orphan-supervisors.test.ts', baseline] }, 'the base plans the plural as the file AC-1\'s proofs live in: the widening to the real file has to follow');
  // The candidate judges the proof-named test as a planned one: refused, with the criterion whose proofs named it and the remedy that fits a path the author never wrote.
  const derived = derivePlannedFiles(gy1617ByProof, gy1617.tree);
  assert.deepEqual({ missing: derived.missing, misnamed: derived.misnamed, planned: derived.plannedFiles },
    { missing: ['tests/orphan-supervisors.test.ts'], misnamed: [{ path: 'tests/orphan-supervisors.test.ts', existing: 'tests/orphan-supervisor.test.ts', criterion: 'AC-1' }], planned: [...gy1617ByProof.plannedFiles, baseline] });
  assert.equal(plannedFilesRefusal(derived.missing, 'origin/main', derived.misnamed),
    'plannedFiles names a path that origin/main does not hold and no criterion describes creating: tests/orphan-supervisors.test.ts (the test file AC-1\'s proofs name; origin/main holds tests/orphan-supervisor.test.ts). Plan the existing test, or name the new one in plannedFiles beside a criterion that creates it');
  // Planning the existing test covers the companion; naming the new test in plannedFiles beside a creating criterion plans it; an open ask naming it grounds it (GY-1676).
  assert.deepEqual(derivePlannedFiles({ ...gy1617ByProof, plannedFiles: [...gy1617ByProof.plannedFiles, 'tests/orphan-supervisor.test.ts'] }, gy1617.tree).missing, []);
  assert.deepEqual(derivePlannedFiles({ plannedFiles: [...gy1617ByProof.plannedFiles, 'tests/orphan-supervisors.test.ts'], criteria: [...gy1617ByProof.criteria, { id: 'AC-3', text: 'A new tests/orphan-supervisors.test.ts drives the two-observation snapshot.', proofs: [] }] }, gy1617.tree).missing, []);
  assert.deepEqual(derivePlannedFiles(gy1617ByProof, gy1617.tree, ['tests/orphan-supervisors.test.ts']).missing, []);
  // A proof whose words name no near test still plans its own file, as on the base.
  assert.deepEqual(derivePlannedFiles({ ...gy1617ByProof, criteria: gy1617.criteria }, gy1617.tree).plannedFiles, [...gy1617ByProof.plannedFiles, 'tests/orphan-status-two-observations.test.ts', baseline]);
  // Spelt `./tests/…`, a plan is judged by the path the tree lists: the base accepts the plural so spelt, the candidate refuses it.
  assert.deepEqual(work.derivePlannedFiles({ plannedFiles: ['./tests/orphan-supervisors.test.ts'], criteria: gy1617.criteria }, gy1617.tree).missing, []);
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['./tests/orphan-supervisors.test.ts'], criteria: gy1617.criteria }, gy1617.tree).misnamed, [{ path: './tests/orphan-supervisors.test.ts', existing: 'tests/orphan-supervisor.test.ts' }]);
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
  assert.equal(misnamedTest('./tests/scope-requests.test.ts', tree), 'tests/scope-request.test.ts', 'the ./ spelling a plan may use is judged by the path the tree lists');
  assert.equal(misnamedTest('./tests/scope-request.test.ts', tree), null);
  assert.equal(misnamedTest('src/scope-request.ts', tree), null, 'only test files are judged');
  assert.equal(misnamedTest('browser-tests/boards.spec.ts', tree), 'browser-tests/board.spec.ts');
});

test('manual:intervention-pattern-scope-widening-build — GY-1617 end to end: `master create` with the item\'s own intent file is refused against a real base branch, records nothing, and names the file the master later added by hand', async () => {
  const file = join(dir, 'gy1617.json');
  await writeFile(file, JSON.stringify({ type: 'bug', title: gy1617.title, priority: 3, criteria: gy1617.criteria, plannedFiles: gy1617.planned, policy: { checks: ['test', 'typecheck'], review: true } }));
  const sent: unknown[] = [];
  const deps = { coordinator: async () => ({ work: [] }), token: async () => 'operator-agent-token', mutate: async (_path: string, data: unknown) => { sent.push(data); return {}; } };
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'Three false orphan-supervisor attentions this session for live, freshly dispatched workers'], deps),
    /plannedFiles names a path that main does not hold and no criterion describes creating: tests\/orphan-supervisors\.test\.ts \(main holds tests\/orphan-supervisor\.test\.ts\)\. Correct the path, or state in a criterion that the item creates it/);
  assert.equal(sent.length, 0, 'nothing is recorded for a refused item: no release, no claim, no widening to make');
  // The same item planning no test, with AC-1's proof a letter from the base's test, is refused by the companion route with its own remedy.
  await writeFile(file, JSON.stringify({ type: 'bug', title: gy1617.title, priority: 3, criteria: gy1617ByProof.criteria, plannedFiles: gy1617ByProof.plannedFiles, policy: { checks: ['test', 'typecheck'], review: true } }));
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'Three false orphan-supervisor attentions this session'], deps),
    /creating: tests\/orphan-supervisors\.test\.ts \(the test file AC-1's proofs name; main holds tests\/orphan-supervisor\.test\.ts\)\. Plan the existing test, or name the new one in plannedFiles beside a criterion that creates it$/);
  assert.equal(sent.length, 0);
});

// ---- GY-1675 ----------------------------------------------------------------------------------------

const gy1675 = {
  id: '1d0ecba7-5451-4bb0-8c8e-55538d400ecc', key: 'GY-1675', title: 'Land the 14 operator commits stranded on the coordinator checkout',
  criteria: [
    { id: 'AC-1', text: 'One PR off origin/main carries the behaviour of commits ccc0a31494..cc2145b2e3 and passes npm run build and npm test on its head', proofs: ['unit:land-coordinator-commits'] },
    { id: 'AC-2', text: 'No test coverage of graphyard up or herdr install instance is removed without a replacing test that covers the changed behaviour', proofs: ['unit:land-coordinator-commits'] },
  ],
  /** The 31 planned paths as the item held them at 22:57Z, after the loop's own grounded widening of docs/install.md, src/install/units.ts and five tests. */
  planned: ['Dockerfile', 'scripts/graphyard-executor.mjs', 'src/auto-dispatch.ts', 'src/engine.ts', 'src/executor.ts', 'src/install/adapters.ts', 'src/install/index.ts', 'src/master/config.ts', 'src/master/dispatch.ts', 'src/master/herdr.ts', 'src/merge-writer/local-observation.ts', 'src/merge-writer/trial.ts', 'src/model/review.ts', 'src/model/work.ts', 'src/onboarding.ts', 'src/repository-setup.ts', 'src/server/main.ts', 'src/server/merge-record.ts', 'src/server/review-verdict.ts', 'src/server/shadow-verdict.ts', 'src/up.ts', 'tests/graphyard-up.test.ts', 'tests/herdr-install-instance.test.ts', 'tests/helpers/timing-baseline.json', 'docs/install.md', 'src/install/units.ts', 'tests/install-adapters.test.ts', 'tests/install-plan.test.ts', 'tests/shadow-gate.test.ts', 'tests/worker-launch-control-plane.test.ts', 'tests/zero-touch-onboarding.test.ts'],
  newFile: 'src/server/control-plane-observation.ts',
  /** What the hand widening of 23:12:05Z added: the exact path, and the two tests that pin the module budget and the docs budget it answers. */
  widened: ['src/server/control-plane-observation.ts', 'tests/hotspots.test.ts', 'tests/docs-budget.test.ts'],
  askReason: 'New module holding the control-plane observation job moved out of src/server/main.ts, which the landed commits pushed past its 320-line module budget (tests/hotspots.test.ts); AC-1 requires npm test to pass. Exact path only, no broad scope.',
  /** The instance as GY-1684's origin records it. */
  recorded: { id: 'scope-widening:1d0ecba7-5451-4bb0-8c8e-55538d400ecc:2489179', work: 'GY-1675', requestedAt: '2026-10-10T23:12:05.763Z', resolvedAt: '2026-10-10T23:12:05.763Z', waitedMs: 0, sources: [{ seq: 2489179, kind: 'requirements' }] },
};
const askedAt1675 = '2026-10-10T22:57:02.161Z', refusedAt1675 = '2026-10-10T22:57:05.907Z', routedAt1675 = Date.parse('2026-10-10T22:57:18.629Z');
/** The ask of 22:57:02Z as the item held it once the rule refused it: one new file beside 21 planned src paths, under epoch 1's live lease. */
const request1675 = { epoch: 1, paths: [gy1675.newFile], reason: gy1675.askReason, requestedBy: 'graphyard-claude-1', at: askedAt1675,
  decision: { state: 'refused' as const, reason: `${gy1675.newFile} is outside what this item's own criteria and the repository's documentation rule imply; an operator decides scope the item does not already carry`, at: refusedAt1675, decidedBy: 'graphyard', treeRead: true, waitedMs: 3746, paths: [gy1675.newFile], requestedBy: 'graphyard-claude-1', requestedAt: askedAt1675 } };
const item1675 = { id: gy1675.id, key: 'GY-1675', stage: 'build', epoch: 1, criteria: gy1675.criteria, plannedFiles: gy1675.planned, scopeRequest: request1675, lease: { epoch: 1, owner: 'graphyard-claude-1', expiresAt: '2026-10-10T22:59:02.000Z' } } as unknown as Work;
/** The hand-requested exact-path decision 016ad8f4 (22:58:37Z), approved at 22:59:16Z and refused by the engine's attempt guard. */
const decision1675 = { id: '016ad8f4-6c97-4d82-99fd-31b59d58bc6b', action: 'requirements' as const, requestedBy: operator, reason: 'GY-1675: add the exact path src/server/control-plane-observation.ts and AC-3 naming its creation: the observation job moves out of src/server/main.ts to keep its module budget' };
const decisionRows1675 = (refusal: string) => [
  { kind: 'decision.requested', actor: operator, at: '2026-10-10T22:58:37.000Z', payload: { id: decision1675.id, action: 'requirements', input: { plannedFiles: [...gy1675.planned, gy1675.newFile], expectedPolicyRevision: 2 }, reason: decision1675.reason, requester: { id: operator, role: 'operator-agent' } } },
  { kind: 'decision.approved', actor: approver, at: '2026-10-10T22:59:16.000Z', payload: { id: decision1675.id, action: 'requirements', reason: 'Approved. This is the exact-path re-filing that refusals bccd33e4 and 5e9f7452 asked for.', approver: { id: approver, role: 'operator-agent' } } },
  { kind: 'decision.failed', actor: approver, at: '2026-10-10T22:59:17.000Z', payload: { id: decision1675.id, error: refusal } },
];
/** requirements#2489179 as the ledger holds it: the operator's hand widening after the attempt had submitted — no ask stood, so it is a widening nobody asked for. */
const hand1675: InterventionLedgerRow = { seq: 2489179, workId: gy1675.id, actor: operator, kind: 'requirements', at: '2026-10-10T23:12:05.763Z', work: { key: 'GY-1675', stage: 'build', title: gy1675.title, epoch: 1, plannedFiles: [...gy1675.planned, ...gy1675.widened], blocker: null, candidate: { sha: '6defae905bcd547ac2febbefb3093e264d4677b4', pr: 1112 }, submission: { epoch: 1, pr: 1112 } },
  details: { before: { epoch: 1, stage: 'build', plannedFiles: gy1675.planned, scopeRequest: null, lease: null, blocker: null, submission: { epoch: 1, pr: 1112 }, candidate: { sha: '6defae905bcd547ac2febbefb3093e264d4677b4', pr: 1112 }, pipeline: { attempts: [{ end: 'submitted', epoch: 1 }] } },
    intent: { reason: 'Add exact path src/server/control-plane-observation.ts and AC-3 naming its creation (approved as exact path by approvers bccd33e4/5e9f7452/016ad8f4; applied now that no lease or quarantine stands): the observation job moves out of src/server/main.ts to keep its module budget', plannedFiles: [...gy1675.planned, ...gy1675.widened] },
    reason: 'Add exact path src/server/control-plane-observation.ts and AC-3 naming its creation (approved as exact path by approvers bccd33e4/5e9f7452/016ad8f4; applied now that no lease or quarantine stands): the observation job moves out of src/server/main.ts to keep its module budget', plannedFiles: [...gy1675.planned, ...gy1675.widened], liveScopeWidening: true } };

test('manual:intervention-pattern-scope-widening-build — GY-1675 against the base: 215bf18e64 collapses the one-file ask into src/ and routes that to the approver, settles the fenced exact-path approval as failed, and its fold counts the hand widening that followed as the record holds it', async () => {
  // The loop's routing on the base: the 21 planned src paths beside one new file fold into a root-level src/ entry — decisions bccd33e4 and 5e9f7452 proposed exactly that and the approver refused both for it.
  const collapse = await base['GY-1675']('model/scope-collapse.ts'), daemon = await base['GY-1675']('master-daemon.ts');
  const folded = collapse.collapsePlannedFiles(gy1675.planned, [gy1675.newFile], collapse.collapseArea(item1675));
  assert.ok(folded.plannedFiles.includes('src/') && !folded.plannedFiles.includes(gy1675.newFile), `the base folds the exact path into src/: ${folded.plannedFiles.join(', ')}`);
  assert.deepEqual(folded.collapsed.map((entry: { scope: string }) => entry.scope), ['src/']);
  const routed = daemon.scopeRoutineDecision(item1675, routedAt1675, true);
  assert.equal(routed.action, 'requirements');
  assert.ok(routed.input.plannedFiles.includes('src/') && !routed.input.plannedFiles.includes(gy1675.newFile), 'the base puts src/ to the approver, not the file the worker asked for');
  assert.match(routed.reason, /asks to widen plannedFiles with src\/ \(one directory entry/);
  // The decision the master then requested by hand: approved, refused by the engine's attempt guard — a live lease or an unverified containment fence of epoch 1 refuse a requirements revision alike — and settled failed by the base's server (server/decisions.ts: a refusal of the application records decision.failed).
  const approval = await base['GY-1675']('model/approval.ts');
  for (const refusal of [quarantinedRevisionRefusal(1), liveLeaseRevisionRefusal]) {
    const [failed] = approval.foldDecisions(gy1675.id, decisionRows1675(refusal));
    assert.deepEqual({ state: failed.state, outcome: failed.outcome }, { state: 'failed', outcome: refusal }, 'the base discards the approval: the master must notice, wait for the attempt to end and apply it by hand');
  }
  // The base's fold over the row the instance names returns it as GY-1684's origin records it: one build-stage widening by the operator, nothing asked before it.
  const fold = await base['GY-1675']('interventions.ts');
  const counted = fold.foldInterventions([hand1675], [], '2026-10-11T01:24:11.774Z').interventions.filter((entry: Intervention) => entry.kind === 'scope-widening');
  assert.deepEqual(counted.map(asRecorded), [gy1675.recorded]);
  assert.deepEqual(counted.map((entry: Intervention) => ({ trigger: entry.trigger, stage: entry.stage, blocked: entry.blocked, resolvedBy: entry.resolvedBy })), [{ trigger: 'operator-widening', stage: 'build', blocked: `files outside plannedFiles: ${gy1675.widened.join(', ')}`, resolvedBy: operator }]);
  // The candidate reads that record the same way — a hand widening is a signal — and removes the need for it below.
  assert.deepEqual(widenings([hand1675], [], '2026-10-11T01:24:11.774Z').map(asRecorded), [gy1675.recorded]);
});

test('manual:intervention-pattern-scope-widening-build — GY-1675 against the candidate: the one-file ask routes as its exact path, its approval is the control plane\'s own settlement, and an approval the attempt guard refuses is held and applied when the attempt ends, so no hand widening follows', () => {
  // GY-1676: the ask routes as the exact path the worker named, never as src/.
  assert.deepEqual(collapsePlannedFiles(gy1675.planned, [gy1675.newFile], collapseArea(item1675)), { plannedFiles: [...gy1675.planned, gy1675.newFile], collapsed: [] });
  const routed = scopeRoutineDecision(item1675, routedAt1675, true)!;
  assert.deepEqual({ action: routed.action, plannedFiles: routed.input!.plannedFiles, answers: routed.input!.answers }, { action: 'requirements', plannedFiles: [...gy1675.planned, gy1675.newFile], answers: { epoch: 1, at: askedAt1675 } });
  assert.ok(!(routed.input!.plannedFiles as string[]).includes('src/'), 'no root-level src/ is proposed');
  assert.match(routed.reason, new RegExp(routedScopeJudgement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // That decision, approved, applies as the control plane's own settlement: the fold reads the ask, the refusal, the route and the application as no intervention.
  const id = '5e9f7452-5a84-4c89-abc3-660606bf04f2', after = [...gy1675.planned, gy1675.newFile];
  const work = (plannedFiles: string[], blocker: string | null = null) => ({ key: 'GY-1675', stage: 'build', title: gy1675.title, epoch: 1, plannedFiles, blocker });
  const candidate: InterventionLedgerRow[] = [
    { seq: 2488910, workId: gy1675.id, actor: 'graphyard-claude-1', kind: 'scope', at: '2026-10-10T22:57:02.186Z', details: { epoch: 1, paths: [gy1675.newFile], reason: gy1675.askReason }, work: work(gy1675.planned) },
    { seq: 2488912, workId: gy1675.id, actor: 'graphyard-master', kind: 'autoscope', at: refusedAt1675, details: { epoch: 1, before: { blocker: null, plannedFiles: gy1675.planned }, decision: { ...request1675.decision, epoch: 1 } }, work: work(gy1675.planned, `Scope request refused: ${request1675.decision.reason}`) },
    { seq: 2488917, workId: gy1675.id, actor: operator, kind: 'decision.requested', at: '2026-10-10T22:57:18.629Z', details: null, payload: { id, action: 'requirements', input: routed.input, reason: routed.reason, requester: { id: operator, role: 'operator-agent' } }, work: work(gy1675.planned, `Scope request refused: ${request1675.decision.reason}`) },
    { seq: 2488941, workId: gy1675.id, actor: approver, kind: 'decision.approved', at: '2026-10-10T22:57:57.184Z', details: null, payload: { id, action: 'requirements', reason: 'Approved: the exact path AC-1 requires', approver: { id: approver, role: 'operator-agent' } }, work: work(gy1675.planned, `Scope request refused: ${request1675.decision.reason}`) },
    { seq: 2488942, workId: gy1675.id, actor: operator, kind: 'requirements', at: '2026-10-10T22:57:57.300Z', details: { before: { plannedFiles: gy1675.planned }, reason: applied(id, routed.reason, 'Approved: the exact path AC-1 requires'), answers: { epoch: 1, at: askedAt1675 }, plannedFiles: after, liveScopeWidening: true }, work: work(after) },
    { seq: 2488943, workId: gy1675.id, actor: approver, kind: 'decision.applied', at: '2026-10-10T22:57:57.320Z', details: null, payload: { id, outcome: 'Requirements revised' }, work: work(after) },
  ];
  assert.equal(wideningSettlement(candidate[4].details, [routed.reason]), 'routed-approver');
  assert.deepEqual(widenings(candidate, [item1675], '2026-10-11T01:24:11.774Z'), []);
  // GY-1687: an approval the attempt guard refuses is held for the transaction that ends the attempt instead of failing — the fold keeps its approval, and no hand application follows the attempt's end.
  const approving: Principal = { id: approver, role: 'operator-agent', sessionKind: 'ai' };
  for (const refusal of [quarantinedRevisionRefusal(1), liveLeaseRevisionRefusal]) {
    const held = heldOutcome(decision1675, approving, 'Approved. This is the exact-path re-filing that refusals bccd33e4 and 5e9f7452 asked for.', new Refusal(refusal), { kind: 'quarantine', epoch: 1 });
    assert.equal(held?.kind, 'decision.held');
    assert.equal(held?.details.reason, `${refusal}; the approved decision is held and applied when the attempt ends`);
    assert.equal(held?.details.application.actor.id, operator, 'applied as the requester under the two-party decision, never by a master session');
    const [decision] = foldDecisions(gy1675.id, [...decisionRows1675(refusal).slice(0, 2), { kind: 'decision.held', actor: approver, at: '2026-10-10T22:59:17.000Z', payload: { id: decision1675.id, ...held!.details } }]);
    assert.deepEqual({ state: decision.state, approvedBy: decision.approvedBy }, { state: 'held', approvedBy: approver }, 'the candidate keeps the approval');
  }
  assert.equal(heldOutcome(decision1675, approving, 'approved', new Refusal('Merged work requires a follow-up task'), { kind: 'quarantine', epoch: 1 }), null, 'any other refusal still fails the decision');
});

// ---- GY-1680 ----------------------------------------------------------------------------------------

const gy1680 = {
  id: '4aed9d65-e6d4-4850-ab6a-67c3362bb916', key: 'GY-1680', title: 'escalation:dirty-checkout\'s remedy runs only from the loop\'s loaded code',
  criteria: [
    { id: 'AC-1', text: 'Serving a checkout-restore request runs the quiesce-and-restore from the verified serving release (the release the deployment step serves, falling back to origin/main) materialized as a detached shared-clone snapshot, so a fix delivered to the serve path reaches the executor without the loop having loaded it', proofs: ['integration:checkout-restore-release-pinned-serve', 'unit:serve-uses-verified-release'] },
    { id: 'AC-2', text: 'When the request finds no dirty path but the checkout\'s HEAD differs from the commit the loop loaded, the serve path settles escalation:dirty-checkout and restarts the loop through its supervising unit onto that HEAD', proofs: ['unit:clean-drift-settles-and-restarts', 'integration:soak-checkout-restore-drift'] },
  ],
  planned: ['src/cli/master-checkout-restore.ts', 'src/daemon/run.ts', 'src/daemon/upgrade.ts', 'tests/loop-faults.test.ts', 'tests/soak-checkout-restore.test.ts', 'tests/checkout-writers-unreadable-cwd.test.ts'],
  paths: ['docs/operations.md', 'src/cli/master.ts'],
  askReason: 'AC-1 requires the serving release\'s own CLI to answer the serve entry (master checkout-restore --serve ROOT REASON): src/cli/master.ts is the master subcommand dispatcher and the only place the entry can be answered before a session is opened, so it imports the new module src/cli/checkout-restore-release.ts (a module-import companion); docs/operations.md documents the recipe and the resources section for the standard documentation criterion, trimmed to its base word count because the docs set is saturated',
  askedAt: '2026-10-11T01:23:21.145Z', refusedAt: '2026-10-11T01:23:30.608Z', detectedAt: '2026-10-11T01:24:11.774Z',
  /** The instance as GY-1684's origin records it: still open at the scan, 50 629 ms after the ask. */
  recorded: { id: 'scope-widening:4aed9d65-e6d4-4850-ab6a-67c3362bb916:2491588', work: 'GY-1680', requestedAt: '2026-10-11T01:23:21.145Z', resolvedAt: null, waitedMs: 50629, sources: [{ seq: 2491588, kind: 'scope' }, { seq: 2491597, kind: 'autoscope' }] },
};
const refusal1680 = 'src/cli/master.ts is outside what this item\'s own criteria and the repository\'s documentation rule imply; an operator decides scope the item does not already carry';
const decision1680 = { at: gy1680.refusedAt, epoch: 1, paths: gy1680.paths, state: 'refused' as const, reason: refusal1680, waitedMs: 9463, decidedBy: 'graphyard', treeRead: true, requestedAt: gy1680.askedAt, requestedBy: 'graphyard-opencode-1' };
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
  { seq: 2491588, workId: gy1680.id, actor: 'graphyard-opencode-1', kind: 'scope', at: gy1680.askedAt, details: { epoch: 1, paths: gy1680.paths, reason: gy1680.askReason }, work: work1680(gy1680.planned) },
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

test('manual:intervention-pattern-scope-widening-build — GY-1680 against the base: c531a1d726\'s fold at the scan\'s instant reads the routed ask as still waiting on somebody, 50 629 ms old, exactly as the record holds it', async () => {
  // The base's fold over the rows the scan had, the item as the snapshot held it, at the scan's own instant: the route of 01:23:47Z changes nothing, and the open ask is the recorded instance.
  const fold = await base['GY-1680']('interventions.ts');
  const counted = fold.foldInterventions(held1680, [item1680], gy1680.detectedAt).interventions.filter((entry: Intervention) => entry.kind === 'scope-widening');
  assert.deepEqual(counted.map(asRecorded), [gy1680.recorded]);
  assert.deepEqual(counted.map((entry: Intervention) => ({ trigger: entry.trigger, stage: entry.stage, blocked: entry.blocked, resolvedBy: entry.resolvedBy })), [{ trigger: 'refused-by-loop', stage: 'build', blocked: 'files outside plannedFiles: docs/operations.md, src/cli/master.ts', resolvedBy: null }]);
  // The base counts it whether or not the route is on the record: its fold does not read the route.
  assert.deepEqual(fold.foldInterventions(held1680.slice(0, 3), [item1680], gy1680.detectedAt).interventions.filter((entry: Intervention) => entry.kind === 'scope-widening').map(asRecorded), [gy1680.recorded]);
});

test('manual:intervention-pattern-scope-widening-build — GY-1680 against the candidate: at the scan\'s instant the refused ask is the approver\'s, routed 24 seconds before with the ask\'s own identity; the fold reads the 50-second hold as no intervention, the approval as the control plane\'s settlement, and the same ask unrouted as the signal it was', () => {
  // The hold: the ask stands refused, the route names its epoch and instant, the lease is live and the ask is 50 s old — well inside the bound the loop promises.
  assert.deepEqual(widenings(held1680, [item1680], gy1680.detectedAt), [], 'the approver holds the ask: nobody is waited on');
  // The answer: the approver approved and the widening applied as the loop's routed decision; the fold reads the settlement as the control plane's own.
  assert.equal(wideningSettlement(answered1680[1].details, [routedReason1680]), 'routed-approver');
  const settled = { ...item1680, plannedFiles: withMaster, scopeRequest: { ...request1680, decision: { ...decision1680, state: 'approved' as const, decidedBy: approver } }, blocker: null } as unknown as Work;
  assert.deepEqual(widenings([...held1680, ...answered1680], [settled], '2026-10-11T01:30:00.000Z'), []);
  // The loop's grounded widening of docs/operations.md answered only that path; the ask stayed open for src/cli/master.ts. GY-1755: unrouted on a live attempt inside the bound the loop promises, it is the loop's to route (scope-refusal-within-bound) and no instance at the scan's instant.
  assert.deepEqual(widenings(held1680.slice(0, 3), [item1680], gy1680.detectedAt), []);
  // A route naming another ask — a later instant of the same epoch — holds nothing: the identity is the ask's epoch and instant, as the engine matches it. GY-1755: within the bound the unrouted ask is the loop's either way, and with the attempt gone (nothing will route or re-ask it) it is counted from its own instant, its identity the scan recorded.
  const other = { ...held1680[3], payload: { ...held1680[3].payload, input: { ...held1680[3].payload.input, answers: { at: '2026-10-11T01:23:50.000Z', epoch: 1 } } } };
  assert.deepEqual(widenings([...held1680.slice(0, 3), other], [item1680], gy1680.detectedAt), []);
  const gone1680 = { ...item1680, lease: null } as unknown as Work, past1680 = '2026-10-11T01:26:00.000Z';
  const counted1680 = widenings([...held1680.slice(0, 3), other], [gone1680], past1680).map(asRecorded);
  assert.deepEqual(counted1680.map(entry => ({ requestedAt: entry.requestedAt, sources: entry.sources })), [{ requestedAt: gy1680.recorded.requestedAt, sources: gy1680.recorded.sources }]);
  assert.equal(counted1680[0].waitedMs, Date.parse(past1680) - Date.parse(gy1680.askedAt));
});
