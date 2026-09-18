import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { attemptGrantSchema, runnerPlanSchema } from '../src/runner-executor.js';
import { collectorInputSchema } from '../src/runner-collector.js';

/**
 * The setup guide's configuration samples are what an operator actually copies, so a
 * sample the CLI would reject during input validation is a broken documented path rather
 * than a typo. These parse the published JSON with the exact schemas the commands use.
 */
const guide = await readFile(new URL('../docs/runner-setup.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as any);
const sample = (key: string) => {
  const found = blocks.filter(block => block && typeof block === 'object' && !Array.isArray(block) && key in block);
  assert.equal(found.length, 1, `exactly one documented sample should carry ${key}`);
  return found[0];
};

test('the documented runner configuration parses as the runner plan the CLI reads', () => {
  const plan = runnerPlanSchema.parse(sample('supervisor'));
  // The collection root, not one attempt's directory: the attestor provisions a fresh
  // boundary per attempt beneath it, which is what lets a second attempt run at all.
  assert.equal(plan.outputPath, '/srv/graphyard/attempts');
  assert.equal(plan.runAsUser, '10001:20001');
  assert.notEqual(plan.runAsUser.split(':')[0], plan.runAsUser.split(':')[1], 'the documented container account and boundary group use distinct numeric identities');
  // Nothing that decides what is approved may be configured locally.
  for (const authority of ['grant', 'targetUrl', 'bundleDigest', 'executionNetwork', 'attestationPublicKey', 'executionHost']) {
    assert.throws(() => runnerPlanSchema.parse({ ...sample('supervisor'), [authority]: 'x' }), new RegExp('unrecognized|Unrecognized', 'i'), authority);
  }
  const { runAsUser: _runAsUser, ...missingContainerIdentity } = sample('supervisor');
  assert.throws(() => runnerPlanSchema.parse(missingContainerIdentity), /runAsUser/,
    'the CLI must not guess the container UID or boundary GID from the attestor process');
});

test('the documented collector configuration carries the whole dispatch authority', () => {
  const collector = sample('requiredArtifacts');
  // `runner collect` parses `grant` with the strict attempt-grant schema. A sample missing
  // `executionHost` or `attestationPublicKey` documents a command that always exits during
  // input validation: the first names the daemon settlement is observed on, the second the
  // key the host attestation is verified against.
  const grant = attemptGrantSchema.parse(collector.grant);
  assert.match(grant.executionHost, /^(?:ssh|tcp|unix):\/\//);
  assert.match(grant.attestationPublicKey, /BEGIN PUBLIC KEY/);
  // The collector reads the attempt's own boundary, which the execution record names.
  assert.equal(collector.outputPath, `/srv/graphyard/attempts/${grant.attemptId}`);

  // Every key the sample sets is one the collector accepts, and every input it must be
  // given is one the sample sets.
  const shape = collectorInputSchema.shape as Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
  const documented = new Set(Object.keys(collector));
  assert.deepEqual([...documented].filter(key => !(key in shape)), []);
  assert.deepEqual(Object.keys(shape).filter(key => !documented.has(key) && !shape[key].safeParse(undefined).success), []);
});
