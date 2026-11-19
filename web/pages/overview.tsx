import Replay from '../components/work-replay';
import { isClosed, type Work } from '../../src/model';
import { mayChangePriority } from '../components/priority';
import WorkCard from '../components/work-card';
import TasteFeed from '../components/taste';
import { StepNames } from '../components/steps-bar';
import { GroupDot } from '../components/status-badge';
import { groupLabel, mergedAt, shippedCounts, groupMeaning, groups, summarySentence, upNextTile, type BoardItem, type OpenGroup } from '../groups';
import { releaseView } from '../../src/model/release';
import { liveFailingLine, plainStage, serveView } from '../../src/model/plain-stage';
import { stalledCards } from '../../src/model/actionless';
import type { Dashboard } from './dashboard';
import { BuildLine } from '../fun';
import { useGlide } from '../glide';
import { EmptyState } from '../components/page-layout';
import { WhereItRuns } from '../components/where-it-runs';
import { pipelineSentence, type PipelineTime } from '../../src/pipeline-speed';

/**
 * The Work page with its motion (GY-3272 AC-4b): on every render, a row that changed group is
 * glided to its new place. The page's own body (OverviewPage, the default export below) stays
 * hook-free — the dashboard's unit tests read it as a plain function, tiles and all.
 */
export function WorkPage(dashboard: Dashboard) {
  useGlide();
  return OverviewPage(dashboard);
}

/** GY-3527: the page's headline, merges an hour over the last 24 hours, and under it one line on how long an item takes; a warning names the item to open. */
function Speed({ time, now, open }: { time?: PipelineTime | null; now: number; open: (id: string) => void }) {
  if (!time) return null;
  const line = pipelineSentence(time, now);
  return <div className="speed">
    <p className="speed-figure" data-speed-figure>{line.figure}</p>
    <p className="speed-line" data-speed-line={line.warning ? 'warning' : 'calm'}>
      {line.text}{line.open && <> <button type="button" className="text-button" onClick={() => open(line.open!)}>Open →</button></>}
    </p>
  </div>;
}

/**
 * The Work page (GY-161) answers "what is happening and what do I do next" on one screen, with
 * one classification: every open item is in exactly one group, as `GET /api/board` serves it
 * (src/model/board.ts, GY-200) — the page derives no group of its own, so it cannot disagree with
 * the board `master status` reads — each summary tile
 * counts one group and filters the page to exactly that group's rows, and the lists below are
 * those same groups — so a number on the page is always the number of rows it stands for.
 * Needs you comes first, with the one action to take; Backlog is folded away and carries no
 * clock. What shipped is one line at the foot, linking to the Shipped page: shipped means the live
 * commit contains it (GY-3452), worded and counted as the top bar shows it, beside the week's merges
 * still going live, and the newest merge in its plain stage.
 */
