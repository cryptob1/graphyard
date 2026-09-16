// Protected merge-authorization probe. Run this from protected source against a candidate
// build; never from the candidate checkout. The probe only drives the candidate and records
// what it observed. Every assertion lives outside, in judgeMergeAuthorization, so a candidate
// cannot pass by rewriting the expectations it is measured against.
//
// Unlike the claim-safety contract, this scenario needs an observed GitHub candidate, and
// Graphyard deliberately exposes no client-controlled route that invents one. The probe
// therefore stands in for the provider adapter at exactly those two points — supplying an
// observation and a final verification snapshot — and drives every authorization decision
// under test through the candidate's own HTTP API.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const repository = 'graphyard-probe/candidate';
const proof = 'integration:merge-authorization';

async function load(sourceRoot, file) {
  return import(pathToFileURL(resolve(sourceRoot, 'src', file)).href);
}

export async function probeMergeAuthorization({ databaseUrl, sourceRoot = '/app' }) {
  const { Store } = await load(sourceRoot, 'store.js');
  const { Engine } = await load(sourceRoot, 'engine.js');
  const { server } = await load(sourceRoot, 'server.js');
  const principals = [
    { id: 'probe-operator', role: 'admin', token: randomUUID() + randomUUID() },
    { id: 'probe-worker', role: 'worker', token: randomUUID() + randomUUID() },
    { id: 'probe-coordinator', role: 'coordinator', token: randomUUID() + randomUUID() },
    { id: 'probe-other-coordinator', role: 'coordinator', token: randomUUID() + randomUUID() },
    { id: 'probe-producer', role: 'producer', proofs: [proof], token: randomUUID() + randomUUID() },
    { id: 'probe-other-producer', role: 'producer', proofs: ['integration:unrelated'], token: randomUUID() + randomUUID() },
  ];
  const actor = id => principals.find(candidate => candidate.id === id);
  const store = new Store(databaseUrl);
  await store.init();
  const engine = new Engine(store, [15368], 120, repository);
  let snapshot = null;
  const github = {
    config: { repository, base: 'main', appId: 1, installationId: 1, privateKey: '' },
    verify: async () => structuredClone(snapshot),
    serverTime: async () => Date.now(),
    reviewRepository: async () => null,
    reviewPermissions: async () => ({}),
  };
  const http = server(engine, principals, github);
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${http.address().port}`;
  const transcript = [];
  const record = (step, detail) => { transcript.push({ step, ...detail }); return detail; };
  try {
    const call = async (path, who, data, key = randomUUID()) => {
      const response = await fetch(`${url}/api/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { ...(who ? { Authorization: `Bearer ${actor(who).token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20_000),
      });
      return { status: response.status, body: await response.json() };
    };
    const refusal = result => ({ status: result.status, message: String(result.body?.error ?? '') });

    let work = (await call('work', 'probe-operator', { title: 'Merge authorization probe', criteria: [{ id: 'AC-1', text: 'A revoked candidate cannot merge', proofs: [proof] }] })).body;
    await call(`work/${work.id}/ready`, 'probe-operator', {});
    work = (await call(`work/${work.id}/claim`, 'probe-worker', {})).body;
    const branch = `graphyard/probe-${work.id}`;
    work = (await call(`work/${work.id}/workspace`, 'probe-worker', { epoch: work.epoch, host: 'probe-host', path: `/tmp/probe-${work.id}`, branch })).body;
    work = (await call(`work/${work.id}/submit`, 'probe-worker', { epoch: work.epoch, pr: 4001 })).body;

    const observe = extra => ({
      clockOffset: { min: 0, max: 0 },
      candidate: { sha: head, baseSha: base, pr: 4001, branch, author: 'probe-implementer' },
      checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
      reviews: [{ reviewer: 'probe-reviewer', sha: head, state: 'APPROVED' }],
      protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/engine.ts'],
      at: new Date().toISOString(), ...extra,
    });
    snapshot = observe({ prState: 'open', draft: false });
    work = await engine.observe(work.id, work.revision, observe());
    work = (await call(`work/${work.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 9, skipped: 0 })).body;
    record('authorized-candidate', { stage: work.stage, gatesPassed: work.gates.every(gate => gate.passed), authorized: !!work.mergeAuthorization });

    const acquireInput = { expectedRevision: work.revision, sha: head, baseSha: base, policyRevision: work.policyRevision };
    const withdrawal = { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, reason: 'Probe withdrew the reported run' };
    for (const who of [null, 'probe-worker', 'probe-producer', 'probe-other-producer'])
      record('broker-identity', { actor: who, ...refusal(await call(`work/${work.id}/merge-acquire`, who, acquireInput)) });
    // The allowlisted producer is excluded here on purpose: it is the one identity that may
    // withdraw this proof, and it does so below while an execution is active.
    for (const who of [null, 'probe-worker', 'probe-other-producer', 'probe-coordinator'])
      record('revocation-identity', { actor: who, ...refusal(await call(`work/${work.id}/revoke`, who, withdrawal)) });
    record('revocation-scope', refusal(await call(`work/${work.id}/revoke`, 'probe-producer', { ...withdrawal, sha: 'd'.repeat(40) })));

    const acquireKey = randomUUID();
    const granted = (await call(`work/${work.id}/merge-acquire`, 'probe-coordinator', acquireInput, acquireKey)).body;
    record('execution-granted', { owner: granted.execution?.owner ?? null, sha: granted.execution?.sha ?? null, authorizationRevision: granted.execution?.authorizationRevision ?? null });
    record('frozen-during-execution', refusal(await call(`work/${work.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 9, skipped: 0 })));

    const revoked = (await call(`work/${work.id}/revoke`, 'probe-producer', withdrawal)).body;
    record('revoked', {
      stage: revoked.stage, execution: revoked.mergeExecution, authorization: revoked.mergeAuthorization,
      acceptanceReasons: revoked.gates?.find(gate => gate.name === 'acceptance')?.reasons ?? [],
      revocations: (revoked.evidence ?? []).filter(item => item.revocation).map(item => ({ proof: item.proof, actor: item.revocation.actor, reason: item.revocation.reason })),
      retainedEvidence: (revoked.evidence ?? []).length,
    });

    record('verify-after-revocation', refusal(await call(`work/${work.id}/merge-verify`, 'probe-coordinator', { executionId: granted.execution.id })));
    record('acquire-replay-after-revocation', refusal(await call(`work/${work.id}/merge-acquire`, 'probe-coordinator', acquireInput, acquireKey)));
    record('cancel-after-revocation', refusal(await call(`work/${work.id}/merge-cancel`, 'probe-coordinator', { executionId: granted.execution.id, reason: 'Probe late cancel' })));

    const current = (await call('work', 'probe-operator')).body.find(item => item.id === work.id);
    const retryInput = { expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision };
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      call(`work/${work.id}/merge-acquire`, index % 2 ? 'probe-coordinator' : 'probe-other-coordinator', retryInput)));
    record('concurrent-attempts', { attempts: concurrent.map(result => refusal(result)) });
    const settled = (await call('work', 'probe-operator')).body.find(item => item.id === work.id);
    record('no-execution-survives', { execution: settled.mergeExecution ?? null, authorization: settled.mergeAuthorization ?? null });

    const merged = await engine.observe(work.id, settled.revision, observe({ merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() + 5000).toISOString() }));
    record('merge-after-revocation', { stage: merged.stage, violations: merged.violations, delivery: merged.delivery ?? null });
    return transcript;
  } finally {
    await new Promise(done => http.close(done));
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transcript = await probeMergeAuthorization({ databaseUrl: process.env.DATABASE_URL, sourceRoot: process.env.GRAPHYARD_SOURCE_ROOT ?? '/app' });
  process.stdout.write(`\n--- graphyard-transcript ---\n${JSON.stringify(transcript)}\n--- end-graphyard-transcript ---\n`);
}
