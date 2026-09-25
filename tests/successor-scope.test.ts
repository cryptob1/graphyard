import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticScopeGrounds, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { ScopeRequestState } from '../src/model/scope.js';
import { parseSuccessions, successorGround, successorsOf, successorWidening } from '../src/model/successors.js';
import { basePaths, baseSuccessions, successionReader } from '../src/review-scope.js';
import type { ChildRun } from '../src/child-runner.js';
import type { Work } from '../src/model.js';

// GY-394: GY-177 split src/master-daemon.ts into src/daemon/*, and every open item that planned the
// old file found the code it plans to change outside its scope. A request for the successor files
// was refused as intent no criterion implies and waited for a human master. The base branch's own
// history says which files succeed which, so the loop grants them on that ground and re-plans the
// open items onto them. Each test is named for the proof it produces.

const clock = Date.parse('2030-01-03T12:00:00Z');
const iso = (at: string) => new Date(at).toISOString();
let scratch: string, origin: string, root: string, split: string, trailered: string;
const git = (cwd: string, args: string[], date = '2030-01-01T00:00:00Z') => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
const run: ChildRun = async (command, args) => execFileSync(command, args, { encoding: 'utf8' });
const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `export function f${from + index}() { return ${from + index} * 2 + 1; }\n`).join('');

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'graphyard-successor-scope-'));
  origin = join(scratch, 'origin.git'); root = join(scratch, 'loop'); const work = join(scratch, 'work');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, work]);
  git(work, ['checkout', '--quiet', '-b', 'main']);
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src/big.ts'), lines(1, 40));
  await writeFile(join(work, 'src/other.ts'), 'export const other = 1;\n');
  await writeFile(join(work, 'src/old-name.ts'), 'export const legacy = true;\n');
  git(work, ['add', '-A']); git(work, ['commit', '--quiet', '-m', 'Plan the big file'], '2030-01-01T00:00:00Z');
  // The split: src/big.ts becomes src/big/a.ts and src/big/b.ts, which git reports as a copy and a rename.
  await mkdir(join(work, 'src/big'), { recursive: true });
  await writeFile(join(work, 'src/big/a.ts'), lines(1, 20));
  await writeFile(join(work, 'src/big/b.ts'), lines(21, 40));
  git(work, ['rm', '--quiet', 'src/big.ts']);
  await writeFile(join(work, 'src/other.ts'), 'export const other = 2;\n');
  git(work, ['add', '-A']); git(work, ['commit', '--quiet', '-m', 'Split src/big.ts'], '2030-01-02T00:00:00Z');
  split = git(work, ['rev-parse', 'HEAD']).trim();
  // A rewrite git cannot detect, whose commit records its successor map instead.
  git(work, ['rm', '--quiet', 'src/old-name.ts']);
  await writeFile(join(work, 'src/new-name.ts'), 'export default function current() { return "rewritten from scratch"; }\n');
  git(work, ['add', '-A']); git(work, ['commit', '--quiet', '-m', 'Rewrite the legacy module', '-m', 'Graphyard-Successor: src/old-name.ts -> src/new-name.ts'], '2030-01-02T06:00:00Z');
  trailered = git(work, ['rev-parse', 'HEAD']).trim();
  git(work, ['push', '--quiet', 'origin', 'main']);
  execFileSync('git', ['clone', '--quiet', origin, root]);
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

const loopConfig = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(tmpdir(), 'successor-scope-coordinator.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository: 'owner/successor-scope', baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-successor', workers: [] }) as MasterConfig;

function item(key: string, plannedFiles: string[], extra: Partial<Work> = {}): Work {
  return {
    id: `00000000-0000-4000-8000-${key.replace(/\D/g, '').padStart(12, '0')}`, key, title: `${key} changes the big module`, description: '', type: 'task', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'The big module keeps working', proofs: ['unit:big'] }], policy: { checks: ['test'], review: true },
    plannedFiles, stage: 'build', revision: 3, policyRevision: 1, createdAt: iso('2030-01-01T12:00:00Z'), updatedAt: iso('2030-01-03T00:00:00Z'),
    stageEnteredAt: iso('2030-01-03T00:00:00Z'), ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], exclusiveResources: [], producerProofs: [],
    ...extra,
  } as unknown as Work;
}

const loopEffects = (work: () => Work[], overrides: Partial<DaemonEffects>): DaemonEffects => ({
  agents: () => [], credentials: async () => ({}),
  snapshot: async () => ({ work: work(), now: new Date(clock).toISOString() }),
  closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
  observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(clock).toISOString(), reason: 'no deployment in this test', deployed: [], pending: [] }),
  recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  ...overrides,
} as DaemonEffects);

