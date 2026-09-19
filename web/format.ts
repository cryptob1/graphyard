import type { EvidenceArtifact, deliveryState } from '../src/model';
import { formatAge } from './duration';

export function age(time: string) { return formatAge(time, Date.now()); }
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
