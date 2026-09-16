import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Work, Workspace } from './model.js';

export class PrelaunchContainmentError extends Error {
  constructor(message: string, public readonly settleAllowed: boolean) { super(message); }
}

export function revalidateContainment(
  snapshot: { now: string; work: Work[] },
  expected: { workId: string; principal: string; epoch: number; settlementHash: string; exclusiveResources: string[]; workspace: Workspace },
) {
  const work = snapshot.work.find(item => item.id === expected.workId);
  if (!work) throw new PrelaunchContainmentError('Fresh Graphyard snapshot no longer contains the work item', false);
  const quarantineOwned = work.containmentQuarantine?.owner === expected.principal
    && work.containmentQuarantine.epoch === expected.epoch
    && work.containmentQuarantine.settlementHash === expected.settlementHash;
  const snapshotTime = Date.parse(snapshot.now);
  const leaseLive = work.lease?.owner === expected.principal && work.lease.epoch === expected.epoch
    && Number.isFinite(snapshotTime) && Date.parse(work.lease.expiresAt) > snapshotTime;
  const authorized = quarantineOwned && leaseLive;
  const workspace = work.workspaces.find(item => item.epoch === expected.epoch);
  const workspaceExact = !!workspace && workspace.owner === expected.workspace.owner && workspace.host === expected.workspace.host
    && workspace.path === expected.workspace.path && workspace.branch === expected.workspace.branch;
  const resourcesExact = JSON.stringify(work.exclusiveResources ?? []) === JSON.stringify(expected.exclusiveResources);
  if (!authorized || !workspaceExact || !resourcesExact)
    throw new PrelaunchContainmentError('Fresh Graphyard snapshot does not authorize this contained worker launch', authorized);
  return work;
}

export function containmentCredentials() {
  const settlementToken = randomBytes(32).toString('hex');
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  const requestId = randomUUID();
  return { settlementToken, settlementHash, requestId };
}

export function isConfirmedCoordinationRefusal(status: number, body: unknown) {
  if (status < 400 || status >= 500 || status === 408 || status === 429 || !body || typeof body !== 'object') return false;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0
    || !!error && typeof error === 'object'
      && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.length > 0
      && typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message.length > 0;
}

export async function establishContainment(
  mutate: (requestId: string) => Promise<any>,
  expected: { epoch: number; settlementHash: string; exclusiveResources: string[]; requestId: string },
  options: { attempts?: number; retryMs?: number } = {},
) {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await mutate(expected.requestId);
      const quarantine = result?.containmentQuarantine;
      if (quarantine?.epoch !== expected.epoch || quarantine?.settlementHash !== expected.settlementHash
        || JSON.stringify(result?.exclusiveResources ?? []) !== JSON.stringify(expected.exclusiveResources))
        throw new Error('Graphyard returned a mismatched containment quarantine');
      return result;
    } catch (error) {
      if ((error as any)?.confirmedRefusal) throw error;
      lastError = error;
      if (attempt < attempts) await delay(options.retryMs ?? 100);
    }
  }
  throw new Error(`Graphyard could not confirm containment quarantine establishment after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function settleContainment(
  mutate: (requestId: string, body: Readonly<{ epoch: number; settlementToken: string }>) => Promise<any>,
  expected: { epoch: number; settlementToken: string; settlementHash: string; exclusiveResources: string[]; requestId: string },
  options: { attempts?: number; retryMs?: number } = {},
) {
  if (createHash('sha256').update(expected.settlementToken).digest('hex') !== expected.settlementHash)
    throw new Error('Containment settlement capability does not match the established quarantine');
  const body = Object.freeze({ epoch: expected.epoch, settlementToken: expected.settlementToken });
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await mutate(expected.requestId, body);
      if (result?.epoch !== expected.epoch || result?.containmentQuarantine != null
        || JSON.stringify(result?.exclusiveResources ?? []) !== JSON.stringify(expected.exclusiveResources))
        throw new Error('Graphyard returned a mismatched containment settlement');
      return result;
    } catch (error) {
      if ((error as any)?.confirmedRefusal) throw error;
      lastError = error;
      if (attempt < attempts) await delay(options.retryMs ?? 100);
    }
  }
  throw new Error(`Graphyard could not confirm containment settlement after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
