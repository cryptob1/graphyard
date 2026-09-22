import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionableSubjects, approvalStep, approvalWatchSchema, approverJudgeBoundMs, cycleDelay, daemonEffects, daemonSummary, decisionKey, emptyDaemonState, latencyBudget, latencyTargets, loopAttention, loopLiveness, maxApproverLaunches, mergeableCandidate, observeItemClock, reconcilePendingActions, routineDecision, runCycle, runDaemon, silenceBudgetMs, standingVerdict, trackSilence, watchdogPlan, withheldDecision, workerStopped, writeDaemonState, type DaemonAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { approverSessionName, decisionInput, launchApprover, listHerdrAgents, masterConfigSchema, type ContainmentAssessment, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import { containmentGraceMs } from '../src/quarantine.js';
import type { Work } from '../src/model.js';
import { decideScopeRequest } from '../src/model/scope.js';

/**
 * GY-84: the loop drives every routine decision unattended.
 *
 * These proofs run the real cycle against a simulated control plane and a simulated outside world:
 * the launcher claims, the worker pushes and submits, CI and the reviewer land verdicts on the exact
 * head, a producer publishes trusted evidence, and the approver session the loop launches judges the
 * decisions the loop requests. Nothing in the harness makes a decision for the loop, and no step
 * waits for a human: what the loop does not do itself does not happen.
 *
 * The approver is not a stub. The loop's own effects launch it — `daemonEffects(...).approver`, which
 * is `launchApprover` — and close it with the real pane closer, both against a simulated Herdr that
 * keeps a finished tab listed exactly as the real one does. What a launched session then does is
 * scripted per launch: it approves, dies, declines, hangs, or has its decision fail on the server.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clockStart = Date.parse('2031-03-01T09:00:00Z');
const hex = (seed: string) => createHash('sha1').update(seed).digest('hex');
/** A decision id shaped like the server's, so each decision gets the session name the launcher gives it. */
const uuid = (seed: string) => hex(seed).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
const minute = 60_000;

function config(overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', operatorAgent: { id: 'graphyard-master-operator', credentialFile: '/outside/coordinator-operator.token' },
    approver: { id: 'graphyard-approver', credentialFile: '/outside/coordinator-approver.token' }, ...overrides,
    run: { proofWorkflow: 'acceptance.yml', ...overrides.run } });
}
const profile = (name: string, overrides: Partial<WorkerProfile> = {}): WorkerProfile =>
  ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], environment: {}, ...overrides }) as WorkerProfile;

/** What the outside world does with one attempt: the session dies, the head is judged, or both. */
type Round = 'die' | 'changes' | 'conflict' | 'pass';
interface Script { key: string; rounds: Round[]; scopeOn?: number }

interface PlaneDecision { id: string; action: string; state: string; input: any; approvedBy: string | null; reason: string; outcome: string | null }

/** What one launched approver session does with the decision it was asked to judge. */
type Judgement = 'approve' | 'die' | 'decline' | 'hang' | 'fail';

/**
 * A repository the real launcher accepts: a Git checkout holding `.graphyard/master.json`, with the
 * coordinator, operator-agent and approver credentials outside it, each mode 0600.
 */
async function approverHost(overrides: Parameters<typeof config>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-unattended-root-')), secrets = await mkdtemp(join(tmpdir(), 'graphyard-unattended-secrets-'));
  execFileSync('git', ['init', '-q', root]);
  const credential = async (name: string) => { const file = join(secrets, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(48, 'x'), { mode: 0o600 }); return file; };
  const master = config({ credentialFile: await credential('coordinator'), operatorAgent: { id: 'graphyard-master-operator', credentialFile: await credential('operator') },
    approver: { id: 'graphyard-approver', credentialFile: await credential('approver') }, ...overrides });
  await mkdir(join(root, '.graphyard'));
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(master), { mode: 0o600 });
  return { root, master, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(secrets, { recursive: true, force: true })]) };
}

/**
 * The part of Herdr the launcher and the pane closer speak to. A session that finishes stays
 * listed under its name until its pane is closed, which is the behaviour that used to refuse the
 * next approver on the same item.
 */
function herdr() {
  const sessions = new Map<string, { name: string; pane: string; status: string; prompt: string; judgement: Judgement }>();
  const panes = new Set<string>(), log: string[] = [], judgements: Judgement[] = [];
  const control = { available: true, closable: true };
  let created = 0;
  const ok = (result: unknown = {}) => JSON.stringify({ result });
  const run = (command: string, args: string[]) => {
    assert.equal(command, 'herdr', `only Herdr is run for an approver: ${command} ${args.join(' ')}`);
    if (!control.available) throw new Error('herdr: the server socket is unreachable');
    const [noun, verb] = args;
    if (noun === 'tab' && verb === 'create') { const pane = `pane-${++created}`; panes.add(pane); return ok({ root_pane: { pane_id: pane, tab_id: `tab-${created}` } }); }
    if (noun === 'agent' && verb === 'start') {
      const name = args[2], pane = args[args.indexOf('--pane') + 1];
      assert.ok(!sessions.has(name), `Herdr refuses a second agent named ${name}`);
      // A runtime with a request contract starts on its instruction (GY-93): it arrives on the
      // command line after the runtime's own flags, never as a later paste, and the session is at work on it at once.
      const runtime = args.slice(args.indexOf('--') + 1), request = args.includes('--') && runtime.at(-1)?.includes(' ') ? runtime.at(-1)! : '';
      sessions.set(name, { name, pane, status: request ? 'working' : 'idle', prompt: request, judgement: judgements.shift() ?? 'approve' }); log.push(`launch:${name}`); return ok();
    }
    if (noun === 'agent' && verb === 'prompt') { Object.assign(sessions.get(args[2])!, { status: 'working', prompt: args[3] }); return ok(); }
    if (noun === 'agent' && verb === 'list') return ok({ agents: [...sessions.values()].map(session => ({ name: session.name, pane_id: session.pane, agent_status: session.status })) });
    if (noun === 'pane' && verb === 'close') {
      if (!control.closable) return JSON.stringify({ error: { code: 'pane_busy', message: 'the pane could not be closed' } });
      for (const session of [...sessions.values()].filter(entry => entry.pane === args[2])) { sessions.delete(session.name); log.push(`close:${session.name}`); }
      panes.delete(args[2]); return ok();
    }
    if (noun === 'pane' && verb === 'list') return ok({ panes: [...panes].map(pane_id => ({ pane_id })) });
    throw new Error(`The simulated Herdr has no ${args.slice(0, 2).join(' ')}`);
  };
  return { run, sessions, panes, log, judgements, control };
}

/**
 * The simulated control plane. It holds work documents, recomputes gates and stage from them
 * exactly as the engine's order does, and applies the mutations the loop's effects ask for —
 * a claim, a settled quarantine, an additive requirements revision, a decision, a merge. Between
 * cycles `advance` runs everyone else: the launched worker, CI, the reviewer, the producer, and
 * the approver session the loop launched for its own request.
 */
