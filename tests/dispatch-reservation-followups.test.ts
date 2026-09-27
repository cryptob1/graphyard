import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { currentAgents, dispatchReservationDirectory, dispatchReserved, dispatchedFile, profileLaunchedFile, removeJudged, reserveDispatch, sweepAsides, takeOverStale } from '../src/master/dispatch-reservation.js';
// @ts-expect-error The standalone executor is a dependency-free entry point script.
import { controlPlaneEffects } from '../scripts/graphyard-executor.mjs';
import type { HerdrAgent, WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';

// GY-356: the follow-ups from the approved review of GY-273's dispatch reservation.
const profile = { name: 'codex-a', agentName: 'agent-codex-a' } as WorkerProfile;
const item = (epoch = 0) => ({ key: 'GY-1', epoch } as Work);
const hour = 3_600_000;

test('unit:stale-takeover-keeps-a-fresh-lock — a dispatcher that judged a lock stale never removes the lock a faster takeover created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-takeover-'));
  try {
    const directory = dispatchReservationDirectory(root);
    await mkdir(directory, { recursive: true });
    const lock = join(directory, 'work-GY-1.lock');
    const old = new Date(Date.now() - hour);
    await writeFile(lock, JSON.stringify({ token: 'stale', pid: 1, host: 'elsewhere', at: old.toISOString() }));
    await utimes(lock, old, old);
    // Both dispatchers race on the one stale lock: exactly one of them reserves the item.
    const outcomes = await Promise.allSettled([reserveDispatch(root, item(), profile, new Date().toISOString()), reserveDispatch(root, item(), { ...profile, name: 'codex-b' }, new Date().toISOString())]);
    const won = outcomes.filter(outcome => outcome.status === 'fulfilled');
    assert.equal(won.length, 1, 'one dispatcher takes the stale reservation over');
    const lost = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.ok(dispatchReserved(lost.reason), `the other is refused cleanly: ${lost.reason}`);
    const holder = JSON.parse(await readFile(lock, 'utf8'));
    assert.notEqual(holder.token, 'stale', 'the lock that stands is the winner\'s');
    assert.equal(holder.host, hostname());
    await (won[0] as PromiseFulfilledResult<() => Promise<void>>).value();
    await assert.rejects(readFile(lock, 'utf8'), 'the winner gives it back');
    await assert.rejects(readFile(`${lock}.takeover`, 'utf8'), 'and no takeover guard is left behind');

    // The slower dispatcher's turn: it judged the old lock stale, but by the time it takes over, a
    // faster takeover's lock stands in its place. That lock carries a new token and is left alone,
    // even once it is old enough to look stale itself.
    const judged = { token: 'stale', pid: 1, host: 'elsewhere', at: old.toISOString() };
    const faster = JSON.stringify({ token: 'fresh-from-a-faster-takeover', pid: 1, host: 'elsewhere', at: new Date().toISOString() });
    await writeFile(lock, faster);
    await takeOverStale(lock, judged, JSON.stringify({ ...judged, token: 'slower', pid: process.pid, host: hostname() }), 'slower');
    assert.equal(await readFile(lock, 'utf8'), faster, 'a fresh lock is not removed by a takeover judged on an older one');
    await utimes(lock, old, old);
    await takeOverStale(lock, judged, JSON.stringify({ ...judged, token: 'slower', pid: process.pid, host: hostname() }), 'slower');
    assert.equal(await readFile(lock, 'utf8'), faster, 'nor once it is itself old: only the token that was judged is removed');
    await assert.rejects(readFile(`${lock}.takeover`, 'utf8'), 'the slower dispatcher gives its guard back');
    // A takeover already under way elsewhere leaves the lock to it.
    await writeFile(lock, JSON.stringify(judged)); await utimes(lock, old, old);
    await writeFile(`${lock}.takeover`, JSON.stringify({ token: 'other', pid: process.pid, host: hostname(), at: new Date().toISOString() }));
    await takeOverStale(lock, judged, JSON.stringify({ ...judged, token: 'slower' }), 'slower');
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'stale', 'the lock is left to the takeover holding the guard');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-509: a live dispatcher that stalls past the takeover guard's age between its read and its removal.
test('unit:stalled-takeover-removes-only-what-it-judged — removal judges the lock it moved aside, never a lock created during a stall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-stall-'));
  try {
    const lock = join(root, 'work-GY-1.lock');
    const old = new Date(Date.now() - hour);
    const stale = JSON.stringify({ token: 'stale', pid: 1, host: 'elsewhere', at: old.toISOString() });
    const fresh = JSON.stringify({ token: 'fresh', pid: process.pid, host: hostname(), at: new Date().toISOString() });
    const judgedStale = (held: { holder: { token: string } | null }) => held.holder?.token === 'stale';
    // The lock was replaced by a fresh one while the dispatcher stalled: it is moved aside, fails the
    // judgement and is put back, whatever its age.
    await writeFile(lock, fresh); await utimes(lock, old, old);
    await removeJudged(lock, judgedStale, 'slower');
    assert.equal(await readFile(lock, 'utf8'), fresh, 'a fresh lock is put back');
    // A takeover creates its lock while this one holds the fresh lock aside, and never withdraws it:
    // that lock is not replaced, and the fresh lock is left aside rather than deleted (GY-682).
    const newer = JSON.stringify({ token: 'newer', pid: process.pid, host: hostname(), at: new Date().toISOString() });
    await removeJudged(lock, judgedStale, 'slower', async () => { await writeFile(lock, newer, { flag: 'wx' }); });
    assert.equal(await readFile(lock, 'utf8'), newer, 'a lock created during the stall is not replaced');
    const left = (await readdir(root)).filter(name => name.endsWith('.removing'));
    assert.equal(left.length, 1, 'the lock that could not be put back is left aside');
    assert.equal(await readFile(join(root, left[0]), 'utf8'), fresh, 'with its holder\'s body');
    await rm(join(root, left[0])); await rm(lock);
    // The judged lock itself is removed, and a missing lock is nothing to remove.
    await writeFile(lock, stale);
    await removeJudged(lock, judgedStale, 'slower');
    await assert.rejects(readFile(lock, 'utf8'), 'the stale lock is removed');
    await removeJudged(lock, judgedStale, 'slower');
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.removing')), [], 'nothing is left aside');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// GY-682: the follow-ups from the approved review of GY-509.
test('unit:set-aside-lock-fences-creates — a create landing while a live lock is set aside is withdrawn, and the lock is put back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-fence-'));
  try {
    const directory = dispatchReservationDirectory(root);
    await mkdir(directory, { recursive: true });
    const lock = join(directory, 'work-GY-1.lock');
    const live = JSON.stringify({ token: 'live', pid: process.pid, host: hostname(), at: new Date().toISOString() });
    await writeFile(lock, live);
    const asides = async () => (await readdir(directory)).filter(name => name.endsWith('.removing'));
    // A third dispatcher creates its lock in the gap before the live lock is put back: it sees the
    // live lock set aside, withdraws its own, and is refused; the live lock is then put back.
    await removeJudged(lock, held => held.holder?.token === 'stale', 'slower', async () => {
      await assert.rejects(reserveDispatch(root, item(), profile, new Date().toISOString()), (error: unknown) => dispatchReserved(error) && /process \d+/.test(String(error)), 'the create in the gap is refused, naming the holder set aside');
    });
    assert.equal(await readFile(lock, 'utf8'), live, 'the live holder keeps its lock');
    assert.deepEqual(await asides(), [], 'and nothing is left aside');

    // A creator that never withdraws leaves the live lock aside, where it goes on fencing creates.
    await removeJudged(lock, held => held.holder?.token === 'stale', 'slower', async () => { await writeFile(lock, JSON.stringify({ token: 'stuck', pid: process.pid, host: hostname(), at: new Date().toISOString() }), { flag: 'wx' }); });
    assert.equal((await asides()).length, 1);
    await rm(lock);
    await assert.rejects(reserveDispatch(root, item(), profile, new Date().toISOString()), dispatchReserved, 'a live lock set aside still holds the reservation');
    await assert.rejects(readFile(lock, 'utf8'), 'and the refused create is withdrawn');
    // Once abandoned, the sweep puts the live lock back at its path.
    await sweepAsides(lock, Date.now() + hour);
    assert.equal(await readFile(lock, 'utf8'), live, 'an abandoned live lock is restored');
    assert.deepEqual(await asides(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:abandoned-asides-are-swept — a crashed removal leaks nothing, and a stale guard is cleared only as judged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-sweep-'));
  try {
    const directory = dispatchReservationDirectory(root);
    await mkdir(directory, { recursive: true });
    const lock = join(directory, 'work-GY-1.lock');
    const old = new Date(Date.now() - hour);
    const stale = JSON.stringify({ token: 'stale', pid: 1, host: 'elsewhere', at: old.toISOString() });
    // A crash left a stale lock and a guard aside: a fresh aside is left to its removal, an abandoned one swept.
    await writeFile(`${lock}.crashed.removing`, stale); await utimes(`${lock}.crashed.removing`, old, old);
    await writeFile(`${lock}.takeover.crashed.removing`, stale);
    await sweepAsides(lock);
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.removing')).length, 2, 'a removal in progress is left alone');
    await sweepAsides(lock, Date.now() + hour);
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.removing')), [], 'abandoned asides are removed');
    // Another subject's files are never swept.
    const other = join(directory, 'work-GY-1.lock.x.lock.crashed.removing');
    await writeFile(other, stale);
    await sweepAsides(lock, Date.now() + hour);
    assert.equal(await readFile(other, 'utf8'), stale);
    await rm(other);

    // A guard abandoned by a crash is cleared through the judged removal; a fresh guard stands.
    const guard = `${lock}.takeover`;
    await writeFile(lock, stale); await utimes(lock, old, old);
    await writeFile(guard, stale); await utimes(guard, old, old);
    await takeOverStale(lock, JSON.parse(stale), JSON.stringify({ token: 'slower', pid: process.pid, host: hostname(), at: new Date().toISOString() }), 'slower');
    await assert.rejects(readFile(guard, 'utf8'), 'the abandoned guard is cleared');
    const fresh = JSON.stringify({ token: 'third', pid: process.pid, host: hostname(), at: new Date().toISOString() });
    await writeFile(guard, fresh);
    await takeOverStale(lock, JSON.parse(stale), JSON.stringify({ token: 'slower', pid: process.pid, host: hostname(), at: new Date().toISOString() }), 'slower');
    assert.equal(await readFile(guard, 'utf8'), fresh, 'a live guard is put back');
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.removing')), [], 'and nothing is left aside');
    // With the guard gone, the stale lock is taken over.
    await rm(guard);
    const release = await reserveDispatch(root, item(), profile, new Date().toISOString());
    assert.notEqual(JSON.parse(await readFile(lock, 'utf8')).token, 'stale');
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:launch-marker-ignores-clock-skew — a profile launch marker re-reads Herdr whatever the control plane clock says', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-skew-'));
  try {
    await mkdir(dispatchReservationDirectory(root), { recursive: true });
    const snapshot: HerdrAgent[] = [];
    const live: HerdrAgent[] = [{ name: profile.agentName, pane_id: 'pane-1', agent_status: 'working' } as HerdrAgent];
    const run = async (_command: string, args: string[]) => args[0] === 'agent' && args[1] === 'list' ? JSON.stringify({ result: { agents: live } }) : JSON.stringify({ result: {} });
    assert.deepEqual(await currentAgents(root, profile, snapshot, new Date().toISOString(), run as never, undefined), snapshot, 'without a marker the snapshot stands');
    // This host's clock is an hour behind the server's: the marker's time precedes the snapshot's.
    const behind = new Date(Date.now() - hour).toISOString();
    await writeFile(profileLaunchedFile(root, profile.name), JSON.stringify({ key: 'GY-1', epoch: 1, agentName: profile.agentName, at: behind }));
    assert.deepEqual((await currentAgents(root, profile, snapshot, new Date().toISOString(), run as never, undefined)).map(agent => agent.name), [profile.agentName], 'a marker re-reads Herdr regardless of its time');
    // The item's own marker stays a hint read against the snapshot's time: skew can pass it over, and
    // what that costs is the claim the control plane then refuses, not a second launch.
    await writeFile(dispatchedFile(root, 'GY-1'), JSON.stringify({ epoch: 1, at: new Date().toISOString() }));
    await assert.rejects(reserveDispatch(root, item(0), profile, behind), (error: unknown) => dispatchReserved(error) && /epoch 1/.test(String(error)), 'an item dispatched at a newer epoch after the snapshot is refused');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:executor-dispatch-rereads-herdr — the standalone executor hands dispatchWork a fresh Herdr reader', async () => {
  const calls: unknown[][] = [];
  const bound = async () => '';
  const modules = { master: { dispatchWork: (...args: unknown[]) => { calls.push(args); return {}; }, listHerdrAgents: async (run: unknown) => [{ name: 'read', run }] }, daemon: {}, reviewer: {}, producer: {} };
  const effects = controlPlaneEffects(modules, { root: '/repo', current: () => ({}), run: bound, snapshot: async () => ({}), mutate: async () => ({}), mergeExecutor: {} });
  await effects.dispatchWorker({ key: 'GY-1' }, profile, [], { work: [], now: new Date().toISOString() });
  const options = calls[0][10] as { agents?: () => Promise<unknown[]> };
  assert.equal(typeof options?.agents, 'function', 'a fresh reader is supplied');
  assert.deepEqual(await options.agents!(), [{ name: 'read', run: bound }], 'and it reads Herdr through the executor\'s runner');
});
