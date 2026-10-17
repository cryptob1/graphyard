import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readInstallRecord, tokenFile } from './secrets.js';

/** What one settle of an install's worker credentials found: every configured worker is exactly one of these. */
export interface WorkerCredentials {
  /** Whether this install has a record here; without one nothing is its to issue. */
  installed: boolean;
  /** Worker files already in place, left untouched. */
  present: string[];
  /** Worker files written by this settle, each a 0600 copy of the install's own token. */
  issued: string[];
  /** Install tokens a configured worker lacks: nothing can be issued for it. */
  missing: string[];
}

export const workerCredentialFile = (directory: string, principal: string) => resolve(directory, 'workers', `${principal}.token`);

const usable = async (file: string) => { const text = await readFile(file, 'utf8').catch(() => null); return text !== null && !!text.trim() ? text : null; };

/**
 * GY-1885: a second install on a host gets its own worker credentials. The install record names the
 * worker principals its plane was deployed with, and their tokens sit 0600 in the install's tokens
 * folder — the only tokens that plane accepts. Each configured worker without a usable file in the
 * install's workers folder (the one folder `master environments` reads for this install) gets a
 * 0600 copy of its token. The settle judges every configured worker on every call, never an
 * aggregate count, so a rerun after a partial issue — or after a missing token was restored — issues
 * exactly what is still absent. Nothing is generated: a token the plane does not know would only be
 * refused. An absent record is no install; one that cannot be read or validated throws.
 */
export async function settleWorkerCredentials(directory: string): Promise<WorkerCredentials> {
  const record = await readInstallRecord(directory);
  const result: WorkerCredentials = { installed: !!record, present: [], issued: [], missing: [] };
  for (const principal of (record?.principals ?? []).filter(principal => principal.role === 'worker')) {
    const file = workerCredentialFile(directory, principal.id);
    if (await usable(file)) { result.present.push(file); continue; }
    const token = await usable(tokenFile(directory, principal.id));
    if (token === null) { result.missing.push(tokenFile(directory, principal.id)); continue; }
    await mkdir(resolve(directory, 'workers'), { recursive: true, mode: 0o700 });
    await writeFile(file, token, { mode: 0o600 });
    await chmod(file, 0o600);
    result.issued.push(file);
  }
  return result;
}
