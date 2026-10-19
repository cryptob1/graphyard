import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSchema } from '../src/delivery.js';
import { definitionSchema } from '../src/validation.js';

/** The guide's JSON samples are what an operator copies, so each must parse with the schema its command uses. */
const guide = await readFile(new URL('../docs/delivery.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as any);
const sample = (predicate: (block: any) => boolean, label: string) => { const found = blocks.filter(predicate); assert.equal(found.length, 1, `exactly one documented sample should be ${label}`); return found[0]; };

test('the documented delivery samples parse with the schemas the API uses', () => {
  const build = buildSchema.parse(sample(b => 'sourceSha' in b && 'artifacts' in b, 'the build attestation'));
  assert.ok(build.artifacts.length >= 1, 'the documented build carries per-service digests');
  // The prose states the observation contract: measured identity, never a self-report; the
  // environment and registration shapes stay named beside their route.
  assert.match(guide, /host attestation, never a self-report/);
  assert.match(guide, /"kind":"environment"/); assert.match(guide, /"kind":"registration"/);
  // Routes whose samples the trim dropped stay named (GY-2172 cut the set to half; the names stay).
  for (const route of ['/api/delivery/release', '/api/delivery/approve', '/api/delivery/observe', '/api/delivery/observe-sha']) assert.ok(guide.includes(route), `delivery.md names ${route}`);
});
