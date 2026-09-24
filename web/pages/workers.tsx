import { useEffect, useRef, useState } from 'react';
import { sessionStaleThresholdMs, workersView, type PrincipalSummary, type WorkerRow } from '../workers-view';
import type { Dashboard } from './dashboard';
import DeliverySlices from '../components/delivery-slices';

/**
 * The Workers tab (GY-116): every agent session across every item in one table — who it is, what
 * it is on, how long it has spent, and the command that attaches to it — read for triage: running
 * rows first by time spent, finished rows collapsed, and one line per principal on top.
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
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—';

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

/** The state column: live, stale (recorded running but not seen inside the threshold), or finished with why. */
function State({ row }: { row: WorkerRow }) {
  if (row.stale) return <span className="pulse-badge stale" data-stale={row.id}>recorded running, not seen since {when(row.stale.since)}</span>;
  if (row.state === 'running') return <span className="green-text">running{row.outcome ? ` · ${row.outcome}` : ''}</span>;
  return <span>finished{row.reconciled ? <> · <span className="amber" data-reconciled={row.reconciled}>ended by liveness reconciliation ({row.reconciled}): {row.outcome}</span></> : row.outcome ? ` · ${row.outcome}` : ''}</span>;
}

function Attach({ row }: { row: WorkerRow }) {
  if (row.state === 'running') {
    if (!row.local) return <span className="muted">no attach command recorded</span>;
    return <span className="attach">
      <CopyButton text={row.local} label="Copy local"/>
      {row.remote ? <CopyButton text={row.remote} label="Copy remote"/> : <span className="muted">no remote form</span>}
    </span>;
  }
  return row.transcript ? <CopyButton text={row.transcript} label="Copy transcript path"/> : <span className="muted">no transcript recorded</span>;
}

function Row({ row, setSelected }: { row: WorkerRow; setSelected(id: string | null): void }) {
  return <tr data-session={row.id} data-work={row.key} data-role={row.roleKind} className={row.stale ? 'stale' : undefined}>
    <th scope="row">{row.agentName ?? '—'} <span className="muted">{row.principal}</span></th>
    <td>{row.roleKind}{row.role && row.role !== row.kind ? <span className="muted"> ({row.role})</span> : ''}</td>
    <td><button type="button" className="text-button" onClick={() => setSelected(row.workId)}>{row.key}{row.epoch !== null ? ` · epoch ${row.epoch}` : ''}</button></td>
    <td>{row.subject}</td>
    <td>{row.host}<span className="muted"> · {row.runtime}{row.pane ? ` · pane ${row.pane}` : ''}</span></td>
    <td><State row={row}/></td>
    <td>{when(row.startedAt)}</td>
    <td data-spent={row.spentMs}>{spent(row.spentMs)}</td>
    <td><Attach row={row}/></td>
  </tr>;
}

const columns = ['Agent', 'Role', 'Item', 'Subject', 'Host', 'State', 'Started', 'Time spent', 'Attach'];
function Table({ rows, label, setSelected }: { rows: WorkerRow[]; label: string; setSelected(id: string | null): void }) {
  return <table className="flow-data" aria-label={label}>
    <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{rows.map(row => <Row key={`${row.workId}:${row.id}`} row={row} setSelected={setSelected}/>)}</tbody>
  </table>;
}

function Principals({ principals, setSelected }: { principals: PrincipalSummary[]; setSelected(id: string | null): void }) {
  return <table className="flow-data" aria-label="Principals">
    <thead><tr><th scope="col">Principal</th><th scope="col">Role</th><th scope="col">Currently on</th><th scope="col">For</th><th scope="col">Sessions in the last 24 hours</th></tr></thead>
    <tbody>{principals.map(entry => <tr key={entry.principal} data-principal={entry.principal} data-current={entry.current ? `${entry.current.key}:${entry.current.epoch ?? ''}` : 'idle'}>
      <th scope="row">{entry.principal}</th>
      <td>{entry.roleKind}</td>
      <td>{entry.current ? <button type="button" className="text-button" onClick={() => setSelected(entry.current!.workId)}>{entry.current.key}{entry.current.epoch !== null ? ` · epoch ${entry.current.epoch}` : ''}</button> : <span className="muted">idle</span>}</td>
      <td>{entry.current ? spent(entry.current.sinceMs) : '—'}</td>
      <td>{entry.sessionsLast24h}</td>
    </tr>)}</tbody>
  </table>;
}

/** Every session handle across every item, running first, for the operator who wants to see who is doing what and watch one. */
export default function WorkersPage({ work, observedAt, setSelected, status }: Pick<Dashboard, 'work' | 'observedAt' | 'setSelected'> & { status?: Dashboard['status'] }) {
  const now = useLiveNow(observedAt);
  const view = workersView(work, new Date(now));
  const stale = view.running.filter(row => row.stale).length;
  return <>
    <div className="page-heading"><div><h1>Workers</h1><p>Every agent session the control plane has a handle for — worker, reviewer, producer, approver, escalation handler and master — with what it is on, how long it has spent, and the command that attaches to it. Running sessions first, longest first. A session not seen for {Math.round(sessionStaleThresholdMs / 60_000)} minutes is marked, never shown as live; the liveness sweep is what ends a dead one.</p></div></div>
    <section><div className="section-title"><h2>Principals <span className="count">{view.principals.length}</span></h2></div>
      {view.principals.length ? <Principals principals={view.principals} setSelected={setSelected}/> : <p className="muted">No worker, reviewer or producer has recorded a session yet.</p>}
    </section>
    <section><div className="section-title"><h2>Running <span className="count">{view.running.length}</span></h2>{stale > 0 && <span className="amber" role="status">{stale} recorded running but not seen recently</span>}</div>
      {view.running.length ? <Table rows={view.running} label="Running sessions" setSelected={setSelected}/> : <p className="muted">No session is running.</p>}
    </section>
    <details className="finished-sessions"><summary>Finished <span className="count">{view.finished.length}</span></summary>
      {view.finished.length ? <Table rows={view.finished} label="Finished sessions" setSelected={setSelected}/> : <p className="muted">No session has finished yet.</p>}
    </details>
    <DeliverySlices status={status}/>
  </>;
}
