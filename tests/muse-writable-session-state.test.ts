import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialMaskFor, type MaskProbe } from '../src/master/confinement.js';
import { sessionConfinement } from '../src/master/launch.js';
import { runtimeLoginHomes } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3303: hwd-backend's Muse sessions exited at once — "failed to create session lock directory
// for session …: Read-only file system" — because the confinement kept the host's XDG data
// directory, where Muse locks and writes its sessions, read-only (and replaced HOME, so without
// XDG variables Muse wrote into throwaway scratch). Under real bubblewrap, through the launcher's
// own confinement for a worker and a reviewer, a stand-in Muse now creates, locks and persists its
// session under the selected account's XDG data directory — default, inherited explicit, and the
// account home on the data variable — while unrelated host directories stay unwritable and
// another account stays unreadable.

const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A stand-in Muse: locks its session directory under XDG data and its settings lock under XDG config, as Muse does, then probes what else it can reach. */
const fakeMuse = [
  '#!/bin/sh',
  'data="${XDG_DATA_HOME:-$HOME/.local/share}/muse" config="${XDG_CONFIG_HOME:-$HOME/.config}/muse"',
  'session="$data/sessions/s-1"',
  'mkdir -p "$session" 2>/dev/null && mkdir "$session/writer.lock" 2>/dev/null || { echo "failed to create session lock directory for session s-1: Read-only file system (os error 30)" >&2; exit 1; }',
  'echo "muse state" > "$session/state.json" && mkdir -p "$config" && : > "$config/.settings.json.lock" || exit 1',
  'echo MUSE-STARTED',
  'shift 0; for p in "$@"; do case "$p" in write:*) if (: > "${p#write:}") 2>/dev/null; then echo "WRITABLE ${p#write:}"; else echo "UNWRITABLE ${p#write:}"; fi;; read:*) if test -r "${p#read:}"; then echo "READABLE ${p#read:}"; else echo "DENIED ${p#read:}"; fi;; esac; done',
].join('\n');

test('e2e:muse-writable-session-state — a confined Muse worker and reviewer lock and persist their session under the account\'s XDG data directory (default, explicit, account home), while unrelated host directories stay unwritable and another account unreadable', async () => {
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  // The fixture HOME lives in this checkout, not the host's tmpdir, which the sandbox replaces.
  const home = await temporaryDirectory('muse-session-home', join(checkout, '.graphyard'));
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME; delete process.env.XDG_CONFIG_HOME;
  try {
    const root = join(home, 'code', 'project');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
    const worktree = join(root, '.graphyard', 'worktrees', 'gy-1-1'), reviewCheckout = join(home, 'managed', 'review-gy-1');
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree, 'main');
    mkdirSync(reviewCheckout, { recursive: true });
    const muse = join(home, 'bin', 'muse');
    mkdirSync(dirname(muse), { recursive: true });
    writeFileSync(muse, `${fakeMuse}\n`); chmodSync(muse, 0o755);
    // Unrelated host state beside the account's, and another account's home with its own Muse state.
    const unrelated = join(home, '.local', 'share', 'other-app'), explicitData = join(home, 'xdg', 'data'), explicitConfig = join(home, 'xdg', 'config');
    const ownAccount = join(home, '.coding_agents', 'muse-a'), otherAccount = join(home, '.coding_agents', 'muse-b');
    for (const directory of [unrelated, join(explicitData, 'other-app'), ownAccount, join(otherAccount, 'muse')]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(otherAccount, 'muse', 'session-index.db'), 'other account\n');
    const config = { environments: [{ home: ownAccount }, { home: otherAccount }] };
    const probes = [`write:${join(unrelated, 'x')}`, `write:${join(explicitData, 'other-app', 'x')}`, `write:${join(home, 'notes.txt')}`, `read:${join(otherAccount, 'muse', 'session-index.db')}`, `write:${join(otherAccount, 'muse', 'x')}`];

    const launches = [
      { name: 'worker, default XDG paths', role: 'worker', environment: {} as Record<string, string>, homeVariable: null, data: join(home, '.local', 'share'), config: join(home, '.config') },
      { name: 'reviewer, explicit XDG paths', role: 'reviewer', environment: { XDG_DATA_HOME: explicitData, XDG_CONFIG_HOME: explicitConfig }, homeVariable: null, data: explicitData, config: explicitConfig },
      { name: 'worker, account home on XDG_DATA_HOME', role: 'worker', environment: { XDG_DATA_HOME: ownAccount }, homeVariable: 'XDG_DATA_HOME', data: ownAccount, config: join(home, '.config') },
    ];
    for (const launch of launches) {
      rmSync(join(launch.data, 'muse'), { recursive: true, force: true });
      // The mask and confinement the worker dispatch and the reviewer launch build for this account.
      const credentialMask = credentialMaskFor(config, { credentialFile: null, runtimeHomes: runtimeLoginHomes(launch.environment, launch.homeVariable, 'muse') });
      const directory = launch.role === 'worker' ? worktree : reviewCheckout;
      const confinement = await sessionConfinement('muse', ['--approval-mode', 'never', '--trust-workspace'],
        { directory, cwd: directory, environment: launch.environment, ...(launch.role === 'worker' ? { secretsBus: null } : { ownGitHubCredential: true }), credentialMask, maskProbe: hostProbe }, root);
      assert.ok(confinement, launch.name);
      const ran = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1), muse, ...probes],
        { cwd: directory, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env, ...launch.environment } });
      const output = `${ran.stdout}\n${ran.stderr}`;
      assert.equal(ran.status, 0, `${launch.name}: Muse starts: ${output}`);
      assert.ok(ran.stdout.includes('MUSE-STARTED'), `${launch.name}: ${output}`);
      // Its state persists to the account, not to the sandbox's scratch.
      assert.equal(readFileSync(join(launch.data, 'muse', 'sessions', 's-1', 'state.json'), 'utf8'), 'muse state\n', `${launch.name}: session state persisted`);
      assert.ok(existsSync(join(launch.data, 'muse', 'sessions', 's-1', 'writer.lock')), `${launch.name}: session lock persisted`);
      assert.ok(existsSync(join(launch.config, 'muse', '.settings.json.lock')), `${launch.name}: settings lock persisted`);
      for (const probe of probes) {
        const path = probe.slice(probe.indexOf(':') + 1);
        assert.ok(ran.stdout.includes(`${probe.startsWith('read:') ? 'DENIED' : 'UNWRITABLE'} ${path}\n`), `${launch.name}: ${path} stays out of reach: ${output}`);
      }
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(home, { recursive: true, force: true });
  }
});
