import { useEffect, useState } from 'react';
import type { Work } from '../../src/model';
import { headTrial, linkedCases } from '../../src/model/test-cases';
import type { Scenario } from '../../src/scenarios';
import { Result } from '../pages/tests';
import Term from './term';

/**
 * The tests linked to this item's pull request, with their result on its current head (GY-162,
 * GY-2091): every test proof its criteria name — a `unit:`/`integration:` proof as the merge
 * writer's trial of the head judged it, an `e2e:` proof as the acceptance gate selects it. The
 * registry is read only for e2e titles and for the cases whose test file the pull request
 * changes, listed apart and never as a requirement.
 */
export default function TestCases({ item, api }: { item: Work; api: (path: string) => Promise<any> }) {
  const [registry, setRegistry] = useState<Scenario[] | null>(null);
  useEffect(() => { let live = true; api('scenarios').then(rows => { if (live) setRegistry(rows); }, () => {}); return () => { live = false; }; }, [item.id]);
  return <TestCasesView item={item} registry={registry}/>;
}

export function TestCasesView({ item, registry, now = new Date() }: { item: Work; registry: Scenario[] | null; now?: Date }) {
  const { linked, touched } = linkedCases(item, registry, now);
  if (!linked.length && !touched.length) return null;
  const passed = linked.filter(entry => entry.head === 'pass').length;
  const trial = headTrial(item);
  const summary = [trial?.build ? `build ${trial.build === 'pass' ? 'passed' : 'failed'}` : null, trial?.testFiles !== undefined ? `${trial.testFiles} test files ran` : null].filter(Boolean).join(' · ');
  return <section className="panel" aria-label="Tests"><h2>Tests <small>{linked.length ? <>{passed} of {linked.length} passed on {item.candidate ? <>the current <Term term="commit">head</Term></> : 'no head yet'}</> : 'none required'}</small></h2>
    {summary && <p className="muted trial-summary">Merge trial of <span className="mono">{trial!.mergeSha.slice(0, 8)}</span>: {summary}</p>}
    {linked.length > 0 && <ul className="test-case-list">{linked.map(entry => <li key={entry.proof} data-case={entry.id}>
      <Result result={entry.head}/> <Term term="proof">{entry.proof}</Term> {entry.title ?? ''} <small className="muted">· {entry.criteria.join(', ')}{entry.pinned ? ` · v${entry.pinned.revision} in ${entry.pinned.environment}` : ''}</small>
      {entry.trial && <><br/><small className="muted">{entry.trial.executed} executed in the merge trial{entry.trial.failed ? ` · ${entry.trial.failed} failed` : ''}</small></>}
      {entry.evidence && <><br/><small className="muted">{entry.evidence.executed} executed / {entry.evidence.skipped} skipped · {entry.evidence.run.kind} run {entry.evidence.run.id.slice(0, 12)}{entry.evidence.run.attempt ? ` attempt ${String(entry.evidence.run.attempt).slice(0, 8)}` : ''} · {entry.evidence.producer} · {new Date(entry.evidence.at).toLocaleString()}</small></>}
    </li>)}</ul>}
    {touched.length > 0 && <><h3>Touched by this <Term term="pull request">pull request</Term> <small>· not required</small></h3><ul className="test-case-list">{touched.map(entry => <li key={entry.id} data-touched={entry.id}><Term term="end-to-end test">e2e:</Term>{entry.id} {entry.title} <small className="muted">· changes <code>{entry.testPath}</code></small></li>)}</ul></>}
  </section>;
}
