import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reclaimTmpDirectories, testTempMinAgeMs, tmpInodeHeadroom, tmpReclaimMinAgeMs, type TmpReclaimOptions } from '../src/tmp-reclaim.js';
import { describeStandingTmpPass, loopTmpReclaimOptions, readResources, readTmpRoots, reclaimResources, resourceAttention, settleTmpReclaim, type ResourceInputs } from '../src/master-resources.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1628: on 9 October 2026 host /tmp stood at 23,065 of 1,048,576 inodes free and the escalated
// passes recorded 0 removals while 13,257 entries were this user's. Those entries were young — test
// temps under their two-hour bound, tsx cache files written minutes before — and the inodes were
// held by agent scratch checkouts the pass then could not reach (GY-1618). The pass reclaims every
// stale entry of this user's, and a zero now says which of its reasons kept each entry.

const hour = 3_600_000, minute = 60_000;
const backdate = (path: string, ageMs: number, now = Date.now()) => utimes(path, new Date(now - ageMs), new Date(now - ageMs));
const ownCache = () => { const uid = process.getuid?.(); return uid === undefined ? null : `tsx-${uid}`; };
const skip = { skip: ownCache() === null ? 'no uids on this platform' : false };
/** Stale test temps of every default name, a stale and a fresh tsx cache file, and young temps: what one pass over `tmp` finds. */
async function seed(tmp: string, now = Date.now()) {
  const cache = join(tmp, ownCache()!);
  await mkdir(join(cache, 'nested'), { recursive: true });
  const staleTemps = ['graphyard-run-Ab3xYz', 'gy-scratch-1', 'landing-merge-result-7', 'native-review-x1', 'pg-password-12', 'playwright_chromiumdev_profile-q9'].map(name => join(tmp, name));
  for (const [index, path] of staleTemps.entries()) {
    if (index % 2) await writeFile(path, 'x');
    else { await mkdir(join(path, 'base'), { recursive: true }); await writeFile(join(path, 'base', 'PG_VERSION'), '17'); await backdate(join(path, 'base', 'PG_VERSION'), testTempMinAgeMs + hour, now); await backdate(join(path, 'base'), testTempMinAgeMs + hour, now); }
    await backdate(path, testTempMinAgeMs + hour, now);
  }
  const staleCache = [join(cache, 'compiled-old-1'), join(cache, 'nested', 'compiled-old-2')];
  for (const path of staleCache) { await writeFile(path, 'x'); await backdate(path, tmpReclaimMinAgeMs + hour, now); }
  const freshCache = join(cache, 'compiled-fresh'), youngTemp = join(tmp, 'graphyard-young-Q1');
  await writeFile(freshCache, 'x'); await mkdir(youngTemp); await backdate(youngTemp, testTempMinAgeMs - 30 * minute, now);
  await backdate(join(cache, 'nested'), 9 * hour, now); await backdate(cache, 9 * hour, now);
  return { cache, staleTemps, staleCache, freshCache, youngTemp };
}

