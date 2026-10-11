import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixItem } from '../src/daemon/diagnosis.js';
import { deriveDiagnosisFixPlannedFiles, plannedFilesRefusal } from '../src/model/work.js';
import type { DiagnosisPayload } from '../src/runner/payloads.js';

// GY-1707: a fix item the loop files from a diagnosis derives plannedFiles the way master create
// does — base-tree resolution, criteria-named files, planned companions, cause-named tree files
// for a recurring-fault subject — and refuses unresolvable paths. Each test is named for its proof.

const baseline = 'tests/helpers/timing-baseline.json';
const docsBudget = 'tests/docs-budget.test.ts';
const baseTree = new Set([
  'src/merge-queue.ts', 'src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md',
  'src/daemon/cycle-decisions.ts', 'src/daemon/metrics.ts', 'src/daemon/decisions.ts',
  'src/daemon/cycle-sessions.ts', 'src/daemon/cycle-approvers.ts', 'src/daemon/diagnosis.ts',
  'src/model/capacity.ts', 'docs/master-agent.md', 'docs/master-agent-sessions.md', 'docs/onboarding.md',
  'tests/capacity-silent-exhaustion.test.ts', baseline, docsBudget,
]);

const entry = (kind: 'recurring' | 'invariant' = 'recurring') =>
  ({ subject: kind === 'recurring' ? 'GY-101' : 'invariant:x', kind, work: kind === 'recurring' ? 'GY-101' : null });

function payload(fix: NonNullable<DiagnosisPayload['fix']>, cause: string): DiagnosisPayload {
  return {
    subject: 'GY-101', cause, evidence: { logLines: ['log'], commands: ['ran: status'] },
    faultClass: 'scope', covering: null, fix,
  };
}

test('unit:diagnosis-fix-item-derives-planned-files — criteria-named base files and unit-proof companions land in plannedFiles', () => {
  const criteria = [{
    id: 'AC-1',
    text: 'A CLEAN candidate whose base moved is observed again in src/merge-queue.ts within one cycle, by a test',
    proofs: ['unit:clean-candidate-refreshed'],
  }];
  // Diagnostician plans nothing; derivation carries the criterion-named file and its proof test.
  const derived = deriveDiagnosisFixPlannedFiles({ plannedFiles: [], criteria, kind: 'invariant' }, baseTree, 'main');
  assert.ok(derived.plannedFiles.includes('src/merge-queue.ts'), 'criterion-named base file is carried');
  assert.ok(derived.plannedFiles.includes('tests/clean-candidate-refreshed.test.ts'), 'unit proof companion is carried');
  assert.ok(derived.plannedFiles.includes(baseline), 'timing baseline companion is carried');
  const filed = fixItem(entry('invariant'), payload({
    title: 'Refresh CLEAN observations', description: 'cause', type: 'bug', priority: 1, criteria, plannedFiles: [],
  }, 'prose names no path'), { ref: 'main', files: baseTree });
  assert.deepEqual(filed.plannedFiles, derived.plannedFiles);
});

test('unit:diagnosis-fix-item-carries-cause-named-files — recurring-fault cause paths that resolve in the tree join plannedFiles', () => {
  const cause = 'The shared cause lives in src/daemon/cycle-decisions.ts:134-140, src/daemon/metrics.ts and src/daemon/decisions.ts';
  const criteria = [{ id: 'AC-1', text: 'The shared cause is removed.', proofs: ['manual:fault-class-decision'] }];
  // As GY-1701 was filed: the diagnostician planned none of the cause-named daemon files.
  const derived = deriveDiagnosisFixPlannedFiles({
    plannedFiles: ['docs/master-agent.md'], criteria, cause, kind: 'recurring',
  }, baseTree, 'main');
  for (const path of ['src/daemon/cycle-decisions.ts', 'src/daemon/metrics.ts', 'src/daemon/decisions.ts']) {
    assert.ok(derived.plannedFiles.includes(path), `${path} from the cause is carried`);
  }
  assert.ok(derived.plannedFiles.includes(docsBudget), 'docs-budget gate accompanies planned documentation');
  // An invariant diagnosis does not treat the cause as a requirement that widens the plan.
  const invariant = deriveDiagnosisFixPlannedFiles({
    plannedFiles: ['docs/master-agent.md'], criteria, cause, kind: 'invariant',
  }, baseTree, 'main');
  assert.equal(invariant.plannedFiles.includes('src/daemon/cycle-decisions.ts'), false);
});

test('unit:diagnosis-fix-item-refuses-unresolvable-planned-files — a path the tree lacks and no criterion creates is refused with plannedFilesRefusal', () => {
  const criteria = [{ id: 'AC-1', text: 'The fix lands.', proofs: ['unit:x'] }];
  const missing = ['src/nowhere.ts'];
  assert.throws(
    () => deriveDiagnosisFixPlannedFiles({ plannedFiles: ['src/merge-queue.ts', ...missing], criteria, kind: 'invariant' }, baseTree, 'origin/main'),
    (error: Error) => {
      assert.equal(error.message, plannedFilesRefusal(missing, 'origin/main'));
      return true;
    },
  );
  assert.throws(
    () => fixItem(entry(), payload({
      title: 'Bad plan', description: 'x', type: 'bug', priority: 1, criteria,
      plannedFiles: ['src/merge-queue.ts', 'src/nowhere.ts'],
    }, 'cause'), { ref: 'origin/main', files: baseTree }),
    /plannedFiles names a path that origin\/main does not hold/,
  );
});

