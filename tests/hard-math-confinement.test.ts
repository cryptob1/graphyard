import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { credentialMaskFor } from '../src/master/confinement.js';
import { launcherCoordinatorRoot, startAgentSession } from '../src/master/launch.js';
import { runConfinement } from '../src/runner/roles.js';

test('integration:hard-math-smoke — non-CLI native launch denies oracle and authority while retaining only assigned credentials', async () => {
  const base = await temporaryDirectory('hard-math-native-confinement');
  const root = join(base, 'repository'), worktree = join(base, 'assigned');
  const install = join(base, 'install'), oracle = join(base, 'oracle'), source = join(base, 'source-install');
  await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed', '--allow-empty');
  git('worktree', 'add', '-qb', 'assigned', worktree);
  const coordinator = join(install, 'coordinator.token'), producer = join(install, 'producer.token');
  const worker = join(install, 'worker.token'), reviewer = join(install, 'reviewer', 'verdict.token');
  const oracleFile = join(oracle, 'verify.py'), sourceCredential = join(source, 'coordinator.token');
  for (const path of [coordinator, producer, worker, reviewer, oracleFile, sourceCredential]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture-only\n', { mode: 0o600 });
  }
  const config = { credentialFile: coordinator, confinement: { maskPaths: [install, oracle, source] } };
  const argv1 = process.argv[1];
  process.argv[1] = resolve('benchmarks/hard-math/runner.ts');
  try {
    assert.equal(launcherCoordinatorRoot(process.argv[1], false), null, 'documented entry cannot infer the root');
    for (const role of ['worker', 'reviewer'] as const) {
      const own = role === 'worker' ? worker : reviewer;
      const mask = credentialMaskFor(config, { credentialFile: own }, join(base, 'config-home'));
      let typed = '';
      await startAgentSession(`benchmark-${role}`, 'pi', 'pane', [], 'Boundary probe', (_command, args) => {
        if (args[0] === 'pane' && args[1] === 'run') typed = args[3];
        return startedAtOnce(args) ?? '';
      }, { directory: worktree, coordinatorRoot: root, credentialMask: mask, secretsBus: null, log: () => {}, keyringWarning: async () => null });
      const words = expandTypedCommand(typed).words;
      const end = words.indexOf('--');
      assert.ok(end > 0 && words[0].endsWith('bwrap'), 'native session launch actually carries the wrapper');
      check([...words.slice(0, end + 1)], own, role === 'worker' ? reviewer : worker);
    }
    // Headless producers use the same explicit-root path, keeping their own token only.
    const wrapper = runConfinement({ coordinatorRoot: root, credentialMask: credentialMaskFor(config, { credentialFile: producer }, join(base, 'config-home')) });
    assert.ok(wrapper);
    check([...wrapper(worktree, process.env)], producer, worker);
  } finally { process.argv[1] = argv1; }

  function check(wrapper: string[], own: string, other: string) {
    const script = 'for path do if test -r "$path"; then echo readable; else echo denied; fi; done';
    const result = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', script, 'probe', coordinator, oracleFile, sourceCredential, other, own], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'denied\ndenied\ndenied\ndenied\nreadable\n');
    if (own !== producer) {
      const denied = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', 'test ! -r "$1"', 'probe', producer], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(denied.status, 0, denied.stderr);
    }
  }
});
