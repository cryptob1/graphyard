import { useEffect, useRef, useState } from 'react';
import Term from '../components/term';
import type { ScenarioRun } from '../../src/model/test-cases';
import type { CaseSummary } from '../../src/test-runs';

/** Each result in words and a mark; a skip is its own state and never reads as a pass. */
export const resultLabel: Record<string, { mark: string; word: string; tone: string }> = {
  pass: { mark: '✓', word: 'passed', tone: 'pass' }, fail: { mark: '×', word: 'failed', tone: 'fail' }, skipped: { mark: '◌', word: 'skipped', tone: 'skipped' },
  'not-run': { mark: '○', word: 'not run on this head', tone: 'none' }, 'no-pr': { mark: '○', word: 'no pull request yet', tone: 'none' }, never: { mark: '○', word: 'never run', tone: 'none' },
};
export const Result = ({ result }: { result: string }) => { const r = resultLabel[result] ?? resultLabel.never; return <span className={`case-result result-${r.tone}`}>{r.mark} {r.word}</span>; };
const day = (at: string) => new Date(at).toLocaleString();
const Commit = ({ sha }: { sha: string }) => <Term term="commit"><span className="mono">{sha.slice(0, 8)}</span></Term>;
const Pr = ({ pr }: { pr: number | null }) => pr ? <> · <Term term="pull request">PR</Term> #{pr}</> : null;
/** Where a run came from: its commit, pull request, item and its lane's own run identity. */
export const RunLine = ({ run }: { run: ScenarioRun }) => run.e2e ? <E2eRunLine run={run} e2e={run.e2e}/> : <>
  <Result result={run.result}/> <Commit sha={run.sha}/><Pr pr={run.pr}/> · {run.workKey}
  {' · '}{run.run.url
    ? <a href={run.run.url} target="_blank" rel="noopener noreferrer">{run.run.kind} run {run.run.id.slice(0, 12)}{run.run.attempt ? ` attempt ${String(run.run.attempt).slice(0, 8)}` : ''} ↗</a>
    : <>{run.run.kind} run {run.run.id.slice(0, 12)}{run.run.attempt ? ` attempt ${String(run.run.attempt).slice(0, 8)}` : ''}</>}
  {run.scenarioRevision ? ` · v${run.scenarioRevision}` : ''} · {run.executed} executed / {run.skipped} skipped · {run.producer} · {day(run.at)}{run.withdrawn ? <strong className="amber"> · withdrawn</strong> : null}</>;
/** A `graphyard e2e run` of a repository case: the target it ran against, how long it took, and the step that failed. */
const E2eRunLine = ({ run, e2e }: { run: ScenarioRun; e2e: NonNullable<ScenarioRun['e2e']> }) => <>
  <Result result={run.result}/> {run.sha === 'unknown' ? 'unreported commit' : <Commit sha={run.sha}/>} on {run.environment}
  {' · '}e2e run {run.run.id.slice(0, 40)} · {e2e.baseUrl}{run.scenarioRevision ? ` · v${run.scenarioRevision}` : ''} · {(e2e.durationMs / 1000).toFixed(1)} s · {run.producer} · {day(run.at)}
  {e2e.failingStep && <><br/><small className="fail">failed at step {e2e.failingStep.index + 1} {e2e.failingStep.name}: {e2e.failingStep.reason}</small></>}</>;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

type Filter = 'all' | 'fail' | 'flaky' | 'never';
const filters: { id: Filter; label: string; keep: (entry: CaseSummary) => boolean }[] = [
  { id: 'all', label: 'All', keep: () => true },
  { id: 'fail', label: 'Failing', keep: entry => entry.latest?.result === 'fail' },
  { id: 'flaky', label: 'Flaky', keep: entry => entry.flaky },
  { id: 'never', label: 'Never run', keep: entry => !entry.latest },
];

/** One case's older runs, paged from the run ledger on request. */
function OlderRuns({ api, id, after }: { api: (path: string) => Promise<any>; id: string; after: number | null }) {
  const [runs, setRuns] = useState<ScenarioRun[]>([]);
  const [next, setNext] = useState<number | null>(after);
  const [error, setError] = useState('');
  if (after === null) return null;
  const more = async () => { setError(''); try { const page = await api(`tests/${encodeURIComponent(id)}/runs?before=${next}&limit=50`); setRuns(current => [...current, ...page.runs]); setNext(page.next); } catch (e) { setError((e as Error).message); } };
  return <>{runs.map(run => <li key={run.seq}><RunLine run={run}/></li>)}
    {error && <li role="alert" className="amber">{error}</li>}
    {next !== null && <li><button type="button" className="text-button" onClick={() => void more()}>Show older runs</button></li>}</>;
}

/**
 * The Tests page (GY-162): every end-to-end test case with its latest trusted result, when its
 * definition last changed, how often it has failed and whether it is flaky. Results come only
 * from trusted runs bound to a commit and a run; the page itself writes nothing.
 */
