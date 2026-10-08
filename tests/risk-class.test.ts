import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifyRisk, deltaPaths, riskDelta, riskOf, sensitiveRules, unknownChangeReason, withRisk } from '../src/model/risk-class.js';
import type { Work } from '../src/model/work.js';
import { workCommands } from '../src/cli/work.js';
import type { CliContext } from '../src/cli/context.js';
import WorkDetails from '../web/pages/work-details.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { boardFromStatus } from '../src/model/board.js';
import { unknownFeatures } from '../web/features.js';
// @ts-expect-error Dependency-free fixture and screenshot script.
import { fixtureApi, fixtureStatus, fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';

// GY-1521: the risk class of a change is judged from the delta the merge would apply to main,
// beside the path-glob lane that still gates github mode. The class is computed on read, never
// stored, and names per file the rule that made it sensitive.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFile(new URL(path, new URL('..', import.meta.url)), 'utf8');
const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const sensitiveSamples: [string, string][] = [
  ['src/store/tables/work.ts', 'persistence layer'],
  ['src/server/auth.ts', 'server auth, principals, API assembler, bootstrap or routes'],
  ['src/server/principals.ts', 'server auth, principals, API assembler, bootstrap or routes'],
  ['src/server/index.ts', 'server auth, principals, API assembler, bootstrap or routes'],
  ['src/server/main.ts', 'server auth, principals, API assembler, bootstrap or routes'],
  ['src/server/routes/status.ts', 'server auth, principals, API assembler, bootstrap or routes'],
  ['src/operator-agent.ts', 'operator agent'],
  ['src/proof-grants.ts', 'proof grants'],
  ['src/install/local-runtime.ts', 'installation'],
  ['deploy/railway.json', 'deployment'],
  ['Dockerfile', 'Dockerfile'],
  ['Dockerfile.worker', 'Dockerfile'],
  ['compose.yaml', 'compose file'],
  ['compose.yml', 'compose file'],
  ['.github/workflows/ci.yml', 'CI configuration'],
  ['package.json', 'dependencies'],
  ['package-lock.json', 'dependencies'],
  ['src/merge-queue.ts', 'merge path'],
  ['src/direct-merge.ts', 'merge path'],
  ['src/merger-mode.ts', 'merge path'],
  ['src/main-guard.ts', 'merge path'],
  ['src/regression-guard.ts', 'merge path'],
  ['src/merge-writer/commit.ts', 'merge writer'],
  ['migrations/0042-risk.sql', 'migrations'],
];
const normalSamples = ['src/model/policy.ts', 'src/cli/work.ts', 'web/pages/work-details.tsx', 'docs/how-graphyard-works.md', 'tests/risk-class.test.ts', 'README.md',
  'src/server/lane-rework.ts', 'src/server/static.ts', 'src/merge-queue-report.ts', 'packages/x/package.json', 'compose.override.yaml', 'scripts/Dockerfile', 'src/installer.ts'];

test('unit:risk-class-paths — every sensitive rule of the criterion classifies its paths sensitive with a reason naming the path and the rule, and paths outside the rules are normal with no reason', () => {
  for (const [path, rule] of sensitiveSamples) {
    const verdict = classifyRisk([{ path }]);
    assert.equal(verdict.risk, 'sensitive', path);
    assert.ok(verdict.reasons.some(reason => reason.includes(path) && reason.includes(rule)), `${path}: ${verdict.reasons.join('; ')} names the path and the rule ${rule}`);
  }
  for (const path of normalSamples) assert.deepEqual(classifyRisk([{ path }]), { risk: 'normal', reasons: [] }, path);
  // A mixed delta is sensitive for exactly its sensitive paths; the normal ones add no reason.
  const mixed = classifyRisk([{ path: 'docs/dashboard.md' }, { path: 'src/store/tables/work.ts' }, { path: 'src/model/policy.ts' }]);
  assert.equal(mixed.risk, 'sensitive');
  assert.deepEqual(mixed.reasons, ['src/store/tables/work.ts: persistence layer']);
  // The rule table is the criterion's list, one rule per surface.
  assert.equal(sensitiveRules.length, 13);
  assert.ok(sensitiveRules.every(({ pattern }) => pattern.source.startsWith('^')), 'every rule is anchored at the start of the path');
  // Node-free: the module imports nothing from node: and nothing but the work type.
});

test('unit:risk-class-paths — src/model/risk-class.ts uses no Node built-in', async () => {
  const source = await read('src/model/risk-class.ts');
  assert.doesNotMatch(source, /from '(node:|fs|path|child_process|os|url)/, 'risk-class.ts imports no Node built-in');
  assert.doesNotMatch(source, /\bprocess\.|require\(/);
});

test('unit:risk-class-rename-both-ends — a rename is judged at both ends: out of a sensitive tree and into one are both sensitive, and a rename inside normal trees is normal', () => {
  const out = classifyRisk([{ path: 'src/model/work-store.ts', previousPath: 'src/store/work.ts' }]);
  assert.equal(out.risk, 'sensitive');
  assert.deepEqual(out.reasons, ['src/store/work.ts: persistence layer'], 'the source of the rename is the reason');
  const into = classifyRisk([{ path: 'src/install/host.ts', previousPath: 'src/host.ts' }]);
  assert.equal(into.risk, 'sensitive');
  assert.deepEqual(into.reasons, ['src/install/host.ts: installation'], 'the destination of the rename is the reason');
  const both = classifyRisk([{ path: 'migrations/002.sql', previousPath: 'src/store/002.sql' }]);
  assert.deepEqual(both.reasons, ['migrations/002.sql: migrations', 'src/store/002.sql: persistence layer']);
  assert.deepEqual(classifyRisk([{ path: 'src/model/b.ts', previousPath: 'src/model/a.ts' }]), { risk: 'normal', reasons: [] });
  // An unchanged path is one path, a rename two, and duplicates collapse.
  assert.deepEqual(deltaPaths([{ path: 'a.ts', previousPath: 'a.ts' }, { path: 'b.ts', previousPath: 'c.ts' }, { path: 'b.ts' }]), ['a.ts', 'b.ts', 'c.ts']);
});

test('unit:risk-class-unknown-sensitive — an empty file list is sensitive with the single reason `unknown change`', () => {
  assert.deepEqual(classifyRisk([]), { risk: 'sensitive', reasons: [unknownChangeReason] });
  assert.equal(unknownChangeReason, 'unknown change');
});

const base = (overrides: Partial<Work> = {}): Pick<Work, 'candidate' | 'observation'> => ({
  candidate: { sha: 'head1', baseSha: 'bound1', pr: 7 } as Work['candidate'],
  observation: {
    candidate: { sha: 'head1', baseSha: 'bound1', pr: 7 }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, at: NOW,
    files: ['src/model/policy.ts'], baseTip: 'tip2',
    scopeFiles: [{ path: 'src/install/host.ts', status: 'modified', sha: 'a', additions: 1, deletions: 0, binary: false }],
    landing: { base: 'tip2', files: [{ path: 'docs/dashboard.md', status: 'modified', sha: 'b', additions: 1, deletions: 0, binary: false }] },
  } as unknown as Work['observation'],
  ...overrides,
});

test('unit:risk-class-delta-source — riskOf reads the landing files when the landing check compared the current head against the live base tip, else the scope files, else the observed file list, and Work carries risk without src/model/work.ts naming it', async () => {
  // Landing check against the live tip: the three-way result decides (docs only → normal).
  assert.deepEqual(riskOf(base()), { risk: 'normal', reasons: [], source: 'landing' });
  // The landing check judged another base than the live tip: the scope files decide.
  const stale = base({ observation: { ...base().observation!, landing: { base: 'tip1', files: base().observation!.landing!.files } } });
  assert.deepEqual(riskOf(stale), { risk: 'sensitive', reasons: ['src/install/host.ts: installation'], source: 'scope' });
  // A landing check without files (same tree as the bound base) falls through to the scope files.
  const sameTree = base({ observation: { ...base().observation!, landing: { base: 'tip2' } } });
  assert.equal(riskOf(sameTree).source, 'scope');
  // The observation is of another head than the current candidate: its landing check judged that head, not this one.
  const moved = base({ candidate: { sha: 'head2', baseSha: 'bound1', pr: 7 } as Work['candidate'] });
  assert.equal(riskOf(moved).source, 'scope');
  // No scope files at all: the observed file list.
  const plain = base({ observation: { ...base().observation!, landing: undefined, scopeFiles: undefined } });
  assert.deepEqual(riskOf(plain), { risk: 'normal', reasons: [], source: 'files' });
  assert.deepEqual(riskDelta(plain).files, [{ path: 'src/model/policy.ts' }]);
  // An empty scope list is an unseen delta, and so is no observation.
  assert.deepEqual(riskOf(base({ observation: { ...base().observation!, landing: undefined, scopeFiles: [] } })), { risk: 'sensitive', reasons: [unknownChangeReason], source: 'scope' });
  assert.deepEqual(riskOf({ candidate: null, observation: null }), { risk: 'sensitive', reasons: [unknownChangeReason], source: 'none' });
  // The rename in a landing check is judged at both ends there too.
  const renamed = base({ observation: { ...base().observation!, landing: { base: 'tip2', files: [{ path: 'src/model/x.ts', previousPath: 'src/store/x.ts', status: 'renamed', sha: 'c', additions: 0, deletions: 0, binary: false }] } } });
  assert.deepEqual(riskOf(renamed).reasons, ['src/store/x.ts: persistence layer']);
  // The Work type carries `risk` by declaration merging from risk-class.ts; work.ts itself never names it.
  const typed: Partial<Work> = { risk: 'normal' };
  assert.equal(typed.risk, 'normal');
  assert.doesNotMatch(await read('src/model/work.ts'), /\brisk\??:/, 'work.ts declares no risk field');
  assert.match(await read('src/model/risk-class.ts'), /declare module '\.\/work\.js'/);
});

const fixture = () => (fixtureWork() as Work[]).map(live) as Work[];
function dashboard(work: Work[], role = 'admin'): Dashboard {
  const noop = () => {};
  const d: Dashboard = {
    token: 'fixture', work, status: fixtureStatus(role), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: unknownFeatures, events: fixtureApi('events') as any[], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, role), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
  } as Dashboard;
  return { ...d, board: boardFromStatus(d.work, d.observedAt, d.status) };
}

test('unit:risk-class-shown — graphyard status GY-N prints risk, its reasons and its source right after lane, and the item page shows Risk with its reasons beside Lane, both computed on read', async () => {
  const status = workCommands.find(command => command.name === 'status')!;
  const printed: any[] = [];
  const context = { api: async (path: string) => { if (path === 'retro/standing') throw Object.assign(new Error('not found'), { status: 404 }); throw new Error(`unexpected ${path}`); }, print: (value: unknown) => { printed.push(value); } } as unknown as CliContext;
  const item = { key: 'GY-1', stage: 'build', ...base(), gates: [], lane: 'medium', speedTarget: 1 } as unknown as Work;
  await status.run(context, item);
  assert.equal(printed.length, 1);
  const keys = Object.keys(printed[0]);
  assert.deepEqual(keys.slice(keys.indexOf('lane'), keys.indexOf('lane') + 4), ['lane', 'risk', 'riskReasons', 'riskSource'], 'risk reads right after lane');
  assert.deepEqual([printed[0].lane, printed[0].risk, printed[0].riskReasons, printed[0].riskSource], ['medium', 'normal', [], 'landing']);
  assert.equal('risk' in item, false, 'the record itself is never stamped: the class is computed on the read');
  const sensitive = withRisk({ ...item, observation: { ...item.observation!, landing: undefined } });
  assert.deepEqual([sensitive.risk, sensitive.riskReasons], ['sensitive', ['src/install/host.ts: installation']]);
  // An item whose record holds no lane still prints the class, after the record's keys.
  const laneless = withRisk({ candidate: null, observation: null });
  assert.deepEqual(Object.keys(laneless), ['candidate', 'observation', 'risk', 'riskReasons', 'riskSource']);
  assert.equal(laneless.risk, 'sensitive');

  // The item page: the Pull request facts carry Lane and Risk side by side, with the reasons.
  const work = fixture();
  const page = work.find(entry => entry.candidate && entry.observation)!;
  const shown = { ...page, lane: 'high', observation: { ...page.observation!, landing: undefined, scopeFiles: [{ path: 'src/store/tables/work.ts', status: 'modified', sha: 'a', additions: 1, deletions: 0, binary: false }] } } as Work;
  const html = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard(work), item: shown }));
  assert.match(html, /<dt>Lane<\/dt><dd class="lane-details">high<\/dd>/);
  assert.match(html, /<dt>Risk<\/dt><dd class="risk-details">sensitive<small> · src\/store\/tables\/work\.ts: persistence layer<\/small><\/dd>/);
  assert.ok(html.indexOf('<dt>Lane</dt>') < html.indexOf('<dt>Risk</dt>') && html.indexOf('<dt>Risk</dt>') - html.indexOf('<dt>Lane</dt>') < 200, 'Risk sits right beside Lane');
  const normal = { ...shown, observation: { ...shown.observation!, scopeFiles: [{ path: 'docs/dashboard.md', status: 'modified', sha: 'a', additions: 1, deletions: 0, binary: false }] } } as Work;
  assert.match(renderToStaticMarkup(createElement(WorkDetails, { ...dashboard(work), item: normal })), /<dt>Risk<\/dt><dd class="risk-details">normal<small> · no sensitive path in the merge delta<\/small><\/dd>/);
});

