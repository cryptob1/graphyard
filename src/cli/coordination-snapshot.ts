// Concern: the coordination snapshot read (GY-864) — the trimmed server read `master status`
// builds from, asked for by header on the plain `work-snapshot` path, so a server without the
// view still answers and the bytes read stay flat however heavy the ledger's settled items are.
import { snapshotWithClock } from '../master/containment.js';
import { coordinationViewHeader } from '../server/work-view.js';

export const coordinationStep = (step: (run: () => Promise<any>) => Promise<any>, read: (path: string, credential?: string, timeoutMs?: number, headers?: Record<string, string>) => Promise<any>) =>
  step(() => snapshotWithClock(() => read('work-snapshot', undefined, undefined, { [coordinationViewHeader]: 'coordination' })));
