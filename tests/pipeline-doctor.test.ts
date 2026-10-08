import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { decisionReadConcurrency, emptyHeldDecisions } from '../src/daemon/decision-reads.js';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { Timings } from '../src/master/timings.js';
import { approverSessionName } from '../src/master/autonomy.js';
import { workerSubmissionBoundMs } from '../src/model/attempt-bound.js';
import { clearDoctorRuns, clearCoveredBlockers, coveredScopePaths, decisionCheckMs, doctorBounds, doctorDue, doctorIntervalMs, doctorPrompt, doctorReportPayloadSchema, doctorRunsSettled, doctorSanctionedCommands, doctorSessionArgs, doctorSessionTools, doctorStep, relaunchUnansweredApprovers, settleSubmittedContainment, stopDoctorRuns, unansweredDecisionMs, type DoctorEffects } from '../src/daemon/doctor.js';
import { applyDoctorRun, doctorTool } from '../src/daemon/doctor.js';
import { loopAttention, type LoopLiveness } from '../src/daemon/liveness.js';
import { silenceBudgetMs, type SilenceEntry } from '../src/daemon/metrics.js';
import { faultClassOf } from '../src/model/fault-classes.js';
import { doctorRunRecordSchema, type DoctorRunRecord } from '../src/daemon/state.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import graphyardExtension, { doctorSanctionedCommands as piSanctioned, doctorRedirects, doctorSegmentAllowed, graphyardTools as piTools } from '../integrations/pi/index.js';
import { statusRoutes, doctorFindingEvent, doctorRunEvent } from '../src/server/routes/status.js';
import type { Runner } from '../src/runner/types.js';
import type { Work } from '../src/model.js';
import { operatorAgentRouteGuard } from '../src/server/auth.js';
import { Next } from '../src/server/routes.js';
import { containmentSettlementRefusals, containmentVerificationSchema } from '../src/quarantine.js';
import { RefusedResponse } from '../src/model/refusal.js';

// Each test is named for the proof it produces (GY-711): unit:doctor-scheduled-and-scoped,
// unit:doctor-run-recorded and unit:loop-applies-routine-remedies.

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/coordinator.token', cliPath: '/usr/lib/graphyard/bin/graphyard.mjs',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
}

