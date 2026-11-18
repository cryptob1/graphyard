import type { Dashboard } from '../pages/dashboard';
import { formatAge } from '../../src/model/duration';

/** /api/status's `app` (GY-3434): the shareable address main declares, or why there is none, with where and what it serves. */
type App = { url: string | null; refused: string | null; missing: string | null; machine: string; commit: string | null; deployedAt: string | null };
const appOf = (status: Dashboard['status']): App | null => status?.app && typeof status.app === 'object' ? status.app as App : null;

/** The top bar's Open app button: shown once main declares a shareable app.url. */
export function OpenApp({ status }: { status: Dashboard['status'] }) {
  const url = appOf(status)?.url;
  return url ? <a className="open-app" href={url} target="_blank" rel="noreferrer" data-open-app>Open app ↗</a> : null;
}

/** The Work page's Where it runs card: the app's link, its machine, serving commit and deploy time, and the dashboard's own link; or the one setting to add. */
export function WhereItRuns({ status, now }: { status: Dashboard['status']; now: number }) {
  const app = appOf(status);
  if (!app) return null;
  const dashboard = typeof location === 'undefined' ? '' : location.origin;
  return <section className="panel where-it-runs" aria-label="Where it runs" data-where-it-runs={app.url ? 'declared' : 'missing'}>
    <h2>Where it runs</h2>
    {app.url
      ? <dl className="facts">
        <div><dt>App</dt><dd><a href={app.url} target="_blank" rel="noreferrer" data-app-link>{app.url}</a></dd></div>
        <div><dt>Machine</dt><dd data-machine>{app.machine}</dd></div>
        <div><dt>Serving</dt><dd className="mono" data-commit title={app.commit ?? undefined}>{app.commit ? app.commit.slice(0, 8) : 'nothing deployed yet'}</dd></div>
        <div><dt>Deployed</dt><dd data-deployed-at title={app.deployedAt ?? undefined}>{app.deployedAt ? `${formatAge(app.deployedAt, now)} ago` : '—'}</dd></div>
        <div><dt>Dashboard</dt><dd><a href={dashboard} data-dashboard-link>{dashboard}</a></dd></div>
      </dl>
      : <p data-app-missing>{app.refused ?? app.missing}</p>}
  </section>;
}