test('unit:successor-scope-granted — a request for a file main split a planned file into is granted with its successor ground and audited; an unrelated file is still refused', async () => {
  // What git reports on the base since the item was planned: a copy and a rename out of src/big.ts.
  const read = await baseSuccessions(root, 'main', iso('2030-01-01T12:00:00Z'), run);
  const successors = successorsOf(['src/big.ts'], read.successions).filter(entry => read.files.has(entry.path));
  assert.deepEqual(successors.map(entry => entry.path).sort(), ['src/big/a.ts', 'src/big/b.ts']);
  assert.ok(successors.every(entry => entry.of === 'src/big.ts' && entry.commit === split));
  assert.equal(successorGround(successors[0]), `successor of src/big.ts via ${split.slice(0, 12)}`);
  // A file planned after the split has no successor: nothing was split out of it since.
  assert.deepEqual(successorsOf(['src/big.ts'], (await baseSuccessions(root, 'main', iso('2030-01-02T12:00:00Z'), run)).successions), []);

  // The grounds rule itself: the successor is granted on that ground, the unrelated file is not.
  const planned = item('GY-1', ['src/big.ts']);
  const request: ScopeRequestState = { epoch: 1, paths: ['src/big/a.ts'], reason: 'The code moved', requestedBy: 'worker', at: iso('2030-01-03T11:00:00Z') };
  const exists = (path: string) => ['src/big/a.ts', 'src/big/b.ts', 'src/other.ts'].includes(path);
  const lookup = async () => successors;
  assert.deepEqual(await automaticScopeGrounds(planned, request, ['src/big/a.ts'], [], exists, undefined, lookup),
    { grounds: [{ path: 'src/big/a.ts', ground: `successor of src/big.ts via ${split.slice(0, 12)}` }] });
  assert.ok('refusal' in await automaticScopeGrounds(planned, { ...request, paths: ['src/other.ts'] }, ['src/other.ts'], [], exists, undefined, lookup), 'an unrelated file is still refused');

  // Through the loop: a request the implication rule refused is widened by the master's own
  // audited revision, naming the ground; one for an unrelated file is not widened.
  const lease = { epoch: 1, owner: 'worker', expiresAt: new Date(clock + 600_000).toISOString() };
  const refused = (paths: string[]) => ({ epoch: 1, paths, reason: 'GY-177 moved the code this item changes', requestedBy: 'worker', at: iso('2030-01-03T11:00:00Z'),
    decision: { state: 'refused', reason: 'outside what the criteria imply', at: iso('2030-01-03T11:00:01Z'), decidedBy: 'graphyard', waitedMs: 1000, paths, requestedBy: 'worker', requestedAt: iso('2030-01-03T11:00:00Z'), epoch: 1 } });
  const successor = item('GY-2', ['src/big.ts'], { lease, scopeRequest: refused(['src/big/a.ts']) } as Partial<Work>);
  const unrelated = item('GY-3', ['src/big.ts'], { lease, scopeRequest: refused(['src/other.ts']) } as Partial<Work>);
  const widened: { key: string; paths: string[]; reason: string }[] = [];
  const state = emptyDaemonState(loopConfig());
  await runCycle(loopConfig(), state, loopEffects(() => [successor, unrelated], {
    basePaths: paths => basePaths(root, 'main', paths, run), baseSuccessions: successionReader(root, 'main', run),
    widenScope: async (work, _request, paths, reason) => { widened.push({ key: work.key, paths, reason }); return work; },
  }), () => clock);
  assert.deepEqual(widened.map(entry => [entry.key, entry.paths]), [['GY-2', ['src/big/a.ts']]], 'only the successor is widened');
  assert.match(widened[0].reason, new RegExp(`src/big/a\\.ts \\(successor of src/big\\.ts via ${split.slice(0, 12)}\\)`), widened[0].reason);
  const audited = Object.values(state.actions).find(action => action.work === 'GY-2' && /^Widened /.test(action.detail));
  assert.ok(audited?.detail.includes(`successor of src/big.ts via ${split.slice(0, 12)}`), audited?.detail);
  const refusal = Object.values(state.actions).find(action => action.work === 'GY-3' && /^Not widened/.test(action.detail));
  assert.ok(refusal, 'the unrelated request stays refused, for the approver');
});

