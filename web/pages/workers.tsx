import { useEffect, useRef, useState } from 'react';
import type { Work } from '../../src/model';
import { sessionStaleThresholdMs, sessionState, workersView, type PrincipalSummary, type SessionRoleKind, type WorkerRow } from '../workers-view';
import { prSteps } from '../../src/model/pr-steps';
import { transcriptRun } from '../../src/model/sessions';
import { releaseView, type ReleaseView } from '../../src/model/release';
import type { Dashboard } from './dashboard';
import DeliverySlices from '../components/delivery-slices';
import LiveRun from '../components/live-run';
import { shortShas } from '../candidate';
import { Agent } from '../fun';

/**
 * The Workers tab (GY-116, one compact line per agent since GY-3314): every agent session across
 * every item in one table of at most 44 px rows — the agent, its item with a truncated title, a
 * state of at most three words and how long it has held it — open sessions first by time spent,
 * ended ones and the per-account summary folded.
 *
 * A row is a session handle the item carries (src/model/sessions.ts), not a Herdr listing: the
 * page draws what the control plane recorded and never asks a runtime. What the derivation is —
 * the stale threshold, the two attach forms, the order, the state words — lives in
 * `workersView` and `sessionState` (web/workers-view.ts), so a test asserts it over a fixture
 * without a browser. Opening a row unfolds that session below it: a live, read-only view of a
 * headless run's output (its run log, the same data the item page reads), the attach commands for
 * a pane session, and nothing that can type into any of them. The master's row opens the Master
 * page instead (GY-3314).
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
  worker: 'Builds code', reviewer: 'Reviews code', producer: 'Proves requirements', master: 'Runs the loop',
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

/** The health as a row carries it (GY-3314): one coloured dot beside the name, its sentence on hover. */
function Health({ row, now }: { row: WorkerRow; now: number }) {
  const { tone, text } = health(row, now);
  return <span className={`health ${tone}`} data-health={tone} data-stale={row.stale ? row.id : undefined}
    data-reconciled={row.reconciled ?? undefined} title={`${text}${row.outcome ? ` · ${shortShas(row.outcome)}` : ''}`}><span className="health-dot" aria-hidden="true"/></span>;
}

/** What the session is doing now: a builder by its item's current step, anyone else by what it was launched for, an ended one by how it ended. */
function doing(row: WorkerRow, item: Work | undefined, now: number, release: ReleaseView) {
  if (row.leftOn) return shortShas(row.subject);
  if (row.state !== 'running') return shortShas(row.reconciled ? row.subject : row.outcome ?? row.subject);
  if (row.roleKind === 'worker' && item && !row.stale) return prSteps(item, now, release).label;
  return shortShas(row.subject);
}

/**
 * What an unfolded session shows beside its output: the attach commands for a session in a pane
 * (the launcher's own form and the remote one built from its host), and a transcript path for an
 * ended session that kept one. A headless run shows its log instead (`LiveRun`); a row that
 * recorded neither says so rather than offering something that cannot work.
 */
function Attach({ row }: { row: WorkerRow }) {
  if (row.state === 'running' && !row.leftOn) {
    if (!row.local) return <p className="muted">no attach command recorded</p>;
    return <p className="attach">
      <CopyButton text={row.local} label="Copy local"/>
      {row.remote ? <CopyButton text={row.remote} label="Copy remote"/> : <span className="muted">no remote form</span>}
    </p>;
  }
  return row.transcript ? <p className="attach"><CopyButton text={row.transcript} label="Copy transcript path"/></p> : <p className="muted">no transcript recorded</p>;
}

/**
 * The session's own view, unfolded under its row (GY-3314): the full title and the doing sentence
 * the row truncates, then the live read-only output of a headless run — following its tail — or
 * the attach commands of a pane session. Nothing here can type into anything.
 */
