import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { autonomyContract, withAutonomyContract } from '../src/autonomy.js';
import { assertLaunchRecipe, launchPlan, LaunchRefusedError, registryContractRefusal, nonInteractiveLaunch, refusedLaunchKinds } from '../src/harness.js';
import { accountLaunch, agentKindSchema, atomicPrivateWrite, dispatchWork, launchApprover, launchEscalationHandler, launchRoleContracts, loadMasterConfig, saveProducerProfile, setupMaster, startAgentSession, startMaster, type WorkerProfile } from '../src/master.js';
import { managedInstructions } from '../src/repository-setup.js';
import { bindReviewer, launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { launchProducer } from '../src/producer.js';
import type { EscalationContext } from '../src/model/escalation-context.js';
import { expandTypedCommand, requestOf, roleOf, startedAtOnce } from './helpers/launch-shell.js';

// GY-184: autonomy is a product contract. Every session Graphyard launches carries one autonomy
// contract (src/autonomy.ts), every accepted runtime launches in its no-approval mode or is
// refused, a runtime without a role-file flag gets the contract at the start of its request, and
// the AGENTS.md section onboarding writes carries it too. One case per proof:
// unit:every-role-carries-autonomy-contract, unit:every-runtime-non-interactive-or-refused,
// unit:contract-reaches-runtimes-without-role-flag, unit:onboarding-agents-md-carries-contract.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-24T10:00:00.000Z';
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
const producerVerify = async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } });

function observation(candidate: { sha: string; baseSha: string }): Observation {
  return { candidate: { ...candidate, pr: 184, branch: 'graphyard/gy-184-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 184, branch: 'graphyard/gy-184-1', author: 'implementer' };
  return { id: 'work-184', key: 'GY-184', title: 'Autonomy is a product contract', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Contract', proofs: ['unit:every-role-carries-autonomy-contract'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-184', branch: 'graphyard/gy-184-1', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 184 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const ready = () => work({ stage: 'ready', lease: null, submission: null, candidate: null, observation: null, gates: [{ name: 'ready', passed: true, reasons: [] }] });

/** A master installed in a throwaway repository, its credentials outside it, with reviewer, approver and operator-agent identities. */
async function installed() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-')), credentials = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  const token = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  const config = await loadMasterConfig(root);
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...config, approver: { id: 'graphyard-approver-project', credentialFile: await token('approver') }, operatorAgent: { id: 'graphyard-operator-project', credentialFile: await token('operator') } });
  return { root, token, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** A Herdr stub whose runtimes start at once; it records every launch line the pane's shell would run, expanded from the launch files. */
function herdr() {
  const typed: ReturnType<typeof expandTypedCommand>[] = [], pasted: string[] = [];
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') { panes++; return JSON.stringify({ result: { root_pane: { pane_id: `pane-${panes}`, tab_id: `tab-${panes}` } } }); }
    if (args[0] === 'pane' && args[1] === 'run') typed.push(expandTypedCommand(args[3]));
    if (args[0] === 'agent' && args[1] === 'prompt') pasted.push(args[3]);
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  return { run, typed, pasted };
}
/** What the runtime reads as its instruction: the role file it loads and the request it starts on. */
const launchText = (launch: ReturnType<typeof expandTypedCommand>) => ({ role: roleOf(launch.args), request: requestOf(launch.kind, launch.args) });

test('unit:every-role-carries-autonomy-contract — worker, reviewer, producer, approver, escalation handler and master each start on text that carries the one autonomy contract verbatim', async () => {
  // The contract says what the operator directive says, once.
  for (const clause of ['act without asking', 'Never ask a human for review, approval or confirmation', 'never ask a human to run a command an agent identity may run', 'record the blocker in Graphyard with its CLI', 'rather than asking in chat', 'Stop for a human only before an irreversible destructive action'])
    assert.ok(autonomyContract.includes(clause), `the contract states: ${clause}`);
  assert.ok(!/\s{2,}|\n/.test(autonomyContract), 'one line, so a role file\'s whitespace folding keeps it verbatim');

  const { root, token, cleanup } = await installed();
  try {
    const roles: Record<string, { kind: string; role: string | null; request: string | null }> = {};
    const capture = (role: string, stub: ReturnType<typeof herdr>) => {
      assert.equal(stub.typed.length, 1, `${role}: one launch line`);
      roles[role] = { kind: stub.typed[0].kind, ...launchText(stub.typed[0]) };
    };

    // Reviewer on Claude Code, which loads a role file.
    let stub = herdr();
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude' });
    await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: stub.run, mint, requestId: 'review-request' });
    capture('reviewer', stub);

    // Producer on Codex, which does not.
    stub = herdr();
    await saveProducerProfile(root, { name: 'producer-codex', principal: 'proof-runner', agentName: 'produce-codex', kind: 'codex', credentialFile: await token('producer') }, producerVerify);
    const config = await loadMasterConfig(root);
    const item = work(); reconcileAutoDispatch(item, [item], new Date(Date.parse(at)));
    await launchProducer(root, item, item.autoDispatch!.producers[0], config.producers[0], [], new Date().toISOString(), { run: stub.run });
    capture('producer', stub);

    // Approver on Cursor.
    stub = herdr();
    await launchApprover(root, work(), 'decision-1', 'cursor', [], stub.run);
    capture('approver', stub);

    // Worker on OpenCode, under the supervisor.
    stub = herdr();
    const profile: WorkerProfile = { name: 'worker-oc', principal: 'worker-a', agentName: 'eng-oc', mode: 'launch', kind: 'opencode', credentialFile: await token('worker'), agentArgs: [], approvals: 'auto', environment: {} };
    await dispatchWork(root, ready(), profile, [], stub.run, [ready()], async () => ({ epoch: 4, path: join(root, 'assigned'), base: 'c'.repeat(40) }), async () => {}, 5_000);
    capture('worker', stub);

    // Escalation handler on Claude Code, with no role harness of its own.
    stub = herdr();
    const context = { key: 'GY-184', escalation: { trigger: 'requirement-weakening' }, fingerprint: 'f'.repeat(64) } as unknown as EscalationContext;
    await launchEscalationHandler(root, await loadMasterConfig(root), context, 'claude', [], stub.run);
    capture('escalation handler', stub);

    // Master on Codex.
    stub = herdr();
    await startMaster(root, 'codex', [], [], stub.run);
    capture('master', stub);

    assert.deepEqual(Object.keys(roles).sort(), ['approver', 'escalation handler', 'master', 'producer', 'reviewer', 'worker']);
    for (const [role, launched] of Object.entries(roles)) {
      assert.ok(launched.request, `${role}: the session starts on its own request`);
      const carried = [launched.role, launched.request].filter(Boolean).join('\n');
      assert.ok(carried.includes(autonomyContract), `${role} (${launched.kind}) carries the autonomy contract verbatim`);
      assert.equal(carried.split(autonomyContract).length - 1, 1, `${role}: stated once, not repeated`);
      // Where it rides follows the runtime: the role file when the runtime loads one, the request otherwise.
      if (launchRoleContracts[launched.kind]) assert.ok(launched.role!.includes(autonomyContract), `${role}: in the role file`);
      else assert.ok(launched.request!.startsWith(autonomyContract), `${role}: at the start of the request`);
    }
  } finally { await cleanup(); }
});

test('unit:every-runtime-non-interactive-or-refused — every kind agentKindSchema accepts has a no-approval launch recipe or is refused before launch, naming the runtime', async () => {
  const kinds = agentKindSchema.options;
  for (const kind of ['pi', 'gemini', 'copilot', 'qwen']) assert.ok(nonInteractiveLaunch[kind], `${kind} has a recipe`);
  assert.deepEqual(Object.keys(nonInteractiveLaunch).filter(kind => !(kinds as readonly string[]).includes(kind)), [], 'every recipe is for an accepted kind');
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-refused-'));
  try {
    for (const kind of kinds) {
      const recipe = nonInteractiveLaunch[kind];
      const refused = (refusedLaunchKinds as readonly string[]).includes(kind);
      assert.notEqual(!!recipe, refused, `${kind} has exactly one of a recipe and a refusal`);
      if (recipe) {
        assert.equal(assertLaunchRecipe(kind), recipe);
        const plan = launchPlan(kind, 'auto');
        assert.equal(plan.applied, true, `${kind}: the recipe is applied`);
        assert.deepEqual(plan.args, recipe.args); assert.deepEqual(plan.environment, recipe.environment);
        // Pi is the one runtime with no prompt to suppress; every other recipe sets a flag or variable.
        if (kind !== 'pi') assert.ok(recipe.args.length + Object.keys(recipe.environment).length > 0, `${kind}: the recipe suppresses its prompts`);
        assert.ok(recipe.prompts && recipe.tradeoff, `${kind}: the recipe says what it suppresses and what that costs`);
        // A profile that opts out of the recipe (approvals "prompt") would wait at the runtime's prompts: refused, naming the runtime.
        assert.throws(() => accountLaunch({ kind, approvals: 'prompt', agentArgs: [], environment: {} }, null),
          (error: unknown) => error instanceof LaunchRefusedError && error.kind === kind && error.message.includes(`the ${kind} runtime with approvals "prompt"`));
        assert.equal(accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, null).plan.applied, true);
        continue;
      }
      assert.throws(() => assertLaunchRecipe(kind), (error: unknown) => error instanceof LaunchRefusedError && error.kind === kind && error.message.includes(`the ${kind} runtime`));
      assert.match(launchPlan(kind, 'auto').reason!, new RegExp(`no non-interactive launch contract for ${kind}; a session of it is refused at launch`));
      // Refused before launch: nothing is typed into the pane.
      const calls: string[][] = [];
      await assert.rejects(startAgentSession(`refused-${kind}`, kind, 'pane-r', [], 'Implement GY-184', (_command, args) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: {} }); }, { directory }),
        (error: unknown) => error instanceof LaunchRefusedError && error.message.includes(kind));
      assert.deepEqual(calls, [], `${kind}: refused before anything reached Herdr`);
    }
    // A runtime the agent registry adds (GY-91) brings its own launch contract: its registered
    // arguments are its no-approval mode, so a kind with no built-in recipe still launches from it.
    const registryAccount = (args: string[]) => ({ name: 'aider-a', kind: 'aider', home: null, fleet: { runtime: 'aider', model: 'gpt', modelId: null, session: 's-1', reason: 'chosen',
      contract: { kind: 'aider', args, environment: {}, homeVariable: 'AIDER_HOME', modelFlag: null, login: null, loginFile: null } } });
    const registered = accountLaunch({ kind: 'claude', approvals: 'auto', agentArgs: [], environment: {} }, registryAccount(['--yes-always']));
    assert.equal(registered.kind, 'aider'); assert.deepEqual(registered.args, ['--yes-always']);
    const aider = herdr();
    const started = await startAgentSession('registry-aider', registered.kind!, 'pane-aider', registered.args, 'Implement GY-184', aider.run, { directory, attempts: 1, contract: registered.contract });
    assert.equal(started.command.includes('--yes-always'), true, 'the registry runtime starts with its registered no-approval arguments');
    assert.equal(aider.typed.length, 1);
    // The same kind without that contract, or with one that registers nothing to suppress its prompts, is refused before launch.
    const unregistered: string[][] = [];
    await assert.rejects(startAgentSession('registry-none', 'aider', 'pane-r', [], 'Implement GY-184', (_command, args) => { unregistered.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: {} }); }, { directory }),
      (error: unknown) => error instanceof LaunchRefusedError && error.kind === 'aider' && error.message.includes('the aider runtime'));
    const bare = accountLaunch({ kind: 'claude', approvals: 'auto', agentArgs: [], environment: {} }, registryAccount([]));
    await assert.rejects(startAgentSession('registry-bare', 'aider', 'pane-r', bare.args, 'Implement GY-184', (_command, args) => { unregistered.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: {} }); }, { directory, contract: bare.contract }),
      (error: unknown) => error instanceof LaunchRefusedError && error.message === registryContractRefusal('aider'));
    assert.deepEqual(unregistered, [], 'refused before anything reached Herdr');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:contract-reaches-runtimes-without-role-flag — a codex and an opencode session, which load no role file, start on a request that begins with the contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-request-'));
  try {
    for (const kind of ['codex', 'opencode']) {
      assert.equal(launchRoleContracts[kind], undefined, `${kind} has no role-file flag`);
      const stub = herdr();
      const started = await startAgentSession(`request-${kind}`, kind, `pane-${kind}`, nonInteractiveLaunch[kind].args, 'Implement GY-184: carry the contract', stub.run, { directory });
      assert.equal(started.delivery, 'request');
      assert.equal(started.files.role, null, `${kind}: no role file is written`);
      const request = requestOf(stub.typed[0].kind, stub.typed[0].args)!;
      assert.ok(request.startsWith(autonomyContract), `${kind}: the request begins with the contract`);
      assert.equal(request, `${autonomyContract} Implement GY-184: carry the contract`, 'the task follows the contract unchanged');
      assert.equal(await readFile(started.files.request!, 'utf8'), request);
    }
    // A runtime delivered by paste gets it the same way, at the start of the pasted request.
    const muse = herdr();
    await startAgentSession('request-muse', 'muse', 'pane-muse', [], 'Implement GY-184', muse.run, { directory, attempts: 1 });
    assert.equal(muse.pasted.length, 1); assert.ok(muse.pasted[0].startsWith(autonomyContract));
    // The rule itself: a role-loading runtime carries it in the role, never twice; text that already carries it is unchanged.
    assert.deepEqual(withAutonomyContract(false, { request: 'Task' }), { request: `${autonomyContract} Task`, role: null });
    assert.deepEqual(withAutonomyContract(false, { request: `${autonomyContract} Task` }), { request: `${autonomyContract} Task`, role: null });
    assert.deepEqual(withAutonomyContract(true, { request: 'Task', role: null }), { request: 'Task', role: autonomyContract });
    assert.deepEqual(withAutonomyContract(true, { request: 'Task', role: `Rules. ${autonomyContract}` }), { request: 'Task', role: `Rules. ${autonomyContract}` });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:onboarding-agents-md-carries-contract — the coordination section onboarding writes into a connected repository\'s AGENTS.md carries the contract, and this repository\'s own does', async () => {
  const section = managedInstructions('# Rules\n', 'https://graphyard.example');
  const block = section.slice(section.indexOf('<!-- graphyard -->'), section.indexOf('<!-- /graphyard -->'));
  assert.ok(block.includes(autonomyContract), 'the generated Graphyard section carries the contract verbatim');
  assert.equal(block.split(autonomyContract).length - 1, 1);
  assert.equal(managedInstructions(section, 'https://graphyard.example'), section, 'regenerating keeps it exactly once');
  const agents = await readFile(join(repositoryRoot, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(autonomyContract), 'this repository\'s AGENTS.md was regenerated with it');
});