function plane(scripts: Script[], options: { hostId?: string; host?: { root: string; master: MasterConfig }; judgements?: Judgement[]; delivered?: number } = {}) {
  const hostId = options.hostId ?? 'machine-a';
  const sessions = herdr();
  sessions.judgements.push(...options.judgements ?? []);
  let now = clockStart;
  const iso = (at: number = now) => new Date(at).toISOString();
  const work: Work[] = scripts.map((script, index) => ({
    id: `id-${script.key}`, key: script.key, title: `Deliver ${script.key}`, description: '', type: 'feature', priority: 2,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Proven end to end', proofs: ['integration:loop'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [`src/${script.key.toLowerCase()}.ts`],
    stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(now - 30 * minute), updatedAt: iso(), stageEnteredAt: iso(now - minute),
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, violations: [],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }],
    pr: 100 + index,
  } as unknown as Work));
  // The ledger an installation already holds: items delivered before this loop ever watched them,
  // reported the way the control plane reports a delivery — a submission, no rework requested,
  // every gate passing — which is exactly what an open, approved, mergeable candidate looks like.
  for (let index = 0; index < (options.delivered ?? 0); index++) {
    const key = `GY-${index + 1}`, sha = hex(`${key}-1`), baseSha = hex(`base-${key}`), mergedAt = iso(now - (index + 1) * 60 * minute);
    const candidate = { sha, baseSha, pr: index + 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker', createdAt: mergedAt };
    work.push({ ...work[0], id: `id-${key}`, key, title: `Deliver ${key}`, plannedFiles: [`src/${key.toLowerCase()}.ts`], stage: 'done', stageEnteredAt: mergedAt, epoch: 1,
      candidate, submission: { epoch: 1, pr: index + 1 }, lastAssignment: { owner: 'graphyard-claude-0', epoch: 1, claimedAt: mergedAt },
      observation: { candidate, checks: [], reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha, state: 'APPROVED', submittedAt: mergedAt }], merged: true, mergeSha: hex(`merge-${key}`), mergedAt,
        mergeable: true, protected: true, files: [], at: mergedAt, baseTip: baseSha, baseTipContained: true, prState: 'closed', draft: false },
      delivery: { mergedAt, mergedAtRepository: mergedAt, mergeSha: hex(`merge-${key}`), authorizationRevision: 1 }, pr: index + 1 } as unknown as Work);
  }
  const decisions = new Map<string, PlaneDecision[]>();
  const judged = new Map<string, number>();
  const find = (id: string) => work.find(item => item.id === id || item.key === id)!;
  const script = (item: Work) => scripts.find(entry => entry.key === item.key)!;
  const round = (item: Work): Round => { const rounds = script(item).rounds; return rounds[Math.min(rounds.length - 1, Math.max(0, item.epoch - 1))]; };

  /** The gates and stage the engine would compute, in its order, from this document alone. */
  const recompute = (item: Work) => {
    const candidate = item.candidate, observation = item.observation;
    const current = !!candidate && !!observation && observation.candidate.sha === candidate.sha;
    const submitted = !!item.submission && !item.reworkRequested && current && !!item.workspaces.length;
    const conflict = item.baseRefresh?.conflict && item.baseRefresh.from.sha === candidate?.sha ? item.baseRefresh.conflict : null;
    const reviews = current ? observation!.reviews : [];
    const approved = reviews.some(review => review.sha === candidate!.sha && review.state === 'APPROVED');
    const changes = reviews.some(review => review.sha === candidate!.sha && review.state === 'CHANGES_REQUESTED');
    const checks = item.policy.checks.filter(name => !(current ? observation!.checks : []).some(check => check.name === name && check.result === 'success'));
    const proofs = [...new Set(item.criteria.flatMap(criterion => criterion.proofs))];
    const unproven = proofs.filter(proof => !item.evidence.some(entry => entry.proof === proof && entry.trusted && !entry.revocation
      && entry.sha === candidate?.sha && entry.baseSha === candidate?.baseSha && entry.policyRevision === item.policyRevision && entry.result === 'pass' && entry.executed > 0 && entry.skipped === 0));
    const stale = !observation || now - Date.parse(observation.at) >= 120_000;
    const gates = [
      { name: 'ready', reasons: [...(item.ready ? [] : ['Not released from backlog']), ...(item.blocker ? [item.blocker] : [])] },
      { name: 'build', reasons: [...(submitted ? [] : ['Worker has not submitted implementation for this attempt']), ...(conflict ? [conflict] : [])] },
      { name: 'review', reasons: [...(approved ? [] : ['Independent approval of the current commit is required']), ...(changes ? ['Outstanding change requests must be resolved through a new review'] : [])] },
      { name: 'test', reasons: checks.map(name => `Required CI check ${name} has not passed on the current candidate`) },
      { name: 'acceptance', reasons: unproven.map(proof => `AC-1: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`) },
      { name: 'merge', reasons: [...(stale ? ['GitHub observation missing or older than two minutes'] : []), ...(observation?.mergeable === false ? ['Pull request is not mergeable against the current base'] : [])] },
    ].map(gate => ({ name: gate.name, passed: !gate.reasons.length, reasons: gate.reasons }));
    if (item.stage === 'done') { item.gates = gates.map(gate => ({ ...gate, passed: true, reasons: [] })); return; }
    const failing = gates.find(gate => !gate.passed);
    const stage = (failing?.name ?? 'merge') as Work['stage'];
    if (stage !== item.stage) { item.stage = stage; item.stageEnteredAt = iso(); }
    item.gates = gates;
    item.mergeAuthorization = gates.every(gate => gate.passed) && candidate ? { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: item.policyRevision, at: iso() } : null;
  };
  for (const item of work) recompute(item);

  const push = (item: Work) => {
    const sha = hex(`${item.key}-${item.epoch}`), baseSha = hex(`base-${item.key}`);
    const pr = (item as unknown as { pr: number }).pr;
    item.candidate = { sha, baseSha, pr, branch: `graphyard/${item.key.toLowerCase()}-${item.epoch}`, author: 'worker', createdAt: iso() };
    item.submission = { epoch: item.epoch, pr };
    item.reworkRequested = false;
    item.observation = { candidate: item.candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: item.plannedFiles, at: iso(), baseTip: baseSha, baseTipContained: true, prState: 'open', draft: false } as Work['observation'];
    item.baseRefresh = null;
    // `complete` reports the implementation and ends the lease in the same transaction.
    item.lease = null;
    recompute(item);
  };
  const judge = (item: Work) => {
    const candidate = item.candidate!, step = (judged.get(item.key) ?? 0) + 1;
    judged.set(item.key, step);
    item.observation = { ...item.observation!, at: iso() };
    const verdict = (state: string) => { item.observation!.reviews = [{ reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state, submittedAt: iso() }]; };
    if (round(item) === 'changes') verdict('CHANGES_REQUESTED');
    else if (round(item) === 'conflict') {
      item.baseRefresh = { from: { sha: candidate.sha, baseSha: candidate.baseSha }, base: item.observation!.baseTip!, baseTree: hex(`tree-${item.key}`),
        policyRevision: item.policyRevision, at: iso(), head: null, conflict: `src/${item.key.toLowerCase()}.ts: merge conflict with the base branch`, carry: null } as Work['baseRefresh'];
    } else if (step === 1) {
      // The reviewer approves and CI reports first; the producer's trusted evidence lands after it.
      verdict('APPROVED');
      item.observation!.checks = item.policy.checks.map(name => ({ name, result: 'success', appId: 1234 }));
    } else {
      item.evidence = [...item.evidence, { id: `evidence-${item.key}-${item.epoch}`, proof: 'integration:loop', sha: candidate.sha, baseSha: candidate.baseSha,
        policyRevision: item.policyRevision, producer: 'ci-producer', trusted: true, result: 'pass', executed: 4, skipped: 0, at: iso() }];
    }
    recompute(item);
  };
  /** The control plane's side of an approval: the decision is applied exactly as the engine applies it. */
  const approve = (item: Work, decision: PlaneDecision, approvedBy = 'graphyard-approver') => {
    Object.assign(decision, { state: 'applied', approvedBy });
    // The engine's `rework` leaves `baseRefresh` alone: a conflict keeps matching the head it was found
    // on until a worker pushes a new one.
    if (decision.action === 'rework') { item.reworkRequested = true; item.lease = null; item.containmentQuarantine = null; judged.set(item.key, 0); }
    if (decision.action === 'recover') item.containmentQuarantine = null;
    recompute(item);
  };
  /**
   * Every approver session the loop launched acts on the prompt the real launcher delivered to it:
   * it judges the one decision it names, from its own tab, and then does what its script says —
   * approve and stop (the tab stays listed), die, decline and go idle, hang, or approve a decision
   * the engine then refuses to apply.
   */
  const judgeDecisions = () => {
    for (const session of [...sessions.sessions.values()].filter(entry => entry.status === 'working')) {
      const named = /Judge decision (\S+) on (\S+):/.exec(session.prompt);
      assert.ok(named, `the approver prompt names its decision: ${session.prompt}`);
      const item = find(named![2]), decision = (decisions.get(item.id) ?? []).find(entry => entry.id === named![1]);
      if (session.judgement === 'hang') continue;
      if (session.judgement === 'die') { sessions.sessions.delete(session.name); sessions.panes.delete(session.pane); continue; }
      if (session.judgement === 'decline') { session.status = 'idle'; continue; }
      session.status = 'done';
      if (!decision || decision.state !== 'requested') continue;
      if (session.judgement === 'fail') Object.assign(decision, { state: 'failed', approvedBy: 'graphyard-approver', outcome: 'Worker startup remains fenced; stop its supervisor and wait for both lease and launch authority expiry before recovery' });
      else approve(item, decision);
    }
  };

  const advance = (ms: number) => {
    now += ms;
    judgeDecisions();
    for (const item of work) {
      if (item.stage === 'done') continue;
      const live = !!item.lease && Date.parse(item.lease.expiresAt) > now;
      const submitted = !!item.submission && !item.reworkRequested && item.submission.epoch === item.epoch;
      // A worker waiting for its scope request keeps its lease and pushes nothing until it lands.
      if (live && item.scopeRequest) continue;
      if (live && round(item) !== 'die' && !submitted) { push(item); continue; }
      if (!submitted || !item.candidate) continue;
      judge(item);
    }
    for (const item of work) recompute(item);
  };

  // The loop's own session effects, as `master run` wires them, against the simulated Herdr. An
  // exercise that asks for no decision needs no repository for the launcher to load.
  const wired = options.host ? daemonEffects(options.host.root, options.host.master, { snapshot: async () => ({ work: [], now: iso() }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'unattended-cycle' }, run: sessions.run }) : null;
  const effects = (overrides: Partial<DaemonEffects> = {}): DaemonEffects => ({
    agents: () => wired ? wired.agents() : [],
    ...(wired ? { herdr: wired.herdr } : {}),
    credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: work.map(item => ({ ...item })), now: iso() }),
    closeSession: pane => { if (wired) return wired.closeSession(pane); },
    dispatch: async (item, worker) => {
      const target = find(item.id);
      target.epoch += 1;
      target.lease = { owner: worker.principal, epoch: target.epoch, expiresAt: iso(now + 30 * minute) };
      target.lastAssignment = { owner: worker.principal, epoch: target.epoch, claimedAt: iso() };
      target.workspaces = [{ host: hostId, path: `/tmp/graphyard/${target.key.toLowerCase()}-${target.epoch}`, branch: `graphyard/${target.key.toLowerCase()}-${target.epoch}`, epoch: target.epoch, owner: worker.principal }];
      target.implementers = [...new Set([...(target.implementers ?? []), worker.principal])];
      // A claim leaves `reworkRequested` standing, as the engine does: only the round's own
      // submission clears it, so a round whose worker dies before pushing is still a requested round.
      if (script(target).scopeOn === target.epoch) target.scopeRequest = { epoch: target.epoch, paths: ['docs/loop.md'], reason: 'The criteria ask for the loop guide to be updated', requestedBy: worker.principal, at: iso() };
      if (round(target) === 'die') {
        // A supervised launch fences its session in a scope unit; this one dies with the fence up.
        target.lease = { ...target.lease, expiresAt: iso(now + minute) };
        target.containmentQuarantine = { owner: worker.principal, epoch: target.epoch, at: iso(), settlementHash: 'f'.repeat(64),
          leaseExpiresAt: iso(now + minute), launchExpiresAt: iso(now + minute), scope: { unit: `graphyard-watch-${target.epoch}.scope`, pid: 4242 } };
      }
      recompute(target);
    },
    requestProof: () => {},
    merge: async item => {
      const target = find(item.id);
      const mergeSha = hex(`merge-${target.key}-${target.epoch}`);
      target.observation = { ...target.observation!, merged: true, mergeSha, mergedAt: iso(), at: iso() };
      target.stage = 'done'; target.stageEnteredAt = iso();
      target.delivery = { mergedAt: iso(), mergedAtRepository: iso(), mergeSha, authorizationRevision: target.revision };
      recompute(target);
      return { result: 'merged' };
    },
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(clockStart), reason: 'No deployment endpoint is configured in this exercise', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    decide: async (item, action, reason) => {
      const target = find(item.id);
      const entries = decisions.get(target.id) ?? [];
      // The server refuses a second request of an action while one stands, whatever it is bound to.
      const pending = entries.find(entry => entry.action === action && (entry.state === 'requested' || entry.state === 'approved'));
      if (pending) throw new Error(`Decision ${pending.id} (${action}) is already ${pending.state} on ${target.key}; wait for it before requesting another`);
      const id = uuid(`${target.key}-${action}-${entries.length + 1}`);
      decisions.set(target.id, [...entries, { id, action, state: 'requested', input: decisionInput(action, target, {}), approvedBy: null, reason, outcome: null }]);
      return { id };
    },
    approver: async (item, decision) => {
      assert.ok(wired, 'this exercise asked for a decision, so it needs a repository for the launcher');
      return wired!.approver!(find(item.id), decision);
    },
    decisions: async item => ({ decisions: (decisions.get(find(item.id).id) ?? []).map(entry => ({ ...entry })) }),
    withdraw: async (item, decision, reason) => {
      const entry = (decisions.get(find(item.id).id) ?? []).find(candidate => candidate.id === decision)!;
      assert.equal(entry.state, 'requested', 'only a requested decision can be withdrawn');
      Object.assign(entry, { state: 'withdrawn', outcome: reason });
    },
    // The control plane's side of `autoscope`: the verdict is recomputed from the item itself, and
    // an approved request is applied and cleared without ending the attempt.
    decideScope: async item => {
      const target = find(item.id);
      const request = target.scopeRequest!;
      const verdict = decideScopeRequest(target, request);
      target.scopeDecision = { state: verdict.state, reason: verdict.reason, at: iso(), decidedBy: 'graphyard', waitedMs: Math.max(0, now - Date.parse(request.at)),
        paths: verdict.paths, requestedBy: request.requestedBy, requestedAt: request.at };
      if (verdict.state === 'approved') {
        target.plannedFiles = [...new Set([...target.plannedFiles, ...verdict.paths])];
        target.policyRevision += 1; target.scopeRequest = null;
      } else target.scopeRequest = { ...request, decision: target.scopeDecision };
      recompute(target);
      return target;
    },
    containment: items => Object.fromEntries(items.filter(item => item.containmentQuarantine).map(item => [item.id, {
      key: item.key, id: item.id, epoch: item.containmentQuarantine!.epoch, owner: item.containmentQuarantine!.owner, at: item.containmentQuarantine!.at,
      host: hostId, workspacePath: item.workspaces[0]?.path ?? null, scope: item.containmentQuarantine!.scope ?? null,
      settleable: true, refusals: [], attestation: '', verification: null,
    } as ContainmentAssessment])),
    settleContainment: async item => { find(item.id).containmentQuarantine = null; recompute(find(item.id)); },
    persist: async () => {},
    ...overrides,
  });

  return { work, decisions, sessions, effects, recompute, advance, approve, find, now: () => now, iso, hostId,
    set: (at: number) => { now = at; } };
}

