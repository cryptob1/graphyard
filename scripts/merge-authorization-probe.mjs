// Protected merge-authorization probe. Run this controller from protected source against a
// candidate process over HTTP; never import candidate code here. It records only the responses
// it observes. Every assertion lives outside, in judgeMergeAuthorization, so a candidate cannot
// pass by rewriting the transcript or expectations it is measured against.
//
// Unlike the claim-safety contract, this scenario needs an observed GitHub candidate, and
// Graphyard deliberately exposes no client-controlled route that invents one. The probe
// therefore uses a separately authenticated harness endpoint at exactly those two points —
// supplying an observation and a speculative tip — and drives every authorization
// decision under test through the candidate's own HTTP API.
import { randomUUID } from 'node:crypto';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const repository = 'graphyard-probe/candidate';
const proof = 'integration:merge-authorization';

export function mergeAuthorizationPrincipals() { return [
  { id: 'probe-operator', role: 'admin', token: randomUUID() + randomUUID() },
  { id: 'probe-worker', role: 'worker', token: randomUUID() + randomUUID() },
  { id: 'probe-coordinator', role: 'coordinator', token: randomUUID() + randomUUID() },
  { id: 'probe-other-coordinator', role: 'coordinator', token: randomUUID() + randomUUID() },
  { id: 'probe-producer', role: 'producer', proofs: [proof], token: randomUUID() + randomUUID() },
  { id: 'probe-other-producer', role: 'producer', proofs: ['integration:unrelated'], token: randomUUID() + randomUUID() },
]; }

