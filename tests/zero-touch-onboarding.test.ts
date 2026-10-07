import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { Goal } from '../src/model/goal.js';
import { acceptanceDraftSchema, draftFiles } from '../src/model/goal.js';
import { acceptanceStep, clearDrafts, draftsSettled, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { clearPlans, plannerStep, plansSettled, type PlannerEffects } from '../src/daemon/planner.js';
import { recordLanding } from '../src/server/routes/goals.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { approverAgentCapabilities, masterOperatorCapabilities } from '../src/master/harness.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import { CHECK_NAME, LANDABLE_CHECK } from '../src/model/work.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import type { UpDependencies, UpEvent } from '../src/up.js';
import { FakeGitHub, type Actor, type FakeApp } from './helpers/fake-github.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1481: zero-touch onboarding as a release gate. `graphyard up --agent --goal FILE` runs on a
 * throwaway repository against an in-process GitHub (tests/helpers/fake-github.ts) and a real control
 * plane, with every agent runtime stubbed, and the system must reach a merged first planned item with
 * no person acting anywhere but GitHub's one App approval, which the fake GitHub approves itself.
 *
 * Each child command `up` runs is answered with the effect the real command has (the install creates
 * the Apps through the manifest flow and protects the base branch, `master autonomy` provisions the
 * master's identities on the control plane, `goal` records the goal); nothing in this world decides for
 * Graphyard. The loop is played by its steps: the real acceptance and planner steps, and the gates of
 * each submitted item answered by the loop's reviewer, GitHub Actions and the proof producer, merged
 * by the control-plane App once the control plane's gates pass. Whatever a person would still have to
 * do — a handoff `up` emits, a wait on the Setup page, a review or merge by hand, an item parked or
 * blocked, a stall in any step — fails the test and names the step.
 */
const repository = 'acme/shop';
const operator: Principal = { id: 'acme-shop-operator', role: 'admin', sessionKind: 'human' };
const master: Principal = { id: 'acme-shop-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'acme-shop-worker', role: 'worker', sessionKind: 'ai' };
const producer: Principal = { id: 'acme-shop-producer', role: 'producer', sessionKind: 'ai' };
const credentials = [operator, master, worker, producer].map(principal => ({ ...principal, token: `${principal.id}-${randomBytes(24).toString('hex')}` }));
const tokenOf = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/bin/graphyard', repository, baseBranch: 'main',
  githubAppId: 901, hostId: 'zero-touch', masterAgentName: 'graphyard-master-shop', autoMerge: true, mergeMethod: 'merge', workers: [] });

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
before(async () => {
  const port = await freePort();
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('zero-touch-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('zero_touch');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/zero_touch`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null);
  await new Promise<void>(accept => http.listen(0, '127.0.0.1', accept));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { clearDrafts(); clearPlans(); if (http) await new Promise<void>(accept => http.close(() => accept())); if (store) await store.close(); if (database) await database.stop(); });

/** The control plane's API with a bearer TOKEN; a refusal throws with its answer. */
async function api(token: string, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} /api/${path} refused (${response.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/** A stubbed agent runtime: answers its role's one tool with RESPOND's payload, through the run's own validation. */
function stubRuntime(respond: (options: RunOptions<unknown>) => unknown, runs: string[]): Runner {
  return { name: 'stub', start<T>(_prompt: string, options: RunOptions<T>) {
    runs.push(String(options.env?.GRAPHYARD_PI_ROLE ?? options.tool));
    let result: RunResult<T>;
    try { const payload = options.validate(respond(options as RunOptions<unknown>)); result = { ok: true, tool: options.tool, payload, payloads: [payload] }; }
    catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
}

/** The repository's goal, in the operator's own words, as `up --goal FILE` reads it. */
const goalText = 'Shoppers can see what is in their basket before they pay';

test('unit:zero-touch-onboarding — `graphyard up --agent --goal FILE` on a fresh repository reaches a merged first planned item, the onboarding change merged through the loop\'s reviewer and the goal accepted and planned by their roles, with no human step but GitHub\'s one App approval', { timeout: 300_000 }, async () => {
  clearDrafts(); clearPlans();
  const { runUp, upRequestFromArgs } = await import('../src/up.js');
  const root = await temporaryDirectory('zero-touch-repo');
  const installDirectory = join(root, '.install');
  await mkdir(join(installDirectory, 'tokens'), { recursive: true });
  const operatorTokenFile = join(installDirectory, 'tokens', `${operator.id}.token`);
  await writeFile(operatorTokenFile, tokenOf(operator), { mode: 0o600 });
  await writeFile(join(root, 'goal.md'), `${goalText}\n`);

  const github = new FakeGitHub(repository, { autoApprove: true });
  const world = {
    installed: false, accounts: false, loop: false,
    controlPlane: null as FakeApp | null, reviewer: null as FakeApp | null,
    /** The master's agent identities once `master autonomy` provisioned them. */
    operatorAgent: null as string | null, approver: null as string | null,
    calls: [] as string[], runs: [] as string[], events: [] as UpEvent[],
    /** Each step of the scenario that stalled or needed a person, by name. */
    stalls: [] as string[],
  };
  let clock = Date.parse('2026-10-07T00:00:00Z');

  // ---- The loop, played by its steps ----------------------------------------------------------------
  const cycle = () => ({ config, state, now: () => clock, clock, snapshot: { work: [] }, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() });
  const state = emptyDaemonState(config);
  const intent = () => { if (!world.operatorAgent) throw new Error('the master has no operator-agent identity'); return world.operatorAgent; };
  const judge = () => { if (!world.approver) throw new Error('the master has no approver identity'); return world.approver; };
  const pullOf = (pr: number) => { const pull = github.pull(pr); return { state: pull.merged ? 'merged' as const : pull.state, mergeSha: pull.mergeSha, head: pull.head.sha }; };
  const acceptance: AcceptanceEffects = {
    settings: diagnosticianSettings({}), cwd: root,
    goals: async () => (await api(tokenOf(master), 'GET', 'goals?open=1')).goals,
    runner: async (role, attempt, goal) => ({ runtime: 'stub', model: attempt, runner: stubRuntime(() => role === 'judge'
      ? { goal: goal.key, verdict: 'approve', reason: 'The outcome is what a shopper asked for and its case checks it' }
      : { goal: goal.key, outcomes: [{ id: 'basket-view', title: 'A shopper sees their basket', criteria: ['The basket page lists what was added'],
        case: { id: 'basket-view', title: 'The basket answers', tags: ['api'], target: 'uat', required: true, steps: [{ kind: 'http', name: 'read the basket', method: 'GET', path: '/api/board', status: 200 }] } }] }, world.runs) }),
    open: async (goal, draft) => {
      const branch = `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`;
      const head = github.push(branch, Object.fromEntries(draftFiles(acceptanceDraftSchema.parse(draft), null).map(file => [file.path, file.content])), `${goal.key}: acceptance cases`, `app:${world.controlPlane!.slug}`);
      const pull = github.openPull({ head: branch, title: `${goal.key}: acceptance`, body: goal.statement }, `app:${world.controlPlane!.slug}`);
      return { pr: pull.number, branch, head };
    },
    draft: async (goal, input) => api(intent(), 'POST', `goals/${goal.key}/draft`, input, `acceptance:${goal.id}:${goal.revision}`),
    judge: async (goal, judgement) => api(judge(), 'POST', `goals/${goal.key}/${judgement.verdict}`, { reason: judgement.reason }, `acceptance:${goal.id}:${goal.revision}:judged`),
    pullRequest: async pr => pullOf(pr),
    // The control plane's own land route, its GitHub adapter the control-plane App on the fake GitHub.
    land: async goal => { (http as any).services.github = github.landing(world.controlPlane!); return api(intent(), 'POST', `goals/${goal.key}/land`, {}, `acceptance:${goal.id}:${goal.revision}:land:${clock}`); },
    close: async pr => { github.pull(pr).state = 'closed'; },
    closed: async (goal, pr, reason) => api(intent(), 'POST', `goals/${goal.key}/closed`, { pr, reason }, `acceptance:${goal.id}:${goal.revision}:closed`),
  };
  const planner: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: root,
    goals: async () => (await api(tokenOf(master), 'GET', 'goals?open=1')).goals,
    runner: async (role, attempt, goal) => ({ runtime: 'stub', model: attempt, runner: stubRuntime(() => role === 'judge'
      ? { goal: goal.key, verdict: 'approve', reason: 'One small item a worker finishes in one change' }
      : { goal: goal.key, note: 'A small Node module under src/basket/, served by the existing API and deployed with the service.',
        items: [{ ref: 'basket', title: 'Show the basket', description: 'The basket page lists the items a shopper added', type: 'feature', priority: 1, outcomes: ['basket-view'], cases: ['basket-view'],
          criteria: [{ id: 'AC-1', text: 'The basket page lists the items a shopper added', proofs: ['unit:basket-view'] }], plannedFiles: ['src/basket/view.ts'], dependsOn: [] }] }, world.runs) }),
    plan: (goal, plan) => api(intent(), 'POST', `goals/${goal.key}/plan`, plan, `planner:${goal.id}:${goal.revision}`),
    invalid: (goal, reason) => api(intent(), 'POST', `goals/${goal.key}/plan-invalid`, { reason }, `planner:${goal.id}:${goal.revision}:invalid`),
    judge: (goal, judgement) => api(judge(), 'POST', `goals/${goal.key}/plan-${judgement.verdict}`, { reason: judgement.reason }, `planner:${goal.id}:${goal.revision}:judged`),
    release: goal => api(intent(), 'POST', `goals/${goal.key}/release`, {}, `planner:${goal.id}:${goal.revision}:release`),
    deliver: (goal, items, reason) => api(intent(), 'POST', `goals/${goal.key}/deliver`, { items, reason }, `planner:${goal.id}:${goal.revision}:deliver`),
  };
  const work = async () => await api(tokenOf(master), 'GET', 'work') as Work[];
  const observation = (item: Work, pr: number, merged = false): Observation => {
    const pull = github.pull(pr), head = pull.head.sha;
    return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: github.branches.get('main')!, pr, branch: pull.head.ref, author: pull.author },
      checks: github.checkRuns.filter(run => run.head_sha === head && run.app.id === github.actionsAppId).map(run => ({ name: run.name, result: run.conclusion, appId: run.app.id })),
      reviews: github.reviews.filter(review => review.pr === pr).map(review => ({ reviewer: review.by.replace(/^app:/, '') + '[bot]', sha: review.sha, state: review.state })),
      protected: !!github.protection, mergeable: true, merged, mergeSha: merged ? pull.mergeSha : null, ...(merged ? { mergedAt: pull.mergedAt! } : {}),
      files: [...github.files(head).keys()].filter(path => github.files('main').get(path) !== github.files(head).get(path)), scopeFiles: [], at: new Date().toISOString() } as unknown as Observation;
  };
  /** One pass of the loop's gate work over every submitted item: review, proofs, observation, merge. */
  const deliverItems = async () => {
    for (const item of await work()) {
      if (item.stage === 'done' || !item.submission?.pr) continue;
      const pr = item.submission.pr, pull = github.pull(pr), head = pull.head.sha;
      if (pull.merged) continue;
      // The loop's reviewer: a stubbed review runtime posting as the reviewer App, never the author.
      if (!github.reviews.some(review => review.pr === pr && review.sha === head && review.by === `app:${world.reviewer!.slug}`)) {
        world.runs.push('reviewer');
        github.review(pr, { sha: head, state: 'APPROVED', body: `Reviewed ${item.key} at ${head.slice(0, 12)}: no blocking findings` }, `app:${world.reviewer!.slug}`);
      }
      let current = await engine.observe(item.id, item.revision, observation(item, pr));
      // The proof producer: each criterion's proofs run at the exact head.
      for (const proof of new Set(current.criteria.flatMap(criterion => criterion.proofs))) {
        if (current.evidence.some(entry => entry.proof === proof && entry.sha === head)) continue;
        world.runs.push(`producer ${proof}`);
        current = await engine.execute(producer, 'evidence', item.id, { proof, sha: head, baseSha: github.branches.get('main')!, policyRevision: current.policyRevision, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: `${item.key}'s change`, result: 'fail', executed: 1 } }, randomUUID());
      }
      current = await engine.observe(item.id, current.revision, observation(current, pr));
      if (!current.gates.filter(gate => gate.name !== 'merge').every(gate => gate.passed)) continue;
      // The control plane publishes its App-bound verdicts and merges head-bound; GitHub enforces protection.
      for (const name of [CHECK_NAME, LANDABLE_CHECK]) github.check(head, name, 'success', world.controlPlane!.id, { external_id: item.id });
      github.merge(pr, head, `app:${world.controlPlane!.slug}`);
      await engine.observe(item.id, current.revision, observation(current, pr, true));
    }
  };
  /** A worker session: claims the first ready item no one holds, pushes its change and opens its pull request. */
  const workItems = async () => {
    const ready = (await work()).find(item => item.stage === 'ready' && !item.lease && !item.submission);
    if (!ready) return;
    world.runs.push(`worker ${ready.key}`);
    const claimed = await engine.execute(worker, 'claim', ready.id, {}, randomUUID());
    const epoch = claimed.lease!.epoch, branch = `graphyard/${ready.key.toLowerCase()}-${epoch}`;
    await engine.execute(worker, 'workspace', ready.id, { epoch, host: 'zero-touch', path: join(root, '.graphyard/worktrees', ready.key), branch }, randomUUID());
    github.push(branch, Object.fromEntries((ready.plannedFiles ?? []).map(path => [path, `export const basket = (items: string[]) => items;\n`])), `${ready.key}: ${ready.title}`, `app:${world.controlPlane!.slug}`);
    const pull = github.openPull({ head: branch, title: `${ready.key}: ${ready.title}`, body: ready.description }, `app:${world.controlPlane!.slug}`);
    await engine.execute(worker, 'submit', ready.id, { epoch, pr: pull.number }, randomUUID());
  };
  const loopTick = async () => {
    if (!world.loop) return;
    clock += 6 * 60_000;
    await acceptanceStep({ ...cycle(), effects: { acceptance, persist: async () => {} } } as unknown as Cycle); await draftsSettled();
    await plannerStep({ ...cycle(), effects: { planner, persist: async () => {} }, snapshot: { work: await work() } } as unknown as Cycle); await plansSettled();
    await workItems();
    await deliverItems();
  };

  // ---- The host `up` runs on: each child command's effect ----------------------------------------------
  const status = () => world.installed ? {
    github: !!world.controlPlane?.installationId, githubRepository: repository, appPermissions: { missing: [] },
    reviewerApps: world.reviewer?.installationId ? [{ id: 'claude', appId: world.reviewer.id }] : [],
    fleet: world.accounts ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] } : { roles: [], accounts: [] },
    setup: { protection: github.protection ? 'complete' : 'off', loop: world.loop },
  } : null;
  /** The agent's browser on the installer's App page: post the manifest, convert its code, install on this repository alone. */
  const driveApp: NonNullable<UpDependencies['driveApp']> = async (_page, handoff) => {
    // The installer serves the control-plane App's page first, then the reviewer App's, on the same address.
    const role = world.controlPlane ? 'reviewer' : 'control-plane';
    const manifest: { name: string; url: string; default_permissions: Record<string, string> } = role === 'reviewer' ? { name: 'shop review claude', url: 'https://github.com/acme/shop', default_permissions: { pull_requests: 'write' } }
      : { name: 'Graphyard shop', url: 'https://github.com/acme/shop', default_permissions: { contents: 'write', pull_requests: 'write', checks: 'write' } };
    const submitted = github.submitManifest(manifest, 'person:acme-owner');
    // GitHub's own confirmation on the account that owns the App: the one step a person approves.
    if (submitted.approval) handoff('Approve the GitHub App on github.com: GitHub asks the account owner to confirm creating it', { url: 'https://github.com/settings/apps/new' });
    if (!submitted.code) return { state: 'failed', reason: 'GitHub was not confirmed' };
    const app = github.app(github.convert(submitted.code).slug);
    github.install(app.slug, [github.repositoryId], 'person:acme-owner');
    if (role === 'reviewer') world.reviewer = app; else world.controlPlane = app;
    return { state: 'done' };
  };
  const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));
  const fileOnboardingWork = async (pullRequest: string, file: string | null, requestId: string) => {
    // GY-1478: up files the onboarding pull request as a work item the loop owns, with the operator's credential.
    const onboarding: any = await import('../src/onboarding.js');
    const token = file ? (await readFile(file, 'utf8')).trim() : '';
    return onboarding.fileOnboardingWork({ server: url, token, url: pullRequest, checks: await onboarding.onboardingChecks(root), host: 'zero-touch', path: join(root, '.graphyard', 'onboarding'), requestId });
  };
  const deps = {
    root, pollMs: 60_000, humanWaitMs: 6 * 60 * 60_000, machineWaitMs: 60 * 60_000,
    emit: (event: UpEvent) => { world.events.push(event); },
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; await yieldTurn(); await loopTick(); },
    serverUrl: async () => world.installed ? url : null,
    masterToken: async () => world.installed ? tokenOf(master) : null,
    signIn: async () => null,
    operatorToken: async (file: string | null) => file ? (await readFile(file, 'utf8')).trim() : null,
    status: async () => status(),
    work: async () => world.installed ? work() : null,
    publishOnboarding: async () => {
      const open = [...github.pulls.values()].find(pull => pull.state === 'open' && pull.head.ref === 'graphyard/onboarding');
      if (open) return { pullRequest: `https://github.com/${repository}/pull/${open.number}` };
      const files = Object.fromEntries(await Promise.all(['AGENTS.md', 'graphyard.json', '.github/workflows/graphyard.yml'].map(async path => [path, await readFile(join(root, path), 'utf8')] as const)));
      // `gh` and `git push` with the operator's stored login: a command acting, not a person.
      github.push('graphyard/onboarding', files, 'Add Graphyard onboarding', 'cli:acme-owner');
      const pull = github.openPull({ head: 'graphyard/onboarding', title: 'Add Graphyard onboarding', body: 'The files graphyard up wrote while onboarding this repository' }, 'cli:acme-owner');
      return { pullRequest: `https://github.com/${repository}/pull/${pull.number}` };
    },
    onboardingMerged: async (pullRequest: string) => github.pull(Number(pullRequest.split('/').pop())).merged,
    fileOnboarding: fileOnboardingWork,
    driveApp,
    async cli(args: string[], options: { stdin?: string; env?: Record<string, string>; onLine?: (line: string) => void } = {}) {
      const joined = args.join(' ');
      world.calls.push(joined);
      if (args[0] === 'install' && args.includes('--plan'))
        return { code: 0, stdout: JSON.stringify({ installId: 'acme-shop', installDirectory, principals: [{ id: operator.id, role: 'admin', sessionKind: 'human', tokenFile: operatorTokenFile }, { id: master.id, role: 'coordinator', sessionKind: 'ai' }], preflight: [{ name: 'GitHub CLI', ok: true }, { name: 'Docker', ok: true }] }) };
      if (args[0] === 'install' && args.includes('--apply')) {
        world.installed = true;
        // The installer serves one manifest page per App and waits for each to be created and installed.
        for (const app of ['controlPlane', 'reviewer'] as const) {
          options.onLine?.(`Open http://127.0.0.1:4311 in a browser on this machine and confirm the ${app === 'reviewer' ? 'reviewer' : 'Graphyard'} App`);
          for (let turns = 0; !world[app]?.installationId; turns++) {
            if (turns > 10_000) return { code: 1, stdout: JSON.stringify({ resume: 'graphyard install --apply' }) };
            await yieldTurn();
          }
        }
        // With the App installed, the install protects the base branch: the repository's checks and Graphyard's App-bound verdicts;
        // an agent review provider leaves GitHub's approval count at zero so the control plane's identity-bound gate decides.
        github.protect({ requiredApprovals: 0, checks: [...github.workflowChecks.map(context => ({ context, app_id: github.actionsAppId })), { context: CHECK_NAME, app_id: world.controlPlane!.id }, { context: LANDABLE_CHECK, app_id: world.controlPlane!.id }] }, `app:${world.controlPlane!.slug}`);
        return { code: 0, stdout: JSON.stringify({ ok: true, installDirectory, principals: [{ id: operator.id, role: 'admin', tokenFile: operatorTokenFile }] }) };
      }
      if (joined.startsWith('master init')) return { code: 0, stdout: '{}' };
      // GY-1479: the master's operator-agent and approver identities, provisioned with the admin credential on stdin.
      if (joined.startsWith('master autonomy')) {
        const admin = (options.stdin ?? '').trim(), scope = { repositories: [repository], workItems: ['*'] };
        const provision = async (id: string, capabilities: readonly string[]) => {
          const token = `${id}-${randomBytes(24).toString('hex')}`;
          await api(admin, 'POST', 'operator-agents', { id, displayName: id, capabilities: [...capabilities], scope, token, reason: 'Master autonomy onboarding' }, `autonomy:${id}`);
          return token;
        };
        world.operatorAgent ??= await provision('graphyard-master-shop-operator', masterOperatorCapabilities);
        world.approver ??= await provision('graphyard-approver-shop', approverAgentCapabilities);
        return { code: 0, stdout: JSON.stringify({ applied: true }) };
      }
      if (joined === 'init --scan') return { code: 0, stdout: JSON.stringify({ repository, proposal: true }) };
      if (joined.startsWith('init --scan --apply')) {
        await mkdir(join(root, '.github/workflows'), { recursive: true });
        await writeFile(join(root, 'AGENTS.md'), '# Agents\nUse Graphyard for coordination.\n');
        await writeFile(join(root, 'graphyard.json'), JSON.stringify({ version: 1, repository }, null, 2));
        await writeFile(join(root, '.github/workflows/graphyard.yml'), 'name: Graphyard\non: [pull_request]\njobs: {}\n');
        return { code: 0, stdout: '{}' };
      }
      // The login homes already on this host become the fleet.
      if (joined === 'master registry propose --apply') { world.accounts = true; return { code: 0, stdout: '{}' }; }
      if (joined.startsWith('master harness')) return { code: 0, stdout: '{}' };
      if (joined === 'master restart') { world.loop = true; return { code: 0, stdout: '{}' }; }
      // `graphyard goal FILE` with the master's own credential, once per request id.
      if (args[0] === 'goal') return { code: 0, stdout: JSON.stringify(await api(tokenOf(master), 'POST', 'goals', JSON.parse(await readFile(args[1], 'utf8')), options.env?.GRAPHYARD_REQUEST_ID)) };
      return { code: 1, stdout: JSON.stringify({ error: `no such command in this world: ${joined}` }) };
    },
  };

  // ---- The run --------------------------------------------------------------------------------------
  const request = upRequestFromArgs(['--repo', repository, '--provider', 'compose', '--agent', '--goal', 'goal.md', '--browser-profile', 'Default']);
  const result = await runUp(request, deps as unknown as UpDependencies);
  const humanRequests = () => [
    ...result.handoffs.slice(1).map(entry => `up handed off at ${entry.step}: ${entry.sentence}`),
    ...world.events.filter(event => event.kind === 'waiting').map(event => `up waited on the Setup page for ${(event as { waitingFor: string[] }).waitingFor.join(', ')}`),
    ...github.approvals.slice(1).map(approval => `GitHub asked a person to approve ${approval.app} again`),
    ...github.humanSteps.map(step => `a person had to ${step.action} on GitHub: ${step.detail}`),
  ];
  assert.equal(result.exitCode, 0, `up stopped after ${result.completed.at(-1) ?? 'nothing'} completed: ${result.next}; human requests: ${humanRequests().join('; ') || 'none'}`);
  assert.ok(result.completed.includes('goal'), `up submitted the goal: ${result.completed.join(', ')}`);

  // The only handoff is the one App approval, which the fake GitHub approved itself.
  assert.equal(github.approvals.length, 1, `GitHub asked for exactly one App approval: ${JSON.stringify(github.approvals)}`);
  assert.equal(github.approvals[0].approved, true);
  assert.deepEqual(result.handoffs.map(entry => entry.step), ['control-plane'], `the only handoff is the App approval: ${JSON.stringify(result.handoffs)}`);
  assert.match(result.handoffs[0].sentence, /Approve the GitHub App/);
  assert.equal(result.prompts, 0, 'up never waited on the Setup page');

  // The onboarding change merged through the loop's own reviewer, under the branch's protection, by the control-plane App.
  const onboarding = [...github.pulls.values()].find(pull => pull.head.ref === 'graphyard/onboarding')!;
  assert.ok(onboarding?.merged, 'the onboarding pull request merged');
  assert.equal(onboarding.mergedBy, `app:${world.controlPlane!.slug}`);
  assert.ok(github.reviews.some(review => review.pr === onboarding.number && review.sha === onboarding.head.sha && review.state === 'APPROVED' && review.by === `app:${world.reviewer!.slug}`), 'the loop\'s reviewer approved the onboarding change at its head');
  assert.ok(github.files('main').has('.github/workflows/graphyard.yml'), 'the base branch carries the delivery workflow');

  // The master creates work with its own identity: no command after up.
  assert.ok(world.operatorAgent, 'up provisioned the master\'s operator-agent identity');
  const created = await api(world.operatorAgent!, 'POST', 'work', { title: 'A follow-up the master files', reason: 'Found while onboarding', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:follow-up'] }] });
  assert.match(created.key, /^GY-\d+$/);

  // The loop runs on, with nobody acting: the goal is accepted and planned by their roles and its first planned item merges.
  const goalKey = result.goal;
  assert.equal((await api(tokenOf(master), 'GET', `goals/${goalKey}`)).goal.statement, goalText, 'the goal was recorded as the operator wrote it');
  const planned = async () => (await work()).filter(item => item.title.startsWith(`${goalKey}: `));
  for (let ticks = 0; ticks < 60 && !(await planned()).some(item => item.stage === 'done'); ticks++) await loopTick();
  const goal = (await api(tokenOf(master), 'GET', `goals/${goalKey}`)).goal as Goal;
  const stalled = goal.stage === 'acceptance-drafting' || goal.stage === 'awaiting-approval' || goal.stage === 'accepted' ? 'acceptance' : goal.stage === 'planning' || goal.stage === 'plan-review' ? 'planner' : null;
  assert.equal(stalled, null, `the goal stalled in the ${stalled} role at ${goal.stage}: ${JSON.stringify(state.actions)}`);
  assert.equal(goal.merged?.pr !== undefined, true, 'the goal\'s acceptance pull request merged');
  assert.notEqual(goal.acceptance!.author, goal.approval!.by, 'its acceptance was approved by an identity that did not draft it');
  assert.notEqual(goal.plan!.author, goal.planApproval!.by, 'its plan was approved by an identity that did not write it');
  assert.ok(world.runs.includes('acceptance') && world.runs.includes('planner'), `the acceptance and planner roles ran: ${world.runs.join(', ')}`);
  const first = (await planned())[0];
  assert.ok(first, 'the plan was released into work items');
  assert.equal(first.stage, 'done', `the first planned item ${first.key} merged: ${JSON.stringify(first.gates.filter(gate => !gate.passed))}`);
  assert.ok(github.pull(first.submission!.pr!).merged, `${first.key}'s pull request merged on GitHub`);

  // Nothing along the way needed a person: no parked or blocked item, no hand review or merge, no second approval.
  const parked = (await work()).filter(item => item.blocker || (item as any).park).map(item => `${item.key} is ${item.blocker ? `blocked: ${item.blocker}` : 'parked for a person'}`);
  assert.deepEqual([...humanRequests(), ...parked], [], 'no human step but the one App approval');
});
