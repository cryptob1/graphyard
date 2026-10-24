import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runUp, type UpDependencies, type UpEvent, type UpRequest } from '../src/up.js';
import { buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { harness } from './install-harness.js';

// GY-2940: a fresh install could merge nothing because `up` created the repository with
// `gh repo create --source . --push`, which leaves `origin` at gh's https url — one the merge
// writer's SSH deploy key cannot push with — and install preflight did not look at it. `up` now
// sets origin to `git@github.com:OWNER/REPO.git` right after creating, and a control-plane
// install preflight refuses any other origin naming that exact set-url command.

const SERVER = 'http://127.0.0.1:4310';
const request = (): UpRequest => ({ repository: 'owner/project', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', browserProfile: null, merger: 'control-plane' });

/** A git host answering `remote` reads from memory, as a checkout would. */
function gitHost() {
  const host = { url: null as string | null, calls: [] as string[][] };
  const git = async (args: string[]) => {
    host.calls.push(args);
    if (args[0] === 'remote' && args[1] === 'set-url') { host.url = args[3] ?? null; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'remote' && args[1] === 'get-url') return { code: host.url === null ? 1 : 0, stdout: host.url ?? '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { host, git };
}

test('unit:up-sets-ssh-origin — up\'s repository creation leaves origin at git@github.com:OWNER/REPO.git, replacing the https url gh repo create set', async () => {
  const root = await temporaryDirectory('up-ssh-origin');
  const events: UpEvent[] = [];
  const { host, git } = gitHost();
  const deps: UpDependencies = {
    root, emit: event => events.push(event), now: () => 0, sleep: async () => {},
    serverUrl: async () => SERVER, masterToken: async () => 'm'.repeat(40), status: async () => null,
    publishOnboarding: async () => null, onboardingMerged: async () => true,
    cli: async args => args.includes('--plan')
      ? { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] }) }
      : { code: 1, stdout: '', stderr: 'the run stops here; the origin is already set' },
    gh: async args => {
      if (args[0] === 'repo' && args[1] === 'view') return { code: 1, stdout: '', stderr: 'not found' };
      if (args[0] === 'repo' && args[1] === 'create') {
        // gh's own behaviour: `--source . --push` adds origin at its https git protocol url.
        host.url = 'https://github.com/owner/project.git';
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    git,
  };
  // The run stops at control-plane (the fake install --apply exits 1); the origin is already set by then.
  const result = await runUp(request(), deps);
  assert.equal(result.ok, false);
  assert.equal(host.url, 'git@github.com:owner/project.git', 'origin is the SSH form the deploy key pushes');
  assert.deepEqual(host.calls, [['remote', 'set-url', 'origin', 'git@github.com:owner/project.git']], 'up sets it with the exact set-url command');
  assert.ok(events.some(event => event.kind === 'note' && event.text.includes('git@github.com:owner/project.git')), 'the run says what origin was set');
});

test('unit:up-sets-ssh-origin — install preflight refuses an https origin under the control-plane merger, naming the exact set-url command', async () => {
  const root = await temporaryDirectory('up-ssh-origin-https');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }));
  const fixture = await harness({ provider: 'compose', serverUrl: SERVER, root });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--plan']);
    const plan = await buildPlan(await prepareInstall(fixture.root, request, fixture.deps, 'plan'));
    const check = plan.preflight.find(item => item.name === 'Repository');
    assert.ok(check, 'the plan carries a Repository check');
    assert.equal(check!.ok, false);
    assert.equal(check!.fix, 'git remote set-url origin git@github.com:owner/project.git');
  } finally { await fixture.cleanup(); }
});

test('unit:up-sets-ssh-origin — install preflight passes the SSH origin an earlier run or a hand clone set', async () => {
  const fixture = await harness({ provider: 'compose', serverUrl: SERVER });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--plan']);
    const plan = await buildPlan(await prepareInstall(fixture.root, request, fixture.deps, 'plan'));
    const check = plan.preflight.find(item => item.name === 'Repository');
    assert.ok(check, 'the plan carries a Repository check');
    assert.equal(check!.ok, true, `origin ${await originOf(fixture.root)} is the SSH form`);
  } finally { await fixture.cleanup(); }
});

const originOf = async (root: string) => execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
