import { isClosed, type Work } from '../../src/model';
import WorkCard from '../components/work-card';
import { StepNames } from '../components/steps-bar';
import { GroupDot } from '../components/status-badge';
import { formatAge } from '../../src/model/duration';
import { groupLabel, mergedAt, shippedThisWeek, groupMeaning, groups, summarySentence, upNextTile, type BoardItem, type OpenGroup } from '../groups';
import { releaseView, servedFor } from '../../src/model/release';
import { liveFailingLine, plainStage, serveView } from '../../src/model/plain-stage';
import { stalledCards } from '../../src/model/actionless';
import type { Dashboard } from './dashboard';

const week = 7 * 24 * 60 * 60 * 1000;

/**
 * The Work page (GY-161) answers "what is happening and what do I do next" on one screen, with
 * one classification: every open item is in exactly one group, as `GET /api/board` serves it
 * (src/model/board.ts, GY-200) — the page derives no group of its own, so it cannot disagree with
 * the board `master status` reads — each summary tile
 * counts one group and filters the page to exactly that group's rows, and the lists below are
 * those same groups — so a number on the page is always the number of rows it stands for.
 * Needs you comes first, with the one action to take; Backlog is folded away and carries no
 * clock. What shipped is one line at the foot, linking to the Shipped page: shipped means the
 * release was observed serving it, dated from that observation. The latest is the newest merge
 * (GY-168), whether or not a release was recorded for it; the merges not yet seen live are the
 * ones the control plane's production observation reports unserved — none where production serves
 * the newest merge, and none claimed where nothing observes production.
 */
