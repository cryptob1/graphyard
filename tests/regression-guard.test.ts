import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScope, regressionRefusals, shippedBy } from '../src/regression-guard.js';
import { parseLocalScopeDiff } from '../src/sync.js';
import { evaluate, type ScopeFile, type Work } from '../src/model.js';

const blob = (label: string) => label.repeat(40).slice(0, 40);
const planned = ['src/engine.ts', 'tests/'];
const file = (overrides: Partial<ScopeFile> & { path: string }): ScopeFile => ({ status: 'modified', sha: blob('1'), additions: 2, deletions: 1, binary: false, baseSha: blob('2'), ...overrides });
const kinds = (files: ScopeFile[]) => Object.fromEntries(classifyScope(planned, files).map(finding => [finding.path, `${finding.kind}:${finding.refused ? 'refused' : 'ok'}`]));

test('scope classifier: in-scope changes, new files and files matching the base pass; reverts, deletions, renames and binaries refuse', () => {
  assert.deepEqual(kinds([
    file({ path: 'src/engine.ts', baseSha: undefined }),
    file({ path: 'tests/new.test.ts', status: 'added', baseSha: undefined }),
    file({ path: 'src/new-module.ts', status: 'added', baseSha: null }),
    file({ path: 'src/already-landed.ts', sha: blob('7'), baseSha: blob('7') }),
    file({ path: 'src/quarantine.ts', additions: 0, deletions: 42 }),
    file({ path: 'src/master.ts', additions: 5, deletions: 30 }),
    file({ path: 'src/reviewer.ts', status: 'removed', sha: null }),
    file({ path: 'src/gone-everywhere.ts', status: 'removed', sha: null, baseSha: null }),
    file({ path: 'src/resurrected.ts', baseSha: null }),
    file({ path: 'web/logo.png', binary: true, additions: 0, deletions: 0 }),
  ]), {
    'src/engine.ts': 'in-scope:ok', 'tests/new.test.ts': 'in-scope:ok', 'src/new-module.ts': 'new:ok', 'src/already-landed.ts': 'matches-base:ok',
    'src/quarantine.ts': 'reverted:refused', 'src/master.ts': 'rewritten:refused', 'src/reviewer.ts': 'deleted:refused', 'src/gone-everywhere.ts': 'already-absent:ok',
    'src/resurrected.ts': 'reverted:refused', 'web/logo.png': 'binary:refused',
  });
});

test('scope classifier: a rename is judged at both ends and an uncompared out-of-scope file never passes', () => {
  const moved = file({ path: 'src/renamed.ts', status: 'renamed', previousPath: 'src/original.ts', baseSha: null, previousBaseSha: blob('9') });
  assert.deepEqual(kinds([moved]), { 'src/original.ts': 'renamed:refused', 'src/renamed.ts': 'new:ok' });
  const fromScope = file({ path: 'src/moved-out.ts', status: 'renamed', previousPath: 'tests/helper.ts', baseSha: null, previousBaseSha: blob('9') });
  assert.deepEqual(kinds([fromScope]), { 'src/moved-out.ts': 'new:ok' }, 'moving a planned file leaves the planned scope free to change');
  const intoScope = file({ path: 'tests/moved-in.test.ts', status: 'renamed', previousPath: 'src/original.ts', baseSha: undefined, previousBaseSha: blob('9') });
  assert.deepEqual(kinds([intoScope]), { 'src/original.ts': 'renamed:refused', 'tests/moved-in.test.ts': 'in-scope:ok' }, 'a rename into scope still removes a shipped path');
  const freshOrigin = file({ path: 'src/renamed.ts', status: 'renamed', previousPath: 'src/temp.ts', baseSha: null, previousBaseSha: null });
  assert.deepEqual(kinds([freshOrigin]), { 'src/renamed.ts': 'new:ok' }, 'renaming a file the base never held moves nothing shipped');
  assert.deepEqual(kinds([file({ path: 'src/unknown.ts', baseSha: undefined }), file({ path: 'src/dropped.ts', status: 'removed', sha: null, baseSha: undefined })]),
    { 'src/unknown.ts': 'unverified:refused', 'src/dropped.ts': 'unverified:refused' });
});

