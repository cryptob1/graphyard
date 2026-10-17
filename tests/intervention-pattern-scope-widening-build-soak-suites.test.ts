import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decideScopeRequest } from '../src/model/scope.js';
import { companionGround } from '../src/model/scope-companions.js';
import { repeatingPaths as sharedRepeatingPaths, soakSuiteFile, soakSuiteGround } from '../src/model/repeating-paths.js';
import { repeatingPaths, repetitionReviewSection } from '../src/reviewer.js';
import { ciCheckRefusal } from '../src/model/ci-refusal.js';
import { exemption } from '../src/intervention-exemptions.js';
import type { WorkOrigin } from '../src/model/interventions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1892 names this file for its proof: manual:intervention-pattern-scope-widening-build.
// Time-bomb allowance: the 14 and 17 October stamps are ledger fixtures, judged only as the strings the record holds, never against the wall clock.
//
// Graphyard opened GY-1892 on 2026-10-17T09:37:28Z: 3 scope widenings at the build stage in 7 days
// (GY-1888, GY-1881, GY-1773). Each instance is replayed from its ledger rows
// (`graphyard events GY-N --kind scope,autoscope,requirements`):
//
//   - scope#2557709 (GY-1773, 2026-10-14): the reviewer's finding asked for soak coverage in
//     tests/soak-day.test.ts, which runs on tests/helpers/soak-simulation.ts. The rule refused
//     both, the loop's finding-grounded widening could not read the review (a gh rate limit), and an
//     operator widened by hand 16 minutes later. GY-1888 hit the same cause on 17 October
//     (scope#2678064 and #2679203: a soak suite the review contract made BLOCKING, refused twice,
//     widened by hand). The cause is that the review contract (src/reviewer.ts
//     repetitionReviewSection) requires a soak suite for any change to a repeating path, but the
//     scope rule never granted one. The candidate grounds it as a companion
//     (model/repeating-paths.ts soakSuiteGround), from the same `repeatingPaths` the reviewer reads,
//     so the engine's autoscope approves it at once with no GitHub read and no approver.
//   - scope#2661903 (GY-1888) and scope#2661162 (GY-1881): GY-1893 removed both causes before this
//     item was claimed (fault-class machinery, and a failed required check's own test file). They
//     are replayed against the base they occurred on (main before GY-1893 merged) and pinned so
//     they do not come back on the candidate.

const claimBaseSha = 'd107df784e6fe203e70634ecf43a20dad65a9649'; // main's tip when GY-1892 was claimed: still refuses the soak suites
const preGy1893Sha = 'c63b62a963b074636174d7ce90fa49d061ccf3fe'; // main just before GY-1893 merged: the base GY-1888's and GY-1881's asks were refused on
type Base = { decideScopeRequest: typeof decideScopeRequest };
const nodeModules = (() => {
  for (let at = process.cwd(); ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) return join(at, 'node_modules');
    if (dirname(at) === at) throw new Error(`no node_modules above ${process.cwd()}`);
  }
})();
const baseScope = async (sha: string): Promise<Base> => {
  try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' }); }
  catch { execFileSync('git', ['fetch', '--no-tags', '--depth=1', '--quiet', 'origin', sha], { cwd: process.cwd() }); }
  const directory = await temporaryDirectory(`gy1892-${sha.slice(0, 8)}`);
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', '--format=tar', sha, 'src'], { cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 }), maxBuffer: 256 * 1024 * 1024 });
  await fs.symlink(nodeModules, join(directory, 'node_modules'), 'dir');
  return import(join(directory, 'src/model/scope.ts')) as Promise<Base>;
};
let claimBase: Base, preGy1893: Base;
before(async () => { [claimBase, preGy1893] = await Promise.all([baseScope(claimBaseSha), baseScope(preGy1893Sha)]); });

const documentation = { paths: ['docs/', 'AGENTS.md', 'README.md'] };
const baseline = 'tests/helpers/timing-baseline.json', wallClock = 'tests/no-wall-clock-time-bombs.test.ts';
type Item = Parameters<typeof decideScopeRequest>[0];
type Ask = Parameters<typeof decideScopeRequest>[1];
/** The engine's autoscope verdict and how the intervention fold reads the row it writes: an approved autoscope is the control plane doing its job. */
const judged = (decide: typeof decideScopeRequest, item: Item, ask: Ask) => {
  const verdict = decide(item, ask);
  return { state: verdict.state, reason: verdict.reason, exempt: exemption({ at: 'autoscope', decision: { state: verdict.state } }) };
};

