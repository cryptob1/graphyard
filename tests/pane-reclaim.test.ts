import { test } from 'node:test';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { agentlessPaneAttentionBound, paneReclaimStatus } from '../src/master-resources.js';
import { daemonEffects } from '../src/daemon/effects.js';
import { bindReviewer, launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { launchProducer } from '../src/producer.js';
import { dispatchWork, launchApprover, launchEscalationHandler, loadMasterConfig, saveProducerProfile, setupMaster, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { launchedSessionHandle } from '../src/auto-dispatch.js';
import { registeredLaunch } from '../src/model/session-state.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import type { SessionHandle } from '../src/model/sessions.js';
import type { Work } from '../src/model.js';

// GY-842: every pane Graphyard launches is closed when its session ends, and leftover agentless
// panes are reclaimed. 2026-09-26: Herdr held 621 panes, 584 of them Graphyard's with no agent —
// sessions were closed in the ledger ('vanished', 'closed by the loop') while their panes stood
// on as bare shells — and the host throttled under them.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clockStart = Date.parse('2030-01-01T00:00:00Z');
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('head'), B = sha40('base');
const worktrees = '/repo/.graphyard/worktrees';
const limitNotice = 'Error: weekly usage limit reached. Your usage resets at 17:00.';
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const producerVerify = async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*'] } });
const reviewerVerify = async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const profile = (name: string, principal: string, agentName: string): WorkerProfile =>
  ({ name, principal, agentName, mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', agentArgs: [], environment: {}, approvals: 'auto' }) as WorkerProfile;

/** A session handle with the fields the loop reads; the rest is the schema's business, not these tests'. */
const handle = (overrides: Partial<SessionHandle> & Pick<SessionHandle, 'id' | 'kind'>): SessionHandle => ({
  principal: 'worker-a', epoch: null, runtime: 'claude', host: 'machine-a', workspace: null, tab: null, pane: null, agentName: null, role: null, head: null,
  attach: null, transcript: null, subject: 'session', startedAt: new Date(clockStart - 600_000).toISOString(), updatedAt: new Date(clockStart - 600_000).toISOString(),
  endedAt: null, state: 'running', outcome: null, ...overrides,
});

function item(key: string, overrides: Partial<Work> = {}, sessions: SessionHandle[] = []): Work {
  return {
    id: `work-${key}`, key, title: 'Panes are reclaimed', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Closed', proofs: ['unit:pane-reclaimed'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'review', revision: 4, policyRevision: 1, createdAt: new Date(clockStart - 7_200_000).toISOString(), updatedAt: new Date(clockStart).toISOString(),
    stageEnteredAt: new Date(clockStart - 3_600_000).toISOString(), ready: true, epoch: 4,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides, sessions,
  } as unknown as Work;
}

/** A candidate whose independent review is required, as the control plane reports one (GY-127's shape). */
function reviewCandidate(key: string): Work {
  const candidate = { sha: H, baseSha: B, pr: 127, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return item(key, {
    stage: 'review', candidate, submission: { epoch: 1, pr: 127 } as Work['submission'],
    plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true, reviewProvider: 'github' } as Work['policy'],
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [],
      at: new Date(clockStart).toISOString(), prState: 'open', draft: false, baseTip: B, baseTree: sha40('tree'), baseTipContained: true } as Work['observation'],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }],
  });
}

/**
 * The part of Herdr the launchers and the loop speak to, against an in-memory pane registry. A
 * runtime that exits leaves its pane behind as a bare shell: `exit` removes the agent from the
 * inventory while the pane stays in `pane list` until something closes it. Every `pane close`
 * invocation is logged, whatever it closes and however often — nothing here deduplicates — and a
 * close of a pane that is already gone answers `pane_not_found`, as Herdr does.
 */
class HerdrStub {
  /** The live agent sessions: name → its pane, what runs in it, and its status. */
  agents = new Map<string, { pane: string; kind: string; status: string }>();
  /** What each pane runs, from the typed launch until the runtime is named (or exits). */
  occupants = new Map<string, string>();
  /** Every pane the runtime holds, with or without an agent in it. */
  panes = new Set<string>();
  /** Every close invocation, in order, without deduplication: the exactly-once record. */
  closes: string[] = [];
  /** Sessions stopped on a provider notice: `agent read` answers with their screen. */
  notices = new Map<string, string>();
  created = 0;
  run = (_command: string, args: string[]): string => {
    assert.equal(_command, 'herdr', `only Herdr is run here: ${_command} ${args.join(' ')}`);
    const ok = (result: unknown = {}) => JSON.stringify({ result });
    const [noun, verb] = args;
    if (noun === 'tab' && verb === 'create') { const pane = `pane-${++this.created}`; this.panes.add(pane); return ok({ root_pane: { pane_id: pane, tab_id: `tab-${this.created}` } }); }
    if (noun === 'pane' && verb === 'run') { this.occupants.set(args[2], 'claude'); return ''; }
    if (noun === 'pane' && verb === 'read') return '';
    if (noun === 'agent' && verb === 'get') {
      const named = [...this.agents.entries()].find(([, entry]) => entry.pane === args[2]);
      const kind = named?.[1].kind ?? this.occupants.get(args[2]);
      return kind ? ok({ agent: { agent: kind, agent_status: named ? named[1].status : 'working', pane_id: args[2] } }) : JSON.stringify({ error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` } });
    }
    if (noun === 'agent' && verb === 'rename') { this.occupants.delete(args[2]); this.agents.set(args[3], { pane: args[2], kind: 'claude', status: 'working' }); return ok({ agent: { agent: 'claude', agent_status: 'working', name: args[3] } }); }
    if (noun === 'agent' && verb === 'prompt') return ok();
    if (noun === 'agent' && verb === 'read') return this.notices.get(args[2]) ?? '';
    if (noun === 'agent' && verb === 'list') {
      const live: HerdrAgent[] = [...this.agents.entries()].map(([name, entry]) => ({ name, pane_id: entry.pane, agent: entry.kind, agent_status: entry.status }));
      // A pane whose runtime has exited is still this host's pane: Herdr lists it with no agent in it.
      const shells: HerdrAgent[] = [...this.panes].filter(pane => ![...this.agents.values()].some(entry => entry.pane === pane))
        .map(pane => ({ pane_id: pane, agent: null, agent_status: 'unknown' }));
      return ok({ agents: [...live, ...shells] });
    }
    if (noun === 'pane' && verb === 'list') return ok({ panes: [...this.panes].map(pane_id => ({ pane_id })) });
    if (noun === 'pane' && verb === 'close') {
      this.closes.push(args[2]);
      if (!this.panes.has(args[2])) return JSON.stringify({ error: { code: 'pane_not_found', message: `pane ${args[2]} not found` } });
      this.panes.delete(args[2]);
      this.occupants.delete(args[2]);
      for (const [name, entry] of [...this.agents]) if (entry.pane === args[2]) this.agents.delete(name);
      return ok();
    }
    throw new Error(`the simulated Herdr has no ${args.slice(0, 2).join(' ')}`);
  };
  /** A runtime stops on its provider's notice: the session stays listed, idle, with the notice on its screen. */
  stopOnNotice(name: string, notice = limitNotice) { const entry = this.agents.get(name); assert.ok(entry, `${name} is listed`); entry.status = 'idle'; this.notices.set(name, notice); }
  /** A runtime exits: the agent is gone from the inventory, its pane stays behind as a bare shell. */
  exit(name: string) { const entry = this.agents.get(name); assert.ok(entry, `${name} is listed`); this.agents.delete(name); }
}

/** A master installed for real launches: the reviewer App bound, reviewer, producer, worker, approver and operator-agent profiles on record. */
async function launchedMaster() {
  const root = await temporaryDirectory('pane-reclaim'), credentials = await temporaryDirectory('pane-reclaim-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=graphyard@example', '-c', 'user.name=graphyard', 'commit', '--allow-empty', '-m', 'init'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, reviewerVerify);
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  const tokenFile = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  await saveProducerProfile(root, { name: 'claude-producer', principal: 'proof-runner', agentName: 'produce-claude-1', kind: 'claude', credentialFile: await tokenFile('producer'), concurrency: 1 }, producerVerify);
  const config = await loadMasterConfig(root);
  const [workerToken, approverToken, operatorToken] = await Promise.all([tokenFile('worker'), tokenFile('approver'), tokenFile('operator')]);
  const enriched = {
    ...config,
    workers: [{ ...profile('claude-primary', 'worker-a', 'graphyard-claude-1'), credentialFile: workerToken }],
    approver: { id: 'graphyard-approver', credentialFile: approverToken },
    operatorAgent: { id: 'graphyard-master-operator', credentialFile: operatorToken },
  } as MasterConfig;
  // The launchers each load the master file themselves, so the roles' identities are persisted.
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(enriched), { mode: 0o600 });
  return { root, credentials, config: enriched, cleanup: async () => {} };
}

test('unit:session-end-closes-pane — one session of every pane-opening role is launched, registered, ended by the loop, and its pane closes in the same step, exactly once', async () => {
  const { root, config, cleanup } = await launchedMaster();
  const herdr = new HerdrStub();
  try {
    // The control plane's own side of a launch: a session write lands on the item's handles, the
    // way POST work/ID/session does, stamped with the time the plane read it.
    let clock = clockStart;
    const iso = () => new Date(clock).toISOString();
    const items: Work[] = [
      // The worker: claimable, so the cycle's own dispatch step launches it for real (dispatchWork).
      item('GY-1', { stage: 'ready', epoch: 0, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] }),
      // The reviewer and the producer: candidate shapes whose requests the loop's ledger holds.
      reviewCandidate('GY-2'),
      (() => { const producer = reviewCandidate('GY-3'); producer.criteria = [{ id: 'AC-1', text: 'Proven', proofs: ['unit:producer-launch'] }]; reconcileAutoDispatch(producer, [producer], new Date(clockStart)); return producer; })(),
      // The escalation handler's item: open, with the standing escalation its context carries.
      item('GY-4', { stage: 'review', ready: false, escalation: { trigger: 'review-unavailable', reason: 'no reviewer could be launched', at: iso(), actor: 'graphyard' } as never }),
      // The approver's item: delivered, so the loop closes the approver still judging it.
      item('GY-5', { stage: 'done', stageEnteredAt: iso() }),
    ];
    const find = (key: string) => items.find(candidate => candidate.key === key)!;
    const record: ((path: string, data: unknown) => Promise<unknown>) = async (path, data) => {
      const match = /^work\/([^/]+)\/(session|capacity)$/.exec(path);
      assert.ok(match, `the plane answers session and capacity writes only: ${path}`);
      if (match[2] === 'capacity') return find('GY-2');
      const written = data as Partial<SessionHandle> & { id: string; state: string };
      const target = items.find(candidate => candidate.id === match[1]);
      assert.ok(target, `the written session names known work: ${match[1]}`);
      const existing = (target.sessions ?? []).findIndex(entry => entry.id === written.id);
      if (existing >= 0) target.sessions![existing] = { ...target.sessions![existing], ...written, updatedAt: iso() } as SessionHandle;
      else target.sessions = [...(target.sessions ?? []), { host: config.hostId, startedAt: iso(), updatedAt: iso(), ...written } as SessionHandle];
      return target;
    };
    // The loop's own session effects, wired to the simulated Herdr: the launch ledgers, the ends,
    // the pane closes and the inventories are the real ones.
    const wired = daemonEffects(root, config, {
      snapshot: async () => ({ work: items.map(entry => ({ ...entry, sessions: [...(entry.sessions ?? [])] })), now: iso() }),
      mutate: record as never,
      executor: { principal: 'graphyard-master', instance: 'pane-reclaim' },
      run: herdr.run,
    });
    // The plane's merge and plane-health answers: no candidate here is ever merged, the dispatch
    // hold reads as healthy, and the worker launch is the real dispatchWork claiming into a real
    // git worktree the way prepareWorkerLaunch claims.
    const prepare = async (): Promise<{ epoch: number; path: string; base: string; branch: string }> => {
      const target = find('GY-1'), epoch = target.epoch + 1, branch = `graphyard/gy-1-${epoch}`, path = join(root, `worker-tree-${epoch}`);
      execFileSync('git', ['worktree', 'add', '-q', path, '-b', branch], { cwd: root });
      Object.assign(target, { epoch, lease: { owner: 'worker-a', epoch, expiresAt: new Date(clock + 30 * 60_000).toISOString() },
        lastAssignment: { owner: 'worker-a', epoch, claimedAt: iso() },
        workspaces: [{ host: config.hostId, path, branch, epoch, owner: 'worker-a' }] });
      return { epoch, path, base: config.baseBranch, branch };
    };
    const plane: Partial<DaemonEffects> = {
      merge: async () => ({ result: 'merged', merged: true }),
      planeHealth: async () => null,
      dispatch: async (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, herdr.run, snapshot.work, prepare, undefined, undefined, snapshot.now),
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {}, requestProof: () => {}, persist: async () => {},
      // A loop wired without the relaunch ends the stopped session and lets the request's next
      // attempt be dispatched: the end, and its pane close, are the behaviour under test.
      relaunch: undefined,
      decisions: async item => ({ decisions: (item.autoDispatch?.history ?? []).map(entry => ({ id: entry.id, action: 'review', state: 'requested', input: null, approvedBy: null, precedent: [] })) }),
    };
    const effects = { ...wired, ...plane } as DaemonEffects;
    const state: DaemonState = emptyDaemonState(config);

    // ---- The launches: one per pane-opening role, each through its real launcher. ----
    // The reviewer: launched by hand (no request id, so no relaunch follows the end), registered
    // like every launch through registeredLaunch with the plane as its recorder.
    {
      const item = find('GY-2');
      const request = { id: 'review-request', kind: 'review' as const, sha: H, baseSha: B, policyRevision: 1, pr: 127, requestedAt: iso(), reason: 'review', state: 'requested' as const };
      const attach = (pane: string) => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`;
      await registeredLaunch(handle => record(`work/${item.id}/session`, handle), launchedSessionHandle('review', request as never, `${item.key}: review ${H.slice(0, 12)}`, config.hostId, undefined, 'claude', config.herdrWorkspace), () =>
        launchReview(root, item, 'claude-reviewer', [], iso(), { run: herdr.run, mint: async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(clock + 3_500_000).toISOString() }) }), undefined, attach);
    }
    // The producer: the request the item's autoDispatch holds, launched like the dispatcher launches it.
    {
      const item = find('GY-3'), request = item.autoDispatch!.producers[0];
      const attach = (pane: string) => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`;
      await registeredLaunch(handle => record(`work/${item.id}/session`, handle), launchedSessionHandle('proof', request, `${item.key}: ${request.group} proofs on ${H.slice(0, 12)}`, config.hostId, undefined, 'claude', config.herdrWorkspace, config.producers[0].principal), () =>
        launchProducer(root, item, request, config.producers[0], [], iso(), { run: herdr.run }), undefined, attach);
    }
    // The approver: the launcher a master's `graphyard master approver` runs, registered on the item.
    const decision = 'dec-approver-1';
    const approver = await launchApprover(root, find('GY-5'), decision, 'claude', { agents: await wired.agents(), available: true }, herdr.run, {}, handle => record(`work/${find('GY-5').id}/session`, handle));
    // The escalation handler: the launcher `graphyard master escalation` runs, registered like every launch.
    const escalation = { trigger: 'review-unavailable', reason: 'no reviewer could be launched', at: iso(), actor: 'graphyard' };
    const handler = await launchEscalationHandler(root, config, {
      version: 1, repository: config.repository, key: 'GY-4', action: 'resolve' as const, escalation,
      rules: { source: { path: 'AGENTS.md', ref: 'main', sha: null }, text: null, unavailable: null, policy: find('GY-4').policy },
      goals: { priority: 0, intents: [], graph: [], graphOmitted: [], dependencies: [], dependents: [] },
      item: { key: 'GY-4', title: 'Panes are reclaimed', type: 'bug', description: '', stage: 'review', ready: false, revision: 4, policyRevision: 1, epoch: 4, createdAt: iso(),
        criteria: find('GY-4').criteria, retiredCriterionIds: [], plannedFiles: [], producerProofs: [], exclusiveResources: [], dependencies: [],
        refusal: { escalation, standing: [escalation], gates: [], blocker: null, violations: [] },
        candidate: null, submission: null, lease: null, implementers: [], history: { total: 0, kinds: [], recent: [], omitted: 0 } },
      precedent: { action: 'resolve' as const, total: 0, matching: 0, detail: [], summary: [], omitted: 0 },
      budget: { limit: 32_000, level: { recent: 40, detail: 20 }, exceeded: null, assembled: null, omitted: [] },
      fingerprint: 'f'.repeat(64),
    } as never, 'claude', [], herdr.run, handle => record(`work/${find('GY-4').id}/session`, handle));

    // Every launch opened one pane and registered it on its item before the runtime started.
    const workerProfile = config.workers[0];
    assert.deepEqual([...herdr.panes].length, 4, `four panes stand before the cycle: ${[...herdr.panes].join(', ')}`);
    for (const [key, name] of [['GY-2', 'review-claude-1'], ['GY-3', 'produce-claude-1'], ['GY-5', approver.agentName], ['GY-4', handler.agentName]] as const) {
      const sessions = find(key).sessions ?? [];
      assert.equal(sessions.filter(entry => entry.pane).length, 1, `${key}: the launch registered its pane on the item`);
      assert.equal(sessions[0].host, config.hostId, `${key}: the handle names this host`);
      assert.ok(herdr.agents.has(name), `${key}: the runtime ${name} runs in Herdr`);
    }
    // The registration is written before the runtime starts (GY-172): every handle above was
    // registered with state 'running' and no pane, and the pane written once the runtime was up.
    for (const key of ['GY-2', 'GY-3', 'GY-4', 'GY-5']) {
      const sessions = find(key).sessions ?? [];
      assert.ok(sessions[0].pane, `${key}: the launch coordinated its pane onto the registered handle`);
      assert.match(sessions[0].attach ?? '', /^herdr pane attach /, `${key}: the handle carries the attach command`);
    }

    // ---- Cycle 1: the loop dispatches the worker itself, launching its session like every role's. ----
    const first = await runCycle(config, state, effects, () => clock);
    const worker = find('GY-1');
    assert.ok(worker.lease, 'the dispatch claimed the worker item');
    assert.equal((worker.sessions ?? []).filter(entry => entry.pane).length, 1, 'the worker launch registered its pane on the item');
    assert.equal(worker.sessions![0].kind, 'implementation', 'the worker session is the implementation handle');
    assert.equal((worker.sessions![0].host), config.hostId, 'the worker handle names this host');
    assert.equal(herdr.panes.size, 4, 'the approver pane is gone; the other four stand');
    // The approver's item is delivered, so this same cycle closed its approver: the pane went with
    // the end, on the record, and nothing else was closed while every other session ran.
    assert.deepEqual(herdr.closes, [approver.pane], 'the delivered item\'s approver pane is closed by the loop, and nothing else');
    assert.ok(Object.values(state.actions).some(action => action.kind === 'close' && /Closed approver session/.test(action.detail)), 'the approver close is on the record');
    assert.equal((find('GY-5').sessions ?? [])[0]?.state, 'finished', 'the approver handle ends with the close');

    // ---- The ends: each remaining session ends the way the loop ends one, and the pane goes with it. ----
    clock += 10 * 60_000;
    // The worker's runtime has exited (Herdr detects no agent in its pane) and its item left build.
    herdr.exit(workerProfile.agentName);
    Object.assign(worker, { stage: 'review', lease: null, stageEnteredAt: iso() });
    // The reviewer and producer stopped on their provider's limit notice.
    herdr.stopOnNotice('review-claude-1'); herdr.stopOnNotice('produce-claude-1');
    // The escalation handler's runtime exited without judging.
    herdr.exit(handler.agentName);
    await runCycle(config, state, effects, () => clock);
    const ended = herdr.closes.slice();
    assert.equal(new Set(ended).size, 5, `five panes were closed: ${ended.join(', ')}`);
    assert.equal(ended.length, 5, 'each pane was closed exactly once, with no duplicate close invocation');
    // The worker's close is the loop's 1g step, recorded with the pane named, and its handle says finished.
    const actions = Object.values(state.actions);
    assert.ok(actions.some(action => action.kind === 'close' && action.state === 'done' && /Closed implementation session .*pane .*\bclosed\b/.test(action.detail)),
      `the implementation session is closed by the loop with its pane (${actions.filter(entry => entry.kind === 'close').map(entry => entry.detail).join(' | ')})`);
    assert.equal(find('GY-1').sessions![0].state, 'finished', 'the worker handle ends with the close');
    assert.match(find('GY-1').sessions![0].outcome!, /closed by the loop: .*pane \S+ closed/);
    // The reviewer and producer were ended on their ledgers by the same step that closed their panes.
    assert.equal(herdr.agents.has('review-claude-1'), false, 'the reviewer session is gone');
    assert.equal(herdr.agents.has('produce-claude-1'), false, 'the producer session is gone');
    // The approver: its item is delivered, so the loop closed it and registered the close.
    assert.ok(actions.some(action => action.kind === 'close' && /Closed approver session/.test(action.detail)), 'the approver close is on the record');
    // The escalation handler was ended like a spent one, its record dropped.
    assert.ok(actions.some(action => action.kind === 'close' && /Ended escalation handler/.test(action.detail)), 'the escalation handler close is on the record');

    // ---- Subsequent cycles: no pane is closed again, and the sweep closes nothing. ----
    for (let pass = 0; pass < 2; pass++) { clock += 60_000; await runCycle(config, state, effects, () => clock); }
    assert.deepEqual(herdr.closes, ended, 'no subsequent cycle closes a pane again');
    assert.equal(herdr.panes.size, 0, 'no pane is left standing');
    assert.ok(!Object.keys(state.actions).some(key => key.startsWith('sweep:pane:')), 'the backstop sweep closes nothing a session-end step did not leave behind');
    // Research and triage runs open no pane at all — they are headless (src/runner/registry.ts) —
    // so they have none to register and none to close: no handle here names any pane but the six.
    assert.deepEqual(items.flatMap(entry => (entry.sessions ?? []).map(session => session.pane)).filter(Boolean).length, 5, 'five launches, five panes, and none for the headless runs');
  } finally { await cleanup(); }
});

test('unit:agentless-pane-sweep — the sweep closes only the agentless panes Graphyard launched on this host whose session ended or whose worktree is gone, bounded per pass, and records the drain', async () => {
  const { root, credentials, config, cleanup } = await launchedMaster();
  try {
    const local = config.hostId;
    const live = { owner: 'worker-a', epoch: 3, expiresAt: new Date(clockStart + 450_000).toISOString() } as Work['lease'];
    const bulk = Array.from({ length: 8 }, (_, index) =>
      item(`GY-${10 + index}`, {}, [handle({ id: `rev-bulk-${index}`, kind: 'review', pane: `pane-bulk-${index}`, host: local, state: 'finished' })]));
    // A remote host's finished handle that names this host's foreign pane coordinate: the map that
    // matches recorded panes is local, so this must never make the operator's own shell closable,
    // nor count it as a launch of this host's.
    const remoteCollision = item('GY-9', {}, [handle({ id: 'remote-1', kind: 'review', pane: 'pane-foreign', host: 'machine-b', state: 'finished' })]);
    const work = [
      // Launched and ended: a review session whose record is finished and whose pane holds a bare shell.
      item('GY-1', {}, [handle({ id: 'rev-1', kind: 'review', pane: 'pane-ended', host: local, state: 'finished' })]),
      // Live: the pane stands in the worktree of GY-2's live lease — it is that lease's, never the sweep's.
      item('GY-2', { stage: 'build', lease: live }, [handle({ id: 'worker-a:2', kind: 'implementation', principal: 'worker-a', epoch: 2, host: local, state: 'finished', pane: 'pane-live-lease' })]),
      // Its worktree no longer exists, while its session record still says running: closable all the same.
      item('GY-3', { stage: 'build' }, [handle({ id: 'proof-1', kind: 'proof', pane: 'pane-deleted', host: local })]),
      // Fresh: its runtime is still on screen in the first cycle and only exits before the second.
      item('GY-4', {}, [handle({ id: 'rev-2', kind: 'review', pane: 'pane-fresh', host: local, state: 'finished' })]),
      // A finished session whose pane still holds its agent (idle at a prompt): never the sweep's.
      item('GY-5', {}, [handle({ id: 'rev-3', kind: 'review', pane: 'pane-live-agent', host: local, state: 'finished' })]),
      remoteCollision,
      ...bulk,
    ];
    const agentsAt = (freshAgentless: boolean): HerdrAgent[] => [
      { name: 'graphyard-reviewer-0', pane_id: 'pane-ended', agent_status: 'unknown', cwd: `${worktrees}/GY-1-4` },
      { name: 'graphyard-cursor-1', pane_id: 'pane-live-lease', agent_status: 'unknown', cwd: `${worktrees}/GY-2-3` },
      { name: 'graphyard-producer-1', pane_id: 'pane-deleted', agent_status: 'unknown', cwd: `${worktrees}/GY-3-1 (deleted)` },
      { name: 'graphyard-reviewer-3', pane_id: 'pane-live-agent', agent: 'claude', agent_status: 'idle', cwd: `${worktrees}/GY-5-4` },
      // A pane Graphyard never launched: the operator's own shell. Never recorded here, never closed.
      { name: 'operator-shell', pane_id: 'pane-foreign', agent_status: 'unknown', cwd: '/home/vish' },
      ...bulk.map((_, index) => ({ name: `graphyard-reviewer-${10 + index}`, pane_id: `pane-bulk-${index}`, agent_status: 'unknown', cwd: `${worktrees}/GY-${10 + index}-1` })),
      freshAgentless ? { name: 'graphyard-reviewer-2', pane_id: 'pane-fresh', agent_status: 'unknown', cwd: `${worktrees}/GY-4-4` }
        : { name: 'graphyard-reviewer-2', pane_id: 'pane-fresh', agent: 'codex', agent_status: 'working', cwd: `${worktrees}/GY-4-4` },
    ];
    const standing = ['pane-ended', 'pane-live-lease', 'pane-deleted', 'pane-fresh', 'pane-live-agent', 'pane-foreign', ...bulk.map((_, index) => `pane-bulk-${index}`)];
    const closed: string[] = [];
    // The inventory is the host's truth: a pane that was closed no longer stands.
    const panesEffect: Partial<DaemonEffects> = { panes: async () => ({ panes: standing.filter(pane => !closed.includes(pane)).map(pane => ({ pane_id: pane })), available: true }) };
    const base = (agents: HerdrAgent[], at: number): DaemonEffects => ({
      agents: () => agents,
      credentials: async () => ({}),
      snapshot: async () => ({ work: work.map(entry => ({ ...entry })), now: new Date(at).toISOString() }),
      closeSession: pane => { closed.push(pane); },
      herdr: async () => ({ agents, available: true }),
      persist: async () => {}, recordSession: async () => {}, dispatch: async () => {}, requestProof: () => {},
      merge: async () => ({ result: 'merged', merged: true }),
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(at).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
      recordDeployment: async () => {}, requestSmoke: () => {},
      ...panesEffect,
    } as DaemonEffects);
    const state = emptyDaemonState(config);
    // First sighting: a runtime that has not started yet looks the same, so nothing closes.
    await runCycle(config, state, base(agentsAt(false), clockStart), () => clockStart);
    assert.equal(closed.length, 0, 'an agentless launched pane is not closed on first sight');
    // Inside the launch bound nothing closes yet.
    await runCycle(config, state, base(agentsAt(false), clockStart + 60_000), () => clockStart + 60_000);
    assert.equal(closed.length, 0, 'nothing closes within the launch bound of its sighting');
    // The fresh pane's runtime exits now: its own bound starts here.
    await runCycle(config, state, base(agentsAt(true), clockStart + 130_000), () => clockStart + 130_000);
    assert.equal(closed.length, 0, 'nor has the fresh pane stood agentless past it');
    await runCycle(config, state, base(agentsAt(true), clockStart + 260_000), () => clockStart + 260_000);
    const firstPass: string[] = [...closed];
    assert.ok(firstPass.includes('pane-ended') && firstPass.includes('pane-deleted'), 'the ended launched panes close');
    assert.equal(firstPass.length, 6, 'the pass is bounded at six closes');
    assert.ok(!firstPass.includes('pane-fresh'), 'the fresh pane was only just seen agentless');
    assert.ok(!firstPass.includes('pane-live-lease') && !firstPass.includes('pane-live-agent') && !firstPass.includes('pane-foreign'),
      'a pane whose worktree holds a live lease, a pane with an agent, and a pane Graphyard did not launch never close');
    // The rest of the backlog drains on the next cycle, the fresh pane with it.
    await runCycle(config, state, base(agentsAt(true), clockStart + 390_000), () => clockStart + 390_000);
    assert.deepEqual(closed.filter(pane => pane === 'pane-ended').length, 1, 'a pane is closed exactly once');
    assert.deepEqual([...new Set(closed)].sort(), standing.filter(pane => !['pane-live-lease', 'pane-live-agent', 'pane-foreign'].includes(pane)).sort(),
      'every ended launched pane closes across passes, and nothing else ever does while its reason stands');
    // The live lease has lapsed by now, so its pane stopped being protected: the lease, not the
    // pane, was the protection. It was first seen agentless only now its lease is gone, so this
    // pass starts its bound and the next one takes it, like any first sighting.
    await runCycle(config, state, base(agentsAt(true), clockStart + 520_000), () => clockStart + 520_000);
    assert.ok(!closed.includes('pane-live-lease'), 'the lapsed pane was first seen agentless only now: its own bound starts');
    await runCycle(config, state, base(agentsAt(true), clockStart + 650_000), () => clockStart + 650_000);
    // A pending close request the cycle left standing is resumed as interrupted, which restarts
    // its bound: one more pass takes it, and the drain lands on the record with it.
    assert.ok(!closed.includes('pane-live-lease'), 'the resumed close request stands its bound again');
    await runCycle(config, state, base(agentsAt(true), clockStart + 780_000), () => clockStart + 780_000);
    assert.ok(closed.includes('pane-live-lease'), 'the pane whose lease lapsed is closable: the lease, not the pane, was the protection');
    const status = state.actions['sweep:panes:status'];
    assert.ok(status, 'the sweep records what the host holds');
    assert.match(status!.detail, /Herdr reports 2 pane\(s\) on this host, 13 opened by Graphyard launch\(es\), 0 standing agentless; the backlog has drained/,
      `the drained status is the one that stands (${status?.detail})`);
    assert.doesNotMatch(status!.detail, /the oldest is pane/, 'no oldest pane outlives the drain');
    assert.ok(!state.actions['sweep:panes:attention'], 'no attention under the bound');
    // A close that never happened cannot have been recorded: the cursor holds one close per pane.
    assert.equal(Object.keys(state.actions).filter(key => key.startsWith('sweep:pane:') && state.actions[key].state === 'done').length, 12, 'twelve sweep closes stand on the cursor');
  } finally { await cleanup(); }
});

test('unit:pane-count-attention — master status counts the host\'s panes, the agentless Graphyard ones and the oldest, and raises attention past twenty', () => {
  const host = 'machine-a';
  const paneList = (count: number) => [
    ...Array.from({ length: 22 }, (_, index) => ({ pane_id: `pane-a-${index}` })),
    { pane_id: 'pane-live' },
    ...Array.from({ length: Math.max(0, count - 23) }, (_, index) => ({ pane_id: `pane-foreign-${index}` })),
  ];
  const recorded = (agentless: number, withAgent: number, closed: number) => {
    const items: Work[] = [];
    for (let index = 0; index < agentless; index++) items.push(item(`GY-A${index}`, {}, [handle({ id: `h-a${index}`, kind: 'review', pane: `pane-a-${index}`, host, startedAt: new Date(clockStart - 3_600_000 + index * 1_000).toISOString() })]));
    for (let index = 0; index < withAgent; index++) items.push(item(`GY-B${index}`, {}, [handle({ id: `h-b${index}`, kind: 'proof', pane: 'pane-live', host })]));
    for (let index = 0; index < closed; index++) items.push(item(`GY-C${index}`, {}, [handle({ id: `h-c${index}`, kind: 'review', pane: `gone-${index}`, host })]));
    return items;
  };
  const agents = [{ name: 'graphyard-reviewer-x', pane_id: 'pane-live', agent: 'claude', agent_status: 'idle' }, { name: 'operator-shell', pane_id: 'pane-foreign-99', agent_status: 'unknown' }];

  // The counts: every pane the host reports, the ones Graphyard launched, the agentless among
  // them, and the oldest by the launch its session recorded. A pane Graphyard never launched, and
  // a recorded pane the runtime no longer holds, count for neither.
  const below = paneReclaimStatus(paneList(30), recorded(18, 1, 2), agents, clockStart, host);
  assert.deepEqual({ panes: below.panes, launched: below.launched, agentless: below.agentless }, { panes: 30, launched: 21, agentless: 18 });
  assert.deepEqual(below.oldest, { pane: 'pane-a-0', work: 'GY-A0', kind: 'review', launchedAt: new Date(clockStart - 3_600_000).toISOString() });
  assert.equal(below.attention, null, 'no attention under the bound');

  // The reading is this host's: handles another host recorded are not this host's launches, so a
  // remote handle naming a local pane coordinate counts for neither launched nor agentless here.
  const remote = recorded(18, 1, 2).concat([item('GY-R1', {}, [handle({ id: 'r-1', kind: 'review', pane: 'pane-a-0', host: 'machine-b', state: 'finished' })]),
    item('GY-R2', {}, [handle({ id: 'r-2', kind: 'review', pane: 'pane-foreign-0', host: 'machine-b', state: 'finished' })])]);
  const scoped = paneReclaimStatus(paneList(30), remote, agents, clockStart, host);
  assert.deepEqual({ panes: scoped.panes, launched: scoped.launched, agentless: scoped.agentless }, { panes: 30, launched: 21, agentless: 18 },
    'remote handles never inflate the host reading, even on a coordinate collision');

  const over = paneReclaimStatus(paneList(30), recorded(agentlessPaneAttentionBound + 2, 1, 2), agents, clockStart, host);
  assert.equal(over.agentless, agentlessPaneAttentionBound + 2);
  assert.ok(over.attention, 'attention rises past the bound');
  assert.match(over.attention!.text, new RegExp(`${agentlessPaneAttentionBound + 2} of the panes Graphyard launched stand agentless \\(past the ${agentlessPaneAttentionBound}-pane attention bound\\)`));
  assert.match(over.attention!.text, /the oldest pane pane-a-0 of GY-A0 \(review\), launched /, 'the oldest agentless pane is named');
  assert.match(over.attention!.text, /Herdr holds 30 pane\(s\) on this host/, 'the host pane count is on the item');
  assert.equal(over.attention!.next, 'the loop sweeps them itself, a bounded number per cycle, once agentless past its launch bound; graphyard master run --once runs a pass now');

  // Drained: once nothing stands agentless there is no oldest pane to name, whatever stood before.
  const drained = paneReclaimStatus(paneList(30), recorded(0, 1, 21), agents, clockStart, host);
  assert.deepEqual({ panes: drained.panes, launched: drained.launched, agentless: drained.agentless, oldest: drained.oldest }, { panes: 30, launched: 22, agentless: 0, oldest: null });
  assert.equal(drained.attention, null, 'a drained backlog raises no attention');

  // A runtime that cannot be read: the pane count is unknown, and an agentless reading is still
  // made from the agent inventory, which lists a session's pane while the pane stands.
  const unreadable = paneReclaimStatus(null, recorded(2, 0, 0), [{ name: 'graphyard-reviewer-1', pane_id: 'pane-a-0', agent_status: 'unknown' }, { name: 'graphyard-reviewer-2', pane_id: 'pane-a-1', agent_status: 'unknown' }], clockStart, host);
  assert.equal(unreadable.panes, null);
  assert.deepEqual({ launched: unreadable.launched, agentless: unreadable.agentless }, { launched: 2, agentless: 2 });
});
