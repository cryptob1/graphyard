import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import type { MasterConfig } from '../src/master/profiles.js';
import type { Observation, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1501: supervised mode for local installs. Each test is named for the proof it produces:
 * unit:supervised-setup-skips-autonomy, unit:supervised-review-gate-human,
 * unit:supervised-no-identity-collapse and unit:supervised-master-prompt.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const SERVER = 'http://127.0.0.1:4310';
const OPERATOR = 'octo-operator';
const GH_TOKEN = `gho_${'g'.repeat(36)}`;

const baseConfig = (extra: Partial<MasterConfig> = {}): MasterConfig => ({ version: 1, url: SERVER, credentialFile: '/outside/master.token', cliPath: launcher, repository: 'acme/shop', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-shop', autoMerge: true, mergeMethod: 'merge', workers: [], reviewers: [], producers: [],
  run: { intervalSeconds: 20, deploymentShaField: 'commit', dispatchIntervalSeconds: 10, producerTimeoutMinutes: 120 } as MasterConfig['run'], ...extra });
const identities = {
  reviewer: { slug: 'graphyard-reviewer', appId: 9, installationId: 10, credentialFile: '/outside/reviewer.json', boundAt: '2026-10-08T00:00:00.000Z' },
  operatorAgent: { id: 'graphyard-master-shop-operator', credentialFile: '/outside/operator.token' },
  approver: { id: 'graphyard-approver-shop', credentialFile: '/outside/approver.token' },
} as unknown as Pick<MasterConfig, 'reviewer' | 'operatorAgent' | 'approver'>;

/** A local control plane: no reviewer App, a worker account only; the loop starts on restart. */
interface World { calls: { args: string[]; stdin?: string; env?: Record<string, string> }[]; installed: boolean; loop: boolean; supervised: number }
const status = (w: World) => w.installed ? {
  github: true, githubRepository: 'acme/shop', appPermissions: { missing: [] }, reviewerApps: [],
  fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
  setup: { protection: 'checks', loop: w.loop },
} : null;
function dependencies(w: World, root: string, events: UpEvent[]): UpDependencies {
  let clock = 0, sleeps = 0;
  return {
    root, pollMs: 1, emit: event => { events.push(event); }, now: () => clock,
    // Bounded polling: an up that would wait forever on a step fails instead of spinning.
    sleep: async ms => { clock += ms; if (++sleeps > 10_000) throw new Error('up polled 10,000 times without finishing'); },
    serverUrl: async () => w.installed ? SERVER : null, masterToken: async () => w.installed ? 'm'.repeat(40) : null,
    // The admin credential is on this machine: a supervised run still never provisions identities with it.
    operatorToken: async () => 'a'.repeat(40),
    status: async () => status(w),
    publishOnboarding: async () => null, onboardingMerged: async () => true,
    supervise: async () => { w.supervised++; return { operatorLogin: OPERATOR }; },
    async cli(args, options = {}) {
      w.calls.push({ args, ...(options.stdin ? { stdin: options.stdin } : {}), ...(options.env ? { env: options.env } : {}) });
      if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) };
      if (args[0] === 'install') { w.installed = true; return { code: 0, stdout: '{"ok":true}' }; }
      if (args.join(' ') === 'master restart') w.loop = true;
      return { code: 0, stdout: '{}' };
    },
  };
}
const localRequest = async (): Promise<UpRequest> => (await import('../src/up.js')).upRequestFromArgs(['--repo', 'acme/shop', '--local']);

