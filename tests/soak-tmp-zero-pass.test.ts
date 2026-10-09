import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { standingTmpKey } from '../src/daemon/cycle-reclaim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1600 (reviews of 52628aeeacc3 and 2171681b50ea). The record of a /tmp pass that removes 0
 * while the inode bound stands repeats every cycle the bound stands, so over three simulated days
 * of the real loop's cycles it must not grow the ledger by a row per cycle, nor state a count its
 * row can no longer hold. The bound clears for two hours early on, then stands for the rest, a run
 * longer than the 1,000 attempts an action row holds; one pass meets a /tmp error. After every
 * cycle every system invariant holds; each run of standing passes is one row whose attempts count
 * its passes, a run that ends is filed under its last pass, the long run's count reads as a floor
 * from the bound on, and the erring pass fails its row without a fault of its own.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, cycleMs = 4 * minute, attemptsMax = 1000;

test('unit:tmp-reclaim-zero-escalates — over three days of standing zero-removal /tmp passes the ledger holds one row per run of them, states no count past its bound, and every system invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-tmp-zero-pass');
  const credentials = await temporaryDirectory('soak-tmp-zero-pass-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config = await loadMasterConfig(root);
  const start = Date.now();
  // The bound clears for the second and fourth hours; the last run stands from the fifth hour on.
  const clear = (at: number) => [hour, 3 * hour].some(from => at - start >= from && at - start < from + hour);
  const erring = start + 2 * day;
  let now = start;
  const reclaimResources = async () => {
    const stands = !clear(now), errors = now === erring ? ['Tmp reclaim: /tmp/graphyard-held: EBUSY'] : [];
    return { at: new Date(now).toISOString(), reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors,
      tmpPass: { roots: ['/tmp'], scanned: 3, kept: 3, boundStands: stands, ...(stands ? { escalated: [{ limit: 20_000, cacheAgeMs: 10 * minute, removed: 0 }], consumers: [{ path: '/tmp/leaker', entries: 90_000, owner: 'someone' }] } : {}) } };
  };
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }), closeSession: () => {},
    dispatch: async () => {}, requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    reclaimResources,
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config), violations: string[] = [], erred: string[] = [];
  let cycles = 0, mostRows = 0, atBound: string | null = null;
  for (; now < start + 3 * day; now += cycleMs, cycles++) {
    await runCycle(config, state, effects, () => now);
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycles}: ${check.invariant} — ${check.reading}`);
    mostRows = Math.max(mostRows, Object.keys(state.actions).filter(key => key.startsWith('reclaim:tmp:')).length);
    const row = state.actions[standingTmpKey];
    if (now === erring) erred.push(row?.state ?? 'missing', row?.faultClass ?? 'no fault');
    if (row?.attempts === attemptsMax && !atBound) atBound = row.detail;
  }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(cycles, 3 * day / cycleMs, 'three days of cycles ran');
  const rows = Object.entries(state.actions).filter(([key]) => key.startsWith('reclaim:tmp:'));
  // Three runs of standing passes, split by the two clear hours: two filed, one still standing.
  assert.equal(rows.length, 3, `one row per run of standing passes: ${rows.map(([key]) => key)}`);
  assert.equal(mostRows, 3, 'the ledger never held more than one row per run');
  const filed = rows.filter(([key]) => key !== standingTmpKey);
  assert.equal(filed.length, 2);
  for (const [key, action] of filed) {
    assert.equal(key, `reclaim:tmp:${action.at}`, 'a finished run is filed under its last pass');
    assert.equal(action.attempts, hour / cycleMs, 'a short run counts each of its passes');
    assert.match(action.detail, new RegExp(`^Pass ${hour / cycleMs} in a row: /tmp reclaim removed 0 entries while the inode bound stands`));
  }
  const current = state.actions[standingTmpKey], lastRun = (3 * day - 4 * hour) / cycleMs;
  assert.ok(lastRun > attemptsMax, `the last run outlasts the row's attempt bound: ${lastRun} passes`);
  assert.equal(current.attempts, attemptsMax, 'the row holds its bound, never more');
  assert.match(atBound ?? '', new RegExp(`^${attemptsMax} or more passes in a row: `), 'the pass that reaches the bound states the count as a floor');
  assert.match(current.detail, new RegExp(`^${attemptsMax} or more passes in a row: /tmp reclaim removed 0 entries while the inode bound stands`), 'every pass past the bound states a floor, not a false number');
  assert.doesNotMatch(current.detail, /Pass \d+ in a row/);
  assert.match(current.detail, /top consumers: \/tmp\/leaker/);
  assert.equal(current.state, 'done', 'a later clean pass leaves the run done');
  // The erring pass failed the run's row while it was the latest, and its fault is the resources row's alone.
  assert.deepEqual(erred, ['failed', 'no fault'], 'the erring pass failed the /tmp row without a fault of its own');
  assert.equal(Object.values(state.actions).filter(action => action.kind === 'reclaim' && action.state === 'failed').length, 1, 'only the resources row still records the failure');
});
