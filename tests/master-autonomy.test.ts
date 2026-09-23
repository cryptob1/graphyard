import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import {
  agentOwner, approvedMerge, buildMasterStatus, humanOnlyDecisions, installWorkerHarness, loadMasterConfig, managedMasterInstructions, masterHarness,
  previewPrincipalRotation, restartMasterLoop, runAutonomyCommand, setupAutonomy, setupMaster, workAttentionOwner, workerHarnessPlan, type AttentionItem, type AutonomyDependencies,
} from '../src/master.js';

// GY-70: onboarding gives the master its own operator-agent identity and a separate approver
// identity, role-scoped harness rules, and the commands that keep routine operation free of a
// human; master status names who resolves every attention item. Each test is named for its proof.
const repositoryName = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'worker-one', role: 'worker', sessionKind: 'ai' };
const roster = [operator, coordinator, worker];
const credentials = roster.map(principal => ({ ...principal, token: `autonomy-${principal.id}-${'y'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const publicUrl = 'https://graphyard.example';
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
// The master talks to `publicUrl`; the test serves it from the local control plane.
const local: typeof fetch = (input, init) => fetch(String(input).replace(publicUrl, url), init);
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: coordinator.id, role: 'coordinator' }, repository: repositoryName, baseBranch: 'main', githubAppId: 1234 }));

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 41;
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-master-autonomy-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('autonomy_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/autonomy_test`); await store.init();
  engine = new Engine(store, [15368], 120, repositoryName); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-root-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repositoryName}.git`], { cwd: root });
  await writeFile(join(root, '.gitignore'), '.graphyard/\n.claude/settings.local.json\n');
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-credentials-'));
  // A launcher that records how it was invoked, so a restarted loop is observable without a server.
  const launcher = join(await mkdtemp(join(tmpdir(), 'graphyard-autonomy-cli-')), 'graphyard.mjs');
  await writeFile(launcher, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(root, 'launched.txt'))}, process.argv.slice(2).join(' ') + '\\n');\n`);
  await setupMaster(root, { url: publicUrl, token: token(coordinator), cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
  return { root, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(credentialDirectory, { recursive: true, force: true }), rm(launcher, { force: true })]) };
}
const coordinatorApi = async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token(coordinator)}` } });
  const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
};
const dependencies = (overrides: Partial<AutonomyDependencies> = {}): AutonomyDependencies => ({ coordinator: coordinatorApi, readSecret: async () => token(operator), agents: () => [], daemonLock: async () => null, fetcher: local, ...overrides });

test('integration:master-autonomy-setup — onboarding provisions the master and approver identities and harness rules, and routine operations need no human', async () => {
  const { root, cleanup } = await fixture();
  try {
    let config = await loadMasterConfig(root);
    // Preview changes nothing and names the identities, their capabilities and the human-only list.
    const preview = await setupAutonomy(root, { apply: false }, local);
    assert.equal(preview.applied, false); assert.deepEqual(preview.humanOnly, [...humanOnlyDecisions]);
    assert.deepEqual(preview.identities.map(identity => identity.id), ['graphyard-master-project-operator', 'graphyard-approver-project']);
    assert.equal((await loadMasterConfig(root)).operatorAgent, undefined);
    await assert.rejects(runAutonomyCommand(root, config, 'autonomy', ['--apply'], dependencies()), /--admin-token-stdin/);
    await assert.rejects(setupAutonomy(root, { apply: true, adminToken: token(coordinator) }, local), /needs the admin credential/);

    // Apply with the admin credential once: both identities exist on the server, their credentials
    // are private files outside the repository, and the configuration records paths only.
    const applied = await runAutonomyCommand(root, config, 'autonomy', ['--admin-token-stdin', '--apply'], dependencies()) as Awaited<ReturnType<typeof setupAutonomy>>;
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.changes, ['graphyard-master-project-operator: provisioned', 'graphyard-approver-project: provisioned']);
    config = await loadMasterConfig(root);
    assert.equal(config.operatorAgent!.id, 'graphyard-master-project-operator'); assert.equal(config.approver!.id, 'graphyard-approver-project');
    for (const file of [config.operatorAgent!.credentialFile, config.approver!.credentialFile]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600); assert.ok(!file.startsWith(root));
    }
    assert.equal(JSON.stringify(await readFile(join(root, '.graphyard/master.json'), 'utf8')).includes(await readFile(config.operatorAgent!.credentialFile, 'utf8')), false, 'the configuration never holds a token');
    const agents = await (await fetch(`${url}/api/operator-agents`, { headers: { Authorization: `Bearer ${token(operator)}` } })).json() as any[];
    const master = agents.find(agent => agent.id === 'graphyard-master-project-operator'), approver = agents.find(agent => agent.id === 'graphyard-approver-project');
    assert.ok(master.capabilities.includes('decision:resolve') && master.capabilities.includes('intent:create') && !master.capabilities.includes('decision:approve'));
    assert.deepEqual(approver.capabilities, ['decision:approve'], 'the approver can only approve');
    // The master's harness rules are installed with the autonomy denies.
    const settings = JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes(`Bash(node ${config.cliPath} master:*)`));
    assert.ok(settings.permissions.deny.includes('Bash(*GRAPHYARD_TOKEN_FILE=*)') && settings.permissions.deny.includes('Bash(git push:*)'));
    assert.ok(masterHarness(root, config, 'claude').deny.every(rule => rule.why.length > 30));

    // Re-running is idempotent; a lost credential is repaired by rotation, never by a new identity.
    assert.deepEqual((await setupAutonomy(root, { apply: true, adminToken: token(operator) }, local)).changes, []);
    await rm(config.operatorAgent!.credentialFile);
    assert.deepEqual((await setupAutonomy(root, { apply: true, adminToken: token(operator) }, local)).changes, ['graphyard-master-project-operator: credential rotated']);

    // Routine operations as the master's own identity: create, release, unblock, add requirements.
    const intent = join(root, 'intent.json');
    await writeFile(intent, JSON.stringify({ title: 'Autonomous item', plannedFiles: ['src/autonomous.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true } }));
    let work = await runAutonomyCommand(root, config, 'create', [intent, 'Operator goal: ship autonomous delivery'], dependencies()) as Work;
    assert.equal(work.stage, 'backlog');
    work = await runAutonomyCommand(root, config, 'release', [work.key, 'Next by priority'], dependencies()) as Work;
    assert.equal(work.ready, true);
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'blocked', work.id, { epoch: work.epoch, reason: 'Waiting on a fixture' }, randomUUID());
    work = await runAutonomyCommand(root, config, 'unblock', [work.key, 'Fixture is ready'], dependencies()) as Work;
    assert.equal(work.blocker, null);
    await engine.execute(worker, 'release', work.id, { epoch: work.epoch }, randomUUID());
    const additions = join(root, 'additions.json');
    await writeFile(additions, JSON.stringify({ criteria: [...work.criteria, { id: 'AC-2', text: 'Documented', proofs: ['unit:documented'] }] }));
    work = await runAutonomyCommand(root, config, 'requirements', [work.key, additions, 'Documentation is part of done'], dependencies()) as Work;
    assert.deepEqual(work.criteria.map(criterion => criterion.id), ['AC-1', 'AC-2']);
    const history = (await store.events(work.id)).map(event => [event.kind, event.actor]);
    for (const kind of ['ready', 'unblock', 'requirements']) assert.ok(history.some(([k, actor]) => k === kind && actor === 'graphyard-master-project-operator'), `${kind} is attributed to the master's identity`);

    // A two-party decision from the CLI: the master requests; its own session cannot approve.
    const decision = await runAutonomyCommand(root, config, 'decide', [work.key, 'unblock', 'Nothing blocks it'], dependencies()).catch(error => error);
    assert.match(String(decision.message), /Task has no blocker to clear/, 'the request binds the current state and is refused when it no longer holds');
    const previous = { master: process.env.GRAPHYARD_MASTER, file: process.env.GRAPHYARD_TOKEN_FILE };
    try {
      process.env.GRAPHYARD_MASTER = '1';
      await assert.rejects(runAutonomyCommand(root, config, 'approve', [work.key, randomUUID(), 'mine'], dependencies()), /master never approves its own decisions/);
      delete process.env.GRAPHYARD_MASTER; process.env.GRAPHYARD_TOKEN_FILE = config.operatorAgent!.credentialFile;
      await assert.rejects(runAutonomyCommand(root, config, 'approve', [work.key, randomUUID(), 'mine'], dependencies()), /one of the master's own credentials/);
    } finally {
      if (previous.master === undefined) delete process.env.GRAPHYARD_MASTER; else process.env.GRAPHYARD_MASTER = previous.master;
      if (previous.file === undefined) delete process.env.GRAPHYARD_TOKEN_FILE; else process.env.GRAPHYARD_TOKEN_FILE = previous.file;
    }

    // Principal rotation: previewed against the live roster, refused when it drops a live principal.
    await writeFile(join(root, '.graphyard/credentials.json'), JSON.stringify([...credentials, { id: 'worker-two', role: 'worker', token: 'z'.repeat(40) }]), { mode: 0o600 });
    const rotation = await runAutonomyCommand(root, config, 'principals', [], dependencies()) as ReturnType<typeof previewPrincipalRotation>;
    assert.equal(rotation.applicable, true); assert.deepEqual(rotation.added, ['worker-two (worker)']);
    assert.equal(JSON.stringify(rotation).includes('z'.repeat(40)), false, 'the preview never prints a token');
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => { calls.push([command, ...args]); return ''; };
    await assert.rejects(runAutonomyCommand(root, config, 'principals', ['--apply'], dependencies({ run })), /no roster applier/);
    await mkdir(join(root, 'scripts')); await writeFile(join(root, 'scripts/provision-railway.mjs'), '');
    const rotated = await runAutonomyCommand(root, config, 'principals', ['--apply'], dependencies({ run })) as { applied: boolean };
    assert.equal(rotated.applied, true); assert.deepEqual(calls, [[process.execPath, join(root, 'scripts/provision-railway.mjs')]]);
    await writeFile(join(root, '.graphyard/credentials.json'), JSON.stringify(credentials.filter(credential => credential.id !== worker.id).map(credential => credential.id === coordinator.id ? { ...credential, role: 'admin' } : credential)), { mode: 0o600 });
    await assert.rejects(runAutonomyCommand(root, config, 'principals', ['--apply'], dependencies({ run })), /worker-one \(worker\) is live and would be dropped; master-loop would change role from coordinator to admin/);
    assert.equal(calls.length, 1, 'a refused rotation deploys nothing');

    // Restarting the loop: the running loop on this host is stopped and a fresh one started detached.
    const running = spawn('sleep', ['30']);
    const restarted = await runAutonomyCommand(root, config, 'restart', [], dependencies({ daemonLock: async () => ({ pid: running.pid!, host: config.hostId, heartbeatAt: new Date().toISOString() }) })) as Awaited<ReturnType<typeof restartMasterLoop>>;
    assert.equal(restarted.stopped, running.pid); assert.ok(restarted.started);
    for (let attempt = 0; attempt < 50 && !(await readFile(join(root, 'launched.txt'), 'utf8').catch(() => '')); attempt++) await new Promise(done => setTimeout(done, 100));
    assert.equal((await readFile(join(root, 'launched.txt'), 'utf8')).trim(), 'master run');
    await assert.rejects(restartMasterLoop(root, config, { pid: 1, host: 'another-host', heartbeatAt: new Date().toISOString() }), /runs on another-host/);

    // Worker sessions get their own rules in their worktree and can push their assigned branch.
    const worktree = await mkdtemp(join(tmpdir(), 'graphyard-autonomy-worktree-'));
    try {
      execFileSync('git', ['init', '-q', worktree]);
      // Only the worktree's own ignore rules count, whatever this machine's global excludes say.
      execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: worktree });
      const profile = { name: 'claude-worker', principal: worker.id, agentName: 'worker-a', mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto', agentArgs: [], environment: {} } as any;
      assert.equal((await installWorkerHarness(config, profile, 'GY-9', { epoch: 3, path: worktree, base: 'c'.repeat(40) })).applied, false, 'no rules are written where Git would track them');
      await writeFile(join(worktree, '.gitignore'), '.claude/settings.local.json\n');
      assert.equal((await installWorkerHarness(config, profile, 'GY-9', { epoch: 3, path: worktree, base: 'c'.repeat(40) })).applied, true);
      const rules = JSON.parse(await readFile(join(worktree, '.claude/settings.local.json'), 'utf8')).permissions;
      assert.ok(rules.allow.includes('Bash(git push origin graphyard/gy-9-3)') && rules.allow.includes('Bash(gh pr create:*)') && rules.allow.includes(`Bash(node ${config.cliPath} complete:*)`));
      for (const denied of ['Bash(git push *--force*)', 'Bash(git push -f*)', 'Bash(git push origin main*)', 'Bash(gh pr merge:*)', 'Bash(git rebase:*)', 'Read(**/*.token)']) assert.ok(rules.deny.includes(denied), `${denied} is denied`);
      // The one rewrite a worker may make is restore-branch's lease push of its own branch (GY-128); no raw force push, never main.
      assert.ok(rules.allow.includes(`Bash(node ${config.cliPath} restore-branch:*)`));
      assert.ok(!rules.allow.some((rule: string) => /push origin main|--force/.test(rule)));
      assert.equal((await installWorkerHarness(config, { ...profile, kind: 'codex' }, 'GY-9', { epoch: 3, path: worktree, base: 'c'.repeat(40) })).applied, false);
      assert.equal(workerHarnessPlan({ cliPath: '/cli', branch: 'graphyard/gy-1-1', baseBranch: 'main', credentialHome: '/creds' }).allow.every(rule => rule.why.length > 20), true);
    } finally { await rm(worktree, { recursive: true, force: true }); }

    // With automatic merging off, only an approved merge decision for the exact candidate counts.
    const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 1, branch: 'graphyard/gy-9-3', author: 'worker' };
    const item = { candidate, policyRevision: 2 } as Work;
    const approvedDecision = { action: 'merge', state: 'applied', approvedBy: 'approver', input: { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 2 } };
    assert.ok(approvedMerge(item, [approvedDecision]));
    assert.equal(approvedMerge(item, [{ ...approvedDecision, state: 'requested' }]), null);
    assert.equal(approvedMerge(item, [{ ...approvedDecision, input: { ...approvedDecision.input, sha: 'c'.repeat(40) } }]), null);
  } finally { await cleanup(); }
});