export async function probeMergeAuthorization({ url, controlUrl, controlToken, principals, observeCandidate }) {
  const actor = id => principals.find(candidate => candidate.id === id);
  let snapshot = null;
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
    const observeWork = observeCandidate ?? (async (item, observation, speculation) => {
      const response = await fetch(`${controlUrl}/observe`, { method: 'POST', headers: { Authorization: `Bearer ${controlToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, revision: item.revision, observation, ...(speculation ? { speculation } : {}) }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Probe observation failed'); return body;
    });
    // The merge queue is the only path onto the base branch, and only Graphyard publishes a
    // speculative tip. Like the observation itself, the harness supplies that binding; no
    // client-controlled route can invent one.
    const speculation = (item, sha, baseSha) => ({ ref: `refs/graphyard/queue/${item.key.toLowerCase()}`, tip: sha, base: baseSha, baseTree: '7e'.repeat(20), predecessors: [], policyRevision: item.policyRevision, publishedAt: new Date().toISOString() });

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
      protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/engine.ts'], scopeFiles: [],
      at: new Date().toISOString(), ...extra,
    });
    snapshot = observe({ prState: 'open', draft: false });
    work = await observeWork(work, observe());
    work = (await call(`work/${work.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 9, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } })).body;
    work = await observeWork(work, observe(), speculation(work, head, base));
    record('authorized-candidate', { stage: work.stage, gatesPassed: work.gates.every(gate => gate.passed), authorized: !!work.mergeAuthorization });

    // GitHub executes merges (GY-258): the merge step's one route records a request that GitHub
    // merge exactly this candidate. No execution, verification or provider commit is issued.
    const requestInput = { enqueue: true, expectedRevision: work.revision, sha: head, baseSha: base, policyRevision: work.policyRevision };
    const withdrawal = { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, reason: 'Probe withdrew the reported run' };
    for (const who of [null, 'probe-worker', 'probe-producer', 'probe-other-producer'])
      record('broker-identity', { actor: who, ...refusal(await call(`work/${work.id}/merge-acquire`, who, requestInput)) });
    // The allowlisted producer is excluded here on purpose: it is the one identity that may
    // withdraw this proof, and it does so below after the merge was requested.
    for (const who of [null, 'probe-worker', 'probe-other-producer', 'probe-coordinator'])
      record('revocation-identity', { actor: who, ...refusal(await call(`work/${work.id}/revoke`, who, withdrawal)) });
    record('revocation-scope', refusal(await call(`work/${work.id}/revoke`, 'probe-producer', { ...withdrawal, sha: 'd'.repeat(40) })));

    const requested = (await call(`work/${work.id}/merge-acquire`, 'probe-coordinator', requestInput)).body;
    record('merge-requested', { requestedBy: requested.enqueue?.requestedBy ?? null, sha: requested.enqueue?.sha ?? null, execution: requested.execution ?? null });
    const unfrozen = await call(`work/${work.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 9, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } });
    record('not-frozen-by-request', { status: unfrozen.status });

    const revoked = (await call(`work/${work.id}/revoke`, 'probe-producer', withdrawal)).body;
    record('revoked', {
      stage: revoked.stage, execution: revoked.mergeExecution ?? null, authorization: revoked.mergeAuthorization,
      queue: revoked.queue ?? null, ejection: revoked.queueEjection ? { sha: revoked.queueEjection.sha, reason: revoked.queueEjection.reason } : null,
      acceptanceReasons: revoked.gates?.find(gate => gate.name === 'acceptance')?.reasons ?? [],
      revocations: (revoked.evidence ?? []).filter(item => item.revocation).map(item => ({ proof: item.proof, actor: item.revocation.actor, reason: item.revocation.reason })),
      retainedEvidence: (revoked.evidence ?? []).length,
    });

    const current = (await call('work', 'probe-operator')).body.find(item => item.id === work.id);
    const retryInput = { enqueue: true, expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision };
    record('request-after-revocation', refusal(await call(`work/${work.id}/merge-acquire`, 'probe-coordinator', retryInput)));
    record('execution-request-refused', refusal(await call(`work/${work.id}/merge-acquire`, 'probe-coordinator', { expectedRevision: current.revision, sha: head, baseSha: base, policyRevision: current.policyRevision })));
    for (const route of ['merge-verify', 'merge-commit', 'merge-cancel'])
      record('removed-execution-route', { route, status: (await call(`work/${work.id}/${route}`, 'probe-coordinator', { executionId: randomUUID(), reason: 'Probe' })).status });
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      call(`work/${work.id}/merge-acquire`, index % 2 ? 'probe-coordinator' : 'probe-other-coordinator', retryInput)));
    record('concurrent-attempts', { attempts: concurrent.map(result => refusal(result)) });
    const settled = (await call('work', 'probe-operator')).body.find(item => item.id === work.id);
    record('no-execution-survives', { execution: settled.mergeExecution ?? null, authorization: settled.mergeAuthorization ?? null });

    const merged = await observeWork(settled, observe({ merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() + 5000).toISOString() }));
    record('merge-after-revocation', { stage: merged.stage, violations: merged.violations, delivery: merged.delivery ?? null });

    // Race the merge request against the withdrawal on a fresh candidate. The row lock gives the
    // two a total order; withdrawal is never refused for a merge GitHub holds, and a merge GitHub
    // lands after it is a violation whichever side won.
    let raced = (await call('work', 'probe-operator', { title: 'Merge request race probe', criteria: [{ id: 'AC-1', text: 'Revocation serializes with the merge request', proofs: [proof] }] })).body;
    await call(`work/${raced.id}/ready`, 'probe-operator', {});
    raced = (await call(`work/${raced.id}/claim`, 'probe-worker', {})).body;
    const racedBranch = `graphyard/probe-${raced.id}`;
    raced = (await call(`work/${raced.id}/workspace`, 'probe-worker', { epoch: raced.epoch, host: 'probe-race-host', path: `/tmp/probe-race-${raced.id}`, branch: racedBranch })).body;
    raced = (await call(`work/${raced.id}/submit`, 'probe-worker', { epoch: raced.epoch, pr: 4002 })).body;
    snapshot = observe({ candidate: { sha: head, baseSha: base, pr: 4002, branch: racedBranch, author: 'probe-implementer' }, prState: 'open', draft: false });
    raced = await observeWork(raced, snapshot);
    raced = (await call(`work/${raced.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: raced.policyRevision, result: 'pass', executed: 9, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } })).body;
    raced = await observeWork(raced, snapshot, speculation(raced, head, base));
    const racedWithdrawal = { proof, sha: head, baseSha: base, policyRevision: raced.policyRevision, reason: 'Probe raced the merge request' };
    const [requestResult, revokeResult] = await Promise.all([
      call(`work/${raced.id}/merge-acquire`, 'probe-coordinator', { enqueue: true, expectedRevision: raced.revision, sha: head, baseSha: base, policyRevision: raced.policyRevision }),
      call(`work/${raced.id}/revoke`, 'probe-producer', racedWithdrawal),
    ]);
    const racedCurrent = (await call('work', 'probe-operator')).body.find(item => item.id === raced.id);
    const racedMerge = await observeWork(racedCurrent, { ...snapshot, merged: true, mergeSha: 'e'.repeat(40), mergedAt: new Date(Date.now() + 5000).toISOString(), at: new Date().toISOString() });
    record('provider-commit-race', {
      request: requestResult.status === 200 ? { status: 200 } : refusal(requestResult),
      revoke: revokeResult.status === 200 ? { status: 200 } : refusal(revokeResult),
      revokedEvidence: racedCurrent.evidence.filter(item => item.revocation).length,
      execution: racedCurrent.mergeExecution ?? null,
      mergedStage: racedMerge.stage, mergedViolations: racedMerge.violations,
    });
    return transcript;
  } finally { /* candidate lifecycle is owned by the outer controller */ }
}
