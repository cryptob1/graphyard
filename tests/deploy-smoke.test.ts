import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Dependency-free protected workflow script.
import { publishSmoke, runSmoke, servedCommit, smokeProof, validateSmokeReport } from '../scripts/deploy-smoke.mjs';

const deployed = 'd'.repeat(40), merge = 'c'.repeat(40), other = 'e'.repeat(40);
const workId = '00000000-0000-4000-8000-000000000050';
const expected = { repository: 'owner/repo', harnessCommit: 'a'.repeat(40), runId: '900', runAttempt: '1', workId, sha: deployed, baseSha: merge, policyRevision: 1 };
const input = (overrides: Record<string, unknown> = {}) => ({ workId, deployedSha: deployed, mergeSha: merge, policyRevision: 1, target: { url: 'https://app.example/version', shaField: 'build.commit' },
  checkUrls: ['https://app.example/healthz', 'https://app.example/api/status'], repository: 'owner/repo', harnessCommit: 'a'.repeat(40), runId: '900', runAttempt: '1', ...overrides });
/** A deployment that serves one commit, then optionally another, with configurable check statuses. */
function deployment(serving: string[], statuses: Record<string, number> = {}) {
  let probes = 0;
  return async (url: string) => {
    if (url === 'https://app.example/version') return new Response(JSON.stringify({ build: { commit: (serving[Math.min(probes++, serving.length - 1)]).toUpperCase() } }));
    return new Response('', { status: statuses[new URL(url).pathname] ?? 200 });
  };
}

test('a smoke run is attributed only to the recorded deployed commit, before and after the checks', async () => {
  const report = await runSmoke(input(), deployment([deployed]) as typeof fetch);
  assert.equal(report.result, 'pass'); assert.equal(report.executed, 2); assert.equal(report.skipped, 0);
  assert.equal(report.sha, deployed); assert.equal(report.baseSha, merge); assert.equal(report.proof, smokeProof);
  const failed = await runSmoke(input(), deployment([deployed], { '/api/status': 503 }) as typeof fetch);
  assert.equal(failed.result, 'fail'); assert.equal(failed.executed, 2, 'a failed check is still an executed check');
  await assert.rejects(runSmoke(input(), deployment([other]) as typeof fetch), /serves .* not the recorded deployed commit/, 'a moved target refuses attribution rather than failing the delivered change');
  await assert.rejects(runSmoke(input(), deployment([deployed, other]) as typeof fetch), /changed .* during the smoke run/);
  await assert.rejects(runSmoke(input({ checkUrls: [] }), deployment([deployed]) as typeof fetch), /at least one smoke check/);
  await assert.rejects(runSmoke(input({ target: { url: 'http://app.example/version' } }), deployment([deployed]) as typeof fetch), /HTTPS/);
  await assert.rejects(servedCommit({ url: 'https://app.example/version', shaField: 'commit' }, (async () => new Response(JSON.stringify({ commit: 'abc1234' }))) as typeof fetch), /full commit/);
  const command = await runSmoke(input({ checkUrls: [], command: 'exit 0' }), deployment([deployed]) as typeof fetch, (() => ({ status: 0, signal: null })) as any);
  assert.deepEqual(command.checks.map((check: any) => check.id), ['command']);
});

test('the smoke reporter rejects incomplete reports and binds the verdict to the deployment Graphyard recorded', async () => {
  const report = () => ({ ...expected, schema: 1, proof: smokeProof, result: 'pass', executed: 2, skipped: 0, checks: [{ id: 'http:/healthz', result: 'pass' }, { id: 'http:/api/status', result: 'pass' }] });
  for (const override of [{ executed: 0, checks: [] }, { skipped: 1 }, { checks: [{ id: 'x', result: 'pass' }] }, { result: 'pass', checks: [{ id: 'a', result: 'fail' }, { id: 'b', result: 'pass' }] }, { runId: 'other' }, { sha: other }, { policyRevision: 0 }]) {
    assert.throws(() => validateSmokeReport({ ...report(), ...override }, expected), `should reject ${JSON.stringify(override)}`);
  }
  assert.doesNotThrow(() => validateSmokeReport(report(), expected));
  const item: any = { id: workId, stage: 'done', policyRevision: 1, policy: { deploySmoke: true }, delivery: { mergeSha: merge, deployment: { sha: deployed } } };
  const sent: any[] = []; let producer = { role: 'producer', proofs: [smokeProof] };
  const fetcher = async (url: string, init: any) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify({ actor: producer }));
    if (url.endsWith('/work')) return new Response(JSON.stringify([item]));
    sent.push(JSON.parse(init.body)); return new Response('{}');
  };
  const config = { expected, url: 'https://graphyard.example', token: 'test-only' };
  await publishSmoke(report(), config, fetcher);
  assert.deepEqual(sent[0], { proof: smokeProof, sha: deployed, baseSha: merge, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, url: 'https://github.com/owner/repo/actions/runs/900/attempts/1' });
  await publishSmoke({ ...report(), result: 'fail', checks: [{ id: 'http:/healthz', result: 'fail' }, { id: 'http:/api/status', result: 'pass' }] }, config, fetcher);
  assert.equal(sent[1].result, 'fail', 'a failure is forwarded, never replaced by a stale pass');
  item.delivery.deployment = { sha: other };
  await assert.rejects(publishSmoke(report(), config, fetcher), /has not recorded a deployment at the smoke-tested commit/);
  item.delivery.deployment = undefined;
  await assert.rejects(publishSmoke(report(), config, fetcher), /has not recorded a deployment/);
  item.delivery.deployment = { sha: deployed }; item.policy.deploySmoke = false;
  await assert.rejects(publishSmoke(report(), config, fetcher), /policy requires/);
  item.policy.deploySmoke = true; producer = { role: 'producer', proofs: ['integration:claim-safety'] };
  await assert.rejects(publishSmoke(report(), config, fetcher), /not a producer authorized/);
  assert.equal(sent.length, 2);
});