/** Run one cycle of the real loop against the simulation, then let the outside world act. */
async function cycle(state: DaemonState, master: MasterConfig, simulation: ReturnType<typeof plane>, effects: DaemonEffects, advanceMs = minute) {
  const result = await runCycle(master, state, effects, simulation.now);
  simulation.advance(advanceMs);
  return result;
}
const steps = (actions: DaemonAction[]) => actions.filter(action => action.kind !== 'deployment').map(action => `${action.kind}:${action.work ?? '-'}:${action.state}`);

test('integration:unattended-full-cycle — with no master session and no human input the loop drives one item from ready to delivered: it dispatches, reclaims a dead session, has an additive scope request decided, requests and dispatches rework after a verdict and after a base conflict through approver sessions that die and decline, and merges the candidate whose gates are green', async t => {
  // Attempt 1's session dies under its fence; attempt 2 is told to change the work; attempt 3
  // hits a base branch Graphyard cannot merge in; attempt 4 asks for one more planned file and
  // then delivers. Every step between them is the loop's to take.
  //
  // The approver sessions are the real launch contract, and they are not all well behaved: the
  // first rework's approver dies without judging, and the second rework's approver declines and
  // goes idle under the very name its replacement needs. The loop has to see both and carry on.
  const host = await approverHost({ workers: [profile('claude-a'), profile('claude-b')] });
  t.after(host.cleanup);
  const master = host.master;
  const simulation = plane([{ key: 'GY-84', rounds: ['die', 'changes', 'conflict', 'pass'], scopeOn: 4 }], { host, judgements: ['die', 'approve', 'decline', 'approve'] });
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  const performed: DaemonAction[] = [];
  const item = simulation.work[0];
  for (let pass = 0; pass < 40 && item.stage !== 'done'; pass++) {
    // Longer than the containment grace window, so the first attempt's fence becomes settleable.
    performed.push(...(await cycle(state, master, simulation, effects, containmentGraceMs / 2)).actions);
  }
  // One more cycle so the delivery is sampled from the snapshot that shows it delivered.
  performed.push(...(await cycle(state, master, simulation, effects)).actions);

  assert.equal(item.stage, 'done', 'the item reached delivery with no master session and no human input');
  assert.equal(item.epoch, 4, 'four attempts: the dead session, the rework round, the base conflict, and the delivered one');
  assert.deepEqual(item.plannedFiles, ['src/gy-84.ts', 'docs/loop.md'], 'the additive scope request was applied without ending the attempt');
  assert.equal(item.containmentQuarantine, null, 'the dead session\'s fence was settled by the loop');
  assert.equal(item.scopeRequest, null);

  // Exactly the routine decisions the criteria name, each requested by the loop and applied by the
  // independent approver session the loop launched for it — never by the requester.
  const requested = simulation.decisions.get(item.id)!;
  assert.deepEqual(requested.map(decision => [decision.action, decision.state, decision.approvedBy]),
    [['rework', 'applied', 'graphyard-approver'], ['rework', 'applied', 'graphyard-approver']]);
  for (const decision of requested) assert.equal(decision.input.previousWorkerStopped, true, 'rework is requested only once the attempt has ended');
  for (const decision of requested) assert.match(decision.reason, /The previous worker is stopped: GY-84 holds no lease and no containment fence stands for it\.$/, 'and the request says what that attestation rests on');

  // What the loop did with the sessions, read from Herdr's side. Each decision has its own session
  // name, so the first decision's tab can never refuse the second's approver. The approver that
  // died was replaced; the one that declined was still listed under the name its replacement
  // needs, so it was closed first; and every finished tab was closed rather than left listed.
  const [first, second] = requested.map(decision => approverSessionName(item, decision.id));
  assert.notEqual(first, second);
  assert.deepEqual(simulation.sessions.log, [`launch:${first}`, `launch:${first}`, `close:${first}`, `launch:${second}`, `close:${second}`, `launch:${second}`, `close:${second}`]);
  assert.deepEqual([...simulation.sessions.sessions.keys()], [], 'no approver tab is left holding a provider seat');
  const supervision = performed.filter(action => action.kind === 'decision').map(action => action.detail);
  assert.ok(supervision.some(detail => new RegExp(`approver session ${first} is gone without judging it; launched independent approver session ${first} \\(launch 2 of 3\\)`).test(detail)), supervision.join('\n'));
  assert.ok(supervision.some(detail => new RegExp(`approver session ${second} ended idle without approving it — declined, or its prompt was dropped; launched independent approver session ${second} \\(launch 2 of 3\\)`).test(detail)), supervision.join('\n'));
  assert.deepEqual(state.approvals, {}, 'a watch is retired with the decision it watched');

  // The launch contract itself, which the loop has to live inside: a name still listed refuses a
  // second session for the same decision, and says nothing about another decision on the item.
  const lingering = [{ name: first, pane_id: 'pane-lingering', agent_status: 'done' }];
  await assert.rejects(launchApprover(host.root, item, requested[0].id, 'claude', lingering, simulation.sessions.run), /is already visible in Herdr; let it finish or close it first/);
  const beside = await launchApprover(host.root, item, requested[1].id, 'claude', lingering, simulation.sessions.run);
  assert.equal(beside.agentName, second);
  assert.deepEqual((await listHerdrAgents(simulation.sessions.run)).map(agent => [agent.name, agent.agent_status]), [[second, 'working']]);

  const kinds = steps(performed);
  const order = (needle: string) => kinds.findIndex(entry => entry === needle);
  assert.ok(order('settle:GY-84:done') >= 0, `the dead session was reclaimed: ${kinds.join(', ')}`);
  assert.equal(kinds.filter(entry => entry === 'dispatch:GY-84:done').length, 4, 'every attempt was dispatched by the loop');
  assert.equal(performed.filter(action => action.kind === 'decision' && /^Requested decision /.test(action.detail)).length, 2, 'one request per round, however many sessions it took to judge it');
  assert.equal(kinds.filter(entry => entry === 'scope:GY-84:done').length, 1);
  assert.equal(kinds.filter(entry => entry === 'merge:GY-84:done').length, 1);
  assert.ok(order('settle:GY-84:done') < order('decision:GY-84:done'), 'the reclaim came before the rework rounds');
  assert.ok(order('decision:GY-84:done') < order('merge:GY-84:done'), 'the merge came after the rework rounds it needed');
  // Nothing in the drive was left to a person: every recorded action is the loop's own, and no
  // escalation was raised for a decision it is able to request.
  const escalations = performed.filter(action => action.kind === 'escalation');
  assert.deepEqual(escalations.map(action => action.detail), [], 'an unattended cycle escalates nothing it can decide itself');

  // The decision behind each of those rounds, read from the item alone: a verdict standing against
  // the exact head, and never a rework request while the previous attempt is still running.
  const reviewed = { ...simulation.work[0], stage: 'review' as const, reworkRequested: false, submission: { epoch: 4, pr: 100 },
    observation: { ...item.observation!, merged: false, reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha: item.candidate!.sha, state: 'CHANGES_REQUESTED', submittedAt: '2031-03-01T09:20:00Z' }] } } as Work;
  assert.deepEqual(standingVerdict(reviewed), { reviewer: 'graphyard-reviewer[bot]', at: '2031-03-01T09:20:00Z', reason: `graphyard-reviewer[bot] requested changes on ${item.candidate!.sha.slice(0, 12)}` });
  assert.equal(routineDecision(reviewed, master, Date.parse('2031-03-01T09:21:00Z'))?.action, 'rework');
  const running = { ...reviewed, lease: { owner: 'claude-a-principal', epoch: 4, expiresAt: '2031-03-01T10:00:00Z' } } as Work;
  assert.equal(routineDecision(running, master, Date.parse('2031-03-01T09:21:00Z')), null, 'rework attests that the previous worker is stopped, so a live attempt is never reworked under it');

  // The passage it measured, from its own observations: one delivery, each figure inside its bound.
  const budget = latencyBudget(state.latency);
  assert.equal(budget.deliveries, 1);
  assert.ok(budget.readyToClaim.p90Ms <= latencyTargets.readyToClaimP90Ms, `ready→claim ${budget.readyToClaim.p90Ms}ms`);
  assert.equal(budget.reworkRequest.count, 1, 'the verdict round was measured from the verdict that stood; the base conflict had no verdict behind it');
  assert.deepEqual(budget.reworkRequest.breaches, [], 'each rework was requested inside the five-minute bound');
  assert.deepEqual(budget.mergeDwell.breaches, []);
});

