import { isClosed, type Work } from '../../src/model';
import WorkCard from '../components/work-card';
import { StepNames } from '../components/steps-bar';
import { GroupDot } from '../components/status-badge';
import { formatAge } from '../duration';
import { classify, groupLabel, groupOf, mergedAt, releasedAt, groupMeaning, groups, humanOnlyIds, summarySentence, type OpenGroup } from '../groups';
import { releaseView } from '../release';
import { stalledCards } from './actionless';
import type { Dashboard } from './dashboard';

const week = 7 * 24 * 60 * 60 * 1000;

/**
 * The Work page (GY-161) answers "what is happening and what do I do next" on one screen, with
 * one classification: every open item is in exactly one group (web/groups.ts), each summary tile
 * counts one group and filters the page to exactly that group's rows, and the lists below are
 * those same groups — so a number on the page is always the number of rows it stands for.
 * Needs you comes first, with the one action to take; Backlog is folded away and carries no
 * clock. What shipped is one line at the foot, linking to the Shipped page: shipped means the
 * release was observed serving it, dated from that observation; work that has merged but is not
 * yet seen live is counted apart, as waiting for the release.
 */
export default function OverviewPage({ work, status, query, setQuery, setSelected, setCreating, setView, observedAt, filter: only, setFilter: setOnly, stepMoves }: Dashboard) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const match = (w: Work) => `${w.key} ${w.title}`.toLowerCase().includes(query.toLowerCase());
  const release = releaseView(status);
  const { byGroup } = classify(work.filter(match), now, status?.humanOnly, release);
  const counts = Object.fromEntries(groups.map(group => [group, byGroup[group].length])) as Record<OpenGroup, number>;
  const stalls = new Map(stalledCards(work.filter(w => w.stage !== 'done' && !isClosed(w)), now).map(card => [card.item.id, card]));
  const humanOnly = humanOnlyIds(work, status?.humanOnly);
  // Shipped this week: delivered and served by the release, dated from when it was seen live.
  const delivered = work.filter(w => groupOf(w, now, undefined, undefined, release) === 'shipped');
  const recent = delivered.filter(w => releasedAt(w, release) !== null && now - releasedAt(w, release)! <= week).sort((a, b) => releasedAt(b, release)! - releasedAt(a, release)!);
  // Merged this week but not yet seen live: delivered, still waiting for the release to serve it.
  const unreleased = delivered.filter(w => releasedAt(w, release) === null && now - mergedAt(w) <= week).length;
  const row = (w: Work, group: OpenGroup) => <WorkCard key={w.id} item={w} group={group} stall={group === 'blocked' ? stalls.get(w.id) : undefined} repository={status?.repository} now={now} onOpen={setSelected} stepMoves={stepMoves} release={release}/>;
  const shown = (group: OpenGroup) => !only || only === group;
  const section = (group: OpenGroup, note?: string) => shown(group) && byGroup[group].length > 0 && <section key={group} className={`work-group group-${group}`} aria-label={groupLabel[group]} data-group-section={group}>
    <h2><GroupDot group={group}/>{groupLabel[group]} <span className="count">{byGroup[group].length}</span>{note && <small>{note}</small>}{group === 'needs-you' && <button type="button" className="text-button push" onClick={() => setView('needs-you')}>Every request and answer →</button>}</h2>
    {group === 'moving' && <div className="row-head" aria-hidden="true"><span/><span/><span className="row-steps"><StepNames/></span><span>Who acts next</span><span>In step</span></div>}
    <div className="rows">{byGroup[group].map(w => row(w, group))}</div>
  </section>;
  const admin = status?.actor?.role === 'admin';
  return <>
    <div className="page-heading"><div><h1>Work</h1><p className="summary">{summarySentence(counts)}</p></div>
      <div className="heading-tools"><label className="search"><input aria-label="Search work" placeholder="Search by key or title" value={query} onChange={e => setQuery(e.target.value)}/></label>
        {admin && <button type="button" onClick={() => setCreating(true)}>＋ New work item</button>}</div></div>
    {status && !status.github && <div className="notice">GitHub is not connected, so nothing can merge yet. <a href="/docs/github">Set it up ↗</a></div>}
    {status?.appPermissions?.attention?.length > 0 && <div className="notice danger" role="alert"><strong>GitHub App permissions need attention.</strong>{status.appPermissions.attention.map((line: string) => <p key={line}>{line}</p>)}{status.heldJobs > 0 && <p>{status.heldJobs} integration job{status.heldJobs === 1 ? ' is' : 's are'} held rather than retried until the permission is accepted.</p>}{/^https:\/\/github\.com\//.test(status.appPermissions.installationUrl ?? '') && <a href={status.appPermissions.installationUrl} target="_blank" rel="noreferrer noopener">Review the App installation on GitHub ↗</a>} <a href="/docs/github#app-permissions">Migration guide ↗</a></div>}
    {/* A rate-limit pause is one incident (GY-117): what stopped, until when, what spent the budget. */}
    {status?.githubBudget?.paused && <div className="notice danger" role="alert"><strong>GitHub requests are paused until {status.githubBudget.paused.until}.</strong> {status.githubBudget.paused.reason}. What exhausted the budget: {status.githubBudget.lastHour.requests} requests in the last hour{status.githubBudget.lastHour.byKind.length > 0 && ` (${status.githubBudget.lastHour.byKind.map((entry: any) => `${entry.kind} ${entry.requests}`).join(', ')})`}. Every gate reads stale until the pause lifts{status.jobs?.length > 0 && `; ${status.jobs.length} integration job${status.jobs.length === 1 ? '' : 's'} recorded the refusal`}.</div>}
    {status?.jobs?.length > 0 && !status?.githubBudget?.paused && <div className="notice danger">{status.jobs.length} GitHub update(s) failed: {status.jobs[0].error}</div>}
    {status?.executors?.attention?.length > 0 && <div className="notice danger" role="alert" aria-label="Unserved actions"><strong>{status.executors.live === 0 ? 'No executor is running.' : `No executor serves ${status.executors.attention.map((entry: any) => entry.kind).join(', ')}.`}</strong> {status.executors.attention.map((entry: any) => <p key={entry.kind}>{entry.text}</p>)}<p className="muted">An action nobody can claim is not queued behind other work; nothing moves until an executor of its kind is started. <a href="/docs/master-agent-reference#running-executors-under-supervision">How executors are supervised ↗</a></p></div>}
    {work.length === 0 ? <div className="empty"><h2>No work yet.</h2><p>Create a work item, say what must be true when it is done, and an agent will pick it up.</p>{admin && <button type="button" onClick={() => setCreating(true)}>Create the first work item</button>}</div> : <>
      <div role="group" aria-label="Filter by group" className="tiles">{groups.map(group => <button type="button" key={group} className={`tile group-${group}${only === group ? ' selected' : ''}${counts[group] === 0 ? ' empty-tile' : ''}`} aria-pressed={only === group} data-tile={group} onClick={() => setOnly(only === group ? null : group)}>
        <span className="tile-label"><GroupDot group={group}/>{groupLabel[group]}</span><strong>{counts[group]}</strong><small>{groupMeaning[group]}</small>
      </button>)}</div>
      {only && <p className="filter-note">Showing {groupLabel[only]} only · <button type="button" className="text-button" onClick={() => setOnly(null)}>Show every group</button></p>}
      {section('needs-you', humanOnly.size ? 'only you can decide these' : undefined)}
      {section('blocked')}
      {section('moving')}
      {section('up-next')}
      {shown('backlog') && byGroup.backlog.length > 0 && <details className="work-group group-backlog" aria-label="Backlog" data-group-section="backlog" open={only === 'backlog'}>
        <summary><GroupDot group="backlog"/>Backlog <span className="count">{byGroup.backlog.length}</span><small>no clock runs</small></summary>
        <div className="rows">{byGroup.backlog.map(w => row(w, 'backlog'))}</div>
      </details>}
      {groups.every(group => counts[group] === 0) && <p className="muted">{query ? 'No open item matches.' : 'Nothing is open.'}</p>}
      <div className="shipped-line" aria-label="Shipped this week">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>
        <span><strong>{recent.length} shipped this week.</strong>{recent[0] && <> Latest: <button type="button" className="text-button" onClick={() => setSelected(recent[0].id)}><span className="mono">{recent[0].key}</span> <span data-title>{recent[0].title}</span></button> · {formatAge(new Date(releasedAt(recent[0])!).toISOString(), now)} ago</>}{unreleased > 0 && <span className="muted" data-unreleased={unreleased}> {unreleased} merged, not yet seen live.</span>}</span>
        <button type="button" className="text-button push" onClick={() => setView('shipped')}>See what shipped →</button>
      </div>
    </>}
  </>;
}