test('unit:landability-verdict — the risk class reads beside the lane and gates nothing: gates, landability and lane rework never import it, and the verdict suites stand unmodified', async () => {
  for (const file of ['src/model/gates.ts', 'src/model/landability.ts', 'src/server/lane-rework.ts', 'src/model/policy.ts']) {
    const source = await read(file);
    assert.doesNotMatch(source, /risk-class/, `${file} does not read the risk class`);
  }
  for (const file of ['tests/landability-verdict.test.ts', 'tests/regression-guard.test.ts']) assert.doesNotMatch(await read(file), /risk-class|classifyRisk/, `${file} is untouched by GY-1521`);
  // The gate evaluation reports the lane and never a risk class: the class is a read, not a verdict.
  assert.doesNotMatch(await read('src/model/gates.ts'), /riskOf|classifyRisk|withRisk/);
});

/** The file list a merge applied to its first parent, as `git diff-tree -M` names it: both ends of a rename. */
function mergeFiles(merge: string): { path: string; previousPath?: string }[] {
  const lines = git(['diff-tree', '-r', '-M', '--name-status', '-z', `${merge}^1`, merge]).split('\0').filter(Boolean);
  const files: { path: string; previousPath?: string }[] = [];
  for (let i = 0; i < lines.length;) {
    const status = lines[i++];
    if (status.startsWith('R') || status.startsWith('C')) { files.push({ previousPath: lines[i++], path: lines[i++] }); }
    else files.push({ path: lines[i++] });
  }
  return files;
}

