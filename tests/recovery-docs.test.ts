import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rollbackClaimSchema, rollbackResolveSchema, rollbackSchema, rollbackSettleSchema } from '../src/delivery.js';
import { definitionSchema } from '../src/validation.js';

/** The recovery guide's JSON samples are what an operator or adapter author copies, so each must parse with the schema its command uses. */
const guide = await readFile(new URL('../docs/recovery.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as any);
const sample = (predicate: (block: any) => boolean, label: string) => { const found = blocks.filter(predicate); assert.equal(found.length, 1, `exactly one documented sample should be ${label}`); return found[0]; };

test('the documented recovery samples parse with the schemas the API uses', () => {
  const registration = definitionSchema.parse(sample(b => b.kind === 'registration', 'the rollback registration'));
  assert.equal(registration.kind === 'registration' && registration.role, 'rollback');
  assert.deepEqual(registration.kind === 'registration' && registration.rollback, { fencing: 'provider', automatic: true });
  const request = rollbackSchema.parse(sample(b => 'target' in b && 'reason' in b, 'the rollback request'));
  assert.equal(request.environment.id, registration.kind === 'registration' ? registration.environment.id : '');
  const claim = rollbackClaimSchema.parse(sample(b => 'epoch' in b && !('outcome' in b), 'the claim'));
  const settle = rollbackSettleSchema.parse(sample(b => 'outcome' in b && 'epoch' in b, 'the settlement'));
  assert.equal(settle.rollbackId, claim.rollbackId); assert.equal(settle.outcome, 'applied');
  const resolve = rollbackResolveSchema.parse(sample(b => 'evidence' in b, 'the operator resolution'));
  assert.equal(resolve.operationId, settle.operationId);
  assert.ok(resolve.evidence, 'the documented resolution carries settlement evidence');
});
