import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';

const modules = async () => ({ ...await import('../src/model.js'), ...await import('../src/executor.js'), ...await import('../src/master-verification.js'), ...await import('../src/model/plain-status.js'), ...await import('../src/model/action-account.js'), ...await import('../src/model/next-action.js'), ...await import('../src/model/actions.js'), ...await import('../src/model/board.js'),
  ...await import('../src/master/status.js'), ...await import('../src/master/dispatch.js'), ...await import('../src/coordination.js') });

// GY-1747: six post-deploy follow-ups sat in backlog until a person released them, and windowed ones (GY-1724, GY-1725)
// were shown as blocked. The release serving a delivery being observed releases its follow-ups; a clock is a wait.

const serving = 'ba607f8a809ed20fea15387e1934425cacbfef9f', at = '2026-10-12T07:33:40.939Z', day = 86_400_000;
const delivered = {
  id: 'e03bc94f-82f4-481d-a443-4b4e6abe9eb6', key: 'GY-1700', title: 'Webhooks', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: [],
  criteria: [{ id: 'AC-2', text: 'A 24-hour window of live GitHub activity shows zero failed webhook deliveries.', proofs: ['manual:post-deploy/webhook-deliveries-clean-24h'] }],
  policy: { checks: ['test', 'typecheck'], review: true }, stage: 'done', revision: 40, policyRevision: 1, createdAt: '2026-10-11T14:00:00.000Z', updatedAt: '2026-10-11T15:08:24Z', stageEnteredAt: '2026-10-11T15:08:24Z',
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha: 'a14965e4ad9ad52069ce7dc0c5d5aabdbf4f8b43', mergedAt: '2026-10-11T15:08:24Z', evidenceAsOf: '2026-10-11T15:08:24Z', authorizationRevision: 1 },
} as unknown as Work;

const verify = async (deployed: boolean, releaseWork?: (key: string) => Promise<void>, others: Work[] = []) => {
  const { controlPlaneHandlers, localPostDeployChecks } = await modules();
  const unusable = async (): Promise<never> => { throw new Error('not reached'); };
  const log: string[] = [];
  const handlers = controlPlaneHandlers(() => ({}) as never, {
    snapshot: async () => ({ work: [delivered, ...others], now: at }),
    mutate: async (path: string) => { log.push(`record ${path.split('/').pop()}`); return {}; },
    agents: () => [], workerCredentials: async () => ({}), producerCredentials: async () => ({}), dispatchWorker: unusable, launchReview: unusable, launchProducer: unusable,
    observeDeployment: async () => ({ source: 'endpoint' as const, sha: serving, at, reason: null, deployed: deployed ? [delivered.key] : [], pending: deployed ? [] : [delivered.key] }) as never,
    fileWork: async () => { log.push('file'); return { key: 'GY-1724' }; },
    ...(releaseWork ? { releaseWork: async (key: string) => { log.push(`release ${key}`); return releaseWork(key); } } : {}),
    postDeployFiler: async () => ({ filer: async input => localPostDeployChecks(input), dispose: async () => {} }),
    now: () => Date.parse(at) + 2_000,
  });
  const action = { id: 'row-1', work: delivered.id, key: delivered.key, kind: 'verify-deployment', inputs: { kind: 'verify-deployment', mergeSha: delivered.delivery!.mergeSha } } as never;
  const outcome = await (handlers['verify-deployment']!(action, { host: 'h', executor: 'e' } as never) as Promise<string>).then(() => 'ok', (error: Error) => error.message);
  return { log, outcome };
};

test('unit:post-deploy-follow-up-released-when-served — the cycle that observes the delivery\'s release serving files the follow-up and releases it before recording; a release not yet serving leaves it in backlog', async () => {
  const served = await verify(true, async () => {});
  assert.equal(served.outcome, 'ok');
  assert.deepEqual(served.log, ['file', 'release GY-1724', 'record deployment'], 'released once filed, before the observation is recorded');
  const pending = await verify(false, async () => {});
  assert.match(pending.outcome, /does not carry GY-1700|does not serve|yet/);
  assert.deepEqual(pending.log, [], 'nothing is filed, released or recorded while the release is not serving');
  const failing = await verify(true, async () => { throw new Error('release refused'); });
  assert.equal(failing.outcome, 'release refused');
  assert.ok(!failing.log.includes('record deployment'), 'a failed release retries the action rather than recording the observation');
});

test('unit:post-deploy-follow-up-release-authority — a filed follow-up with no release authority leaves the deployment unrecorded', async () => {
  const none = await verify(true);
  assert.match(none.outcome, /no operator-agent identity to release it/);
  assert.ok(!none.log.includes('record deployment'), 'the observation waits, so the verification action does not disappear with the follow-up in backlog');
});

