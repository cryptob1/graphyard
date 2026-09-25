import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { launchApprover, listHerdrAgents, loadMasterConfig, masterConfigSchema, saveProducerProfile, setupMaster } from '../src/master.js';
import { approvalStep, approvalWatchSchema } from '../src/master-daemon.js';
import { launchProducer, readProducerLedger, reconcileProducers } from '../src/producer.js';
import { narrowRoleRuntime, piRuntimeSchema } from '../src/runner/payloads.js';
import { clearRuns, liveRun } from '../src/runner/registry.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';

// GY-169 AC-3, proof integration:pi-narrow-roles. The master config selects the runtime of each
// narrow role; with `pi` the approver and the unit proof producer run through the headless runner
// on a fake Pi — a wrapper command, configured exactly as `pi-a` would be, that loads the real
// Graphyard extension and makes the tool calls its scenario names the way Pi does, emitting Pi's
// JSONL — and what the run submitted is applied through the control-plane routes with the role's
// own credential. Without the setting both roles launch in Herdr as today.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const extension = fileURLToPath(new URL('../integrations/pi/index.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x'), approverToken = 'approver-token-'.padEnd(40, 'x'), producerToken = 'producer-token-'.padEnd(40, 'x');
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const H = 'c'.repeat(40), B = 'd'.repeat(40);
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const decision = '4cb51514-4cb5-4f21-9b0e-0f2a6c8d4e15';

/** A Pi stand-in: loads the extension named by --extension and runs the scenario's tool calls through its guard and tools, printing Pi's JSONL. */
const fakePi = `import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.FAKE_PI_SCENARIO, 'utf8'));
writeFileSync(process.env.FAKE_PI_SCENARIO + '.launched', JSON.stringify({ args, cwd: process.cwd(), role: process.env.GRAPHYARD_PI_ROLE ?? null, tokenFile: process.env.GRAPHYARD_TOKEN_FILE ?? null }));
const out = record => process.stdout.write(JSON.stringify(record) + '\\n');
const tools = new Map(), handlers = {};
(await import(pathToFileURL(args[args.indexOf('--extension') + 1]).href)).default({ registerTool: tool => tools.set(tool.name, tool), on: (event, handler) => (handlers[event] ??= []).push(handler) });
const sections = {};
for (const handler of handlers.before_agent_start ?? []) await handler({ prompt: args.at(-1), systemPromptOptions: { sections } }, { cwd: process.cwd() });
out({ type: 'session', version: 3, id: 'fake', cwd: process.cwd() });
out({ type: 'message_end', message: { role: 'system', content: [{ type: 'text', text: Object.values(sections).join('\\n') }] } });
let n = 0;
for (const call of scenario.calls) {
  const id = 'call-' + ++n;
  out({ type: 'tool_execution_start', toolCallId: id, toolName: call.tool, args: call.input });
  let result, isError = false;
  const blocked = (await Promise.all((handlers.tool_call ?? []).map(handler => handler({ toolName: call.tool, toolCallId: id, input: call.input }, { cwd: process.cwd() })))).find(answer => answer?.block);
  if (blocked) { result = { content: [{ type: 'text', text: blocked.reason }], details: {} }; isError = true; }
  else if (!tools.has(call.tool)) { result = { content: [{ type: 'text', text: 'ran' }], details: {} }; }
  else try { result = await tools.get(call.tool).execute(id, call.input); } catch (error) { result = { content: [{ type: 'text', text: error.message }], details: {} }; isError = true; }
  out({ type: 'tool_execution_end', toolCallId: id, toolName: call.tool, result, isError });
}
out({ type: 'agent_end', messages: [], willRetry: false });
out({ type: 'agent_settled' });
`;