function item(overrides: Partial<Work> = {}): Work {
  return { id: `id-${overrides.key ?? 'GY-1'}`, key: 'GY-1', title: 'Item', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/item.ts'], stage: 'build', revision: 3, policyRevision: 1, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z',
    stageEnteredAt: '2030-01-01T00:00:00Z', ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}

test('unit:attention-ownership — every attention item names the role that resolves it and the next command, and only the human-only list goes to a human', async () => {
  const now = '2030-01-01T03:00:00Z';
  const future = '2030-01-01T04:00:00Z';
  const gate = (name: string, reason: string) => [{ name, passed: false, reasons: [reason] }];
  const work = [
    item({ key: 'GY-1', containmentQuarantine: { owner: 'w', epoch: 1, at: now, settlementHash: 'a'.repeat(64) } as any }),
    item({ key: 'GY-2', containmentQuarantine: { owner: 'w', epoch: 1, at: now, settlementHash: 'b'.repeat(64) } as any }),
    item({ key: 'GY-3', lease: { owner: 'worker-one', epoch: 1, expiresAt: future } }),
    item({ key: 'GY-4', proofGaps: ['manual:audit'] }),
    item({ key: 'GY-5', blocker: 'Needs a decision', escalations: [{ trigger: 'requirement-weakening', reason: 'AC-2 retired', at: now, actor: 'master' }] as any, gates: gate('merge', 'Unresolved requirement-weakening escalation requires operator resolution: AC-2 retired') }),
    item({ key: 'GY-6', blocker: 'External fixture' }),
    item({ key: 'GY-7', blocker: 'Awaiting attestation', gates: gate('acceptance', 'AC-1: manual:audit needs trusted passing evidence') }),
    item({ key: 'GY-8', blocker: 'Awaiting review', gates: gate('review', 'Independent approval of the current commit is required') }),
  ];
  const containment = { 'id-GY-1': { settleable: true, refusals: [], verification: null }, 'id-GY-2': { settleable: false, refusals: ['Supervisor absence has not been verified on the registered host'], verification: null } } as any;
  const controlPlane = {
    appPermissions: { attention: ['App graphyard lacks Contents: write (installed with read); accept the pending permission request', 'The installation is suspended'] },
    heldJobs: 2,
    delegationLimits: { attention: ['Independent review/proof agent limit exceeded: 4/2; Set GRAPHYARD_MAX_REVIEWERS=4 on the deployment'] },
  };
  const status = buildMasterStatus({ work, now }, [], [], {}, containment, undefined, 'main', controlPlane);
  const items: AttentionItem[] = status.attentionItems;
  assert.equal(items.length, status.counts.attention, 'every counted attention item is listed with its owner');
  for (const entry of items) {
    assert.ok(entry.text && entry.next && entry.role, `${entry.subject}: text, role and next command`);
    if (entry.human) assert.ok(humanOnlyDecisions.includes(entry.humanOnly!), `${entry.subject} goes to a human only for a human-only decision`);
    else {
      assert.equal(entry.humanOnly, null);
      assert.doesNotMatch(entry.next, /ask (the )?(human|operator)|operator (must|should) run/i, `${entry.subject}: an agent item never hands a command to a human`);
    }
  }
  const owner = (subject: string) => items.find(entry => entry.subject === subject)!;
  assert.deepEqual([owner('GY-1').role, owner('GY-1').next], ['master', 'graphyard master settle-containment GY-1 REASON']);
  assert.equal(owner('GY-2').approvedBy, 'approver'); assert.match(owner('GY-2').next, /graphyard master decide GY-2 rework REASON/);
  assert.match(owner('GY-3').next, /graphyard master dispatch GY-3 PROFILE/);
  assert.match(owner('GY-4').next, /graphyard master decide GY-4 grant .*manual:audit/); assert.equal(owner('GY-4').approvedBy, 'approver');
  assert.match(owner('GY-5').next, /graphyard master decide GY-5 resolve '\{"trigger":"requirement-weakening"\}'/); assert.equal(owner('GY-5').approvedBy, 'approver');
  assert.match(owner('GY-6').next, /graphyard master unblock GY-6 REASON/); assert.equal(owner('GY-6').approvedBy, null);
  assert.match(owner('GY-7').next, /graphyard master decide GY-7 attest '\{"proof":"manual:audit"\}'/);
  assert.equal(owner('GY-8').role, 'reviewer');
  const installation = items.filter(entry => entry.subject === 'installation');
  assert.deepEqual(installation.map(entry => entry.role), ['master', 'human', 'control plane', 'master']);
  assert.match(installation[0].next, /graphyard master browser app-permissions/);
  assert.equal(installation[1].humanOnly, 'spending money or opening third-party accounts');
  assert.match(installation[3].next, /Set GRAPHYARD_MAX_REVIEWERS=4 on the deployment/);
  // Each row carries the same owner beside its attention text.
  assert.deepEqual(status.work.find(row => row.key === 'GY-6')!.attentionOwner, agentOwner('master', owner('GY-6').next));
  // Every cause the row chain can raise has an agent owner.
  for (const cause of ['containment-settleable', 'containment', 'session', 'proof-gap', 'reviewer-exhausted', 'launch-review', 'launch-producer', 'gate'] as const) {
    const resolved = workAttentionOwner(item({ key: 'GY-9' }), cause);
    assert.equal(resolved.human, false, `${cause} is an agent's`); assert.ok(resolved.next.length > 10);
  }

  // The generated instructions and the master guide never ask a human for what an agent may do,
  // and state the reduced human-only list.
  const guide = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');
  const instructions = managedMasterInstructions('');
  const forbidden = [/wait for\s+explicit operator approval/i, /ask (the )?(human )?operator to (run|approve|release|narrow|return)/i, /request operator rework/i,
    /human-only: choosing/i, /stays? with the human operator/i, /operator attestation path/i, /capacity decision for the operator/i];
  for (const [name, text] of [['docs/master-agent.md', guide], ['generated instructions', instructions]] as const) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name} must not route an agent-permitted action to a human: ${pattern}`);
    for (const decision of humanOnlyDecisions) assert.ok(text.replace(/\s+/g, ' ').includes(decision), `${name} states the human-only decision: ${decision}`);
  }
  for (const command of ['master decide GY-N', 'master approver GY-N DECISION']) assert.ok(instructions.replace(/\s+/g, ' ').includes(command), `the generated instructions route decisions through ${command}`);
});