// GY-1773 as the record held it at scope#2557709 (2026-10-14T04:59:06.260Z), its plan and criteria verbatim.
const gy1773: Item = {
  documentation,
  plannedFiles: ['src/daemon/upgrade.ts', 'src/daemon/state.ts', 'src/cli/master-status.ts', 'tests/upgrade-dirty-snapshot.test.ts', 'docs/operations.md', 'docs/master-agent-reference.md', baseline, wallClock, 'tests/docs-budget.test.ts', 'src/daemon/run.ts', 'tests/loop-self-upgrade.test.ts', 'tests/self-upgrade-null-production.test.ts'],
  criteria: [
    { id: 'AC-1', text: 'With a dirty checkout and a newer merged commit, the upgrade\'s outcome is a restart onto a held-cli snapshot of that commit with the launcher pinned to it, the checkout\'s tracked files and HEAD are unchanged, and the cursor records the checkout left behind with its dirty paths; with a clean detached checkout the checkout is moved as before and no pin is written for it', proofs: ['unit:dirty-checkout-upgrades-by-snapshot'] },
    { id: 'AC-2', text: 'master status reports the loop\'s release as the snapshot\'s commit and names the checkout as left behind while the pin stands; moving the checkout onto that commit lifts the pin; the item creates tests/upgrade-dirty-snapshot.test.ts holding these tests', proofs: ['unit:snapshot-pin-reported-and-lifted'] },
  ],
};
const gy1773Ask: Ask = { paths: ['tests/soak-day.test.ts', 'tests/helpers/soak-simulation.ts'], reason: 'Review finding \'repeated-cycle reliability coverage (tests/soak-day.test.ts:499)\' names tests/soak-day.test.ts directly: the day soak still asserts the pre-GY-1773 behavior and must be rewritten to the snapshot behavior; the day it reads is simulated by tests/helpers/soak-simulation.ts' };

// GY-1888 as the record held it at scope#2678064 (12:03:46Z) and scope#2679203 (12:14:06Z).
const gy1888Origin: WorkOrigin = { faultClass: { class: 'decision', threshold: 3, windowHours: 24, count: 3, detectedAt: '2026-10-17T08:25:44.598Z', instances: [] } };
const gy1888Criteria = [{ id: 'AC-1', text: 'The shared cause of the recurring decision faults is found and removed at the candidate: each instance listed on this item is reproduced against the base and shown not to recur against the candidate, by a test the change adds', proofs: ['manual:fault-class-decision'] }];
const gy1888Late: Item = { documentation, origin: gy1888Origin, criteria: gy1888Criteria,
  plannedFiles: ['tests/fault-class-decision.test.ts', baseline, wallClock, 'src/daemon/decision-text.ts', 'src/daemon/cycle-decisions.ts', 'src/daemon/cycle-approvers.ts', 'src/daemon/decision-holds.ts', 'docs/master-agent-sessions.md'] };
const gy1888SoakAsks: Ask[] = [
  { paths: ['tests/soak-decision-holds.test.ts'], reason: 'BLOCKING required soak coverage / AC-1 reliability on review of 6653b93a: the reviewer requires simulated-day coverage of heldRework adoption and agent_name_taken recovery through the real loop in tests/soak-*.test.ts' },
  { paths: ['tests/soak-decision-faults.test.ts'], reason: 'BLOCKING on review of 92e18d651f2c: AC-1 reliability requires the simulated-day coverage to live in tests/soak-*.test.ts; this widens only the existing decision-fault soak suite' },
];

