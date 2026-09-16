import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function containmentCredentials() {
  const settlementToken = randomBytes(32).toString('hex');
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  const requestId = randomUUID();
  return { settlementToken, settlementHash, requestId };
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
