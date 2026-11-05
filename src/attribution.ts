import { createHash } from 'node:crypto';

const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

// ---- Manifests ------------------------------------------------------------------------------

export const digestHash = (artifacts: { service: string; digest: string }[]) => sha256([...artifacts].sort((a, b) => a.service.localeCompare(b.service)).map(a => [a.service, a.digest]));
