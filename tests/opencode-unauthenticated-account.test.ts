import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { chooseSession, emptyRegistry, endRegistrySession, fleetView, foldObservations, proposedRuntimes, supersededByRequest, type AgentRegistry, type FleetSession, type RegistryMutation } from '../src/model/registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { opencodeAuthList } from '../src/master/runtimes.js';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';
import { clearRuns } from '../src/runner/registry.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';

// GY-3414: on lumina-investor opencode-a/b/c held an auth.json with a Z.AI key, read as logged in,
// while OpenCode itself listed no authenticated provider: every review ran the free fallback model,
// stopped in 2-3 s and was recorded only as "bwrap exited with code 1". An account OpenCode lists
// no provider for now reads as not logged in on the Workers page, is passed over for review, and a
// run that still fails names OpenCode's own error.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const scratch = await realpath(await temporaryDirectory('opencode-unauthenticated'));
const bin = join(scratch, 'bin');
await mkdir(bin);
// A stand-in OpenCode 2.x: `auth list` lists a provider only for a home OpenCode took the login
// into (marked `taken`); `run` prints its error as a JSON event on stdout and exits 1, as 2.3 does.
await writeFile(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = auth ]; then
  if [ -e "$XDG_DATA_HOME/opencode/taken" ]; then echo 'Z.AI Coding Plan  API key  stored'; else echo 'No authenticated integrations'; fi
  exit 0
fi
echo '{"type":"step_start","sessionID":"ses_1"}'
echo '{"type":"error","sessionID":"ses_1","error":{"type":"provider.model","message":"Model not found: zai-coding-plan/glm-9"}}'
exit 1
`, { mode: 0o755 });
const path = process.env.PATH;
process.env.PATH = `${bin}:${path}`;
after(() => { process.env.PATH = path; clearRuns(); });

/** The control plane's registry in memory, through the same pure functions the server runs. */
function memoryRegistry(host: string) {
  let registry: AgentRegistry = emptyRegistry();
  const at = () => new Date().toISOString();
  const mutate = (kind: RegistryMutation, input: unknown) => { registry = applyRegistryMutation(registry, kind, input, { actor: 'operator', at: at() }).registry; };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at(), endReason: 'superseded' });
      foldObservations(registry, request, { actor: 'coordinator', at: at() });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const session: FleetSession = { id: crypto.randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at(), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry.sessions.push(session); registry.revision++;
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async (id, reason, outcome) => { const session = registry.sessions.find(entry => entry.id === id); if (session && endRegistrySession(registry, session, reason, outcome, at())) registry.revision++; },
  };
  return { client, mutate, current: () => registry };
}

async function installation() {
  const root = join(scratch, 'repository'), credentials = join(scratch, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'opencode login\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: join(scratch, 'worktrees') } }, coordinatorStatus, { probe: durable });
  return { root, config: await loadMasterConfig(root) };
}
async function opencodeHome(name: string, taken: boolean) {
  const home = join(scratch, name);
  await mkdir(join(home, 'opencode'), { recursive: true });
  await writeFile(join(home, 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: `${name}-key` } }), { mode: 0o600 });
  if (taken) await writeFile(join(home, 'opencode', 'taken'), '');
  return home;
}

test('e2e:opencode-unauthenticated-account — an auth file OpenCode lists no provider for is not logged in, not chosen to review, and a failing run names OpenCode\'s error', async () => {
  const { root, config } = await installation(), registry = memoryRegistry(config.hostId);
  registry.mutate('apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'opencode'),
    models: [{ name: 'glm', id: 'zai-coding-plan/glm-5.3' }],
    accounts: [{ name: 'opencode-a', home: await opencodeHome('opencode-a', false) }, { name: 'opencode-b', home: await opencodeHome('opencode-b', true) }]
      .map(account => ({ name: account.name, runtime: 'opencode', model: 'glm', plan: 'zai', credential: { host: config.hostId, home: account.home } })),
    roles: [{ name: 'reviewer', accounts: ['opencode-a', 'opencode-b'], concurrency: 4 }],
    reason: 'Reviewers on OpenCode',
  });

  const chosen = (await selectFleetSession(config, 'reviewer', { name: 'reviewer' }, { registry: registry.client, quota: false, cacheMs: 0, opencodeAuth: opencodeAuthList }))!;
  assert.equal(chosen.account?.name, 'opencode-b', 'the review goes to the account OpenCode lists a provider for');

  const workers = fleetView(registry.current(), Date.now(), config.hostId).accounts;
  const unauthenticated = workers.find(account => account.name === 'opencode-a')!;
  assert.equal(unauthenticated.loggedIn, false, 'the Workers page shows opencode-a logged out');
  assert.equal(unauthenticated.eligible, false);
  assert.match(unauthenticated.ineligible ?? '', /opencode-a is not logged in/);
  assert.equal(workers.find(account => account.name === 'opencode-b')!.loggedIn, true);

  // A run that still fails on OpenCode carries OpenCode's own error, not only its exit code.
  const directory = await temporaryDirectory('review', scratch);
  const session = await startHeadlessSession({ name: 'review-opencode', work: 'GY-9414', subject: 'review', kind: 'opencode', account: 'opencode-b', args: [], environment: { PATH: `${bin}:/usr/bin:/bin` },
    directory, root, route: 'review', context: {}, prompt: 'Review GY-9414.', exec: spawnHeadless, answer: async output => output });
  await assert.rejects(session.settled, /exited with code 1: Model not found: zai-coding-plan\/glm-9/);
});
