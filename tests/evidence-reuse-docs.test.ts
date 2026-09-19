import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { definitionSchema } from '../src/validation.js';
import { reuseDecisionSchema, classifyPath } from '../src/evidence-reuse.js';

/** The reuse guide's JSON samples are what an operator copies, so each must parse with the schema its command uses. */
const guide = await readFile(new URL('../docs/evidence-reuse.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as any);
const sample = (predicate: (block: any) => boolean, label: string) => { const found = blocks.filter(predicate); assert.equal(found.length, 1, `exactly one documented sample should be ${label}`); return found[0]; };

test('the documented reuse samples parse with the schemas the API uses, and the documented policy classifies as described', () => {
  const policy = definitionSchema.parse(sample(b => b.kind === 'reuse', 'the reuse policy'));
  assert.equal(policy.kind, 'reuse');
  if (policy.kind !== 'reuse') return;
  assert.equal(policy.artifacts, 'identical'); assert.deepEqual(Object.keys(policy.relevant.services), ['api']);
  assert.deepEqual(classifyPath(policy, 'docs/guide.md'), { classification: 'ignorable', category: null });
  assert.deepEqual(classifyPath(policy, 'src/api/server.ts'), { classification: 'relevant', category: 'services.api' });
  assert.deepEqual(classifyPath(policy, 'packages/web/package.json'), { classification: 'relevant', category: 'dependencies' });
  assert.deepEqual(classifyPath(policy, 'scripts/release.sh'), { classification: 'unknown', category: null });
  const decision = reuseDecisionSchema.parse(sample(b => 'buildAttestationId' in b && 'policy' in b, 'the reuse decision request'));
  assert.equal(decision.policy.id, policy.id);
  assert.match(guide, /authorizes.*nothing/);
});
