import { useState } from 'react';
import type { Evidence, EvidenceArtifact } from '../../src/model';
import { artifactLabel, safeExternalUrl } from '../format';

export default function EvidenceArtifacts({ evidence, token, observedAt }: { evidence: Evidence; token: string; observedAt: number }) {
  const artifacts: EvidenceArtifact[] = evidence.artifacts?.length ? evidence.artifacts : evidence.url ? [{ kind: 'other', label: 'Legacy evidence link', availability: 'external', url: evidence.url }] : [];
  const [preview, setPreview] = useState<{ key: string; kind: 'image' | 'text'; value: string } | null>(null);
  const [error, setError] = useState('');
  async function openPrivate(artifact: EvidenceArtifact, download: boolean) {
    if (!artifact.reference) return;
    setError('');
    const path = `/api/validation/artifacts/${artifact.reference.requestId}/${artifact.reference.artifactId}${download ? '' : '?preview=1'}`;
    try {
      const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(response.status === 410 ? 'Artifact retention expired.' : response.status === 403 ? 'You are not authorized to read this artifact.' : 'Artifact is unavailable.');
      const blob = await response.blob();
      if (download) {
        const href = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = href; anchor.download = artifact.label; anchor.click(); URL.revokeObjectURL(href); return;
      }
      const key = `${artifact.reference.requestId}:${artifact.reference.artifactId}`;
      if (artifact.mediaType === 'image/png') { const reader = new FileReader(); reader.onload = () => setPreview({ key, kind: 'image', value: String(reader.result) }); reader.readAsDataURL(blob); }
      else setPreview({ key, kind: 'text', value: await blob.text() });
    } catch (cause) { setError((cause as Error).message); }
  }
  if (!artifacts.length) return <p className="artifact-empty">No artifacts attached.</p>;
  return <div className="artifacts">{artifacts.map((artifact, index) => {
    const status = artifact.availability === 'available' && Number.isFinite(observedAt) && artifact.expiresAt && Date.parse(artifact.expiresAt) <= observedAt ? 'expired' : artifact.availability;
    const key = artifact.reference ? `${artifact.reference.requestId}:${artifact.reference.artifactId}` : `${artifact.url}:${index}`;
    const previewable = artifact.reference && artifact.size !== undefined && artifact.size <= 1_000_000 && ['image/png', 'application/json', 'text/plain'].includes(artifact.mediaType ?? '');
    return <div className="artifact" key={key}><div><strong>{artifact.label}</strong><small>{artifactLabel(artifact)}</small><small>Status: {status}{artifact.expiresAt ? ` · retained until ${new Date(artifact.expiresAt).toLocaleString()}` : ''}</small><small title={artifact.digest}>{artifact.digest ? `SHA-256 ${artifact.digest.slice(7, 19)}…` : 'Digest unavailable'}</small></div><div className="artifact-actions">
      {status === 'external' && safeExternalUrl(artifact.url) && <a href={safeExternalUrl(artifact.url)} target="_blank" rel="noreferrer noopener">Open external ↗</a>}
      {status === 'external' && artifact.url && !safeExternalUrl(artifact.url) && <small>Unsafe external URL refused</small>}
      {status === 'available' && previewable && <button type="button" onClick={() => void openPrivate(artifact, false)}>{preview?.key === key ? 'Refresh preview' : 'Preview'}</button>}
      {status === 'available' && artifact.reference && <button type="button" onClick={() => void openPrivate(artifact, true)}>Download</button>}
    </div>{preview?.key === key && (preview.kind === 'image' ? <img className="artifact-preview" src={preview.value} alt={`Preview of ${artifact.label}`}/> : <pre className="artifact-preview">{preview.value}</pre>)}</div>;
  })}{error && <p role="alert" className="notice danger">{error}</p>}</div>;
}
