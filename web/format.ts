import type { EvidenceArtifact, deliveryState } from '../src/model';

export function age(time: string) { const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }
export function artifactLabel(artifact: EvidenceArtifact) {
  const size = artifact.size === undefined ? '' : ` · ${artifact.size < 1024 ? `${artifact.size} B` : `${(artifact.size / 1024).toFixed(1)} KiB`}`;
  return `${artifact.kind} · ${artifact.mediaType ?? 'type unknown'}${size}`;
}
export function safeExternalUrl(value?: string) {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : undefined; } catch { return undefined; }
}
export const deliveryLabel: Record<NonNullable<ReturnType<typeof deliveryState>>, string> = {
  delivered: 'Delivered', 'awaiting-deployment': 'Awaiting deployment', 'awaiting-smoke': 'Awaiting smoke proof', 'smoke-passed': 'Smoke proof passed', 'delivered-with-failure': 'Delivered with failure',
};
