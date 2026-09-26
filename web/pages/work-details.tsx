import { useEffect } from 'react';
import { deliveryState, deploySmokeRequired, isClosed, type Work } from '../../src/model';
import { sessionSummary } from '../../src/model/sessions';
import { openAgentRequests } from '../../src/model/agent-requests';
import { humanDecisionLabel, humanOnlyRefusal, openHumanOnly, type HumanRequestRow } from '../../src/model/human-request';
import { diagnose, obligationLedger, proofPreview } from '../../src/coordination';
import History from '../history';
import RequirementsEditor from '../requirements';
import { assignment } from '../../src/model/assignment';
import { CandidatePr, CandidateSha, shortShas } from '../candidate';
import EvidenceArtifacts from '../components/evidence-artifacts';
import PostDeployment from '../components/post-deployment';
import StatusAge from '../components/status-age';
import Term, { Explained } from '../components/term';
import { age } from '../../src/model/format';
import { formatAge } from '../../src/model/duration';
import { candidatePrUrl } from '../links';
import { activityLabel, historyLabel, overlapLine, whatIsLeft, type LeftGroup } from '../item-page';
import { plainStatus } from '../../src/model/plain-status';
import { groupWithin, nextActor, timedGroups } from '../groups';
import { checkStates, prSteps, stepHeld } from '../../src/model/pr-steps';
import { releaseView } from '../../src/model/release';
import StatusBadge from '../components/status-badge';
import { StepsDetail } from '../components/steps-bar';
import { RequestCard } from './human-requests';
import type { Dashboard } from './dashboard';
import { LiveSessions } from '../session-viewer';