export function SessionPanel({ row, item, now, release, token, setSelected }: { row: WorkerRow; item?: Work; now: number; release: ReleaseView; token: string; setSelected(id: string | null): void }) {
  const run = transcriptRun(row.transcript);
  return <tr className="session-view" data-view-of={row.id}><td colSpan={4}>
    <div className="session-head">
      <button type="button" className="text-button session-item" title={item?.title ?? shortShas(row.subject)} onClick={() => setSelected(row.workId)}><span className="mono">{row.key}</span>{item ? <> {item.title}</> : null}</button>
      <span className="muted">{doing(row, item, now, release)} · {row.runtime} on {row.host}</span>
    </div>
    {run ? <LiveRun workId={row.workId} run={run} token={token} live={row.state === 'running' && !row.stale && !row.leftOn}/> : <Attach row={row}/>}
  </td></tr>;
}

function Row({ row, item, now, release, open, setOpen, token, setSelected, setView }: { row: WorkerRow; item?: Work; now: number; release: ReleaseView; open: string | null; setOpen(id: string | null): void; token: string; setSelected(id: string | null): void; setView(view: string): void }) {
  const state = sessionState(row, item, now);
  // The master's row is the one exception: it opens the Master page, where its terminal lives.
  const master = row.roleKind === 'master';
  const unfold = () => master ? setView('master') : setOpen(open === row.id ? null : row.id);
  return <>
    <tr data-session={row.id} data-work={row.key} data-role={row.roleKind} className={row.stale && !row.leftOn ? 'stale' : undefined} onClick={unfold}>
      <th scope="row" data-label="Agent"><span className="agent-name"><Health row={row} now={now}/><Agent id={row.principal} master={master} detail={`${row.runtime} on ${row.host}`}/></span></th>
      <td data-label="Working on"><button type="button" className="text-button row-open" aria-expanded={master ? undefined : open === row.id} title={item?.title ?? shortShas(row.subject)} onClick={event => { event.stopPropagation(); unfold(); }}><span className="mono">{row.key}</span> <span className="row-title">{item ? item.title : shortShas(row.subject)}</span></button></td>
      <td data-label="State" data-state={state.words}>{state.words}</td>
      <td data-label="Age" data-since={state.since}><span className="spent">{spent(now - Date.parse(state.since))}</span></td>
    </tr>
    {open === row.id && <SessionPanel key={`${row.id}:view`} row={row} item={item} now={now} release={release} token={token} setSelected={setSelected}/>}
  </>;
}

const columns = ['Agent', 'Working on', 'State', 'Age'];
function Table({ rows, label, work, now, release, open, setOpen, token, setSelected, setView }: { rows: WorkerRow[]; label: string; work: Work[]; now: number; release: ReleaseView; open: string | null; setOpen(id: string | null): void; token: string; setSelected(id: string | null): void; setView(view: string): void }) {
  const byId = new Map(work.map(item => [item.id, item]));
  return <table className="sessions-table workers" aria-label={label}>
    <colgroup><col className="col-agent"/><col/><col className="col-state"/><col className="col-age"/></colgroup>
    <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.map(row => <Row key={`${row.workId}:${row.id}`} row={row} item={byId.get(row.workId)} now={now} release={release} open={open} setOpen={setOpen} token={token} setSelected={setSelected} setView={setView}/>)}</tbody>
  </table>;
}

/** One line per agent account: what it is on now, and how many sessions it ran in the last day. Folded away below the sessions. */
function Accounts({ principals, setSelected }: { principals: PrincipalSummary[]; setSelected(id: string | null): void }) {
  return <table className="sessions-table" aria-label="Principals">
    <thead><tr><th scope="col">Account</th><th scope="col">Role</th><th scope="col">Working on</th><th scope="col">For</th><th scope="col">Sessions today</th></tr></thead>
    <tbody>{principals.map(entry => <tr key={entry.principal} data-principal={entry.principal} data-current={entry.current ? `${entry.current.key}:${entry.current.epoch ?? ''}` : 'idle'}>
      <th scope="row" data-label="Account"><Agent id={entry.principal}/></th>
      <td data-label="Role">{roleWords[entry.roleKind]}</td>
      <td data-label="Working on">{entry.current ? <button type="button" className="text-button" onClick={() => setSelected(entry.current!.workId)}>{entry.current.key}</button> : <span className="muted">idle</span>}</td>
      <td data-label="For">{entry.current ? spent(entry.current.sinceMs) : '—'}</td>
      <td data-label="Sessions today">{entry.sessionsLast24h}</td>
    </tr>)}</tbody>
  </table>;
}

