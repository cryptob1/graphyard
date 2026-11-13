import { useEffect, useRef, useState } from 'react';
import Term from '../components/term';
import type { CaseRun, TrackedCase } from '../../src/scenarios';
import type { JudgedProof } from '../../src/test-runs';
import { matrixColumns, type MatrixCell, type MatrixColumn } from '../../src/test-matrix';

/** Each result in words and a mark; a skip is its own state and never reads as a pass. */
export const resultLabel: Record<string, { mark: string; word: string; tone: string }> = {
  pass: { mark: '✓', word: 'passed', tone: 'pass' }, fail: { mark: '×', word: 'failed', tone: 'fail' }, skipped: { mark: '◌', word: 'skipped', tone: 'skipped' },
  'not-run': { mark: '○', word: 'not run yet', tone: 'none' }, 'no-pr': { mark: '○', word: 'no pull request yet', tone: 'none' }, never: { mark: '○', word: 'never run', tone: 'none' },
  'not-written': { mark: '○', word: 'not written yet', tone: 'none' },
};
export const Result = ({ result }: { result: string }) => { const r = resultLabel[result] ?? resultLabel.never; return <span className={`case-result result-${r.tone}`}>{r.mark} {r.word}</span>; };
const day = (at: string) => new Date(at).toLocaleString();
const Commit = ({ sha }: { sha: string }) => <Term term="commit"><span className="mono">{sha.slice(0, 8)}</span></Term>;
const Pr = ({ pr }: { pr: number | null }) => pr ? <> · <Term term="pull request">PR</Term> #{pr}</> : null;
/** Where a run came from: its commit, pull request, item and its lane's own run identity. */
export const RunLine = ({ run }: { run: CaseRun }) => run.e2e ? <E2eRunLine run={run} e2e={run.e2e}/> : <>
  <Result result={run.result}/> <Commit sha={run.sha}/><Pr pr={run.pr}/> · {run.workKey}
  {' · '}{run.run.url
    ? <a href={run.run.url} target="_blank" rel="noopener noreferrer">{run.run.kind} run {run.run.id.slice(0, 12)}{run.run.attempt ? ` attempt ${String(run.run.attempt).slice(0, 8)}` : ''} ↗</a>
    : <>{run.run.kind} run {run.run.id.slice(0, 12)}{run.run.attempt ? ` attempt ${String(run.run.attempt).slice(0, 8)}` : ''}</>}
  {run.scenarioRevision ? ` · v${run.scenarioRevision}` : ''} · {run.executed} executed / {run.skipped} skipped · {run.producer} · {day(run.at)}{run.withdrawn ? <strong className="amber"> · withdrawn</strong> : null}</>;
/** A `graphyard e2e run` of a repository case: the target it ran against, how long it took, and the step that failed. */
const E2eRunLine = ({ run, e2e }: { run: CaseRun; e2e: NonNullable<CaseRun['e2e']> }) => <>
  <Result result={run.result}/> {run.sha === 'unknown' ? 'unreported commit' : <Commit sha={run.sha}/>} on {run.environment}
  {' · '}e2e run {run.run.id.slice(0, 40)} · {e2e.baseUrl}{run.scenarioRevision ? ` · v${run.scenarioRevision}` : ''} · {(e2e.durationMs / 1000).toFixed(1)} s · {run.producer} · {day(run.at)}
  {e2e.failingStep && <><br/><small className="fail">failed at step {e2e.failingStep.index + 1} {e2e.failingStep.name}: {e2e.failingStep.reason}</small></>}</>;
/** How many items link a case, newest first: the latest few shown, the rest folded away (GY-3194). */
const linkedShown = 3;
type ProofLink = TrackedCase['links'][number];
type OpenItem = ((id: string) => void) | undefined;
/** One item a proof belongs to (GY-3278): its key and title, linking to the item, and the criteria that name the proof, in their own words. */
const Link = ({ link, openItem }: { link: ProofLink; openItem: OpenItem }) => <div className="proof-item">
  <a href={`#${link.key}`} onClick={event => { if (openItem) { event.preventDefault(); openItem(link.id); } }}><span className="mono">{link.key}</span> {link.title}</a>
  {link.criteria.map(criterion => <small key={criterion.id} className="proof-criterion">{criterion.id}: {criterion.text}</small>)}</div>;
