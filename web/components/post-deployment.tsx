import { deliveryState, deploySmokeRequired, postDeployMs, rollbackGuidance, type Work } from '../../src/model';
import { deliveryLabel, safeExternalUrl } from '../../src/model/format';
import { CandidateSha } from '../candidate';
import { formatDuration } from '../../src/model/duration';

/**
 * The second confidence layer for one delivery: what the release served, what the trusted
 * producer found against exactly that commit, and, on a failure, what to roll back.
 */
export default function PostDeployment({ item, repository, baseBranch, observedAt }: { item: Work; repository: unknown; baseBranch: string; observedAt: number }) {
  const state = deliveryState(item);
  if (!state || !item.delivery) return null;
  const { deployment, smoke, mergeSha } = item.delivery;
  const rollback = rollbackGuidance(item, baseBranch);
  const elapsed = postDeployMs(item, Number.isFinite(observedAt) ? observedAt : Date.now());
  return <><h3>Post-deployment</h3>
    <p className="post-deploy-state"><strong className={state === 'delivered-with-failure' ? 'danger-text' : state === 'smoke-passed' || state === 'delivered' ? 'green-text' : 'amber'}>{deliveryLabel[state]}</strong>{state !== 'delivered' && <span className="muted"> · {deploySmokeRequired(item.policy) ? 'policy requires e2e:deploy-smoke' : ''}{elapsed !== null ? ` · post-deploy time ${formatDuration(elapsed / 60000)}` : ''}</span>}</p>
    <p className="candidate-details">Merge commit <CandidateSha repository={repository} sha={mergeSha} workKey={item.key}/></p>
    {deployment ? <p className="candidate-details">Deployment observed serving <CandidateSha repository={repository} sha={deployment.sha} workKey={item.key}/> ({deployment.covers === 'exact' ? 'the merge commit itself' : 'a descendant containing the merge'}) · {deployment.source} · {new Date(deployment.observedAt).toLocaleString()} · recorded by {deployment.observer}</p>
      : state !== 'delivered' && <p className="muted">Graphyard has not observed a deployment covering this merge. Smoke evidence is refused until the coordinator records one.</p>}
    {smoke ? <p>{smoke.result === 'pass' ? '✓' : '×'} e2e:deploy-smoke · {smoke.producer} · {smoke.executed} executed / {smoke.skipped} skipped · {new Date(smoke.at).toLocaleString()}{smoke.url && safeExternalUrl(smoke.url) ? <> · <a href={safeExternalUrl(smoke.url)} target="_blank" rel="noreferrer noopener">run ↗</a></> : ''}</p>
      : deployment && <p className="muted">Waiting for the trusted producer to run e2e:deploy-smoke against the observed deployed commit.</p>}
    {rollback && <div role="alert" className="notice danger">{rollback}</div>}</>;
}
