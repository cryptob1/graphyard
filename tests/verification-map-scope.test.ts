import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { automaticScopeGrounds, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { ScopeRequestState } from '../src/model/scope.js';
import type { Work } from '../src/model.js';

// GY-1783: on 2026-10-14T04:56Z GY-1776's worker asked for tests/loop-self-upgrade.test.ts and
// verification/master.md. The loop grounded the test (it imports the planned src/master/release-lag.ts)
// but had no ground for the map, so the whole ask went to the approver's 15-minute route. A
// verification map opens with a Paths: line naming the globs it covers and lists the area's test
// files under ## Tests, so an item that changes a planned file under those paths must edit the map:
// it is a companion, granted like the test that imports the planned file.

const clock = Date.parse('2026-10-14T05:00:00Z');
const masterMap = [
  'Paths: src/master/**, src/master.ts, src/reviewer.ts',
  '',
  '## Tests',
  '',
  '- `tests/master.test.ts`, `tests/master-daemon.test.ts`.',
  '',
  '## Drive',
  '',
  '`node bin/graphyard.mjs master status` reads the loop\'s view.',
  '',
  '## Invariants',
  '',
  '- A launched session\'s request is its first message on the runtime\'s command line, never a paste.',
  '',
  '## Gotchas',
  '',
  '- `src/master.ts` only re-exports; add code to the module that owns the concern.',
].join('\n');
/** The base tree when GY-1776 asked. */
const base: Record<string, string> = {
  'verification/master.md': masterMap,
  'verification/store.md': masterMap.replace(/^Paths:.*$/m, 'Paths: src/store/**, src/store.ts, src/engine.ts'),
  'src/master/release-lag.ts': 'export function releaseLag() { return 0; }',
  'src/daemon/run.ts': 'export async function run() {}',
  'src/master.ts': "export { releaseLag } from './master/release-lag.js';",
  'tests/loop-self-upgrade.test.ts': "import { releaseLag } from '../src/master/release-lag.js';\ntest('lag', () => releaseLag());",
  'tests/store-locks.test.ts': "import { locks } from '../src/store/locks.js';\ntest('locks', () => locks());",
};
const read = async (path: string) => base[path] ?? null;
const exists = (path: string) => path in base;
const ask = (paths: string[]): ScopeRequestState => ({ epoch: 1, paths, reason: 'the map names the new test file for the area', requestedBy: 'graphyard-worker', at: '2026-10-14T04:56:00.000Z' });
const grounds = (work: Work, paths: string[], tree: Record<string, string> = base) => automaticScopeGrounds(work, ask(paths), paths, [], path => path in tree, async path => tree[path] ?? null, async () => [], async () => Infinity, async () => Infinity);

function item(plannedFiles: string[], extra: Partial<Work> = {}): Work {
  return {
    id: '00000000-0000-4000-8000-000000001776', key: 'GY-1776', title: 'GY-1776', description: '', type: 'bug', priority: 2, dependencies: [],
    // No criterion names the test file: the loop grounds it on its import, as it did for GY-1776.
    criteria: [{ id: 'AC-1', text: 'The loop upgrades itself when the served release lags the base', proofs: ['unit:release-lag-upgrade'] }],
    policy: { checks: ['test'], review: true }, plannedFiles, stage: 'build', revision: 3, policyRevision: 1,
    createdAt: '2026-10-14T04:00:00.000Z', updatedAt: '2026-10-14T04:56:00.000Z', stageEnteredAt: '2026-10-14T04:00:00.000Z', ready: true, epoch: 1, lease: null,
    workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    violations: [], gates: [], exclusiveResources: [], producerProofs: [], ...extra,
  } as unknown as Work;
}
const masterItem = () => item(['src/master/release-lag.ts', 'tests/loop-self-upgrade.test.ts']);
const daemonItem = () => item(['src/daemon/run.ts', 'tests/loop-self-upgrade.test.ts']);
const mapGround = "verification/master.md is the verification map whose Paths: src/master/**, src/master.ts, src/reviewer.ts covers src/master/release-lag.ts, a planned file whose behaviour the item changes";

test('unit:verification-map-companion — the map whose Paths line covers a planned file is granted by the loop\'s scope step as a companion naming that file and the line; a map covering none of the planned files is refused and routed as before', async () => {
  // Imported inside the case so a base without the rule fails this case, not the file (graphyard verify's exercise).
  const { verificationMapGround } = await import('../src/model/scope-companions.js');
  const granted = await grounds(masterItem(), ['verification/master.md']);
  assert.ok(!('refusal' in granted), 'refusal' in granted ? granted.refusal : '');
  assert.deepEqual(granted.grounds, [{ path: 'verification/master.md', ground: mapGround, companion: true }]);

  // The same ask on an item planning only src/daemon/run.ts: no planned file under src/master/**.
  const refused = await grounds(daemonItem(), ['verification/master.md']);
  assert.ok('refusal' in refused && !refused.grounds?.length, 'still the approver\'s');
  assert.match(refused.refusal, /no unresolved review finding on the head names verification\/master\.md/);

  // A map whose paths cover nothing planned stays refused beside the one that is granted: each path is judged on its own.
  const mixed = await grounds(masterItem(), ['verification/master.md', 'verification/store.md']);
  assert.deepEqual(mixed.grounds?.map(entry => entry.path), ['verification/master.md']);
  assert.ok('refusal' in mixed && /verification\/store\.md/.test(mixed.refusal) && !/master\.md/.test(mixed.refusal), 'refusal' in mixed ? mixed.refusal : '');

  // The ground itself: a planned directory scope under the glob, a planned file above it, a map the base lacks or one with no Paths line.
  assert.equal(verificationMapGround('verification/master.md', masterMap, { plannedFiles: ['src/master/'], criteria: [] }), mapGround.replace('src/master/release-lag.ts', 'src/master/'));
  assert.equal(verificationMapGround('verification/master.md', masterMap, { plannedFiles: ['src/'], criteria: [] }), mapGround.replace('src/master/release-lag.ts', 'src/'), 'a planned scope that holds the glob');
  assert.equal(verificationMapGround('verification/master.md', masterMap, { plannedFiles: ['src/reviewer.ts'], criteria: [] }), mapGround.replace('src/master/release-lag.ts', 'src/reviewer.ts'), 'a file glob');
  // Review of 8aac4bbf: a `./`-prefixed glob, which verificationGlobCovers strips, covers a planned scope that holds it
  // exactly as the bare glob does, so the loop grants the map it selects instead of refusing and routing it.
  const dottedMap = masterMap.replace(/^Paths:.*$/m, 'Paths: ./src/master/**, ./src/master.ts');
  const dottedGround = 'verification/master.md is the verification map whose Paths: ./src/master/**, ./src/master.ts covers src/, a planned file whose behaviour the item changes';
  assert.equal(verificationMapGround('verification/master.md', dottedMap, { plannedFiles: ['src/'], criteria: [] }), dottedGround, 'a ./ glob under a planned scope');
  assert.equal(verificationMapGround('verification/master.md', dottedMap, { plannedFiles: ['./src/'], criteria: [] }), dottedGround.replace('covers src/', 'covers ./src/'), 'a ./ glob under a ./ planned scope');
  assert.equal(verificationMapGround('verification/master.md', dottedMap, { plannedFiles: ['src/master/release-lag.ts'], criteria: [] }), dottedGround.replace('covers src/', 'covers src/master/release-lag.ts'), 'a ./ glob over a planned file');
  assert.equal(verificationMapGround('verification/master.md', dottedMap, { plannedFiles: ['tests/'], criteria: [] }), null, 'a ./ glob outside the planned scope');
  const dotted = await grounds(item(['src/']), ['verification/master.md'], { ...base, 'verification/master.md': dottedMap });
  assert.ok(!('refusal' in dotted), 'refusal' in dotted ? dotted.refusal : '');
  assert.deepEqual(dotted.grounds, [{ path: 'verification/master.md', ground: dottedGround, companion: true }]);
  assert.equal(verificationMapGround('verification/master.md', masterMap, daemonItem()), null, 'covers none of the planned files');
  assert.equal(verificationMapGround('verification/master.md', null, masterItem()), null, 'a map the base does not hold');
  assert.equal(verificationMapGround('verification/master.md', '## Tests\n\n- none', masterItem()), null, 'no Paths line');
  assert.equal(verificationMapGround('verification/', masterMap, masterItem()), null, 'never the tree');
  assert.equal(verificationMapGround('docs/master.md', masterMap, masterItem()), null, 'only a map under verification/');
  // A test the criteria name, or one this request already granted, under the map's paths grounds it too (a map whose Paths name tests).
  const testMap = masterMap.replace(/^Paths:.*$/m, 'Paths: tests/loop-*.test.ts');
  const naming = [{ id: 'AC-2', text: 'The item creates tests/loop-self-upgrade.test.ts holding these tests', proofs: ['unit:loop-self-upgrade'] }];
  assert.equal(verificationMapGround('verification/master.md', testMap, { plannedFiles: ['src/daemon/run.ts'], criteria: naming }), 'verification/master.md is the verification map whose Paths: tests/loop-*.test.ts covers tests/loop-self-upgrade.test.ts, a test file the item creates');
  assert.equal(verificationMapGround('verification/master.md', testMap, { plannedFiles: ['src/daemon/run.ts'], criteria: [] }, ['tests/loop-self-upgrade.test.ts']), 'verification/master.md is the verification map whose Paths: tests/loop-*.test.ts covers tests/loop-self-upgrade.test.ts, a test file this request grants');
  assert.equal(verificationMapGround('verification/master.md', testMap, { plannedFiles: ['src/daemon/run.ts'], criteria: [] }, ['src/daemon/loop-x.ts']), null, 'only a test file');
  assert.equal(verificationMapGround('verification/master.md', testMap, { plannedFiles: ['src/daemon/run.ts'], criteria: [] }), null, 'nothing granted, nothing named: the raw ask grounds no map');

  // Review of 4a6bb1bb: the ask alone never grounds a map. On an item planning only src/daemon/run.ts, a map whose
  // Paths cover tests/loop-*.test.ts asked beside tests/loop-self-upgrade.test.ts (no criterion names the test, it
  // imports nothing planned) is refused with the test, so pairing an arbitrary test path with a map buys no scope.
  const testTree = { ...base, 'verification/master.md': testMap };
  const paired = await grounds(item(['src/daemon/run.ts']), ['tests/loop-self-upgrade.test.ts', 'verification/master.md'], testTree);
  assert.ok('refusal' in paired && !paired.grounds?.length, 'refusal' in paired ? paired.refusal : 'granted');
  assert.match(paired.refusal, /tests\/loop-self-upgrade\.test\.ts/);
  assert.match(paired.refusal, /verification\/master\.md/);
  // The same pair on the item planning src/master/release-lag.ts: the test is granted on its import, and the map on that granted test.
  const chained = await grounds(item(['src/master/release-lag.ts']), ['verification/master.md', 'tests/loop-self-upgrade.test.ts'], testTree);
  assert.ok(!('refusal' in chained), 'refusal' in chained ? chained.refusal : '');
  assert.deepEqual(chained.grounds, [
    { path: 'tests/loop-self-upgrade.test.ts', ground: 'tests/loop-self-upgrade.test.ts imports src/master/release-lag.ts, a planned file whose behaviour the item changes', companion: true },
    { path: 'verification/master.md', ground: 'verification/master.md is the verification map whose Paths: tests/loop-*.test.ts covers tests/loop-self-upgrade.test.ts, a test file this request grants', companion: true },
  ], 'the map is judged after the test, whatever order the ask named them in');

  // Review of d8e550a6: a gate the engine grants as the companion of a test in the raw ask (GY-1706's wall-clock gate,
  // the timing baseline, the docs-budget gate) is no ground for a map. On an item planning only src/daemon/run.ts, an
  // ask naming an unrelated test, the wall-clock gate and a map whose Paths cover tests/** grants the gate on the ask as
  // GY-1706 does, but the map is refused with the test: a refused test reaches no map through the gate it drags in.
  const gateMap = masterMap.replace(/^Paths:.*$/m, 'Paths: tests/**');
  const gateTree = { ...base, 'verification/gates.md': gateMap, 'tests/no-wall-clock-time-bombs.test.ts': "test('gate', () => {});" };
  const gated = await grounds(item(['src/daemon/run.ts']), ['tests/loop-self-upgrade.test.ts', 'tests/no-wall-clock-time-bombs.test.ts', 'verification/gates.md'], gateTree);
  assert.ok('refusal' in gated, 'the test and the map stay refused');
  assert.deepEqual(gated.grounds?.map(entry => entry.path), ['tests/no-wall-clock-time-bombs.test.ts'], 'only the gate, on the ask, as before this item');
  assert.match(gated.refusal, /tests\/loop-self-upgrade\.test\.ts/);
  assert.match(gated.refusal, /verification\/gates\.md/);
  for (const gate of ['tests/no-wall-clock-time-bombs.test.ts', 'tests/helpers/timing-baseline.json', 'tests/docs-budget.test.ts'])
    assert.equal(verificationMapGround('verification/gates.md', gateMap, { plannedFiles: ['src/daemon/run.ts'], criteria: [] }, [gate]), null, `${gate} grounds no map`);
  // The same ask on the item planning src/master/release-lag.ts: the test is granted on its import, the gate on the
  // test, and the map on the granted test, never on the gate.
  const gatedChain = await grounds(item(['src/master/release-lag.ts']), ['verification/gates.md', 'tests/no-wall-clock-time-bombs.test.ts', 'tests/loop-self-upgrade.test.ts'], gateTree);
  assert.ok(!('refusal' in gatedChain), 'refusal' in gatedChain ? gatedChain.refusal : '');
  assert.deepEqual(gatedChain.grounds.map(entry => entry.path), ['tests/no-wall-clock-time-bombs.test.ts', 'tests/loop-self-upgrade.test.ts', 'verification/gates.md']);
  assert.equal(gatedChain.grounds[2].ground, 'verification/gates.md is the verification map whose Paths: tests/** covers tests/loop-self-upgrade.test.ts, a test file this request grants');
  // A map the base holds malformed — a Paths line over a planned file, but no Drive, Invariants or Gotchas — is one
  // parseVerificationMap rejects and no session is ever shown, so the loop routes it instead of granting it.
  const partial = await grounds(masterItem(), ['verification/master.md'], { ...base, 'verification/master.md': 'Paths: src/master/**\n\n## Tests\n\n- none\n' });
  assert.ok('refusal' in partial && !partial.grounds?.length, 'refusal' in partial ? partial.refusal : 'granted');
  assert.match(partial.refusal, /verification\/master\.md/);
  // The supported ./ spelling of the map is the same file, classified and grounded as the bare one.
  assert.equal(verificationMapGround('./verification/master.md', masterMap, masterItem()), mapGround.replace(/^verification/, './verification'));

  // The checked-in map covers this repository's src/master/release-lag.ts as the fixture says.
  assert.equal(verificationMapGround('verification/master.md', readFileSync(new URL('../verification/master.md', import.meta.url), 'utf8'), masterItem()), mapGround);
});

test('unit:verification-map-with-importing-test — the ask GY-1776 made, the map beside the test importing a planned file, is granted whole, and the loop widens by both with no approver', async () => {
  const paths = ['tests/loop-self-upgrade.test.ts', 'verification/master.md'];
  const work = item(['src/master/release-lag.ts']);
  const scoped = await grounds(work, paths);
  assert.ok(!('refusal' in scoped), 'refusal' in scoped ? scoped.refusal : '');
  assert.deepEqual(scoped.grounds, [
    { path: 'tests/loop-self-upgrade.test.ts', ground: 'tests/loop-self-upgrade.test.ts imports src/master/release-lag.ts, a planned file whose behaviour the item changes', companion: true },
    { path: 'verification/master.md', ground: mapGround, companion: true },
  ]);
  // On the item planning only src/daemon/run.ts the test is refused as well as the map: nothing it imports is planned.
  const unrelated = await grounds(item(['src/daemon/run.ts']), paths);
  assert.ok('refusal' in unrelated && !unrelated.grounds?.length, 'refusal' in unrelated ? unrelated.refusal : 'granted');

  // The loop's scope step widens the refused ask by both paths, audited as companions, and routes nothing.
  const lease = { epoch: 1, owner: 'graphyard-worker', expiresAt: new Date(clock + 600_000).toISOString() };
  const refused: ScopeRequestState = { ...ask(paths), decision: { state: 'refused', reason: 'outside what the criteria imply', at: '2026-10-14T04:56:01.000Z', decidedBy: 'graphyard', waitedMs: 1000, paths, requestedBy: 'graphyard-worker', requestedAt: '2026-10-14T04:56:00.000Z', epoch: 1 } } as ScopeRequestState;
  const widened: { paths: string[]; reason: string }[] = [];
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/nonexistent/verification-map-scope.token', cliPath: 'bin/graphyard.mjs',
    repository: 'owner/verification-map-scope', baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-maps', workers: [] }) as MasterConfig;
  const state = emptyDaemonState(config);
  await runCycle(config, state, {
    agents: () => [], credentials: async () => ({}),
    snapshot: async () => ({ work: [{ ...work, lease, scopeRequest: refused } as Work], now: new Date(clock).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'no deployment in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    basePaths: async (asked: readonly string[]) => new Set(asked.filter(exists)), baseText: read, baseMentions: async () => Infinity,
    widenScope: async (item: Work, _request: unknown, added: string[], reason: string) => { widened.push({ paths: added, reason }); return { ...item, plannedFiles: [...(item.plannedFiles ?? []), ...added], policyRevision: item.policyRevision + 1 }; },
  } as unknown as DaemonEffects, () => clock);
  assert.deepEqual(widened.map(entry => entry.paths), [paths]);
  assert.match(widened[0].reason, /a companion the change inevitably carries/);
  assert.match(widened[0].reason, /verification\/master\.md is the verification map whose Paths: src\/master\/\*\*/);
  const actions = Object.values(state.actions).filter(action => action.work === 'GY-1776');
  assert.ok(actions.some(action => /^Widened /.test(action.detail) && /the verification map whose Paths cover a planned file/.test(action.detail)), JSON.stringify(actions.map(action => action.detail)));
  assert.ok(!actions.some(action => /^Partly widened |approver/i.test(action.detail) && !/^Widened /.test(action.detail)), JSON.stringify(actions.map(action => action.detail)));
  assert.ok(!actions.some(action => action.state === 'failed'), JSON.stringify(actions.filter(action => action.state === 'failed')));
});
