import { useEffect, useRef, useState } from 'react';
import type { Work } from '../../src/model';
import { sessionStaleThresholdMs, workersView, type PrincipalSummary, type SessionRoleKind, type WorkerRow } from '../workers-view';
import { prSteps } from '../../src/model/pr-steps';
import { releaseView, type ReleaseView } from '../../src/model/release';
import type { Dashboard } from './dashboard';
import DeliverySlices from '../components/delivery-slices';
import { shortShas } from '../candidate';

/**
 * The Workers tab (GY-116, redrawn to the design in GY-161): every agent session across every item
 * — who it is, what it is on, how long it has spent, and the command that attaches to it — read
 * for triage: open sessions first by time spent, ended ones and the per-account summary folded.
 *
 * A row is a session handle the item carries (src/model/sessions.ts), not a Herdr listing: the
 * page draws what the control plane recorded and never asks a runtime. What the derivation is —
 * the stale threshold, the two attach forms, the order — lives in `workersView`, so a test
 * asserts it over a fixture without a browser (web/workers-view.ts).
 */

/** Time spent to the second, so a running row is seen to tick: `1h 02m 09s`, `4m 30s`, `12s`. */
export function spent(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours ? `${hours}h ${two(minutes)}m ${two(seconds)}s` : minutes ? `${minutes}m ${two(seconds)}s` : `${seconds}s`;
}
/** How long ago an instant was, in the same units: `12s ago`, `4m 30s ago`. Never an absolute timestamp. */
export function ago(iso: string | null, now: number) {
  const at = Date.parse(iso ?? '');
  return Number.isFinite(at) ? `${spent(now - at)} ago` : 'at an unrecorded time';
}
/** Commit SHAs in recorded text, shown as their first 8 characters (web/candidate.tsx). */
export { shortShas };

/**
 * One-click copy of exactly the text given: no prose, no trailing newline. The text is also the
 * `data-copy` attribute, so what a test reads is byte for byte what the click writes.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }
    catch { window.prompt(`Copy this ${label}`, text); }
  };
  return <button type="button" className="text-button copy" data-copy={text} title={text} aria-label={`Copy ${label}: ${text}`} onClick={() => void copy()}>{done ? 'Copied' : label}</button>;
}

/**
 * The clock every live duration reads. The server's `now` at the last poll is the anchor, and the
 * seconds since it arrived are added on a one-second tick, so a running row counts up between
 * polls without a reload. Rendered without effects (a test, the server) it is exactly the anchor.
 */
export function useLiveNow(observedAt: number) {
  const anchor = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const receivedAt = useRef({ anchor, at: Date.now() });
  if (receivedAt.current.anchor !== anchor) receivedAt.current = { anchor, at: Date.now() };
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), 1000); return () => clearInterval(timer); }, []);
  void tick;
  return typeof window === 'undefined' ? anchor : anchor + Math.max(0, Date.now() - receivedAt.current.at);
}

/** Each role in the words the Workers design uses. */
export const roleWords: Record<SessionRoleKind, string> = {
  worker: 'Builds code', reviewer: 'Reviews code', producer: 'Proves requirements', approver: 'Approves decisions', 'escalation handler': 'Handles escalations', master: 'Runs the loop',
};

/**
 * A session's health in plain words, from the one session state (GY-172): only a session whose
 * latest observation is working or idle, inside the threshold, reads as running — 'seen' is that
 * observation — one recorded open but not seen since is stale, and one observed ended or lost is
 * ended. Neither of the last two is ever shown as running.
 */
export function health(row: WorkerRow, now: number): { tone: 'live' | 'stale' | 'ended'; text: string } {
  if (row.leftOn && row.stale) return { tone: 'ended', text: `Not seen for ${spent(now - Date.parse(row.stale.since))} · its item is ${row.leftOn}` };
  if (row.stale) return { tone: 'stale', text: `Not seen for ${spent(now - Date.parse(row.stale.since))}` };
  if (row.state === 'running') return { tone: 'live', text: `Seen ${ago(row.seenAt, now)}${row.observed === 'idle' ? ' · at its prompt' : ''}` };
  if (/exited to a shell/.test(row.outcome ?? '')) return { tone: 'ended', text: 'Ended · its agent exited' };
  if (row.reconciled === 'vanished') return { tone: 'ended', text: 'Ended · stopped responding' };
  if (row.reconciled === 'superseded') return { tone: 'ended', text: 'Ended · replaced by a newer session' };
  if (row.reconciled === 'ended') return { tone: 'ended', text: 'Ended · its runtime closed it' };
  return { tone: 'ended', text: 'Finished' };
}

function Health({ row, now }: { row: WorkerRow; now: number }) {
  const { tone, text } = health(row, now);
  return <span className={`health ${tone}`} data-health={tone} data-stale={row.stale ? row.id : undefined}
    data-reconciled={row.reconciled ?? undefined} title={row.outcome ? shortShas(row.outcome) : undefined}><span className="health-dot" aria-hidden="true"/>{text}</span>;
}

function Attach({ row }: { row: WorkerRow }) {
  if (row.state === 'running' && !row.leftOn) {
    if (!row.local) return <span className="muted">no attach command recorded</span>;
    return <span className="attach">
      <CopyButton text={row.local} label="Copy local"/>
      {row.remote ? <CopyButton text={row.remote} label="Copy remote"/> : <span className="muted">no remote form</span>}
    </span>;
  }
  return row.transcript ? <CopyButton text={row.transcript} label="Copy transcript path"/> : <span className="muted">no transcript recorded</span>;
}