async function installation(runtimes?: { approver?: 'herdr' | 'pi'; producer?: 'herdr' | 'pi' }) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-pi-roles-')));
  const root = join(scratch, 'repository'), credentials = join(scratch, 'credentials'), managed = join(scratch, 'data', 'worktrees');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'narrow roles\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: managed } }, coordinatorStatus, { probe: durable });
  const producerFile = join(credentials, 'producer.token'), approverFile = join(credentials, 'approver.token');
  await writeFile(producerFile, producerToken, { mode: 0o600 }); await writeFile(approverFile, approverToken, { mode: 0o600 });
  await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'codex', credentialFile: producerFile }, async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } }));
  // The Pi environment wrapper, as `pi-a` is: one command that runs Pi with its account.
  const script = join(scratch, 'fake-pi.mjs'), wrapper = join(scratch, 'pi-fake'), scenario = join(scratch, 'scenario.json');
  await writeFile(script, fakePi);
  await writeFile(wrapper, `#!/bin/sh\nFAKE_PI_SCENARIO='${scenario}' exec '${process.execPath}' --import '${tsx}' '${script}' "$@"\n`); await chmod(wrapper, 0o755);
  const file = join(root, '.graphyard/master.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.approver = { id: 'graphyard-approver-project', credentialFile: approverFile };
  if (runtimes) config.run = { ...config.run, runtimes, pi: { command: wrapper, model: 'zai/glm-5.3-flash' } };
  await writeFile(file, JSON.stringify(masterConfigSchema.parse(config), null, 2), { mode: 0o600 });
  const posted: { url: string; auth: string | null; body: any }[] = [];
  let answer = (_url: string): Response => new Response('{}', { status: 200 });
  const fetcher = (async (url: string, init: RequestInit) => { posted.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }); return answer(String(url)); }) as typeof fetch;
  return { root, managed, scenario, posted, fetcher, answer: (next: typeof answer) => { answer = next; }, cleanup: () => { clearRuns(); return rm(scratch, { recursive: true, force: true }); } };
}