/** A private master.json, as master init writes it, in a fresh checkout. */
async function storedConfig(label: string, extra: Partial<MasterConfig> = {}) {
  const root = await temporaryDirectory(label), outside = await temporaryDirectory(`${label}-credentials`);
  execFileSync('git', ['init', '--quiet', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const file = join(root, '.graphyard', 'master.json');
  await writeFile(join(outside, 'master.token'), 'm'.repeat(40), { mode: 0o600 });
  await writeFile(file, JSON.stringify(baseConfig({ credentialFile: join(outside, 'master.token'), ...extra })), { mode: 0o600 });
  return { root, file };
}

test('unit:supervised-setup-skips-autonomy — supervision defaults to autonomous; up --local records supervised, registers no reviewer App, skips master-autonomy, and its checklist never asks for the reviewer App or a reviewing account', async () => {
  const { masterConfigSchema } = await import('../src/master/profiles.js');
  const { setupChecklist } = await import('../src/model/setup-checklist.js');
  const { runUp, upSupervised } = await import('../src/up.js');
  const { recordSupervision, loadMasterConfig } = await import('../src/master/config.js');
  // The schema: absent is autonomous (every existing master.json loads unchanged); only the two modes parse.
  assert.equal(masterConfigSchema.parse(baseConfig()).supervision, undefined);
  assert.equal(masterConfigSchema.parse(baseConfig({ supervision: 'supervised' })).supervision, 'supervised');
  assert.throws(() => masterConfigSchema.parse({ ...baseConfig(), supervision: 'unattended' }));
  assert.equal(upSupervised(await localRequest()), true, '--local installs supervised');
  assert.equal(upSupervised({ provider: 'compose' }), false, 'every other provider keeps autonomous');

  // The checklist: supervised omits the reviewer App and the reviewing account; autonomous keeps both.
  const bare = status({ calls: [], installed: true, loop: true, supervised: 0 });
  const supervisedIds = setupChecklist(bare, { supervised: true }).map(item => item.id);
  assert.deepEqual(supervisedIds, ['github-app', 'account:worker', 'branch-protection', 'master-loop']);
  assert.ok(setupChecklist(bare, { supervised: true }).every(item => item.done), 'a local install with a worker account is green');
  const autonomous = setupChecklist(bare);
  assert.deepEqual(autonomous.map(item => item.id), ['github-app', 'reviewer-app', 'account:worker', 'account:reviewer', 'branch-protection', 'master-loop']);
  assert.deepEqual(autonomous.filter(item => !item.done).map(item => item.id), ['reviewer-app', 'account:reviewer'], 'autonomous mode still reports them missing');

  // The dashboard's caller: /api/status names the live loop's supervision (`setup.supervision`, from
  // the header on its coordination read), and the Setup page judges the same checklist from it.
  const { LoopRegistry, loopSupervision } = await import('../src/model/executor-presence.js');
  assert.equal(loopSupervision('supervised'), 'supervised'); assert.equal(loopSupervision('autonomous'), 'autonomous');
  assert.equal(loopSupervision(undefined), null); assert.equal(loopSupervision('unattended'), null);
  const registry = new LoopRegistry(), seen = new Date('2026-10-08T00:00:00.000Z');
  registry.observe({ principal: 'graphyard-master', intervalSeconds: 20, supervision: loopSupervision('supervised') }, seen);
  assert.equal(registry.live(seen)?.supervision, 'supervised');
  registry.observe({ principal: 'graphyard-master', intervalSeconds: 20, supervision: loopSupervision(undefined) }, seen);
  assert.equal(registry.live(seen)?.supervision, undefined, 'an older loop that names none is not read as supervised');
  const dashboard = { ...bare!, setup: { ...bare!.setup, supervision: 'supervised' } };
  assert.deepEqual(setupChecklist(dashboard).map(item => item.id), supervisedIds, 'the status alone makes the checklist supervised');
  assert.deepEqual(setupChecklist({ ...bare!, setup: { ...bare!.setup, supervision: 'autonomous' } }).map(item => item.id), autonomous.map(item => item.id));
  const { SetupView } = await import('../web/pages/setup.js');
  const page = (state: any) => renderToStaticMarkup(createElement(SetupView, { status: state, work: [], onConnect: () => {}, onSubmitGoal: () => {} }));
  const supervisedPage = page(dashboard), autonomousPage = page(bare);
  assert.ok(!/Reviewer App|reviews code/.test(supervisedPage), 'the Setup page asks for no reviewer App or reviewing account');
  assert.match(supervisedPage, /data-supervised/); assert.match(supervisedPage, /data-goal-submit/, 'a supervised install with a worker account is green, so the first-goal form shows');
  assert.match(autonomousPage, /Reviewer App/); assert.ok(!/data-supervised|data-goal-submit/.test(autonomousPage), 'autonomous mode still waits for the reviewer');

  // up --local, end to end against a simulated local host.
  const root = await temporaryDirectory('supervised-up');
  const w: World = { calls: [], installed: false, loop: false, supervised: 0 };
  const events: UpEvent[] = [];
  const result = await runUp(await localRequest(), dependencies(w, root, events));
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(!result.completed.includes('master-autonomy'), 'master-autonomy is not run');
  assert.ok(events.some(event => event.kind === 'step' && event.step === 'master-autonomy' && event.state === 'skipped' && /supervised/.test(event.detail ?? '')));
  assert.ok(!w.calls.some(call => call.args[0] === 'master' && ['autonomy', 'reviewer', 'approver'].includes(call.args[1])), 'no identity or reviewer App is set up');
  for (const call of w.calls.filter(entry => entry.args[0] === 'install')) assert.ok(!call.args.includes('--reviewer'), `install registers no reviewer App: ${call.args.join(' ')}`);
  assert.ok(w.supervised >= 1, 'master.json records supervised mode');
  assert.deepEqual(result.checklist.map(item => item.id), supervisedIds);
  assert.ok(events.some(event => event.kind === 'note' && /you review and merge each pull request on GitHub/.test(event.text)));

  // recordSupervision writes it into master.json; the loop then loads it without any agent identity.
  const stored = await storedConfig('supervised-record', identities);
  assert.deepEqual(await recordSupervision(stored.root, 'supervised', OPERATOR), { supervision: 'supervised', operatorLogin: OPERATOR });
  const written = JSON.parse(await readFile(stored.file, 'utf8'));
  assert.equal(written.supervision, 'supervised'); assert.equal(written.operatorLogin, OPERATOR);
  const loaded = await loadMasterConfig(stored.root);
  assert.equal(loaded.supervision, 'supervised');
  assert.equal(loaded.reviewer, undefined); assert.equal(loaded.operatorAgent, undefined); assert.equal(loaded.approver, undefined);
});

const sha = (label: string) => label.padEnd(40, '0').slice(0, 40);
const H = sha('a1'), B = sha('b1');
function work(reviews: Observation['reviews'], author = 'graphyard-worker[bot]'): Work {
  const at = '2026-10-08T00:00:00.000Z', candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author };
  const observation: Observation = { candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews, merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/app.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: B, baseTree: sha('7b'), baseTipContained: true } as Observation;
  return { id: 'work-7', key: 'GY-7', title: 'A supervised change', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/app.ts'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['manual:works'] }], policy: { checks: ['test', 'typecheck'], review: true }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation, blocker: null, gates: [], violations: [] } as unknown as Work;
}

test('unit:supervised-review-gate-human — review stays required: no approval never merges, the operator\'s approval of the exact head passes; the loop launches no reviewer, approver or escalation session; master status names the operator and the promotion command', async () => {
  const { exactApproval } = await import('../src/model.js');
  const { evaluate } = await import('../src/model/gates.js');
  const { withRoleDefaults } = await import('../src/master/profiles.js');
  const { selectReviewerProfile, supervisedReview } = await import('../src/auto-dispatch.js');
  const { daemonEffects } = await import('../src/master-daemon.js');
  const { buildMasterStatus } = await import('../src/master/status.js');
  const reviewGate = (item: Work) => evaluate(item, [item], new Date('2026-10-08T00:05:00.000Z'), [15368]).gates.find(gate => gate.name === 'review')!;

  // Items keep policy review true and the GitHub review provider: an unreviewed candidate never merges.
  const unreviewed = work([]);
  assert.equal(unreviewed.policy.review, true);
  assert.equal(exactApproval(unreviewed), null);
  assert.equal(reviewGate(unreviewed).passed, false);
  assert.deepEqual(reviewGate(unreviewed).reasons, ['Independent approval of the current commit is required']);
  // An approval of another head is not an approval of this one.
  assert.equal(reviewGate(work([{ reviewer: OPERATOR, state: 'APPROVED', sha: sha('c1'), id: 1 }] as Observation['reviews'])).passed, false);
  // The operator's GitHub approval of the exact head passes the gate; GitHub auto-merge then merges it.
  const approved = work([{ reviewer: OPERATOR, state: 'APPROVED', sha: H, id: 2 }] as Observation['reviews']);
  assert.deepEqual(exactApproval(approved), { provider: 'github', reviewer: OPERATOR, sha: H, reviewId: 2 });
  assert.equal(reviewGate(approved).passed, true);

  // The loop's view of a supervised config: no reviewer App, operator-agent or approver identity.
  const supervised = withRoleDefaults(baseConfig({ supervision: 'supervised', ...identities }));
  assert.equal(supervised.reviewer, undefined); assert.equal(supervised.operatorAgent, undefined); assert.equal(supervised.approver, undefined);
  assert.deepEqual(selectReviewerProfile(supervised), { profile: null, reason: supervisedReview }, 'no reviewer session is launched');
  const effects = daemonEffects('/nonexistent/gy-1501', supervised, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}) });
  assert.equal(effects.approver, undefined, 'no approver session is launched');
  assert.equal(effects.decide, undefined, 'no two-party decision is requested, so no escalation handler runs for one');
  // The same identities in autonomous mode are kept.
  const autonomous = withRoleDefaults(baseConfig(identities));
  assert.ok(autonomous.reviewer && autonomous.operatorAgent && autonomous.approver);
  assert.ok(daemonEffects('/nonexistent/gy-1501', autonomous, { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}) }).approver);

  // master status: one line naming who reviews and merges and the promotion command; none in autonomous mode.
  const now = '2026-10-08T00:05:00.000Z';
  const line = buildMasterStatus({ work: [unreviewed], now }, [], [], {}, {}, undefined, 'main', undefined, undefined, undefined, undefined, 'graphyard', null, { mode: 'supervised', operatorLogin: OPERATOR }).supervision;
  assert.match(line!, /the operator reviews and merges each pull request/);
  assert.match(line!, /graphyard master promote --admin-token-stdin/);
  assert.equal(buildMasterStatus({ work: [unreviewed], now }, [], []).supervision, null);
});

