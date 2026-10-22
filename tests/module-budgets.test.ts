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

// Advisory, never failing (GY-1786 AC-2): the budgeted modules within 50 lines of the bound, named
// in the report so the next approach to the bound is visible before an item pays a rework round to
// split. A module listed here is the next mechanical housekeeping item; add nothing to it.
test('unit:module-budgets-advisory-listing — every budgeted module within 50 lines of the bound is reported', async t => {
  const near: string[] = [];
  for (const { original, directory } of split) {
    for (const file of [original, ...await modules(directory)]) {
      const count = lines(await read(file));
      if (count >= lineBudget - 50) near.push(`${file} at ${count}/${lineBudget}`);
    }
  }
  const report = near.length
    ? `Approaching the ${lineBudget}-line bound (within 50 lines, plan a split by concern before an item is made to pay for one): ${near.join('; ')}`
    : `No budgeted module is within 50 lines of the ${lineBudget}-line bound`;
  t.diagnostic(report);
  assert.ok(true, report);
});

// GY-1786 AC-1: the eight loop modules that sat one line under the 800-line bound hold at least
// 100 lines of headroom each, split by one concern per new module — every new module opens with a
// `// Concern:` header naming it, and the original path re-exports what it exported before, so no
// import changed and no behaviour moved.
const headroomBound = 700;
const headroomModules = [
  'src/master/worktrees.ts', 'src/master/environments.ts', 'src/master/profiles.ts',
  'src/daemon/state.ts', 'src/daemon/effects.ts', 'src/daemon/decisions.ts',
  'src/daemon/doctor.ts',
];
const headroomSplits: Record<string, string[]> = {
  'src/master/worktrees.ts': ['src/master/branch-release.ts'],
  'src/master/environments.ts': ['src/master/environment-quota.ts'],
  'src/master/profiles.ts': ['src/master/confinement.ts'],
  'src/daemon/state.ts': ['src/daemon/state-cursor.ts'],
  'src/daemon/effects.ts': ['src/daemon/effects-production.ts'],
  'src/daemon/decisions.ts': ['src/daemon/decision-text.ts'],
  'src/daemon/doctor.ts': ['src/daemon/remedies.ts'],
};
test('unit:module-budgets-headroom — every recently-full loop module keeps 100 lines of headroom under the bound', async () => {
  for (const file of headroomModules) {
    const count = lines(await read(file));
    assert.ok(count <= headroomBound, `${file} has ${count} lines; its headroom bound is ${headroomBound} so an item that touches it never pays a split round. Split it by concern`);
    for (const module of headroomSplits[file] ?? []) {
      const text = await read(module);
      assert.match(text.split('\n')[0], /^\/\/ Concern: \S.{10,}$/, `${module} opens with a "// Concern: …" header naming the one concern it took out of ${file}`);
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
  for (const name of ['runCycle', 'runDaemon', 'daemonEffects', 'emptyDaemonState', 'readDaemonState', 'retriedSnapshot', 'observeDeployment', 'approvalStep', 'loopLiveness'])
    assert.equal(typeof (daemon as Record<string, unknown>)[name], 'function', `src/master-daemon.ts still exports ${name}`);
  const master = await import('../src/master.js');
  for (const name of ['loadMasterConfig', 'dispatchWork', 'buildMasterStatus', 'launchApprover', 'runAutonomyCommand', 'selectAccount', 'startAgentSession', 'reclaimWorktrees', 'verifyContainmentDeath', 'listHerdrAgents', 'workerHarnessPlan'])
    assert.equal(typeof (master as Record<string, unknown>)[name], 'function', `src/master.ts still exports ${name}`);
  assert.ok('parse' in master.masterConfigSchema, 'src/master.ts still exports masterConfigSchema');
  const cli = await import('../src/cli/master.js');
  assert.ok(cli.masterCommands.some(command => command.name === 'master'), 'src/cli/master.ts still registers the master command');
  assert.equal(typeof cli.cycleBudget, 'function');
});
