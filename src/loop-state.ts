// Durable executor bookkeeping. Work leases, verdicts and evidence remain owned by their domain APIs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { readCredentialFile } from './private-file.js';
import type { MasterConfig } from './master/profiles.js';

export type LoopStateKind = 'reviews' | 'producers' | 'dispatch';
export interface LoopStateClient {
  read(kind: LoopStateKind): Promise<Record<string, unknown>[]>;
  write(kind: LoopStateKind, records: Record<string, unknown>[], removed?: string[], migrate?: boolean): Promise<void>;
}
/** Embedded executors and fixtures can supply the same store without an HTTP hop. */
export const loopStateContext = new AsyncLocalStorage<(scope: string) => LoopStateClient>();
type Config = Pick<MasterConfig, 'url' | 'credentialFile' | 'repository' | 'hostId'>;
const scopeOf = (config: Config) => createHash('sha256').update(`${config.repository.toLowerCase()}\n${config.hostId ?? hostname()}\n${config.credentialFile}`).digest('hex');
export async function loopStateClient(rootOrConfig: string | Config): Promise<LoopStateClient> {
  const injected = loopStateContext.getStore();
  if (injected) return injected(typeof rootOrConfig === 'string' ? resolve(rootOrConfig) : scopeOf(rootOrConfig));
  const config: Config = typeof rootOrConfig === 'string'
    ? JSON.parse(await readFile(resolve(rootOrConfig, '.graphyard/master.json'), 'utf8')) : rootOrConfig;
  const scope = scopeOf(config);
  const request = async (kind: LoopStateKind, body?: unknown) => {
    const response = await fetch(`${config.url}/api/loop-state/${scope}/${kind}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${await readCredentialFile(config.credentialFile)}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Loop state ${kind}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  return { read: kind => request(kind), write: async (kind, records, removed = [], migrate = false) => { await request(kind, { records, removed, migrate }); } };
}

/** Import before unlinking. Repeating after a crash never replaces a newer database record. */
export async function migrateLoopFile(client: LoopStateClient, kind: LoopStateKind, file: string, parse: (value: unknown) => Record<string, unknown>[]) {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  await client.write(kind, parse(JSON.parse(raw)), [], true);
  await unlink(file).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
}

// Carry the read snapshot through object spreads, but never serialize it. Saves send only changes,
// so a reconcile pass cannot overwrite an unrelated launch made while it waited on a runtime.
const baseline = Symbol('loop-state baseline');
type RecordWithId = { id: string };
export function ledgerSnapshot<T extends object>(ledger: T, records: RecordWithId[]): T {
  return Object.assign(ledger, { [baseline]: new Map(records.map(record => [record.id, JSON.stringify(record)])) });
}
export async function saveLedger(client: LoopStateClient, kind: LoopStateKind, ledger: object, records: RecordWithId[]) {
  const before: Map<string, string> = (ledger as any)[baseline] ?? new Map();
  const ids = new Set(records.map(record => record.id));
  const changed = records.filter(record => before.get(record.id) !== JSON.stringify(record));
  const removed = [...before.keys()].filter(id => !ids.has(id));
  if (changed.length || removed.length) await client.write(kind, changed, removed);
}
