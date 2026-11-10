import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeUpEvent, onboardingBranch, publishOnboarding, runUp, type UpDependencies, type UpEvent } from '../src/up.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3221: `up` refuses a base branch inside Graphyard's own branch namespace before anything
// runs; onboarding commits are authored by Graphyard's own identity, so a host with no global git
// identity commits all the same; and a failing step's event and printed error carry the failed
// command's stderr. Every scratch repository here runs with HOME pointing at an empty directory
// (and no system git config), so no host git identity exists anywhere in these tests.

/** A scratch repository whose every git child runs with an empty HOME, plus the runner publishOnboarding uses. */
async function scratchRepository(label: string) {
  const root = await temporaryDirectory(`up-preflight-${label}`);
  const origin = await temporaryDirectory(`up-preflight-${label}-origin`);
  const home = await temporaryDirectory(`up-preflight-${label}-home`);
  const configHome = await temporaryDirectory(`up-preflight-${label}-config`);
  // No global (~/.gitconfig, ~/.config/git/config) and no system git config: the only identity any
  // git command could find is the one Graphyard's own commands carry.
  const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', '-q', '-b', 'main', origin);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  await writeFile(join(root, 'README.md'), '# scratch\n');
  git('add', '.');
  git('-c', 'user.name=Scratch', '-c', 'user.email=scratch@example.com', 'commit', '-qm', 'main');
  git('push', '-q', 'origin', 'main');
  // The runner publishOnboarding runs its children with: the same empty HOME, and gh answered
  // without the binary (the scratch repository's default branch is main).
  const run = (program: string, args: string[], env?: Record<string, string>) => program === 'gh'
    ? 'main\n'
    : execFileSync(program, args, { cwd: root, encoding: 'utf8', env: { ...environment, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { root, origin, configHome, git, run };
}

/** Runs BODY with GRAPHYARD_CONFIG_HOME on the scratch config home, so no real install record is read. */
async function withConfigHome<T>(configHome: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = configHome;
  try { return await body(); } finally {
    if (previous === undefined) delete process.env.GRAPHYARD_CONFIG_HOME;
    else process.env.GRAPHYARD_CONFIG_HOME = previous;
  }
}

const onboardingFiles = async (root: string) => {
  await writeFile(join(root, 'AGENTS.md'), '# Coordination\n');
  await writeFile(join(root, '.gitignore'), '.graphyard/\n');
  await writeFile(join(root, 'graphyard.json'), '{}\n');
};

test("unit:tests/up-preflight-branch-identity.test.ts — up refuses --base-branch graphyard and graphyard/x before any action runs", async () => {
  const root = await temporaryDirectory('up-preflight-namespace');
  const calls: string[][] = [];
  const events: UpEvent[] = [];
  const deps: UpDependencies = {
    root, emit: event => events.push(event), now: () => 0, sleep: async () => {},
    serverUrl: async () => 'http://127.0.0.1:4310', masterToken: async () => 'm'.repeat(40), status: async () => null,
    publishOnboarding: async () => null,
    cli: async args => {
      calls.push(args);
      return args.includes('--plan')
        ? { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) }
        : { code: 1, stdout: '', stderr: 'the run stops after preflight' };
    },
    gh: async () => ({ code: 0, stdout: '', stderr: '' }), git: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  for (const branch of ['graphyard', 'graphyard/release']) {
    calls.length = 0; events.length = 0;
    const result = await runUp({ repository: 'owner/project', provider: 'compose', agent: false, master: 'claude', baseBranch: branch }, deps);
    assert.equal(result.ok, false, `${branch} is refused`);
    assert.match(result.next, /--base-branch graphyard[/\w.-]* is Graphyard's own branch namespace/);
    assert.match(result.next, new RegExp(onboardingBranch));
    assert.deepEqual(calls, [], `${branch}: no command ran before the refusal`);
    assert.ok(events.every(event => event.kind !== 'step'), `${branch}: no step ran: ${JSON.stringify(events)}`);
  }
  // A branch outside the namespace — even one containing the word — is not refused: preflight runs.
  calls.length = 0; events.length = 0;
  const outside = await runUp({ repository: 'owner/project', provider: 'compose', agent: false, master: 'claude', baseBranch: 'release/graphyard-mirror' }, deps);
  assert.ok(calls.some(args => args[0] === 'install' && args.includes('--plan')), `preflight ran: ${outside.next}`);
  assert.ok(events.some(event => event.kind === 'step' && event.state === 'done'), JSON.stringify(events));
});

test("unit:tests/up-preflight-branch-identity.test.ts — onboarding commits succeed with no host git identity, authored by Graphyard", async () => {
  const { root, origin, configHome, git, run } = await scratchRepository('identity');
  await onboardingFiles(root);
  const published = await withConfigHome(configHome, () => publishOnboarding(root, 'owner/scratch-up-preflight', run));
  assert.ok(published, 'the onboarding commit was built with no host git identity');
  assert.equal(git('show', '-s', '--format=%an <%ae>', published.commit), 'Graphyard <graphyard@localhost>');
  assert.equal(git('show', '-s', '--format=%cn <%ce>', published.commit), 'Graphyard <graphyard@localhost>');
  assert.match(git('ls-remote', origin, `refs/heads/${onboardingBranch}`), new RegExp(published.commit), 'pushed to the onboarding branch');
  assert.deepEqual(await withConfigHome(configHome, () => publishOnboarding(root, 'owner/scratch-up-preflight', run)), published, 'a rerun publishes the same head');
});

test("unit:tests/up-preflight-branch-identity.test.ts — a failing up step's event and printed error carry the command's stderr", async () => {
  const { root, configHome, git, run } = await scratchRepository('stderr');
  await onboardingFiles(root);
  // The publish fetches from an origin that is not a git repository, so a git child of the
  // onboarding step fails with stderr of its own.
  git('remote', 'set-url', 'origin', join(root, 'not-a-repository'));
  const events: UpEvent[] = [];
  const deps: UpDependencies = {
    root, emit: event => events.push(event), now: () => 0, sleep: async () => {},
    serverUrl: async () => 'http://127.0.0.1:4310', masterToken: async () => 'm'.repeat(40), status: async () => null,
    gh: async () => ({ code: 0, stdout: '', stderr: '' }), git: async () => ({ code: 0, stdout: '', stderr: '' }),
    ensureDeployKey: async () => 'deploy key registered', operatorToken: async () => 'a'.repeat(40),
    cli: async () => ({ code: 0, stdout: '{}' }),
    publishOnboarding: async () => withConfigHome(configHome, () => publishOnboarding(root, 'owner/scratch-up-preflight', run)),
  };
  const result = await runUp({ repository: 'owner/scratch-up-preflight', provider: 'compose', agent: true, master: 'claude' }, deps);
  assert.equal(result.ok, false, 'the onboarding step fails on the unreachable origin');
  const failed: any = events.find(event => event.kind === 'step-failed' && event.step === 'onboarding');
  assert.ok(failed, `the onboarding step failed: ${JSON.stringify(events)}`);
  const complaint = /does not appear to be a git repository|Could not read from remote repository/;
  assert.match(String(failed.stderr), complaint, 'the event carries the command\'s stderr');
  assert.match(failed.detail, complaint, 'the printed error carries it');
  assert.match(describeUpEvent(failed), complaint, 'the line the operator reads carries it');
  assert.match(result.next, complaint, 'the run\'s closing error carries it');
  assert.ok(Array.isArray(failed.argv) && failed.argv.join(' ').startsWith('git'), `the event names the failed command: ${JSON.stringify(failed.argv)}`);
});