test('integration:mergeable-dwell-budget — a candidate whose gates are green merges within five minutes of becoming mergeable and a standing verdict reaches a rework request in the same window, with p90 approval→merge inside ten minutes over more than ten deliveries; a loop that leaves one green reports the breach', async () => {
  const scripts = Array.from({ length: 11 }, (_, index) => ({ key: `GY-${200 + index}`, rounds: ['pass' as const] }));
  // The loop starts beside a ledger that already holds deliveries, as every real installation does,
  // and keeps cycling long after its own: the budget is of the passages this loop watched, and a
  // delivered item is history, not a passage that completes again every cycle.
  const history = 79;
  const simulation = plane(scripts, { delivered: history });
  const master = config({ workers: scripts.map((_, index) => profile(`claude-${index}`)) });
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  const open = () => simulation.work.filter(item => scripts.some(entry => entry.key === item.key) && item.stage !== 'done');
  await cycle(state, master, simulation, effects, 2 * minute);
  assert.equal(state.latency.length, 0, 'a delivery this loop never watched is not a sample');
  assert.equal(latencyBudget(state.latency).met, null, 'and history alone does not make the ten deliveries the targets are judged over');
  for (let pass = 0; pass < 10 && open().length; pass++) await cycle(state, master, simulation, effects, 2 * minute);
  for (let pass = 0; pass < 40; pass++) await cycle(state, master, simulation, effects);

  assert.equal(simulation.work.filter(item => item.stage === 'done').length, history + 11, 'every item was delivered by the loop alone');
  const budget = latencyBudget(state.latency);
  assert.equal(budget.deliveries, 11, 'one sample per delivery the loop made, forty cycles after the last of them');
  assert.deepEqual(state.latency.map(sample => sample.work).sort(), scripts.map(entry => entry.key).sort(), 'and each is of an item this loop delivered');
  assert.equal(budget.approvalToMerge.count, 11, 'approval→merge is not diluted by items delivered before the loop watched');
  assert.ok(budget.approvalToMerge.p50Ms > 0, 'the median is of real passages, not of zeros');
  assert.deepEqual(Object.keys(state.clocks), [], 'a sampled delivery keeps no clock, and none is created for it again');
  assert.deepEqual(budget.mergeDwell.breaches, [], 'no candidate stayed mergeable past the five-minute bound');
  assert.ok(budget.mergeDwell.count >= latencyTargets.minimumDeliveries, 'every delivery measured its mergeable dwell');
  assert.ok(budget.approvalToMerge.p90Ms <= latencyTargets.approvalToMergeP90Ms, `approval→merge p90 ${budget.approvalToMerge.p90Ms}ms exceeds the ten-minute target`);
  assert.ok(budget.approvalToMerge.p90Ms > 0, 'the measurement is of a real passage, not of a zero');
  assert.equal(budget.met, true, `budget reasons: ${budget.reasons.join('; ')}`);
  assert.deepEqual(loopAttention({ liveness: loopLiveness(state, simulation.now(), 20_000, master.hostId), budget }).filter(attention => /budget/.test(attention.text)), []);

  // The same measurement over a loop that cannot merge what is green: the dwell is the breach, it
  // names the candidate, and it reaches the attention list rather than a chart nobody reads.
  const stalled = plane([{ key: 'GY-300', rounds: ['pass'] }], { delivered: history });
  const stalledState = emptyDaemonState(master);
  let refuse = true;
  const stalledEffects = stalled.effects();
  const merge = stalledEffects.merge;
  stalledEffects.merge = async item => {
    if (refuse) throw new Error('Guarded merge refused: the base branch moved under the candidate');
    return merge(item);
  };
  for (let pass = 0; pass < 4; pass++) await cycle(stalledState, master, stalled, stalledEffects, 2 * minute);
  assert.ok(mergeableCandidate(stalled.work[0]), 'the candidate is green and the loop is the only thing not merging it');
  stalled.advance(30 * minute);
  refuse = false;
  await cycle(stalledState, master, stalled, stalledEffects);
  // The breach is still what the budget reports many cycles later: nothing evicts it, and nothing
  // outvotes it with deliveries that were never measured.
  for (let pass = 0; pass < 40; pass++) await cycle(stalledState, master, stalled, stalledEffects);
  const stalledBudget = latencyBudget(stalledState.latency);
  assert.equal(stalledBudget.deliveries, 1);
  assert.deepEqual(stalledBudget.mergeDwell.breaches.map(breach => breach.work), ['GY-300']);
  assert.equal(stalledBudget.met, false);
  assert.match(stalledBudget.reasons.join('; '), /GY-300 stayed mergeable for 3\d(\.\d)? min, past the 5 min bound/);
  const attention = loopAttention({ liveness: loopLiveness(stalledState, stalled.now(), 20_000, master.hostId), budget: stalledBudget });
  assert.match(attention.at(-1)!.text, /unattended delivery budget is not met/);
  assert.equal(attention.at(-1)!.role, 'master');
  assert.equal(attention.at(-1)!.human, false);
});

