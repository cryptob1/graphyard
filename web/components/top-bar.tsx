import { glossary, type GlossaryTerm } from '../glossary';
import Invite from './invite';
import Term from './term';
import { viewFor, visibleViews, type View } from '../pages';
import type { Dashboard } from '../pages/dashboard';
import { mergedAt, shippedCounts } from '../groups';
import { workersView } from '../workers-view';
import type { Work } from '../../src/model';
import { OpenApp } from './where-it-runs';

/** The commit as the release line shows it: the first 8 characters, the whole SHA in the title. */
const shortSha = (sha: string) => <span className="mono" title={sha}>{sha.slice(0, 8)}</span>;

/**
 * GY-3483: the header's strip says what is happening now — live agent sessions (the Workers page's
 * open ones plus the master's pane), the checks running (merge trials and a batch gate on main, as
 * /api/status counts them) and today's merges. Each number rides a data attribute for readers and tests.
 */
export function ActivityStrip({ work, observedAt, status }: { work: Work[]; observedAt: number; status?: Dashboard['status'] }) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const agents = workersView(work, new Date(now)).running.filter(row => !row.stale && row.roleKind !== 'master').length + (status?.setup?.panes?.master ? 1 : 0);
  const checks = typeof status?.checksRunning === 'number' ? status.checksRunning : 0;
  const today = new Date(now).setHours(0, 0, 0, 0);
  const merged = work.filter(item => item.stage === 'done' && !!(item.delivery?.mergedAt ?? item.observation?.mergedAt) && mergedAt(item) >= today).length;
  const plural = (n: number, word: string) => <><span className="mono">{n}</span> {word}{n === 1 ? '' : 's'}</>;
  return <p className="activity-strip" aria-label="Activity" data-on-shift={agents} data-in-trial={checks} data-shipped-tonight={merged}>
    <span className="beacon" aria-hidden="true"/>{plural(agents, 'agent')} working
    <span aria-hidden="true"> · </span>{plural(checks, 'check')} running
    <span aria-hidden="true"> · </span><span className="mono">{merged}</span> merged today
  </p>;
}

/**
 * Shipped and going live (GY-3452): the week's merges the live commit contains, and those it does
 * not carry yet — the Work page card's one count, so the two never disagree. With no live commit
 * known the release line already says so, and the strip stays out of the way.
 */
export function ShippedStrip({ work, observedAt, live }: { work: Work[]; observedAt: number; live?: { commit?: unknown; waiting?: unknown } | null }) {
  if (typeof live?.commit !== 'string') return null;
  const { shipped, waiting } = shippedCounts(work, live, Number.isNaN(observedAt) ? Date.now() : observedAt);
  return <p className="shipped-strip" aria-label="Shipped" data-shipped={shipped.length} data-waiting={waiting.length}>
    <span className="mono">{shipped.length}</span> shipped · <span className="mono">{waiting.length}</span> going live
  </p>;
}

/** "· <n> changes not live yet", or nothing when the live commit carries every merge. */
const notLive = (pending: number | null) => pending ? <> · {pending} {pending === 1 ? 'change' : 'changes'} not live yet</> : null;

/**
 * The board's one release line (GY-1979), shown only when it says something (GY-3483): "Live:
 * <sha8>" with the merged changes the live commit does not carry yet. A declared node application
 * (GY-2976) reads what the serve pass last served, with its required cases' verdict (GY-2983) once
 * one is recorded, the last build failure and a link to the declared URL; a managed install
 * (GY-2964) reads the deploy record naming its repository; elsewhere the production watch's report
 * (src/model/release.ts), with its open deployment incidents. With no deploy configured, or
 * nothing observing production, there is no line — Settings → Delivery says so.
 */