test('unit:tmp-reclaim-removes-stale-entries — a pass at the loop\'s bounds over a fixture of stale test temps and tsx cache files past their age bounds removes every one of them, and only them', skip, async () => {
  const tmp = await temporaryDirectory('reclaim-stale-entries');
  const { cache, staleTemps, staleCache, freshCache, youngTemp } = await seed(tmp);
  const report = await reclaimTmpDirectories({ ...loopTmpReclaimOptions([tmp]), workMs: 60_000, held: new Set() });
  assert.deepEqual(report.errors, []);
  assert.ok(report.removed.length > 0, 'the pass removed entries');
  assert.deepEqual(report.removed.map(entry => entry.path).sort(), [...staleTemps, ...staleCache].sort(), 'every stale test temp and stale cache file, and nothing else');
  for (const path of [...staleTemps, ...staleCache]) assert.equal(existsSync(path), false, `${path} is gone`);
  for (const path of [freshCache, youngTemp, cache]) assert.equal(existsSync(path), true, `${path} stays`);
  assert.ok(report.bytes > 0, 'the bytes freed are reported');
  // What it kept, it counts by reason: the young temp is young, and the fresh cache file too.
  assert.deepEqual(report.keptFor, { young: 1, held: 0, owner: 0, bound: 0 });
  assert.deepEqual(report.cacheKept, { young: 1, held: 0, bound: 0 });

  // A second pass over the same fixture removes nothing more, and says why: what is left is young.
  const again = await reclaimTmpDirectories({ ...loopTmpReclaimOptions([tmp]), workMs: 60_000, held: new Set() });
  assert.deepEqual(again.removed, []);
  assert.deepEqual(again.keptFor, { young: 1, held: 0, owner: 0, bound: 0 });
  // Below the headroom that zero is ledgered, and the record states each reason as counted, not a list of possibilities.
  const low = await reclaimTmpDirectories({ ...loopTmpReclaimOptions([tmp]), held: new Set(), volume: async () => ({ files: 4000, ffree: 100 }) });
  const detail = describeStandingTmpPass({ at: low.at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [],
    tmpPass: { roots: low.roots, scanned: low.scanned, kept: low.kept, keptFor: low.keptFor, cacheKept: low.cacheKept, boundStands: low.boundStands, escalated: low.escalated, consumers: low.consumers } });
  assert.match(detail ?? '', /1 kept \(1 younger than their age bound \(2 hours for test temp names, 24 hours for agent scratch\), 0 held open or named by a live process, 0 with a live owner, 0 past the pass's bounds\)/);
  assert.match(detail ?? '', /no tsx cache file of this user's it could remove \(each younger than 10 minutes or held open by a live process\): 1 younger, 0 held; nothing of this user's was both past its age bound and free to remove/);

  // Held entries are counted as held, never removed, and the pass's entry bound leaves the rest as the next pass's.
  const next = await temporaryDirectory('reclaim-stale-entries-held');
  const seeded = await seed(next);
  const bounded = await reclaimTmpDirectories({ tmpRoot: next, held: new Set([seeded.staleTemps[0]!, seeded.staleCache[0]!]), limit: 3, workMs: 60_000 });
  assert.equal(bounded.removed.length, 3, 'the pass stops at its entry bound');
  assert.equal(existsSync(seeded.staleTemps[0]!), true, 'a held temp stays');
  assert.equal(bounded.keptFor?.held, 1);
  assert.equal(bounded.keptFor?.young, 1);
  assert.ok(bounded.keptFor!.bound >= 1, 'what the bound left is counted as the bound\'s');
});

const standing = (pass: Awaited<ReturnType<typeof reclaimTmpDirectories>>) => describeStandingTmpPass({ at: pass.at, reaped: { review: 0, producer: 0 }, closed: [], released: [], tmp: { removed: 0, bytes: 0 }, errors: [],
  tmpPass: { roots: pass.roots, scanned: pass.scanned, kept: pass.kept, keptFor: pass.keptFor, cacheKept: pass.cacheKept, boundStands: true, escalated: pass.escalated, consumers: pass.consumers } }) ?? '';

test('unit:tmp-reclaim-kept-counts-are-this-users — the bound\'s unexamined remainder counts only this user\'s entries, and old cache files the work bound left keep a zero record from calling nothing eligible', skip, async () => {
  const tmp = await temporaryDirectory('reclaim-kept-own');
  await seed(tmp);
  // At an entry bound of 0 every candidate is the bound's remainder: as this user's, all seven; as another user's, none.
  const own = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), limit: 0, workMs: 60_000 });
  assert.deepEqual(own.keptFor, { young: 0, held: 0, owner: 0, bound: 7 }, 'this user\'s unexamined candidates are the bound\'s');
  const foreign = await reclaimTmpDirectories({ tmpRoot: tmp, held: new Set(), limit: 0, workMs: 60_000, uid: process.getuid!() + 1 });
  assert.deepEqual(foreign.keptFor, { young: 0, held: 0, owner: 0, bound: 0 }, 'another user\'s entries on a shared /tmp are never counted as left by the bound');
  assert.equal(foreign.kept, 0);

  // Work bound already spent: the stale cache files stay, are counted as the bound's, and the record names them.
  // Only the cache is seeded, so no test temp's bound count stands in for the cache's.
  const spent = await temporaryDirectory('reclaim-kept-cache-bound');
  const cache = join(spent, ownCache()!), staleCache = [join(cache, 'compiled-old-1'), join(cache, 'compiled-old-2')];
  await mkdir(cache);
  for (const path of staleCache) { await writeFile(path, 'x'); await backdate(path, tmpReclaimMinAgeMs + hour); }
  await writeFile(join(cache, 'compiled-fresh'), 'x');
  const pass = await reclaimTmpDirectories({ tmpRoot: spent, held: new Set(), workMs: -1 });
  assert.deepEqual(pass.removed, []);
  assert.deepEqual(pass.keptFor, { young: 0, held: 0, owner: 0, bound: 0 });
  for (const path of staleCache) assert.equal(existsSync(path), true, `${path} stays this cycle`);
  assert.deepEqual(pass.cacheKept, { young: 1, held: 0, bound: 2 });
  assert.equal(pass.kept, 2, 'what the cache\'s bound left is kept');
  const detail = standing(pass);
  assert.match(detail, /\(each younger than [^,]+, held open by a live process, or past the pass's bounds\): 1 younger, 0 held, 2 past the pass's bounds/);
  assert.doesNotMatch(detail, /nothing of this user's was both past its age bound and free to remove/, 'eligible cache files remained, so the record does not say none did');
});

/**
 * One loop pass over `tmp`, as the cycle runs it: started by one reclaim, read back by the next.
 * `volume` stands for the host's statfs, so the pass escalates and the reading warns as on /tmp.
 */
const loopPass = (root: string, tmp: string, volume: NonNullable<TmpReclaimOptions['volume']>) => async () => {
  const options = { tmpRoots: [tmp], tmpPass: (each: TmpReclaimOptions) => reclaimTmpDirectories({ ...each, held: new Set(), workMs: 60_000, volume }) };
  await reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
  await settleTmpReclaim();
  return reclaimResources(root, { reviewers: [], producers: [] }, { work: [], agents: [] }, options);
};

test('integration:tmp-inode-headroom-recovers — a host /tmp at 23,065 of 1,048,576 inodes free recovers above the 262,144 headroom within its first pass, stays above it over consecutive loop cycles while young temps keep arriving, and the resource-bound fault stops', { ...skip, timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('headroom-recovers');
  const credentials = await temporaryDirectory('headroom-recovers-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const config = await loadMasterConfig(root);
  const tmp = await temporaryDirectory('headroom-recovers-tmp');
  const { staleTemps, staleCache } = await seed(tmp);
  // The host's volume: each stale test temp stands for an embedded-Postgres data dir of 40,000
  // inodes, each cache file and each young temp for one; young temps keep arriving every cycle.
  const total = 1_048_576, headroom = tmpInodeHeadroom(total), arrivals: string[] = [];
  const volume = async () => {
    const freed = staleTemps.filter(path => !existsSync(path)).length * 40_000 + staleCache.filter(path => !existsSync(path)).length;
    return { files: total, ffree: 23_065 + freed - arrivals.filter(path => existsSync(path)).length };
  };
  assert.equal(headroom, 262_144);
  assert.ok((await volume()).ffree < headroom, 'the fixture starts where the host stood');

  let now = Date.now();
  const state = emptyDaemonState(config), violations: string[] = [], frees: number[] = [], passes: NonNullable<Awaited<ReturnType<typeof reclaimResources>>['tmpPass']>[] = [];
  const pass = loopPass(root, tmp, volume);
  const effects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }), closeSession: () => {},
    dispatch: async () => {}, requestProof: () => {}, recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    reclaimResources: async () => { const report = await pass(); if (report.tmpPass) passes.push(report.tmpPass); assert.equal(describeStandingTmpPass(report), null, 'no pass records a standing zero'); return report; },
  } as unknown as DaemonEffects;
  for (let cycle = 0; cycle < 6; cycle++, now += 5 * minute) {
    await runCycle(config, state, effects, () => now);
    // The pass the cycle's reclaim started runs beside it: let it finish before measuring, as the next cycle would find it.
    await settleTmpReclaim();
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
    frees.push((await volume()).ffree);
    // The reading the loop raises its resource-bound attention from, measured after each pass.
    const tmpReading = await readTmpRoots(root, [tmp], volume);
    const input: ResourceInputs = { now: Date.now(), reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null, tmp: tmpReading, profiles: { workers: [], reviewers: [], producers: [] } };
    const readings = readResources(input).filter(entry => entry.resource === 'tmp-inodes');
    assert.deepEqual(readings.map(entry => entry.state), ['ok'], `cycle ${cycle}: the tmp-inodes reading is back above its warn line`);
    assert.deepEqual(resourceAttention(readings), [], `cycle ${cycle}: no resource-bound attention`);
    // Test runs keep writing young temps between cycles: never the pass's, never enough to fall back.
    for (let index = 0; index < 5; index++) { const path = join(tmp, `gy-arrival-${cycle}-${index}`); await mkdir(path); arrivals.push(path); }
  }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.equal(passes.length, 6, 'each cycle recorded one finished pass');
  assert.ok(passes[0]!.boundStands === false, 'the first pass left the volume above its headroom');
  for (const [index, free] of frees.entries()) assert.ok(free >= headroom, `cycle ${index}: ${free} inodes free, above ${headroom}`);
  for (const [index, report] of passes.slice(1).entries()) {
    assert.equal(report.boundStands, false, `pass ${index + 1} found the volume above its headroom`);
    assert.equal(report.escalated, undefined, `pass ${index + 1} kept its base bounds: nothing to escalate`);
    // What a recovered pass keeps it accounts for by reason (GY-1628): only young temps, none held, owned or left by a bound.
    assert.equal(report.keptFor?.held, 0, `pass ${index + 1} kept nothing as held`);
    assert.equal(report.keptFor?.bound, 0, `pass ${index + 1} left nothing to its bounds: every stale entry went`);
    assert.ok(report.keptFor!.young >= 1 && report.keptFor!.young === report.kept, `pass ${index + 1} kept only young temps (${report.keptFor!.young} of ${report.kept})`);
  }
  for (const path of [...staleTemps, ...staleCache]) assert.equal(existsSync(path), false, `${path} was reclaimed`);
  assert.ok(arrivals.every(path => existsSync(path)), 'no young temp was taken');
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('reclaim:tmp:')), [], 'no standing zero-removal row was ever filed');
});