test('integration:no-actionable-silence — every cycle records what it could act on and what it did, the longest actionable-but-idle wait is reported, and a subject nothing has acted on for more than twenty minutes reaches the top of the attention list, a decision the loop requested and no approver judged included', async t => {
  const simulation = plane([{ key: 'GY-400', rounds: ['pass'] }]);
  // A two-minute cycle, so cycling every two simulated minutes is a healthy loop rather than a
  // stalled one: this proof is about silence in the work, not about the loop's own liveness.
  const master = config({ workers: [profile('claude-a')], run: { intervalSeconds: 120 } });
  const state = emptyDaemonState(master);
  // The one worker profile has no usable credential, so nothing can claim the ready item: the
  // pipeline has something actionable and no way to act on it, which is exactly the silence GY-84
  // is about. The loop escalates once and then has nothing left to record.
  const effects = simulation.effects({ credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: false, reason: 'Worker credential is unreadable' }])) });
  state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: simulation.iso(), heartbeatAt: simulation.iso() };

  const first = await cycle(state, master, simulation, effects, minute);
  assert.equal(first.metrics.actionable, 1, 'the cycle records what it could act on, not only what it did');
  assert.deepEqual(first.silence.longest && [first.silence.longest.kind, first.silence.longest.work], ['dispatch', 'GY-400']);
  assert.match(first.silence.longest!.detail, /GY-400 is claimable and waiting for a worker/);
  assert.deepEqual(steps(first.actions), ['escalation:GY-400:done'], 'and what it did: the escalation naming the profile it cannot use');
  assert.equal(first.silence.longestIdleMs, 0, 'a subject it acted on this cycle starts its wait again');

  let last = first;
  for (let pass = 0; pass < 12; pass++) last = await cycle(state, master, simulation, effects, 2 * minute);
  assert.ok(last.silence.longestIdleMs > silenceBudgetMs, `${last.silence.longestIdleMs}ms of silence on an actionable item`);
  assert.equal(last.silence.breached, true);
  assert.equal(last.metrics.idleMs, last.silence.longestIdleMs, 'every cycle records the wait, whether or not it acted');
  const liveness = loopLiveness(state, simulation.now(), master.run.intervalSeconds * 1000, master.hostId);
  assert.equal(liveness.state, 'running', 'the loop is cycling: the silence is about the work, not about the loop');
  const attention = loopAttention({ liveness, silence: last.silence, budget: latencyBudget(state.latency) });
  assert.equal(attention[0].subject, 'GY-400');
  assert.match(attention[0].text, /Nothing has acted on GY-400 is claimable and waiting for a worker for 2\d minutes, past the 20-minute bound/);
  assert.equal(attention[0].human, false);

  // The credential comes back: the same subject is acted on, and the wait resets to zero.
  const healthy = simulation.effects();
  const acted = await cycle(state, master, simulation, healthy, minute);
  assert.ok(acted.actions.some(action => action.kind === 'dispatch' && action.state === 'done'));
  assert.equal(acted.silence.longestIdleMs, 0);
  assert.equal(acted.silence.breached, false);

  // The inventory follows the work rather than a fixed list: a claimed, submitted attempt asks
  // nothing of the dispatcher, what it is still missing is named, and a delivery asks nothing.
  const underway = actionableSubjects(master, simulation.work, simulation.now());
  assert.deepEqual(underway.map(subject => subject.kind), ['proof'], `${underway.map(subject => subject.detail).join('; ')}`);
  simulation.advance(minute); // the reviewer approves and CI reports
  simulation.advance(minute); // the producer publishes its trusted evidence
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()).map(subject => subject.kind), ['merge'], 'with every gate green the candidate is the loop\'s to merge');
  await cycle(state, master, simulation, healthy, minute);
  assert.equal(simulation.work[0].stage, 'done');
  assert.deepEqual(actionableSubjects(master, simulation.work, simulation.now()), [], 'a delivered item asks nothing of the loop');

  // The wait the loop itself creates: a decision it requested, sitting with an approver. Every
  // approver the loop launches here declines — it goes idle without approving, which the control
  // plane records nowhere. The item must not drop off the measure while that happens.
  const host = await approverHost({ workers: [profile('claude-a')], run: { intervalSeconds: 120 } });
  t.after(host.cleanup);
  const waiting = plane([{ key: 'GY-410', rounds: ['changes', 'pass'] }], { host, judgements: ['decline', 'decline', 'decline'] });
  const waitingState = emptyDaemonState(host.master);
  waitingState.lock = { id: 'lock', pid: process.pid, host: host.master.hostId, startedAt: waiting.iso(), heartbeatAt: waiting.iso() };
  const waitingEffects = waiting.effects();
  let pass = await cycle(waitingState, host.master, waiting, waitingEffects, 2 * minute);
  while (!Object.keys(waitingState.approvals).length) pass = await cycle(waitingState, host.master, waiting, waitingEffects, 2 * minute);
  const [watchKey] = Object.keys(waitingState.approvals), decision = waitingState.approvals[watchKey].decision;
  const session = approverSessionName(waiting.work[0], decision);
  // Requested and launched: still a subject, its wait started by the action just taken.
  assert.deepEqual(pass.silence.subjects.map(subject => [subject.kind, subject.work, subject.idleMs]), [['decision', 'GY-410', 0]]);
  assert.equal(pass.metrics.actionable, 1, 'a decision waiting on an approver is still something the pipeline could act on');

  // Three sessions decline in turn. Each replacement is an action; then the launches are spent.
  const replaced: DaemonAction[] = [];
  for (let round = 0; round < 3; round++) { pass = await cycle(waitingState, host.master, waiting, waitingEffects, 2 * minute); replaced.push(...pass.actions); }
  assert.deepEqual(waiting.sessions.log, [`launch:${session}`, `close:${session}`, `launch:${session}`, `close:${session}`, `launch:${session}`, `close:${session}`]);
  assert.equal(waitingState.approvals[watchKey].launches, maxApproverLaunches);
  assert.ok(waitingState.approvals[watchKey].exhaustedAt, 'the loop stops spending sessions on a decision none of them will judge');
  const unjudged = replaced.filter(action => action.kind === 'escalation');
  assert.equal(unjudged.length, 1, 'and escalates it once, when the last session ends');
  assert.equal(unjudged[0].state, 'failed');
  assert.match(unjudged[0].detail, new RegExp(`rework decision ${decision} on GY-410: approver session ${session} ended idle without approving it — declined, or its prompt was dropped\\. 3 approver session\\(s\\) and 1 request\\(s\\) have not produced a judgement`));
  assert.match(unjudged[0].detail, new RegExp(`graphyard master approver GY-410 ${decision}`), 'with the command that puts it to a fresh approver');
  assert.equal(waiting.decisions.get(waiting.work[0].id)![0].state, 'requested', 'the request itself still stands for whoever judges it');

  // From there nothing acts on it, and the silence is reported for what it is.
  for (let round = 0; round < 11; round++) pass = await cycle(waitingState, host.master, waiting, waitingEffects, 2 * minute);
  assert.deepEqual(pass.actions.filter(action => action.kind !== 'deployment'), [], 'no relaunch every few minutes forever');
  assert.equal(pass.silence.breached, true, `${pass.silence.longestIdleMs}ms on ${pass.silence.longest?.detail}`);
  assert.deepEqual([pass.silence.longest!.kind, pass.silence.longest!.work], ['decision', 'GY-410']);
  const unjudgedAttention = loopAttention({ liveness: loopLiveness(waitingState, waiting.now(), host.master.run.intervalSeconds * 1000, host.master.hostId), silence: pass.silence, budget: latencyBudget(waitingState.latency) });
  assert.equal(unjudgedAttention[0].subject, 'GY-410');
  assert.match(unjudgedAttention[0].text, new RegExp(`Nothing has acted on GY-410's rework decision ${decision} is unjudged after 3 approver session\\(s\\) for 2\\d minutes, past the 20-minute bound`));
  assert.equal(daemonSummary(waitingState, waiting.now(), host.master.run.intervalSeconds * 1000, host.master.hostId).approvals[0].decision, decision, 'master status lists the decision the loop is waiting on');

  // A fresh approver judges it (`master approver`, from a master session): the loop sees the
  // decision applied, retires its watch, dispatches the round, and the silence is over.
  waiting.approve(waiting.work[0], waiting.decisions.get(waiting.work[0].id)![0]);
  pass = await cycle(waitingState, host.master, waiting, waitingEffects, 2 * minute);
  assert.ok(pass.actions.some(action => action.kind === 'dispatch' && action.state === 'done'), steps(pass.actions).join(', '));
  assert.deepEqual(waitingState.approvals, {});
  assert.equal(pass.silence.breached, false);
  assert.deepEqual(pass.silence.subjects.filter(subject => subject.kind === 'decision'), []);

  // The step behind each of those cycles, as a pure judgement over one watch. A session that is
  // still working is waited for up to the bound and replaced past it; a history or an inventory
  // that cannot be read concludes nothing; and an approval the server has not applied yet is the
  // approver's to resume, so its session is supervised exactly like a request's.
  const at = waiting.now();
  const watch = approvalWatchSchema.parse({ work: 'GY-410', action: 'rework', decision, agentName: session, requestedAt: waiting.iso(at), launchedAt: waiting.iso(at), launches: 1 });
  const working = { agents: [{ name: session, pane_id: 'pane-9', agent_status: 'working' }], available: true };
  assert.equal(approvalStep(watch, { state: 'requested' }, working, at + approverJudgeBoundMs).step, 'wait');
  const hung = approvalStep(watch, { state: 'requested' }, working, at + approverJudgeBoundMs + minute);
  assert.deepEqual([hung.step, /has not judged it for 11 minutes, past the 10-minute bound/.test(hung.detail)], ['relaunch', true]);
  assert.equal(approvalStep({ ...watch, launches: maxApproverLaunches }, { state: 'approved' }, { agents: [], available: true }, at + minute).step, 'exhausted');
  assert.equal(approvalStep(watch, { state: 'approved' }, { agents: [], available: true }, at + minute).step, 'relaunch');
  assert.equal(approvalStep(watch, undefined, { agents: [], available: true }, at + minute).step, 'wait');
  assert.equal(approvalStep(watch, { state: 'requested' }, { agents: [], available: false }, at + minute).step, 'wait');
  assert.equal(approvalStep(watch, { state: 'applied' }, working, at + minute).step, 'settled');
  assert.equal(approvalStep(watch, null, working, at + minute).step, 'rerequest');
  assert.deepEqual(['stale', 'withdrawn', 'failed'].map(ended => approvalStep(watch, { state: ended }, working, at + minute).step), ['rerequest', 'rerequest', 'rerequest']);
});

test('integration:dispatch-latency-budget — ready work reaches a free worker inside two minutes and its first push inside fifteen, measured over ten items, and a long configured interval cannot push a claim past that bound', async () => {
  const scripts = Array.from({ length: 10 }, (_, index) => ({ key: `GY-${500 + index}`, rounds: ['pass' as const] }));
  const simulation = plane(scripts);
  const master = config({ workers: scripts.map((_, index) => profile(`claude-${index}`)) });
  const state = emptyDaemonState(master);
  const effects = simulation.effects();
  // The loop's first cycle sees ten released items and ten free profiles; each subsequent pass is
  // the worker's own work, which the push budget — not the dispatch budget — is judged on.
  for (let pass = 0; pass < 8 && simulation.work.some(item => item.stage !== 'done'); pass++) await cycle(state, master, simulation, effects, 3 * minute);
  await cycle(state, master, simulation, effects);

  assert.equal(simulation.work.filter(item => item.stage === 'done').length, 10);
  const budget = latencyBudget(state.latency);
  assert.equal(budget.readyToClaim.count, 10, 'every item measured ready→claim');
  assert.ok(budget.readyToClaim.p90Ms <= latencyTargets.readyToClaimP90Ms, `ready→claim p90 ${budget.readyToClaim.p90Ms}ms exceeds two minutes`);
  assert.equal(budget.readyToFirstPush.count, 10);
  assert.ok(budget.readyToFirstPush.p90Ms > 0 && budget.readyToFirstPush.p90Ms <= latencyTargets.readyToFirstPushP90Ms, `ready→first push p90 ${budget.readyToFirstPush.p90Ms}ms exceeds fifteen minutes`);
  assert.equal(budget.met, true, budget.reasons.join('; '));

  // A fifteen-minute interval is an idle cadence, never a bound on how long ready work may sit:
  // with anything actionable the loop comes back inside the responsive window.
  assert.equal(cycleDelay(900_000, { actionable: 1 }), 30_000);
  assert.equal(cycleDelay(10_000, { actionable: 3 }), 10_000, 'a shorter configured interval still wins');
  assert.equal(cycleDelay(900_000, { actionable: 0 }), 900_000);
  assert.equal(cycleDelay(900_000, null), 900_000);
});