/** What the session is doing now: a builder by its item's current step, anyone else by what it was launched for, an ended one by how it ended. */
function doing(row: WorkerRow, item: Work | undefined, now: number, release: ReleaseView) {
  if (row.leftOn) return shortShas(row.subject);
  if (row.state !== 'running') return shortShas(row.reconciled ? row.subject : row.outcome ?? row.subject);
  if (row.roleKind === 'worker' && item && !row.stale) return prSteps(item, now, release).label;
  return shortShas(row.subject);
}

/** Since when, relative to now: a running session by when it started, an ended one by when it ended and how long it ran. */
function since(row: WorkerRow, now: number) {
  if (row.leftOn) return <>last seen {ago(row.updatedAt, now)} · ran <span className="spent">{spent(row.spentMs)}</span></>;
  if (row.state === 'running') return <>started <span className="spent">{spent(row.spentMs)}</span> ago</>;
  return <>ended {ago(row.endedAt ?? row.updatedAt, now)} · ran <span className="spent">{spent(row.spentMs)}</span></>;
}

function Row({ row, item, now, release, setSelected }: { row: WorkerRow; item?: Work; now: number; release: ReleaseView; setSelected(id: string | null): void }) {
  return <tr data-session={row.id} data-work={row.key} data-role={row.roleKind} className={row.stale && !row.leftOn ? 'stale' : undefined}>
    <th scope="row" data-label="Agent"><span className="mono agent-name" title={`${row.principal} · ${row.runtime} on ${row.host}`}>{row.agentName ?? row.principal}</span><Attach row={row}/></th>
    <td data-label="Role">{roleWords[row.roleKind]}</td>
    <td data-label="Working on"><button type="button" className="text-button" title={shortShas(row.subject)} onClick={() => setSelected(row.workId)}><span className="mono">{row.key}</span>{item ? <> {item.title}</> : null}</button></td>
    <td data-label="Doing now">{doing(row, item, now, release)}</td>
    <td data-label="Since" data-spent={row.spentMs}>{since(row, now)}</td>
    <td data-label="Health"><Health row={row} now={now}/></td>
  </tr>;
}

const columns = ['Agent', 'Role', 'Working on', 'Doing now', 'Since', 'Health'];
function Table({ rows, label, work, now, release, setSelected }: { rows: WorkerRow[]; label: string; work: Work[]; now: number; release: ReleaseView; setSelected(id: string | null): void }) {
  const byId = new Map(work.map(item => [item.id, item]));
  return <table className="sessions-table" aria-label={label}>
    <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.map(row => <Row key={`${row.workId}:${row.id}`} row={row} item={byId.get(row.workId)} now={now} release={release} setSelected={setSelected}/>)}</tbody>
  </table>;
}

/** One line per agent account: what it is on now, and how many sessions it ran in the last day. Folded away below the sessions. */
function Accounts({ principals, setSelected }: { principals: PrincipalSummary[]; setSelected(id: string | null): void }) {
  return <table className="sessions-table" aria-label="Principals">
    <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Working on</th><th scope="col">For</th><th scope="col">Sessions today</th></tr></thead>
    <tbody>{principals.map(entry => <tr key={entry.principal} data-principal={entry.principal} data-current={entry.current ? `${entry.current.key}:${entry.current.epoch ?? ''}` : 'idle'}>
      <th scope="row" data-label="Account" className="mono">{entry.principal}</th>
      <td data-label="Role">{roleWords[entry.roleKind]}</td>
      <td data-label="Working on">{entry.current ? <button type="button" className="text-button" onClick={() => setSelected(entry.current!.workId)}>{entry.current.key}</button> : <span className="muted">idle</span>}</td>
      <td data-label="For">{entry.current ? spent(entry.current.sinceMs) : '—'}</td>
      <td data-label="Sessions today">{entry.sessionsLast24h}</td>
    </tr>)}</tbody>
  </table>;
}

/**
 * The Workers page (GY-161, design/dashboard/Workers.dc.html): one table of the agent sessions
 * open now — the agent, its role in plain words, the item it works on, what it is doing, since
 * when, and its health — with the sessions that ended and the per-account summary folded below.
 */
export default function WorkersPage({ work, observedAt, setSelected, status }: Pick<Dashboard, 'work' | 'observedAt' | 'setSelected'> & { status?: Dashboard['status'] }) {
  const now = useLiveNow(observedAt);
  const release = releaseView(status);
  const view = workersView(work, new Date(now), undefined, release);
  // A session the runtime no longer reports is not open: it is listed, marked, but never counted as working.
  const stale = view.running.filter(row => row.stale).length;
  const open = view.running.length - stale;
  return <>
    <div className="page-heading"><div><h1>Workers</h1><p className="summary">{open} agent {open === 1 ? 'session' : 'sessions'} open.{stale ? ` ${stale} not seen recently.` : ''} {view.finished.length} ended.</p></div></div>
    {view.running.length ? <Table rows={view.running} label="Agent sessions" work={work} now={now} release={release} setSelected={setSelected}/> : <p className="muted">No agent session is open.</p>}
    <p className="muted workers-note">Roles: builds code · reviews code · proves requirements · approves decisions. An agent never reviews or approves its own work. A session not seen for {Math.round(sessionStaleThresholdMs / 60_000)} minutes is marked, never shown as live.</p>
    <details className="finished-sessions"><summary>Ended <span className="count">{view.finished.length}</span></summary>
      {view.finished.length ? <Table rows={view.finished} label="Ended sessions" work={work} now={now} release={release} setSelected={setSelected}/> : <p className="muted">No session has ended yet.</p>}
    </details>
    <details className="finished-sessions accounts"><summary>By account <span className="count">{view.principals.length}</span></summary>
      {view.principals.length ? <Accounts principals={view.principals} setSelected={setSelected}/> : <p className="muted">No agent has worked here yet.</p>}
    </details>
    <DeliverySlices status={status}/>
  </>;
}
