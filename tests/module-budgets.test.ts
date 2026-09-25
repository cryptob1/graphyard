import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GY-177: almost every loop change touched src/master-daemon.ts, src/master.ts and
// src/cli/master.ts, so small items overlapped on planned files and could not run in parallel.
// Each is now split into modules that own one concern; the original paths re-export them.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFile(join(root, path), 'utf8');
const lines = (text: string) => text.split('\n').length;
const lineBudget = 800;
const split = [
  { original: 'src/master-daemon.ts', directory: 'src/daemon' },
  { original: 'src/master.ts', directory: 'src/master' },
  { original: 'src/cli/master.ts', directory: 'src/cli/master' },
];
const modules = async (directory: string) => (await readdir(join(root, directory))).filter(name => name.endsWith('.ts')).sort().map(name => `${directory}/${name}`);

test('unit:module-budgets — the split master, daemon and master CLI modules each stay within 800 lines', async () => {
  for (const { original, directory } of split) {
    assert.ok((await stat(join(root, directory))).isDirectory(), `${directory} holds the modules split out of ${original}`);
    const files = await modules(directory);
    assert.ok(files.length >= 2, `${original} is split into modules under ${directory}`);
    for (const file of [original, ...files]) {
      const count = lines(await read(file));
      assert.ok(count <= lineBudget, `${file} has ${count} lines; the budget is ${lineBudget}. Split it by concern rather than raising the bound`);
    }
  }
});

test('unit:module-budgets — every split module names the one concern it owns in its header comment', async () => {
  for (const { directory } of split) for (const file of await modules(directory)) {
    const header = (await read(file)).split('\n')[0];
    assert.match(header, /^\/\/ Concern: \S.{10,}$/, `${file} opens with a "// Concern: …" header naming what it owns`);
  }
});

test('unit:module-budgets — the original paths re-export the split modules, so every existing import keeps working', async () => {
  // The library barrels hold nothing but comments and re-exports.
  for (const original of ['src/master-daemon.ts', 'src/master.ts']) {
    const code = (await read(original)).split('\n').filter(line => line.trim() && !line.startsWith('//'));
    for (const line of code) assert.match(line, /^export (type )?\{[^}]*\} from '\.[^']+';$/, `${original} only re-exports: ${line.slice(0, 120)}`);
  }
  const daemon = await import('../src/master-daemon.js');
  for (const name of ['runCycle', 'runDaemon', 'daemonEffects', 'emptyDaemonState', 'readDaemonState', 'retriedSnapshot', 'observeDeployment', 'approvalStep', 'loopLiveness', 'scopeBudget'])
    assert.equal(typeof (daemon as Record<string, unknown>)[name], 'function', `src/master-daemon.ts still exports ${name}`);
  const master = await import('../src/master.js');
  for (const name of ['loadMasterConfig', 'dispatchWork', 'mergeExecutor', 'buildMasterStatus', 'launchApprover', 'runAutonomyCommand', 'selectAccount', 'startAgentSession', 'reclaimWorktrees', 'verifyContainmentDeath', 'listHerdrAgents', 'workerHarnessPlan'])
    assert.equal(typeof (master as Record<string, unknown>)[name], 'function', `src/master.ts still exports ${name}`);
  assert.ok('parse' in master.masterConfigSchema, 'src/master.ts still exports masterConfigSchema');
  const cli = await import('../src/cli/master.js');
  assert.ok(cli.masterCommands.some(command => command.name === 'master'), 'src/cli/master.ts still registers the master command');
  assert.equal(typeof cli.cycleBudget, 'function');
});
