import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { liveScopeWidening } from '../src/model/scope.js';
import { approverSessionName, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { successorWidening } from '../src/model/successors.js';
import { scopeRefusalFault, transientScopeRefusal } from '../src/daemon/cycle-scope.js';
import { lateDecisionRead } from '../src/daemon/decision-reads.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { Principal, ScopeFile, Work } from '../src/model.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { approveScopeRequest, scopeRequestAttention } from '../src/cli/master-status.js';
import { Store } from '../src/store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-76: a purely additive plannedFiles widening applies to an item under an active lease
// without ending the attempt, a worker asks for it through a scope request the master approves
// with one command, and every non-additive change under a lease is still refused. Each test is
// named for the proof it produces.
const repository = 'owner/live-scope';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, implementer].map(principal => ({ ...principal, token: `scope-${principal.id}-${'x'.repeat(32)}` }));
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements'] };
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, operatorTokenFile: string;
const specFile: ScopeFile = { path: 'web/Widget.spec.tsx', status: 'modified', sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), additions: 4, deletions: 2, binary: false };
const reason = 'The browser specs assert the layout this item removes';

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const input = (title: string) => ({ title, plannedFiles: ['src/widget/Layout.tsx'], criteria: [{ id: 'AC-1', text: 'Layout renders', proofs: ['unit:layout'] }], reason: 'Operator goal: scope widening never forces a hand-back' });
const widen = (work: Work, paths: string[]) => ({ expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles: [...work.plannedFiles, ...paths], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [] });

