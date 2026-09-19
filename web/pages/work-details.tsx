import { deliveryState, deploySmokeRequired, type Work } from '../../src/model';
import { diagnose, fileConflicts, obligationLedger, proofPreview } from '../../src/coordination';
import Dialog from '../dialog';
import History from '../history';
import RequirementsEditor from '../requirements';
import { assignment } from '../assignment';
import { CandidatePr, CandidateSha } from '../candidate';
import EvidenceArtifacts from '../components/evidence-artifacts';
import PostDeployment from '../components/post-deployment';
import Term from '../components/term';
import { age } from '../format';
import { plainReason, plainStatus } from '../plain-status';
import type { Dashboard } from './dashboard';

const stepLabel: Record<string, string> = { ready: 'Released for work', build: 'Built and handed in', review: 'Reviewed', test: 'Automated checks pass', acceptance: 'Proven to work', merge: 'Merged' };
const marker: Record<string, { symbol: string; word: string; tone: string }> = {
  passed: { symbol: '✓', word: 'passed', tone: 'pass' }, failed: { symbol: '×', word: 'failed', tone: 'fail' }, revoked: { symbol: '×', word: 'withdrawn', tone: 'fail' },
  deferred: { symbol: '○', word: 'put off', tone: 'pending' }, unmeasured: { symbol: '○', word: 'pending', tone: 'pending' }, incomplete: { symbol: '○', word: 'pending', tone: 'pending' },
};
/** The first sentence, capped: the plain meaning on one line; the whole text stays in the tooltip and in the details. */
const oneLine = (text: string) => { const first = text.split(/(?<=[.;:])\s/)[0]; return first.length > 90 ? `${first.slice(0, 88).replace(/\s+\S*$/, '')}…` : first; };

/**
 * The drawer for one work item. It opens with what a newcomer needs: the status sentence, who
 * owns it, its pull request and the one thing blocking progress; then the current step's reasons
 * and each criterion once. Everything else (later steps, evidence, history, raw gate reasons)
 * is under "More details", and policy-changing actions are in the admin-only Edit menu.
 */
