// Concern: the flake ledger's file (GY-1498): .graphyard/flake-ledger.json under the loop's
// repository root, mode 0600, written whole through a temporary file as project memory is. The
// entries and their bounds are model/flake-ledger.ts; the loop's step is daemon/cycle-flakes.ts.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { emptyFlakeLedger, flakeLedgerSchema, type FlakeLedger } from './model/flake-ledger.js';

export const flakeLedgerPath = (root: string) => resolve(root, '.graphyard', 'flake-ledger.json');

/** Where the loop keeps the ledger between its cycles. */
export interface FlakeLedgerStore { read: () => Promise<FlakeLedger>; write: (ledger: FlakeLedger) => Promise<void> }

/** The ledger file under `root`. A missing or unreadable file reads as an empty ledger. */
export function flakeLedgerStore(root: string): FlakeLedgerStore {
  const file = flakeLedgerPath(root);
  return {
    read: async () => {
      try { return flakeLedgerSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
      catch { return emptyFlakeLedger(); }
    },
    write: async ledger => {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(flakeLedgerSchema.parse(ledger), null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
      await chmod(file, 0o600);
    },
  };
}