test('integration:loop-liveness — an absent or stalled loop is the top attention item with the command that restarts it, the loop keeps its supervisor\'s watchdog fed per cycle, and the packaged unit restarts it without a person', async () => {
  const master = config({ workers: [] });
  const intervalMs = master.run.intervalSeconds * 1000;
  const now = clockStart + 10 * minute;
  const state = emptyDaemonState(master);

  // Nothing has ever cycled: no other attention item on the list would say why.
  const absent = loopLiveness(state, now, intervalMs, master.hostId);
  assert.equal(absent.state, 'absent');
  assert.match(absent.detail, /No master loop holds this repository and none has ever cycled/);
  assert.match(absent.restart, /^graphyard master restart/);
  const absentItems = loopAttention({ liveness: absent });
  assert.equal(absentItems[0].subject, 'loop');
  assert.equal(absentItems[0].role, 'master');
  assert.equal(absentItems[0].human, false);
  assert.match(absentItems[0].next, /graphyard master restart/);
  assert.match(absentItems[0].next, /systemctl --user restart graphyard-master/);

  // A lock whose process is gone on this host is an absence, not a stall.
  state.lock = { id: 'lock', pid: 2 ** 22 - 1, host: master.hostId, startedAt: new Date(clockStart).toISOString(), heartbeatAt: new Date(now - minute).toISOString() };
  state.lastCycleAt = new Date(now - minute).toISOString();
  state.cycle = 12;
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId).state, 'absent');
  assert.match(loopLiveness(state, now, intervalMs, master.hostId).detail, /names a process that is gone/);

  // A live process that has not completed a cycle for more than two intervals is stalled.
  state.lock = { ...state.lock, pid: process.pid };
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId).state, 'stalled');
  const stalled = loopAttention({ liveness: loopLiveness(state, now, intervalMs, master.hostId) });
  assert.match(stalled[0].text, /has not completed a cycle for 60s, past the two-interval bound of 40s/);
  assert.match(stalled[0].next, /graphyard master restart/);
  // Inside two intervals it is simply running, and raises nothing.
  state.lastCycleAt = new Date(now - 30_000).toISOString();
  assert.equal(loopLiveness(state, now, intervalMs, master.hostId).state, 'running');
  assert.deepEqual(loopAttention({ liveness: loopLiveness(state, now, intervalMs, master.hostId) }), []);
  // The same judgement reaches `master status` through the daemon summary it reads.
  const summary = daemonSummary(state, now, intervalMs, master.hostId);
  assert.equal(summary.liveness.state, 'running');
  assert.equal(summary.silence.actionable, 0);
  assert.equal(summary.budget.met, null, 'no delivery measured yet');

  // Self-healing: under a supervisor that watches for keep-alives, the loop reports ready once and
  // alive after every completed cycle, so a cycle that hangs becomes a restart.
  const simulation = plane([{ key: 'GY-600', rounds: ['pass'] }]);
  const notified: string[] = [];
  const log: string[] = [];
  const supervised = emptyDaemonState(master);
  await runDaemon(master, supervised, simulation.effects({ notify: signal => { notified.push(signal); } }), {
    once: true, intervalMs, identity: { pid: process.pid, host: master.hostId }, now: simulation.now, log: line => log.push(line), signals: [],
    environment: { NOTIFY_SOCKET: '/run/user/1000/systemd/notify', WATCHDOG_USEC: String(180 * 1_000_000) },
  });
  assert.deepEqual(notified, ['ready', 'alive']);
  assert.match(log.join('\n'), /cycle 0 complete in \d+ms \(\d+ms waiting on child processes\); 1 open, 1 actionable, \d+ action\(s\)/, 'the cycle log carries both halves');
  const unsupervised: string[] = [];
  await runDaemon(master, emptyDaemonState(master), simulation.effects({ notify: signal => { unsupervised.push(signal); } }), {
    once: true, intervalMs, identity: { pid: process.pid, host: master.hostId }, now: simulation.now, log: () => {}, signals: [], environment: {},
  });
  assert.deepEqual(unsupervised, [], 'a loop nobody supervises talks to no supervisor');

  // A watchdog window that would restart a healthy loop mid-cycle is named, not obeyed silently.
  assert.deepEqual(watchdogPlan({}, intervalMs), { supervised: false, windowMs: null, refusal: null });
  assert.equal(watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(180 * 1_000_000) }, intervalMs).refusal, null);
  const tight = watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(30 * 1_000_000) }, intervalMs);
  assert.match(tight.refusal!, /watchdog window \(30s\) is not longer than two cycle intervals \(40s\)/);
  const noted = emptyDaemonState(master);
  await runDaemon(master, noted, simulation.effects(), { once: true, intervalMs, identity: { pid: process.pid, host: master.hostId }, now: simulation.now, log: () => {}, signals: [],
    environment: { NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(30 * 1_000_000) } });
  assert.ok(Object.values(noted.actions).some(action => action.kind === 'escalation' && /watchdog window/.test(action.detail)), 'the mismatch is recorded where master status reads it');

  // The report `master status` prints puts it first, ahead of every work item, and counts it.
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-loop-'));
  const root = await mkdtemp(join(tmpdir(), 'graphyard-loop-root-'));
  try {
    const credential = join(directory, 'coordinator.token');
    await writeFile(credential, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    execFileSync('git', ['init', '-q', root]);
    const reported = config({ credentialFile: credential, workers: [] });
    await writeDaemonState(reported, emptyDaemonState(reported));
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, reported, masterApi, { actor: { id: 'coordinator-1' } }, { commit: null });
    assert.equal(report.attentionItems[0].subject, 'loop', `the top attention item: ${JSON.stringify(report.attentionItems[0])}`);
    assert.match(report.attentionItems[0].text, /No master loop holds this repository/);
    assert.match(report.attentionItems[0].next, /graphyard master restart/);
    assert.equal(report.counts.attention, 1, 'and it is counted, so a quiet installation is not reported as all clear');
    assert.equal((report.daemon as { liveness: { state: string } }).liveness.state, 'absent');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }

  // And the packaged deployment restarts the loop on its own, however it stopped.
  const unit = await readFile(new URL('../examples/master/graphyard-master.service', import.meta.url), 'utf8');
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=\d+$/m);
  // In [Unit]: in [Service] systemd ignores it, and a crash loop would be left dead.
  const sections = Object.fromEntries(unit.split(/^\[(\w+)\]$/m).slice(1).reduce<[string, string][]>((pairs, part, index, parts) => index % 2 ? [...pairs, [parts[index - 1], part]] : pairs, []));
  assert.match(sections.Unit, /^StartLimitIntervalSec=0$/m);
  assert.match(sections.Service, /^NotifyAccess=all$/m);
  const window = Number(/^WatchdogSec=(\d+)$/m.exec(sections.Service)![1]) * 1000;
  assert.ok(window > 2 * intervalMs, `the packaged watchdog window ${window}ms must exceed two default intervals`);
  assert.equal(watchdogPlan({ NOTIFY_SOCKET: '/run/notify', WATCHDOG_USEC: String(window * 1000) }, intervalMs).refusal, null, 'the packaged unit and the default interval agree');
});

