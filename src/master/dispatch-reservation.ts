// Runtime liveness and launch history; session reservations live only in the registry.
import { resolve } from 'node:path';
export class DispatchReservedError extends Error {
  readonly dispatchReserved = true;
  constructor(readonly resource: 'profile' | 'work', readonly subject: string, message: string) { super(message); }
}
export const dispatchReserved = (error: unknown): error is DispatchReservedError => (error as { dispatchReserved?: boolean } | null)?.dispatchReserved === true;
export const dispatchReservationDirectory = (root: string) => resolve(root, '.graphyard/dispatch');
export const dispatchedFile = (root: string, key: string) => resolve(dispatchReservationDirectory(root), `dispatched-${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
export const profileLaunchedFile = (root: string, profile: string) => resolve(dispatchReservationDirectory(root), `launched-${profile.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
