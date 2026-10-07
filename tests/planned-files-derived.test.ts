import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { baseTree, derivedIntent } from '../src/cli/master.js';
import { derivePlannedFiles, describedAsNew, impliedScopeRequests } from '../src/model/work.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-140: plannedFiles is derived from the criteria and resolved against the base branch the item
// will be worked on, instead of being accepted as hand-written. `master create` and
// `master requirements` read the real tree of a real git repository here; the control plane is a
// recorder, since what is under test is what the master sends it, or refuses to send.
// Each test is named for the proof it produces.
let root: string, dir: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
const baseFiles = ['src/supervisor.ts', 'src/executor.ts', 'src/model/escalation-context.ts', 'src/master.ts', 'docs/master-agent.md', 'tests/existing.test.ts'];

before(async () => {
  root = await temporaryDirectory('gy140');
  dir = await temporaryDirectory('gy140-intent');
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

test('unit:planned-files-dotfile-creation — a dotfile a criterion describes creating (.gitignore, a .github path) is accepted as any other new path, and one no criterion describes is still refused', async () => {
  // GY-1479: `master create` refused .gitignore although its criterion said "It creates a new .gitignore file".
  for (const [path, text] of [['.gitignore', 'It creates a new .gitignore file that ignores the build output.'], ['.github/workflows/ci.yml', 'It adds .github/workflows/ci.yml, which runs the tests.'], ['.env.example', 'A new `.env.example` lists every variable.']]) {
    const criteria = [{ id: 'AC-1', text, proofs: ['unit:x'] }];
    assert.equal(describedAsNew(path, criteria), 'AC-1', `${path} is described as new`);
    const { sent, deps } = recorder();
    await derivedIntent(root, { baseBranch: 'main' }, 'create', [await intentFile({ title: 'Dotfile', criteria, plannedFiles: [path, 'src/master.ts'] }), 'file it'], deps);
    assert.ok(sent[0].data.plannedFiles.includes(path), `${path} is recorded in plannedFiles`);
  }
  const { sent, deps } = recorder();
  await assert.rejects(derivedIntent(root, { baseBranch: 'main' }, 'create', [await intentFile({ title: 'Dotfile', criteria: [{ id: 'AC-1', text: 'The master reads its config.', proofs: ['unit:x'] }], plannedFiles: ['.gitignore', '.github/workflows/ci.yml'] }), 'file it'], deps),
    /paths that main does not hold and no criterion describes creating: \.gitignore, \.github\/workflows\/ci\.yml/);
  assert.equal(sent.length, 0);
  assert.equal(describedAsNew('.gitignore', [{ id: 'AC-1', text: 'It creates a new src/gitignore.ts module.' }]), null, 'a dot inside a word names no dotfile');
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
  // The plan holds no test file, so the one AC-1's proof will live in is carried in too (GY-955).
  assert.deepEqual(accepted.sent[0].data.plannedFiles, ['src/supervisor.ts', 'src/executor.ts', 'tests/x.test.ts']);
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

test('unit:planned-files-carry-companions — authoring carries the test file the proofs live in and the docs-budget gate, so items authored like GY-945 and GY-883 report no implied scope request', () => {
  const tree = new Set(['src/model/policy.ts', 'src/model/gates.ts', 'src/model.ts', 'docs/dashboard.md', 'web/pages/fleet.tsx', 'web/style.css', 'tests/docs-budget.test.ts', 'tests/auto-rebase.test.ts', 'tests/existing.test.ts']);
  // GY-945: web-UI prose criteria whose two proofs share `fleet-panel`, and a documentation guide.
  const fleet = [
    { id: 'AC-1', text: 'A fleet panel in the web UI lists every registry account.', proofs: ['unit:fleet-panel-renders-registry'] },
    { id: 'AC-2', text: 'Stale or probe-failed accounts are visually distinguished from healthy ones.', proofs: ['unit:fleet-panel-marks-stale-probe'] },
  ];
  const gy945 = derivePlannedFiles({ plannedFiles: ['docs/dashboard.md', 'web/pages/fleet.tsx', 'web/style.css'], criteria: fleet }, tree);
  assert.deepEqual(gy945.added, [{ path: 'tests/fleet-panel.test.ts', criterion: 'AC-1' }, { path: 'tests/docs-budget.test.ts', criterion: 'DOCS' }]);
  assert.deepEqual(gy945.missing, []);
  // GY-883: criteria naming src/model/policy.ts, src/model/gates.ts and the new tests/risk-lanes.test.ts.
  const lanes = [
    { id: 'AC-1', text: 'src/model/policy.ts assigns every item a lane. A new test file tests/risk-lanes.test.ts that this item creates asserts it.', proofs: ['unit:risk-lane-assigned'] },
    { id: 'AC-2', text: 'In src/model/gates.ts a low-lane item is landable with its checks green.', proofs: ['unit:lane-sets-required-gates'] },
  ];
  const gy883 = derivePlannedFiles({ plannedFiles: ['tests/risk-lanes.test.ts', 'docs/how-graphyard-works.md'], criteria: lanes }, tree);
  assert.deepEqual(gy883.plannedFiles, ['tests/risk-lanes.test.ts', 'docs/how-graphyard-works.md', 'src/model/policy.ts', 'src/model/gates.ts', 'tests/docs-budget.test.ts'], 'a planned test file holds the proofs; the gate rides beside documentation');
  // No documentation and no test proof: nothing is carried.
  assert.deepEqual(derivePlannedFiles({ plannedFiles: ['src/model/gates.ts'], criteria: [{ id: 'AC-1', text: 'Gates change.', proofs: ['manual:x'] }] }, tree).added, []);

  // The measure (GY-140 AC-3): authored as before, the worker asked for the companions and each
  // ask counted; authored with them carried in, the same worker never needs to ask.
  const now = '2026-09-29T06:30:57.512Z';
  const open = (plannedFiles: string[], paths: string[], criteria: typeof fleet) => ({ key: 'GY-945', stage: 'build', criteria, plannedFiles, scopeDecision: null,
    scopeRequest: paths.length ? { epoch: 1, paths, reason: 'the feature', requestedBy: 'w', at: now } : null }) as unknown as Work;
  const asked = ['docs/dashboard.md', 'web/pages/fleet.tsx', 'web/style.css', 'tests/fleet-panel.test.ts', 'tests/docs-budget.test.ts'];
  const before = impliedScopeRequests([open([], asked, fleet)]);
  assert.equal(before.count, 1);
  assert.deepEqual(before.items[0].named.map(entry => entry.path), ['web/pages/fleet.tsx', 'web/style.css', 'tests/fleet-panel.test.ts', 'tests/docs-budget.test.ts']);
  const carried = derivePlannedFiles({ plannedFiles: ['docs/dashboard.md', 'web/pages/fleet.tsx', 'web/style.css'], criteria: fleet }, tree).plannedFiles;
  const unplanned = asked.filter(path => !carried.includes(path));
  assert.deepEqual(unplanned, [], 'every path GY-945 asked for is planned at authoring');
  assert.equal(impliedScopeRequests([open(carried, unplanned, fleet), open(gy883.plannedFiles, [], lanes)]).count, 0);
});