test('routine decisions rest on what the loop verified and are supervised to the end: a fence nobody verified withholds rework and recovery, a merge decision bound to an earlier candidate is withdrawn, a decision the server fails is requested again, and the merge wait is raised again as its approver changes', async t => {
  const host = await approverHost({ workers: [profile('claude-a')], autoMerge: false });
  t.after(host.cleanup);
  const master = host.master;

  // The attestation, from the item alone. A live lease or a fence in its grace window is waited
  // out; a lapsed fence is attested only on this host's verification; an unverified one withholds.
  const verdictAt = '2031-03-01T09:20:00Z', at = Date.parse('2031-03-01T09:30:00Z');
  const sha = hex('candidate'), baseSha = hex('base');
  const candidate = { sha, baseSha, pr: 7, branch: 'graphyard/gy-700-1', author: 'worker', createdAt: verdictAt };
  const reviewed = { id: 'id-GY-700', key: 'GY-700', stage: 'review', epoch: 1, policyRevision: 1, lease: null, submission: { epoch: 1, pr: 7 }, reworkRequested: false, candidate, violations: [], gates: [], workspaces: [],
    observation: { candidate, reviews: [{ reviewer: 'graphyard-reviewer[bot]', sha, state: 'CHANGES_REQUESTED', submittedAt: verdictAt }], at: verdictAt } } as unknown as Work;
  const fence = (lapsedAt: number) => ({ owner: 'claude-a-principal', epoch: 1, at: verdictAt, settlementHash: 'f'.repeat(64), leaseExpiresAt: new Date(lapsedAt).toISOString(), launchExpiresAt: new Date(lapsedAt).toISOString(), scope: { unit: 'graphyard-watch-1.scope', pid: 4242 } });
  const assessed = (settleable: boolean, refusals: string[] = []) => ({ key: 'GY-700', id: 'id-GY-700', epoch: 1, owner: 'claude-a-principal', at: verdictAt, host: 'machine-a', workspacePath: null, scope: null, settleable, refusals, attestation: '', verification: null }) as ContainmentAssessment;
  assert.match(routineDecision(reviewed, master, at)!.reason, /The previous worker is stopped: GY-700 holds no lease and no containment fence stands for it\.$/);
  const inGrace = { ...reviewed, containmentQuarantine: fence(at - containmentGraceMs / 2) } as Work;
  assert.equal(routineDecision(inGrace, master, at, assessed(true)), null, 'a fence still inside its grace window is waited out, verified or not');
  assert.equal(withheldDecision(inGrace, master, at, assessed(true)), null, 'and waiting it out is not an escalation');
  const lapsed = { ...reviewed, containmentQuarantine: fence(at - 2 * containmentGraceMs) } as Work;
  assert.equal(routineDecision(lapsed, master, at), null, 'a lapsed fence alone attests nothing');
  assert.equal(routineDecision(lapsed, master, at, assessed(false, ['Process 4242 is still present'])), null);
  assert.deepEqual(workerStopped(lapsed, at, assessed(false, ['Process 4242 is still present'])), { stopped: false, grounds: '', unverified: 'Process 4242 is still present' });
  assert.match(withheldDecision(lapsed, master, at, assessed(false, ['Process 4242 is still present']))!.reason, /GY-700 needs a rework decision, but it attests that the previous worker is stopped and that is not verified: Process 4242 is still present/);
  assert.equal(routineDecision(lapsed, master, at, { ...assessed(true), epoch: 9 }), null, 'a verification of another epoch is not a verification of this fence');
  assert.match(routineDecision(lapsed, master, at, assessed(true))!.reason, /the master loop verified on machine-a that the supervisor of epoch 1 is gone\.$/);
  const delivered = { ...lapsed, stage: 'done' } as Work;
  assert.equal(routineDecision(delivered, master, at, assessed(false, ['Epoch 1 is registered on host machine-b; automatic verification must run there'])), null, 'recovery lowers the same fence on the same attestation');
  assert.equal(routineDecision(delivered, master, at, assessed(true))!.action, 'recover');
  assert.equal(routineDecision({ ...delivered, containmentQuarantine: fence(at - containmentGraceMs / 2) } as Work, master, at, assessed(true)), null);

  // The same in the cycle. A verdict stands, the worker's fence lapsed, and this host cannot
  // verify its supervisor gone: the loop requests nothing, and says so once where a master reads it.
  const simulation = plane([{ key: 'GY-701', rounds: ['changes', 'pass'] }], { host, judgements: ['fail', 'die', 'approve'] });
  const state = emptyDaemonState(master);
  let verified = false;
  const effects = simulation.effects({ containment: items => Object.fromEntries(items.filter(entry => entry.containmentQuarantine).map(entry => [entry.id,
    { ...assessed(verified, verified ? [] : ['Process 4242 is still present']), key: entry.key, id: entry.id, epoch: entry.containmentQuarantine!.epoch }])), settleContainment: undefined });
  const item = simulation.work[0];
  while (!standingVerdict(item)) await cycle(state, master, simulation, effects);
  item.containmentQuarantine = { ...fence(simulation.now() - 2 * containmentGraceMs), epoch: item.epoch };
  const held = await cycle(state, master, simulation, effects);
  assert.deepEqual(simulation.decisions.get(item.id) ?? [], [], 'no rework is requested on an attestation nobody verified');
  assert.deepEqual(held.actions.filter(action => action.kind === 'escalation').map(action => /cannot be settled automatically: Process 4242 is still present/.test(action.detail)), [true]);
  assert.ok(held.silence.subjects.some(subject => subject.kind === 'decision' && /is not verified: Process 4242 is still present/.test(subject.detail)), 'and the withheld decision stays on the silence measure');

  // The probe verifies it. Rework is requested on those grounds — and the engine refuses to apply
  // the first decision, which the loop reads back and requests again; the second one's first
  // approver dies, its second approves. One round, three sessions, no master session.
  verified = true;
  const performed: DaemonAction[] = [];
  for (let pass = 0; pass < 8 && !item.reworkRequested && item.epoch === 1; pass++) performed.push(...(await cycle(state, master, simulation, effects)).actions);
  const reworks = simulation.decisions.get(item.id)!;
  assert.deepEqual(reworks.map(decision => [decision.action, decision.state]), [['rework', 'failed'], ['rework', 'applied']]);
  assert.match(reworks[0].reason, /the master loop verified on machine-a that the supervisor of epoch 1 is gone\.$/);
  assert.ok(performed.some(action => action.kind === 'decision' && action.state === 'failed' && /ended failed \(Worker startup remains fenced.*still needs it, so it is requested again/.test(action.detail)), performed.map(action => action.detail).join('\n'));
  assert.deepEqual(simulation.sessions.log.filter(entry => entry.startsWith('launch:')).map(entry => entry.slice(7)), [reworks[0].id, reworks[1].id, reworks[1].id].map(id => approverSessionName(item, id)));

  // Automatic merging off. The second attempt goes green while a merge decision for an earlier
  // head still stands `requested`; the server would refuse a second request, so the loop — its
  // requester — withdraws the one that can never apply and asks for the candidate that is mergeable.
  simulation.sessions.judgements.push('die', 'approve');
  while (!mergeableCandidate(simulation.work[0])) await cycle(state, master, simulation, effects);
  const earlier = { id: uuid('earlier-merge'), action: 'merge', state: 'requested', input: { sha: hex('an-earlier-head'), baseSha: item.candidate!.baseSha, policyRevision: 1 }, approvedBy: null, reason: 'requested for the head before the rework', outcome: null };
  simulation.decisions.set(item.id, [...reworks, earlier]);
  const merging: DaemonAction[] = [];
  for (let pass = 0; pass < 8 && item.stage !== 'done'; pass++) merging.push(...(await cycle(state, master, simulation, effects)).actions);
  assert.equal(item.stage, 'done', steps(merging).join(', '));
  const merges = simulation.decisions.get(item.id)!.filter(decision => decision.action === 'merge');
  assert.deepEqual(merges.map(decision => [decision.state, decision.input.sha]), [['withdrawn', hex('an-earlier-head')], ['applied', item.candidate!.sha]]);
  // The wait names the decision and the session it is with, so it is raised again when the first
  // approver dies and a second takes over — not recorded once and never looked at again.
  const waits = merging.filter(action => action.kind === 'escalation').map(action => action.detail);
  assert.equal(waits.length, 2, waits.join('\n'));
  assert.match(waits[0], new RegExp(`\\(launch 1 of 3\\) applies merge decision ${merges[1].id}`));
  assert.match(waits[1], new RegExp(`\\(launch 2 of 3\\) applies merge decision ${merges[1].id}`));
  assert.equal(merging.filter(action => action.kind === 'merge' && action.state === 'done').length, 1);
  assert.deepEqual([...simulation.sessions.sessions.keys()], [], 'every approver tab was closed');

  // An item with no review gate was never approved, so it starts no approval→merge passage.
  const clocks = emptyDaemonState(master);
  const unreviewed = { ...reviewed, observation: { ...reviewed.observation!, reviews: [] }, gates: [{ name: 'build', passed: true, reasons: [] }] } as Work;
  observeItemClock(clocks, unreviewed, at);
  assert.equal(clocks.clocks[unreviewed.id].approvedAt, null);
  observeItemClock(clocks, { ...unreviewed, gates: [...unreviewed.gates, { name: 'review', passed: true, reasons: [] }] } as Work, at);
  assert.equal(clocks.clocks[unreviewed.id].approvedAt, new Date(at).toISOString());

  // A loop killed between requesting a decision and recording it resumes to something it will
  // act on: requested again (and the standing request adopted), or supervised from its watch.
  const interrupted = emptyDaemonState(master), key = decisionKey(reviewed, { action: 'rework', binding: sha });
  interrupted.actions[key] = { kind: 'decision', work: 'GY-700', principal: null, state: 'started', detail: 'Requesting the rework decision for GY-700', attempts: 1, epoch: 1, cycle: 3, at: verdictAt };
  assert.deepEqual(reconcilePendingActions(interrupted, [reviewed], at).map(action => action.state), ['failed']);
  interrupted.actions[key].state = 'started';
  interrupted.approvals[key] = approvalWatchSchema.parse({ work: 'GY-700', action: 'rework', decision: uuid('standing'), requestedAt: verdictAt });
  assert.deepEqual(reconcilePendingActions(interrupted, [reviewed], at).map(action => action.state), ['done']);
});

test('a requested round is requested once, a request the item moved past is taken back, a refused action is not the loop acting, and a loop with no operator-agent identity escalates instead of failing', async t => {
  const host = await approverHost({ workers: [profile('claude-a')] });
  t.after(host.cleanup);
  const master = host.master;

  // A base conflict returns the head to a worker; the round's worker dies before pushing. The
  // conflict still matches that head — the engine's `rework` never clears it — but the round is
  // already requested: the loop settles the dead worker's fence and dispatches, and asks for nothing.
  const simulation = plane([{ key: 'GY-720', rounds: ['conflict', 'die', 'pass'] }], { host });
  const state = emptyDaemonState(master), effects = simulation.effects(), item = simulation.work[0];
  const performed: DaemonAction[] = [];
  for (let pass = 0; pass < 40 && item.stage !== 'done'; pass++) performed.push(...(await cycle(state, master, simulation, effects)).actions);
  assert.equal(item.stage, 'done', steps(performed).join(', '));
  assert.equal(item.epoch, 3, 'the conflicted head, the round whose worker died, and the round that delivered');
  assert.deepEqual(simulation.decisions.get(item.id)!.map(decision => [decision.action, decision.state]), [['rework', 'applied']], 'one conflict, one rework decision');
  assert.equal(simulation.sessions.log.filter(entry => entry.startsWith('launch:')).length, 1, 'and one approver session spent on it');
  assert.ok(performed.some(action => action.kind === 'settle' && action.state === 'done'), 'the dead round was recovered by settling its fence, not by a second decision');

  // A verdict stands and its rework is with an approver that has not judged it when an operator
  // requests the round by hand. The item has moved past the loop's request, so the loop — its
  // requester — takes it back rather than leaving it to be adopted for some later round.
  const moved = plane([{ key: 'GY-721', rounds: ['changes', 'pass'] }], { host, judgements: ['hang'] });
  const movedState = emptyDaemonState(master), movedEffects = moved.effects(), overtaken = moved.work[0];
  while (!(moved.decisions.get(overtaken.id) ?? []).length) await cycle(movedState, master, moved, movedEffects);
  const asked = moved.decisions.get(overtaken.id)![0];
  assert.equal(asked.state, 'requested');
  Object.assign(overtaken, { reworkRequested: true }); moved.recompute(overtaken);
  const after = await cycle(movedState, master, moved, movedEffects);
  assert.equal(asked.state, 'withdrawn', steps(after.actions).join(', '));
  assert.match(asked.outcome!, /GY-721 moved past the rework this decision asked for before any approver judged it/);
  assert.ok(after.actions.some(action => action.kind === 'decision' && action.state === 'done' && new RegExp(`Withdrew rework decision ${asked.id}`).test(action.detail)));
  assert.deepEqual(Object.keys(movedState.approvals), [], 'its watch is retired');
  assert.ok(!moved.sessions.sessions.has(approverSessionName(overtaken, asked.id)), 'and its approver tab closed');

  // A request the item still calls for, which the loop merely cannot attest this cycle, is not
  // one it moved past: it stays requested, and is adopted once the worker is verified stopped.
  let verified = true;
  const withheld = plane([{ key: 'GY-722', rounds: ['changes', 'pass'] }], { host, judgements: ['hang', 'approve'] });
  const withheldState = emptyDaemonState(master), waiting = withheld.work[0];
  const withheldEffects = withheld.effects({ settleContainment: undefined, containment: items => Object.fromEntries(items.filter(entry => entry.containmentQuarantine).map(entry => [entry.id,
    { key: entry.key, id: entry.id, epoch: entry.containmentQuarantine!.epoch, owner: entry.containmentQuarantine!.owner, at: entry.containmentQuarantine!.at, host: 'machine-a', workspacePath: null, scope: null,
      settleable: verified, refusals: verified ? [] : ['Process 4242 is still present'], attestation: '', verification: null } as ContainmentAssessment])) });
  while (!(withheld.decisions.get(waiting.id) ?? []).length) await cycle(withheldState, master, withheld, withheldEffects);
  const standing = withheld.decisions.get(waiting.id)![0];
  const lapsedAt = withheld.iso(withheld.now() - 2 * containmentGraceMs);
  waiting.containmentQuarantine = { owner: 'claude-a-principal', epoch: waiting.epoch, at: lapsedAt, settlementHash: 'f'.repeat(64), leaseExpiresAt: lapsedAt, launchExpiresAt: lapsedAt, scope: { unit: 'graphyard-watch-1.scope', pid: 4242 } };
  verified = false;
  await cycle(withheldState, master, withheld, withheldEffects);
  assert.equal(standing.state, 'requested', 'a withheld decision is not withdrawn');
  verified = true;
  for (let pass = 0; pass < 6 && !waiting.reworkRequested; pass++) await cycle(withheldState, master, withheld, withheldEffects);
  assert.deepEqual(withheld.decisions.get(waiting.id)!.map(decision => [decision.id, decision.state]), [[standing.id, 'applied']], 'the same request is adopted and applied; no second one is made');

  // Only an action that succeeded restarts a subject's wait. A request refused on every retry
  // reaches the twenty-minute bound like any other silence.
  const silent = emptyDaemonState(master), start = Date.parse('2031-03-01T09:00:00Z');
  const subject = [{ key: 'decision:GY-730', kind: 'decision' as const, work: 'GY-730', detail: 'GY-730 needs a rework decision' }];
  const acted = (outcome: DaemonAction['state']): DaemonAction[] => [{ kind: 'decision', work: 'GY-730', principal: null, state: outcome, detail: 'Requesting the rework decision', attempts: 1, epoch: 1, cycle: 1, at: new Date(start).toISOString() }];
  trackSilence(silent, subject, [], start);
  assert.equal(trackSilence(silent, subject, acted('failed'), start + 15 * minute).longestIdleMs, 15 * minute, 'a refusal is not the loop acting');
  const breached = trackSilence(silent, subject, acted('failed'), start + 30 * minute);
  assert.equal(breached.breached, true);
  assert.equal(breached.longest!.key, 'decision:GY-730');
  assert.equal(trackSilence(silent, subject, acted('done'), start + 31 * minute).longestIdleMs, 0, 'a request that lands is');

  // No operator-agent identity: the wired loop has no decision effects at all, so a routine
  // decision is the escalation naming the two commands — not a request that fails on every retry —
  // and provisioning the identity brings the effects back on the next reload, with no restart.
  let live: MasterConfig = { ...master, operatorAgent: undefined } as MasterConfig;
  const bare = daemonEffects(host.root, () => live, { snapshot: async () => ({ work: [], now: simulation.iso() }), mutate: async () => { throw new Error('not used'); }, executor: { principal: 'coordinator', instance: 'unattended-cycle' }, run: simulation.sessions.run });
  assert.deepEqual([bare.decide, bare.approver, bare.withdraw, bare.decisions], [undefined, undefined, undefined, undefined]);
  const degraded = plane([{ key: 'GY-740', rounds: ['changes', 'pass'] }], { host });
  const degradedState = emptyDaemonState(live), degradedEffects = degraded.effects({ decide: bare.decide, approver: bare.approver, withdraw: bare.withdraw, decisions: bare.decisions });
  const raised: DaemonAction[] = [];
  while (!standingVerdict(degraded.work[0])) await cycle(degradedState, live, degraded, degradedEffects);
  for (let pass = 0; pass < 3; pass++) raised.push(...(await cycle(degradedState, live, degraded, degradedEffects)).actions);
  assert.deepEqual(raised.filter(action => action.kind === 'decision'), [], 'nothing is requested, so nothing fails');
  const escalations = raised.filter(action => action.kind === 'escalation');
  assert.equal(escalations.length, 1, 'raised once');
  assert.match(escalations[0].detail, /GY-740 needs a rework decision: .*graphyard master decide GY-740 rework REASON, then graphyard master approver GY-740 DECISION/);
  live = master;
  assert.deepEqual([bare.decide, bare.approver, bare.withdraw, bare.decisions].map(effect => typeof effect), ['function', 'function', 'function', 'function']);
});

test('an agent or Codex review that has not approved is not a verdict: a head not yet dispatched, one a reviewer is still working on, and one whose profiles are exhausted are asked for nothing and keep their proofs, and only a changes-requested verdict for the exact head and request sends it back', async t => {
  const host = await approverHost({ workers: [profile('claude-a')] });
  t.after(host.cleanup);
  const master = host.master;

  // A worker submits: `complete` ends the lease, so from the next cycle the loop may attest that
  // the worker is stopped. Everything it does next rests on what the review observation says.
  const simulation = plane([{ key: 'GY-730', rounds: ['pass'] }], { host });
  const item = simulation.work[0];
  await cycle(emptyDaemonState(master), master, simulation, simulation.effects());
  assert.ok(item.submission && item.candidate && !item.lease, 'the head is submitted and its worker is gone');
  const head = item.candidate!.sha, reviewer = { name: 'claude-review', runtime: 'claude', reviewerApp: 'claude-app', timeoutSeconds: 1800 };
  item.policy = { ...item.policy, reviewProvider: 'agent', reviewerProfiles: [reviewer] } as Work['policy'];
  const request = { commentId: 501, sha: head, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, body: '@claude review', createdAt: simulation.iso(),
    provider: 'agent' as const, profile: reviewer.name, reviewerApp: reviewer.reviewerApp, marker: uuid('GY-730-request') };
  const refusal = (reason: string, extra: Record<string, unknown> = {}) => ({ provider: 'agent' as const, sha: head, approved: false, reason, profile: reviewer.name, reviewerApp: reviewer.reviewerApp, ...extra });
  const observe = (agentReview: NonNullable<Work['observation']>['agentReview'], changes: Partial<Work> = {}) => {
    Object.assign(item, { reviewRequest: null, reviewFailovers: [], ...changes });
    item.observation = { ...item.observation!, at: simulation.iso(), agentReview };
    simulation.recompute(item);
  };
  /** One cycle of the real loop from a loop that has seen nothing, with the proof requests it made. */
  const run = async () => {
    const proofs: string[] = [];
    const result = await runCycle(master, emptyDaemonState(master), simulation.effects({ requestProof: work => { proofs.push(work.key); } }), simulation.now);
    return { proofs, actions: result.actions };
  };
  const at = simulation.now() + minute;

  // Every state the observers report short of approval, as they report it (src/agent-review.ts,
  // `observeAgent` in src/github.ts). None is a verdict, and each would have read as one.
  const unreviewed: [string, () => void][] = [
    ['not dispatched', () => observe(refusal('Graphyard must dispatch a review to this profile bound to this candidate and policy'))],
    ['waiting', () => observe(refusal(`Waiting for reviewer profile ${reviewer.name} to post a verdict through its registered App`), { reviewRequest: request })],
    ['exhausted profiles', () => observe({ provider: 'agent', sha: head, approved: false, reason: 'Every configured reviewer profile is exhausted for this candidate; add reviewer capacity or select another review provider' },
      { reviewFailovers: [{ profile: reviewer.name, reviewerApp: reviewer.reviewerApp, runtime: reviewer.runtime, exhaustion: 'timeout', reason: 'no verdict', at: simulation.iso(), sha: head, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, requestCommentId: request.commentId, nextProfile: null }] })],
  ];
  for (const [name, arrange] of unreviewed) {
    arrange();
    assert.equal(standingVerdict(item), null, `${name}: no verdict stands`);
    assert.equal(routineDecision(item, master, at), null, `${name}: no decision is needed`);
    assert.ok(actionableSubjects(master, simulation.work, simulation.now()).some(subject => subject.kind === 'proof'), `${name}: the head's proofs are still the loop's to request`);
    const { proofs, actions } = await run();
    assert.deepEqual(actions.filter(action => action.kind === 'decision').map(action => action.detail), [], `${name}: the loop asks for no rework`);
    assert.equal((simulation.decisions.get(item.id) ?? []).length, 0, `${name}: and none reached the control plane`);
    assert.deepEqual(proofs, ['GY-730'], `${name}: the proof step still runs for the head`);
  }
  assert.deepEqual(simulation.sessions.log.filter(entry => entry.startsWith('launch:')), [], 'no approver session was spent on a head nobody has reviewed');

  // The reviewer answered the recorded request and asked for changes on this exact head.
  const verdict = refusal(`Reviewer profile ${reviewer.name} requested changes; address the findings and request a fresh review`,
    { verdict: 'changes-requested', verdictId: 902, requestId: request.commentId, completedAt: '2031-03-01T09:20:00.000Z' });
  observe(verdict, { reviewRequest: request });
  assert.deepEqual(standingVerdict(item), { reviewer: reviewer.name, at: '2031-03-01T09:20:00.000Z', reason: `${reviewer.name} requested changes on ${head.slice(0, 12)}: ${verdict.reason}` });
  assert.equal(routineDecision(item, master, at)?.action, 'rework');
  assert.ok(!actionableSubjects(master, simulation.work, simulation.now()).some(subject => subject.kind === 'proof'), 'a head going back to a worker is waiting on no proof');
  // It is the head's verdict only while it answers the head's request, on the head, unapproved,
  // under the provider the policy names: the same binding an approval must carry.
  observe(verdict, { reviewRequest: { ...request, commentId: 777 } });
  assert.equal(standingVerdict(item), null, 'a verdict for another request is not this head\'s');
  observe(verdict);
  assert.equal(standingVerdict(item), null, 'nor is one with no recorded request behind it');
  observe({ ...verdict, sha: hex('an-earlier-head') }, { reviewRequest: request });
  assert.equal(standingVerdict(item), null, 'nor one on another commit');
  observe({ ...verdict, provider: 'codex' }, { reviewRequest: request });
  assert.equal(standingVerdict(item), null, 'nor one from a provider the policy does not name');
  observe({ ...verdict, reason: 'did not approve: requested changes', verdict: undefined }, { reviewRequest: request });
  assert.equal(standingVerdict(item), null, 'and reason text is never read as a verdict');

  observe(verdict, { reviewRequest: request });
  const reworked = await run();
  assert.deepEqual(reworked.proofs, [], 'the loop requests no proof for a head that is going back');
  assert.deepEqual((simulation.decisions.get(item.id) ?? []).map(decision => [decision.action, decision.state]), [['rework', 'requested']], steps(reworked.actions).join(', '));
  assert.match(simulation.decisions.get(item.id)![0].reason, new RegExp(`${reviewer.name} requested changes on ${head.slice(0, 12)}`));

  // Codex has the same shape: running and not dispatched are no verdict; findings on the head are.
  const codex = { ...item, policy: { ...item.policy, reviewProvider: 'codex', reviewerProfiles: undefined }, reviewRequest: { commentId: 601, sha: head, baseSha: item.candidate!.baseSha, policyRevision: item.policyRevision, body: '@codex review', createdAt: simulation.iso() } } as Work;
  const codexReview = (reason: string, extra: Record<string, unknown> = {}) => ({ ...codex, observation: { ...codex.observation!, agentReview: { provider: 'codex' as const, sha: head, approved: false, reason, ...extra } } }) as Work;
  for (const reason of ['Graphyard must dispatch a review bound to this candidate and policy', 'Codex review changed or is running; retry', 'Codex has not completed a supported review of this candidate'])
    assert.equal(standingVerdict(codexReview(reason)), null, reason);
  assert.equal(standingVerdict(codexReview('Codex posted review findings/output for this request; fix them and request a fresh clean review', { verdict: 'changes-requested', requestId: 601, completedAt: '2031-03-01T09:25:00.000Z' }))?.reviewer, 'codex');
});