export const LinkedWork = ({ links, openItem }: { links: TrackedCase['links']; openItem?: OpenItem }) => {
  if (!links.length) return <span className="muted">none</span>;
  const newest = [...links].reverse(), rest = newest.slice(linkedShown);
  return <>{links.length > 1 && <>{links.length} items</>}
    {newest.slice(0, linkedShown).map(link => <Link key={link.key} link={link} openItem={openItem}/>)}
    {rest.length > 0 && <details><summary>and {rest.length} more {rest.length === 1 ? 'item' : 'items'}</summary>{rest.map(link => <Link key={link.key} link={link} openItem={openItem}/>)}</details>}</>;
};
const percent = (rate: number) => `${Math.round(rate * 100)}%`;

/**
 * Where a case's file stands (GY-3278). Only a case whose item merged without its file on main is
 * an alarm; one whose items are not merged yet is simply not written yet, and is folded away.
 */
const merged = (link: ProofLink) => link.stage === 'done';
const missingOnMain = (entry: TrackedCase) => entry.onMain === false && entry.links.some(merged);
const notBuilt = (entry: TrackedCase) => entry.onMain === false && !entry.links.some(merged) && !entry.latest;
/** Failing first (a failed run, or a merged item's missing case file), then passing, then the rest. */
const caseRank = (entry: TrackedCase) => entry.latest?.result === 'fail' || missingOnMain(entry) ? 0 : entry.latest?.result === 'pass' ? 1 : 2;
const proofRank = (proof: JudgedProof) => proof.record?.result === 'fail' ? 0 : proof.record ? 1 : 2;
const inBacklog = (links: ProofLink[]) => links.length > 0 && links.every(link => link.stage === 'backlog');

type Filter = 'all' | 'fail' | 'flaky' | 'never';
const filters: { id: Filter; label: string; keep: (entry: TrackedCase) => boolean; keepProof: (proof: JudgedProof) => boolean }[] = [
  { id: 'all', label: 'All', keep: () => true, keepProof: () => true },
  { id: 'fail', label: 'Failing', keep: entry => caseRank(entry) === 0, keepProof: proof => proofRank(proof) === 0 },
  { id: 'flaky', label: 'Flaky', keep: entry => entry.flaky, keepProof: () => false },
  { id: 'never', label: 'Never run', keep: entry => !entry.latest, keepProof: proof => !proof.record },
];
type TestsData = { window: number; cases: TrackedCase[]; manual?: JudgedProof[] };

