import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registryCommand } from '../src/cli/master-registry.js';
import { applyRegistryMutation, emptyRegistry, fleetRoles, type AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-170 AC-1: `master registry propose` turns this installation's ~/.coding_agents tree into a
 * registry — every Claude, Codex, Cursor, OpenCode and Pi environment as an account of its runtime,
 * with the credential held by reference (host and home) — and `--apply` stores it as one registry
 * revision. Every credential file in the fixture holds a secret-shaped value; none of it may reach
 * the proposal, which carries only what the readiness probes decide: logged in or not.
 */

const HOST = 'agent-host-1';
const scratch = await temporaryDirectory('registry-discovery');
after(() => rm(scratch, { recursive: true, force: true }));

const secrets: string[] = [];
const secret = (label: string) => { const value = `sk-ant-${label}-${'x'.repeat(24)}-SECRET`; secrets.push(value); return value; };
async function file(path: string, content: unknown) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
}

/** The environments this installation actually has (see ~/.coding_agents/README.md), each logged in, plus one Pi environment nobody logged in to. */
async function codingAgents() {
  const root = join(scratch, '.coding_agents');
  for (const name of ['claude-a', 'claude-b', 'claude-c'])
    await file(join(root, name, '.credentials.json'), { claudeAiOauth: { accessToken: secret(`${name}-access`), refreshToken: secret(`${name}-refresh`), expiresAt: Date.now() + 3_600_000 } });
  await file(join(root, 'codex', 'auth.json'), { tokens: { access_token: secret('codex-access'), refresh_token: secret('codex-refresh') } });
  await file(join(root, 'cursor-a', 'cli-config.json'), { authInfo: { userId: 'user-1', email: 'agent@example.test', accessToken: secret('cursor-access') } });
  for (const name of ['opencode-a', 'opencode-b']) await file(join(root, name, 'opencode', 'auth.json'), { anthropic: { type: 'api', key: secret(`${name}-key`) } });
  for (const name of ['pi-a', 'pi-b']) {
    await file(join(root, name, 'auth.json'), { zai: { type: 'api_key', key: secret(`${name}-key`) } });
    await file(join(root, name, 'settings.json'), { theme: 'dark', note: secret(`${name}-settings`) });
  }
  await mkdir(join(root, 'pi-c'), { recursive: true });
  // Files that are nobody's login are never looked at either.
  await file(join(root, 'claude-a', 'history.jsonl'), `${JSON.stringify({ text: secret('history') })}\n`);
  await file(join(root, 'README.md'), '# not an environment');
  return root;
}