async function claimed(title: string) {
  let work = await ok(master.token, 'POST', 'work', input(title)) as Work;
  work = await ok(master.token, 'POST', `work/${work.id}/ready`, { expectedRevision: work.revision, reason: 'Ready for the live-scope attempt' }) as Work;
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'scope-host', path: `/tmp/scope/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  return reload(work.id);
}
const masterScopeConfig = () => ({ url, operatorAgent: { credentialFile: operatorTokenFile } }) as unknown as MasterConfig;
const snapshotRead = (path: string) => ok(token(operator), 'GET', path);

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 21;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('live-scope-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('live_scope_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/live_scope_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await ok(token(operator), 'POST', 'operator-agents', { id: master.id, displayName: master.id, capabilities: master.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: master.token, reason: 'Onboarding provisions the master operator agent' });
  operatorTokenFile = join(await temporaryDirectory('live-scope'), 'operator.token');
  await writeFile(operatorTokenFile, `${master.token}\n`, { mode: 0o600 });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:live-scope-widening — an additive plannedFiles widening applies under a live lease and reaches the worker scope check immediately', async () => {
  let work = await claimed('widening');
  assert.ok(work.lease && work.lease.owner === implementer.id && Date.parse(work.lease.expiresAt) > Date.now());
  assert.ok(regressionRefusals(work, { scopeFiles: [specFile] }, []).length, 'before widening, the spec file is outside plannedFiles and refused');

  const widened = await ok(master.token, 'POST', `work/${work.id}/requirements`, { ...widen(work, [specFile.path]), reason });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, ['src/widget/Layout.tsx', specFile.path]);
  assert.equal(work.policyRevision, widened.policyRevision);
  assert.ok(work.lease && work.lease.epoch === widened.epoch && work.lease.owner === implementer.id, 'the attempt keeps its lease');
  const ledger = await events(work);
  const row = ledger.filter(entry => entry.kind === 'requirements').at(-1)!;
  assert.equal(row.actor, master.id);
  assert.equal(row.payload.details.liveScopeWidening, true);
  assert.deepEqual(row.payload.details.before.plannedFiles, ['src/widget/Layout.tsx']);
  assert.ok(row.payload.work.plannedFiles.includes(specFile.path));
  const beats = await engine.execute(implementer, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID());
  assert.ok(Date.parse(beats.lease!.expiresAt) >= Date.parse(work.lease!.expiresAt), 'the worker keeps heartbeating the same attempt');
  assert.equal(regressionRefusals(work, { scopeFiles: [specFile] }, []).length, 0, 'the worker scope check sees the widened scope immediately');

  for (const broken of [
    { ...widen(work, []), plannedFiles: work.plannedFiles.slice(1) },
    { ...widen(work, []), criteria: [{ ...work.criteria[0], text: 'Layout renders everywhere' }] },
  ]) {
    const refused = await call(master.token, 'POST', `work/${work.id}/requirements`, { ...broken, reason: 'Under a live lease nothing else may change' });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /Stop and release the active worker before revising requirements/);
  }
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, ['src/widget/Layout.tsx', specFile.path], 'refused revisions change nothing');

  await engine.execute(implementer, 'quarantine', work.id, { epoch: work.epoch, settlementHash: 'e'.repeat(64) }, randomUUID());
  const quarantined = await call(master.token, 'POST', `work/${work.id}/requirements`, { ...widen(work, []), reason: 'A no-op under quarantine is still a revision' });
  assert.match(quarantined.body.error, /quarantined by unverified containment from epoch 1; requirements remain immutable until settlement or stopped-worker recovery/);
  await ok(master.token, 'POST', `work/${work.id}/requirements`, { ...widen(work, ['docs/widget.md']), reason: 'The docs page embeds the layout' });
  work = await reload(work.id);
  assert.deepEqual(work.plannedFiles, ['src/widget/Layout.tsx', specFile.path, 'docs/widget.md']);
  assert.ok(work.containmentQuarantine && work.containmentQuarantine.epoch === work.epoch, 'the live quarantine survives a live widening');
  assert.ok(work.lease && work.lease.epoch === work.epoch, 'the live lease survives a live widening');

  // GY-1293 (GY-1235 on 5 October 2026): the loop's successor re-plan was posted from the snapshot
  // its own widening had just outdated. Against requirements it never saw, the additive widening
  // read as a narrowing and was refused as a quarantine breach; it is refused as the stale revision it is.
  const stale = await call(master.token, 'POST', `work/${work.id}/requirements`, { ...widen({ ...work, policyRevision: work.policyRevision - 1, plannedFiles: work.plannedFiles.slice(0, -1) }, ['src/widget/Successor.tsx']), reason: 'Re-planned onto a successor from a stale read' });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error, /^Policy revision changed; reload before revising$/);
  assert.deepEqual((await reload(work.id)).plannedFiles, ['src/widget/Layout.tsx', specFile.path, 'docs/widget.md'], 'the stale revision changes nothing');
});

test('integration:scope-request-flow — the request surfaces to the master and one command applies it without ending the attempt', async () => {
  let work = await claimed('request');
  const requested = await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [specFile.path], reason }) as Work;
  assert.deepEqual(requested.scopeRequest, { epoch: work.epoch, paths: [specFile.path], reason, requestedBy: implementer.id, at: requested.scopeRequest!.at });
  work = await reload(work.id);
  const ledger = await events(work);
  assert.equal(ledger.filter(entry => entry.kind === 'scope').at(-1)!.actor, implementer.id);

  const now = new Date().toISOString();
  const items = scopeRequestAttention({ work: [work], now });
  assert.equal(items.length, 1);
  assert.equal(items[0].subject, work.key);
  assert.match(items[0].text, new RegExp(`${implementer.id} needs files outside plannedFiles`));
  assert.match(items[0].text, new RegExp(specFile.path.replace('.', '\\.')));
  assert.match(items[0].text, /browser specs assert the layout/);
  assert.equal(items[0].role, 'master');
  assert.equal(items[0].human, false);
  assert.equal(items[0].next, `graphyard master scope ${work.key}`);

  const applied = await approveScopeRequest(process.cwd(), masterScopeConfig(), [work.key], { coordinator: snapshotRead }) as Work;
  assert.deepEqual(applied.plannedFiles, ['src/widget/Layout.tsx', specFile.path]);
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the answered request is cleared');
  assert.ok(work.lease && work.lease.epoch === requested.epoch, 'the attempt keeps its lease');
  assert.equal(scopeRequestAttention({ work: [work], now: new Date().toISOString() }).length, 0);
  const requirements = (await events(work)).filter(entry => entry.kind === 'requirements').at(-1)!;
  assert.equal(requirements.actor, master.id);
  assert.equal(requirements.payload.details.liveScopeWidening, true);
  assert.match(requirements.payload.details.reason, new RegExp(`Approve ${implementer.id}`));

  const inside = await call(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['src/widget/Layout.tsx'], reason: 'already planned' });
  assert.equal(inside.status, 409, JSON.stringify(inside.body));
  assert.match(inside.body.error, /Every named path is already inside plannedFiles/);

  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['docs/widget.md'], reason: 'Still needed' });
  work = await reload(work.id);
  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [], reason: 'Withdrawn by the worker' });
  work = await reload(work.id);
  assert.equal(work.scopeRequest, null, 'the worker can withdraw the request');
  const empty = await call(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: [], reason: 'Nothing to withdraw' });
  assert.match(empty.body.error, /No scope request is open for this attempt/);

  await ok(token(implementer), 'POST', `work/${work.id}/scope`, { epoch: work.epoch, paths: ['docs/widget.md'], reason: 'Still needed' });
  work = await reload(work.id);
  await engine.execute(implementer, 'release', work.id, { epoch: work.epoch }, randomUUID());
  work = await reload(work.id);
  assert.equal(scopeRequestAttention({ work: [work], now: new Date().toISOString() }).length, 0, 'a request whose lease ended is never surfaced');
  // The release ended the attempt that asked, so it closed the request (GY-597): nothing is left to approve.
  assert.equal(work.scopeRequest, null, 'the ended attempt\'s request is closed');
  await assert.rejects(approveScopeRequest(process.cwd(), masterScopeConfig(), [work.key], { coordinator: snapshotRead }), /no open scope request to approve/);
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  assert.equal(work.scopeRequest, null, 'a fresh attempt asks afresh');
});

test('unit:live-scope-change-guard — only adding planned files is a live widening; removals, criterion and proof changes are not', () => {
  const current = { criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], dependencies: [] as string[], plannedFiles: ['src/a.ts'], exclusiveResources: [] as string[], producerProofs: [] as string[] };
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/a.ts', 'src/b.ts'] }), true);
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }), true);
  assert.equal(liveScopeWidening(current, { ...current }), false, 'no added file is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/b.ts'] }), false, 'removal is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, plannedFiles: ['src/a.ts', 'src/a.ts'] }), false, 'a duplicate is not an added file');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ id: 'AC-1', text: 'Works everywhere', proofs: ['unit:works'] }] }), false, 'a criterion rewrite is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works-again'] }] }), false, 'a proof change is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }, { id: 'AC-2', text: 'More', proofs: ['unit:more'] }] }), false, 'an added criterion is not a scope widening');
  assert.equal(liveScopeWidening(current, { ...current, dependencies: ['5f0f5f0f-0000-4000-8000-000000000000'] }), false, 'a dependency change is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, exclusiveResources: ['db'] }), false, 'a resource change is not a widening');
  assert.equal(liveScopeWidening(current, { ...current, producerProofs: ['manual:audit'] }), false, 'a producer-proof change is not a widening');
  assert.equal(liveScopeWidening({ ...current, producerProofs: undefined }, { ...current, plannedFiles: ['src/a.ts', 'src/b.ts'] }), true, 'unset and empty lists mean the same');
  const bootstrapped = { ...current, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'], bootstrap: { reason: 'harness', contractPaths: ['src/a.ts'], declaredBy: 'op', declaredAt: 't0', policyRevision: 1 } }] };
  const echoed = { ...bootstrapped, criteria: [{ proofs: ['unit:works'], id: 'AC-1', text: 'Works', bootstrap: { policyRevision: 1, declaredAt: 't0', declaredBy: 'op', contractPaths: ['src/a.ts'], reason: 'harness' } }], plannedFiles: ['src/a.ts', 'src/b.ts'] };
  assert.equal(liveScopeWidening(bootstrapped, echoed), true, 'a verbatim echo of the stored criteria, any key order, widens');
});

// GY-1293: three scope faults in one day, each the loop failing to carry one of its own scope steps
// to its end for a reason that judged nothing about scope. GY-1235's successor re-plan was posted
// from the snapshot the same cycle's partial widening had just outdated (409), and GY-1290's
// widening met a control-plane internal error the next cycle did not (500). The partial widening
// that outdated GY-1235's snapshot also kept its request from the approver, one companion hop per
// cycle, for 14 minutes. GY-1287's refused request never reached its approver at all: the loop's
// cursor holds its requirements decision failed at 10:07:18 and 10:13:55 because its decision
// history was read only when the decisions step reached it, past the step's read deadline, and the
// scope budget ran out at 10:17:19. Each test reproduces one instance as the ledger recorded it.

const clock = Date.parse('2030-01-03T12:00:00Z');
const iso = (offset = 0) => new Date(clock + offset).toISOString();
const config = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: join(tmpdir(), 'live-scope-fault-recurrence.token'), cliPath: join(process.cwd(), 'bin/graphyard.mjs'),
  repository: 'owner/scope-faults', baseBranch: 'main', githubAppId: 4242, hostId: 'loop-host', masterAgentName: 'graphyard-master-scope-faults', workers: [] }) as MasterConfig;

const lease = { epoch: 3, owner: 'worker', expiresAt: iso(600_000) };
const asked = iso(-300_000);
const refusedRequest = (paths: string[]) => ({ epoch: 3, paths, reason: 'The delivery change reaches these files', requestedBy: 'worker', at: asked,
  decision: { state: 'refused', reason: 'outside what the criteria imply', at: iso(-200_000), decidedBy: 'graphyard', waitedMs: 100_000, paths, requestedBy: 'worker', requestedAt: asked, epoch: 3 } });

function item(extra: Partial<Work> = {}): Work {
  return {
    id: '00000000-0000-4000-8000-000000001235', key: 'GY-1235', title: 'Remove the guarded merge', description: '', type: 'chore', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'GitHub merges are delivery', proofs: ['unit:github-merge-is-delivery'] }], policy: { checks: ['test'], review: true },
    plannedFiles: ['src/master/merge.ts', 'src/engine.ts'], stage: 'build', revision: 10, policyRevision: 2, createdAt: iso(-86_400_000), updatedAt: iso(-60_000),
    stageEnteredAt: iso(-3_600_000), ready: true, epoch: 3, lease, workspaces: [], submission: null, candidate: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [], gates: [], exclusiveResources: [], producerProofs: [],
    containmentQuarantine: { epoch: 3, owner: 'worker', at: iso(-3_600_000), settlementHash: 'e'.repeat(64), leaseExpiresAt: lease.expiresAt },
    ...extra,
  } as unknown as Work;
}

/** The refusal the loop's control-plane client throws: the status rides on the error, as `asOperatorAgent` sets it. */
const refused = (id: string, status: number, error: string) => new RefusedResponse(`Graphyard refused work/${id}/requirements (${status}): ${error}`, status, { error });

/**
 * The control plane's requirements command as far as these instances need it: a revision of the
 * current policy revision that only widens is applied under the live lease and quarantine; a stale
 * one is refused. `fail` answers the next posts with an error instead, as the plane did for GY-1290.
 */
function plane(initial: Work) {
  let current = structuredClone(initial);
  const posted: { via: string; expectedPolicyRevision: number; plannedFiles: string[] }[] = [];
  const fail: Error[] = [];
  const requirements = (via: string, revision: { expectedPolicyRevision: number; criteria: unknown[]; dependencies: readonly string[]; plannedFiles: readonly string[]; exclusiveResources?: readonly string[]; producerProofs?: readonly string[] }) => {
    posted.push({ via, expectedPolicyRevision: revision.expectedPolicyRevision, plannedFiles: [...revision.plannedFiles] });
    if (fail.length) throw fail.shift();
    if (revision.expectedPolicyRevision !== current.policyRevision) throw refused(current.id, 409, 'Policy revision changed; reload before revising');
    if (!liveScopeWidening({ criteria: current.criteria, dependencies: current.dependencies, plannedFiles: current.plannedFiles ?? [], exclusiveResources: current.exclusiveResources, producerProofs: current.producerProofs }, revision as never))
      throw refused(current.id, 409, 'Task is quarantined by unverified containment from epoch 3; requirements remain immutable until settlement or stopped-worker recovery');
    current = { ...current, plannedFiles: [...revision.plannedFiles], policyRevision: current.policyRevision + 1, revision: current.revision + 1 };
    return structuredClone(current);
  };
  return { posted, fail, read: () => structuredClone(current), requirements };
}

function effects(control: ReturnType<typeof plane>, overrides: Partial<DaemonEffects> = {}): DaemonEffects {
  return {
    agents: () => [], credentials: async () => ({}),
    snapshot: async () => ({ work: [control.read()], now: iso() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'no deployment in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    reviewFindings: async () => [],
    // Every requested path exists on the base; nothing reads their text, so only the rules decide.
    basePaths: async paths => new Set(paths),
    // The base renamed a planned file since the item was planned: src/master/merge.ts → src/merge/execute.ts.
    baseSuccessions: async () => ({ tip: 'f'.repeat(40), successions: [{ from: 'src/master/merge.ts', to: 'src/merge/execute.ts', commit: 'c'.repeat(40), similarity: 90 }], files: new Set(['src/merge/execute.ts']) }),
    widenScope: async (work, request, paths, reason) => control.requirements('widen', { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies,
      plannedFiles: [...new Set([...(work.plannedFiles ?? []), ...paths])], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], answers: { epoch: request.epoch, at: request.at }, reason } as never),
    replan: async (work, paths, reason) => control.requirements('replan', successorWidening(work, paths, reason)),
    ...overrides,
  } as DaemonEffects;
}

const scopeFaults = (state: DaemonState) => state.faults.instances.filter(instance => instance.kind === 'action:scope');
const cycle = (state: DaemonState, effect: DaemonEffects, at = clock) => runCycle(config(), state, effect, () => at);

test('manual:fault-class-scope — GY-1235: a successor re-plan in the cycle a partial widening moved the item reads the widened item, and is applied rather than refused', async () => {
  // The worker asked for a documentation page (which the item implies) and a file nothing grounds:
  // the finding rule widens by the page and leaves the file to the approver, moving the revision.
  const control = plane(item({ scopeRequest: refusedRequest(['docs/delivery.md', 'src/unrelated.ts']) } as Partial<Work>));
  const state = emptyDaemonState(config());
  await cycle(state, effects(control));

  const [widen, replan] = control.posted;
  assert.equal(widen?.via, 'widen');
  assert.ok(widen.plannedFiles.includes('docs/delivery.md') && !widen.plannedFiles.includes('src/unrelated.ts'), 'the partial widening grants only what the rules ground');
  assert.equal(replan?.via, 'replan', 'the successor step re-plans the item in the same cycle');
  // On the base the re-plan was posted from the snapshot: revision 2, without the page, and refused.
  assert.equal(replan.expectedPolicyRevision, 3, 'it is posted against the revision the widening made, not the snapshot\'s');
  assert.ok(replan.plannedFiles.includes('docs/delivery.md'), 'and keeps what the widening granted');
  assert.deepEqual(control.read().plannedFiles, ['src/master/merge.ts', 'src/engine.ts', 'docs/delivery.md', 'src/merge/execute.ts'], 'both revisions are applied');
  assert.ok(Object.values(state.actions).some(action => action.work === 'GY-1235' && action.state === 'done' && /^Re-planned GY-1235 with 1 file \(src\/merge\/execute\.ts\)/.test(action.detail)));
  assert.deepEqual(scopeFaults(state), [], 'no scope fault is noted');
});

test('manual:fault-class-scope — GY-1235: the rest of a partly widened request goes to the approver in the same cycle, and the findings are not read again while the approver judges it', async () => {
  const control = plane(item({ scopeRequest: refusedRequest(['docs/delivery.md', 'src/unrelated.ts']) } as Partial<Work>));
  const decided: { key: string; plannedFiles: string[]; expectedPolicyRevision?: number }[] = [];
  const effect = effects(control, {
    baseSuccessions: undefined, replan: undefined,
    decide: async (work, action, _reason, input = {}) => { decided.push({ key: work.key, plannedFiles: (input as { plannedFiles: string[] }).plannedFiles, expectedPolicyRevision: work.policyRevision }); assert.equal(action, 'requirements'); return { id: `decision-${decided.length}` }; },
    approver: async (work, decision) => ({ agentName: `approver-${work.key}-${decision}`, pane: 'pane-1' }),
    decisions: async () => ({ decisions: [] }),
  } as Partial<DaemonEffects>);
  const state = emptyDaemonState(config());
  await cycle(state, effect);
  // On the base the decision step read no judgement for the widened revision and asked no approver;
  // the next cycle read the findings again at that revision, so the approver waited cycle after cycle.
  assert.equal(control.posted.length, 1, 'one partial widening');
  assert.deepEqual(decided.map(entry => entry.key), ['GY-1235'], 'the approver is asked about the rest in the cycle that widened');
  assert.ok(decided[0].plannedFiles.includes('docs/delivery.md') && decided[0].plannedFiles.includes('src/unrelated.ts'), 'against the widened plannedFiles');
  assert.equal(decided[0].expectedPolicyRevision, 3);

  await cycle(state, effect, clock + 600_000);
  assert.equal(control.posted.length, 1, 'while the approver judges the rest, the findings are not read again and the revision does not move');
});

test('manual:fault-class-scope — GY-1290: a widening the control plane answers with an internal error is retried next cycle and noted as no scope fault; a second in a row is one', async () => {
  const control = plane(item({ key: 'GY-1290', scopeRequest: refusedRequest(['docs/delivery.md']) } as Partial<Work>));
  control.fail.push(refused(control.read().id, 500, 'Internal error; consult server logs'));
  const state = emptyDaemonState(config());
  const effect = effects(control, { baseSuccessions: undefined, replan: undefined, reviewFindings: async () => [], baseText: async () => null });
  await cycle(state, effect);
  const failed = Object.values(state.actions).find(action => action.work === 'GY-1290' && action.state === 'failed');
  assert.match(failed?.detail ?? '', /the control plane answered 5xx, so it is retried next cycle on a fresh read/);
  // On the base this failure opened an action:scope instance at once.
  assert.deepEqual(scopeFaults(state), [], 'one transient refusal is no scope fault');
  await cycle(state, effect, clock + 60_000);
  assert.deepEqual(control.read().plannedFiles, ['src/master/merge.ts', 'src/engine.ts', 'docs/delivery.md'], 'the next cycle widens it');
  assert.deepEqual(scopeFaults(state), []);

  // The plane failing the retry too is a fault the loop cannot clear on its own: it is counted.
  const again = plane(item({ key: 'GY-1290', scopeRequest: refusedRequest(['docs/delivery.md']) } as Partial<Work>));
  for (let n = 0; n < 2; n++) again.fail.push(refused(again.read().id, 500, 'Internal error; consult server logs'));
  const twice = emptyDaemonState(config());
  const failing = effects(again, { baseSuccessions: undefined, replan: undefined });
  await cycle(twice, failing);
  await cycle(twice, failing, clock + 60_000);
  assert.deepEqual(scopeFaults(twice).map(instance => [instance.kind, instance.subject]), [['action:scope', 'GY-1290']]);
});

test('manual:fault-class-scope — GY-1287: a refused scope request reaches its approver in the cycle it is judged, though slower history reads hold the decisions step past its deadline', async () => {
  // GY-1287 as the loop's cursor recorded it: plannedFiles empty, six paths the rule refused, no
  // finding grounding any. Another item's decision history answers slower than the step's read
  // deadline, and the loop keeps no history between cycles (no decision-ledger read answered), so
  // nothing read late is there for the next cycle. Cycles run five minutes apart, as they did.
  const paths = ['src/master/dispatch.ts', 'src/master.ts', 'src/model/session-state.ts', 'src/master/status.ts', 'src/daemon/state.ts', 'tests/session-liveness-launch-window.test.ts'];
  const asked1287 = iso(-150_000);
  const request = (epoch: number, at: string) => ({ epoch, paths, reason: 'AC-1 needs the launch window fixed', requestedBy: 'worker', at,
    decision: { state: 'refused', reason: 'outside what the criteria imply', at: iso(-10_000), decidedBy: 'graphyard', waitedMs: 140_000, paths, requestedBy: 'worker', requestedAt: at, epoch } });
  // The workers' supervisors renew their leases throughout, so each stays live past the scope budget.
  const criteria = [{ id: 'AC-1', text: 'The shared cause of the recurring faults is removed', proofs: ['manual:fault-class-session-liveness'] }];
  const renewed = (epoch: number) => ({ epoch, owner: 'worker', expiresAt: iso(3_600_000) });
  const slow = item({ id: '00000000-0000-4000-8000-000000001286', key: 'GY-1286', plannedFiles: [], policyRevision: 1, epoch: 2, lease: renewed(2), containmentQuarantine: null, scopeRequest: request(2, iso(-60_000)), criteria } as Partial<Work>);
  let target = item({ id: '00000000-0000-4000-8000-000000001287', key: 'GY-1287', plannedFiles: [], policyRevision: 1, epoch: 1, lease: renewed(1), containmentQuarantine: null, scopeRequest: request(1, asked1287), criteria } as Partial<Work>);
  const deadlineMs = 200;
  const decided: string[] = [], approvers: { name: string; pane_id: string; agent_status: string }[] = [];
  let at = clock;
  const effect = {
    agents: () => approvers, credentials: async () => ({}), snapshot: async () => ({ work: [structuredClone(slow), structuredClone(target)], now: new Date(at).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'no deployment in this test', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    reviewFindings: async () => [], basePaths: async (asked: string[]) => new Set(asked.filter(path => !path.startsWith('tests/'))), baseText: async () => 'export const unrelated = 1;\n', baseMentions: async () => 0,
    widenScope: async () => { throw new Error('no rule grounds any of these paths'); },
    decisionReadDeadlineMs: deadlineMs,
    // GY-1286's request stays with its approver; GY-1287's approver applies the widening at once.
    decisions: async (work: Work) => {
      await new Promise(resolve => setTimeout(resolve, work.key === 'GY-1286' ? 3 * deadlineMs : 5));
      return { decisions: decided.filter(key => key === work.key).map(key => ({ id: `decision-${key}`, action: 'requirements', state: key === 'GY-1287' ? 'applied' : 'requested', approvedAt: iso(), input: { answers: { epoch: work.epoch, at: key === 'GY-1287' ? asked1287 : work.scopeRequest?.at } }, approvedBy: key === 'GY-1287' ? 'approver' : null })) };
    },
    decide: async (work: Work, action: string) => {
      assert.equal(action, 'requirements');
      decided.push(work.key);
      if (work.key === 'GY-1287') target = { ...target, plannedFiles: [...paths], policyRevision: 2, scopeRequest: null, blocker: null,
        scopeDecision: { state: 'approved', reason: 'the approver granted it', at: new Date(at).toISOString(), decidedBy: 'approver', waitedMs: 0, paths, requestedBy: 'worker', requestedAt: asked1287, epoch: 1 } } as unknown as Work;
      return { id: `decision-${work.key}` };
    },
    approver: async (work: Work, decision: string) => { const name = approverSessionName(work, decision); approvers.push({ name, pane_id: `pane-${work.key}`, agent_status: 'working' }); return { agentName: name, pane: `pane-${work.key}` }; },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  // Every read a cycle started has answered before the next begins, as five minutes apart they had.
  for (const minutes of [0, 5, 10, 15]) { at = clock + minutes * 60_000; await cycle(state, effect, at); await new Promise(resolve => setTimeout(resolve, 4 * deadlineMs)); }

  // On the base the step read GY-1287's history only when it reached it, behind GY-1286's: it
  // missed the deadline every cycle, the request backed off, and at fifteen minutes the request
  // stood unanswered — the scope-request fault.
  assert.ok(decided.includes('GY-1287'), `GY-1287's request is put to its approver: ${JSON.stringify(Object.entries(state.actions).filter(([, action]) => action.work === 'GY-1287').map(([key, action]) => [key, action.state, action.detail.slice(0, 160)]))}`);
  assert.equal(decided.filter(key => key === 'GY-1287').length, 1, 'once');
  const owed = (key: string) => state.faults.instances.filter(instance => instance.subject === key && (instance.faultClass === 'scope' || instance.faultClass === 'decision')).map(instance => instance.kind);
  assert.deepEqual(owed('GY-1287'), [], 'neither a scope-request nor a decision fault opens for it');

  // GY-1286's history never answers in time: its request is asked again every cycle, not on the
  // widening backoff, and only the second late read in a row is a decision fault.
  const slowRow = Object.entries(state.actions).find(([key, action]) => action.work === 'GY-1286' && key.startsWith('decision:'))?.[1];
  assert.ok(slowRow && lateDecisionRead(slowRow.detail), slowRow?.detail);
  assert.equal(slowRow.attempts, 4, 'asked on each of the four cycles');
  assert.deepEqual(owed('GY-1286'), ['action:decision', 'scope-request'], 'and once its request stands past the scope budget, that is a scope fault');
});