export function ReleaseLine({ status }: { status?: Dashboard['status'] }) {
  // The declared serve's serving, read from master status's serving block over the API.
  const serving = status?.serving as { commit?: unknown; main?: unknown; pending?: unknown; serve?: { url?: unknown; failure?: { commit?: unknown; reason?: unknown } | null; check?: { verified?: unknown; case?: unknown; step?: unknown } | null } | null | undefined } | null | undefined;
  const declared = serving?.serve && typeof serving.serve === 'object' ? serving.serve : null;
  if (declared) {
    const commit = typeof serving!.commit === 'string' && serving!.commit ? serving!.commit : null;
    const main = typeof serving!.main === 'string' && serving!.main ? serving!.main : null;
    const pending = typeof serving!.pending === 'number' ? serving!.pending : null;
    const failureCommit = declared.failure && typeof declared.failure.commit === 'string' ? declared.failure.commit : null;
    const failure = failureCommit ? { commit: failureCommit, reason: typeof declared.failure?.reason === 'string' ? declared.failure.reason : '' } : null;
    const check = declared.check && typeof declared.check === 'object' ? declared.check : null;
    const url = typeof declared.url === 'string' && declared.url ? declared.url : null;
    let host = url ?? '';
    try { host = url ? new URL(url).host : ''; } catch { /* the declared text stands */ }
    return <p className="release-line" data-release-line={commit ? 'serving' : 'unserved'}>
      {commit
        ? <>Live: {shortSha(commit)}{notLive(pending)}
          {check && check.verified === true && <> · verified</>}
          {check && check.verified === false && typeof check.case === 'string' && <> · failing {check.case}{typeof check.step === 'string' && check.step ? <>: {check.step}</> : null}</>}</>
        : <>No serve yet{main && <> · main {shortSha(main)}</>}</>}
      {failure && <> · build of {shortSha(failure.commit)} failed: {failure.reason.slice(0, 140)}</>}
      {url && <> · <a href={url}>Served · {host}</a></>}
    </p>;
  }
  const deploy = status?.deploy as { configured?: unknown; tip?: unknown; pending?: unknown } | null | undefined;
  if (deploy && typeof deploy === 'object') {
    if (deploy.configured !== true || typeof deploy.tip !== 'string' || !deploy.tip) return null;
    return <p className="release-line" data-release-line="serving">Live: {shortSha(deploy.tip)}{notLive(typeof deploy.pending === 'number' ? deploy.pending : null)}</p>;
  }
  const watch = status?.production as { observedAt?: unknown; serving?: unknown; error?: unknown; pending?: unknown; incidents?: unknown } | null | undefined;
  if (!watch?.observedAt || typeof watch.serving !== 'string' || !watch.serving || watch.error) return null;
  const incidents = Array.isArray(watch.incidents) ? watch.incidents.length : 0;
  const pending = Array.isArray(watch.pending) ? watch.pending.filter(entry => typeof entry === 'string').length : 0;
  return <p className="release-line" data-release-line="serving" data-healthy={incidents === 0} data-pending={pending}>
    Live: {shortSha(watch.serving)}{notLive(pending)}
    {incidents > 0 && <> · <strong>unhealthy: {incidents} open deployment {incidents === 1 ? 'incident' : 'incidents'}</strong></>}
  </p>;
}

/**
 * GY-3399: the week's batch-gate reverts and gates removed — lessons the master turned into code,
 * whose item's delivery removed them — as /api/status's `thisWeek` reports them, each count
 * followed by links that open its items. One line, shown only while either count is above zero (GY-3483).
 */
export function WeekLine({ status, work, open }: { status?: Dashboard['status']; work: Work[]; open?: (id: string) => void }) {
  const week = status?.thisWeek as { reverts?: unknown; revertedItems?: unknown; gatesRemoved?: unknown; gatesRemovedItems?: unknown } | null | undefined;
  if (!week || typeof week.reverts !== 'number' || typeof week.gatesRemoved !== 'number' || (!week.reverts && !week.gatesRemoved)) return null;
  const keys = (value: unknown) => Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  const links = (value: unknown) => keys(value).map(key => {
    const id = work.find(item => item.key === key)?.id;
    return <span key={key}> <a className="mono" href={`#${key}`} onClick={event => { if (id && open) { event.preventDefault(); open(id); } }}>{key}</a></span>;
  });
  return <p className="week-line" data-reverts={week.reverts} data-gates-removed={week.gatesRemoved}>
    This week: <span className="mono">{week.reverts}</span> {week.reverts === 1 ? 'revert' : 'reverts'}{links(week.revertedItems)}
    <span aria-hidden="true"> · </span><span className="mono">{week.gatesRemoved}</span> {week.gatesRemoved === 1 ? 'gate' : 'gates'} removed{links(week.gatesRemovedItems)}
  </p>;
}