test('refusals name every offending file with the delivered work that shipped it, and an uncompared observation is refused', () => {
  const done = (key: string, plannedFiles: string[], files: string[] = []) => ({ key, id: key, stage: 'done', plannedFiles, observation: { files } } as unknown as Work);
  const all = [done('GY-33', ['src/quarantine.ts', 'tests/quarantine.test.ts']), done('GY-1', ['scripts/'], ['src/reviewer.ts']), { key: 'GY-55', id: 'GY-55', stage: 'build', plannedFiles: planned } as unknown as Work];
  assert.deepEqual(shippedBy('src/quarantine.ts', all), ['GY-33']); assert.deepEqual(shippedBy('src/reviewer.ts', all), ['GY-1']); assert.deepEqual(shippedBy('src/nobody.ts', all), []);
  const reasons = regressionRefusals({ key: 'GY-55', plannedFiles: planned }, { scopeFiles: [
    file({ path: 'src/engine.ts', baseSha: undefined }), file({ path: 'src/quarantine.ts', additions: 0, deletions: 42 }), file({ path: 'src/reviewer.ts', status: 'removed', sha: null }), file({ path: 'src/nobody.ts' }),
  ] }, all);
  assert.equal(reasons.length, 4);
  assert.match(reasons[0], /3 files outside its planned files.*graphyard sync GY-55/);
  assert.match(reasons[1], /^Out-of-scope regression: src\/quarantine\.ts: removes 42 lines.*\(shipped by GY-33\)$/);
  assert.match(reasons[2], /^Out-of-scope regression: src\/reviewer\.ts: deleted.*\(shipped by GY-1\)$/);
  assert.match(reasons[3], /src\/nobody\.ts: differs from the base branch tip \(\+2 −1\) \(no delivered work item claims this path\)/);
  assert.deepEqual(regressionRefusals({ key: 'GY-55', plannedFiles: planned }, { scopeFiles: [file({ path: 'src/engine.ts', baseSha: undefined }), file({ path: 'src/new.ts', status: 'added', baseSha: null })] }, all), []);
  assert.match(regressionRefusals({ key: 'GY-55', plannedFiles: planned }, {}, all)[0], /has not been compared against the base branch tip/);
});

test('the build gate carries the regression refusal only for the observed candidate and clears once the head is fixed', () => {
  const head = blob('a'), base = blob('b');
  const work = { id: 'w', key: 'GY-55', ready: true, dependencies: [], criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], policy: { checks: ['test'], review: false }, plannedFiles: planned,
    submission: { epoch: 1, pr: 5 }, workspaces: [{ epoch: 1, host: 'h', path: '/w', branch: 'graphyard/gy-55-1', owner: 'a' }], candidate: { sha: head, baseSha: base, pr: 5, branch: 'graphyard/gy-55-1', author: 'a' },
    observation: { candidate: { sha: head, baseSha: base, pr: 5, branch: 'graphyard/gy-55-1', author: 'a' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/quarantine.ts'],
      scopeFiles: [file({ path: 'src/quarantine.ts', additions: 0, deletions: 9 })], at: new Date().toISOString() },
    evidence: [], violations: [], gates: [], stage: 'build', scenarioRequirements: [], reworkRequested: false, lease: null, epoch: 1, revision: 1, policyRevision: 1, blocker: null } as unknown as Work;
  const refused = evaluate(work, [work], new Date(), [15368]);
  assert.equal(refused.stage, 'build');
  assert.match(refused.gates.find(gate => gate.name === 'build')!.reasons.join('\n'), /src\/quarantine\.ts: removes 9 lines/);
  const stale = { ...work, candidate: { ...work.candidate!, sha: blob('c') } } as Work;
  assert.doesNotMatch(evaluate(stale, [stale], new Date(), [15368]).gates.find(gate => gate.name === 'build')!.reasons.join('\n'), /quarantine/, 'a refusal never outlives its observation');
  const fixed = { ...work, observation: { ...work.observation!, scopeFiles: [file({ path: 'src/quarantine.ts', sha: blob('2') })] } } as Work;
  assert.equal(evaluate(fixed, [fixed], new Date(), [15368]).gates.find(gate => gate.name === 'build')!.passed, true);
});

test('the local diff parser turns git raw and numstat output into the same file records the provider observation carries', () => {
  const raw = `:100644 100644 ${blob('1')} ${blob('2')} M\0src/engine.ts\0:100644 000000 ${blob('3')} ${'0'.repeat(40)} D\0src/reviewer.ts\0:100644 100644 ${blob('4')} ${blob('4')} R100\0web/logo.png\0web/moved.png\0:000000 100644 ${'0'.repeat(40)} ${blob('5')} A\0src/new.ts\0`;
  const numstat = `3\t1\tsrc/engine.ts\0` + `0\t12\tsrc/reviewer.ts\0` + `-\t-\t\0web/logo.png\0web/moved.png\0` + `4\t0\tsrc/new.ts\0`;
  const files = parseLocalScopeDiff(raw, numstat);
  assert.deepEqual(files, [
    { path: 'src/engine.ts', status: 'modified', sha: blob('2'), additions: 3, deletions: 1, binary: false, baseSha: blob('1') },
    { path: 'src/reviewer.ts', status: 'removed', sha: null, additions: 0, deletions: 12, binary: false, baseSha: blob('3') },
    { path: 'web/moved.png', status: 'renamed', sha: blob('4'), additions: 0, deletions: 0, binary: true, baseSha: null, previousPath: 'web/logo.png', previousBaseSha: blob('4') },
    { path: 'src/new.ts', status: 'added', sha: blob('5'), additions: 4, deletions: 0, binary: false, baseSha: null },
  ]);
  assert.deepEqual(kinds(files), { 'src/engine.ts': 'in-scope:ok', 'src/reviewer.ts': 'deleted:refused', 'web/logo.png': 'renamed:refused', 'web/moved.png': 'new:ok', 'src/new.ts': 'new:ok' });
  assert.deepEqual(parseLocalScopeDiff('', ''), []);
});
