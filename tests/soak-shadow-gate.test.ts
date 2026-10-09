import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { daemonSummary, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { shadowIdle, shadowKeptVerdicts, shadowReads, shadowRunnerRetries, shadowStateSchema } from '../src/daemon/cycle-shadow.js';
import { shadowExplanationPairsMax, trialCauseLength, trialLogTailLength } from '../src/merge-writer/shadow.js';
import { TrialRunnerError } from '../src/merge-writer/trial.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';

/**
 * GY-1522: the shadow merge gate over many simulated cycles of the real loop step order. Over a
 * day of cycles with items submitted every few minutes, GitHub merging each after a delay, main's
 * tip moving and a coordinator that refuses some posts, the gate runs at most one trial at a time,
 * tries each (head, tip) pair at most once, keeps at most 200 verdicts, raises one attention line
 * per disagreeing item, and never stalls delivery (it only reads). GY-1549: every failing verdict it
 * posts carries the trial's log tail, bounded to `trialLogTailLength`, through every retry of a
 * refused post; a passing verdict posts none; and the loop's cursor never holds one. GY-1548: a
 * trial whose runner exits naming no failing test records no verdict and no disagreement, is
 * retried at most `shadowRunnerRetries` times per (head, tip) under one diagnostic record, and
 * never posts. GY-1560: disagreements are explained mid-run and cleared through a read that names
 * only the cursor's disagreements, in bounded chunks, whatever the explanation ledger holds. GY-1564:
 * the failing test a trial's colored log names joins the cursor as its verdict's bounded cause,
 * stays with that verdict across cycles, tip moves and an item's new head, and its attention line names it.
 */
const minute = 60_000;
const start = Date.parse('2030-03-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const githubDouble = new Proxy({}, { get: (_, name) => { throw new Error(`the shadow step called GitHub (${String(name)})`); } });

// Every tenth item pushes a second head before it merges: its first head's verdict keeps its own cause.
const headOf = (n: number, submittedAt: number, now: number) => n % 10 === 3 && now >= submittedAt + 10 * 60_000 ? sha(`head${n}-2`) : sha(`head${n}`);
const work = (n: number, submittedAt: number, mergedAt: number, now: number): Work => ({
  id: `w${n}`, key: `GY-${n}`, description: '', type: 'feature', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: [],
  revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(submittedAt), ready: true, epoch: 1, lease: null, workspaces: [],
  submission: { epoch: 1, pr: n }, candidate: { sha: headOf(n, submittedAt, now), baseSha: sha('base'), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' }, reworkRequested: false,
  scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [],
  ...(now >= mergedAt ? { stage: 'done', delivery: { mergedAt: iso(mergedAt), mergeSha: sha(`merge${n}`), authorizationRevision: 1 } } : { stage: 'review' }),
}) as unknown as Work;

test('unit:soak-shadow-gate — a simulated day: bounded trials, one verdict per (head, tip), at most 200 kept, one attention line per disagreeing item, delivery unaffected, every failing post carries a bounded log tail and no passing post or cursor entry does, and a runner exit naming no test is retried at most twice per pair and never posted', { timeout: 300_000 }, async () => {
  const cycles = 24 * 60 / 2, items = 150;
  let now = start, tipIndex = 0, failPosts = 0, running = 0, widest = 0;
  const tip = () => sha(`tip${tipIndex}`);
  // Every trial's output outgrows the tail a verdict may carry, so a bounded tail is a cut, never the whole.
  const output = Array.from({ length: 400 }, (_, line) => `trial output line ${line}`).join('\n');
  // A failing trial's output ends in the spec reporter's colored summary naming a test of its own merge (GY-1564).
  const failingTest = (mergeSha: string) => `unit:soak-${mergeSha.slice(0, 8)}`;
  const failedOutput = (mergeSha: string) => `${output}\n\u001b[31m✖ failing tests:\u001b[39m\n\ntest at tests/x.test.ts:1:1\n\u001b[31m✖ ${failingTest(mergeSha)} — the merge broke it (1.5ms)\u001b[39m\n\u001b[31m  AssertionError [ERR_ASSERTION]: soak\u001b[39m\n[exit status 1]`;
  const trials: string[] = [], posts: string[] = [];
  const attempts: { pair: string; failed: boolean; refused: boolean; logTail: string | undefined; mergeSha: string | null }[] = [];
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
    // The coordinator refuses the scheduled posts, and the first post of every failing verdict: a retry carries the whole verdict again, log included.
    const pair = `${item.key}:${verdict.head}:${verdict.baseTip}`, failed = verdict.tests.failed.length > 0;
    const refused = failPosts-- > 0 || (failed && !attempts.some(attempt => attempt.pair === pair));
    attempts.push({ pair, failed, refused, logTail: verdict.logTail, mergeSha: verdict.mergeSha });
    if (refused) throw new Error('route down');
    posts.push(`${item.key}:${verdict.head}:${verdict.baseTip}`);
  }, trial: async input => {
    running += 1; widest = Math.max(widest, running); trials.push(input.mergeSha);
    await new Promise(resolve => setTimeout(resolve, 1));
    running -= 1;
    // Every thirteenth trial's runner dies naming no test, and one pair in seventeen does so every time it is tried: host failures, so no verdict follows from them.
    if (trials.length % 13 === 0 || parseInt(input.mergeSha.slice(0, 2), 16) % 17 === 0) throw new TrialRunnerError('tests', null, 'SIGKILL', ['tests/x.test.ts'], 0, output, input.mergeSha, 1000);
    // Every seventh trial fails its tests: GitHub merges those anyway, a disagreement. Every trial's full output comes back; the step decides what the verdict carries.
    const failed = trials.length % 7 === 0;
    return { build: 'pass', tests: { passed: failed ? 0 : 1, failed: failed ? ['tests/x.test.ts'] : [], files: 1 }, durationMs: 1000, logTail: failed ? failedOutput(input.mergeSha) : output, runnerExit: failed ? 1 : 0 };
  } });
  const submittedAt = (n: number) => start + n * 7 * minute, mergedAt = (n: number) => submittedAt(n) + 25 * minute;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.from({ length: items }, (_, index) => index + 1).filter(n => submittedAt(n) <= now).map(n => work(n, submittedAt(n), mergedAt(n), now)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: reads } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const raised = new Map<string, number>(), runnerLines = new Map<string, number>(), causeKept = new Map<string, string>();
  let namedLines = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * 2 * minute;
    if (cycle % 40 === 0) tipIndex += 1;
    if (cycle % 90 < 3) failPosts = 1;
    const result = await runCycle(config, state, effects, () => now);
    for (const action of result.actions) if (action.detail.startsWith('Shadow merge gate:')) {
      raised.set(action.work ?? '', (raised.get(action.work ?? '') ?? 0) + 1);
      // The line names the failing test of the trial merge it reports, never the bare line or another merge's test.
      const mergeSha = action.detail.match(/\(trial merge ([0-9a-f]{40})\)/)?.[1];
      assert.ok(mergeSha && action.detail.includes(`the trial log names ${failingTest(mergeSha)} (tests/x.test.ts): AssertionError [ERR_ASSERTION]: soak`), `cycle ${cycle}: ${action.detail}`);
      namedLines += 1;
    }
    for (const action of result.actions) if (action.detail.startsWith('Shadow merge gate runner failure:')) runnerLines.set(action.detail.replace(/ ended .*$/s, ''), (runnerLines.get(action.detail.replace(/ ended .*$/s, '')) ?? 0) + 1);
    await shadowIdle(state);
    assert.ok(state.shadow.length <= shadowKeptVerdicts, `cycle ${cycle}: ${state.shadow.length} verdicts kept`);
    assert.ok(widest <= 1, 'one trial at a time');
    // The cursor keeps no log: the recorded event holds it, and the persisted state parses under the strict schema that has no room for one.
    assert.ok(state.shadow.every(verdict => !('logTail' in verdict)), `cycle ${cycle}: the cursor holds a log tail`);
    assert.doesNotThrow(() => shadowStateSchema.parse(state.shadow), `cycle ${cycle}: the cursor does not parse as persisted state`);
    // Each failing verdict's cause is its own merge's test, bounded, and unchanged from cycle to cycle while the cursor keeps it; a passing verdict has none.
    for (const verdict of state.shadow) {
      const pair = `${verdict.key}:${verdict.head}:${verdict.baseTip}`;
      if (!verdict.tests.failed.length) { assert.equal(verdict.cause, undefined, `cycle ${cycle}: ${pair} passed but names a cause`); continue; }
      assert.equal(verdict.cause, `${failingTest(verdict.mergeSha!)} (tests/x.test.ts): AssertionError [ERR_ASSERTION]: soak`, `cycle ${cycle}: ${pair}`);
      assert.ok(verdict.cause!.length <= trialCauseLength);
      assert.equal(causeKept.get(pair) ?? verdict.cause, verdict.cause, `cycle ${cycle}: ${pair} changed its cause`);
      causeKept.set(pair, verdict.cause!);
    }
  }
  assert.ok(trials.length > 20, `the gate made progress: ${trials.length} trials`);
  assert.ok(trials.length <= cycles, 'at most one trial per cycle');
  assert.ok(causeKept.size >= 10 && namedLines === raised.size, `${causeKept.size} failing verdicts kept a cause; ${namedLines} attention lines named one`);
  assert.ok(posts.some(post => post.split(':')[1] === sha(`head${post.split(':')[0]!.slice(3)}-2`)), 'some item was tried on its second head');
  assert.equal(new Set(posts).size, posts.length, 'each (head, tip) pair was recorded once, however many posts failed along the way');
  // Every failing verdict posted the last trialLogTailLength characters of its trial's output, on the first post and on every retry of a refused one; no passing verdict posted any.
  const failing = attempts.filter(attempt => attempt.failed), passing = attempts.filter(attempt => !attempt.failed), refused = attempts.filter(attempt => attempt.refused);
  assert.ok(failing.length >= 10 && passing.length >= 50 && refused.length >= 5, `the day posted ${failing.length} failing, ${passing.length} passing and retried ${refused.length} refused verdicts`);
  for (const attempt of failing) { assert.equal(attempt.logTail?.length, trialLogTailLength, `${attempt.pair} posted a bounded log tail`); assert.equal(attempt.logTail, failedOutput(attempt.mergeSha!).slice(-trialLogTailLength), `${attempt.pair} posted the end of its trial's output`); }
  for (const attempt of passing) assert.equal(attempt.logTail, undefined, `${attempt.pair} passed and posted no log tail`);
  assert.ok(refused.some(attempt => !attempt.failed) && failing.every(attempt => attempts.some(other => other.pair === attempt.pair && other.refused)), 'every failing verdict and some passing ones were refused once');
  for (const attempt of refused) {
    const retried = attempts.filter(other => other.pair === attempt.pair && !other.refused);
    assert.equal(retried.length, 1, `${attempt.pair} was recorded once after its refusal`);
    assert.equal(retried[0]!.logTail, attempt.logTail, `${attempt.pair} retried the same post, log tail included`);
  }
  assert.ok([...raised.values()].every(count => count === 1), `one attention line per item: ${JSON.stringify([...raised])}`);
  assert.ok(raised.size > 0, 'a disagreement was raised');
  // Runner failures: one bounded diagnostic record per (head, tip), never more than shadowRunnerRetries trials, one attention line once given up, and no verdict for a pair given up.
  const records = Object.entries(state.actions).filter(([key]) => key.startsWith('shadow-runner:'));
  assert.ok(records.length >= 5, `the day met ${records.length} runner failures`);
  for (const [key, record] of records) {
    assert.ok(record.attempts <= shadowRunnerRetries && record.state === 'failed' && /met a runner failure \(\d of 2\): its tests runner exited \(signal SIGKILL\) naming no failing test/.test(record.detail), `${key}: ${record.detail.slice(0, 200)}`);
    if (record.attempts === shadowRunnerRetries) assert.ok(!posts.some(post => post.endsWith(key.slice('shadow-runner:'.length))), `${key} was given up, so it has no verdict`);
  }
  assert.ok(records.some(([, record]) => record.attempts === shadowRunnerRetries), 'some pair was given up');
  assert.ok([...runnerLines.values()].every(count => count === 1) && runnerLines.size === records.filter(([, record]) => record.attempts === shadowRunnerRetries).length, `one attention line per given-up pair: ${JSON.stringify([...runnerLines])}`);
  const section = daemonSummary(state, now, config.run.intervalSeconds * 1000, config.hostId).shadowGate;
  assert.equal(section.total, state.shadow.length);
  assert.ok(section.disagreements.length <= 10);
});