test('unit:transient-scope-refusal — only a 5xx response or a stale revision is transient; a refusal that judged the scope always counts', () => {
  assert.equal(transientScopeRefusal(refused('x', 500, 'Internal error; consult server logs')), 'the control plane answered 5xx');
  assert.equal(transientScopeRefusal(refused('x', 502, 'Application failed to respond')), 'the control plane answered 5xx');
  // The status is read from the response, not the text: a message merely quoting a 5xx is no 5xx.
  assert.equal(transientScopeRefusal(new Error('Graphyard refused work/x/requirements (500): Internal error; consult server logs')), null);
  assert.equal(transientScopeRefusal(refused('x', 409, 'Policy revision changed; reload before revising')), 'the item moved past the revision the loop read');
  assert.equal(transientScopeRefusal(refused('x', 409, 'Task is quarantined by unverified containment from epoch 3; requirements remain immutable until settlement or stopped-worker recovery')), null);
  assert.equal(transientScopeRefusal(refused('x', 409, 'Operator agents cannot remove planned-file containment')), null);
  assert.equal(scopeRefusalFault('the control plane answered 5xx', undefined), null);
  assert.equal(scopeRefusalFault('the control plane answered 5xx', { state: 'failed', detail: 'Could not widen GY-1 (the control plane answered 5xx, so it is retried next cycle on a fresh read): …' }), undefined);
  assert.equal(scopeRefusalFault(null, undefined), undefined);
});