function work(key: string, group: string, proofs: string[], overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 169, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  const request = { id: `request-${key}-${group}`, kind: 'producer', sha: H, baseSha: B, policyRevision: 4, pr: 169, group, proofs, state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' };
  return { id: `id-${key}`, key, title: 'Narrow roles', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [],
    criteria: [{ id: 'AC-2', text: 'Typed tools', proofs: ['unit:pi-graphyard-tools'] }, { id: 'AC-5', text: 'Guard', proofs: ['unit:pi-destructive-guard'] }, { id: 'AC-3', text: 'Roles', proofs: ['integration:pi-narrow-roles'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 4, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate,
    submission: { epoch: 1, pr: 169 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['implementer'],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false },
    autoDispatch: { review: null, producers: [request], history: [] }, ...overrides } as unknown as Work;
}
const requestOf = (item: Work) => item.autoDispatch!.producers[0] as any;
function herdr(calls: string[][] = []) {
  let pane = 0;
  return (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab') { pane++; return JSON.stringify({ result: { type: 'tab_created', root_pane: { pane_id: `pane-${pane}`, tab_id: `tab-${pane}` }, tab: { tab_id: `tab-${pane}` } } }); }
    if (args[0] === 'agent' && args[1] === 'list') return JSON.stringify({ result: { agents: [] } });
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
}
const evidence = (proof: string, result = 'pass') => ({ proof, sha: H, baseSha: B, policyRevision: 4, result, executed: 3, skipped: 0, exercise: { criterion: 'AC-2', behaviour: 'schema checks removed', result: 'fail', executed: 3 } });

test('integration:pi-narrow-roles the master config selects each narrow role\'s runtime, and an absent setting is today\'s Herdr launch', () => {
  assert.equal(narrowRoleRuntime(undefined, 'approver'), 'herdr');
  assert.equal(narrowRoleRuntime({}, 'producer', 'unit'), 'herdr');
  assert.equal(narrowRoleRuntime({ runtimes: { approver: 'pi' } }, 'approver'), 'pi');
  assert.equal(narrowRoleRuntime({ runtimes: { approver: 'pi' } }, 'producer', 'unit'), 'herdr', 'each role is selected on its own');
  assert.equal(narrowRoleRuntime({ runtimes: { producer: 'pi' } }, 'producer', 'unit'), 'pi');
  assert.equal(narrowRoleRuntime({ runtimes: { producer: 'pi' } }, 'producer', 'integration'), 'herdr', 'only the unit proof producer runs on Pi');
  assert.throws(() => masterConfigSchema.shape.run.parse({ runtimes: { approver: 'opencode' } }), 'an unknown runtime is refused at load');
  assert.throws(() => masterConfigSchema.shape.run.parse({ runtimes: { reviewer: 'pi' } }), 'only the narrow roles are selectable');
  assert.deepEqual(piRuntimeSchema.parse({}), { command: 'pi', model: 'zai/glm-5.3-flash', approverTimeoutMinutes: 10 });
});

test('integration:pi-narrow-roles with pi selected the approver runs headless and its verdict is applied as the approver identity on the approve route, and the server still judges it', async () => {
  const { root, scenario, posted, fetcher, answer, cleanup } = await installation({ approver: 'pi' });
  try {
    const item = work('GY-88', 'unit', ['unit:pi-graphyard-tools']);
    const reason = 'the requested rework is grounded in the reviewer finding';
    await writeFile(scenario, JSON.stringify({ calls: [
      { tool: 'bash', input: { command: 'node bin/graphyard.mjs master decisions GY-88' } },
      { tool: 'graphyard_decide', input: { decision, approve: 'yes', reason } },
      { tool: 'graphyard_decide', input: { decision, approve: true, reason } },
    ] }));
    const launched = await launchApprover(root, item, decision, undefined, [], herdr(), {}, { fetcher });
    assert.equal(launched.runtime, 'pi');
    assert.equal(launched.pane, null, 'no terminal pane');
    // While it runs, the loop's inventory lists it under its session name, so supervision waits on it.
    const inventory = await listHerdrAgents(herdr());
    assert.deepEqual(inventory.find(agent => agent.name === launched.agentName), { name: launched.agentName, agent: 'pi', agent_status: 'working' });
    const watch = approvalWatchSchema.parse({ work: 'GY-88', action: 'rework', decision, agentName: launched.agentName, requestedAt: new Date().toISOString(), launchedAt: new Date().toISOString(), launches: 1, run: launched.run });
    assert.equal(approvalStep(watch, { state: 'requested' }, { agents: inventory, available: true }, Date.now()).step, 'wait');

    const record = await launched.settled!;
    assert.deepEqual(record.result, { ok: true, tool: 'graphyard_decide', submitted: 1 });
    assert.deepEqual(record.applied, [{ subject: `decision ${decision}`, outcome: 'applied', detail: `approved: ${reason}` }]);
    assert.ok(record.events.some(event => event.kind === 'tool-end' && (event as any).error === true), 'the malformed call was rejected back to the agent');
    assert.ok(record.events.some(event => event.kind === 'message' && /Graphyard autonomy contract: act without asking/.test((event as any).text)), 'the session ran under the autonomy contract');
    // Applied once, as the approver identity — not the master's or its operator agent's — on the route `master approve` uses.
    assert.deepEqual(posted, [{ url: 'https://graphyard.example/api/work/id-GY-88/approve', auth: `Bearer ${approverToken}`, body: { decision, reason } }]);
    const launch = JSON.parse(await readFile(`${scenario}.launched`, 'utf8'));
    assert.equal(launch.role, 'approver');
    assert.deepEqual(launch.args.slice(0, 2), ['--mode', 'json']);
    assert.equal(launch.args[launch.args.indexOf('--extension') + 1], extension);
    assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'zai/glm-5.3-flash');
    assert.equal(liveRun(launched.agentName), null);
    assert.equal((await listHerdrAgents(herdr())).some(agent => agent.name === launched.agentName), false, 'an ended run is gone from the inventory');
    assert.equal(approvalWatchSchema.parse({ ...watch, run: record }).run?.result?.ok, true, 'the watch keeps the run record');

    // Separation is the server's: a verdict it refuses (this approver produced evidence for the
    // item) is recorded as refused, and nothing retries it under another identity.
    posted.length = 0;
    answer(() => new Response(JSON.stringify({ error: 'The approver must not have produced evidence for this work' }), { status: 403 }));
    await writeFile(scenario, JSON.stringify({ calls: [{ tool: 'graphyard_decide', input: { decision, approve: false, reason: 'not justified' } }] }));
    const refused = await (await launchApprover(root, item, decision, undefined, [], herdr(), {}, { fetcher })).settled!;
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { action: 'refuse', decision, reason: 'not justified' });
    assert.equal(refused.applied[0].outcome, 'refused');
    assert.match(refused.applied[0].detail, /Graphyard refused work\/id-GY-88\/approve \(403\): The approver must not have produced evidence/);

    // A verdict for another decision is not this run's submission, so nothing is applied.
    posted.length = 0;
    await writeFile(scenario, JSON.stringify({ calls: [{ tool: 'graphyard_decide', input: { decision: 'another-decision', approve: true, reason } }] }));
    const stray = await (await launchApprover(root, item, decision, undefined, [], herdr(), {}, { fetcher })).settled!;
    assert.equal(stray.result?.ok === false && stray.result.reason, 'invalid-payload');
    assert.deepEqual(posted, []);
  } finally { await cleanup(); }
});

test('integration:pi-narrow-roles with pi selected the unit proof producer runs headless, its evidence is submitted as the producer principal, and the session record keeps the run', async () => {
  const { root, scenario, posted, fetcher, cleanup } = await installation({ producer: 'pi' });
  try {
    const proofs = ['unit:pi-graphyard-tools', 'unit:pi-destructive-guard'];
    const item = work('GY-89', 'unit', proofs);
    await writeFile(scenario, JSON.stringify({ calls: [
      { tool: 'bash', input: { command: 'rm -rf "$WORKTREE"/node_modules' } },
      { tool: 'graphyard_submit_evidence', input: evidence(proofs[0]) },
      { tool: 'graphyard_submit_evidence', input: evidence(proofs[1], 'fail') },
    ] }));
    const config = await loadMasterConfig(root);
    const launched = await launchProducer(root, item, requestOf(item), config.producers[0], [], new Date().toISOString(), { fetcher, filesystem: durable }) as any;
    assert.equal(launched.runtime, 'pi');
    assert.equal(launched.pane, null);
    let ledger = await readProducerLedger(root);
    assert.deepEqual(ledger.producers.map(record => [record.state, record.runtime, record.pane, record.principal]), [['pending', 'pi', null, 'proof-runner']]);

    const run = await launched.settled;
    assert.deepEqual(run.result, { ok: true, tool: 'graphyard_submit_evidence', submitted: 2 });
    assert.deepEqual(posted.map(call => [call.url, call.auth, call.body.proof, call.body.result]), [
      ['https://graphyard.example/api/work/id-GY-89/evidence', `Bearer ${producerToken}`, proofs[0], 'pass'],
      ['https://graphyard.example/api/work/id-GY-89/evidence', `Bearer ${producerToken}`, proofs[1], 'fail'],
    ], 'each proof submitted on the evidence route with the producer credential');
    const { environment, ...submitted } = posted[0].body;
    assert.deepEqual(submitted, evidence(proofs[0]), 'the validated payload, unchanged');
    assert.equal(environment, `pi zai/glm-5.3-flash via ${config.run.pi!.command}`);
    assert.ok(run.events.some((event: any) => event.kind === 'tool-end' && event.tool === 'bash' && event.error && /Graphyard refused this command/.test(event.text)), 'the destructive-command guard ran in the session');
    const launch = JSON.parse(await readFile(`${scenario}.launched`, 'utf8'));
    assert.equal(launch.role, 'producer');
    assert.equal(launch.cwd, launched.checkout, 'the run works in the session directory allocated for it');

    // The session record keeps the run: its events, result, and what became of each submission.
    ledger = await readProducerLedger(root);
    const kept = ledger.producers[0].run!;
    assert.deepEqual(kept.applied.map(entry => [entry.subject, entry.outcome]), [[`proof ${proofs[0]}`, 'applied'], [`proof ${proofs[1]}`, 'applied']]);
    assert.ok(kept.endedAt && kept.events.length > 0);

    // Trust is the control plane's: reconciliation settles the record from the evidence the server
    // holds, exactly as for a Herdr session, and removes the checkout.
    const trusted = proofs.map((proof, index) => ({ proof, sha: H, baseSha: B, policyRevision: 4, result: index ? 'fail' : 'pass', executed: 3, skipped: 0, trusted: true }));
    await reconcileProducers(root, config, [{ ...item, evidence: trusted } as any], [], { run: herdr() });
    ledger = await readProducerLedger(root);
    assert.equal(ledger.producers[0].state, 'completed');
    assert.match(ledger.producers[0].resolution!, /trusted evidence failed for unit:pi-destructive-guard/);
    assert.equal(existsSync(launched.checkout), false);
  } finally { await cleanup(); }
});

test('integration:pi-narrow-roles without the setting, and for non-unit proof groups, the roles launch in Herdr as today', async () => {
  const { root, scenario, cleanup } = await installation();
  try {
    await writeFile(scenario, JSON.stringify({ calls: [] }));
    const config = await loadMasterConfig(root);
    assert.equal(config.run.runtimes, undefined);
    const item = work('GY-90', 'unit', ['unit:pi-graphyard-tools']);
    const calls: string[][] = [];
    const launched = await launchProducer(root, item, requestOf(item), config.producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable }) as any;
    assert.equal(launched.pane, 'pane-1', 'a Herdr pane was created');
    assert.equal(launched.runtime, undefined);
    assert.ok(calls.some(args => args[0] === 'tab' && args[1] === 'create'));
    assert.equal((await readProducerLedger(root)).producers[0].runtime, undefined);
    // The approver with no setting takes today's Herdr path, which needs a registry runtime.
    await assert.rejects(launchApprover(root, item, decision, undefined, [], herdr()), /No runtime is configured for the approver/);
    assert.equal(existsSync(`${scenario}.launched`), false, 'Pi was never started');
  } finally { await cleanup(); }

  const selected = await installation({ approver: 'pi', producer: 'pi' });
  try {
    const config = await loadMasterConfig(selected.root);
    const item = work('GY-91', 'integration', ['integration:pi-narrow-roles']);
    const launched = await launchProducer(selected.root, item, requestOf(item), config.producers[0], [], new Date().toISOString(), { run: herdr(), filesystem: durable }) as any;
    assert.equal(launched.pane, 'pane-1', 'an integration group still launches in Herdr');
    assert.equal(existsSync(`${selected.scenario}.launched`), false);
  } finally { await selected.cleanup(); }
});
