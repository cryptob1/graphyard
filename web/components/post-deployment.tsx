import { deliveryState, type Work } from '../../src/model';
import { deliveryLabel, safeExternalUrl } from '../../src/model/format';
import { CandidateSha } from '../candidate';

/**
 * One delivery: delivered at merge (GY-1981), with the release and smoke result older deliveries
 * recorded shown as the history they are.
 */
export default function PostDeployment({ item, repository }: { item: Work; repository: unknown }) {
  const state = deliveryState(item);
  if (!state || !item.delivery) return null;
  const { deployment, smoke, mergeSha } = item.delivery;
  return <><h3>Post-deployment</h3>
    <p className="post-deploy-state"><strong className="green-text">{deliveryLabel[state]}</strong></p>
    <p className="candidate-details">Merge commit <CandidateSha repository={repository} sha={mergeSha} workKey={item.key}/></p>
    {deployment && <p className="candidate-details">Deployment observed serving <CandidateSha repository={repository} sha={deployment.sha} workKey={item.key}/> ({deployment.covers === 'exact' ? 'the merge commit itself' : 'a descendant containing the merge'}) · {deployment.source} · {new Date(deployment.observedAt).toLocaleString()} · recorded by {deployment.observer}</p>}
    {smoke && <p>{smoke.result === 'pass' ? '✓' : '×'} e2e:deploy-smoke · {smoke.producer} · {smoke.executed} executed / {smoke.skipped} skipped · {new Date(smoke.at).toLocaleString()}{smoke.url && safeExternalUrl(smoke.url) ? <> · <a href={safeExternalUrl(smoke.url)} target="_blank" rel="noreferrer noopener">run ↗</a></> : ''}</p>}</>;
}