test('unit:registry-discovers-agent-environments — propose discovers every ~/.coding_agents environment (Claude, Codex, Cursor, OpenCode, Pi), proposes runtimes, accounts by reference, models and a worker/reviewer/approver/producer mapping, --apply writes it as a registry revision, and no credential content reaches the proposal', async () => {
  const directory = await codingAgents(), home = join(scratch, 'home');
  await mkdir(home, { recursive: true });
  // Only the fixture is looked at: no runtime default home, no provider, no executable on this machine.
  const saved = process.env.XDG_DATA_HOME; delete process.env.XDG_DATA_HOME;
  const written: { path: string; data: any }[] = [];
  let registry: AgentRegistry = emptyRegistry();
  const api = {
    read: async (path: string) => { assert.equal(path, 'agent-registry/document'); return registry; },
    write: async (path: string, data: any) => {
      written.push({ path, data });
      const { reason, ...proposal } = data;
      registry = applyRegistryMutation(registry, 'apply', { ...proposal, reason }, { actor: 'coordinator', at: new Date().toISOString() }).registry;
      return { revision: registry.revision, registry };
    },
  };
  const options = { home, executables: () => false };
  try {
    const preview = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory], api, options) as any;
    assert.equal(preview.applied, false, 'a proposal alone stores nothing');
    assert.equal(written.length, 0);

    // Discovery: every environment directory, with its runtime and home; the one nobody logged in to is reported with how to log it in.
    assert.deepEqual(preview.discovered.map((login: any) => [login.name, login.runtime, login.home, login.loggedIn, login.source]), [
      ['claude-a', 'claude', join(directory, 'claude-a'), true, 'environment'],
      ['claude-b', 'claude', join(directory, 'claude-b'), true, 'environment'],
      ['claude-c', 'claude', join(directory, 'claude-c'), true, 'environment'],
      ['codex', 'codex', join(directory, 'codex'), true, 'environment'],
      ['cursor-a', 'cursor', join(directory, 'cursor-a'), true, 'environment'],
      ['opencode-a', 'opencode', join(directory, 'opencode-a'), true, 'environment'],
      ['opencode-b', 'opencode', join(directory, 'opencode-b'), true, 'environment'],
      ['pi-a', 'pi', join(directory, 'pi-a'), true, 'environment'],
      ['pi-b', 'pi', join(directory, 'pi-b'), true, 'environment'],
      ['pi-c', 'pi', join(directory, 'pi-c'), false, 'environment'],
    ]);
    assert.equal(preview.discovered.find((login: any) => login.name === 'pi-c').login, `PI_CODING_AGENT_DIR=${join(directory, 'pi-c')} pi, then /login`);

    // Runtimes, each with its launch contract; Pi is its own `pi` runtime kind.
    const proposal = preview.proposal;
    assert.deepEqual(proposal.runtimes.map((runtime: any) => runtime.name), ['claude', 'codex', 'cursor', 'opencode', 'pi']);
    assert.deepEqual(proposal.runtimes.find((runtime: any) => runtime.name === 'pi').launch,
      { kind: 'pi', args: [], environment: {}, homeVariable: 'PI_CODING_AGENT_DIR', modelFlag: '--model', login: 'PI_CODING_AGENT_DIR={home} pi, then /login', loginFile: 'auth.json', toolsFlag: '--tools' });
    assert.equal(proposal.runtimes.find((runtime: any) => runtime.name === 'claude').launch.homeVariable, 'CLAUDE_CONFIG_DIR');

    // Accounts: one per logged-in environment, the credential by reference only — host and home.
    assert.deepEqual(proposal.accounts.map((account: any) => [account.name, account.runtime, account.model, account.credential]), [
      ['claude-a', 'claude', 'claude-default', { host: HOST, home: join(directory, 'claude-a') }],
      ['claude-b', 'claude', 'claude-default', { host: HOST, home: join(directory, 'claude-b') }],
      ['claude-c', 'claude', 'claude-default', { host: HOST, home: join(directory, 'claude-c') }],
      ['codex', 'codex', 'codex-default', { host: HOST, home: join(directory, 'codex') }],
      ['cursor-a', 'cursor', 'cursor-default', { host: HOST, home: join(directory, 'cursor-a') }],
      ['opencode-a', 'opencode', 'opencode-default', { host: HOST, home: join(directory, 'opencode-a') }],
      ['opencode-b', 'opencode', 'opencode-default', { host: HOST, home: join(directory, 'opencode-b') }],
      ['pi-a', 'pi', 'pi-default', { host: HOST, home: join(directory, 'pi-a') }],
      ['pi-b', 'pi', 'pi-default', { host: HOST, home: join(directory, 'pi-b') }],
    ]);
    for (const account of proposal.accounts) assert.deepEqual(Object.keys(account.credential).sort(), ['home', 'host'], `${account.name} holds a reference, nothing more`);
    assert.deepEqual(proposal.models.map((model: any) => model.name), ['claude-default', 'codex-default', 'cursor-default', 'opencode-default', 'pi-default']);

    // The role mapping: worker, reviewer, approver and producer are all mapped; Pi serves the narrow roles.
    const roles = Object.fromEntries(proposal.roles.map((role: any) => [role.name, role.accounts]));
    for (const role of ['worker', 'reviewer', 'approver', 'producer']) assert.ok(roles[role]?.length, `role ${role} is mapped`);
    const full = ['claude-a', 'claude-b', 'claude-c', 'codex', 'cursor-a', 'opencode-a', 'opencode-b'];
    assert.deepEqual(roles.worker, full); assert.deepEqual(roles.reviewer, full);
    assert.deepEqual(roles.approver, [...full, 'pi-a', 'pi-b']); assert.deepEqual(roles.producer, [...full, 'pi-a', 'pi-b']);
    assert.deepEqual(proposal.roles.map((role: any) => role.name), [...fleetRoles]);

    // Nothing a credential home holds beyond what the readiness probe decides reaches the proposal.
    const shown = JSON.stringify(preview);
    for (const value of secrets) assert.ok(!shown.includes(value), `the proposal never carries ${value.slice(0, 20)}…`);
    assert.ok(!/accessToken|refreshToken|access_token|"key"/.test(shown), 'no credential field name either');

    // --apply writes the proposal as one registry revision.
    const applied = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory, '--apply'], api, options) as any;
    assert.equal(applied.applied, true);
    assert.deepEqual(written.map(entry => entry.path), ['agent-registry/apply']);
    assert.equal(applied.revision, 1);
    assert.deepEqual(registry.accounts.map(account => account.name), proposal.accounts.map((account: any) => account.name));
    assert.deepEqual(registry.roles.map(role => role.name), [...fleetRoles]);
    assert.equal(registry.lastMutation?.kind, 'apply');
    const stored = JSON.stringify(registry);
    for (const value of secrets) assert.ok(!stored.includes(value), 'the stored revision never carries a credential');

    // Proposing again finds the registry already holding every login: nothing more to write.
    const again = await registryCommand({ hostId: HOST }, ['propose', '--directory', directory, '--apply'], api, options) as any;
    assert.equal(again.applied, false); assert.equal(written.length, 1);
    assert.match(again.next, /already holds every login/);
  } finally {
    if (saved !== undefined) process.env.XDG_DATA_HOME = saved;
  }
});
