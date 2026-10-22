// Concern: the coordination snapshot read (GY-864) — the trimmed server read `master status`
// builds from, asked for by header on the plain `work-snapshot` path, so a server without the
// view still answers and the bytes read stay flat however heavy the ledger's settled items are.
import { coordinationViewHeader } from '../server/work-view.js';

export const coordinationStep = (read: (path: string, credential?: string, timeoutMs?: number, headers?: Record<string, string>) => Promise<any>) =>
  snapshotWithClock(() => read('work-snapshot', undefined, undefined, { [coordinationViewHeader]: 'coordination' }));

/** A snapshot read with its clock offset bound against the control plane, from the local clock before and after the read. */
export async function snapshotWithClock<T extends { now: string }>(read: () => Promise<T>, clock: () => number = Date.now) {
  const before = clock();
  const snapshot = await read();
  const after = clock();
  const server = Date.parse(snapshot.now);
  const bound = (value: number) => Number.isFinite(server) ? Math.round(value - server) : NaN;
  return { snapshot, clockOffset: { min: bound(before), max: bound(after) } };
}