function item(overrides: Partial<Work> = {}): Work {
  return { id: 'id-GY-74', key: 'GY-74', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/item.ts'], stage: 'build', revision: 3, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}

function cycle(work: Work[], overrides: Partial<Omit<Cycle, 'effects'>> & { doctor?: DoctorEffects | null; effects?: Partial<DaemonEffects> } = {}): Cycle {
  const { effects: effectOverrides, doctor, ...cycleOverrides } = overrides;
  const master = config();
  const clock = Date.parse(observedAt);
  const base: DaemonEffects = {
    agents: () => overrides.agents ?? [],
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: observedAt }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: observedAt, reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };
  const state: DaemonState = overrides.state ?? emptyDaemonState(master);
  const effects = { ...base, ...effectOverrides, ...(doctor === null || doctor === undefined ? {} : { doctor }) } as DaemonEffects;
  return {
    config: master, state, effects, now: () => clock, snapshot: { work, now: observedAt }, clock, clockOffset: { min: 0, max: 0 },
    performed: [], agents: overrides.agents ?? [], credentials: {}, open: work.filter(entry => entry.stage !== 'done'),
    owns: () => false, heldBy: () => null, timings: new Timings(() => clock),
    launcher: new Launcher(Number.POSITIVE_INFINITY),
    launch: () => false, detached: false, heldDecisions: emptyHeldDecisions(),
    isolate: async (_kind, _item, _name, body) => await body(),
    ...cycleOverrides,
  } as Cycle;
}

const words = (...values: string[]) => values.map(value => ({ value, dynamic: false, glob: false }));
const liveAgent = (name: string) => ({ name, agent_status: 'working', pane_id: 'p1' } as any);
const summary = (at_: string, runState: 'reported' | 'running' = 'reported'): DoctorRunRecord => ({ at: at_, state: runState, runs: [], findings: [], actions: [], filed: [], detail: '' });

test('unit:doctor-scheduled-and-scoped — the doctor runs every ten minutes by default on a configurable interval, its session holds only the sanctioned commands with a refusal recorded rather than run, and the shipped template names every fault bound', async () => {
  const settings = doctorSettingsSchema.parse({});
  assert.equal(settings.enabled, true, 'the doctor is on by default');
  assert.equal(settings.intervalMinutes, 10, 'the doctor runs every ten minutes by default');
  assert.notEqual(settings.fallbackModel, settings.model, 'the fallback model is stronger than the default model');
  const master = config();
  const state = emptyDaemonState(master);
  // The schedule: never run, it is due; nine minutes after a run it is not; at ten it is.
  state.doctor.runs = [summary(at(0))];
  assert.equal(doctorDue(state, Date.parse(at(9 * 60_000)), settings), false, 'nine minutes after the last run the doctor is not due');
  assert.equal(doctorDue(state, Date.parse(at(10 * 60_000)), settings), true, 'ten minutes after the last run the doctor is due');
  // A run still in flight is never overlapped, whatever the interval.
  state.doctor.runs.push(summary(at(10 * 60_000), 'running'));
  assert.equal(doctorDue(state, Date.parse(at(30 * 60_000)), settings), false, 'a run in flight is not overlapped');
  // The interval is the operator's: run.doctor.intervalMinutes=30 moves the bound.
  const slower = doctorSettingsSchema.parse({ intervalMinutes: 30 });
  assert.equal(doctorIntervalMs(slower), 30 * 60_000);
  assert.equal(doctorDue({ doctor: { runs: [summary(at(0))] } }, Date.parse(at(10 * 60_000)), slower), false, 'on a 30-minute interval a ten-minute-old run is not due');

  // The role's command allowlist: the sanctioned master commands run; merge, dispatch, evidence
  // and lease commands are refused with a reason that says the refusal is recorded, not run.
  assert.deepEqual([...piSanctioned].sort(), [...doctorSanctionedCommands].sort(), 'the integration and the loop agree on the sanctioned commands');
  for (const command of doctorSanctionedCommands) {
    assert.deepEqual(doctorSegmentAllowed(words('graphyard', 'master', command, 'GY-74', 'reason')), { allow: true }, `master ${command} is sanctioned`);
  }
  for (const segments of [['graphyard', 'master', 'merge', 'GY-74'], ['graphyard', 'master', 'dispatch', 'GY-74', 'profile'], ['graphyard', 'evidence', 'GY-74'], ['graphyard', 'claim', 'GY-74'], ['graphyard', 'complete', 'GY-74', '3', '1'], ['graphyard', 'heartbeat', 'GY-74'], ['git', 'push', 'origin', 'main'], ['npm', 'install'], ['rm', '-rf', 'src']]) {
    const verdict = doctorSegmentAllowed(words(...segments));
    assert.equal(verdict.allow, false, `${segments.join(' ')} is outside the allowlist`);
    if (!verdict.allow) assert.match(verdict.reason, /was not run|Record the refused command/, `${segments.join(' ')} is refused as recorded, not run`);
  }
  // Reads run: the status commands, and the read-only programs.
  for (const segments of [['graphyard', 'status', 'GY-74'], ['graphyard', 'master', 'status'], ['graphyard', 'master', 'decisions', 'GY-74'], ['git', 'log', '-5'], ['gh', 'pr', 'view', '12'], ['cat', 'README.md']]) {
    assert.deepEqual(doctorSegmentAllowed(words(...segments)), { allow: true }, `${segments.join(' ')} is read-only`);
  }
  // No way around the allowlist: node runs only the Graphyard CLI script with no node options;
  // nothing expands, wraps or assigns; reads stay inside the checkout, so the operator-agent
  // credential kept outside it is never read; git and gh run their read subcommands only; and a
  // redirection is refused on the raw line before any segment is judged.
  const guard = { cwd: process.cwd(), cli: master.cliPath, env: {} };
  const dynamic = (value: string) => ({ value, dynamic: true, glob: false });
  const glob = (value: string) => ({ value, dynamic: false, glob: true });
  const refused: [string, ReturnType<typeof words>][] = [
    ['node -e', words('node', '-e', 'require("child_process").execSync("git push")', 'status')],
    ['node --require', words('node', '--require', '/tmp/x.js', master.cliPath, 'status')],
    ['node another script', words('node', 'scripts/other.mjs', 'status')],
    ['an assignment', words('NODE_OPTIONS=--require=/tmp/x.js', 'node', master.cliPath, 'status')],
    ['a wrapper', words('env', 'cat', 'README.md')],
    ['sudo', words('sudo', 'cat', '/etc/shadow')],
    ['a script named like a read', words('./cat', 'README.md')],
    ['the credential by variable', [...words('cat'), dynamic('$GRAPHYARD_TOKEN_FILE')]],
    ['a brace glob', [...words('cat'), glob('{README.md,/etc/passwd}')]],
    ['a path glob', [...words('grep', 'token'), glob('src/**/*.ts')]],
    ['a node script glob', [...words('node'), glob('*.mjs'), ...words('master', 'status')]],
    ['a path outside the checkout', words('cat', '/home/someone/.graphyard/operator-agent.token')],
    ['the installation credentials inside the checkout', words('cat', '.graphyard/credentials.json')],
    ['the installation credentials by absolute path', words('cat', `${process.cwd()}/.graphyard/credentials.json`)],
    ['connection.json inside .graphyard', words('cat', '.graphyard/connection.json')],
    ['github-app.json inside .graphyard', words('cat', '.graphyard/github-app.json')],
    ['jq github-app.json inside .graphyard', words('jq', '.', '.graphyard/github-app.json')],
    ['a pem key inside the checkout', words('cat', 'some/key.pem')],
    ['a token file inside the checkout', words('cat', 'some/secret.token')],
    ['grep recursive inside .graphyard', words('grep', '-r', '-i', 'key', '.graphyard')],
    ['grep recursive inside checkout', words('grep', '-r', 'key', 'src')],
    ['grep recursive cluster', words('grep', '-ri', 'key', 'src')],
    ['grep --recursive', words('grep', '--recursive', 'key', 'src')],
    ['ls recursive', words('ls', '-R', 'src')],
    ['reading the .graphyard directory', words('ls', '.graphyard')],
    ['rg in .graphyard directory', words('rg', 'key', '.graphyard')],
    ['an environment file', words('cat', '.env')],
    ['an environment file variant', words('grep', 'TOKEN', '.env.local')],
    ['an environment file by absolute path', words('cat', `${process.cwd()}/.env`)],
    ['an environment file under a directory', words('cat', 'fixtures/.env')],
    ['a committed environment file', words('git', 'show', 'HEAD:.env')],
    ['an option naming an environment file', words('rg', '--ignore-file=.env', 'x')],
    ['an ssh key inside the checkout', words('cat', 'fixtures/id_rsa')],
    ['a netrc inside the checkout', words('head', '.netrc')],
    ['an npm registry auth file', words('cat', '.npmrc')],
    ['a pypi auth file', words('cat', 'pkg/.pypirc')],
    ['a yarn registry auth file', words('cat', '.yarnrc.yml')],
    ['the git config', words('cat', '.git/config')],
    ['the git directory', words('ls', '.git')],
    ['a nested git config', words('grep', 'extraheader', 'vendor/lib/.git/config')],
    ['a home path', words('grep', '-r', 'token', '~')],
    ['a parent path', words('cat', '../../secrets.token')],
    ['an option naming an outside path', words('rg', '--ignore-file=/etc/passwd', 'x')],
    ['a separate argument naming an outside path', words('jq', '--rawfile', 't', '/etc/passwd', '.')],
    ['git branch -D', words('git', 'branch', '-D', 'graphyard/gy-1-1')],
    ['git branch create', words('git', 'branch', 'new-branch')],
    ['git worktree remove', words('git', 'worktree', 'remove', '--force', '/work/GY-74-1')],
    ['git worktree add', words('git', 'worktree', 'add', 'x')],
    ['git -c', words('git', '-c', 'core.pager=sh', 'log')],
    ['git log --output', words('git', 'log', '--output=src/x.ts')],
    ['gh api', words('gh', 'api', '-X', 'DELETE', 'repos/o/p/git/refs/heads/main')],
    ['gh pr merge', words('gh', 'pr', 'merge', '12')],
    ['gh -R override', words('gh', 'pr', 'diff', '1', '-R', 'other/private')],
    ['gh -R attached override', words('gh', 'pr', 'view', '-Rother/private', '1')],
    ['gh --repo override', words('gh', 'pr', 'view', '--repo=other/private', '12')],
    ['a foreign PR URL', words('gh', 'pr', 'view', 'https://github.com/other/private/pull/5')],
    ['rg --pre', words('rg', '--pre', 'sh', 'x')],
    ['sort -o', words('sort', '-o', 'src/x.ts', 'README.md')],
    // GNU accepts unique prefixes of long options, and short options cluster: every abbreviation
    // of an option that writes, runs a program or writes temporaries is refused too.
    ['sort --output', words('sort', '--output', 'src/x.ts', 'README.md')],
    ['sort --output attached', words('sort', '--output=src/x.ts', 'README.md')],
    ['sort --out abbreviation', words('sort', '--out=package.json', 'package.json')],
    ['sort --o abbreviation', words('sort', '--o=package.json', 'package.json')],
    ['sort --compress-program abbreviation', words('sort', '--compress-p=sh', 'README.md')],
    ['sort --temporary-directory abbreviation', words('sort', '--temp', '/outside', 'README.md')],
    ['sort -T short form', words('sort', '-T', '/outside', 'README.md')],
    ['sort -ofile attached', words('sort', '-ofile', 'README.md')],
    ['sort clustered -ro', words('sort', '-ro', 'src/x.ts', 'README.md')],
    ['sort clustered -uTo', words('sort', '-uTo', 'src/x.ts', 'README.md')],
    ['a foreign PR URL upper-case host', words('gh', 'pr', 'view', 'https://GITHUB.COM/other/private/pull/5')],
    ['a foreign PR URL another host', words('gh', 'pr', 'view', 'https://github.evil.com/other/private/pull/5')],
    ['a foreign PR URL git protocol', words('gh', 'pr', 'view', 'git://github.com/other/private/pull/5')],
    ['an scp-style override', words('gh', 'pr', 'view', 'github.com:other/private')],
    ['a git@ override', words('gh', 'pr', 'view', 'git@github.com:other/private')],
    ['a --rep abbreviation', words('gh', 'pr', 'list', '--rep', 'other/private')],
    ['a browser launch', words('gh', 'pr', 'view', '12', '--web')],
    ['a short browser launch', words('gh', 'run', 'view', '-w')],
    ['a clustered browser launch', words('gh', 'issue', 'list', '-cw')],
  ];
  for (const [label, segment] of refused) assert.equal(doctorSegmentAllowed(segment, guard).allow, false, `${label} is refused`);
  for (const line of ['cat README.md > leaked.txt', 'cat "$GRAPHYARD_TOKEN_FILE" >> x', 'grep x README.md 2>&1', 'jq . < /etc/passwd']) assert.equal(doctorRedirects(line), true, `${line} redirects`);
  for (const line of ["grep '->' README.md", 'jq ".a > 1" x.json', 'gh pr view 12 && git log -1']) assert.equal(doctorRedirects(line), false, `${line} does not redirect`);
  for (const segment of [words('node', master.cliPath, 'master', 'status'), words('git', 'branch', '--show-current'), words('git', 'branch', '--list', 'graphyard/*'), words('git', 'worktree', 'list'),
    words('git', 'diff', 'main...HEAD'), words('gh', 'pr', 'checks', '12'), words('gh', 'pr', 'view', '12'), words('rg', 'doctor', 'src'),
    words('sort', '--stable', '--sort=human', 'README.md'), words('sort', '-r', '-n', 'README.md'), words('sort', '--parallel=4', 'README.md'), words('sort', '--random-source=seed', 'README.md'), words('cat', `${process.cwd()}/README.md`),
    words('cat', '.github/workflows/ci.yml'), words('cat', 'fixtures/credentials.example.json'), words('git', 'show', 'HEAD:package.json')])
    assert.deepEqual(doctorSegmentAllowed(segment, guard), { allow: true }, `${segment.map(word => word.value).join(' ')} is a read inside the checkout`);
  assert.equal(doctorSegmentAllowed(words('node', master.cliPath, 'master', 'merge', 'GY-74'), guard).allow, false, 'the named CLI still refuses merge');
  // An ambient GH_REPO or GH_HOST picks another repository with no word on the line: gh is refused
  // while either is set, and the extension clears both from the doctor's environment.
  for (const name of ['GH_REPO', 'GH_HOST']) assert.equal(doctorSegmentAllowed(words('gh', 'pr', 'view', '1'), { ...guard, env: { [name]: 'other/private' } }).allow, false, `gh with ${name} set is refused`);
  assert.deepEqual(doctorSegmentAllowed(words('gh', 'pr', 'view', '1'), { ...guard, env: {} }), { allow: true }, 'gh with no ambient override reads');

  // The doctor session launched through the headless runner gets exactly the doctor tool, and the
  // launch itself names that surface on the runtime's tools flag: bash under the allowlist and the
  // report tool — no read, edit or write ever starts, whatever the extension gate sees.
  assert.deepEqual(piTools('doctor').map(tool => tool.name), [doctorTool]);
  assert.deepEqual([...doctorSessionTools], ['bash', doctorTool]);
  assert.deepEqual([...doctorSessionArgs], ['--tools', `bash,${doctorTool}`]);

  // The report schema is the run record's own bound: a report carrying more findings than a run
  // record can hold is refused at validation, so nothing accepted is dropped before it is posted.
  assert.throws(() => doctorReportPayloadSchema.parse({ findings: Array.from({ length: 51 }, (_, index) => ({ subject: `GY-${index}`, check: 'blocked', detail: 'x' })), actions: [], filed: [] }),
    /<=50|at most 50/, '51 findings exceed the report bound');
  assert.equal(doctorReportPayloadSchema.parse({ findings: Array.from({ length: 50 }, (_, index) => ({ subject: `GY-${index}`, check: 'blocked', detail: 'x' })), actions: [], filed: [] }).findings.length, 50, '50 findings are accepted whole');

  // Every tool the doctor's session calls is judged at the extension hook, not only bash: no
  // built-in read, edit or write may bypass the allowlist and the checkout boundary, and only the
  // report tool joins bash on the allowed surface.
  const hook: Record<string, (event: any, ctx: any) => unknown> = {};
  graphyardExtension({ registerTool: () => {}, on: (event, handler) => { hook[event] = handler as never; return handler; } });
  const call = (toolName: string, input: any = {}) => hook.tool_call({ toolName, input }, { cwd: process.cwd() }) as { block?: boolean; reason?: string } | undefined;
  const role = process.env.GRAPHYARD_PI_ROLE;
  try {
    process.env.GRAPHYARD_PI_ROLE = 'doctor';
    for (const refusedTool of ['read', 'edit', 'write', 'grep_files', '']) {
      const verdict = call(refusedTool, { path: '/etc/passwd' });
      assert.equal(verdict?.block, true, `the ${refusedTool || 'unnamed'} tool is refused for the doctor role`);
      assert.match(verdict!.reason!, /was not run|Record the refused call/, `the ${refusedTool || 'unnamed'} refusal says it was recorded, not run`);
    }
    assert.equal(call(doctorTool, { findings: [], actions: [], filed: [] }), undefined, 'the doctor report tool runs');
    assert.equal(call('bash', { command: 'graphyard status GY-74' }), undefined, 'an allowlisted bash command runs');
    const refusedBash = call('bash', { command: 'cat {README.md,/etc/passwd}' });
    assert.equal(refusedBash?.block, true, 'a bash command outside the allowlist is still refused');
  } finally {
    if (role === undefined) delete process.env.GRAPHYARD_PI_ROLE; else process.env.GRAPHYARD_PI_ROLE = role;
  }
  // A doctor session starting with an ambient GH_REPO and GH_HOST clears both before any bash runs.
  const ambient = { role: process.env.GRAPHYARD_PI_ROLE, repo: process.env.GH_REPO, host: process.env.GH_HOST };
  try {
    Object.assign(process.env, { GRAPHYARD_PI_ROLE: 'doctor', GH_REPO: 'other/private', GH_HOST: 'github.example' });
    graphyardExtension({ registerTool: () => {}, on: (_event, handler) => handler });
    assert.equal(process.env.GH_REPO, undefined, 'the doctor extension clears GH_REPO');
    assert.equal(process.env.GH_HOST, undefined, 'the doctor extension clears GH_HOST');
  } finally {
    for (const [name, value] of [['GRAPHYARD_PI_ROLE', ambient.role], ['GH_REPO', ambient.repo], ['GH_HOST', ambient.host]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  // Another role keeps its built-in surface: the tool gate is the doctor's alone (the role is
  // read per call, and the finally above restored the session's own).
  assert.equal(call('read', { path: 'src/x.ts' }), undefined, 'without the doctor role the built-in tools are not blocked here');

  // The shipped template names every check bound, the sanctioned commands and the unactionable rule.
  const prompt = doctorPrompt({ repository: master.repository, cliPath: master.cliPath }, { items: [], faults: [] });
  assert.ok(prompt.includes(`node ${master.cliPath}`), 'the template names node <cliPath>');
  for (const [bound, minutes] of Object.entries(doctorBounds)) assert.ok(prompt.includes(`${minutes} min`), `the template names the ${bound} bound (${minutes} min)`);
  // GY-1462: the worker bound is the product's no-submission bound, one declaration behind both.
  assert.equal(doctorBounds.workerMinutes * 60_000, workerSubmissionBoundMs, 'the doctor\'s worker bound is the bound the loop and the server enforce');
  assert.ok(prompt.includes('lapsed containment') && prompt.includes('refusal') && prompt.includes('overdue'), 'the template names the non-minute checks: lapsed containment, stale refusal text, overdue items');
  for (const command of doctorSanctionedCommands) assert.ok(prompt.includes(`master ${command}`), `the template names the sanctioned command master ${command}`);
  for (const never of ['never merge', 'dispatch', 'evidence', 'lease']) assert.ok(prompt.includes(never), `the template refuses ${never}`);
  assert.ok(prompt.includes('human-only'), 'the template names the human-only decisions a finding cannot act on');
});

test('unit:doctor-run-recorded — a doctor run records one event per item it found or acted on, one run summary on the cursor and the control plane, and files a fault item only when no open item already covers its class', async () => {
  clearDoctorRuns();
  const work = [item({ stageEnteredAt: at(60_000) }), item({ id: 'id-GY-75', key: 'GY-75', stageEnteredAt: at(0) })];
  const filed: { title: string; priority: number }[] = [];
  const posted: { at: string; findings: unknown[] }[] = [];
  const prompts: string[] = [];
  const report = {
    findings: [
      { subject: 'GY-74', check: 'blocked' as const, detail: 'blocked 14 min on a scope refusal', unactionable: false },
      { subject: 'installation', check: 'overdue' as const, detail: 'every human-only park', unactionable: true },
    ],
    actions: [{ subject: 'GY-75', command: 'graphyard master unblock GY-75 because scope is granted', outcome: 'applied' as const, detail: 'blocker cleared' }],
    filed: [
      { faultClass: 'decision' as const, title: 'Decision faults recur', description: 'evidence', priority: 1, criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:x'] }], plannedFiles: ['src/x.ts'] },
      { faultClass: 'containment' as const, title: 'Lapsed fences pile up', description: 'evidence', priority: 0, criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:y'] }], plannedFiles: ['src/y.ts'] },
    ],
  };
  // 'decision' has an open item standing for it (filed through the same origin), so it is deduplicated.
  work.push(item({ id: 'id-GY-90', key: 'GY-90', stage: 'ready', origin: { faultClass: { class: 'decision', threshold: 1, windowHours: 1, count: 1, detectedAt: observedAt, instances: [] } } }));
  const doctor: DoctorEffects = {
    settings: doctorSettingsSchema.parse({}) as DoctorEffects['settings'], cwd: '/tmp', env: {},
    runner: () => Promise.resolve({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
      name: 'pi', start: (prompt: string, options: { tool: string }) => {
        prompts.push(prompt);
        return { id: 'run', events: [], onEvent: () => () => {}, cancel: () => {},
          result: async () => ({ ok: true as const, tool: options.tool, payload: report, payloads: [report] }) };
      } } as unknown as Runner }),
    file: async input => { filed.push({ title: input.title, priority: input.priority }); return item({ id: 'id-GY-91', key: 'GY-91', title: input.title }); },
    recordRun: async run => { posted[0] = { at: run.at, findings: run.findings }; },
  };
  const first = cycle(work, { doctor });
  await doctorStep(first);
  assert.equal(first.state.doctor.runs.length, 1, 'the run was scheduled at once from an empty cursor');
  await doctorRunsSettled();
  const run = first.state.doctor.runs[0];
  assert.equal(run.state, 'reported');
  assert.ok(prompts[0].indexOf('GY-75') < prompts[0].indexOf('GY-74'), 'the evidence lists open items oldest stage first, not by work number');
  assert.deepEqual([run.findings.length, run.actions.length], [2, 1]);
  assert.deepEqual(posted.length && [posted[0].at, posted[0].findings.length], [run.at, 2], 'the run summary was posted to the control plane');
  // One event per item the run found or acted on, plus one summary event.
  const events = Object.values(first.state.actions).filter(action => action.kind === 'fault');
  assert.deepEqual(events.filter(action => action.work).map(action => action.work).sort(), ['GY-74', 'GY-75'], 'one event per item with a finding or an action');
  assert.ok(events.some(action => action.work === null && /2 finding\(s\), 1 action\(s\)/.test(action.detail)), 'one run summary event names what was stuck, what it did and what it filed');
  // Dedup: the covered class is not filed; the uncovered one is filed through master create's checks.
  assert.deepEqual(filed, [{ title: 'Lapsed fences pile up', priority: 0 }], 'only the fault class with no open item is filed, at P0/P1');
  assert.deepEqual(run.filed.map(entry => entry.work), ['GY-91']);
  assert.ok(events.some(action => /already covered by an open item/.test(action.detail)), 'the deduplicated filing is recorded, not silently dropped');

  // The live post is admitted: the operator-agent identity the loop posts as reaches /api/doctor.
  assert.equal(await operatorAgentRouteGuard.handle({ actor: { id: 'operator', role: 'operator-agent' }, url: new URL('https://graphyard.example/api/doctor') } as any, undefined as any), Next, 'the operator-agent route guard admits the doctor run post');
  // The finding the doctor could not act on raises attention: an escalation master status reports.
  assert.ok(Object.values(first.state.actions).some(action => action.kind === 'escalation' && /could not act on it: every human-only park/.test(action.detail)), 'an unactionable finding is raised as an escalation');

  // The next run is due one interval later, not on the next cycle.
  const second = cycle(work, { doctor, state: first.state });
  await doctorStep(second);
  assert.equal(second.state.doctor.runs.length, 1, 'the doctor does not run again inside its interval');
  clearDoctorRuns();

  // A run the control plane refuses is recorded as failed and posted again, never silently lost.
  let refusals = 1;
  const accepted: string[] = [];
  const flaky: DoctorEffects = { ...doctor, recordRun: async run => { if (refusals-- > 0) throw new Error('Graphyard refused doctor (403): Route is not available to operator agents'); accepted.push(run.at); } };
  const third = cycle(work, { doctor: flaky });
  await doctorStep(third);
  await doctorRunsSettled();
  const refusedRun = third.state.doctor.runs[0];
  assert.deepEqual(third.state.doctor.unposted, [refusedRun.at], 'the refused run is held for another post');
  assert.ok(Object.values(third.state.actions).some(action => action.state === 'failed' && /did not accept the doctor run.*403/.test(action.detail)), 'the refusal is recorded, not swallowed');
  third.state.cycle += 1;
  await doctorStep(cycle(work, { doctor: flaky, state: third.state }));
  assert.deepEqual(accepted, [refusedRun.at], 'the run is posted again on a later cycle');
  assert.deepEqual(third.state.doctor.unposted, []);
  clearDoctorRuns();

  // A runner whose start throws is released, and the fallback runs.
  const released: string[] = [];
  const throwing: DoctorEffects = { ...doctor, runner: async attempt => attempt === 'primary'
    ? { runtime: 'pi', model: 'registry/model', release: async reason => { released.push(reason); }, runner: { name: 'pi', start: () => { throw new Error('account key unreadable'); } } as unknown as Runner }
    : doctor.runner(attempt) };
  const fourth = cycle(work, { doctor: throwing });
  await doctorStep(fourth);
  await doctorRunsSettled();
  assert.deepEqual(released, ['the primary doctor run ended'], 'the primary runner is released although its start threw');
  assert.equal(fourth.state.doctor.runs[0].state, 'reported', 'the fallback ran and reported');
  assert.deepEqual(fourth.state.doctor.runs[0].runs.map(entry => entry.result), ['spawn', 'reported']);
  clearDoctorRuns();

  // Shutdown that begins while the runner is still being selected starts no doctor: `active` is
  // not yet the cancellable one, so the chosen session is rechecked against `stopping`, released
  // without starting, and the attempt is recorded as cancelled — never leaked past the shutdown.
  let releaseSelection!: () => void;
  const selection = new Promise<void>(resolve => { releaseSelection = resolve; });
  const started: string[] = [];
  const releasedEarly: string[] = [];
  const slow: DoctorEffects = { ...doctor, runner: async attempt => {
    await selection;
    return { runtime: 'pi', model: 'registry/model', release: async reason => { releasedEarly.push(reason); },
      runner: { name: 'pi', start: () => { started.push(attempt); throw new Error('a stopping loop must not start a doctor'); } } as unknown as Runner };
  } };
  const fifth = cycle(work, { doctor: slow });
  await doctorStep(fifth);
  const shutdown = stopDoctorRuns('shutdown during selection');
  releaseSelection();
  await shutdown;
  assert.deepEqual(started, [], 'a stopping loop starts no doctor run');
  assert.deepEqual(releasedEarly, ['the primary doctor run ended'], 'the selected session is released without starting');
  assert.deepEqual(fifth.state.doctor.runs[0].runs.map(entry => entry.result), ['cancelled'], 'the interrupted attempt is recorded as cancelled');
  assert.equal(fifth.state.doctor.runs[0].state, 'failed', 'with no report, the run is recorded failed, not left running');
  clearDoctorRuns();

  // A report that cannot be applied — here, the cursor refusing to persist while the run's events
  // are recorded — reaches the chain after the settled run's own catch is gone, so the terminal
  // handler records the run as failed and posts it: it never stands `running` with `live` cleared,
  // suppressing later cycles past the lost-run bound, and no rejection goes unhandled.
  const failingReport = { findings: [{ subject: 'GY-74', check: 'blocked' as const, detail: 'blocked 14 min on a scope refusal', unactionable: false }], actions: [], filed: [] };
  const unappliable: DoctorEffects = { ...doctor, runner: () => Promise.resolve({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
    name: 'pi', start: (_prompt: string, options: { tool: string }) => ({
      id: 'run', events: [], onEvent: () => () => {}, cancel: () => {},
      result: async () => ({ ok: true as const, tool: options.tool, payload: failingReport, payloads: [failingReport] }),
    }) } as unknown as Runner }) };
  let persistFailures = 1;
  const applied: string[] = [];
  const unapplied = cycle(work, { doctor: unappliable, effects: { persist: async () => { if (persistFailures-- > 0) throw new Error('the cursor is momentarily unwritable'); applied.push('persisted'); } } });
  await doctorStep(unapplied);
  await doctorRunsSettled();
  const unappliedRun = unapplied.state.doctor.runs[0];
  assert.equal(unappliedRun.state, 'failed', 'a run whose apply threw is recorded failed, not left running');
  assert.match(unappliedRun.detail, /Applying the report failed/, 'the run names why its report was not applied');
  assert.ok(Object.values(unapplied.state.actions).some(action => action.state === 'failed' && /Applying the report failed/.test(action.detail)), 'the apply failure is recorded as an event');
  assert.deepEqual(applied, ['persisted'], 'the record of the failed run persisted after the momentary refusal');
  clearDoctorRuns();

  // When the recovery record cannot persist either, the failed run stays queued for posting: it is
  // never reaped as lost, so without the marker it and its per-item history would be dropped.
  let stuckFailures = 2;
  const unrecorded = cycle(work, { doctor: unappliable, effects: { persist: async () => { if (stuckFailures-- > 0) throw new Error('the cursor is unwritable'); } } });
  await doctorStep(unrecorded);
  await doctorRunsSettled();
  const unrecordedRun = unrecorded.state.doctor.runs[0];
  assert.equal(unrecordedRun.state, 'failed', 'the run is still recorded failed');
  assert.ok(unrecorded.state.doctor.unposted.includes(unrecordedRun.at), 'a run whose recovery record failed stays queued for a later cycle to post');
  clearDoctorRuns();

  // A filing the control plane did not accept is kept on the cursor and filed again on a later
  // cycle under the same stable key — a briefly unreachable control plane loses no P0/P1 fault
  // item — and a filing whose fault class an open item comes to cover meanwhile is dropped.
  const filedKeys: string[] = [];
  let refuseFilings = true;
  const filing: DoctorEffects = { ...doctor, file: async (input, key) => {
    if (refuseFilings) throw new Error('Graphyard refused work (503): the control plane is unavailable');
    filedKeys.push(key);
    return item({ id: 'id-GY-92', key: 'GY-92', title: input.title });
  } };
  const filingReport = { findings: [], actions: [], filed: [
    { faultClass: 'merge' as const, title: 'Merge faults recur', description: 'evidence', priority: 1, criteria: [{ id: 'AC-1', text: 'Fixed', proofs: ['unit:m'] }], plannedFiles: ['src/m.ts'] }] };
  const filingDoctor: DoctorEffects = { ...filing, runner: () => Promise.resolve({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
    name: 'pi', start: (_prompt: string, options: { tool: string }) => ({
      id: 'run', events: [], onEvent: () => () => {}, cancel: () => {},
      result: async () => ({ ok: true as const, tool: options.tool, payload: filingReport, payloads: [filingReport] }),
    }) } as unknown as Runner }) };
  const sixth = cycle(work, { doctor: filingDoctor });
  await doctorStep(sixth);
  await doctorRunsSettled();
  assert.equal(sixth.state.doctor.pendingFiles.length, 1, 'the refused filing is kept on the cursor for a later cycle');
  const filingKey = sixth.state.doctor.pendingFiles[0].key;
  assert.ok(/Could not file "Merge faults recur"/.test(sixth.state.actions[filingKey]?.detail ?? ''), 'the refusal is recorded under the filing\'s own stable key');
  sixth.state.cycle += 1;
  refuseFilings = false;
  await doctorStep(cycle(work, { doctor: filingDoctor, state: sixth.state }));
  assert.deepEqual(filedKeys, [filingKey], 'the filing is retried on the later cycle under the same stable key');
  assert.equal(sixth.state.doctor.pendingFiles.length, 0, 'the filing leaves the pending list once accepted');
  // A later run refuses again; by its retry an open item covers the class, so the filing is
  // dropped as covered instead of standing beside the item that already covers it.
  refuseFilings = true;
  const seventh = cycle(work, { doctor: filingDoctor, state: sixth.state, clock: Date.parse(at(11 * 60_000)) });
  await doctorStep(seventh);
  await doctorRunsSettled();
  assert.equal(sixth.state.doctor.pendingFiles.length, 1, 'the run that fired at its interval filed again and was refused again');
  const refilingKey = sixth.state.doctor.pendingFiles[0].key;
  assert.notEqual(refilingKey, filingKey, 'each run files under its own key');
  work.push(item({ id: 'id-GY-95', key: 'GY-95', stage: 'ready', origin: { faultClass: { class: 'merge', threshold: 1, windowHours: 1, count: 1, detectedAt: observedAt, instances: [] } } }));
  sixth.state.cycle += 1;
  await doctorStep(cycle(work, { doctor: filingDoctor, state: sixth.state }));
  assert.equal(sixth.state.doctor.pendingFiles.length, 0, 'the pending filing is dropped once an open item covers its class');
  assert.ok(/now covered by an open item/.test(sixth.state.actions[refilingKey]?.detail ?? ''), 'the drop is recorded, not silent');
  clearDoctorRuns();

  // The route itself aggregates a run's findings and actions into one event per affected item: an
  // action-only item reaches its item history, repeated findings are one event, and a status-level
  // subject files nothing.
  const inserts: { workId: string | null; kind: string; payload: any }[] = [];
  const rows = [{ id: 'work-74', key: 'GY-74' }, { id: 'work-75', key: 'GY-75' }];
  const db: { query(sql: string, params?: any[]): Promise<any> } = { query: async (sql, params = []) => {
    if (sql.includes('VALUES(NULL')) { inserts.push({ workId: null, kind: params[1], payload: JSON.parse(params[2]) }); return { rowCount: 1 }; }
    if (sql.includes('INSERT INTO events')) { inserts.push({ workId: params[0], kind: params[2], payload: JSON.parse(params[3]) }); return { rowCount: 1 }; }
    if (sql.includes('FROM work_index')) return { rows };
    return { rows: [] };
  } };
  const postedRun: DoctorRunRecord = { at: at(60_000), state: 'reported', runs: [], detail: 'stuck and fixed',
    findings: [
      { subject: 'GY-74', check: 'blocked', detail: 'first', unactionable: false },
      { subject: 'GY-74', check: 'overdue', detail: 'second', unactionable: false },
      { subject: 'installation', check: 'launch', detail: 'nobody launched', unactionable: true },
    ],
    actions: [{ subject: 'GY-75', command: 'graphyard master unblock GY-75 REASON', outcome: 'applied', detail: 'blocker cleared' }],
    filed: [] };
  const doctorRoute = statusRoutes.routes.find(route => route.method === 'POST' && route.path === '/api/doctor')!;
  const post = (actor: any) => doctorRoute.handle({ actor, services: { engine: { store: { transaction: async (run: (session: typeof db) => Promise<void>) => run(db) } } },
    body: async () => Buffer.from(JSON.stringify(postedRun)) } as any, []);
  // The live post is admitted: the operator-agent identity the loop posts as reaches /api/doctor —
  // an operator identity holding the master's filing capability, whose scope covers every item the
  // run names. A narrow agent poisons no audit history: without the capability, or with an item
  // outside its scope, the run is refused whole and nothing is inserted.
  const outcome = await post({ id: 'operator-agent-1', role: 'operator-agent', capabilities: ['intent:create'], scope: { repositories: ['owner/project'], workItems: ['*'] } });
  assert.deepEqual(outcome, { recorded: true, runs: 1 });
  assert.equal(await post({ id: 'approver-1', role: 'operator-agent', capabilities: ['decision:approve'], scope: { repositories: ['owner/project'], workItems: ['*'] } }).then(() => true, (error: any) => error.message), 'Coordinator permission or the intent:create capability is required', 'an operator agent without the filing capability is refused');
  assert.equal(await post({ id: 'narrow-1', role: 'operator-agent', capabilities: ['intent:create'], scope: { repositories: ['owner/project'], workItems: ['id-GY-90'] } }).then(() => true, (error: any) => error.message), 'Work item is outside this operator-agent scope: GY-74, GY-75', 'an item outside the poster\'s scope refuses the whole run');
  assert.equal(inserts.length, 3, 'the refused runs inserted nothing: only the accepted run\'s summary and its two per-item events');
  assert.equal(inserts.filter(entry => entry.kind === doctorRunEvent).length, 1, 'one run summary event');
  const perItem = inserts.filter(entry => entry.kind === doctorFindingEvent);
  assert.deepEqual(perItem.map(entry => entry.workId), ['work-74', 'work-75'], 'one event per affected item');
  assert.deepEqual(perItem[0].payload.findings.map((finding: any) => finding.detail), ['first', 'second'], 'both findings for one item are one event');
  assert.deepEqual(perItem[0].payload.actions, [], 'an item with findings only carries no actions');
  assert.deepEqual(perItem[1].payload.actions.map((action: any) => action.command), ['graphyard master unblock GY-75 REASON'], 'an action-only item reaches its item history');
  assert.deepEqual(perItem[1].payload.findings, []);
  assert.ok(!perItem.some(entry => entry.payload.subject === 'installation'), 'a status-level subject files no per-item event');
});

test('unit:loop-applies-routine-remedies — the loop settles a lapsed containment whose attempt submitted, clears a blocker whose named scope plannedFiles already covers, and relaunches an approver for a decision unanswered past ten minutes', async () => {
  // Remedy 1: a lapsed fence on a submitted attempt is verified on this host with the settle-containment
  // probe and settled through autosettle with that verification, which the control plane re-checks.
  const settled: string[] = [], probed: string[] = [];
  const quarantine = (hash: string) => ({ owner: 'worker-a', epoch: 1, at: at(-3_600_000), settlementHash: hash.repeat(64), leaseExpiresAt: at(-600_000) });
  const workspaces = [{ epoch: 1, host: 'machine-a', path: '/work/GY-74-1', branch: 'graphyard/gy-74-1' }] as Work['workspaces'];
  const submitted = item({ submission: { epoch: 1, pr: 12 } as Work['submission'], workspaces, containmentQuarantine: quarantine('a') });
  const unsubmitted = item({ id: 'id-GY-76', key: 'GY-76', workspaces, containmentQuarantine: quarantine('b') });
  const stillHeld = item({ id: 'id-GY-80', key: 'GY-80', submission: { epoch: 1, pr: 13 } as Work['submission'], workspaces, containmentQuarantine: quarantine('c') });
  const verification = (target: Work, processes: { pid: number; evidence: 'command' | 'workspace' }[] = []) => containmentVerificationSchema.parse({ method: 'linux-proc-systemd', host: 'machine-a', uid: 1000, platform: 'linux',
    workspacePath: target.workspaces[0].path, observedAt, clockOffset: { min: 0, max: 0 }, processes, scopes: [], inaccessible: 0, unverifiable: [] });
  const remedied = cycle([submitted, unsubmitted, stillHeld], { effects: {
    containment: async (targets: Work[]) => Object.fromEntries(targets.map(target => {
      probed.push(target.key);
      const found = verification(target, target.key === 'GY-80' ? [{ pid: 4242, evidence: 'command' }] : []);
      const refusals = containmentSettlementRefusals(target, found, { now: Date.parse(observedAt) });
      return [target.id, { key: target.key, id: target.id, epoch: 1, owner: 'worker-a', at: at(-3_600_000), host: 'machine-a', workspacePath: target.workspaces[0].path, scope: null,
        settleable: !refusals.length, refusals, attestation: 'attest', verification: found }];
    })),
    settleContainment: async (target, assessment) => {
      // Exactly what the control plane's autosettle re-checks: a full verification with no refusal.
      assert.ok(assessment.verification, 'the settlement carries the probe verification');
      assert.deepEqual(containmentSettlementRefusals(target, containmentVerificationSchema.parse(assessment.verification), { now: Date.parse(observedAt) }), [], 'the control plane would accept this verification');
      settled.push(target.key);
    },
  } });
  await settleSubmittedContainment(remedied);
  assert.deepEqual(probed.sort(), ['GY-74', 'GY-80'], 'only fences whose attempt submitted are probed by the remedy');
  assert.deepEqual(settled, ['GY-74'], 'the submitted fence verified gone is settled; one whose supervisor is still present is not');
  assert.ok(Object.values(remedied.state.actions).some(action => action.kind === 'settle' && action.state === 'done' && action.work === 'GY-74'));
  assert.ok(Object.values(remedied.state.actions).some(action => action.kind === 'settle' && action.state === 'failed' && action.work === 'GY-80' && /still present/.test(action.detail)), 'a fence still held is recorded with the probe refusal');
  // Settled once: the next cycle does not settle it again.
  await settleSubmittedContainment(remedied);
  assert.deepEqual(settled, ['GY-74']);

  // Remedy 2: a scope-refusal blocker whose paths a widening already planned is cleared by the loop
  // itself as the operator-agent identity, bound to the revision it read — no decision, no approver.
  const unblockedKeys: { key: string; revision: number }[] = [];
  // Coverage is judged from the structured scope record, and any file the prose names besides —
  // a root-level one included — must be planned too; an item with no record keeps its blocker.
  const refusal = (paths: string[]) => ({ state: 'refused' as const, reason: 'outside', at: at(-60_000), decidedBy: 'graphyard', waitedMs: 0, paths, requestedBy: 'worker-a', requestedAt: at(-120_000), epoch: 1 });
  const covered = item({ id: 'id-GY-77', key: 'GY-77', blocker: 'Scope request refused: GY-77 needs src/item.ts/extra and tests/extra outside plannedFiles', plannedFiles: ['src/item.ts', 'src/item.ts/extra', 'tests/extra'], scopeDecision: refusal(['src/item.ts/extra', 'tests/extra']) });
  const stillUnplanned = item({ id: 'id-GY-78', key: 'GY-78', blocker: 'Scope request refused: GY-78 needs src/other.ts outside plannedFiles', plannedFiles: [], scopeDecision: refusal(['src/other.ts']) });
  const rootUnplanned = item({ id: 'id-GY-81', key: 'GY-81', blocker: 'Scope request refused: GY-81 needs src/a.ts and package.json outside plannedFiles', plannedFiles: ['src/a.ts'], scopeDecision: refusal(['src/a.ts', 'package.json']) });
  const proseRootUnplanned = item({ id: 'id-GY-82', key: 'GY-82', blocker: 'Scope request refused: GY-82 needs src/a.ts and AGENTS.md outside plannedFiles', plannedFiles: ['src/a.ts'], scopeDecision: refusal(['src/a.ts']) });
  const unrecorded = item({ id: 'id-GY-83', key: 'GY-83', blocker: 'Scope request refused: GY-83 needs src/a.ts outside plannedFiles', plannedFiles: ['src/a.ts'] });
  assert.deepEqual(coveredScopePaths(covered), ['src/item.ts/extra', 'tests/extra']);
  assert.equal(coveredScopePaths(rootUnplanned), null, 'a root-level path the record names and plannedFiles lacks is not covered');
  assert.equal(coveredScopePaths(proseRootUnplanned), null, 'a root-level file the refusal names besides the record is not covered');
  assert.equal(coveredScopePaths(unrecorded), null, 'with no structured scope record the blocker is left alone');
  const unblocked = cycle([covered, stillUnplanned, rootUnplanned, proseRootUnplanned, unrecorded], { effects: {
    unblock: async target => { unblockedKeys.push({ key: target.key, revision: target.revision }); return { ...target, blocker: null }; },
    decide: async () => { throw new Error('the remedy applies the unblock itself; it never requests a decision'); },
  } });
  await clearCoveredBlockers(unblocked);
  assert.deepEqual(unblockedKeys, [{ key: 'GY-77', revision: 3 }], 'only the blocker whose every named path is planned is cleared, at the revision read');
  assert.ok(Object.values(unblocked.state.actions).some(action => action.work === 'GY-77' && action.state === 'done' && /Cleared GY-77's blocker/.test(action.detail)));
  await clearCoveredBlockers(unblocked);
  assert.equal(unblockedKeys.length, 1, 'cleared once per revision');

  // Remedy 3: a requested decision unanswered past ten minutes with no live approver gets one.
  const launched: string[] = [];
  const asked = at(-unansweredDecisionMs - 60_000), fresh = at(-60_000);
  const waiting = item({ id: 'id-GY-79', key: 'GY-79', stage: 'review', candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 9, branch: 'x', author: 'w' } });
  // The remedy first reads an item's history `decisionCheckMs` after it first sees the item.
  const seen = (target: Cycle) => { target.state.doctor.decisionsCheckedAt[waiting.id] = new Date(target.clock - decisionCheckMs).toISOString(); return target; };
  const approverCycle = seen(cycle([waiting], {
    agents: [],
    effects: {
      decisions: async () => ({ decisions: [
        { id: 'd-old', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked },
        { id: 'd-fresh', action: 'merge', state: 'requested', input: null, approvedBy: null, requestedAt: fresh },
      ] }),
      approver: async (_target, decision) => { launched.push(decision); return { agentName: 'approver-1', pane: null }; },
    },
  }));
  await relaunchUnansweredApprovers(approverCycle);
  assert.deepEqual(launched, ['d-old'], 'the decision unanswered past ten minutes is relaunched; the fresh one is not');

  // A live approver session for the same decision is adopted, not doubled.
  const adopted = seen(cycle([waiting], {
    agents: [liveAgent(approverSessionName(waiting, 'd-old'))],
    effects: {
      decisions: async () => ({ decisions: [{ id: 'd-old', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked }] }),
      approver: async (_target, decision) => { launched.push(`again-${decision}`); return { agentName: 'approver-2', pane: null }; },
    },
  }));
  await relaunchUnansweredApprovers(adopted);
  assert.deepEqual(launched, ['d-old'], 'a decision whose approver session is still live is left alone');

  // In the loop's own cycles the launch goes to the launcher beside the cycle (GY-616), never awaited in it.
  const handed: string[] = [];
  const detachedCycle = seen(cycle([waiting], {
    agents: [], detached: true,
    launch: (_kind, _item, key) => { handed.push(key); return true; },
    effects: {
      decisions: async () => ({ decisions: [{ id: 'd-slow', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked }] }),
      approver: async (_target, decision) => { launched.push(decision); return { agentName: 'approver-s', pane: null }; },
    },
  }));
  await relaunchUnansweredApprovers(detachedCycle);
  assert.deepEqual(handed, ['launch:approver:d-slow'], 'the relaunch is handed to the shared launcher');
  assert.deepEqual(launched, ['d-old'], 'and not run inside the cycle');

  // A decision the loop's approval supervision watches is relaunched there (GY-551), never here too.
  const watchedCycle = seen(cycle([waiting], {
    agents: [],
    effects: {
      decisions: async () => ({ decisions: [{ id: 'd-watched', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked }] }),
      approver: async (_target, decision) => { launched.push(decision); return { agentName: 'approver-w', pane: null }; },
    },
  }));
  watchedCycle.state.approvals['hand:d-watched'] = { decision: 'd-watched' } as never;
  await relaunchUnansweredApprovers(watchedCycle);
  assert.deepEqual(launched, ['d-old'], 'a watched decision is left to its approval supervision');

  // A replacement that also leaves without judging is relaunched once the decision has stood
  // another ten minutes, even with no approval watch for it, within the launch bound.
  const state = approverCycle.state;
  const later = (offset: number) => cycle([waiting], { state, clock: Date.parse(observedAt) + offset, agents: [], effects: {
    decisions: async () => ({ decisions: [{ id: 'd-old', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked }] }),
    approver: async (_target, decision) => { launched.push(decision); return { agentName: 'approver-3', pane: null }; },
  } });
  await relaunchUnansweredApprovers(later(3 * 60_000));
  assert.deepEqual(launched, ['d-old'], 'not relaunched again inside ten minutes of the last launch');
  await relaunchUnansweredApprovers(later(unansweredDecisionMs + 60_000));
  assert.deepEqual(launched, ['d-old', 'd-old'], 'relaunched when the replacement also left the decision unanswered');
  // The decision history is read at most once per item per decisionCheckMs, not every cycle.
  let reads = 0;
  const throttled = cycle([waiting], { state, clock: Date.parse(observedAt) + unansweredDecisionMs + 90_000, effects: { decisions: async () => { reads++; return { decisions: [] }; }, approver: async () => ({ agentName: 'x', pane: null }) } });
  await relaunchUnansweredApprovers(throttled);
  assert.equal(reads, 0, 'the item read 30 s ago is not read again');
  assert.ok(decisionCheckMs <= unansweredDecisionMs / 2, 'the throttle is well inside the ten-minute bound');
  // An item seen for the first time is not read until `decisionCheckMs` later (GY-1142's bound on
  // the cycle's history reads), and a history the decisions step already holds is used, not read.
  let unseenReads = 0;
  const unseen = cycle([waiting], { agents: [], effects: { decisions: async () => { unseenReads++; return { decisions: [] }; }, approver: async (_target, decision) => { launched.push(decision); return { agentName: 'approver-u', pane: null }; } } });
  await relaunchUnansweredApprovers(unseen);
  assert.equal(unseenReads, 0, 'the first sighting defers the read');
  unseen.heldDecisions.histories.set(waiting.id, [{ id: 'd-held', action: 'unblock', state: 'requested', input: null, approvedBy: null, requestedAt: asked }] as never);
  await relaunchUnansweredApprovers(unseen);
  assert.equal(unseenReads, 0, 'a held history is not read again');
  assert.deepEqual(launched.slice(-1), ['d-held'], 'and its unanswered decision is relaunched');
  // However many items fall due at once, a cycle makes at most `decisionReadConcurrency` uncached reads.
  let cappedReads = 0;
  const many = Array.from({ length: decisionReadConcurrency + 4 }, (_, index) => item({ id: `id-GY-${200 + index}`, key: `GY-${200 + index}` }));
  const capped = cycle(many, { agents: [], effects: { decisions: async () => { cappedReads++; return { decisions: [] }; }, approver: async () => ({ agentName: 'x', pane: null }) } });
  for (const entry of many) capped.state.doctor.decisionsCheckedAt[entry.id] = new Date(capped.clock - decisionCheckMs).toISOString();
  await relaunchUnansweredApprovers(capped);
  assert.equal(cappedReads, decisionReadConcurrency, 'the cycle reads only up to its bound; the rest wait for the next cycle');
});

// GY-1295: the six instances of "Recurring loop faults: 6 in 24 hours", replayed as the loop recorded them.
test('fault-class-loop — a doctor command its allowlist refused and a decision waiting on its approver are not loop faults', async () => {
  // Instances 1–5: one doctor run whose read-only attempts the allowlist refused, each adapted around.
  const refused = [
    ['node /home/vish/code/graphyard/bin/graphyard.mjs --help | head -60', 'Allowlist refusal (pipe outside the doctor\'s allowlist); not retried — CLI surface was read from src/cli/master.ts instead'],
    ['node /home/vish/code/graphyard/bin/graphyard.mjs master --help | head -80', 'Allowlist refusal (pipe); not retried'],
    ['node /home/vish/code/graphyard/bin/graphyard.mjs', 'Allowlist refusal (bare invocation outside the allowlist); not retried'],
    ['rg -n "command === |case \'|subcommand" /home/vish/code/graphyard/src/cli.ts /home/vish/code/graphyard/src/cli/master.ts /home/vish/code/graphyard/src/cli/master/ --glob *.ts -l', 'Allowlist refusal (glob expansion cannot be checked); not retried — directory listing used instead'],
    ['sed -n 30,110p /home/vish/code/graphyard/src/cli/master.ts', 'Allowlist refusal (sed is a wrapper outside the allowlist); not retried — rg -n -A/-B context used instead'],
  ] as const;
  const actions = refused.map(([command, detail]) => ({ subject: 'installation', command, outcome: 'refused' as const, detail }));
  const replay = cycle([item()]);
  const run = doctorRunRecordSchema.parse({ at: observedAt, state: 'running', actions });
  const effects = { file: async () => { throw new Error('nothing is filed'); }, recordRun: async () => {} } as unknown as DoctorEffects;
  await applyDoctorRun(replay, effects, run, { findings: [], actions, filed: [] }, () => replay.clock);
  const recorded = Object.values(replay.state.actions).filter(action => action.detail.startsWith('Was refused'));
  assert.equal(recorded.length, 5, 'every refusal is still recorded, so master status shows what the doctor could not run');
  assert.deepEqual(recorded.map(action => action.state), Array(5).fill('done'), 'a refusal the doctor adapted around is not a failed loop action');
  assert.deepEqual(replay.state.faults.instances.filter(entry => faultClassOf(entry.kind) === 'loop'), [], 'and opens no loop fault instance');

  // Instance 6: GY-949's rework decision waiting on its approver past the silence bound.
  const liveness = { state: 'running', detail: 'cycling', restart: 'restart' } as unknown as LoopLiveness;
  const silent = (entry: Pick<SilenceEntry, 'kind' | 'work' | 'detail'>) => {
    const longest = { key: `${entry.kind}:${entry.work}`, since: observedAt, idleMs: 34 * 60_000, ...entry };
    return loopAttention({ liveness, silence: { actionable: 7, longestIdleMs: longest.idleMs, longest, budgetMs: silenceBudgetMs, breached: true, lastActionAt: observedAt, subjects: [longest] } })[0];
  };
  const approver = silent({ kind: 'decision', work: 'GY-949', detail: 'GY-949\'s rework decision 8b62b40b-0f3d-4cd6-b3c0-3920340a512b is requested and waiting for approver session graphyard-approver-gy-949-8b62b4 to judge it' });
  assert.match(approver.text, /^Nothing has acted on GY-949's rework decision .+ past the 20-minute bound, while 7 subject\(s\) were actionable/, 'the wait is still raised');
  assert.deepEqual([approver.kind, approver.faultClass], ['decision-unanswered', 'decision'], 'as the decision fault it is, not the loop failing to cycle');
  const exhausted = silent({ kind: 'decision', work: 'GY-949', detail: 'GY-949\'s rework decision 8b62b40b is unjudged after 3 approver session(s)' });
  assert.equal(exhausted.faultClass, 'decision', 'an approver wait past its launches is a decision fault too');
  // What the loop itself owes stays loop silence.
  assert.equal(silent({ kind: 'decision', work: 'GY-949', detail: 'GY-949 needs a rework decision requested and approved' }).faultClass, 'loop', 'a decision nobody requested is the loop\'s to request');
  assert.equal(silent({ kind: 'dispatch', work: 'GY-949', detail: 'GY-949 is claimable and waiting for a worker' }).kind, 'loop-silence');
});

// GY-1318 instance 2: doctor:2026-10-05T15:21:52.963Z — "no report: zai/glm-5.3-flash exit; zai/glm-5.3
// cancelled": the primary's model died and the fallback was cancelled by the loop's own shutdown.
test('unit:doctor-no-report-not-a-loop-fault — a doctor run that returns no report stays failed, posted and retried, and opens no loop fault; one whose report cannot be applied still opens a fault', async () => {
  clearDoctorRuns();
  const loopFaults = (state: DaemonState) => state.faults.instances.filter(entry => faultClassOf(entry.kind) === 'loop');
  const posted: string[] = [];
  let postRefusals = 1;
  const settings = doctorSettingsSchema.parse({}) as DoctorEffects['settings'];
  const recordRun: DoctorEffects['recordRun'] = async run => { if (postRefusals-- > 0) throw new Error('Graphyard refused doctor-runs (502)'); posted.push(run.at); };
  const dying: DoctorEffects = { settings, cwd: '/tmp', env: {}, file: async () => { throw new Error('nothing is filed'); }, recordRun,
    runner: async attempt => ({ runtime: 'pi', model: attempt === 'primary' ? 'zai/glm-5.3-flash' : 'zai/glm-5.3', release: async () => {}, runner: {
      name: 'pi', start: () => {
        let cancelled!: () => void;
        const held = new Promise<void>(resolve => { cancelled = resolve; });
        return { id: attempt, events: [], onEvent: () => () => {}, cancel: () => cancelled(),
          result: async () => attempt === 'primary' ? { ok: false as const, failure: { reason: 'exit' as const, detail: 'pi exited 1' }, payloads: [] }
            : (await held, { ok: false as const, failure: { reason: 'cancelled' as const, detail: 'the loop is stopping' }, payloads: [] }) };
      } } as unknown as Runner }) };
  const replay = cycle([item()], { doctor: dying });
  await doctorStep(replay);
  await new Promise(resolve => setTimeout(resolve, 10));
  await stopDoctorRuns('the loop is upgrading itself');
  const run = replay.state.doctor.runs[0];
  assert.equal(run.state, 'failed', 'the run record stays failed');
  assert.equal(run.detail, 'no report: zai/glm-5.3-flash exit; zai/glm-5.3 cancelled', 'as the instance recorded it');
  assert.ok(Object.values(replay.state.actions).some(action => action.state === 'failed' && action.detail === `The doctor run returned no report: ${run.detail}`), 'the failure is still recorded');
  assert.deepEqual(replay.state.doctor.unposted, [run.at], 'a refused post is held for another');
  replay.state.cycle += 1;
  await doctorStep(cycle([item()], { doctor: dying, state: replay.state }));
  assert.deepEqual(posted, [run.at], 'and posted on a later cycle');
  // The refused post is the control plane's own recorded failure (doctor:post:…), kept as it was.
  assert.deepEqual(loopFaults(replay.state).filter(entry => entry.subject === `doctor:${run.at}`), [], 'but the loop did not fail to cycle: the run opens no loop fault instance');
  clearDoctorRuns();

  // A run whose models both die, with no shutdown at all, is the same handled outcome.
  const exiting: DoctorEffects = { ...dying, recordRun: async () => {}, runner: async attempt => ({ runtime: 'pi', model: attempt, release: async () => {}, runner: {
    name: 'pi', start: () => ({ id: attempt, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: false as const, failure: { reason: 'exit' as const, detail: 'died' }, payloads: [] }) }) } as unknown as Runner }) };
  const died = cycle([item()], { doctor: exiting });
  await doctorStep(died);
  await doctorRunsSettled();
  assert.equal(died.state.doctor.runs[0].state, 'failed');
  assert.deepEqual(loopFaults(died.state), []);
  clearDoctorRuns();

  // The bound is not weakened: a report that cannot be applied is still a fault — unclassified since
  // GY-1338, for a failed doctor action names the step that did not finish, not the loop's cause.
  const report = { findings: [{ subject: 'GY-74', check: 'blocked' as const, detail: 'blocked', unactionable: false }], actions: [], filed: [] };
  const unappliable: DoctorEffects = { ...exiting, runner: async () => ({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
    name: 'pi', start: (_prompt: string, options: { tool: string }) => ({ id: 'run', events: [], onEvent: () => () => {}, cancel: () => {},
      result: async () => ({ ok: true as const, tool: options.tool, payload: report, payloads: [report] }) }) } as unknown as Runner }) };
  let persistFailures = 1;
  const unapplied = cycle([item()], { doctor: unappliable, effects: { persist: async () => { if (persistFailures-- > 0) throw new Error('the cursor is momentarily unwritable'); } } });
  await doctorStep(unapplied);
  await doctorRunsSettled();
  assert.match(unapplied.state.doctor.runs[0].detail, /Applying the report failed/);
  assert.deepEqual(unapplied.state.faults.instances.map(entry => [entry.kind, entry.faultClass]), [['action:fault', 'unclassified']], 'an apply failure still opens its fault');
  clearDoctorRuns();
});

// ---- GY-1336: manual:fault-class-loop, the doctor's two instances -------------------------------
//
// Instance 1, doctor:2026-10-05T23:32:04.689Z ("no report: zai/glm-5.3-flash exit; zai/glm-5.3
// cancelled"), is GY-1318's no-report shape: the base already records it with no fault kind (the
// test above). It recurred because the loop process that raised it still ran code from before
// GY-1318's merge (21:41Z) until its upgrade at 23:33Z cancelled the fallback; it is replayed below
// under its own timestamp. Instance 2, doctor:3379f2b6c361998f7abec8ee:file:merge, is a filing the
// create checks refused for a model-authored proof ID, recorded as a failed loop action although the
// filing was by design kept for a retry — and a retry of the same content would be refused again.
const gy1336Doctor = { noReport: '2026-10-05T23:32:04.689Z', filing: 'doctor:3379f2b6c361998f7abec8ee:file:merge' };
const loopFaultsOf = (state: DaemonState) => state.faults.instances.filter(entry => faultClassOf(entry.kind) === 'loop');
/** A doctor whose one report asks `filed` filed, and whose control plane files through `file`. */
function filingDoctor(filed: unknown[], file: DoctorEffects['file']): DoctorEffects {
  const report = { findings: [], actions: [], filed };
  return { settings: doctorSettingsSchema.parse({}) as DoctorEffects['settings'], cwd: '/checkout', env: {}, file, recordRun: async () => {},
    runner: async () => ({ runtime: 'pi', model: 'zai/glm-5.3', release: async () => {}, runner: {
      name: 'pi', start: (_prompt: string, options: { tool: string }) => ({ id: 'run', events: [], onEvent: () => () => {}, cancel: () => {},
        result: async () => ({ ok: true as const, tool: options.tool, payload: report, payloads: [report] }) }) } as unknown as Runner }) };
}
/** The filing instance 2 asked for: its title, with a proof ID written as prose. */
const mainGuardFiling = (proofs: string[]) => ({ faultClass: 'merge' as const, priority: 1, plannedFiles: ['src/daemon/main-guard.ts'],
  title: 'Main-guard revert PRs are refused by GitHub\'s approval rule and the guard abandons after one attempt, leaving a required check failing on main 38-90 minutes until an unrelated merge recovers it',
  description: 'evidence', criteria: [{ id: 'AC-1', text: 'A refused revert is retried until main is green', proofs }] });

test(`manual:fault-class-loop — GY-1336 doctor:${gy1336Doctor.noReport}: a doctor run whose fallback the loop's own upgrade cancelled opens no loop fault`, async () => {
  clearDoctorRuns();
  const doctor: DoctorEffects = { ...filingDoctor([], async () => { throw new Error('nothing is filed'); }),
    runner: async attempt => ({ runtime: 'pi', model: attempt === 'primary' ? 'zai/glm-5.3-flash' : 'zai/glm-5.3', release: async () => {}, runner: {
      name: 'pi', start: () => {
        let cancelled!: () => void;
        const held = new Promise<void>(resolve => { cancelled = resolve; });
        return { id: attempt, events: [], onEvent: () => () => {}, cancel: () => cancelled(),
          result: async () => attempt === 'primary' ? { ok: false as const, failure: { reason: 'exit' as const, detail: 'pi exited 1' }, payloads: [] }
            : (await held, { ok: false as const, failure: { reason: 'cancelled' as const, detail: 'the loop is upgrading itself' }, payloads: [] }) };
      } } as unknown as Runner }) };
  const replay = cycle([item()], { doctor, clock: Date.parse(gy1336Doctor.noReport) });
  await doctorStep(replay);
  await new Promise(resolve => setTimeout(resolve, 10));
  await stopDoctorRuns('the loop is upgrading itself');
  assert.equal(replay.state.doctor.runs[0].detail, 'no report: zai/glm-5.3-flash exit; zai/glm-5.3 cancelled', 'the instance\'s own detail');
  assert.deepEqual(loopFaultsOf(replay.state), [], 'no loop fault instance');
  clearDoctorRuns();
});

test(`manual:fault-class-loop — GY-1336 ${gy1336Doctor.filing}: a doctor filing whose proof IDs are prose is normalised and filed, with no loop fault`, async () => {
  clearDoctorRuns();
  const filed: { key: string; criteria: { id: string; proofs: string[] }[] }[] = [];
  const doctor = filingDoctor([mainGuardFiling(['integration: main guard retries a refused revert', 'Unit:guard/retry', 'the revert merges', 'manual:fault-class-merge'])],
    async (input, key) => { filed.push({ key, criteria: input.criteria }); return item({ id: 'id-GY-1332', key: 'GY-1332', title: input.title }); });
  const replay = cycle([item()], { doctor });
  await doctorStep(replay);
  await doctorRunsSettled();
  assert.equal(filed.length, 1, 'the filing reaches the control plane');
  assert.deepEqual(filed[0].criteria.map(criterion => criterion.proofs), [['integration:main-guard-retries-a-refused-revert', 'unit:guard/retry', 'manual:the-revert-merges', 'manual:fault-class-merge']]);
  assert.deepEqual(replay.state.doctor.pendingFiles, [], 'nothing is left to retry');
  assert.deepEqual(Object.values(replay.state.actions).filter(action => action.state === 'failed'), [], 'no failed action');
  assert.deepEqual(loopFaultsOf(replay.state), [], 'no loop fault instance');
  clearDoctorRuns();
});

test(`manual:fault-class-loop — GY-1336 ${gy1336Doctor.filing}: a refused filing queued for its retry is no fault, a retry refused again is, and one the checks can never take is escalated instead of retried`, async () => {
  clearDoctorRuns();
  let refuse = true;
  const doctor = filingDoctor([mainGuardFiling(['unit:guard-retry'])], async input => {
    if (refuse) throw new Error('Graphyard refused work (503): the control plane is unavailable');
    return item({ id: 'id-GY-1332', key: 'GY-1332', title: input.title });
  });
  const replay = cycle([item()], { doctor });
  await doctorStep(replay);
  await doctorRunsSettled();
  assert.equal(replay.state.doctor.pendingFiles.length, 1, 'the refused filing is kept for its retry');
  assert.deepEqual(loopFaultsOf(replay.state), [], 'queued for the retry, it is no loop fault');
  replay.state.cycle += 1;
  await doctorStep(cycle([item()], { doctor, state: replay.state }));
  assert.deepEqual(replay.state.faults.instances.map(entry => [entry.kind, entry.faultClass]), [['plane-unavailable', 'deployment']], 'a retry refused again is still a fault: the plane not answering is the plane\'s (GY-1404, GY-1530), never a loop fault');
  clearDoctorRuns();

  // A post-merge proof no normalising can mend: the create checks refuse it on every attempt.
  const unmendable = filingDoctor([mainGuardFiling(['e2e:deploy-smoke'])], async () => { throw new Error('never reached'); });
  const refused = cycle([item()], { doctor: unmendable });
  await doctorStep(refused);
  await doctorRunsSettled();
  assert.deepEqual(refused.state.doctor.pendingFiles, [], 'it is not retried');
  const escalations = Object.values(refused.state.actions).filter(action => action.kind === 'escalation');
  assert.equal(escalations.length, 1, 'it is raised for the master instead');
  assert.match(escalations[0].detail, /fails the checks master create applies, so it is not filed; file it by hand/);
  assert.deepEqual(loopFaultsOf(refused.state), [], 'no loop fault instance');
  clearDoctorRuns();
});

// ---- GY-1338: a settled run deduplicates against the open items when it settles -----------------
//
// GY-1338 replays GY-1336's third shape at its source: a doctor run launched before GY-1332 existed
// (created 00:17:48Z) settled at 00:30:34Z and filed GY-1333 for the merge class GY-1332 already
// covered, because it deduplicated against the snapshot of the cycle that launched it.
const gy1338 = { launched: '2026-10-06T00:10:00.000Z', covering: '2026-10-06T00:17:48.544Z', settled: '2026-10-06T00:30:34.922Z' };
const gy1332 = () => item({ id: 'id-GY-1332', key: 'GY-1332', stage: 'backlog', createdAt: gy1338.covering,
  origin: { faultClass: { class: 'merge', threshold: 1, windowHours: 1, count: 1, detectedAt: gy1338.covering, instances: [] } } } as Partial<Work>);

test('unit:doctor-report-dedup-fresh-snapshot — a settled run deduplicates its filings against the open items read when it settles, not the launching cycle\'s snapshot', async () => {
  clearDoctorRuns();
  const filed: string[] = [];
  const doctor = filingDoctor([mainGuardFiling(['unit:guard-retry'])], async input => { filed.push(input.title); return item({ id: 'id-GY-1333', key: 'GY-1333' }); });
  // The launching cycle saw no merge item; by the time the run settles, GY-1332 is open.
  let current = [item()];
  const replay = cycle([item()], { doctor, clock: Date.parse(gy1338.launched), effects: { snapshot: async () => ({ work: current, now: gy1338.settled }) } });
  current = [item(), gy1332()];
  await doctorStep(replay);
  await doctorRunsSettled();
  assert.deepEqual(filed, [], 'no duplicate of GY-1332 is filed');
  assert.equal(replay.state.doctor.runs[0].state, 'reported');
  assert.match(replay.state.doctor.runs[0].detail, /0 filed, 1 deduplicated/);
  assert.ok(Object.values(replay.state.actions).some(action => /already covered by an open item/.test(action.detail)), 'recorded as covered');
  assert.deepEqual(replay.state.faults.instances, [], 'no fault');
  clearDoctorRuns();

  // With no covering item when it settles, the run files as before.
  const uncovered = cycle([item()], { doctor });
  await doctorStep(uncovered);
  await doctorRunsSettled();
  assert.deepEqual(filed, [mainGuardFiling([]).title]);
  clearDoctorRuns();

  // Unable to read the open items when it settles, the run files nothing blind: the filing waits for
  // the retry, which deduplicates against its own cycle's snapshot, with no failed action.
  filed.length = 0;
  const unread = cycle([item()], { doctor, effects: { snapshot: async () => { throw new Error('Graphyard refused work-snapshot (502): Application failed to respond'); } } });
  await doctorStep(unread);
  await doctorRunsSettled();
  assert.deepEqual(filed, []);
  assert.equal(unread.state.doctor.pendingFiles.length, 1, 'kept for the retry');
  assert.deepEqual(Object.values(unread.state.actions).filter(action => action.state === 'failed'), []);
  unread.state.cycle += 1;
  await doctorStep(cycle([item(), gy1332()], { doctor, state: unread.state }));
  assert.deepEqual(filed, [], 'the retry sees GY-1332 and drops it');
  assert.deepEqual(unread.state.doctor.pendingFiles, []);
  assert.deepEqual(unread.state.faults.instances, []);
  clearDoctorRuns();
});

test(`manual:fault-class-loop — GY-1336 GY-1333: the run that filed GY-1333 at ${gy1338.settled}, replayed, files no duplicate of GY-1332`, async () => {
  clearDoctorRuns();
  const filed: string[] = [];
  const doctor = filingDoctor([mainGuardFiling(['integration: main guard retries a refused revert'])], async input => { filed.push(input.title); return item({ id: 'id-GY-1333', key: 'GY-1333' }); });
  const launched = cycle([item()], { doctor, clock: Date.parse(gy1338.launched), effects: { snapshot: async () => ({ work: [item(), gy1332()], now: gy1338.settled }) } });
  await doctorStep(launched);
  await doctorRunsSettled();
  assert.deepEqual(filed, [], 'GY-1333 is not filed');
  assert.deepEqual(launched.state.doctor.pendingFiles, []);
  assert.deepEqual(loopFaultsOf(launched.state), []);
  clearDoctorRuns();
});

test('manual:doctor-launch-fails-fast — a run a killed loop process left running is failed by the next process at once, and the next cycle starts a fresh run, so no doctor gap waits out the old run’s bound (GY-1373)', async () => {
  clearDoctorRuns();
  const started: string[] = [], posted: string[] = [];
  const report = { findings: [], actions: [], filed: [] };
  const doctor: DoctorEffects = { settings: doctorSettingsSchema.parse({}) as DoctorEffects['settings'], cwd: '/tmp', env: {},
    file: async () => { throw new Error('nothing is filed'); }, recordRun: async run => { posted.push(`${run.at} ${run.state}`); },
    runner: async () => ({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
      name: 'pi', start: (_prompt: string, options: { tool: string }) => { started.push(options.tool);
        return { id: 'run', events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload: report, payloads: [report] }) }; } } as unknown as Runner }) };
  // The predecessor process started a run twelve minutes ago — past the interval, well inside the
  // old reaping bound of twice the time limit plus five minutes — and was killed before it settled:
  // this process holds no run, so the record is the only trace of it.
  const state = emptyDaemonState(config());
  state.doctor.runs = [summary(at(-12 * 60_000), 'running')];
  const restarted = cycle([item()], { doctor, state });
  await doctorStep(restarted);
  assert.equal(state.doctor.runs[0].state, 'failed', 'the inherited run is failed at once, not after twice its time limit');
  assert.match(state.doctor.runs[0].detail, /never ended in this process/);
  assert.deepEqual(posted, [`${at(-12 * 60_000)} failed`], 'the lost run is posted');
  const next = cycle([item()], { doctor, state });
  await doctorStep(next);
  assert.equal(state.doctor.runs.at(-1)?.at, observedAt, 'the next cycle starts a fresh run');
  await doctorRunsSettled();
  assert.equal(state.doctor.runs.at(-1)?.state, 'reported');
  assert.equal(started.length, 1);
  // A run this process started is still awaited, however long it has run.
  const running = emptyDaemonState(config());
  const own = cycle([item()], { doctor: { ...doctor, runner: async () => ({ runtime: 'pi', model: 'test/model', release: async () => {}, runner: {
    name: 'pi', start: () => ({ id: 'held', events: [], onEvent: () => () => {}, cancel: () => {}, result: () => new Promise(() => {}) }) } as unknown as Runner }) }, state: running });
  await doctorStep(own);
  const later = cycle([item()], { doctor, state: running, clock: Date.parse(at(3 * 60 * 60_000)), now: () => Date.parse(at(3 * 60 * 60_000)) });
  await doctorStep(later);
  assert.equal(running.doctor.runs[0].state, 'running', 'the run in flight in this process is left to settle');
  clearDoctorRuns();
});

