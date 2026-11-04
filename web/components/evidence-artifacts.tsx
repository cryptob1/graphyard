import type { Evidence, EvidenceArtifact } from '../../src/model';
import { artifactLabel, safeExternalUrl } from '../../src/model/format';

export default function EvidenceArtifacts({ evidence, token, observedAt }: { evidence: Evidence; token: string; observedAt: number }) {
  const artifacts: EvidenceArtifact[] = evidence.artifacts?.length ? evidence.artifacts : evidence.url ? [{ kind: 'other', label: 'Legacy evidence link', availability: 'external', url: evidence.url }] : [];
  if (!artifacts.length) return <p className="artifact-empty">No artifacts attached.</p>;
  return <div className="artifacts">{artifacts.map((artifact, index) => {
    const status = artifact.reference ? 'unavailable' : artifact.availability === 'available' && Number.isFinite(observedAt) && artifact.expiresAt && Date.parse(artifact.expiresAt) <= observedAt ? 'expired' : artifact.availability;
    const key = artifact.reference ? `${artifact.reference.requestId}:${artifact.reference.artifactId}` : `${artifact.url}:${index}`;
    return <div className="artifact" key={key}><div><strong>{artifact.label}</strong><small>{artifactLabel(artifact)}</small><small>Status: {status}{artifact.expiresAt ? ` · retained until ${new Date(artifact.expiresAt).toLocaleString()}` : ''}</small><small title={artifact.digest}>{artifact.digest ? `SHA-256 ${artifact.digest.slice(7, 19)}…` : 'Digest unavailable'}</small></div><div className="artifact-actions">
      {status === 'external' && safeExternalUrl(artifact.url) && <a href={safeExternalUrl(artifact.url)} target="_blank" rel="noreferrer noopener">Open external ↗</a>}
      {status === 'external' && artifact.url && !safeExternalUrl(artifact.url) && <small>Unsafe external URL refused</small>}
    </div></div>;
  })}</div>;
}