test('unit:soak-shadow-explanations — a simulated day in which disagreements are raised, explained mid-run and cleared: an explained item is cleared once and never raised again, an unexplained one keeps its line, a failing explanations read stops no trial, and state stays bounded', { timeout: 300_000 }, async () => {
  const cycles = 24 * 60 / 2, items = 150;
  let now = start, tipIndex = 0, running = 0, widest = 0, readFails = false, explanationReads = 0, widestRead = 0, widestCycleAsk = 0, cycleAsk = 0;
  const tip = () => sha(`tip${tipIndex}`);
  // The explanation ledger already holds thousands of explanations of other heads: the loop's reads never carry them.
  const trials: string[] = [], explanations: { key: string; head: string; baseTip: string }[] = Array.from({ length: 5000 }, (_, n) => ({ key: `GY-${9000 + n}`, head: sha(`old${n}`), baseTip: sha('old-tip') }));
  const git = ((command: string, args: string[]) => {
    assert.equal(command, 'git');
    const [, , sub] = args;
    if (sub === 'rev-parse') return `${tip()}\n`;
    if (sub === 'merge-tree') return `${sha('tree')}\0`;
    if (sub === 'commit-tree') return `${sha(`merge-${args.join(' ')}`)}\n`;
    if (sub === 'diff') return 'src/a.ts\n';
    return '';
  }) as never;
  const state = emptyDaemonState(config);
  const reads = shadowReads(config, '/coordinator', git, { base: '/w', record: async () => {}, explanations: async pairs => {
    // The loop names only the disagreements its cursor holds, in bounded chunks, and the answer
    // carries only those of them that are explained, however long the explanation ledger grows.
    explanationReads += 1; cycleAsk += pairs.length;
    widestRead = Math.max(widestRead, pairs.length);
    for (const pair of pairs) assert.ok(state.shadow.some(verdict => verdict.key === pair.key && verdict.head === pair.head && verdict.baseTip === pair.baseTip && (verdict.outcome === 'shadow-only-fail' || verdict.outcome === 'shadow-missed')), `the loop asked about ${pair.key}, which is no disagreement in its cursor`);
    if (readFails) throw new Error('coordinator 503');
    const asked = new Set(pairs.map(pair => `${pair.key}:${pair.head}:${pair.baseTip}`));
    return explanations.filter(entry => asked.has(`${entry.key}:${entry.head}:${entry.baseTip}`)).map(entry => ({ ...entry }));
  }, trial: async input => {
    running += 1; widest = Math.max(widest, running); trials.push(input.mergeSha);
    await new Promise(resolve => setTimeout(resolve, 1));
    running -= 1;
    // Every fifth trial fails its tests and GitHub merges it anyway: a shadow-only-fail.
    const failed = trials.length % 5 === 0;
    return { build: 'pass', tests: { passed: failed ? 0 : 1, failed: failed ? ['tests/x.test.ts'] : [], files: 1 }, durationMs: 1000, logTail: 'out', runnerExit: failed ? 1 : 0 };
  } });
  const submittedAt = (n: number) => start + n * 7 * minute, mergedAt = (n: number) => submittedAt(n) + 25 * minute;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: Array.from({ length: items }, (_, index) => index + 1).filter(n => submittedAt(n) <= now).map(n => work(n, submittedAt(n), mergedAt(n), now)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {},
    github: githubDouble, merge: githubDouble, shadow: reads } as unknown as DaemonEffects;
    const raised = new Map<string, number>(), raisedAt = new Map<string, number>(), explainedAt = new Map<string, number>(), cleared = new Set<string>();
  let trialsDuringFailedReads = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = start + cycle * 2 * minute;
    if (cycle % 40 === 0) tipIndex += 1;
    // The coordinator refuses the explanations read for six cycles in every hundred.
    readFails = cycle % 100 >= 94;
    const before = trials.length;
    cycleAsk = 0;
    const result = await runCycle(config, state, effects, () => now);
    if (readFails) trialsDuringFailedReads += trials.length - before;
    widestCycleAsk = Math.max(widestCycleAsk, cycleAsk);
    for (const action of result.actions) if (action.detail.startsWith('Shadow merge gate:')) {
      const key = action.work ?? '';
      raised.set(key, (raised.get(key) ?? 0) + 1);
      if (!raisedAt.has(key)) raisedAt.set(key, cycle);
      assert.ok(!explainedAt.has(key), `cycle ${cycle}: ${key} was raised again after it was explained`);
    }
    await shadowIdle(state);
    // An operator explains every disagreement of an even-numbered item ten cycles after its line is raised; odd-numbered items stay unexplained.
    for (const [key, at] of raisedAt) {
      if (explainedAt.has(key) || Number(key.slice(3)) % 2 || cycle - at < 10) continue;
      for (const entry of state.shadow.filter(verdict => verdict.key === key && verdict.outcome === 'shadow-only-fail')) explanations.push({ key, head: entry.head, baseTip: entry.baseTip });
      explainedAt.set(key, cycle);
    }
    for (const [key, at] of explainedAt) {
      if (state.actions[`shadow:${key}`]) { assert.ok(cycle - at <= 8, `cycle ${cycle}: ${key} still standing ${cycle - at} cycles after its explanation`); continue; }
      cleared.add(key);
    }
    assert.ok(state.shadow.length <= shadowKeptVerdicts, `cycle ${cycle}: ${state.shadow.length} verdicts kept`);
    assert.ok(Object.keys(state.actions).filter(name => /^shadow:[^:]+$/.test(name)).length <= raised.size, `cycle ${cycle}: an attention line without a raise`);
    assert.ok(widest <= 1, 'one trial at a time');
    assert.doesNotThrow(() => shadowStateSchema.parse(state.shadow), `cycle ${cycle}: the cursor does not parse as persisted state`);
  }
  assert.ok(trials.length > 20, `the gate made progress: ${trials.length} trials`);
  assert.ok(trialsDuringFailedReads > 0, 'trials went on while the explanations read failed');
  assert.ok(explanationReads > 0, 'the loop read explanations');
  assert.ok(widestRead <= shadowExplanationPairsMax, `one read named ${widestRead} pairs`);
  assert.ok(widestCycleAsk <= shadowKeptVerdicts, `one cycle asked about ${widestCycleAsk} pairs`);
  assert.ok([...raised.values()].every(count => count === 1), `one attention line per item: ${JSON.stringify([...raised])}`);
  assert.ok(explainedAt.size >= 3, `the day explained ${explainedAt.size} items`);
  for (const key of explainedAt.keys()) assert.ok(cleared.has(key) && !state.actions[`shadow:${key}`], `${key} was explained and cleared`);
  const unexplained = [...raised.keys()].filter(key => !explainedAt.has(key));
  assert.ok(unexplained.length >= 3, `the day left ${unexplained.length} items unexplained`);
  for (const key of unexplained) assert.ok(state.actions[`shadow:${key}`], `${key} is unexplained and keeps its line`);
  const section = daemonSummary(state, now, config.run.intervalSeconds * 1000, config.hostId).shadowGate;
  assert.equal(section.total, state.shadow.length);
});
