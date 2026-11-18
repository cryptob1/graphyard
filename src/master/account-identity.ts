// Provider login identity and account-check descriptions.
import { createHash } from 'node:crypto';
import { adapterIdentity } from './runtimes.js';
import type { ObservedExhaustion } from './environments.js';

/** The provider login an account home holds (GY-1573), read through its runtime adapter's identity file (runtimes.ts `adapterIdentity`). */
export const providerIdentity = (kind: string, home: string) => adapterIdentity(kind, home, ids => createHash('sha256').update(ids.join('\0')).digest('hex').slice(0, 32));

export const describeObservedExhaustion = (environment: string, held: ObservedExhaustion) =>
  `${environment} exhausted its quota mid-session at ${held.at} (${held.reason}); ${held.resetsAt ? `it resets ${held.resetsAt}` : `its reset time is unknown, so it is tried again after ${held.until}`}`;
