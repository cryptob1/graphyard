import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { baseTree, derivedIntent } from '../src/cli/master.js';
import { derivePlannedFiles, describedAsNew, impliedScopeRequests } from '../src/model/work.js';
import type { Work } from '../src/model.js';

// GY-140: plannedFiles is derived from the criteria and resolved against the base branch the item
// will be worked on, instead of being accepted as hand-written. `master create` and
// `master requirements` read the real tree of a real git repository here; the control plane is a
// recorder, since what is under test is what the master sends it, or refuses to send.
// Each test is named for the proof it produces.
let root: string, dir: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
const baseFiles = ['src/supervisor.ts', 'src/executor.ts', 'src/model/escalation-context.ts', 'src/master.ts', 'docs/master-agent.md', 'tests/existing.test.ts'];

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gy140-'));
  dir = await mkdtemp(join(tmpdir(), 'gy140-intent-'));
  git('init', '--quiet', '--initial-branch=main');
  for (const file of baseFiles) { await mkdir(join(root, dirname(file)), { recursive: true }); await writeFile(join(root, file), `// ${file}\n`); }
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  // A file only on another branch is not in the base the item will be worked on.
  git('checkout', '--quiet', '-b', 'elsewhere'); await writeFile(join(root, 'src/elsewhere.ts'), '//\n'); git('add', '.'); git('commit', '--quiet', '-m', 'elsewhere'); git('checkout', '--quiet', 'main');
});
after(async () => { await rm(root, { recursive: true, force: true }); await rm(dir, { recursive: true, force: true }); });

const intentFile = async (intent: object) => { const file = join(dir, `${Math.random().toString(36).slice(2)}.json`); await writeFile(file, JSON.stringify(intent)); return file; };
function recorder(work: Partial<Work>[] = []) {
  const sent: { path: string; data: any; credential?: string }[] = [];
  return { sent, deps: { coordinator: async () => ({ work }), token: async () => 'operator-agent-token', mutate: async (path: string, data: unknown, _id?: string, credential?: string) => { sent.push({ path, data, credential }); return { key: 'GY-1', plannedFiles: (data as any).plannedFiles }; } } };
}

test('integration:nonexistent-planned-path-refused — a planned path the base branch does not hold, which no criterion describes creating, refuses the item naming every such path', async () => {
  const { sent, deps } = recorder();
  const file = await intentFile({ title: 'Escalation context', criteria: [{ id: 'AC-1', text: 'The escalation context names its precedent.', proofs: ['unit:x'] }],
    plannedFiles: ['src/model/escalation-context.ts', 'src/escalation-context.ts', 'src/server/routes/context.ts', 'src/elsewhere.ts'] });
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'file', 'it'], deps), (error: Error) => {
    for (const path of ['src/escalation-context.ts', 'src/server/routes/context.ts', 'src/elsewhere.ts']) assert.match(error.message, new RegExp(path.replace(/[./]/g, '\\$&')), `the refusal names ${path}`);
    assert.doesNotMatch(error.message, /src\/model\/escalation-context\.ts/, 'a path the tree holds is not named');
    assert.match(error.message, /\bmain\b/, 'the refusal names the base it resolved against');
    return true;
  });
  assert.equal(sent.length, 0, 'nothing is recorded for a refused item');
});

test('integration:nonexistent-planned-path-refused — a planned path the criteria describe creating is accepted, as is a new test file a criterion requires', async () => {
  const { sent, deps } = recorder();
  const file = await intentFile({ title: 'Registry', criteria: [{ id: 'AC-1', text: 'A new module src/registry.ts holds the resource registry. A test asserts it covers every resource.', proofs: ['unit:x'] }],
    plannedFiles: ['src/registry.ts', 'tests/registry.test.ts', 'docs/'] });
  const result = await derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'file it'], deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, 'work');
  assert.equal(sent[0].credential, 'operator-agent-token', 'recorded with the operator-agent identity');
  assert.deepEqual(sent[0].data.plannedFiles, ['src/registry.ts', 'tests/registry.test.ts', 'docs/']);
  assert.equal(sent[0].data.reason, 'file it');
  assert.equal(result.plannedFilesDerived.base, 'main');
  assert.equal(describedAsNew('src/registry.ts', [{ id: 'AC-1', text: 'The registry in src/registry.ts is read.' }]), null, 'naming a path is not describing its creation');
});