/** GY-3517: the compute machines the loop's latest probe reads away only because their host helper is too old for this release. */
export const hostsNeedingUpdate = (status?: Dashboard['status']): string[] =>
  Array.isArray(status?.hosts) ? status.hosts.filter((host: { away?: unknown; update?: unknown; host?: unknown }) => host?.away === true && host.update === true && typeof host.host === 'string').map((host: { host: string }) => host.host) : [];
/** The one command that updates a machine's helper: its printed script is then run there with sudo. */
export const hostUpdateCommand = 'graphyard host prepare';

/** GY-3517: one line while any compute machine needs its helper updated, naming them and the one command; gone once the next probe reads them ready. */
export function HostUpdateLine({ status }: { status?: Dashboard['status'] }) {
  const names = hostsNeedingUpdate(status);
  if (!names.length) return null;
  return <p className="host-update-line" role="status" data-host-update={names.join(' ')}>
    <strong>Compute machines need an update: {names.join(', ')}</strong> · run <span className="mono">{hostUpdateCommand}</span>, then the script it prints on each with sudo
  </p>;
}

/** The glossary entry a tab's label names, by the label itself or by its singular. */
const meaning = (label: string): GlossaryTerm | null => {
  const key = label.toLowerCase(), singular = key.replace(/s$/, '');
  return key in glossary ? key as GlossaryTerm : singular in glossary ? singular as GlossaryTerm : null;
};

/**
 * The board's top bar: the configured repository, then the release line, then the pages
 * of the current section, when it has more than one (Work, Workers, Shipped, Tests, Settings); a
 * rarely needed page sits behind the row's Advanced fold. The tabs are not a second navigation:
 * no page shares a label with a sidebar entry (a test holds the registry to that), they list only
 * the pages under the entry the sidebar has selected, and a section with a single page draws none
 * at all. An open item keeps the repository and release line, with its own Back control.
 *
 * The project's emblem (GY-3273) rides beside the repository name through an `<img>` of
 * `/favicon.svg`: the master's drawing once one is stored, the default Graphyard mark until then.
 * An image never runs script, and the same route serves the page's favicon, so one address is the
 * whole feature.
 */
export default function TopBar(dashboard: Dashboard & { onPalette?: () => void }) {
  const { view, setView, status, selected, work, observedAt, onPalette } = dashboard;
  const section = viewFor(view).section;
  const pages = section ? visibleViews(dashboard).filter(page => page.section === section) : [];
  const tabs = pages.filter(page => !page.advanced), advanced = pages.filter(page => page.advanced);
  const tab = (page: View) => { const term = meaning(page.label); return <button key={page.id} type="button" className={page.id === view ? 'tab active' : 'tab'} aria-current={page.id === view ? 'page' : undefined} onClick={() => setView(page.id)}>{term ? <Term term={term} focusable={false}>{page.label}</Term> : page.label}</button>; };
  return <div className="top-bar">
    <div className="top-bar-row">
      {status?.repository && <p className="project-name" data-title><img className="project-emblem" src="/favicon.svg" alt=""/>{status.repository}</p>}
      <div className="top-bar-live">
        <ActivityStrip work={work} observedAt={observedAt} status={status}/>
        <ShippedStrip work={work} observedAt={observedAt} live={status?.live}/>
        <OpenApp status={status}/>
        <Invite api={dashboard.api} status={status}/>
        {onPalette && <button type="button" className="palette-button" title="Ctrl K / ⌘ K" aria-label="Command palette (Ctrl K)" onClick={onPalette}><kbd>⌘</kbd><kbd>K</kbd></button>}
      </div>
    </div>
    {status && <HostUpdateLine status={status}/>}
    {status && <ReleaseLine status={status}/>}
    {status && <WeekLine status={status} work={work} open={dashboard.setSelected}/>}
    {!selected && pages.length >= 2 && <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab)}{advanced.length > 0 && <details className="tabs-advanced" open={advanced.some(page => page.id === view) || undefined}><summary className="tab">Advanced</summary>{advanced.map(tab)}</details>}</nav>}
  </div>;
}