export default function WorkDetails({ item, work, status, token, observedAt, jobs, queue, events, busy, codexAvailable, editingRequirements, setEditingRequirements, action, api, refresh, setSelected, sessionEpoch }: Dashboard & { item: Work }) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const plain = plainStatus(item, now);
  const owner = assignment(item, now);
  const admin = status?.actor?.role === 'admin';
  const current = item.gates.findIndex(g => !g.passed);
  const later = current < 0 ? [] : item.gates.slice(current + 1).filter(g => !g.passed);
  const proofs = proofPreview(item, work);
  const entry = queue.find(e => e.id === item.id);
  const provider = item.policy.reviewProvider ?? 'github';
  const failedDelivery = deliveryState(item) === 'delivered-with-failure';
  const postDeployment = <PostDeployment item={item} repository={status?.repository} baseBranch={status?.baseBranch ?? 'main'} observedAt={observedAt}/>;
  return <Dialog onClose={() => setSelected(null)}><section role="dialog" aria-modal="true" aria-label={item.title} className="drawer" onClick={e => e.stopPropagation()}><button className="close" aria-label="Close details" onClick={() => setSelected(null)}>×</button>
    <div className="drawer-key">{item.key}</div><h2>{item.title}</h2>
    <p className={`status-sentence tone-${plain.tone}`}>{plain.sentence}</p>
    <dl className="facts">
      <div><dt>Owner</dt><dd className="assignment-details">{owner.active ? owner.label : owner.owner ? owner.text : 'Nobody yet'}</dd></div>
      <div><dt>Pull request</dt><dd className="candidate-details">{item.candidate ? <><CandidatePr repository={status?.repository} candidate={item.candidate} workKey={item.key}/> <CandidateSha repository={status?.repository} sha={item.candidate.sha} workKey={item.key}/></> : 'None yet'}</dd></div>
    </dl>
    {plain.blocking && <p className="blocking-now"><strong>Blocking now:</strong> {plain.blocking}</p>}
    {item.violations.map(v => <div className="notice danger" key={v}>{v}</div>)}
    {!item.ready && admin && <button disabled={busy} onClick={() => action(item.id, 'ready')}>Release to ready</button>}
    {failedDelivery && postDeployment}
    {item.stage !== 'done' && current >= 0 && <><h3>Steps</h3><ol className="steps">
      {item.gates.map((g, i) => i < current ? <li key={g.name} className="step done">✓ {stepLabel[g.name] ?? g.name}</li> : i === current && <li key={g.name} className="step current">○ {stepLabel[g.name] ?? g.name}
        {g.name === 'acceptance' ? <p>{g.reasons.length} {g.reasons.length === 1 ? 'thing' : 'things'} still to prove — see below.</p> : <ul>{g.reasons.map(r => <li key={r}>{plainReason(r, g.name).text}</li>)}</ul>}</li>)}
    </ol>
    {later.length > 0 && <details className="later-steps"><summary>Later steps ({later.length})</summary><ul>{later.map(g => <li key={g.name}><strong>{stepLabel[g.name] ?? g.name}:</strong> {[...new Set(g.reasons.map(r => plainReason(r, g.name).text))].join('; ')}</li>)}</ul></details>}</>}
    <h3>What must be true</h3>
    {item.criteria.map(ac => <div className="criterion" key={ac.id}><strong>{ac.id}</strong> <span className="criterion-text" title={ac.text}>{oneLine(ac.text)}</span>
      <ul className="proof-markers">{proofs.filter(p => p.criterion === ac.id).map(p => <li key={p.proof} className={`marker-${marker[p.status]?.tone ?? 'pending'}`}>{marker[p.status]?.symbol ?? '○'} <Term term="proof">{p.proof}</Term> {marker[p.status]?.word ?? p.status}</li>)}</ul></div>)}
    {admin && item.stage !== 'done' && <details className="edit-menu"><summary>Edit</summary>
      <p className="muted">These change the rules for this item and need fresh proof afterwards.</p>
      {item.policy.review && <>{!codexAvailable && <p className="muted">Codex review is unavailable. Verify the GitHub App connection and accept its required permission updates.</p>}
        <button disabled={busy || provider === 'github' && !codexAvailable} onClick={() => action(item.id, 'reviewpolicy', { provider: provider === 'github' ? 'codex' : 'github', expectedPolicyRevision: item.policyRevision, reason: 'Operator changed review provider through dashboard' })}>Use {provider === 'github' ? 'Codex cloud' : 'formal GitHub'} review</button>
        {provider !== 'github' && item.submission && <button disabled={busy || !codexAvailable} onClick={() => action(item.id, 'rereview')}>Request fresh {item.policy.reviewProvider === 'codex' ? 'Codex' : 'agent'} review</button>}</>}
      <button disabled={busy || owner.active} onClick={() => setEditingRequirements(v => !v)}>Revise requirements</button>
    </details>}
    {editingRequirements && <RequirementsEditor key={`${item.id}:${item.policyRevision}`} item={item} all={work} api={api} onSaved={async () => { const epoch = sessionEpoch.current; setEditingRequirements(false); await refresh(epoch); }}/>}
    <details className="more-details"><summary>More details</summary>
      <p>{item.description}</p>
      <div className="tags"><span>{item.type}</span><span>P{item.priority}</span><span>{item.stage}</span><span>In this step for {age(item.stageEnteredAt)}</span><span>Policy v{item.policyRevision}</span><span>Revision {item.revision}</span>{deploySmokeRequired(item.policy) && <span>e2e:deploy-smoke after deploy</span>}</div>
      <h3>Ownership</h3><p>{owner.text}</p>{owner.owner && <p className="muted">Worker ID: {owner.owner} · assignment {owner.epoch}</p>}<p>{owner.active && item.lease ? `Active lease · expires ${new Date(item.lease.expiresAt).toLocaleTimeString()}` : 'No active assignment'}</p>{item.workspaces.map(w => <code key={w.epoch}>{w.host}:{w.path}<br/>{w.branch} · assignment {w.epoch}</code>)}
      {!failedDelivery && postDeployment}
      <h3>Coordination</h3>{diagnose(item, work, observedAt, jobs).map((d, i) => <div className="criterion" key={i}><strong>{d.message}</strong><p>{d.next}</p></div>)}
      {!!item.exclusiveResources?.length && <p>Exclusive resources: {item.exclusiveResources.join(', ')}. Reserved only while an assignment lease is active.</p>}
      {fileConflicts(item, work).map(c => <div className="notice" key={c.key}>Possible overlap with {c.key}: {c.paths.join(', ')}. Coordinate the changes; this warning does not establish a semantic conflict.</div>)}
      {entry && <><h3>Merge queue</h3><p>Position {entry.position + 1} of {entry.size} · waiting {age(entry.enqueuedAt)} · {entry.current ? 'validated on its predicted tip' : 'awaiting speculative validation'}</p><p className="muted">Predicted base <code>{entry.predictedBase ? entry.predictedBase.slice(0, 12) : 'pending'}</code> · predicted tip <code>{entry.tip ? entry.tip.slice(0, 12) : 'pending'}</code>{entry.predecessors.length ? ` · behind ${entry.predecessors.join(', ')}` : ''}</p>{entry.reasons.map(reason => <p className="muted" key={reason}>{reason}</p>)}{item.queue?.speculation && <code>{item.queue.speculation.ref}</code>}</>}
      {!entry && item.queueEjection && <><h3>Merge queue</h3><p className="amber">Ejected {new Date(item.queueEjection.at).toLocaleString()}: {item.queueEjection.reason}</p><p className="muted">A new candidate re-enters at the back of the queue. There is no bypass.</p></>}
      <h3>Code review</h3><p>Provider: {item.policy.reviewProvider === 'codex' ? 'Codex cloud' : item.policy.reviewProvider === 'agent' ? 'Identity-bound agent reviewers' : 'Formal GitHub approval'}</p>{item.policy.reviewProvider === 'agent' && <p className="muted">Reviewer profiles in failover order: {(item.policy.reviewerProfiles ?? []).map(p => `${p.name} (${p.runtime})`).join(' → ') || 'none configured'}</p>}{item.observation?.agentReview && <p>{item.observation.agentReview.reason}</p>}{(item.reviewFailovers ?? []).filter(f => f.sha === item.candidate?.sha && f.baseSha === item.candidate?.baseSha && f.policyRevision === item.policyRevision).map(f => <p className="amber" key={`${f.profile}-${f.at}`}>Failover: {f.profile} exhausted ({f.exhaustion}) · {f.nextProfile ? `dispatched to ${f.nextProfile}` : 'no reviewer profile remains'}</p>)}{admin && <p className="muted">Changing provider creates a policy revision and requires fresh acceptance evidence. Agent reviewer profiles are configured through the CLI or API because they name registered reviewer App identities.</p>}
      <h3>Gate decisions</h3>{item.gates.map(g => <div className="gate" key={g.name}><strong className={g.passed ? 'green-text' : 'amber'}>{g.passed ? '✓' : '○'} {g.name}</strong>{g.reasons.map(r => <p key={r}>{r}</p>)}</div>)}
      <h3>Acceptance criteria and required proof</h3>{item.criteria.map(ac => <div className="criterion" key={ac.id}><strong>{ac.id} · {ac.text}{ac.bootstrap ? ' · bootstrap mode' : ''}</strong>{ac.bootstrap && <p className="amber">Proof deferred by {ac.bootstrap.declaredBy} on {new Date(ac.bootstrap.declaredAt).toLocaleString()} at policy v{ac.bootstrap.policyRevision}: {ac.bootstrap.reason}. Review, CI and every other criterion still gate this item. The proof is not dropped — it stays owed on {ac.bootstrap.contractPaths.join(', ')} and the next change touching that contract must produce it.</p>}</div>)}
      {proofs.map(p => <div className="criterion" key={`${p.criterion}:${p.proof}`}><strong>{p.criterion} · {p.proof} · {p.status}</strong><p>{p.status === 'deferred' ? `Deferred in bootstrap mode; recorded as an obligation on ${p.bootstrap?.contractPaths.join(', ')}` : p.scenario ? `Scenario v${p.scenario.revision} in ${p.scenario.environment}` : 'Requires an authorized producer or manual operator evidence'} · current candidate and policy v{item.policyRevision}</p>{p.status !== 'deferred' && p.bootstrap && <p className="amber">Inherited from {p.bootstrap.key} {p.bootstrap.criterionId} because this item plans to touch {p.bootstrap.contractPaths.join(', ')}. A bootstrap deferral cannot be renewed by the change that inherits it.</p>}{item.proofGaps?.includes(p.proof) && <p className="amber">No principal was authorized to produce {p.proof} when this intent was recorded. Open Proof authority and grant it before dispatch.</p>}</div>)}
      {(() => { const ledger = obligationLedger(work); return ledger.length > 0 && <><h3>Bootstrap obligations ({ledger.length})</h3><p className="muted">Deferred proofs still owed across this repository. An obligation clears only when a delivered change produces trusted passing evidence for it; no operator command retires one.</p>{ledger.map(o => <div className="criterion" key={`${o.workId}:${o.criterionId}:${o.proof}`}><strong>{o.proof} · owed by {o.key} {o.criterionId}</strong><p>{o.reason} · contract {o.contractPaths.join(', ')} · declared by {o.declaredBy} on {new Date(o.declaredAt).toLocaleString()} at policy v{o.policyRevision}</p><p>{o.inheritedBy.length ? `Inherited by ${o.inheritedBy.join(', ')}` : 'No planned work touches this contract yet'}</p></div>)}</>; })()}
      {!!item.releaseDeliveries?.length && <><h3>Observed delivery</h3>{item.releaseDeliveries.map(d => <p key={d.environment}>Verified in {d.environment} · release {d.releaseId} r{d.releaseRevision} · generation {d.generation} · {new Date(d.verifiedAt).toLocaleString()}</p>)}<p className="muted">Independently observed runtime identity over a common interval, recorded once per environment. The merge above is a separate fact.</p></>}
      <h3>Evidence ({item.evidence.length})</h3>{item.evidence.map(e => <div className="criterion evidence-row" key={e.id}><strong>{e.revocation ? '⦸' : e.result === 'pass' ? '✓' : '×'} {e.proof}</strong><p>{e.trusted ? 'Trusted producer' : 'Worker assertion'} · {e.producer} · {e.sha.slice(0, 8)} · {e.executed} executed / {e.skipped} skipped</p>{e.revocation && <p className="amber">Revoked by {e.revocation.actor}: {e.revocation.reason}</p>}{e.reuse && <p className="muted">Reused from the pass observed {new Date(e.reuse.observedAt).toLocaleString()} on {e.reuse.sourceSha.slice(0, 8)} (attempt sequence {e.reuse.sequence}, policy {e.reuse.policy.id} r{e.reuse.policy.revision}); a newer live attempt supersedes it.</p>}<EvidenceArtifacts evidence={e} token={token} observedAt={observedAt}/></div>)}
      <History key={item.id} events={events}/>
    </details>
  </section></Dialog>;
}