test('unit:clock-wait-is-not-a-block — a released follow-up holding only a window has no blocker and no attention row, waits until its time, and is dispatched once it passes', async () => {
  const { actionAccount, assertDispatchable, buildMasterStatus, dispatchable, groupOf, observationWindowHold, plainStatus } = await modules();
  const notBefore = new Date(Date.parse(at) + day).toISOString();
  const item = { ...delivered, id: 'c0ffee00-0000-4000-8000-000000001724', key: 'GY-1724', stage: 'ready', stageEnteredAt: at, ready: true, delivery: undefined, submission: null, dependencies: [], blocker: null, epoch: 0,
    observationWindow: { notBefore, basis: 'criterion-window', detail: 'GY-1700 was first observed serving at the filing and AC-2 names a 24-hour live window' }, gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as unknown as Work;
  const before = Date.parse(at) + 3_600_000;
  assert.ok(observationWindowHold(item, new Date(before)));
  const account = actionAccount(item, [item], new Date(before));
  assert.deepEqual([account.action, account.wait?.kind, item.blocker], [null, 'window', null]);
  assert.equal(groupOf(item, before), 'up-next', 'Up next, not Blocked');
  const row = buildMasterStatus({ work: [item], now: new Date(before).toISOString() }, [], []).work[0];
  assert.deepEqual([row.attention, row.attentionOwner, row.observationWindow?.waiting], [null, null, true], 'no attention row');
  assert.match(JSON.stringify(plainStatus(item, before)), /[Ww]aiting/);
  assert.equal(dispatchable(item, before), false);
  assert.throws(() => assertDispatchable(item, [item], new Date(before).toISOString()), /observation window/);
  const after = Date.parse(notBefore);
  assert.equal(observationWindowHold(item, new Date(after)), null);
  assert.equal(actionAccount(item, [item], new Date(after)).action?.kind, 'dispatch', 'the loop dispatches it when the time passes');
  assert.equal(dispatchable(item, after), true);
});

test('unit:post-deploy-follow-up-released-when-served — master verify-deployment (the supported CLI path) releases the filed follow-up before it records the deployment', async () => {
  const { verifyDeployment } = await modules();
  const run = async (releaseWork: (key: string) => Promise<void>) => {
    const log: string[] = [], now = Date.parse(at) + 2_000;
    const attempt = await verifyDeployment(delivered, {
      snapshot: async () => ({ work: [delivered], now: new Date(now).toISOString() }),
      observe: async () => ({ source: 'endpoint' as const, sha: serving, at, reason: null, deployed: [delivered.key], pending: [] }),
      release: () => ({ sha: 'f'.repeat(40), clean: true, repository: 'other/repo', reason: null }),
      emit: async () => assert.fail('nothing is emitted'), repository: 'owner/project', now: () => now,
      record: async () => { log.push('record'); }, file: async () => { log.push('file'); return { key: 'GY-1724' }; },
      releaseWork: async key => { log.push(`release ${key}`); return releaseWork(key); },
    }).then(result => result.result, (error: Error) => error.message);
    return { log, attempt };
  };
  const served = await run(async () => {});
  assert.deepEqual([served.attempt, served.log], ['verified', ['file', 'release GY-1724', 'record']]);
  const failing = await run(async () => { throw new Error('release refused'); });
  assert.equal(failing.attempt, 'release refused');
  assert.ok(!failing.log.includes('record'), 'a failed release leaves the delivery unobserved so the retry releases it');
});

test('unit:post-deploy-follow-up-released-when-served — the CLI\'s verification effects release through the operator agent only when they can file as it', async () => {
  const { verificationEffects } = await modules();
  const deps = { root: '/nonexistent', snapshot: async () => ({ work: [], now: at }), mutate: async () => ({}) };
  assert.equal(typeof verificationEffects({ repository: 'o/r', cliPath: '' } as never, { ...deps, file: async () => ({}) }).releaseWork, 'function');
  assert.equal(verificationEffects({ repository: 'o/r', cliPath: '' } as never, deps).releaseWork, undefined);
});

// A retry after an attempt that released the follow-up but failed before recording has no release left to perform.
const owedFollowUp = async (ready: boolean) => {
  const { localPostDeployChecks } = await modules();
  const [check] = await localPostDeployChecks({ work: delivered, release: serving, now: at, projections: {}, servedAt: at });
  return { ...delivered, id: 'f0000000-0000-4000-8000-000000000001', key: 'GY-1724', description: check!.followUp!.input.description, stage: ready ? 'ready' : 'backlog', ready } as unknown as Work;
};

test('unit:post-deploy-follow-up-release-authority — a retry with no release authority records when the filed follow-up is already released, and still refuses while it is in backlog', async () => {
  const released = await verify(true, undefined, [await owedFollowUp(true)]);
  assert.equal(released.outcome, 'ok');
  assert.deepEqual(released.log, ['record deployment'], 'nothing is filed or released again; the observation is recorded');
  const backlog = await verify(true, undefined, [await owedFollowUp(false)]);
  assert.match(backlog.outcome, /no operator-agent identity to release it/);
  assert.ok(!backlog.log.includes('record deployment'));
});

test('unit:post-deploy-follow-up-release-authority — master verify-deployment with no release authority records when the filed follow-up is already released', async () => {
  const { verifyDeployment } = await modules();
  const run = async (ready: boolean) => {
    const log: string[] = [], now = Date.parse(at) + 2_000, followUp = await owedFollowUp(ready);
    const attempt = await verifyDeployment(delivered, {
      snapshot: async () => ({ work: [delivered, followUp], now: new Date(now).toISOString() }),
      observe: async () => ({ source: 'endpoint' as const, sha: serving, at, reason: null, deployed: [delivered.key], pending: [] }),
      release: () => ({ sha: 'f'.repeat(40), clean: true, repository: 'other/repo', reason: null }),
      emit: async () => assert.fail('nothing is emitted'), repository: 'owner/project', now: () => now,
      record: async () => { log.push('record'); }, file: async () => { log.push('file'); return { key: 'GY-1724' }; },
    }).then(result => result.result, (error: Error) => error.message);
    return { log, attempt };
  };
  assert.deepEqual(await run(true).then(r => [r.attempt, r.log]), ['verified', ['record']]);
  const backlog = await run(false);
  assert.equal(backlog.attempt, 'refused');
  assert.ok(!backlog.log.includes('record'));
});
