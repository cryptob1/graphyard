import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { ChildRun } from '../src/child-runner.js';
import { watchPorts } from '../src/cli/upgrade.js';
import { pinKnownGood } from '../src/master/known-good.js';
import { acquireVerificationSlot, declarationSlot, gateSlot, heldSlots, requestHeavyDrain, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3450 (AC-4): on 2026-11-17 the deploy build of 3b9606c4, verified 19:52Z, waited 30 minutes
// behind merge trials GY-3448, GY-3447 and others. The deploy build and restart of a gate-verified
// commit take the deploy path's reserved slot and never wait behind item work or a drain.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const modules = resolve(createRequire(import.meta.url).resolve('tsx'), '../../..');
const saved = { slots: process.env[slotsDirectoryVariable], home: process.env.GRAPHYARD_CONFIG_HOME, database: process.env.DATABASE_URL };
after(() => {
  for (const [name, value] of [[slotsDirectoryVariable, saved.slots], ['GRAPHYARD_CONFIG_HOME', saved.home], ['DATABASE_URL', saved.database]] as const)
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
});

/** Runs `job` with a 3-second deadline: a deploy step that waits for an ordinary slot never finishes. */
const promptly = <T>(what: string, job: Promise<T>) => Promise.race([job, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} waited behind item work`)), 3_000))]);

test('integration:deploy-uses-reserved-slot — with both ordinary slots held by a merge trial and a worker verification and a drain set, the deploy build, the restart and the coordinator pin build run at once in the reserved slot', { timeout: 60_000 }, async () => {
  const base = await temporaryDirectory('deploy-reserved-slot');
  const slots = join(base, 'heavy-jobs'), home = join(base, 'config'), cli = join(base, 'cli');
  await mkdir(slots, { recursive: true }); await writeFile(join(slots, 'limit'), '2\n');
  process.env[slotsDirectoryVariable] = slots;
  process.env.GRAPHYARD_CONFIG_HOME = home;
  delete process.env.DATABASE_URL;
  await mkdir(join(home, 'owner-project'), { recursive: true });
  await writeFile(join(home, 'owner-project', 'install.json'), JSON.stringify({ version: 1, installId: 'owner-project', repository: 'owner/project', provider: 'compose', baseBranch: 'main', createdAt: 'now', updatedAt: 'now' }));
  await mkdir(cli);
  await writeFile(join(cli, 'package.json'), '{}');
  await writeFile(join(cli, '.gitignore'), 'node_modules/\n.graphyard/\n');
  git(cli, 'init', '-q', '-b', 'main'); git(cli, 'add', '.'); git(cli, 'commit', '-q', '-m', 'verified');
  const commit = git(cli, 'rev-parse', 'HEAD');

  const trial = await acquireVerificationSlot({ directory: slots, label: 'test merge GY-3448' });
  const verification = await acquireVerificationSlot({ directory: slots, label: 'worker verification GY-3447' });
  requestHeavyDrain(slots, 'quiet window', 'graphyard-master');

  // Who held which slot while each deploy step ran.
  const seen: { step: string; reserved: string | undefined }[] = [];
  const reservedHolder = () => heldSlots(slots).find(entry => entry.slot === gateSlot)?.owner?.label;
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') {
      seen.push({ step: `npm ${args[0]}`, reserved: reservedHolder() });
      const cwd = options!.cwd!;
      if (args[0] === 'ci' && !existsSync(join(cwd, 'node_modules'))) await symlink(modules, join(cwd, 'node_modules'));
      if (args[0] === 'run') { await mkdir(join(cwd, 'dist'), { recursive: true }); await writeFile(join(cwd, 'dist', 'cli.js'), '// built\n'); }
      return '';
    }
    if (command === process.execPath && args.includes('install')) { seen.push({ step: `install ${args.includes('--plan') ? 'plan' : 'apply'}`, reserved: reservedHolder() }); return ''; }
    return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd, env });
  };

  const ports = await watchPorts({ cliRoot: cli, repoRoot: cli, repository: 'owner/project', url: 'http://127.0.0.1:1', run });
  if (typeof ports === 'string') throw new Error(ports);
  await promptly('the deploy build', ports.build(commit));
  await promptly('the deploy restart', ports.restart(commit));
  await promptly('the coordinator pin build', pinKnownGood({ installDir: join(home, 'owner-project'), repository: cli }, commit, run));

  const short = commit.slice(0, 12);
  assert.deepEqual(seen, [
    { step: 'npm ci', reserved: `deploy build ${short}` },
    { step: 'install plan', reserved: `deploy restart ${short}` },
    { step: 'install apply', reserved: `deploy restart ${short}` },
    { step: 'npm ci', reserved: `deploy build ${short}` },
    { step: 'npm run', reserved: `deploy build ${short}` },
  ], 'every deploy step ran in the reserved slot');
  assert.deepEqual(heldSlots(slots).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label).sort(), ['test merge GY-3448', 'worker verification GY-3447'], 'the reserved slot is free again; the item work kept its slots');
  trial.release(); verification.release();
});