/** One case's older runs, paged from the run ledger on request. */
function OlderRuns({ api, id, after }: { api: (path: string) => Promise<any>; id: string; after: number | null }) {
  const [runs, setRuns] = useState<CaseRun[]>([]);
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
 * definition last changed, how often it has failed and whether it is flaky; and (GY-3278) each
 * proof's item and criterion, failing rows first, the proofs of unbuilt items folded, and every
 * manual and closed-question proof with its state. The page itself writes nothing.
 */
export default function TestsPage({ api, canEdit, setView, openItem }: { api: (path: string) => Promise<any>; canEdit: boolean; setView?: (view: string) => void; openItem?: (id: string) => void }) {
  const [data, setData] = useState<TestsData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [item, setItem] = useState('');
  const [view, setTestsView] = useState<TestsViewMode>('matrix');
  const [matrix, setMatrix] = useState<MatrixFilter>(allPlaces);
  const request = useRef(0);
  const load = async () => {
    const version = ++request.current; setLoading(true); setError('');
    try { const next = await api('tests'); if (version === request.current) setData(next); }
    catch (e) { if (version === request.current) setError((e as Error).message); }
    finally { if (version === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { request.current++; }; }, []);
  return <TestsView data={data} error={error} loading={loading} filter={filter} setFilter={setFilter} item={item} setItem={setItem} view={view} setTestsView={setTestsView} matrix={matrix} setMatrix={setMatrix} retry={() => void load()} api={api} canEdit={canEdit} setView={setView} openItem={openItem}/>;
}

/** One case's row. */
function CaseRow({ entry, api, openItem }: { entry: TrackedCase; api: (path: string) => Promise<any>; openItem: OpenItem }) {
  const stage = entry.links.every(link => link.stage === 'backlog') ? 'in backlog' : 'in progress';
  return <tr data-case={entry.id}>
    <th scope="row" id={`case-${entry.id}`}><span className="mono"><Term term="end-to-end test">e2e:</Term>{entry.id}</span>{entry.title}
      {missingOnMain(entry) && <strong className="case-alarm"> Case file missing on main: {entry.links.filter(merged).map(link => link.key).join(', ')} merged without e2e/cases/{entry.id}.json</strong>}
      {entry.onMain === false && !missingOnMain(entry) && <span className="case-pending"> Case file not written yet — item {stage}</span>}
      {entry.e2e && <><br/><small className="muted">E2E case · {entry.testPath} · targets {entry.e2e.target} · {entry.e2e.required ? <strong>required</strong> : 'optional, never blocks a release'}{entry.e2e.tags.length ? ` · ${entry.e2e.tags.join(', ')}` : ''}</small></>}
      {entry.flaky && <strong className="flaky-flag" title={entry.flakyReason ?? ''}> · flaky: {entry.flakyReason}</strong>}
      {entry.runs > 0 && <details><summary><a href={`#case-${entry.id}`}>History</a> · {entry.runs} {entry.runs === 1 ? 'run' : 'runs'}</summary>
        {entry.purpose && <p className="muted">{entry.purpose}</p>}
        <ul className="run-history">{entry.history.map(run => <li key={run.seq}><RunLine run={run}/></li>)}
          <OlderRuns api={api} id={entry.id} after={entry.runs > entry.history.length ? entry.history.at(-1)?.seq ?? null : null}/></ul></details>}</th>
    <td><LinkedWork links={entry.links} openItem={openItem}/></td>
    <td>{entry.latest ? <><Result result={entry.latest.result}/><br/><small><Commit sha={entry.latest.sha}/><Pr pr={entry.latest.pr}/>{entry.latest.environment ? <> on {entry.latest.environment}</> : null} · {day(entry.latest.at)}</small>{entry.staleRevision && <><br/><small className="amber">measured v{entry.latest.scenarioRevision}; the case is now v{entry.revision}</small></>}</> : <Result result={entry.onMain === false ? 'not-written' : 'never'}/>}</td>
    <td>{entry.passRate === undefined || entry.passRate === null ? '—' : <>{percent(entry.passRate)} of {entry.history.filter(run => !run.withdrawn && run.result !== 'skipped').length} runs</>}</td>
    <td>{entry.changed ? <>v{entry.revision} · {day(entry.changed.at)}<br/><small>by {entry.changed.by}</small></> : '—'}</td>
    <td>{entry.failures ? <>{entry.failures}<br/><small>last {day(entry.lastFailure!.at)} on <Commit sha={entry.lastFailure!.sha}/></small></> : 'none'}</td>
  </tr>;
}
const CaseTable = ({ cases, label, api, openItem }: { cases: TrackedCase[]; label: string; api: (path: string) => Promise<any>; openItem: OpenItem }) =>
  <table className="sessions-table test-cases" aria-label={label}><thead><tr><th scope="col">Case</th><th scope="col">Item and criterion</th><th scope="col">Latest result</th><th scope="col">Pass rate</th><th scope="col">Last change</th><th scope="col">Failures</th></tr></thead>
    <tbody>{cases.map(entry => <CaseRow key={entry.id} entry={entry} api={api} openItem={openItem}/>)}</tbody></table>;
/** A manual or closed-question proof's state: who recorded it and when, or that it is still waiting. */
const ProofState = ({ proof }: { proof: JudgedProof }) => proof.record
  ? <><Result result={proof.record.result}/><br/><small>{proof.proof.startsWith('manual:') ? 'attested' : 'answered'} by {proof.record.producer} · {day(proof.record.at)}</small></>
  : <span className="case-result result-none">○ waiting{proof.proof.startsWith('manual:') ? ' for an attestation' : ' for an answer'}</span>;
const ProofTable = ({ proofs, label, openItem }: { proofs: JudgedProof[]; label: string; openItem: OpenItem }) =>
  <table className="sessions-table test-cases" aria-label={label}><thead><tr><th scope="col">Proof</th><th scope="col">Item and criterion</th><th scope="col">State</th></tr></thead>
    <tbody>{proofs.map(proof => <tr key={`${proof.link.key} ${proof.proof}`} data-proof={proof.proof}><th scope="row"><span className="mono">{proof.proof}</span></th><td><Link link={proof.link} openItem={openItem}/></td><td><ProofState proof={proof}/></td></tr>)}</tbody></table>;
const folded = (count: number) => `${count} ${count === 1 ? 'proof' : 'proofs'} of items not built yet`;

/**
 * The environment matrix (GY-3278 AC-3), the page's default view: each E2E case by category, and
 * its latest result in each place it runs, in delivery order. A place with no record of the case
 * reads 'not run here', neutrally.
 */
type TestsViewMode = 'matrix' | 'cases';
export interface MatrixFilter { failing: boolean; category: string; column: MatrixColumn | 'all'; required?: 'all' | 'required' | 'optional' }
const allPlaces: MatrixFilter = { failing: false, category: 'all', column: 'all', required: 'all' };
const places: Record<MatrixColumn, { label: string; place: string }> = {
  trial: { label: 'Trial', place: 'the latest merge trial that ran it' }, main: { label: 'Main', place: 'the batch gate on main' },
  served: { label: 'Served', place: 'runs against the release this install serves' }, nightly: { label: 'Nightly', place: 'the daily full run' },
};
const ago = (at: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
};
const categoryOf = (entry: TrackedCase) => entry.category ?? 'other';
/** A case's state over the shown places: failing when any failed, passing when any passed, else not run. */
const caseState = (entry: TrackedCase, columns: readonly MatrixColumn[]) => columns.some(column => entry.matrix?.[column]?.result === 'fail') ? 'fail'
  : columns.some(column => entry.matrix?.[column]?.result === 'pass') ? 'pass' : 'none';
const count = (cells: (MatrixCell | undefined)[], result: MatrixCell['result']) => cells.filter(cell => cell?.result === result).length;
const tally = (cells: (MatrixCell | undefined)[]) =>
  [`${count(cells, 'pass')} passed`, `${count(cells, 'fail')} failed`, ...count(cells, 'skipped') ? [`${count(cells, 'skipped')} skipped`] : []].join(' · ');
function Cell({ id, column, cell, openItem, showHistory }: { id: string; column: MatrixColumn; cell: MatrixCell | undefined; openItem: OpenItem; showHistory?(id: string): void }) {
  if (!cell) return <td data-column={column} className="matrix-cell result-none">not run here</td>;
  const r = resultLabel[cell.result], label = <>{r.mark} {r.word}</>, link = cell.link;
  return <td data-column={column} className={`matrix-cell result-${r.tone}`} title={cell.detail ?? undefined}>
    {link && 'url' in link ? <a href={link.url} target="_blank" rel="noopener noreferrer">{label}</a>
      : link ? <a href={`#${link.key}`} onClick={event => { if (openItem) { event.preventDefault(); openItem(link.item); } }}>{label}</a>
      // A run with no output of its own kept elsewhere opens the case's run history, where its failing step is.
      : showHistory && (column === 'trial' || column === 'served') ? <a href={`#case-${id}`} onClick={() => showHistory(id)}>{label}</a> : label}
    <small> {ago(cell.at)}</small></td>;
}
const Chip = ({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) =>
  <button type="button" className={on ? 'chip active' : 'chip'} aria-pressed={on} onClick={onClick}>{children}</button>;

/** Categories by place (GY-3278 AC-4): each cell coloured by its worst case, with its counts, a dot where no case of the category runs there; a click filters the matrix to it. */
function CoverageGrid({ cases, categories, filter, setFilter }: { cases: TrackedCase[]; categories: string[]; filter: MatrixFilter; setFilter(filter: MatrixFilter): void }) {
  return <table className="sessions-table coverage-grid" aria-label="Coverage by category">
    <thead><tr><th scope="col">Category</th>{matrixColumns.map(column => <th key={column} scope="col">{places[column].label}</th>)}</tr></thead>
    <tbody>{categories.map(category => <tr key={category}><th scope="row">{category}</th>{matrixColumns.map(column => {
      const cells = cases.filter(entry => categoryOf(entry) === category).map(entry => entry.matrix?.[column]).filter(Boolean);
      const worst = !cells.length ? 'none' : count(cells, 'fail') ? 'fail' : count(cells, 'skipped') ? 'skipped' : 'pass';
      const words = cells.length ? tally(cells) : 'no case runs here';
      return <td key={column} data-grid={`${category}:${column}`} className={`result-${worst}`}>
        <button type="button" className="text-button" title={`${category} in ${places[column].label}: ${words}`} onClick={() => setFilter({ ...filter, category, column })}>
          {cells.length ? <>{count(cells, 'pass')} ✓ {count(cells, 'fail')} ×{count(cells, 'skipped') ? ` ${count(cells, 'skipped')} ◌` : ''}</> : '·'}</button></td>;
    })}</tr>)}</tbody></table>;
}

export function MatrixView({ cases, filter, setFilter, collapsed, toggle, openItem, showHistory }: { cases: TrackedCase[]; filter: MatrixFilter; setFilter(filter: MatrixFilter): void; collapsed: ReadonlySet<string>; toggle(category: string): void; openItem: OpenItem; showHistory?(id: string): void }) {
  const columns = filter.column === 'all' ? matrixColumns : [filter.column];
  const required = filter.required ?? 'all';
  const kept = cases.filter(entry => required === 'all' || (required === 'required') === !!entry.e2e?.required);
  const categories = [...new Set(cases.map(categoryOf))].sort();
  const inCategory = kept.filter(entry => filter.category === 'all' || categoryOf(entry) === filter.category);
  const rows = inCategory.filter(entry => !filter.failing || caseState(entry, columns) === 'fail');
  const groups = [...new Set(rows.map(categoryOf))].sort();
  const states = inCategory.map(entry => caseState(entry, columns));
  return <>
    <p className="matrix-summary" data-summary="">{inCategory.length} {inCategory.length === 1 ? 'case' : 'cases'} · {inCategory.filter(entry => entry.e2e?.required).length} required · {states.filter(state => state === 'pass').length} passing · {states.filter(state => state === 'fail').length} failing · {states.filter(state => state === 'none').length} not run{filter.column === 'all' ? '' : ` in ${places[filter.column].label}`}</p>
    {categories.length > 0 && <CoverageGrid cases={kept} categories={categories} filter={filter} setFilter={setFilter}/>}
    <details className="matrix-help"><summary>How this works</summary><p>Trial is the merge trial, which runs an item's bound cases against its candidate merged onto main before it lands. Main is the batch gate, which runs the merged batch's cases on main's tip before anything serves it, and Served is a <code>graphyard e2e run</code> against the release this install serves. Nightly is the daily full run of every case on the last verified commit, which never blocks a merge.</p></details>
    <div className="case-filters" role="group" aria-label="Filter the matrix">
      <Chip on={filter.failing} onClick={() => setFilter({ ...filter, failing: !filter.failing })}>Only failing</Chip>
      {(['all', 'required', 'optional'] as const).map(value => <Chip key={value} on={required === value} onClick={() => setFilter({ ...filter, required: value })}>{value === 'all' ? 'Required and optional' : value === 'required' ? 'Required' : 'Optional'}</Chip>)}</div>
    <div className="case-filters" role="group" aria-label="Category">{['all', ...categories].map(category => <Chip key={category} on={filter.category === category} onClick={() => setFilter({ ...filter, category })}>{category === 'all' ? 'Every category' : category}</Chip>)}</div>
    <div className="case-filters" role="group" aria-label="Where it runs">{(['all', ...matrixColumns] as const).map(column => <Chip key={column} on={filter.column === column} onClick={() => setFilter({ ...filter, column })}>{column === 'all' ? 'Every place' : places[column].label}</Chip>)}</div>
    {rows.length ? <table className="sessions-table test-matrix" aria-label="Where each case runs">
      <thead><tr><th scope="col">Case</th>{columns.map(column => <th key={column} scope="col" title={places[column].place}>{places[column].label}<br/><small className="muted">{places[column].place}</small></th>)}</tr>
        <tr className="matrix-totals"><th scope="row">All cases</th>{columns.map(column => <td key={column} data-column={column}>{tally(rows.map(entry => entry.matrix?.[column]))}</td>)}</tr></thead>
      {groups.map(category => { const members = rows.filter(entry => categoryOf(entry) === category), open = !collapsed.has(category), state = members.map(entry => caseState(entry, columns));
        return <tbody key={category} data-category={category}>
          <tr className="matrix-group"><th scope="rowgroup" colSpan={columns.length + 1}><button type="button" className="text-button" aria-expanded={open} onClick={() => toggle(category)}>{open ? '▾' : '▸'} {category}</button> <span className="muted">{state.filter(s => s === 'pass').length} passing · {state.filter(s => s === 'fail').length} failing</span></th></tr>
          {open && members.map(entry => <tr key={entry.id} data-case={entry.id}><th scope="row"><span className="mono">{entry.id}</span>{entry.title ? <><br/><small>{entry.title}</small></> : null}</th>
            {columns.map(column => <Cell key={column} id={entry.id} column={column} cell={entry.matrix?.[column]} openItem={openItem} showHistory={showHistory}/>)}</tr>)}
        </tbody>; })}
    </table> : <p className="muted">No test case matches this filter.</p>}</>;
}
function Matrix(props: Omit<Parameters<typeof MatrixView>[0], 'collapsed' | 'toggle'>) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return <MatrixView {...props} collapsed={collapsed} toggle={category => setCollapsed(current => { const next = new Set(current); if (!next.delete(category)) next.add(category); return next; })}/>;
}

/** The page as rendered from one read, so it can be drawn and tested without the network. */
export function TestsView({ data, error, loading, filter, setFilter, item = '', setItem = () => {}, view = 'matrix', setTestsView = () => {}, matrix = allPlaces, setMatrix = () => {}, retry, api, canEdit, setView, openItem }: { data: TestsData | null; error: string; loading: boolean; filter: Filter; setFilter(filter: Filter): void; item?: string; setItem?(item: string): void;
  view?: TestsViewMode; setTestsView?(view: TestsViewMode): void; matrix?: MatrixFilter; setMatrix?(filter: MatrixFilter): void; retry(): void; api: (path: string) => Promise<any>; canEdit: boolean; setView?: (view: string) => void; openItem?: (id: string) => void }) {
  const cases = data?.cases ?? [], manual = data?.manual ?? [];
  const query = item.trim().toLowerCase();
  const forItem = (links: ProofLink[]) => !query || links.some(link => link.key.toLowerCase().includes(query) || link.title.toLowerCase().includes(query));
  const active = filters.find(f => f.id === filter)!;
  const shown = cases.filter(entry => active.keep(entry) && forItem(entry.links)).sort((a, b) => caseRank(a) - caseRank(b));
  const proofs = manual.filter(proof => active.keepProof(proof) && forItem([proof.link])).sort((a, b) => proofRank(a) - proofRank(b));
  const [visible, unbuilt] = [shown.filter(entry => !notBuilt(entry)), shown.filter(notBuilt)];
  const [visibleProofs, unbuiltProofs] = [proofs.filter(proof => proof.record || !inBacklog([proof.link])), proofs.filter(proof => !proof.record && inBacklog([proof.link]))];
  const count = (id: Filter) => { const f = filters.find(entry => entry.id === id)!; return cases.filter(f.keep).length + manual.filter(f.keepProof).length; };
  return <section className="tests-page" aria-label="Tests">
    <div className="page-heading"><div><div className="eyebrow">WHAT IS TESTED, AND WHETHER IT PASSES</div><h1>Tests</h1>
      <p>Every proof an item must pass: each <Term term="end-to-end test">end-to-end</Term> <Term term="test case">test case</Term> with the item and criterion it proves, its latest trusted result, and its history, and every manual proof with its state. A result is recorded only from a trusted run bound to its commit; a builder cannot record one.</p></div>
      {canEdit && setView && <button type="button" onClick={() => setView('scenarios')}>Define test cases</button>}</div>
    {error && <div role="alert" className="notice danger">{error} <button type="button" disabled={loading} onClick={retry}>Retry loading tests</button>{data ? <p>Previously loaded results are shown; they may be stale.</p> : null}</div>}
    {loading && !data && <p role="status">Loading tests…</p>}
    {data && !cases.length && !manual.length && <div className="empty"><span>◇</span><h2>No test cases yet.</h2><p>Add a case as <code>e2e/cases/ID.json</code> in the repository, register it with <code>graphyard e2e sync</code>, and <code>graphyard e2e run</code> records its runs here.</p></div>}
    {(cases.length > 0 || manual.length > 0) && <div className="case-filters" role="group" aria-label="View">{([['matrix', 'Where each case runs'], ['cases', 'By item and criterion']] as const).map(([id, label]) =>
      <button key={id} type="button" className={view === id ? 'chip active' : 'chip'} aria-pressed={view === id} onClick={() => setTestsView(id)}>{label}</button>)}</div>}
    {view === 'matrix' && (cases.length > 0 || manual.length > 0) && <Matrix cases={cases.filter(entry => !notBuilt(entry))} filter={matrix} setFilter={setMatrix} openItem={openItem} showHistory={() => setTestsView('cases')}/>}
    {view === 'cases' && (cases.length > 0 || manual.length > 0) && <>
      <div className="case-filters" role="group" aria-label="Filter test cases">{filters.map(f => <button key={f.id} type="button" className={filter === f.id ? 'chip active' : 'chip'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} <span className="count">{count(f.id)}</span></button>)}
        <input type="search" aria-label="Filter by item" placeholder="Filter by item" value={item} onChange={event => setItem(event.target.value)}/></div>
      <p className="muted">Failing first. Flaky: passed and failed on the same commit, or changed result twice or more in its last {data!.window} runs. Pass rate is over those runs. Skipped runs count as neither. E2E cases live in <code>e2e/cases/</code>; <code>graphyard e2e run</code> records their runs.</p>
      {visible.length > 0 && <CaseTable cases={visible} label="Test cases" api={api} openItem={openItem}/>}
      {unbuilt.length > 0 && <details className="unbuilt-proofs"><summary>{folded(unbuilt.length)}</summary><CaseTable cases={unbuilt} label="Test cases of items not built yet" api={api} openItem={openItem}/></details>}
      {!shown.length && <p className="muted">No test case matches this filter.</p>}
      {manual.length > 0 && <><h2>Manual and judged proofs</h2>
        {visibleProofs.length > 0 && <ProofTable proofs={visibleProofs} label="Manual and judged proofs" openItem={openItem}/>}
        {unbuiltProofs.length > 0 && <details className="unbuilt-proofs"><summary>{folded(unbuiltProofs.length)}</summary><ProofTable proofs={unbuiltProofs} label="Manual proofs of items not built yet" openItem={openItem}/></details>}
        {!proofs.length && <p className="muted">No manual proof matches this filter.</p>}</>}
    </>}
  </section>;
}