const marker: Record<string, { symbol: string; word: string; tone: string }> = {
  passed: { symbol: '✓', word: 'passed', tone: 'pass' }, failed: { symbol: '×', word: 'failed', tone: 'fail' }, revoked: { symbol: '×', word: 'withdrawn', tone: 'fail' },
  deferred: { symbol: '○', word: 'put off', tone: 'pending' }, unmeasured: { symbol: '○', word: 'pending', tone: 'pending' }, incomplete: { symbol: '○', word: 'pending', tone: 'pending' },
};
/** A sentence without its pull request mention: the page header links the pull request once. */
const withoutPr = (sentence: string) => sentence.replace(/\s*(?:of|on|in)?\s*PR #\d+/g, '').replace(/\s+—/, ' —');
/** The first sentence, capped: the plain meaning on one line; the whole text stays in the tooltip and in the details. */
const oneLine = (text: string) => { const first = text.split(/(?<=[.;:])\s/)[0]; return first.length > 90 ? `${first.slice(0, 88).replace(/\s+\S*$/, '')}…` : first; };

/**
 * One work item's page (GY-161). Its first screen answers, without scrolling or a click: what
 * state it is in (its group's badge), why (one plain sentence), who acts next (a role, never a
 * code name), where it is in the seven pull-request steps, and its pull request, linked once in
 * the header. A decision only the human may make is answered right here. Below it (GY-171), each
 * section answers one question, in this order: What is left (one plain line per unmet
 * requirement, grouped by step, naming who clears it; gate reasons only through `plainReason`),
 * Requirements (one line per criterion with its met or pending mark, the full text on expand),
 * Pull request (link, commit, changed files, checks, review) and Activity (the latest events, the
 * full history on expand). Everything technical — gate internals, sessions and their attach
 * commands, review provider, next action and executors, agent requests, evidence — is in one
 * collapsed "Technical details" section, in the control plane's own vocabulary, and policy
 * changes are in the admin Edit menu.
 */
export default function WorkDetails({ item, work, status, token, observedAt, jobs, queue, events, busy, codexAvailable, editingRequirements, setEditingRequirements, action, api, refresh, setSelected, setView, sessionEpoch, stepMoves }: Dashboard & { item: Work }) {
  const now = Number.isNaN(observedAt) ? Date.now() : observedAt;
  const plain = plainStatus(item, now);
  // The same duration and the same threshold the card carries; this view is another view of it.
  const release = releaseView(status);
  const held = stepHeld(item, now, stepMoves, release);
  const owner = assignment(item, now);
  const admin = status?.actor?.role === 'admin';
  const proofs = proofPreview(item, work);
  const entry = queue.find(e => e.id === item.id);
  const provider = item.policy.reviewProvider ?? 'github';
  const failedDelivery = deliveryState(item) === 'delivered-with-failure';
  const prUrl = item.candidate ? candidatePrUrl(status?.repository, item.candidate.pr) : undefined;
  const postDeployment = <PostDeployment item={item} repository={status?.repository} baseBranch={status?.baseBranch ?? 'main'} observedAt={observedAt}/>;
  // The inverted loop, as this item sees it: what the control plane says to do next, which
  // executor has it, who is waiting on a decision, and every session that can be watched or read.
  const sessions = sessionSummary(item, new Date(now));
  // Shown running only while its latest observation is working or idle, and fresh (GY-172).
  const running = sessions.filter(handle => handle.live);
  const requests = openAgentRequests(item, new Date(now));
  // What this item needs from the operator themselves, from the same human-only rule table the
  // Needs you page renders: it is answered there, in this session, never on a command line.
  const waitingOnYou: HumanRequestRow[] = (status?.humanOnly ?? openHumanOnly([{ work: item }], now)).filter((row: HumanRequestRow) => row.id === item.id);
  const actions = item.actionQueue?.actions ?? [];
  // A pending action no live executor serves (GY-105), as the control plane reports it: shown as
  // unclaimable rather than as waiting its turn.
  const unserved: { kind: string; since: string; start: string } | undefined = (status?.executors?.unserved ?? []).find((entry: any) => entry.work === item.id);
  // Escape returns to the page the item was opened from, unless the reader is typing.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement | null)?.closest?.('input, textarea, select, [role="dialog"]')) setSelected(null); };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [setSelected]);
  // The Work page's own classification of this item, so its badge is the tile that led here.
  const group = groupWithin(item, work, now, status?.humanOnly, release);
  const steps = prSteps(item, now, release);
  const actor = nextActor(item, group, now, release, work);
  // Work closed without merging has no step: no bar, nothing left, nobody acting (`prSteps`).
  const closed = isClosed(item);
  const showSteps = !closed && (group === 'moving' || group === 'blocked' || group === 'shipped' || (!!item.submission && group !== 'backlog'));
  // The why, in plain words and without the pull request, which the header links once.
  const why = group === 'needs-you' && item.humanRequest ? `Waiting on your decision about ${humanDecisionLabel[item.humanRequest.kind]}: ${item.humanRequest.reason}`
    : group === 'moving' ? `${steps.label}.`
      // Merged work blocked at Deploy says what the release lacks, not that it shipped.
      : group === 'blocked' && steps.current === 'deploy' ? `${steps.detail.replace(/^./, c => c.toUpperCase())}.`
      // Waiting work is described by what it waits for, never by who last held it.
      : group === 'up-next' || group === 'backlog' ? (actor.who === 'Nobody yet' ? actor.does : group === 'backlog' ? 'Not released for work yet.' : item.reworkRequested ? 'Sent back for changes; waiting for a builder.' : 'Released for work; waiting for a builder.')
        : withoutPr(plain.sentence).replace(/^Stuck: /, '').replace(/^./, c => c.toUpperCase());
  // What is left, one plain line per unmet requirement, grouped by the step that owns it (web/item-page.ts).
  const left = whatIsLeft(item, now, release);
  const [currentLeft, ...laterLeft] = left;
  const leftCount = left.reduce((sum, group) => sum + group.lines.length, 0);
  const overlap = overlapLine(item, work);
  const leftGroup = (group: LeftGroup) => <section key={group.step} className="left-step" aria-label={`${group.label} step`}>
    <h3>{group.label} <small>· cleared by {group.who}</small></h3>
    <ul className="left-list">{group.lines.map(text => <li key={text}><Explained sentence={text}/></li>)}</ul></section>;
  // Each required check as the test gate reads it, the same states the Test step counts.
  const checks = checkStates(item, release.ciAppIds);
  // The review gate's own verdict, whichever provider gave it (GitHub, Codex or an agent reviewer).
  const reviewGate = item.gates.find(g => g.name === 'review');
  const review = !reviewGate || reviewGate.passed ? 'Approved' : reviewGate.reasons.some(r => r.startsWith('Outstanding change requests')) ? 'Changes requested' : 'Waiting for approval';
  return <article className="item-page" aria-label={item.title}>
    <button type="button" className="text-button back" autoFocus onClick={() => setSelected(null)}>← Back</button>
    <div className="item-head">
      <div className="item-title">
        <div className="item-meta"><span className="mono">{item.key}</span>{group && <StatusBadge group={group}/>}<span>{item.type.replace(/^./, c => c.toUpperCase())} · priority {item.priority}</span>{timedGroups.has(group ?? 'shipped') && <StatusAge held={held}/>}</div>
        <h1 data-title>{item.title}</h1>
      </div>
      {item.candidate && <span className="pr-button"><CandidatePr repository={status?.repository} candidate={item.candidate} workKey={item.key}/> on GitHub ↗</span>}
    </div>
    <section className={`where-now group-${group ?? 'shipped'}`} aria-label="Where it is now">
      <p className={`status-sentence tone-${plain.tone}`}><Explained sentence={why}/></p>
      <p className="next-line"><span className="next-label">Who acts next:</span> <strong>{actor.who}</strong>{actor.does && actor.does !== steps.label ? <> — {actor.does}</> : null}</p>
      {showSteps && <StepsDetail steps={steps}/>}
      {waitingOnYou.map(row => <RequestCard key={row.request.id} row={row} refusal={humanOnlyRefusal(row.rule, status?.actor ?? {})} busy={busy} open={() => {}}
        answer={(text, post) => action(row.id, row.answer.post.command, { ...post, [row.answer.post.field]: text })}/>)}
      {item.violations.map(v => <div className="notice danger" key={v}>{shortShas(v)}</div>)}
      {!item.ready && admin && <button type="button" disabled={busy} onClick={() => action(item.id, 'ready')}>Release to ready</button>}
      {failedDelivery && postDeployment}
    </section>
    <LiveSessions api={api} work={item.id} title="Sessions"/>
    <section className="panel" aria-label="What is left"><h2>What is left <small>{leftCount ? `${leftCount} ${leftCount === 1 ? 'thing' : 'things'}` : 'nothing blocks it'}</small></h2>
      {currentLeft ? leftGroup(currentLeft) : <p className="muted">When something blocks a step it is listed here in plain words, with who clears it.</p>}
      {laterLeft.length > 0 && <details className="later-steps"><summary>Later steps ({laterLeft.length})</summary>{laterLeft.map(leftGroup)}</details>}</section>
    <section className="panel requirements" aria-label="Requirements"><h2>Requirements <small>{item.criteria.length} · {proofs.filter(p => p.status === 'passed').length} of {proofs.length} proofs passed</small></h2>
      {item.criteria.map(ac => { const own = proofs.filter(p => p.criterion === ac.id); const met = own.length > 0 && own.every(p => p.status === 'passed');
        return <div className={`criterion ${met ? 'criterion-met' : 'criterion-pending'}`} key={ac.id}>
          <details className="criterion-full"><summary><span className="criterion-mark" title={met ? 'Met' : 'Pending'}>{met ? '✓' : '○'}</span> <span className="mono">{ac.id}</span> <span className="criterion-text" title={ac.text}>{oneLine(ac.text)}</span></summary><p>{ac.text}</p></details>
          <ul className="proof-markers">{own.map(p => <li key={p.proof} className={`marker-${marker[p.status]?.tone ?? 'pending'}`}>{marker[p.status]?.symbol ?? '○'} <Term term="proof">{p.proof}</Term> {marker[p.status]?.word ?? p.status}</li>)}</ul></div>; })}</section>
    <section className="panel" aria-label="Pull request"><h2>Pull request</h2>
      {item.candidate ? <dl className="facts">
        {prUrl && <div><dt>Link</dt><dd><a className="pr-open" href={prUrl} target="_blank" rel="noopener noreferrer" aria-label={`Pull request on GitHub for ${item.key}`}>Open on GitHub ↗</a></dd></div>}
        <div><dt><Term term="commit" focusable={false}>Commit</Term></dt><dd className="candidate-details"><CandidateSha repository={status?.repository} sha={item.candidate.sha} workKey={item.key}/></dd></div>
        {item.observation?.files && <div><dt>Changes</dt><dd>{item.observation.files.length} {item.observation.files.length === 1 ? 'file' : 'files'}</dd></div>}
        <div><dt>Checks</dt><dd>{checks.length ? checks.map(check => `${check.name} ${check.state}`).join(' · ') : 'none required'}</dd></div>
        <div><dt>Review</dt><dd>{!item.policy.review ? 'not required' : review}</dd></div>
      </dl> : <p className="muted">No pull request yet.</p>}
    </section>
    <section className="panel activity" aria-label="Activity"><h2>Activity</h2>
      {events.length ? <ul className="activity-list">{events.slice(0, 3).map(event => <li key={event.seq}>{activityLabel(event.kind)} <small>· {formatAge(event.created_at, now)} ago</small></li>)}</ul> : <p className="muted">Nothing recorded yet.</p>}
      <details className="full-history"><summary>{historyLabel(events.length)}</summary><History key={item.id} events={events}/></details>
    </section>
    {admin && item.stage !== 'done' && <details className="edit-menu"><summary>Edit</summary>
      <p className="muted">These change the rules for this item and need fresh proof afterwards.</p>
      {item.policy.review && <>{!codexAvailable && <p className="muted">Codex review is unavailable. Verify the GitHub App connection and accept its required permission updates.</p>}
        <button disabled={busy || provider === 'github' && !codexAvailable} onClick={() => action(item.id, 'reviewpolicy', { provider: provider === 'github' ? 'codex' : 'github', expectedPolicyRevision: item.policyRevision, reason: 'Operator changed review provider through dashboard' })}>Use {provider === 'github' ? 'Codex cloud' : 'formal GitHub'} review</button>
        {provider !== 'github' && item.submission && <button disabled={busy || !codexAvailable} onClick={() => action(item.id, 'rereview')}>Request fresh {item.policy.reviewProvider === 'codex' ? 'Codex' : 'agent'} review</button>}</>}
      <button disabled={busy || owner.active} onClick={() => setEditingRequirements(v => !v)}>Revise requirements</button>
    </details>}
    {editingRequirements && <RequirementsEditor key={`${item.id}:${item.policyRevision}`} item={item} all={work} api={api} onSaved={async () => { const epoch = sessionEpoch.current; setEditingRequirements(false); await refresh(epoch); }}/>}
    {/* Everything technical, one click down, in the control plane's own vocabulary. */}
    <details className="more-details" aria-label="Technical details"><summary>Technical details</summary>
      <h3>About this item</h3>
      <p>{item.description}</p>
      <dl className="facts">
        <div><dt>Owner</dt><dd className="assignment-details">{owner.active ? owner.label : owner.owner ? owner.text : 'Nobody yet'}</dd></div>
      </dl>
      {plain.blocking && <p className="blocking-now"><strong>Blocking now:</strong> <Explained sentence={plain.blocking}/></p>}
      <div className="tags"><span>{item.type}</span><span>P{item.priority}</span><span>{item.stage}</span><span>In this step for {age(item.stageEnteredAt)}</span><span>Policy v{item.policyRevision}</span><span>Revision {item.revision}</span>{deploySmokeRequired(item.policy) && <span><Term term="post-deploy check">e2e:deploy-smoke</Term> after deploy</span>}</div>
      <h3>Ownership</h3><p>{owner.text}</p>{owner.owner && <p className="muted">Worker ID: {owner.owner} · assignment {owner.epoch}</p>}<p>{owner.active && item.lease ? `Active lease · expires ${new Date(item.lease.expiresAt).toLocaleTimeString()}` : 'No active assignment'}</p>{item.workspaces.map(w => <code key={w.epoch}>{w.host}:{w.path}<br/>{w.branch} · assignment {w.epoch}</code>)}
      {!failedDelivery && postDeployment}
      <h3>Gate decisions</h3>{item.gates.map(g => <div className="gate" key={g.name}><strong className={g.passed ? 'green-text' : 'amber'}>{g.passed ? '✓' : '○'} {g.name}</strong>{g.reasons.map(r => <p key={r}>{shortShas(r)}</p>)}</div>)}
      <h3>Coordination</h3>{diagnose(item, work, observedAt, jobs).map((d, i) => <div className="criterion" key={i}><strong>{shortShas(d.message)}</strong><p>{shortShas(d.next)}</p></div>)}
      {!!item.exclusiveResources?.length && <p>Exclusive resources: {item.exclusiveResources.join(', ')}. Reserved only while an assignment lease is active.</p>}
      {overlap && <p className="overlap-line">{overlap}. Coordinate the changes; this warning does not establish a semantic conflict.</p>}
      {entry && <><h3>Merge queue</h3><p>Position {entry.position + 1} of {entry.size} · waiting {age(entry.enqueuedAt)} · {entry.current ? 'validated on its predicted tip' : 'awaiting speculative validation'}</p><p className="muted">Predicted base <code>{entry.predictedBase ? entry.predictedBase.slice(0, 8) : 'pending'}</code> · predicted tip <code>{entry.tip ? entry.tip.slice(0, 8) : 'pending'}</code>{entry.predecessors.length ? ` · behind ${entry.predecessors.join(', ')}` : ''}</p>{entry.reasons.map(reason => <p className="muted" key={reason}>{shortShas(reason)}</p>)}{item.queue?.speculation && <code>{shortShas(item.queue.speculation.ref)}</code>}</>}
      {!entry && item.queueEjection && <><h3>Merge queue</h3><p className="amber">Ejected {new Date(item.queueEjection.at).toLocaleString()}: {shortShas(item.queueEjection.reason)}</p><p className="muted">A new candidate re-enters at the back of the queue. There is no bypass.</p></>}
      <h3>Code review</h3><p>Provider: {item.policy.reviewProvider === 'codex' ? 'Codex cloud' : item.policy.reviewProvider === 'agent' ? 'Identity-bound agent reviewers' : 'Formal GitHub approval'}</p>{item.policy.reviewProvider === 'agent' && <p className="muted">Reviewer profiles in failover order: {(item.policy.reviewerProfiles ?? []).map(p => `${p.name} (${p.runtime})`).join(' → ') || 'none configured'}</p>}{item.observation?.agentReview && <p>{shortShas(item.observation.agentReview.reason)}</p>}{(item.reviewFailovers ?? []).filter(f => f.sha === item.candidate?.sha && f.baseSha === item.candidate?.baseSha && f.policyRevision === item.policyRevision).map(f => <p className="amber" key={`${f.profile}-${f.at}`}>Failover: {f.profile} exhausted ({f.exhaustion}) · {f.nextProfile ? `dispatched to ${f.nextProfile}` : 'no reviewer profile remains'}</p>)}{admin && <p className="muted">Changing provider creates a policy revision and requires fresh acceptance evidence. Agent reviewer profiles are configured through the CLI or API because they name registered reviewer App identities.</p>}
      <h3>Next action and executors</h3>
      {item.nextAction && <p className="next-action"><strong>Next:</strong> <code>{item.nextAction.kind}</code>{(() => { const row = actions.find(entry => entry.kind === item.nextAction!.kind); return row?.claim ? ` — ${row.claim.executor} on ${row.claim.host} is running it` : row ? (unserved ? ` — nobody can claim it: no live executor serves ${row.kind} (waited ${age(unserved.since)}); ${unserved.start}` : ' — waiting for an executor to claim it') : ''; })()}</p>}
      {unserved && <p className="amber">This action is not queued behind other work: {status.executors.live === 0 ? 'no executor is alive' : `the ${status.executors.live} live executor(s) serve ${(status.executors.served ?? []).join(', ') || 'nothing'}`}, and nothing moves until one that serves <code>{unserved.kind}</code> is started.</p>}
      {item.nextAction
        ? <p>The control plane computes <code>{item.nextAction.kind}</code> for this item{item.nextAction.gate ? <> from the <strong>{item.nextAction.gate}</strong> gate’s refusal “{shortShas(item.nextAction.refusal ?? '')}”</> : ''}: {shortShas(item.nextAction.reason)}. {item.nextAction.llmRole ? `The action starts a session whose judgment is ${item.nextAction.llmRole}; running the action itself needs no model.` : 'Running it needs no language model at all.'}</p>
        : <p className="muted">The control plane has no outstanding action for this item.</p>}
      {actions.map(row => <div className="criterion" key={row.id}><strong>{row.kind} · {row.state}{row.claim ? ` · ${row.claim.executor} on ${row.claim.host}` : ''}</strong>
        <p>Requested by {row.requestedBy} {age(row.requestedAt)} ago · attempt {row.attempts}{row.resolution ? ` · last result: ${shortShas(row.resolution)}` : ''}</p>
        <ul>{row.history.slice(-5).map((entry, index) => <li key={index}>{entry.event}{entry.executor ? ` by ${entry.executor}` : ''}: {shortShas(entry.reason)}</li>)}</ul></div>)}
      {running.length > 0 && <><h3>Sessions running now</h3><ul className="sessions">{running.map(handle => <li key={handle.id}>
        <strong>{handle.kind}</strong> · {handle.principal} · {handle.runtime} on {handle.host} · working on {shortShas(handle.subject)} · {age(handle.startedAt)} · seen {formatAge(handle.seenAt ?? handle.updatedAt, now)} ago<br/><code>{handle.attach}</code></li>)}</ul></>}
      <h3>Sessions ({sessions.length})</h3>
      {sessions.length === 0 && <p className="muted">No session has recorded a handle on this item.</p>}
      {sessions.map(handle => <div className="criterion" key={handle.id}><strong>{handle.live ? '▶' : handle.state === 'running' ? '?' : '■'} {handle.kind} · {handle.principal}</strong>
        <p>{handle.runtime} on {handle.host}{handle.workspace ? ` · workspace ${handle.workspace}` : ''}{handle.tab ? ` · tab ${handle.tab}` : ''}{handle.pane ? ` · pane ${handle.pane}` : ''} · {shortShas(handle.subject)}</p>
        <p>{handle.live ? `Running for ${age(handle.startedAt)}` : handle.state === 'running' ? `Not seen for ${formatAge(handle.seenAt ?? handle.updatedAt, now)}` : `Finished ${age(handle.endedAt ?? handle.updatedAt)} ago${handle.outcome ? `: ${shortShas(handle.outcome)}` : ''}`}</p>
        <code>{handle.attach}</code></div>)}
      <h3>Agent requests ({(item.agentRequests ?? []).length})</h3>
      {requests.length > 0 && <div className="notice"><strong>{requests.length === 1 ? 'An agent is waiting' : `${requests.length} agents are waiting`} on a decision</strong>
        <ul>{requests.map(r => <li key={r.id}>{r.requestedBy} recorded a {r.type} {age(r.at)} ago and released its lease: {shortShas(r.reason)} — decided by {r.decider.who}{r.decider.command ? <> (<code>{r.decider.command}</code>)</> : ''}</li>)}</ul></div>}
      {(item.agentRequests ?? []).length === 0 && <p className="muted">No agent has recorded a typed request on this item.</p>}
      {(item.agentRequests ?? []).map(request => <div className="criterion" key={request.id}><strong>{request.state === 'open' ? '○' : '✓'} {request.type} · {request.requestedBy}</strong>
        <p>{shortShas(request.reason)}{request.paths?.length ? ` · ${request.paths.join(', ')}` : ''}</p>
        <p>Decided by {request.decider.who}{request.decider.command ? ` · ${request.decider.command}` : ''} · recorded {age(request.at)} ago{request.releasedLease ? ' and the attempt released its lease' : ''}{request.state === 'resolved' ? ` · resolved: ${shortShas(request.resolution ?? 'no reason recorded')}` : ''}</p></div>)}
      <h3>Acceptance criteria and required proof</h3>{item.criteria.map(ac => <div className="criterion" key={ac.id}><strong>{ac.id} · {ac.text}{ac.bootstrap ? ' · bootstrap mode' : ''}</strong>{ac.bootstrap && <p className="amber">Proof deferred by {ac.bootstrap.declaredBy} on {new Date(ac.bootstrap.declaredAt).toLocaleString()} at policy v{ac.bootstrap.policyRevision}: {shortShas(ac.bootstrap.reason)}. Review, CI and every other criterion still gate this item. The proof is not dropped — it stays owed on {ac.bootstrap.contractPaths.join(', ')} and the next change touching that contract must produce it.</p>}</div>)}
      {proofs.map(p => <div className="criterion" key={`${p.criterion}:${p.proof}`}><strong>{p.criterion} · {p.proof} · {p.status}</strong><p>{p.status === 'deferred' ? `Deferred in bootstrap mode; recorded as an obligation on ${p.bootstrap?.contractPaths.join(', ')}` : p.scenario ? `Scenario v${p.scenario.revision} in ${p.scenario.environment}` : 'Requires an authorized producer or manual operator evidence'} · current candidate and policy v{item.policyRevision}</p>{p.status !== 'deferred' && p.bootstrap && <p className="amber">Inherited from {p.bootstrap.key} {p.bootstrap.criterionId} because this item plans to touch {p.bootstrap.contractPaths.join(', ')}. A bootstrap deferral cannot be renewed by the change that inherits it.</p>}{item.proofGaps?.includes(p.proof) && <p className="amber">No principal was authorized to produce {p.proof} when this intent was recorded. Open Proof authority and grant it before dispatch.</p>}</div>)}
      {(() => { const ledger = obligationLedger(work); return ledger.length > 0 && <><h3>Bootstrap obligations ({ledger.length})</h3><p className="muted">Deferred proofs still owed across this repository. An obligation clears only when a delivered change produces trusted passing evidence for it; no operator command retires one.</p>{ledger.map(o => <div className="criterion" key={`${o.workId}:${o.criterionId}:${o.proof}`}><strong>{o.proof} · owed by {o.key} {o.criterionId}</strong><p>{shortShas(o.reason)} · contract {o.contractPaths.join(', ')} · declared by {o.declaredBy} on {new Date(o.declaredAt).toLocaleString()} at policy v{o.policyRevision}</p><p>{o.inheritedBy.length ? `Inherited by ${o.inheritedBy.join(', ')}` : 'No planned work touches this contract yet'}</p></div>)}</>; })()}
      {!!item.releaseDeliveries?.length && <><h3>Observed delivery</h3>{item.releaseDeliveries.map(d => <p key={d.environment}>Verified in {d.environment} · release {d.releaseId} r{d.releaseRevision} · generation {d.generation} · {new Date(d.verifiedAt).toLocaleString()}</p>)}<p className="muted">Independently observed runtime identity over a common interval, recorded once per environment. The merge above is a separate fact.</p></>}
      <h3>Evidence ({item.evidence.length})</h3>{item.evidence.map(e => <div className="criterion evidence-row" key={e.id}><strong>{e.revocation ? '⦸' : e.result === 'pass' ? '✓' : '×'} {e.proof}</strong><p>{e.trusted ? 'Trusted producer' : 'Worker assertion'} · {e.producer} · {e.sha.slice(0, 8)} · {e.executed} executed / {e.skipped} skipped</p>{e.revocation && <p className="amber">Revoked by {e.revocation.actor}: {shortShas(e.revocation.reason)}</p>}{e.reuse && <p className="muted">Reused from the pass observed {new Date(e.reuse.observedAt).toLocaleString()} on {e.reuse.sourceSha.slice(0, 8)} (attempt sequence {e.reuse.sequence}, policy {e.reuse.policy.id} r{e.reuse.policy.revision}); a newer live attempt supersedes it.</p>}<EvidenceArtifacts evidence={e} token={token} observedAt={observedAt}/></div>)}
    </details>
  </article>;
}
// The document this page renders: a settled delivery's is read when it is opened (GY-422).
export { useOpenedWork } from '../opened-work';