test('integration:nonexistent-planned-path-refused — master requirements resolves the revised plannedFiles the same way', async () => {
  const work = { id: '00000000-0000-4000-8000-000000000001', key: 'GY-9', policyRevision: 3, criteria: [{ id: 'AC-1', text: 'The supervisor stops renewing.', proofs: ['unit:x'] }], dependencies: [], plannedFiles: ['src/supervisor.ts'] } as unknown as Work;
  const refused = recorder([work]);
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'requirements', ['GY-9', await intentFile({ plannedFiles: ['src/supervisor.ts', 'src/nowhere.ts'] }), 'widen'], refused.deps), /src\/nowhere\.ts/);
  assert.equal(refused.sent.length, 0);
  const accepted = recorder([work]);
  await derivedIntent(root, { baseBranch: 'main' }, 'requirements', ['GY-9', await intentFile({ plannedFiles: ['src/supervisor.ts', 'src/executor.ts'] }), 'widen'], accepted.deps);
  assert.equal(accepted.sent[0].path, `work/${work.id}/requirements`);
  assert.equal(accepted.sent[0].data.expectedPolicyRevision, 3);
  assert.deepEqual(accepted.sent[0].data.plannedFiles, ['src/supervisor.ts', 'src/executor.ts']);
});

test('integration:criterion-named-files-carried — a file a criterion names is carried into plannedFiles with that criterion as its source; a path mentioned only in prose is not', async () => {
  const { sent, deps } = recorder();
  const file = await intentFile({
    title: 'Consent prompts',
    description: 'Context: the merge path lives in src/master.ts, which this item does not need.',
    criteria: [
      { id: 'AC-1', text: 'A worker awaiting consent is reported by status.', proofs: ['unit:a'] },
      { id: 'AC-3', text: 'src/supervisor.ts stops renewing a lease for a session awaiting consent; `src/executor.ts` reports it, and src/absent.ts is not read.', proofs: ['unit:b'] },
    ],
    plannedFiles: ['tests/existing.test.ts'],
  });
  const result = await derivedIntent(root, { baseBranch: 'main' }, 'create', [file, 'file it'], deps);
  const planned: string[] = sent[0].data.plannedFiles;
  assert.ok(planned.includes('src/supervisor.ts'), 'the criterion-named file is planned');
  assert.ok(planned.includes('src/executor.ts'), 'a code-formatted criterion-named file is planned');
  assert.ok(!planned.includes('src/master.ts'), 'a path mentioned only in the description prose is not added');
  assert.ok(!planned.includes('src/absent.ts'), 'a named path the tree does not hold is not added');
  assert.deepEqual(result.plannedFilesDerived.added, [{ path: 'src/supervisor.ts', criterion: 'AC-3' }, { path: 'src/executor.ts', criterion: 'AC-3' }]);
  // A path already planned, directly or by a directory scope, is not reported as added.
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'src/supervisor.ts changes.' }] }, (await baseTree(root, 'main')).files).added, []);
});

test('unit:implied-scope-requests-reported — master status reports and counts, per open item, every scope request whose paths a criterion already names', () => {
  const now = '2026-09-23T12:00:00.000Z';
  const item = (key: string, stage: Work['stage'], extra: Partial<Work>) => ({ key, stage, criteria: [{ id: 'AC-3', text: 'The supervisor in src/supervisor.ts stops renewing.', proofs: ['unit:x'] }], scopeRequest: null, scopeDecision: null, ...extra }) as Work;
  const report = impliedScopeRequests([
    item('GY-130', 'build', { scopeRequest: { epoch: 1, paths: ['src/supervisor.ts', 'src/other.ts'], reason: 'needs it', requestedBy: 'w', at: now } }),
    item('GY-131', 'build', { scopeDecision: { state: 'approved', reason: 'implied', at: now, decidedBy: 'loop', waitedMs: 1, paths: ['src/supervisor.ts'], requestedBy: 'w', requestedAt: now } }),
    item('GY-132', 'build', { scopeRequest: { epoch: 1, paths: ['src/unnamed.ts'], reason: 'wider', requestedBy: 'w', at: now } }),
    item('GY-133', 'done', { scopeRequest: { epoch: 1, paths: ['src/supervisor.ts'], reason: 'late', requestedBy: 'w', at: now } }),
  ]);
  assert.equal(report.count, 2);
  assert.deepEqual(report.items.map(entry => [entry.key, entry.state, entry.named]), [
    ['GY-130', 'open', [{ path: 'src/supervisor.ts', criterion: 'AC-3' }]],
    ['GY-131', 'approved', [{ path: 'src/supervisor.ts', criterion: 'AC-3' }]],
  ]);
});
