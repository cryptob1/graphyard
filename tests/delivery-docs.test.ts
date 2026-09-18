import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { approvalSchema, buildSchema, observationSchema, releaseSchema, selectSchema } from '../src/delivery.js';
import { definitionSchema } from '../src/validation.js';

/** The guide's JSON samples are what an operator copies, so each must parse with the schema its command uses. */
const guide = await readFile(new URL('../docs/delivery.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as any);
const sample = (predicate: (block: any) => boolean, label: string) => { const found = blocks.filter(predicate); assert.equal(found.length, 1, `exactly one documented sample should be ${label}`); return found[0]; };

test('the documented delivery samples parse with the schemas the API uses', () => {
  const environment = definitionSchema.parse(sample(b => b.kind === 'environment', 'the environment'));
  assert.equal(environment.kind, 'environment'); assert.deepEqual((environment as any).delivery, { freshnessSeconds: 300, approvalRequired: true });
  const observerRegistration = definitionSchema.parse(sample(b => b.kind === 'registration', 'the observer registration'));
  assert.equal(observerRegistration.kind === 'registration' && observerRegistration.role, 'observer');
  assert.deepEqual(observerRegistration.kind === 'registration' && observerRegistration.services, ['api', 'web']);
  const build = buildSchema.parse(sample(b => 'provenanceUrl' in b, 'the build attestation'));
  const release = releaseSchema.parse(sample(b => 'members' in b, 'the release'));
  assert.deepEqual(release.manifest, build.artifacts, 'the documented release cites the documented build');
  assert.equal(release.members.filter(m => !m.included).length, 1, 'a reverted member is documented as excluded');
  const selection = selectSchema.parse(sample(b => 'expectedGeneration' in b && !('services' in b), 'the selection'));
  assert.equal(selection.release.id, release.id);
  approvalSchema.parse({ release: selection.release, environment: selection.environment });
  const observation = observationSchema.parse(sample(b => 'snapshotId' in b, 'the observation'));
  assert.ok(observation.services.every(s => s.instances.every(i => i.measurement === 'host-attestation')), 'the documented observation carries measured identity, never a self-report');
  assert.deepEqual(observation.services.map(s => s.service), environment.kind === 'environment' ? environment.services : []);
});
