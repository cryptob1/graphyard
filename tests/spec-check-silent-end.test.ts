import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { masterConfigSchema, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, writeDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { sessionHarnessPlan } from '../src/master/harness.js';
import { readVendorPrompts, specCheckPrompt } from '../src/spec-check.js';
import { postSpecCheck, writeSpecCheckBinding } from '../src/spec-check-post.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { fileURLToPath } from 'node:url';

// GY-2995: the loop refuses a launch whose CLI is unreachable, so the fixture names this checkout's real launcher.
const cliPath = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

// GY-2994: a spec-check session that cannot fetch origin still reads the base tip it was handed
// from the local repository and posts its report; and one that ends without a report — its pane
// gone, or BLOCKED on it — is named in master status with its reason and relaunched at once,
// rather than when its launch expires an hour on.

const start = Date.parse('2030-01-01T12:00:00Z');

function feature(key: string): Work {
  const at = new Date(start).toISOString();
  return {
    id: `0b5e6c1e-0000-4000-8000-0000000000${key.slice(-2)}`, key, title: key, description: 'The export flow moves behind the settings screen.', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'A signed-up user can export their data from the settings screen', proofs: ['e2e:export-flow'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
  } as Work;
}

test('integration:spec-check-reads-base-without-network — the prompted checkout reads the local base tip with origin unreachable, the harness allows it, and the report posts', async () => {
  const root = await temporaryDirectory('spec-check-offline');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0' } }).trim();
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(root, 'README.md'), 'The named file.\n');
  git('add', 'README.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'base');
  // An origin no session can reach, and the remote-tracking ref the loop's dispatch cycle last fetched.
  git('remote', 'add', 'origin', 'ssh://git@unreachable.invalid/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.throws(() => git('fetch', 'origin', 'main'), 'origin is unreachable from this session');
  const tip = git('rev-parse', 'refs/remotes/origin/main');
  const worktree = join(root, '..', `${root.split('/').at(-1)}-checkout`);
  const work = feature('GY-01');
  const prompt = specCheckPrompt({ repository: 'owner/project', cliPath, baseBranch: 'main' }, work, await readVendorPrompts(), worktree, tip);
  assert.doesNotMatch(prompt, /git fetch/, 'the prompt asks for no network fetch');
  assert.match(prompt, /fetch nothing/);
  assert.match(prompt, /MODULE_NOT_FOUND.*wait a minute and run the same post again/, 'a CLI a self-deploy is replacing is retried, not given up on');
  // Run exactly the command the prompt names: it succeeds from the local object store alone.
  const command = /git worktree add --detach (\S+) ([0-9a-f]{40})/.exec(prompt);
  assert.ok(command, 'the prompt names the checkout command');
  assert.equal(command[1], worktree);
  assert.equal(command[2], tip);
  git('worktree', 'add', '--quiet', '--detach', command[1], command[2]);
  assert.ok(existsSync(join(worktree, 'README.md')), 'the named file is read from the base tip');
  // The session's harness allows that command and the post.
  const plan = sessionHarnessPlan({ role: 'reviewer', kind: 'claude', cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome: '/home/reviewer', credentialDirectories: [], checkout: worktree });
  const allowed = plan.allow.map(entry => entry.rule);
  assert.ok(allowed.includes(`Bash(git worktree add --detach ${worktree}:*)`), 'the harness allows the prompted checkout');
  assert.ok(allowed.includes(`Bash(node ${cliPath} spec-check post:*)`), 'and the post');
  // The report posts through the launch's binding.
  const credentials = await temporaryDirectory('spec-check-offline-binding');
  const token = 'a'.repeat(64);
  await writeSpecCheckBinding(credentials, { repository: 'owner/project', key: work.key, workId: work.id, policyRevision: 1, reviewer: 'spec-checker', url: 'https://graphyard.example', token });
  const posted: { url: string; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => { posted.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ policyRevision: 1 }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
  const result = await postSpecCheck({ verdict: 'ready', paraphrase: 'Moves the export flow; AC-1 proven by its e2e case.', gaps: [], cliPath, environment: { GH_CONFIG_DIR: credentials, GRAPHYARD_SPEC_CHECK: work.key, GRAPHYARD_URL: 'https://graphyard.example' } }, { fetch });
  assert.match(result, /Spec check recorded on GY-01/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, `https://graphyard.example/api/work/${work.id}/spec-check`);
  assert.equal(posted[0].body.verdict, 'ready');
});

test('integration:spec-check-silent-end-surfaces — a checker that ends without a report is named in master status with its reason and relaunched within 5 minutes', async () => {
  const directory = await temporaryDirectory('spec-check-silent-end');
  const root = join(directory, 'repo'), private_ = join(directory, 'private');
  await mkdir(root); await mkdir(private_);
  execFileSync('git', ['init', '--quiet', root]);
  const token = join(private_, 'coordinator.token');
  await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const gone = feature('GY-02'), blocked = feature('GY-03');
  const work = [gone, blocked];
  let clock = start, launches = 0;
  const live = new Set<string>(), closed: string[] = [], checks: { key: string; at: number }[] = [];
  const screens = new Map<string, string>();
  const state = emptyDaemonState(master);
  const effects: DaemonEffects = {
    agents: () => [...live].map(pane => ({ name: pane, pane_id: pane }) as unknown as HerdrAgent),
    credentials: async () => ({}),
    snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
    sessionScreen: session => screens.get(session.pane ?? '') ?? '',
    closeSession: pane => { closed.push(pane); live.delete(pane); },
    dispatch: async () => { throw new Error('no worker dispatches before the check reports'); },
    // The checker launch: the control plane registers a fresh launch, replacing any standing one, and the pane runs.
    launchSpecCheck: async item => {
      launches += 1;
      checks.push({ key: item.key, at: clock });
      item.specCheckLaunch = { id: `launch-${launches}`, reviewer: 'spec-checker', requester: 'master', tokenHash: 'f'.repeat(64), at: new Date(clock).toISOString(), expiresAt: new Date(clock + 3_600_000).toISOString(), policyRevision: item.policyRevision };
      live.add(`pane-${launches}`);
      return { pane: `pane-${launches}` };
    },
    persist: current => writeDaemonState(master, current),
  };
  const cycle = async () => { await runCycle(master, state, effects, () => clock); clock += 30_000; };
  // One checker launches a cycle; both run.
  await cycle(); await cycle(); await cycle();
  assert.deepEqual(checks.map(entry => entry.key), ['GY-02', 'GY-03'], 'each feature gets its checker');
  assert.deepEqual(closed, [], 'running checkers stay open');
  // GY-02's session exits (its pane leaves Herdr); GY-03's prints a BLOCKED line and sits.
  const ended = clock;
  live.delete('pane-1');
  screens.set('pane-2', 'Running git fetch...\n⏺ BLOCKED: git fetch --no-write-fetch-head origin main exited 128: Bad owner or permissions on /etc/ssh/ssh_config.d/20-omarchy-keepalive.conf\n> ');
  for (let round = 0; round < 4; round += 1) await cycle();
  assert.deepEqual(closed.sort(), ['pane-1', 'pane-2'], 'both silent checkers are closed');
  const relaunched = checks.slice(2);
  assert.deepEqual(relaunched.map(entry => entry.key).sort(), ['GY-02', 'GY-03'], 'both are relaunched');
  for (const entry of relaunched) assert.ok(entry.at - ended <= 5 * 60_000, `${entry.key} relaunched ${(entry.at - ended) / 1000}s after its session ended`);
  assert.equal(live.size, 2, 'the relaunched checkers run');
  // Master status names each, with its reason.
  const report = await masterStatusReport(root, master, async () => ({ work, now: new Date(clock).toISOString() }), async () => { throw new Error('no git in the fixture'); });
  const named = Object.fromEntries(report.specChecksEnded.map(entry => [entry.work, entry.reason]));
  assert.match(named['GY-02'] ?? '', /ended without a report: Herdr no longer reports pane pane-1/);
  assert.match(named['GY-03'] ?? '', /ended without a report: BLOCKED: git fetch .* exited 128: Bad owner or permissions/);
  // Once the check reports, master status stops naming it.
  gone.specCheck = { policyRevision: 1, verdict: 'ready', paraphrase: 'p', gaps: [], reviewer: 'spec-checker', at: new Date(clock).toISOString() };
  const after = await masterStatusReport(root, master, async () => ({ work, now: new Date(clock).toISOString() }), async () => { throw new Error('no git in the fixture'); });
  assert.deepEqual(after.specChecksEnded.map(entry => entry.work), ['GY-03']);
});