const sampleSize = 50;
const commitPresent = (rev: string) => { try { git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]); return true; } catch { return false; } };
const newestMerges = () => git(['log', '--first-parent', '--merges', `-${sampleSize}`, '--format=%H']).split('\n').filter(Boolean);
/** The sample is whole when it holds the newest 50 first-parent merges and the oldest one's first parent, so every diff is real. */
const sampleWhole = (merges: string[]) => merges.length === sampleSize && commitPresent(`${merges[sampleSize - 1]}^1`);

/**
 * Deepens a shallow checkout's history from origin by `commits` commits past its shallow boundary.
 * CI checks a pull request out two commits deep (.github/workflows/ci.yml), which holds only the
 * synthetic merge onto the base: the sample must never shrink to that. The fetch names the head's
 * own commit (GitHub serves every reachable commit; the checkout keeps its credentials) and falls
 * back to the remote refs the checkout tracks for it, never the remote's whole branch list.
 */
function deepen(commits: number): void {
  const head = git(['rev-parse', 'HEAD']);
  const refs = git(['for-each-ref', '--points-at', head, '--format=%(refname)', 'refs/remotes/']).split('\n').filter(Boolean)
    .map(ref => ref.replace(/^refs\/remotes\/origin\//, 'refs/heads/').replace(/^refs\/remotes\/pull\//, 'refs/pull/'));
  const errors: string[] = [];
  for (const want of [head, ...refs]) {
    try { git(['fetch', '--quiet', '--no-tags', `--deepen=${commits}`, 'origin', want]); return; }
    catch (error) { errors.push(`${want}: ${String((error as { stderr?: string }).stderr ?? (error as Error).message).trim()}`); }
  }
  throw new Error(`the shallow checkout cannot be deepened from origin: ${errors.join('; ')}`);
}

/** The newest 50 first-parent merges of this repository, deepening a shallow checkout until it holds them and their parents. */
function repositorySample(): string[] {
  let merges = newestMerges();
  for (let round = 0; !sampleWhole(merges) && round < 10 && git(['rev-parse', '--is-shallow-repository']) === 'true'; round++) {
    deepen(100);
    merges = newestMerges();
  }
  return merges;
}

test('unit:risk-class-repository-sample — the newest 50 first-parent merges of this repository: every merge touching src/store/ or src/install/ is sensitive, every docs-only merge is normal, and every sensitive verdict names a file of the merge', () => {
  const merges = repositorySample();
  assert.equal(merges.length, sampleSize, `the sample is exactly the newest ${sampleSize} first-parent merges (${merges.length} found; a shallow checkout is deepened, never sampled short)`);
  assert.ok(commitPresent(`${merges[sampleSize - 1]}^1`), `the first parent of the oldest sampled merge ${merges[sampleSize - 1].slice(0, 12)} is present, so its delta is the real one`);
  const sample = merges.map(merge => ({ merge, files: mergeFiles(merge), verdict: classifyRisk(mergeFiles(merge)) }));
  const paths = (entry: typeof sample[number]) => deltaPaths(entry.files);
  for (const entry of sample) {
    const touched = paths(entry);
    if (touched.some(path => /^src\/(store|install)\//.test(path))) assert.equal(entry.verdict.risk, 'sensitive', `${entry.merge.slice(0, 12)} touches src/store/ or src/install/: ${touched.join(', ')}`);
    if (touched.length && touched.every(path => path.startsWith('docs/'))) assert.deepEqual(entry.verdict, { risk: 'normal', reasons: [] }, `${entry.merge.slice(0, 12)} is docs-only: ${touched.join(', ')}`);
    if (!touched.length) assert.deepEqual(entry.verdict.reasons, [unknownChangeReason], `${entry.merge.slice(0, 12)} applied no file`);
    for (const reason of entry.verdict.reasons) if (reason !== unknownChangeReason) assert.ok(touched.some(path => reason.startsWith(`${path}: `)), `${entry.merge.slice(0, 12)}: ${reason} names a file of the merge`);
  }
  const counts = {
    sensitive: sample.filter(entry => entry.verdict.risk === 'sensitive').length, normal: sample.filter(entry => entry.verdict.risk === 'normal').length,
    storeOrInstall: sample.filter(entry => paths(entry).some(path => /^src\/(store|install)\//.test(path))).length,
    docsOnly: sample.filter(entry => paths(entry).length > 0 && paths(entry).every(path => path.startsWith('docs/'))).length,
  };
  // The sensitive implication is exercised by the sample itself, not vacuously: this repository
  // merges a store or install change every few merges. Docs-only merges are rarer, so their count
  // is reported rather than required.
  assert.ok(counts.storeOrInstall >= 1, `the newest ${sampleSize} merges include a merge touching src/store/ or src/install/`);
  console.log(`unit:risk-class-repository-sample: ${sample.length} merges, ${counts.sensitive} sensitive, ${counts.normal} normal, ${counts.storeOrInstall} touching src/store/ or src/install/, ${counts.docsOnly} docs-only`);
});
