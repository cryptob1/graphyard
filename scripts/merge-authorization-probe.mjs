// Protected merge-authorization probe. Run this controller from protected source against a
// candidate process over HTTP; never import candidate code here. It records only the responses
// it observes. Every assertion lives outside, in judgeMergeAuthorization, so a candidate cannot
// pass by rewriting the transcript or expectations it is measured against.
//
// Unlike the claim-safety contract, this scenario needs an observed GitHub candidate, and
// Graphyard deliberately exposes no client-controlled route that invents one. The probe
// therefore uses a separately authenticated harness endpoint at exactly those two points —
// supplying an observation and a final verification snapshot — and drives every authorization
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
    record('frozen-during-execution', refusal(await call(`work/${work.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 9, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } })));

    const revoked = (await call(`work/${work.id}/revoke`, 'probe-producer', withdrawal)).body;
    record('revoked', {
      stage: revoked.stage, execution: revoked.mergeExecution, authorization: revoked.mergeAuthorization,
      queue: revoked.queue ?? null, ejection: revoked.queueEjection ? { sha: revoked.queueEjection.sha, reason: revoked.queueEjection.reason } : null,
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

    const merged = await observeWork(settled, observe({ merged: true, mergeSha: 'c'.repeat(40), mergedAt: new Date(Date.now() + 5000).toISOString() }));
    record('merge-after-revocation', { stage: merged.stage, violations: merged.violations, delivery: merged.delivery ?? null });

    // Exercise the exact final race on a fresh candidate. The row lock gives one operation
    // a total order: withdrawal cancels before provider commit, or commit wins and the later
    // withdrawal refuses instead of falsely reporting a revoked candidate.
    let raced = (await call('work', 'probe-operator', { title: 'Merge commit race probe', criteria: [{ id: 'AC-1', text: 'Revocation serializes with provider commit', proofs: [proof] }] })).body;
    await call(`work/${raced.id}/ready`, 'probe-operator', {});
    raced = (await call(`work/${raced.id}/claim`, 'probe-worker', {})).body;
    const racedBranch = `graphyard/probe-${raced.id}`;
    raced = (await call(`work/${raced.id}/workspace`, 'probe-worker', { epoch: raced.epoch, host: 'probe-race-host', path: `/tmp/probe-race-${raced.id}`, branch: racedBranch })).body;
    raced = (await call(`work/${raced.id}/submit`, 'probe-worker', { epoch: raced.epoch, pr: 4002 })).body;
    snapshot = observe({ candidate: { sha: head, baseSha: base, pr: 4002, branch: racedBranch, author: 'probe-implementer' }, prState: 'open', draft: false });
    raced = await observeWork(raced, snapshot);
    raced = (await call(`work/${raced.id}/evidence`, 'probe-producer', { proof, sha: head, baseSha: base, policyRevision: raced.policyRevision, result: 'pass', executed: 9, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } })).body;
    raced = await observeWork(raced, snapshot, speculation(raced, head, base));
    const racedAcquire = (await call(`work/${raced.id}/merge-acquire`, 'probe-coordinator', { expectedRevision: raced.revision, sha: head, baseSha: base, policyRevision: raced.policyRevision })).body;
    await call(`work/${raced.id}/merge-verify`, 'probe-coordinator', { executionId: racedAcquire.execution.id });
    const racedWithdrawal = { proof, sha: head, baseSha: base, policyRevision: raced.policyRevision, reason: 'Probe raced final provider commit' };
    const [commitResult, revokeResult] = await Promise.all([
      call(`work/${raced.id}/merge-commit`, 'probe-coordinator', { executionId: racedAcquire.execution.id }),
      call(`work/${raced.id}/revoke`, 'probe-producer', racedWithdrawal),
    ]);
    const racedCurrent = (await call('work', 'probe-operator')).body.find(item => item.id === raced.id);
    record('provider-commit-race', {
      commit: commitResult.status === 200 ? { status: 200 } : refusal(commitResult),
      revoke: revokeResult.status === 200 ? { status: 200 } : refusal(revokeResult),
      revokedEvidence: racedCurrent.evidence.filter(item => item.revocation).length,
      committingAt: racedCurrent.mergeExecution?.committingAt ?? null,
    });
    return transcript;
  } finally { /* candidate lifecycle is owned by the outer controller */ }
}