export default function TestsPage({ api, canEdit, setView }: { api: (path: string) => Promise<any>; canEdit: boolean; setView?: (view: string) => void }) {
  const [data, setData] = useState<{ window: number; cases: CaseSummary[] } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const request = useRef(0);
  const load = async () => {
    const version = ++request.current; setLoading(true); setError('');
    try { const next = await api('tests'); if (version === request.current) setData(next); }
    catch (e) { if (version === request.current) setError((e as Error).message); }
    finally { if (version === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { request.current++; }; }, []);
  return <TestsView data={data} error={error} loading={loading} filter={filter} setFilter={setFilter} retry={() => void load()} api={api} canEdit={canEdit} setView={setView}/>;
}

/** The page as rendered from one read, so it can be drawn and tested without the network. */
export function TestsView({ data, error, loading, filter, setFilter, retry, api, canEdit, setView }: { data: { window: number; cases: CaseSummary[] } | null; error: string; loading: boolean; filter: Filter; setFilter(filter: Filter): void; retry(): void; api: (path: string) => Promise<any>; canEdit: boolean; setView?: (view: string) => void }) {
  const cases = data?.cases ?? [];
  const shown = cases.filter(filters.find(f => f.id === filter)!.keep);
  const count = (id: Filter) => cases.filter(filters.find(f => f.id === id)!.keep).length;
  return <section className="tests-page" aria-label="Tests">
    <div className="page-heading"><div><div className="eyebrow">WHAT IS TESTED, AND WHETHER IT PASSES</div><h1>Tests</h1>
      <p>Every <Term term="end-to-end test">end-to-end</Term> <Term term="test case">test case</Term>, its latest trusted result, and its history. A result is recorded only from a trusted run bound to its commit; a builder cannot record one.</p></div>
      {canEdit && setView && <button type="button" onClick={() => setView('scenarios')}>Define test cases</button>}</div>
    {error && <div role="alert" className="notice danger">{error} <button type="button" disabled={loading} onClick={retry}>Retry loading tests</button>{data ? <p>Previously loaded results are shown; they may be stale.</p> : null}</div>}
    {loading && !data && <p role="status">Loading tests…</p>}
    {data && !cases.length && <div className="empty"><span>◇</span><h2>No test cases yet.</h2><p>Define a case, link it to a criterion as <Term term="end-to-end test"><code>e2e:ID</code></Term>, and its trusted runs appear here.</p></div>}
    {cases.length > 0 && <>
      <div className="case-filters" role="group" aria-label="Filter test cases">{filters.map(f => <button key={f.id} type="button" className={filter === f.id ? 'chip active' : 'chip'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} <span className="count">{count(f.id)}</span></button>)}</div>
      <p className="muted">Flaky: passed and failed on the same commit, or changed result twice or more in its last {data!.window} runs. Pass rate is over those runs. Skipped runs count as neither. E2E cases live in <code>e2e/cases/</code>; <code>graphyard e2e run</code> records their runs.</p>
      <table className="sessions-table test-cases" aria-label="Test cases"><thead><tr><th scope="col">Case</th><th scope="col">Latest result</th><th scope="col">Pass rate</th><th scope="col">Last change</th><th scope="col">Failures</th><th scope="col">Linked work</th></tr></thead>
        <tbody>{shown.map(entry => <tr key={entry.id} data-case={entry.id}>
          <th scope="row" id={`case-${entry.id}`}><span className="mono"><Term term="end-to-end test">e2e:</Term>{entry.id}</span>{entry.title ?? <span className="amber">not in the registry</span>}
            {entry.e2e && <><br/><small className="muted">E2E case · {entry.testPath} · targets {entry.e2e.target}{entry.e2e.tags.length ? ` · ${entry.e2e.tags.join(', ')}` : ''}</small></>}
            {entry.flaky && <strong className="flaky-flag" title={entry.flakyReason ?? ''}> · flaky: {entry.flakyReason}</strong>}
            <details><summary><a href={`#case-${entry.id}`}>History</a> · {entry.runs} {entry.runs === 1 ? 'run' : 'runs'}</summary>
              {entry.purpose && <p className="muted">{entry.purpose}</p>}
              <ul className="run-history">{entry.history.map(run => <li key={run.seq}><RunLine run={run}/></li>)}
                <OlderRuns api={api} id={entry.id} after={entry.runs > entry.history.length ? entry.history.at(-1)?.seq ?? null : null}/></ul></details></th>
          <td>{entry.latest ? <><Result result={entry.latest.result}/><br/><small><Commit sha={entry.latest.sha}/><Pr pr={entry.latest.pr}/>{entry.latest.environment ? <> on {entry.latest.environment}</> : null} · {day(entry.latest.at)}</small>{entry.staleRevision && <><br/><small className="amber">measured v{entry.latest.scenarioRevision}; the case is now v{entry.revision}</small></>}</> : <Result result="never"/>}</td>
          <td>{entry.passRate === undefined || entry.passRate === null ? '—' : <>{percent(entry.passRate)} of {entry.history.filter(run => !run.withdrawn && run.result !== 'skipped').length} runs</>}</td>
          <td>{entry.changed ? <>v{entry.revision} · {day(entry.changed.at)}<br/><small>by {entry.changed.by}</small></> : '—'}</td>
          <td>{entry.failures ? <>{entry.failures}<br/><small>last {day(entry.lastFailure!.at)} on <Commit sha={entry.lastFailure!.sha}/></small></> : 'none'}</td>
          <td>{entry.links.length ? entry.links.map(link => <div key={link.key}><span className="mono">{link.key}</span> {link.criteria.join(', ')}</div>) : <span className="muted">none</span>}</td>
        </tr>)}</tbody></table>
      {!shown.length && <p className="muted">No test case matches this filter.</p>}
    </>}
  </section>;
}
