import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateChecks, type GateRecord } from '../src/batch-gate.js';
import type { ServeLanding } from '../src/merge-writer/serve-revert.js';
import type { Work } from '../src/model.js';

// GY-3547: GY-3514 deleted a case GY-3486 bound, and the batch gate required it forever.
const landing = (sha: string, key: string, proof: string) => ({ sha, before: '', subject: key, item: { key, criteria: [{ id: 'AC-1', text: '', proofs: [proof] }] } as unknown as Work }) as ServeLanding;

test('unit:gate-skips-deleted-bound-cases — a bound case absent from the tip catalog is dropped with one note naming it and its item', async () => {
  const record = { merges: [], notes: [] } as unknown as Pick<GateRecord, 'merges' | 'notes'>;
  const ports = { catalog: async () => ['kept', 'smoke'], core: async () => ['smoke'] };
  const landings = [landing('1'.repeat(40), 'GY-1', 'e2e:gone'), landing('2'.repeat(40), 'GY-2', 'e2e:kept')];
  assert.deepEqual(await gateChecks(ports, record, 'tip', landings, false), ['build', 'e2e:kept', 'e2e:smoke', 'affected']);
  assert.equal(record.notes!.length, 1);
  assert.match(record.notes![0]!, /gone.*GY-1/);
});
