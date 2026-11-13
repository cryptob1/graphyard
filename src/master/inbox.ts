// Concern: where a file pasted or dropped on the Master page (GY-3288) lands on the host the master runs on.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const maxUploadBytes = 20 * 1024 * 1024;
const keepMs = 7 * 24 * 60 * 60 * 1000;

/** Saves DATA as ROOT/.graphyard/master-inbox/TIMESTAMP-NAME (readable by the master session), prunes files older than 7 days, and returns its absolute path. */
export function saveInboxFile(root: string, name: string, data: Buffer): string {
  const dir = resolve(root, '.graphyard', 'master-inbox');
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  for (const old of readdirSync(dir)) if (Date.now() - statSync(join(dir, old)).mtimeMs > keepMs) rmSync(join(dir, old), { force: true });
  const path = join(dir, `${Date.now()}-${name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file'}`);
  writeFileSync(path, data, { mode: 0o644 });
  return path;
}