function ProjectMemorySection({ memory }: { memory?: any }) {
  if (!memory || (!memory.notes?.length && !memory.changes?.length)) return null;
  const count = (memory.notes?.length ?? 0) + (memory.changes?.length ?? 0);
  return <details className="finished-sessions project-memory" data-project-memory open>
    <summary>Shared project memory <span className="count">{count}</span></summary>
    <div className="memory-content">
      {memory.notes?.length ? (
        <div className="memory-block">
          <h3>Recent notes</h3>
          <ul className="memory-list">
            {memory.notes.map((n: any) => (
              <li key={n.id} data-note={n.id}>
                <span className="mono bold">{n.key}</span> ({n.kind}): {n.text} <span className="muted">· by {n.by}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {memory.changes?.length ? (
        <div className="memory-block">
          <h3>Recent merges</h3>
          <ul className="memory-list">
            {memory.changes.map((c: any) => (
              <li key={c.sha} data-change={c.sha}>
                <span className="mono bold">{c.key}</span> (<span className="mono">{shortShas(c.sha)}</span>): {c.files?.join(', ') || 'no files'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  </details>;
}

/**
 * The Workers page (GY-161, one compact line per agent since GY-3314): one table of the agent
 * sessions open now — the agent, its item with a truncated title, its state of at most three
 * words and how long it has held it — where each row unfolds its session's live, read-only view,
 * with the sessions that ended and the per-account summary folded below.
 */
export default function WorkersPage({ work, observedAt, setSelected, setView, token, status }: Pick<Dashboard, 'work' | 'observedAt' | 'setSelected' | 'setView' | 'token'> & { status?: Dashboard['status'] }) {
  const now = useLiveNow(observedAt);
  const release = releaseView(status);
  const view = workersView(work, new Date(now), undefined, release);
  const [open, setOpen] = useState<string | null>(null);
  // A session the runtime no longer reports is not open: it is listed, marked, but never counted as working.
  const stale = view.running.filter(row => row.stale).length;
  const openCount = view.running.length - stale;
  const table = (rows: WorkerRow[], label: string) => <Table rows={rows} label={label} work={work} now={now} release={release} open={open} setOpen={setOpen} token={token} setSelected={setSelected} setView={setView}/>;
  return <>
    <div className="page-heading"><div><h1>Workers</h1><p className="summary">{openCount} agent {openCount === 1 ? 'session' : 'sessions'} open.{stale ? ` ${stale} not seen recently.` : ''} {view.finished.length} ended.</p></div></div>
    {view.running.length ? table(view.running, 'Agent sessions') : <p className="muted">No agent session is open.</p>}
    <p className="muted workers-note">Building means an agent is writing the change; Rework, that it is making the requested changes; In review, someone else judges it; Proving runs the proofs; the Master runs the loop. An agent never reviews or approves its own work. A session not seen for {Math.round(sessionStaleThresholdMs / 60_000)} minutes reads Not seen, never as live.</p>
    <ProjectMemorySection memory={status?.projectMemory}/>
    <details className="finished-sessions"><summary>Ended <span className="count">{view.finished.length}</span></summary>
      {view.finished.length ? table(view.finished, 'Ended sessions') : <p className="muted">No session has ended yet.</p>}
    </details>
    <details className="finished-sessions accounts"><summary>By account <span className="count">{view.principals.length}</span></summary>
      {view.principals.length ? <Accounts principals={view.principals} setSelected={setSelected}/> : <p className="muted">No agent has worked here yet.</p>}
    </details>
    <DeliverySlices status={status}/>
  </>;
}