export default function OverviewPage({ work, board, status, query, setQuery, setSelected, setCreating, setView, observedAt, filter: only, setFilter: setOnly, action, busy, api, token }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const match = (w: Pick<Work, 'key' | 'title'>) => `${w.key} ${w.title}`.toLowerCase().includes(query.toLowerCase());
  const release = releaseView(status);
  const serve = serveView(status);
  // Each group's rows are the board's, in the board's order; the item documents the rows render come from the snapshot.
  const byId = new Map(work.map(w => [w.id, w]));
  const rowsOf = (entries: BoardItem[]) => entries.filter(match).flatMap(entry => byId.has(entry.id) ? [byId.get(entry.id)!] : []);
  const byGroup = Object.fromEntries(groups.map(group => [group, board ? rowsOf(board.groups[group]) : []])) as Record<OpenGroup, Work[]>;
  const counts = Object.fromEntries(groups.map(group => [group, byGroup[group].length])) as Record<OpenGroup, number>;
  const queues = new Map(board ? board.groups.moving.flatMap(entry => entry.queue ? [[entry.id, entry.queue] as const] : []) : []);
  const stalls = new Map(stalledCards(work.filter(w => w.stage !== 'done' && !isClosed(w)), now).map(card => [card.item.id, card]));
  // GY-3452: shipped means live — the week's merges the live commit contains; the rest wait to go live. The top bar reads the same count.
  const { shipped, waiting } = shippedCounts(work, status?.live, now);
  // The latest is the newest merge (GY-168), named with its plain stage (GY-2988).
  const latest = [...shipped, ...waiting].reduce<Work | null>((newest, w) => !newest || mergedAt(w) > mergedAt(newest) ? w : newest, null);
  const row = (w: Work, group: OpenGroup) => <WorkCard key={w.id} item={w} all={work} group={group} stall={group === 'blocked' ? stalls.get(w.id) : undefined} queue={queues.get(w.id)} repository={status?.repository} now={now} onOpen={setSelected} release={release} busy={busy} onPriority={mayChangePriority(status?.actor) ? priority => { void action(w.id, 'priority', { priority, source: 'dashboard' }); } : undefined}/>;
  const shown = (group: OpenGroup) => !only || only === group;
  const section = (group: OpenGroup, note?: string) => shown(group) && (byGroup[group].length > 0 || (group === 'needs-you' && only === group)) && <section key={group} className={`panel work-group group-${group}`} aria-label={groupLabel[group]} data-group-section={group}>
    <h2><GroupDot group={group}/>{groupLabel[group]} <span className="count">{byGroup[group].length}</span>{note && <small>{note}</small>}{group === 'needs-you' && <button type="button" className="text-button push" onClick={() => setView('needs-you')}>Every request and answer →</button>}</h2>
    {group === 'moving' && <div className="row-head" aria-hidden="true"><span/><span/><span className="row-steps"><StepNames/></span><span>Who acts next</span><span>In step</span></div>}
    <div className="rows">{byGroup[group].map(w => row(w, group))}</div>
  </section>;
  const admin = status?.actor?.role === 'admin';
  return <>
    <Speed time={status?.pipelineTime} now={now} open={setSelected}/>
    <div className="page-heading"><div><h1>Work</h1><p className="page-fact">{board ? summarySentence(counts) : 'Reading the board…'}</p><BuildLine/></div>
      <div className="page-actions"><label className="search"><input aria-label="Search work" placeholder="Search by key or title" value={query} onChange={e => setQuery(e.target.value)}/></label>
        {admin && <button type="button" onClick={() => setCreating(true)}>＋ New work item</button>}</div></div>
    {status?.jobs?.length > 0 && <div className="notice danger">{status.jobs.length} integration update(s) failed: {status.jobs[0].error}</div>}
    {work.length === 0 ? <EmptyState title="The yard is quiet. File a goal and wake the crew." action={admin && <button type="button" onClick={() => setCreating(true)}>Create the first work item</button>}>Create a work item, say what must be true when it is done, and an agent will pick it up.</EmptyState> : <>
      <div role="group" aria-label="Filter by group" className="tiles">{groups.map(group => <button type="button" key={group} className={`tile group-${group}${only === group ? ' selected' : ''}${counts[group] === 0 ? ' empty-tile' : ''}`} aria-pressed={only === group} data-tile={group} onClick={() => setOnly(only === group ? null : group)}>
        <span className="tile-label"><GroupDot group={group}/>{groupLabel[group]}</span><strong>{counts[group]}</strong><small>{group === 'up-next' ? upNextTile(board ? board.groups['up-next'].filter(match) : []) : groupMeaning[group]}</small>
      </button>)}</div>
      {only && <p className="filter-note">Showing {groupLabel[only]} only · <button type="button" className="text-button" onClick={() => setOnly(null)}>Show every group</button></p>}
      {section('needs-you', 'only you can decide these')}
      {section('blocked')}
      {section('moving')}
      {section('up-next')}
      {shown('backlog') && byGroup.backlog.length > 0 && <details className="panel work-group group-backlog" aria-label="Backlog" data-group-section="backlog" open={only === 'backlog'}>
        <summary><GroupDot group="backlog"/>Backlog <span className="count">{byGroup.backlog.length}</span></summary>
        <div className="rows">{byGroup.backlog.map(w => row(w, 'backlog'))}</div>
      </details>}
      {board && groups.every(group => counts[group] === 0) && <p className="muted">{query ? 'No open item matches.' : 'Inbox zero, factory edition.'}</p>}
      <div className="shipped-line" aria-label="Shipped this week">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>
        <span><strong data-shipped={shipped.length} title="Merged this week and live">{shipped.length} shipped</strong>, <span data-waiting={waiting.length}>{waiting.length} going live</span>.{latest && <> Latest: <button type="button" className="text-button" data-latest={latest.key} onClick={() => setSelected(latest.id)}><span className="mono">{latest.key}</span></button> · {plainStage(latest, now, release, serve)}</>}{liveFailingLine(serve) && <span className="danger-text" data-live-failing> {liveFailingLine(serve)}.</span>}</span>
        <button type="button" className="text-button push" onClick={() => setView('shipped')}>Shipped →</button>
      </div>
      {/* GY-3393: what shipped and awaits the owner's taste, with its evidence; tasting gates nothing. The fold
          sits after the shipped line so its folded cards never precede the page's visible text in the DOM —
          a case's text lookup finds the visible words first. */}
      <TasteFeed work={work} status={status} token={token} observedAt={now} busy={busy} action={action} setSelected={setSelected}/>
    </>}
    <WhereItRuns status={status} now={now}/>
    <Replay api={api} onOpen={setSelected}/>
  </>;
}
