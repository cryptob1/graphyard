import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { currentAgents, dispatchReservationDirectory, dispatchReserved, dispatchedFile, profileLaunchedFile, removeJudged, reserveDispatch, takeOverStale } from '../src/master/dispatch-reservation.js';
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
    // A takeover creates its lock while this one holds the fresh lock aside: that lock is not replaced.
    const newer = JSON.stringify({ token: 'newer', pid: process.pid, host: hostname(), at: new Date().toISOString() });
    await removeJudged(lock, judgedStale, 'slower', async () => { await writeFile(lock, newer, { flag: 'wx' }); });
    assert.equal(await readFile(lock, 'utf8'), newer, 'a lock created during the stall stands');
    // The judged lock itself is removed, and a missing lock is nothing to remove.
    await writeFile(lock, stale);
    await removeJudged(lock, judgedStale, 'slower');
    await assert.rejects(readFile(lock, 'utf8'), 'the stale lock is removed');
    await removeJudged(lock, judgedStale, 'slower');
    await assert.rejects(readFile(`${lock}.slower.removing`, 'utf8'), 'nothing is left aside');
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
