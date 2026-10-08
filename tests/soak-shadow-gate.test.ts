import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { shadowIdle, shadowKeptVerdicts, shadowReads } from '../src/daemon/cycle-shadow.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1522: the shadow merge gate over many simulated cycles of the real loop step order. Over a
 * day of cycles with items submitted every few minutes, GitHub merging each after a delay, main's
 * tip moving and a coordinator that refuses some posts, the gate runs at most one trial at a time,
 * tries each (head, tip) pair at most once, keeps at most 200 verdicts, raises one attention line
 * per disagreeing item, and never stalls delivery (it only reads).
 */
const minute = 60_000;
const start = Date.parse('2030-03-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the shadow step called GitHub (${String(name)})`); } });

const work = (n: number, submittedAt: number, mergedAt: number, now: number): Work => ({
  id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
  revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(submittedAt), ready: true, epoch: 1, lease: null, workspaces: [],
  submission: { epoch: 1, pr: n }, candidate: { sha: sha(`head${n}`), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  ...(now >= mergedAt ? { stage: 'done', delivery: { mergedAt: iso(mergedAt), mergeSha: sha(`merge${n}`), authorizationRevision: 1 } } : { stage: 'review' }),
}) as unknown as Work;

test('unit:soak-shadow-gate — a simulated day: bounded trials, one verdict per (head, tip), at most 200 kept, one attention line per disagreeing item, delivery unaffected', { timeout: 300_000 }, async () => {
  const cycles = 24 * 60 / 2, items = 150;
  let now = start, tipIndex = 0, failPosts = 0, running = 0, widest = 0;
  const tip = () => sha(`tip${tipIndex}`);
  const trials: string[] = [], posts: string[] = [];
  const git = ((command: string, args: string[]) => {
    assert.equal(command, 'git');
    const [, , sub] = args;
    if (sub === 'rev-parse') return `${tip()}\n`;
    if (sub === 'merge-tree') return `${sha('tree')}\0`;
    if (sub === 'commit-tree') return `${sha(`merge-${args.join(' ')}`)}\n`;
    if (sub === 'diff') return 'src/a.ts\n';
    assert.ok(['fetch', 'update-ref'].includes(sub!), `git ${sub} is not a read or the trial ref`);
    return '';
  }) as never;
  const reads = shadowReads(config, '/coordinator', git, { base: '/w', record: async (item, verdict) => {
    if (failPosts-- > 0) throw new Error('route down');
    posts.push(`${item.key}:${verdict.head}:${verdict.baseTip}`);
  }, trial: async input => {
    running += 1; widest = Math.max(widest, running); trials.push(input.mergeSha);
    await new Promise(resolve => setTimeout(resolve, 1));
    running -= 1;
    // Every seventh trial fails its tests: GitHub merges those anyway, a disagreement.
    return { build: 'pass', tests: { passed: 1, failed: trials.length % 7 === 0 ? ['tests/x.test.ts'] : [], files: 1 }, durationMs: 1000, logTail: '' };
  } });
  const submittedAt = (n: number) => start + n * 7 * minute, mergedAt = (n: number) => submittedAt(n) + 25 * minute;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.from({ length: items }, (_, index) => index + 1).filter(n => submittedAt(n) <= now).map(n => work(n, submittedAt(n), mergedAt(n), now)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: reads } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const raised = new Map<string, number>();
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * 2 * minute;
    if (cycle % 40 === 0) tipIndex += 1;
    if (cycle % 90 < 3) failPosts = 1;
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) if (action.detail.startsWith('Shadow merge gate:')) raised.set(action.work ?? '', (raised.get(action.work ?? '') ?? 0) + 1);
    await shadowIdle(state);
    assert.ok(state.shadow.length <= shadowKeptVerdicts, `cycle ${cycle}: ${state.shadow.length} verdicts kept`);
    assert.ok(widest <= 1, 'one trial at a time');
  }
  assert.ok(trials.length > 20, `the gate made progress: ${trials.length} trials`);
  assert.ok(trials.length <= cycles, 'at most one trial per cycle');
  assert.equal(new Set(posts).size, posts.length, 'each (head, tip) pair was recorded once, however many posts failed along the way');
  assert.ok([...raised.values()].every(count => count === 1), `one attention line per item: ${JSON.stringify([...raised])}`);
  assert.ok(raised.size > 0, 'a disagreement was raised');
  const section = daemonSummary(state, now, config.run.intervalSeconds * 1000, config.hostId).shadowGate;
  assert.equal(section.total, state.shadow.length);
  assert.ok(section.disagreements.length <= 10);
});