// ---- GY-1530: a filing create refuses is classified and never re-filed ---------------------------
//
// GY-1516's two doctor instances were one filing — "Master loop cannot restart or self-upgrade: …" —
// whose criterion cited e2e:self-upgrade-loaded-revision-clears. master create refused it (409,
// "Register E2E scenario self-upgrade-loaded-revision-clears before creating work that requires it"):
// scenarios register only from e2e/cases files, and none by that name exists, so the refusal could
// never clear; yet the doctor kept the filing pending and re-filed it every cycle, recording each
// refusal as an unclassified action:fault.
const gy1516 = { scenario: 'self-upgrade-loaded-revision-clears', title: 'Master loop cannot restart or self-upgrade: coordinator checkout HEAD moves under the running loop, so the dirty-checkout guard stands for hours (instances 2026-10-08T01:09Z and 04:11Z)' };
/** The create route's refusal as the operator-agent post throws it: status and body kept on the error. */
const scenarioRefusal = (scenario: string) => new RefusedResponse(`Graphyard refused work (409): Register E2E scenario ${scenario} before creating work that requires it`, 409, { error: `Register E2E scenario ${scenario} before creating work that requires it` });
const selfUpgradeFiling = (proofs: string[]) => ({ faultClass: 'loop' as const, priority: 1, plannedFiles: ['src/daemon/self-upgrade.ts'], title: gy1516.title, description: 'evidence',
  criteria: [{ id: 'AC-1', text: 'The loop restarts onto the checkout revision', proofs }] });
