import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { sshOrigin } from './helpers/ssh-origin.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, type AgentRegistry } from '../src/model/registry.js';
import { publishOnboarding } from '../src/up.js';
import { onboardingBranch } from '../src/model/onboarding-work.js';

// GY-3276 AC-1: setup accepts a long PATH and the onboarding push uses the install's own push
// credential. A host whose PATH runs 1,500 characters — many tool directories — proposes and
// applies its fleet registry, and the pinned runtime keeps the whole PATH, led by the resolved
// install directory. A 9,000-character value is refused naming PATH and its exact length, never
// a bare schema error. And the onboarding branch push lands on a fixture git remote whose SSH
// door serves git only to the install's deploy key — the credential the merge writer itself
// pushes with, never the operator's personal SSH key.

/** A PATH of exactly `length` characters: colon-joined /opt entries, the last padded to length. */
const pathOfLength = (length: number) => {
  const entries: string[] = [];
  let used = 0;
  for (let index = 0; used < length; index++) {
    const entry = `/opt/fixture-tools-${index}`, cost = entries.length ? entry.length + 1 : entry.length;
    if (used + cost > length) break;
    entries.push(entry); used += cost;
  }
  return entries.join(':') + 'x'.repeat(length - used);
};

/** One logged-in Claude environment under a fixture ~/.coding_agents. */
async function claudeHost(directory: string) {
  const agents = join(directory, '.coding_agents'), home = join(directory, 'home');
  await mkdir(join(agents, 'claude-a'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(agents, 'claude-a', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `a${'t'.repeat(39)}`, refreshToken: `r${'t'.repeat(39)}`, expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  return { agents, home };
}

/** Runs BODY with this host's own agent login (XDG_DATA_HOME) out of the way, so only the fixture is discovered. */
async function fixtureLoginsOnly<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try { return await body(); } finally { if (saved !== undefined) process.env.XDG_DATA_HOME = saved; }
}

/**
 * The control plane's own apply path: the same `applyRegistryMutation` the registry route runs,
 * with a schema refusal answered as the server answers it (its zod issues), so the wording the
 * operator reads is the wording judged here.
 */
function registryApi() {
  let registry: AgentRegistry = emptyRegistry();
  return {
    read: async () => registry,
    write: async (_path: string, data: unknown) => {
      try {
        registry = applyRegistryMutation(registry, 'apply', data, { actor: 'coordinator', at: new Date().toISOString() }).registry;
        return { revision: registry.revision, registry };
      } catch (error: any) {
        if (Array.isArray(error?.issues)) throw new Error(JSON.stringify({ error: 'Invalid input', issues: error.issues }));
        throw error;
      }
    },
  };
}

test('e2e:setup-long-path-and-onboarding-push — a 1,500-character PATH applies through the registry proposal and the pinned runtime keeps it', async t => {
  const directory = await temporaryDirectory('setup-long-path-propose');
  const { agents, home } = await claudeHost(directory);
  const install = join(directory, 'claude-install');
  await mkdir(install, { recursive: true });
  const path = pathOfLength(1500);
  assert.equal(path.length, 1500);
  const saved = process.env.PATH;
  process.env.PATH = path;
  t.after(() => { process.env.PATH = saved; });
  const applied = await fixtureLoginsOnly(() => registryCommand({ hostId: 'agent-host-1' }, ['propose', '--directory', agents, '--apply'], registryApi(), { home, executables: () => false, install: () => install })) as any;
  assert.equal(applied.applied, true, `the proposal applies on a host with a 1,500-character PATH: ${applied.next ?? ''}`);
  const runtime = applied.registry.runtimes.find((entry: any) => entry.name === 'claude');
  assert.ok(runtime, 'the pinned claude runtime is registered');
  assert.equal(runtime.launch.environment.PATH, [install, path].join(':'), 'the pinned runtime keeps the whole 1,500-character PATH, led by its install directory');
  assert.equal(runtime.launch.environment.MISE_NO_CONFIG, '1');
});

test('e2e:setup-long-path-and-onboarding-push — a 9,000-character PATH is refused naming the variable and its length', async t => {
  const directory = await temporaryDirectory('setup-long-path-refused');
  const { agents, home } = await claudeHost(directory);
  const install = join(directory, 'claude-install');
  await mkdir(install, { recursive: true });
  // The pinned launch value is the install directory plus the host PATH, so the host PATH is set
  // to what makes the stored value exactly 9,000 characters — the value the AC refuses.
  const path = pathOfLength(9000 - install.length - 1);
  const saved = process.env.PATH;
  process.env.PATH = path;
  t.after(() => { process.env.PATH = saved; });
  await assert.rejects(
    () => fixtureLoginsOnly(() => registryCommand({ hostId: 'agent-host-1' }, ['propose', '--directory', agents, '--apply'], registryApi(), { home, executables: () => false, install: () => install })),
    /PATH is 9000 characters.*limited to 8000/s,
    'the refusal names PATH and its exact length',
  );
});

test('e2e:setup-long-path-and-onboarding-push — the onboarding branch push lands on a fixture remote that accepts only the install\'s deploy key', async t => {
  // The door and the install share one directory, so the deploy key the door demands is the one
  // at the install's own path — the file the merge writer's push credential resolves to.
  const fixture = await temporaryDirectory('setup-long-path-push');
  const configHome = join(fixture, 'graphyard-config'), install = join(configHome, 'owner-project');
  const door = await sshOrigin(install);
  const checkout = join(fixture, 'checkout');
  const through = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${door.bin}:${process.env.PATH}`, ...extra });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', env: through({ GIT_SSH_COMMAND: door.deployKeySshCommand }), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['clone', '-q', door.url, checkout], { env: through({ GIT_SSH_COMMAND: door.deployKeySshCommand }), stdio: 'ignore' });
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  await writeFile(join(checkout, 'README.md'), '# Fixture\n');
  git('add', '--', 'README.md'); git('commit', '-qm', 'base'); git('push', '-q', 'origin', 'main');
  await writeFile(join(checkout, 'AGENTS.md'), '# Coordination\n');
  await writeFile(join(checkout, '.gitignore'), '.graphyard/\n');
  await writeFile(join(checkout, 'graphyard.json'), '{}\n');
  const servedBefore = (await door.accesses()).length;
  // The operator's environment carries no key of their own: only the install's credential, on the
  // PATH the door's ssh wrapper rides, pushes the branch.
  const savedPath = process.env.PATH, savedConfigHome = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.PATH = `${door.bin}:${process.env.PATH}`;
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  t.after(() => { process.env.PATH = savedPath; if (savedConfigHome === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = savedConfigHome; });
  const run = (program: string, args: string[], env?: Record<string, string>) => program === 'gh'
    ? 'main\n'
    : execFileSync(program, args, { cwd: checkout, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const published = await publishOnboarding(checkout, 'owner/project', run);
  assert.ok(published, 'the onboarding files were published through the door');
  assert.match(published.commit, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', `refs/heads/${onboardingBranch}`], { cwd: door.repository, encoding: 'utf8' }).trim(), published.commit, 'the onboarding branch landed on the remote only the deploy key opens');
  const accesses = (await door.accesses()).slice(servedBefore);
  assert.ok(accesses.some(entry => entry.service === 'git-upload-pack' && entry.presented && entry.outcome === 'served'), `the fetch presented the install's deploy key: ${JSON.stringify(accesses)}`);
  assert.ok(accesses.some(entry => entry.service === 'git-receive-pack' && entry.presented && entry.outcome === 'served'), `the push presented the install's deploy key: ${JSON.stringify(accesses)}`);
  assert.ok(accesses.every(entry => entry.presented), `no keyless call was served: ${JSON.stringify(accesses)}`);
});
