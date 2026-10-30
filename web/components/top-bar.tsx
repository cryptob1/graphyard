import { glossary, type GlossaryTerm } from '../glossary';
import Term from './term';
import { viewFor, visibleViews } from '../pages';
import type { Dashboard } from '../pages/dashboard';

/** The commit as the release line shows it: the first 8 characters, the whole SHA in the title. */
const shortSha = (sha: string) => <span className="mono" title={sha}>{sha.slice(0, 8)}</span>;

/**
 * The board's one release line (GY-1979). A repository that declares `.graphyard/serve.json`
 * (GY-2976) renders what the deploy unit's serve pass last served — "Serving <commit>" with the
 * merged changes main holds since it, the last build failure, a link to the declared URL, and the
 * served commit's required cases' verdict (GY-2983): "verified", "failing <case>: <step>" once a
 * required case is broken, or "not yet run" while the pass has recorded no verdict. Elsewhere a
 * managed install (GY-2964) names its repository's own serving, which only a deploy record naming
 * it can: "Serving <commit>" with the merged changes main holds since it, or "No deploy configured
 * · main <tip>" — never the control plane's own commit, which serves Graphyard's code, not the
 * managed repository's. Elsewhere it reads the production watch's report on status (`production`),
 * the same view the board reads (src/model/release.ts): the commit production serves, whether it is
 * healthy, and how many merged changes it does not carry yet. Health is the watch's own: an open
 * deployment incident is an unhealthy release; a pending count is lag, not ill health. Where
 * nothing has observed production (no watch configured, a failed provider read, an unknown serving
 * commit) the line says so rather than claiming either way — "Release: not watched", never a
 * serving sha or health claim without an observation. It is plain text, not a live region: it
 * refreshes with every poll, and the page's own `role="status"` regions (loading notices) stay
 * unique for readers and tests.
 */
export function ReleaseLine({ status }: { status?: Dashboard['status'] }) {
  // The declared serve's serving, read from master status's serving block over the API.
  const serving = status?.serving as { commit?: unknown; main?: unknown; pending?: unknown; failedDeploy?: { tip?: unknown; reason?: unknown } | null | undefined; serve?: { url?: unknown; failure?: { commit?: unknown; reason?: unknown } | null; check?: { verified?: unknown; case?: unknown; step?: unknown } | null } | null | undefined } | null | undefined;
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
        ? <>Serving {shortSha(commit)}{pending !== null && pending > 0 && <> · {pending} merged {pending === 1 ? 'change' : 'changes'} not carried yet</>}
          {check && check.verified === true && <> · verified</>}
          {check && check.verified === false && typeof check.case === 'string' && <> · failing {check.case}{typeof check.step === 'string' && check.step ? <>: {check.step}</> : null}</>}
          {!check && <> · not yet run</>}</>
        : <>No serve yet{main && <> · main {shortSha(main)}</>}</>}
      {failure && <> · build of {shortSha(failure.commit)} failed: {failure.reason.slice(0, 140)}</>}
      {url && <> · <a href={url}>Served · {host}</a></>}
    </p>;
  }
  const deploy = status?.deploy as { configured?: unknown; tip?: unknown; main?: unknown; pending?: unknown } | null | undefined;
  if (deploy && typeof deploy === 'object') {
    const configured = deploy.configured === true && typeof deploy.tip === 'string' && !!deploy.tip;
    const pending = typeof deploy.pending === 'number' ? deploy.pending : null;
    const main = typeof deploy.main === 'string' && deploy.main ? deploy.main : null;
    return <p className="release-line" data-release-line={configured ? 'serving' : 'undeployed'}>
      {configured
        ? <>Serving {shortSha(deploy.tip as string)}{pending !== null && <> · {pending} merged {pending === 1 ? 'change' : 'changes'} not carried yet</>}</>
        : <>No deploy configured{main && <> · main {shortSha(main)}</>}</>}
    </p>;
  }
  const watch = status?.production as { observedAt?: unknown; serving?: unknown; error?: unknown; pending?: unknown; incidents?: unknown } | null | undefined;
  const observed = !!watch?.observedAt && typeof watch.serving === 'string' && !!watch.serving && !watch.error;
  const incidents = Array.isArray(watch?.incidents) ? watch.incidents.length : 0;
  const pending = Array.isArray(watch?.pending) ? watch.pending.filter(entry => typeof entry === 'string').length : 0;
  return <p className="release-line" data-release-line={observed ? 'serving' : 'unobserved'} data-healthy={observed ? incidents === 0 : undefined} data-pending={observed ? pending : undefined}>
    {observed
      ? <>Serving {shortSha(watch!.serving as string)} · <strong>{incidents ? `unhealthy: ${incidents} open deployment ${incidents === 1 ? 'incident' : 'incidents'}` : 'healthy'}</strong> · {pending} merged {pending === 1 ? 'change' : 'changes'} not carried yet</>
      : <>Release: not watched</>}
  </p>;
}

/** The glossary entry a tab's label names, by the label itself or by its singular. */
const meaning = (label: string): GlossaryTerm | null => {
  const key = label.toLowerCase(), singular = key.replace(/s$/, '');
  return key in glossary ? key as GlossaryTerm : singular in glossary ? singular as GlossaryTerm : null;
};

/**
 * The board's top bar (GY-1979): the one speed number, then the one release line, then the pages
 * of the current section, when it has more than one (Shipped, Insights, Settings). The tabs are
 * not a second navigation:
 * no page shares a label with a sidebar entry (a test holds the registry to that), they list only
 * the pages under the entry the sidebar has selected, and a section with a single page draws none
 * at all. The repository and how fresh the data is live at the foot of the sidebar.
 */
export default function TopBar(dashboard: Dashboard) {
  const { view, setView, status } = dashboard;
  const section = viewFor(view).section;
  const tabs = section ? visibleViews(dashboard).filter(page => page.section === section) : [];
  return <div className="top-bar">
    {status && <ReleaseLine status={status}/>}
    {tabs.length >= 2 && <nav className="tabs" aria-label="Pages in this section">{tabs.map(tab => { const term = meaning(tab.label); return <button key={tab.id} type="button" className={tab.id === view ? 'tab active' : 'tab'} aria-current={tab.id === view ? 'page' : undefined} onClick={() => setView(tab.id)}>{term ? <Term term={term} focusable={false}>{tab.label}</Term> : tab.label}</button>; })}</nav>}
  </div>;
}