const instanceKinds = (state: DaemonState) => state.faults.instances.map(entry => [entry.kind, entry.faultClass]);
const escalationsOf = (state: DaemonState) => Object.values(state.actions).filter(action => action.kind === 'escalation');

test('unit:doctor-filing-refusal-fix-item-kind — a filing master create refuses (any 409) is recorded failed under fix-item (proof), never action:fault, and is not kept for a retry; a plane that did not answer still queues it, and its retry refused plane-wide is the plane\'s fault', async () => {
  clearDoctorRuns();
  // Structural: the operator-agent post's RefusedResponse, here naming an unregistered scenario.
  const filed: string[] = [];
  const refusing = filingDoctor([selfUpgradeFiling([`e2e:${gy1516.scenario}`])], async (_input, key) => { filed.push(key); throw scenarioRefusal(gy1516.scenario); });
  const replay = cycle([item()], { doctor: refusing });
  await doctorStep(replay);
  await doctorRunsSettled();
  assert.equal(filed.length, 1, 'filed once');
  assert.deepEqual(instanceKinds(replay.state), [['fix-item', 'proof']]);
  assert.match(replay.state.faults.instances[0].text, /^Could not file ".+", and it is not filed again: master create refused the filing itself for the e2e proof it cites, whose scenario self-upgrade-loaded-revision-clears has no registered revision: Graphyard refused work \(409\): Register E2E scenario/);
  assert.equal(replay.state.actions[filed[0]].state, 'failed');
  assert.deepEqual(replay.state.doctor.pendingFiles, [], 'not kept for a retry');
  assert.deepEqual(loopFaultsOf(replay.state), [], 'no loop fault');
  assert.equal(replay.state.doctor.runs[0].state, 'reported', 'the run itself applied');
  clearDoctorRuns();
  // Textual: a 409 the post wrapped in plain text, for any other refusal, is the same class, and its escalation names the refusal for the master to mend.
  const other = filingDoctor([selfUpgradeFiling(['unit:self-upgrade'])], async () => { throw new Error('Graphyard refused work (409): Idempotency key reused with different input'); });
  const textual = cycle([item()], { doctor: other });
  await doctorStep(textual);
  await doctorRunsSettled();
  assert.deepEqual(instanceKinds(textual.state), [['fix-item', 'proof']]);
  assert.deepEqual(textual.state.doctor.pendingFiles, []);
  assert.equal(escalationsOf(textual.state).length, 1);
  assert.match(escalationsOf(textual.state)[0].detail, /^The doctor asked to file ".+" \(loop, P1\), but master create refused it \(Graphyard refused work \(409\): Idempotency key reused with different input\); file it by hand with master create once mended$/);
  clearDoctorRuns();
  // A plane that did not answer is queued for the retry with no fault (GY-1336); the retry refused plane-wide is plane-unavailable, not unclassified.
  const outage = filingDoctor([selfUpgradeFiling(['unit:self-upgrade'])], async () => { throw new Error('Graphyard refused work (503): the control plane is unavailable'); });
  const queued = cycle([item()], { doctor: outage });
  await doctorStep(queued);
  await doctorRunsSettled();
  assert.equal(queued.state.doctor.pendingFiles.length, 1, 'kept for the retry');
  assert.deepEqual(instanceKinds(queued.state), [], 'queued, no fault');
  queued.state.cycle += 1;
  await doctorStep(cycle([item()], { doctor: outage, state: queued.state }));
  assert.deepEqual(instanceKinds(queued.state), [['plane-unavailable', 'deployment']]);
  assert.equal(queued.state.doctor.pendingFiles.length, 1, 'still kept: the plane may answer later');
  // The plane back, the create route refuses the content: the plane's run on the key is over, so the refusal opens its own proof instance, and the filing is dropped.
  const mended = { ...outage, file: async () => { throw new Error('Graphyard refused work (409): Idempotency key reused with different input'); } };
  queued.state.cycle += 2;
  await doctorStep(cycle([item()], { doctor: mended, state: queued.state }));
  assert.deepEqual(instanceKinds(queued.state), [['plane-unavailable', 'deployment'], ['fix-item', 'proof']], 'the outage and the refusal are two causes, two instances');
  assert.deepEqual(queued.state.doctor.pendingFiles, [], 'dropped once the plane refused the content');
  clearDoctorRuns();
});

