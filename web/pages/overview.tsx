import { useState } from 'react';
import type { Work } from '../../src/model';
import SessionBadge from '../components/session-badge';
import Term, { Explained } from '../components/term';
import StatusAge from '../components/status-age';
import WorkCard from '../components/work-card';
import { CandidatePr } from '../candidate';
import { age } from '../format';
import { formatAge, formatDuration } from '../duration';
import { homeNumbers } from '../home-numbers';
import { byAttention, phaseLabel, phaseOf, phases, plainStatus, statusHeld, type Phase } from '../plain-status';
import type { Dashboard } from './dashboard';

const week = 7 * 24 * 60 * 60 * 1000;
const openPhases = phases.filter(phase => phase !== 'shipped');

/**
 * The home page answers three questions on one screen: what is stuck and why, what is in
 * progress, and what shipped recently. One row of counts — the stages — plus the open total in
 * the page heading and, when there is any, one highlighted stuck count; nothing is counted
 * twice, on this page or beside it: the sidebar's Work entry carries no count, and a board
 * column is headed by its stage name alone. Everything else about an item is one click away in
 * its details; analytics live under Insights.
 */
export default function OverviewPage({ work, status, filter, setFilter, query, setQuery, setSelected, setCreating, setView, observedAt, queue }: Dashboard) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [board, setBoard] = useState(false);
  const [timings, setTimings] = useState(false);
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const numbers = homeNumbers(work, now);
  const match = (w: Work) => `${w.key} ${w.title}`.toLowerCase().includes(query.toLowerCase()) && (!phase || phaseOf(w, now) === phase) && (!filter || w.stage === filter);
  const open = byAttention(work.filter(w => w.stage !== 'done' && match(w)), now);
  const stuck = open.filter(w => plainStatus(w, now).tone === 'stuck');
  const moving = open.filter(w => plainStatus(w, now).tone !== 'stuck');
  const inProgress = moving.filter(w => !['needs-worker', 'not-started'].includes(phaseOf(w, now)));
  const waiting = moving.filter(w => phaseOf(w, now) === 'needs-worker');
  const notStarted = moving.filter(w => phaseOf(w, now) === 'not-started');
  const shippedAt = (w: Work) => Date.parse(w.observation?.mergedAt ?? w.stageEnteredAt);
  const recent = work.filter(w => w.stage === 'done' && now - shippedAt(w) <= week && match(w)).sort((a, b) => shippedAt(b) - shippedAt(a));
  const card = (w: Work) => <WorkCard key={w.id} item={w} repository={status?.repository} now={now} onOpen={setSelected}/>;
  const list = (title: string, items: Work[], note?: string, attention = false) => items.length > 0 && <section className={attention ? 'work-list attention' : 'work-list'} aria-label={title}><h2>{attention ? <>{title} <span className="count">{items.length}</span></> : title}{note && <small> {note}</small>}</h2><div className="cards">{items.map(card)}</div></section>;
  const slices = (status?.delegation?.slices ?? []).filter((slice: any) => slice.lead);
  // One row of counts: the stages that hold something. A stage with nothing in it takes no tile.
  const stages = openPhases.filter(p => numbers.byPhase[p] > 0);
  const dwell = (p: Phase) => {
    const times = work.filter(w => w.stage !== 'done' && phaseOf(w, now) === p).map(w => now - Date.parse(w.stageEnteredAt)).sort((a, b) => a - b);
    return times.length ? <span title="Time in this stage for its open items: the oldest, then the 50th and 95th percentile">{`oldest ${age(new Date(now - times.at(-1)!).toISOString())} · p50 ${formatDuration(times[Math.floor(times.length * .5)] / 60000)} · p95 ${formatDuration(times[Math.min(times.length - 1, Math.floor(times.length * .95))] / 60000)}`}</span> : null;
  };
  return <>
    <div className="page-heading"><h1>Work <span className="count" title="Work items not shipped yet">{numbers.open}</span></h1>{status?.actor?.role === 'admin' && <button onClick={() => setCreating(true)}>＋ New work item</button>}</div>
    {status && !status.github && <div className="notice">GitHub is not connected, so nothing can merge yet. <a href="/docs/github">Set it up ↗</a></div>}
    {status?.appPermissions?.attention?.length > 0 && <div className="notice danger" role="alert"><strong>GitHub App permissions need attention.</strong>{status.appPermissions.attention.map((line: string) => <p key={line}>{line}</p>)}{status.heldJobs > 0 && <p>{status.heldJobs} integration job{status.heldJobs === 1 ? ' is' : 's are'} held rather than retried until the permission is accepted.</p>}{/^https:\/\/github\.com\//.test(status.appPermissions.installationUrl ?? '') && <a href={status.appPermissions.installationUrl} target="_blank" rel="noreferrer noopener">Review the App installation on GitHub ↗</a>} <a href="/docs/github#app-permissions">Migration guide ↗</a></div>}
    {status?.fleet && !status.fleet.configured && <p className="muted fleet-line">The agent fleet is not configured yet, so sessions launch from each host's local profiles · <button className="text-button" onClick={() => setView('fleet')}>Set up the fleet ↗</button></p>}
    {status?.fleet?.configured && <p className="muted fleet-line">Agent fleet: {status.fleet.accounts.length} account{status.fleet.accounts.length === 1 ? '' : 's'} across {status.fleet.runtimes.length} runtime{status.fleet.runtimes.length === 1 ? '' : 's'}{status.fleet.accounts.some((account: any) => !account.eligible) ? <> · <span className="amber">{status.fleet.accounts.filter((account: any) => !account.eligible).length} ineligible</span></> : ' · all eligible'} · <button className="text-button" onClick={() => setView('fleet')}>Open the fleet ↗</button></p>}
    {status?.jobs?.length > 0 && <div className="notice danger">{status.jobs.length} GitHub update(s) failed: {status.jobs[0].error}</div>}
    {status?.executors?.attention?.length > 0 && <div className="notice danger" role="alert" aria-label="Unserved actions"><strong>{status.executors.live === 0 ? 'No executor is running.' : `No executor serves ${status.executors.attention.map((entry: any) => entry.kind).join(', ')}.`}</strong> {status.executors.attention.map((entry: any) => <p key={entry.kind}>{entry.text}</p>)}<p className="muted">An action nobody can claim is not queued behind other work; nothing moves until an executor of its kind is started. <a href="/docs/master-agent#running-executors-under-supervision">How executors are supervised ↗</a></p></div>}
    {stages.length > 0 && <section className="stage-strip" aria-label="Stages">
      <div className="graph">{stages.map(p => <button key={p} className={`node ${phase === p ? 'selected' : ''}`} aria-pressed={phase === p} onClick={() => setPhase(phase === p ? null : p)}><span>{phaseLabel[p]}</span><strong>{numbers.byPhase[p]}</strong>{timings && <small>{dwell(p)}</small>}</button>)}</div>
    </section>}
    {slices.length > 0 && <section aria-label="Delivery slices"><h2><Term term="delivery slice">Delivery slices</Term></h2><div className="cards">{status.delegation.slices.map((slice: any) => <div className="slice-card" key={slice.id}>
      <div className="card-top"><span>{slice.name}</span>{slice.lead ? <SessionBadge kind={slice.lead.sessionKind} suffix="lead"/> : <span className="identity none">No lead assigned</span>}</div>
      <h3>{slice.lead ? slice.lead.displayName ?? slice.lead.id : 'Unassigned'}</h3>
      <p>{(slice.engineers ?? slice.workers).length}/{status.delegation.limits.maxEngineersPerLead} active engineers · {slice.workers.length} {slice.workers.length === 1 ? 'claimed item' : 'claimed items'} · {slice.bottlenecks.length} {slice.bottlenecks.length === 1 ? 'bottleneck' : 'bottlenecks'}</p>
      <p className="muted">Workers: {slice.workers.length ? slice.workers.map((worker: any) => <span className="session" key={worker.key}>{worker.key} · {worker.displayName ?? worker.id} <SessionBadge kind={worker.sessionKind}/></span>) : 'none'}</p>
      <p className="muted">Bottlenecks: {slice.bottlenecks.length ? slice.bottlenecks.map((bottleneck: any) => `${bottleneck.key} — ${bottleneck.reason}`).join(' · ') : 'none'}</p>
    </div>)}</div><p className="muted">Independent review/proof sessions ({status.delegation.reviewers.length}): {status.delegation.reviewers.length ? status.delegation.reviewers.map((agent: any) => <span className="session" key={agent.id}>{agent.displayName ?? agent.id} <SessionBadge kind={agent.sessionKind}/></span>) : 'none configured'}</p></section>}
    <div className="list-tools"><button className="text-button" onClick={() => setTimings(v => !v)} aria-expanded={timings}>{timings ? 'Hide times' : 'Show times'}</button>{(phase || filter) && <button className="text-button" onClick={() => { setPhase(null); setFilter(null); }}>Clear filter ×</button>}<input aria-label="Search work" placeholder="Search work…" value={query} onChange={e => setQuery(e.target.value)}/><button className="text-button" aria-pressed={board} onClick={() => setBoard(v => !v)}>{board ? 'List view' : 'Board view'}</button></div>
    <div className="home-columns"><div>
    {work.length === 0 ? <div className="empty"><h2>No work yet.</h2><p>Create a work item, say what must be true when it is done, and an agent will pick it up.</p>{status?.actor?.role === 'admin' && <button onClick={() => setCreating(true)}>Create the first work item</button>}</div>
      : board ? <div className="board">{openPhases.map(p => <div className="column" key={p}><h3>{phaseLabel[p]}</h3>{open.filter(w => phaseOf(w, now) === p).map(card)}</div>)}</div>
      : <>{list('Stuck', stuck, undefined, true)}{list('In progress', inProgress)}{list('Needs a worker', waiting)}
        {notStarted.length > 0 && <details className="work-list"><summary>Not started</summary><div className="cards">{notStarted.map(card)}</div></details>}
        {!open.length && <p className="muted">No open item matches.</p>}</>}
    </div><aside>
    {queue.length > 0 && <section className="graph-section" aria-label="Merge queue"><h2><Term term="merge queue">Merge queue</Term> <span className="count">{queue.length}</span></h2>{queue.map(entry => { const item = work.find(w => w.id === entry.id); const held = item && statusHeld(item, now); return <button className={`card${held?.overdue ? ' overdue' : ''}`} key={entry.id} onClick={() => setSelected(entry.id)}><div className="card-top"><span>{entry.position + 1}. {entry.key}</span>{held && <StatusAge held={held}/>}</div><p className="reason">{entry.predecessors.length ? `Behind ${entry.predecessors.join(', ')}` : 'Next to merge'} · {entry.current ? 'tested with the changes ahead of it' : 'being re-tested'} · queued {formatAge(entry.enqueuedAt, now)} ago</p></button>; })}</section>}
    <section className="work-list shipped-recently" aria-label="Shipped this week"><h2>Shipped this week <span className="count">{numbers.shippedThisWeek}</span></h2>
      {recent.length ? <ul className="shipped-list">{recent.slice(0, 5).map(w => <li key={w.id}><button className="text-button" onClick={() => setSelected(w.id)}>{w.key} <span data-title>{w.title}</span></button>{w.candidate && <CandidatePr repository={status?.repository} candidate={w.candidate} workKey={w.key}/>}{plainStatus(w, now).tone === 'stuck' && <span className="danger-text"><Explained sentence={plainStatus(w, now).blocking!}/></span>}</li>)}</ul> : <p className="muted">Nothing shipped in the last seven days.</p>}
      {work.some(w => w.stage === 'done') && <button className="text-button" onClick={() => setView('shipped')}>See everything shipped →</button>}
    </section>
    </aside></div>
  </>;
}