test('unit:diagnosis-fix-filed-input-equals-derived — the filed plannedFiles equal the derivation, with diagnostician and derivation naming a path once', () => {
  const criteria = [{
    id: 'AC-1',
    text: 'src/merge-queue.ts refreshes a CLEAN candidate; a test asserts it.',
    proofs: ['unit:clean-candidate-refreshed'],
  }];
  // Diagnostician already named the criterion file and the proof companion; derivation must not duplicate.
  const planned = ['src/merge-queue.ts', 'tests/clean-candidate-refreshed.test.ts'];
  const derived = deriveDiagnosisFixPlannedFiles({ plannedFiles: planned, criteria, kind: 'recurring', cause: 'in src/merge-queue.ts' }, baseTree, 'main');
  assert.equal(derived.plannedFiles.filter(path => path === 'src/merge-queue.ts').length, 1);
  assert.equal(derived.plannedFiles.filter(path => path === 'tests/clean-candidate-refreshed.test.ts').length, 1);
  const filed = fixItem(entry(), payload({
    title: 'Refresh', description: 'x', type: 'bug', priority: 1, criteria, plannedFiles: planned,
  }, 'stale observation in src/merge-queue.ts'), { ref: 'main', files: baseTree });
  assert.deepEqual(filed.plannedFiles, derived.plannedFiles);
});

/**
 * The three linked scope-fault instances (GY-1700, GY-1701, GY-1705) as the diagnostician filed
 * them — planned narrower than their own record — and the files their workers had to ask for.
 * Replaying each shape against a base tree that holds the named files must produce plannedFiles
 * covering those asks.
 */
test('integration:replay-fault-class-filing-carries-asked-files — GY-1700, GY-1701 and GY-1705 filing shapes cover the files their workers asked for', () => {
  // GY-1700: AC-0 unit proof had no planned test vehicle; the worker asked for tests/webhook-soft-accept.test.ts.
  const gy1700 = deriveDiagnosisFixPlannedFiles({
    plannedFiles: ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md'],
    criteria: [{
      id: 'AC-0',
      text: 'A verified webhook delivery soft-accepts with HTTP 202 when readiness is false.',
      proofs: ['unit:webhook-soft-accept-no-5xx'],
    }],
    kind: 'recurring',
    cause: 'receiver endpoint erroring in src/server/routes/github.ts mounted from src/server/main.ts',
  }, baseTree, 'main');
  assert.ok(gy1700.plannedFiles.includes('tests/webhook-soft-accept-no-5xx.test.ts')
    || gy1700.plannedFiles.includes('tests/webhook-soft-accept.test.ts'),
  'GY-1700 proof companion is planned');
  // proofTestFile names tests/webhook-soft-accept-no-5xx.test.ts from the proof id; either that or a
  // criterion-described new test is the vehicle the worker asked for under the soft-accept stem.
  assert.ok(gy1700.plannedFiles.some(path => /webhook-soft-accept/.test(path)), 'GY-1700 AC-0 test vehicle is planned');

  // GY-1701: cause named the three daemon files; filed plannedFiles held none of them.
  const gy1701 = deriveDiagnosisFixPlannedFiles({
    plannedFiles: ['docs/master-agent.md'],
    criteria: [{ id: 'AC-1', text: 'The shared cause of the recurring decision faults is removed.', proofs: ['manual:fault-class-decision'] }],
    kind: 'recurring',
    cause: 'A no-answers standing revision always deferred in src/daemon/cycle-decisions.ts:134-140; counting and holds live in src/daemon/metrics.ts and src/daemon/decisions.ts',
  }, baseTree, 'main');
  for (const path of ['src/daemon/cycle-decisions.ts', 'src/daemon/metrics.ts', 'src/daemon/decisions.ts']) {
    assert.ok(gy1701.plannedFiles.includes(path), `GY-1701 carries cause-named ${path}`);
  }

  // GY-1705: AC-4 declares its soak-test vehicle; peers/docs the worker asked for were unplanned.
  const gy1705Tree = new Set([...baseTree, 'tests/soak-silent-exhaustion.test.ts', 'src/daemon/effects.ts',
    'src/reviewer.ts', 'src/producer.ts', 'src/master/autonomy.ts', 'src/master/launch-account.ts',
    'src/daemon/doctor.ts', 'src/daemon/cycle-dispatch.ts']);
  const gy1705 = deriveDiagnosisFixPlannedFiles({
    plannedFiles: ['src/model/capacity.ts', 'src/daemon/cycle-sessions.ts', 'src/daemon/cycle-approvers.ts',
      'src/daemon/diagnosis.ts', 'tests/capacity-silent-exhaustion.test.ts'],
    criteria: [
      { id: 'AC-1', text: 'A silent pane exhaustion is treated as an account exhaustion.', proofs: ['unit:silent-pane-exhaustion-signal', 'integration:approver-silent-exhaustion-failover'] },
      { id: 'AC-4', text: 'Replaying the filed instances against the candidate shows each bounded, by a test in tests/soak-silent-exhaustion.test.ts.', proofs: ['integration:replay-approver-silent-deaths', 'manual:replay-doctor-no-report'] },
    ],
    kind: 'recurring',
    cause: 'sessionExhaustion in src/daemon/cycle-sessions.ts and approverExhausted in src/daemon/cycle-approvers.ts miss a spent account with no provider notice; src/daemon/diagnosis.ts providerLimit only fires when every attempt names one',
  }, gy1705Tree, 'main');
  assert.ok(gy1705.plannedFiles.includes('tests/soak-silent-exhaustion.test.ts'), 'GY-1705 declared soak vehicle is planned');
  assert.ok(gy1705.plannedFiles.includes(baseline), 'GY-1705 timing baseline companion is planned');
});