test('manual:intervention-pattern-scope-widening-build — scope#2557709 (GY-1773): the soak suite and its simulation helper the review contract demands are refused on the base and granted by the engine itself on the candidate', () => {
  const base = judged(claimBase.decideScopeRequest, gy1773, gy1773Ask);
  assert.equal(base.state, 'refused', 'the instance reproduces on the claim base');
  assert.match(base.reason, /tests\/soak-day\.test\.ts, tests\/helpers\/soak-simulation\.ts are outside what this item's own criteria/);
  assert.equal(base.exempt, null, 'the refused autoscope is counted, as the pattern counted it');
  const candidate = judged(decideScopeRequest, gy1773, gy1773Ask);
  assert.equal(candidate.state, 'approved', candidate.reason);
  assert.match(candidate.reason, /tests\/soak-day\.test\.ts \(tests\/soak-day\.test\.ts is the soak coverage the review contract requires of a change to src\/daemon\/upgrade\.ts/);
  assert.match(candidate.reason, /tests\/helpers\/soak-simulation\.ts \(tests\/helpers\/soak-simulation\.ts is the soak coverage/);
  assert.equal(candidate.exempt, 'approved-autoscope', 'the fold reads the grant as no intervention');
});

test('manual:intervention-pattern-scope-widening-build — scope#2678064 and #2679203 (GY-1888): a new or existing soak suite beside planned src/daemon modules is refused on the base and granted on the candidate', () => {
  for (const ask of gy1888SoakAsks) {
    assert.equal(judged(claimBase.decideScopeRequest, gy1888Late, ask).state, 'refused', `${ask.paths[0]} reproduces on the claim base`);
    const candidate = judged(decideScopeRequest, gy1888Late, ask);
    assert.equal(candidate.state, 'approved', candidate.reason);
    assert.equal(candidate.exempt, 'approved-autoscope');
  }
});

test('manual:intervention-pattern-scope-widening-build — scope#2661903 (GY-1888) and scope#2661162 (GY-1881): refused on the base they occurred on, granted on the claim base since GY-1893 and still granted on the candidate', () => {
  const gy1888: Item = { documentation, origin: gy1888Origin, criteria: gy1888Criteria, plannedFiles: ['tests/fault-class-decision.test.ts', baseline, wallClock] };
  const gy1888Ask: Ask = { paths: ['src/daemon/decision-text.ts', 'src/daemon/cycle-decisions.ts', 'src/daemon/cycle-approvers.ts'], reason: 'AC-1 removes the decision faults\' shared cause in the loop\'s decision machinery' };
  const candidateSha = '552d4fbeedff', baseSha = 'c30a233fdea2';
  const gy1881: Item = { documentation, plannedFiles: ['src/up.ts', 'src/repository-setup.ts', 'tests/up-host-executor-repair.test.ts', baseline, wallClock],
    criteria: [{ id: 'AC-1', text: 'In tests/up-host-executor-repair.test.ts, with a host layout whose executor unit template starts another Graphyard checkout, `up` runs the real installExecutorSupervision path (not a stubbed --install).', proofs: ['unit:up-host-executor-repair-real-installer'] }],
    candidate: { sha: candidateSha, baseSha }, policy: { checks: ['test'], review: true },
    observation: { candidate: { sha: candidateSha, baseSha }, checks: [{ name: 'test', result: 'failure', appId: 15368, id: 100 }] },
    gates: [{ name: 'test', passed: false, reasons: [ciCheckRefusal('test')], ciAppIds: [15368] }] };
  const gy1881Ask: Ask = { paths: ['tests/pi-provider-limit-exhaustion.test.ts'], reason: 'CI point: the required test check failed on candidate 552d4fbeedff — test shard 6 fails at tests/pi-provider-limit-exhaustion.test.ts:199, a live wall-clock time bomb independent of this PR\'s diff' };
  for (const [key, item, ask] of [['GY-1888', gy1888, gy1888Ask], ['GY-1881', gy1881, gy1881Ask]] as const) {
    assert.equal(judged(preGy1893.decideScopeRequest, item, ask).state, 'refused', `${key}'s instance reproduces on the base it occurred on`);
    assert.equal(judged(claimBase.decideScopeRequest, item, ask).state, 'approved', `${key}'s cause was removed by GY-1893 before this item`);
    const candidate = judged(decideScopeRequest, item, ask);
    assert.deepEqual({ state: candidate.state, exempt: candidate.exempt }, { state: 'approved', exempt: 'approved-autoscope' }, `${key} does not recur: ${candidate.reason}`);
  }
});

test('manual:intervention-pattern-scope-widening-build — the soak ground is exactly the review contract\'s: one list of repeating paths, soak suites and their helpers only, and only beside a planned repeating path', () => {
  // One authority: the reviewer's repeating paths are the scope rule's.
  assert.equal(repeatingPaths, sharedRepeatingPaths);
  assert.match(repetitionReviewSection(['src/daemon/upgrade.ts']), /tests\/soak-\*\.test\.ts/);
  assert.equal(repetitionReviewSection(['src/up.ts']), '', 'the reviewer asks nothing of a change outside the repeating paths');
  // The files a soak suite is: a top-level soak test or a soak helper, nothing else under tests/.
  for (const path of ['tests/soak-day.test.ts', 'tests/soak-decision-holds.test.ts', 'tests/helpers/soak-simulation.ts', 'tests/helpers/soak-world.ts']) assert.ok(soakSuiteFile(path), path);
  for (const path of ['tests/soak/', 'tests/nested/soak-day.test.ts', 'tests/helpers/timing-report.ts', 'tests/fault-class-scope.test.ts', 'src/soak-day.ts', 'tests/soak-day.ts']) assert.ok(!soakSuiteFile(path), path);
  // Only beside a planned repeating path, file or prefix: a change the reviewer asks no soak of grants none.
  assert.match(soakSuiteGround('tests/soak-day.test.ts', ['src/master/']) ?? '', /a change to src\/master\//);
  assert.match(soakSuiteGround('tests/soak-day.test.ts', ['src/merge-queue.ts']) ?? '', /a change to src\/merge-queue\.ts/);
  assert.equal(soakSuiteGround('tests/soak-day.test.ts', ['src/up.ts', 'tests/up-host-executor-repair.test.ts']), null);
  assert.equal(soakSuiteGround('tests/soak-day.test.ts', []), null);
  const outside: Item = { documentation, plannedFiles: ['src/up.ts'], criteria: [{ id: 'AC-1', text: 'up repairs the unit', proofs: [] }] };
  assert.equal(decideScopeRequest(outside, gy1773Ask).state, 'refused', 'the rule keeps its teeth for an item the review contract asks no soak of');
  // A soak path in the ask never grounds itself: only the item's plan is read.
  assert.equal(companionGround('tests/soak-day.test.ts', outside, ['tests/soak-day.test.ts', 'src/daemon/run.ts'], documentation.paths), null);
});