test('unit:split-replans-open-items — after a split merges, an open item planning the old file carries its successors without a scope request', async () => {
  const items = new Map<string, Work>([
    ['GY-10', item('GY-10', ['src/big.ts', 'docs/guide.md'])],
    ['GY-11', item('GY-11', ['src/other.ts'])],
    ['GY-12', item('GY-12', ['src/old-name.ts'])],
    // Planned after the split landed: nothing was split out of the file it names since.
    ['GY-13', item('GY-13', ['src/big.ts'], { createdAt: iso('2030-01-02T12:00:00Z') })],
  ]);
  const replans: { key: string; paths: string[]; reason: string; revision: ReturnType<typeof successorWidening> }[] = [];
  const effects = loopEffects(() => [...items.values()], {
    baseSuccessions: successionReader(root, 'main', run),
    // The audited requirements revision the loop posts as the master: apply it as the control plane would.
    replan: async (work, paths, reason) => {
      const revision = successorWidening(work, paths, reason);
      replans.push({ key: work.key, paths, reason, revision });
      items.set(work.key, { ...work, plannedFiles: revision.plannedFiles, policyRevision: work.policyRevision + 1 });
    },
  });
  const state = emptyDaemonState(loopConfig());
  await runCycle(loopConfig(), state, effects, () => clock);

  assert.deepEqual(replans.map(entry => entry.key).sort(), ['GY-10', 'GY-12'], 'only items planning a split or renamed file are re-planned');
  const big = replans.find(entry => entry.key === 'GY-10')!;
  assert.deepEqual(big.paths.sort(), ['src/big/a.ts', 'src/big/b.ts']);
  assert.deepEqual(items.get('GY-10')!.plannedFiles, ['src/big.ts', 'docs/guide.md', 'src/big/a.ts', 'src/big/b.ts'], 'the successors are added and nothing is removed');
  assert.equal(items.get('GY-10')!.scopeRequest ?? null, null, 'no scope request was needed');
  assert.match(big.reason, new RegExp(`src/big/a\\.ts \\(successor of src/big\\.ts via ${split.slice(0, 12)}\\)`));
  assert.deepEqual({ ...big.revision, plannedFiles: undefined, reason: undefined }, { expectedPolicyRevision: 1, criteria: items.get('GY-10')!.criteria, dependencies: [], exclusiveResources: [], producerProofs: [], plannedFiles: undefined, reason: undefined }, 'criteria, dependencies and containment are carried over unchanged');
  // A successor map a split commit records is a ground too, when git cannot see the rename.
  assert.deepEqual(replans.find(entry => entry.key === 'GY-12')!.paths, ['src/new-name.ts']);
  assert.match(replans.find(entry => entry.key === 'GY-12')!.reason, new RegExp(`successor of src/old-name\\.ts via ${trailered.slice(0, 12)}`));
  const done = Object.values(state.actions).find(action => action.work === 'GY-10' && /^Re-planned /.test(action.detail));
  assert.ok(done?.detail.includes('src/big/a.ts'), 'the re-plan is recorded as the loop\'s action');

  // A re-planned item carries its successors, so the next cycle leaves it alone.
  await runCycle(loopConfig(), state, effects, () => clock);
  assert.equal(replans.length, 2, 'a standing re-plan never churns');
});

test('unit:successor-parse — git renames, copies and a recorded successor map are read; a weak or quoted pair and a malformed trailer are not', () => {
  const log = [
    `\x1e${'a'.repeat(40)}\x1fsrc/x.ts -> src/x/one.ts, src/x/two.ts\x1dnot a map\x1d../escape.ts -> src/y.ts`, '',
    'R050\tsrc/p.ts\tsrc/q.ts', 'C029\tsrc/p.ts\tsrc/weak.ts', 'C100\t"src/sp ace.ts"\tsrc/r.ts', 'M\tsrc/p.ts',
    `\x1e${'b'.repeat(40)}\x1f`, '', 'R100\tsrc/q.ts\tsrc/q2.ts',
  ].join('\n');
  const successions = parseSuccessions(log);
  assert.deepEqual(successions.map(entry => `${entry.from}>${entry.to}`), ['src/x.ts>src/x/one.ts', 'src/x.ts>src/x/two.ts', 'src/p.ts>src/q.ts', 'src/q.ts>src/q2.ts']);
  // A successor of a successor traces back to the planned file; a directory scope has none.
  assert.deepEqual(successorsOf(['src/p.ts', 'src/x/'], successions).map(entry => `${entry.path}<${entry.of}`), ['src/q.ts<src/p.ts', 'src/q2.ts<src/p.ts']);
});
