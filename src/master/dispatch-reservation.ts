// Concern: the per-host dispatch reservation of a profile and an item, and the watch-supervisor probe a failed launch consults (GY-273).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { Work } from '../model.js';
import { watchAssignment } from '../supervisor.js';
import type { WorkerProfile } from './profiles.js';
import { type HerdrAgent, listHerdrAgents } from './herdr.js';

/**
 * The per-host dispatch reservation (GY-273). The loop and every executor dispatch from their own
 * snapshot of Herdr's agents, so two of them could pick one profile, or one item, within the same
 * second; the loser had already claimed the item and started its runtime when Herdr refused the
 * name. A dispatch therefore takes an exclusive reservation of its profile and its item — a lock
 * file created with O_EXCL under the installation's `.graphyard/dispatch` — before anything is
 * claimed, re-reads Herdr's agents while holding it, and gives it back once the session carries
 * its name (or the launch failed). A dispatcher that finds either reserved is refused cleanly,
 * before any claim, with a `DispatchReservedError` naming what is held, and picks another profile
 * or leaves the item to the dispatcher launching it.
 *
 * A lock is stale, and taken over, once its holder's process is gone on this host or it is older
 * than `dispatchReservationMs` — longer than any launch takes (two attempts at the start ceiling).
 */
export const dispatchReservationMs = 10 * 60_000;
export const dispatchReservationDirectory = (root: string) => resolve(root, '.graphyard/dispatch');
export class DispatchReservedError extends Error {
  readonly dispatchReserved = true;
  constructor(readonly resource: 'profile' | 'work', readonly subject: string, message: string) { super(message); }
}
export const dispatchReserved = (error: unknown): error is DispatchReservedError => (error as { dispatchReserved?: boolean } | null)?.dispatchReserved === true;
interface ReservationHolder { token: string; pid: number; host: string; at: string; epoch?: number }
const reservationFile = (root: string, resource: 'profile' | 'work', subject: string) => resolve(dispatchReservationDirectory(root), `${resource}-${subject.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
const processAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
async function reservationHolder(file: string): Promise<{ holder: ReservationHolder | null; ageMs: number } | null> {
  let text: string, ageMs: number;
  try { [text, ageMs] = await Promise.all([readFile(file, 'utf8'), stat(file).then(info => Date.now() - info.mtimeMs)]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { return { holder: JSON.parse(text) as ReservationHolder, ageMs }; } catch { return { holder: null, ageMs }; }
}
const staleHolder = (held: { holder: ReservationHolder | null; ageMs: number }, limitMs: number) =>
  held.ageMs > limitMs || !!held.holder && held.holder.host === hostname() && Number.isSafeInteger(held.holder.pid) && !processAlive(held.holder.pid);
/** A takeover guard is held only between a re-read and an `rm`: one older than this was abandoned by a crash. */
const takeoverGuardMs = 60_000;
/**
 * Removes the lock at `file` only if the lock actually removed passes `judged` (GY-509). The guard
 * of a takeover counts as abandoned after `takeoverGuardMs` of age alone, so a live dispatcher that
 * stalls between reading a lock and removing it can find its guard cleared and a fresh lock created
 * in the meantime; an `rm` of the path would then delete that fresh lock. The lock is instead moved
 * aside by an atomic rename to a name of this dispatcher's own and judged there: what was moved is
 * exactly what gets judged, however long the dispatcher stalled. A lock that fails the judgement is
 * put back with `link`, which never replaces a lock created at the path in the meantime.
 */
export async function removeJudged(file: string, judged: (held: { holder: ReservationHolder | null; ageMs: number }) => boolean, token: string, afterMove?: () => Promise<void>) {
  const aside = `${file}.${token}.removing`;
  try { await rename(file, aside); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    await afterMove?.();
    const held = await reservationHolder(aside);
    if (held && !judged(held)) await link(aside, file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  } finally { await rm(aside, { force: true }); }
}
/**
 * Removes a stale lock, but only the lock that was judged stale (GY-356). Two dispatchers can both
 * judge one lock stale; were each simply to `rm` it and retry the create, the slower one's `rm`
 * could delete the lock the faster one had just created, and both would hold the reservation. A
 * takeover is therefore serialised by a `.takeover` guard created with O_EXCL, and under it the
 * lock is removed only while it still carries the token that was judged stale, judged on the lock
 * actually moved aside (`removeJudged`). A lock created by a faster takeover carries a new token and
 * is left alone; the slower dispatcher's next create then finds it held.
 */
export async function takeOverStale(file: string, judged: ReservationHolder | null, body: string, token: string) {
  const guard = `${file}.takeover`;
  try { await writeFile(guard, body, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another dispatcher is taking over; a guard abandoned by a crash is cleared for the next attempt.
    const held = await reservationHolder(guard);
    if (held && staleHolder(held, takeoverGuardMs)) await rm(guard, { force: true });
    return;
  }
  try {
    await removeJudged(file, held => held.holder?.token === judged?.token && staleHolder(held, dispatchReservationMs), token);
  } finally {
    const own = await reservationHolder(guard).catch(() => null);
    if (own?.holder?.token === token) await rm(guard, { force: true });
  }
}
/** Reserves one resource, or refuses naming its live holder; the returned function gives it back. */
async function reserveDispatchResource(root: string, resource: 'profile' | 'work', subject: string, refusal: (holder: ReservationHolder | null) => string): Promise<() => Promise<void>> {
  const file = reservationFile(root, resource, subject);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const body = JSON.stringify({ token, pid: process.pid, host: hostname(), at: new Date().toISOString() } satisfies ReservationHolder);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, body, { flag: 'wx', mode: 0o600 });
      return async () => { const held = await reservationHolder(file).catch(() => null); if (held?.holder?.token === token) await rm(file, { force: true }); };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const held = await reservationHolder(file);
    if (!held) continue;
    // A file still being written reads as unparsable for an instant: only its age makes it stale.
    if (!staleHolder(held, dispatchReservationMs)) throw new DispatchReservedError(resource, subject, refusal(held.holder));
    await takeOverStale(file, held.holder, body, token);
  }
  throw new DispatchReservedError(resource, subject, refusal(null));
}
const heldBy = (holder: ReservationHolder | null) => holder ? ` (process ${holder.pid} on ${holder.host} since ${holder.at})` : '';
/**
 * What the last dispatch on this host launched, written before its reservation is given back: the
 * epoch it claimed for an item (a snapshot from before it is stale) and the profile it named.
 */
export const dispatchedFile = (root: string, key: string) => resolve(dispatchReservationDirectory(root), `dispatched-${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
export const profileLaunchedFile = (root: string, profile: string) => resolve(dispatchReservationDirectory(root), `launched-${profile.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
const launchMarker = (file: string) => readFile(file, 'utf8').then(text => JSON.parse(text) as { epoch?: number; at?: string }).catch(() => null);
/**
 * Herdr's agents as they stand under the reservation. A snapshot can only have gone stale on this
 * profile's name if a dispatch here launched the profile, and every such launch leaves its marker
 * before giving the reservation back: with such a marker, or a fresh reader supplied, Herdr is read
 * again; otherwise the snapshot the dispatcher chose from stands. The marker is not compared with
 * the snapshot's time (GY-356): that time is the control plane's clock and the marker's this host's,
 * so a skewed server would make a launch after the snapshot look older than it.
 */
export async function currentAgents(root: string, profile: WorkerProfile, snapshot: HerdrAgent[], _observedAt: string, run: ChildRun | undefined, fresh: (() => HerdrAgent[] | Promise<HerdrAgent[]>) | undefined) {
  if (fresh) return fresh();
  return await launchMarker(profileLaunchedFile(root, profile.name)) ? listHerdrAgents(run) : snapshot;
}
export async function reserveDispatch(root: string, work: Work, profile: WorkerProfile, observedAt: string) {
  const releaseWork = await reserveDispatchResource(root, 'work', work.key, holder => `${work.key} is being dispatched by another dispatcher${heldBy(holder)}; it is left to that launch`);
  try {
    // A dispatch that finished while this one read its snapshot claimed a newer epoch than the
    // snapshot shows: the item is taken, and claiming it again would only be refused at the claim.
    // The marker's time is this host's clock and the snapshot's the control plane's: under skew a
    // marker can be passed over, which costs only that refused claim, never a second launch (GY-356).
    const marker = await launchMarker(dispatchedFile(root, work.key));
    const last = typeof marker?.at === 'string' && Date.parse(marker.at) > Date.parse(observedAt) ? marker : null;
    if (typeof last?.epoch === 'number' && last.epoch > work.epoch) throw new DispatchReservedError('work', work.key, `${work.key} was dispatched at epoch ${last.epoch} after this dispatcher's snapshot (epoch ${work.epoch}); it is left to that launch`);
    const releaseProfile = await reserveDispatchResource(root, 'profile', profile.name, holder => `Worker profile ${profile.name} is reserved by another dispatch${heldBy(holder)}; pick another profile`);
    return async () => { await releaseProfile().catch(() => {}); await releaseWork().catch(() => {}); };
  } catch (error) { await releaseWork().catch(() => {}); throw error; }
}
/**
 * Whether this host runs the watch supervisor of `KEY EPOCH`, read from the process table by the
 * supervisor's exact command line. A host whose table cannot be read answers true: a pane that may
 * hold a running supervisor is not closed.
 */
export function watchSupervisorRunning(target: { key: string; epoch: number }, readCommand: (pid: number) => string = pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8'), list: () => string[] = () => readdirSync('/proc')): boolean {
  let pids: string[];
  try { pids = list().filter(name => /^\d+$/.test(name)); } catch { return true; }
  return pids.some(pid => {
    try { const assignment = watchAssignment(readCommand(Number(pid)).split('\0').filter(Boolean)); return assignment?.key === target.key && assignment.epoch === String(target.epoch); }
    catch { return false; }
  });
}