test('unit:supervised-no-identity-collapse — up --local hands the operator\'s gh login to no worker, reviewer or producer credential; master status raises attention when a candidate is the operator\'s own', async () => {
  const { runUp } = await import('../src/up.js');
  const { recordSupervision, loadStoredMasterConfig } = await import('../src/master/config.js');
  const { buildMasterStatus, supervisionReport } = await import('../src/master/status.js');
  // Every child up --local runs: none is given the gh credential, on its arguments, stdin or environment.
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = GH_TOKEN;
  try {
    const w: World = { calls: [], installed: false, loop: false, supervised: 0 };
    const result = await runUp(await localRequest(), dependencies(w, await temporaryDirectory('supervised-identity'), []));
    assert.equal(result.exitCode, 0, result.next);
    for (const call of w.calls) assert.ok(!JSON.stringify(call).includes(GH_TOKEN) && !JSON.stringify(call).includes(OPERATOR), `no child carries the operator's GitHub identity: ${call.args.join(' ')}`);
    assert.ok(!w.calls.some(call => call.args[0] === 'master' && ['worker', 'reviewer', 'producer', 'autonomy'].includes(call.args[1])), 'no role credential is minted');
  } finally { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; }
  // master.json gains only the login's name: no profile, credential file or identity is added or changed.
  const stored = await storedConfig('supervised-collapse');
  const before = await loadStoredMasterConfig(stored.root);
  await recordSupervision(stored.root, 'supervised', OPERATOR);
  const after = await loadStoredMasterConfig(stored.root);
  assert.deepEqual({ ...after, supervision: undefined, operatorLogin: undefined }, { ...before, supervision: undefined, operatorLogin: undefined });
  assert.equal(after.credentialFile, before.credentialFile);
  assert.ok(!JSON.stringify(after).includes(GH_TOKEN));

  // A candidate the operator's own login authored cannot be independently approved by that operator.
  const own = work([], 'Octo-Operator'), workers = work([]);
  const report = supervisionReport({ mode: 'supervised', operatorLogin: OPERATOR }, [own]);
  assert.equal(report.attentionItems.length, 1);
  assert.equal(report.attentionItems[0].subject, 'GY-7');
  assert.match(report.attentionItems[0].text, /authored by octo-operator, the operator's own login, so the operator's approval of it would not be independent/);
  assert.match(report.attentionItems[0].next, /Have someone other than octo-operator approve PR #7/);
  assert.equal(supervisionReport({ mode: 'supervised', operatorLogin: OPERATOR }, [workers]).attentionItems.length, 0, 'a worker-authored candidate raises nothing');
  assert.equal(supervisionReport({ operatorLogin: OPERATOR }, [own]).attentionItems.length, 0, 'autonomous mode raises nothing');
  const status = buildMasterStatus({ work: [own], now: '2026-10-08T00:05:00.000Z' }, [], [], {}, {}, undefined, 'main', undefined, undefined, undefined, undefined, 'graphyard', null, { mode: 'supervised', operatorLogin: OPERATOR });
  assert.ok(status.attentionItems.some(item => item.subject === 'GY-7' && /operator's own login/.test(item.text)), 'master status carries the attention item');
});

test('unit:supervised-master-prompt — the supervised master prompt says the operator reviews and merges and no two-party decision can be approved yet; the autonomous prompt is unchanged', async () => {
  const { masterPrompt } = await import('../src/master/harness.js');
  const { withRoleDefaults } = await import('../src/master/profiles.js');
  const supervised = masterPrompt(withRoleDefaults(baseConfig({ supervision: 'supervised', operatorLogin: OPERATOR })));
  assert.match(supervised, /the operator reviews and merges each pull request on GitHub/);
  assert.match(supervised, /no two-party decision can be approved yet/);
  assert.match(supervised, /not an onboarding fault, so do not report the missing identities/);
  assert.ok(!/report that onboarding must run/.test(supervised), 'the missing identities are not an onboarding fault');
  assert.ok(!/No reviewer identity is registered yet/.test(supervised), 'the missing reviewer App is not a setup step');
  assert.ok(!/master approver GY-N DECISION/.test(supervised), 'no approver is launched');
  // Autonomous: the same prompt whether supervision is absent or explicit, still naming the onboarding step.
  for (const extra of [{}, identities]) {
    const absent = masterPrompt(baseConfig(extra)), explicit = masterPrompt(baseConfig({ ...extra, supervision: 'autonomous' }));
    assert.equal(explicit, absent);
    assert.ok(!/supervised/i.test(absent));
  }
  assert.match(masterPrompt(baseConfig()), /Your operator-agent and approver identities are not provisioned yet; report that onboarding must run/);
  assert.match(masterPrompt(baseConfig(identities)), /launch its independent approver with node .* master approver GY-N DECISION\. Independent review and proof collection start on their own/);
});