export default function OverviewPage({ work, board, status, query, setQuery, setSelected, setCreating, setView, observedAt, filter: only, setFilter: setOnly }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const match = (w: Pick<Work, 'key' | 'title'>) => `${w.key} ${w.title}`.toLowerCase().includes(query.toLowerCase());
  const release = releaseView(status);
  const serve = serveView(status);
  // Each group's rows are the board's, in the board's order; the item documents the rows render come from the snapshot.
  const byId = new Map(work.map(w => [w.id, w]));
  const rowsOf = (entries: BoardItem[]) => entries.filter(match).flatMap(entry => byId.has(entry.id) ? [byId.get(entry.id)!] : []);
  const byGroup = Object.fromEntries(groups.map(group => [group, board ? rowsOf(board.groups[group]) : []])) as Record<OpenGroup, Work[]>;
  const counts = Object.fromEntries(groups.map(group => [group, byGroup[group].length])) as Record<OpenGroup, number>;
  const stalls = new Map(stalledCards(work.filter(w => w.stage !== 'done' && !isClosed(w)), now).map(card => [card.item.id, card]));
  // Shipped this week: delivered and served by the release, dated from when it was seen live.
  const recent = shippedThisWeek(work, now, release);
  // The latest is the newest merge: most real deliveries carry no release record, so ordering by
  // release would name an old item, or none. A legacy delivery with no delivery record is dated
  // from its observed merge (`mergedAt`), so it counts too.
  const merged = work.filter(w => w.stage === 'done' && !isClosed(w) && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt) && Number.isFinite(mergedAt(w)));
  const latest = merged.length ? merged.reduce((newest, w) => mergedAt(w) > mergedAt(newest) ? w : newest) : null;
  // Merged this week but not yet seen live, as the production observation says, whatever its group:
  // a merge the production watch reports pending or failed, or merged after its last pass. With no
  // production observation nothing is claimed: a smoke-gated merge is not "not live" by default.
  // A legacy merge with no delivery record is Shipped on the board (groupOf), so it is never counted.
  const unreleased = release.observedAt === null ? 0 : merged.filter(w => !!w.delivery && now - mergedAt(w) <= week && !servedFor(w, release)
    && (release.unserved.has(w.key) || release.failed.has(w.key) || mergedAt(w) > release.observedAt!)).length;
  const row = (w: Work, group: OpenGroup) => <WorkCard key={w.id} item={w} all={work} group={group} stall={group === 'blocked' ? stalls.get(w.id) : undefined} repository={status?.repository} now={now} onOpen={setSelected} release={release}/>;
  const shown = (group: OpenGroup) => !only || only === group;
  const section = (group: OpenGroup, note?: string) => shown(group) && byGroup[group].length > 0 && <section key={group} className={`work-group group-${group}`} aria-label={groupLabel[group]} data-group-section={group}>
    <h2><GroupDot group={group}/>{groupLabel[group]} <span className="count">{byGroup[group].length}</span>{note && <small>{note}</small>}{group === 'needs-you' && <button type="button" className="text-button push" onClick={() => setView('needs-you')}>Every request and answer →</button>}</h2>
    {group === 'moving' && <div className="row-head" aria-hidden="true"><span/><span/><span className="row-steps"><StepNames/></span><span>Who acts next</span><span>In step</span></div>}
    <div className="rows">{byGroup[group].map(w => row(w, group))}</div>
  </section>;
  const admin = status?.actor?.role === 'admin';
  return <>
    <div className="page-heading"><div><h1>Work</h1><p className="summary">{board ? summarySentence(counts) : 'Reading the board…'}</p></div>
      <div className="heading-tools"><label className="search"><input aria-label="Search work" placeholder="Search by key or title" value={query} onChange={e => setQuery(e.target.value)}/></label>
        {admin && <button type="button" onClick={() => setCreating(true)}>＋ New work item</button>}</div></div>
    {status?.jobs?.length > 0 && <div className="notice danger">{status.jobs.length} integration update(s) failed: {status.jobs[0].error}</div>}
    {work.length === 0 ? <div className="empty"><h2>No work yet.</h2><p>Create a work item, say what must be true when it is done, and an agent will pick it up.</p>{admin && <button type="button" onClick={() => setCreating(true)}>Create the first work item</button>}</div> : <>
      <div role="group" aria-label="Filter by group" className="tiles">{groups.map(group => <button type="button" key={group} className={`tile group-${group}${only === group ? ' selected' : ''}${counts[group] === 0 ? ' empty-tile' : ''}`} aria-pressed={only === group} data-tile={group} onClick={() => setOnly(only === group ? null : group)}>
        <span className="tile-label"><GroupDot group={group}/>{groupLabel[group]}</span><strong>{counts[group]}</strong><small>{group === 'up-next' ? upNextTile(board ? board.groups['up-next'].filter(match) : []) : groupMeaning[group]}</small>
      </button>)}</div>
      {only && <p className="filter-note">Showing {groupLabel[only]} only · <button type="button" className="text-button" onClick={() => setOnly(null)}>Show every group</button></p>}
      {section('needs-you', 'only you can decide these')}
      {section('blocked')}
      {section('moving')}
      {section('up-next')}
      {shown('backlog') && byGroup.backlog.length > 0 && <details className="work-group group-backlog" aria-label="Backlog" data-group-section="backlog" open={only === 'backlog'}>
        <summary><GroupDot group="backlog"/>Backlog <span className="count">{byGroup.backlog.length}</span><small>no clock runs</small></summary>
        <div className="rows">{byGroup.backlog.map(w => row(w, 'backlog'))}</div>
      </details>}
      {board && groups.every(group => counts[group] === 0) && <p className="muted">{query ? 'No open item matches.' : 'Nothing is open.'}</p>}
      <div className="shipped-line" aria-label="Shipped this week">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>
        <span><strong>{recent.length} shipped this week.</strong>{latest && <> Latest: <button type="button" className="text-button" data-latest={latest.key} onClick={() => setSelected(latest.id)}><span className="mono">{latest.key}</span> <span data-title>{latest.title}</span></button> · {plainStage(latest, release, serve)} · {formatAge(new Date(mergedAt(latest)).toISOString(), now)} ago</>}{unreleased > 0 && <span className="muted" data-unreleased={unreleased}> {unreleased} merged, not yet seen live.</span>}{liveFailingLine(serve) && <span className="danger-text" data-live-failing> {liveFailingLine(serve)}.</span>}</span>
        <button type="button" className="text-button push" onClick={() => setView('shipped')}>See what shipped →</button>
      </div>
    </>}
  </>;
}