test('unit:doctor-e2e-scenario-refusal-drops-pending-file — a pending filing whose e2e proof names an unregistered scenario is dropped on its retry, escalated naming the scenario for the master to file by hand, and never re-filed', async () => {
  clearDoctorRuns();
  const filed: string[] = [];
  // No doctor run launches here: only the pending retry, which runs whether or not the doctor is due.
  const doctor: DoctorEffects = { ...filingDoctor([], async (_input, key) => { filed.push(key); throw scenarioRefusal(gy1516.scenario); }), settings: doctorSettingsSchema.parse({ enabled: false }) as DoctorEffects['settings'] };
  const state = emptyDaemonState(config());
  const key = 'doctor:3379f2b6c361998f7abec8ee:file:loop';
  state.doctor.pendingFiles = [{ key, at: observedAt, file: selfUpgradeFiling([`e2e:${gy1516.scenario}`]) }];
  await doctorStep(cycle([item()], { doctor, state }));
  assert.deepEqual(filed, [key], 'the retry reaches the control plane once, under the filing\'s stable key');
  assert.deepEqual(state.doctor.pendingFiles, [], 'dropped');
  assert.deepEqual(instanceKinds(state), [['fix-item', 'proof']]);
  assert.equal(state.actions[key].state, 'failed');
  assert.match(state.actions[key].detail, /whose scenario self-upgrade-loaded-revision-clears has no registered revision/);
  const escalations = escalationsOf(state);
  assert.equal(escalations.length, 1, 'raised for the master');
  assert.match(escalations[0].detail, /^The doctor asked to file ".+" \(loop, P1\), but the filing cites e2e:self-upgrade-loaded-revision-clears, and no scenario self-upgrade-loaded-revision-clears is registered \(scenarios register only from e2e\/cases files via graphyard e2e sync or an admin's defineScenario\); register it, or file the item by hand with master create under a proof that exists$/);
  assert.equal(escalations[0].state, 'done', 'an escalation, not a second fault');
  // Every later cycle, past every backoff the retry would have waited: nothing is filed again.
  for (let round = 1; round <= 8; round++) { state.cycle += 1 << round; await doctorStep(cycle([item()], { doctor, state })); }
  assert.deepEqual(filed, [key], 'never re-filed');
  assert.equal(state.faults.instances.length, 1, 'one refusal, one instance');
  clearDoctorRuns();
});
