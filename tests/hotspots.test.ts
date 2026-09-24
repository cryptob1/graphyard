import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { commands, renderHelp } from '../src/cli/index.js';
import { apiRoutes, publicRoutes } from '../src/server/index.js';
import { staticRoutes } from '../src/server/static.js';
import type { RouteModule } from '../src/server/routes.js';
import { ledgerOrder, ledgerSequences, ledgerTables, migration, tables } from '../src/store.js';
import { views } from '../web/pages/index.js';

// GY-56: the files every feature used to edit are now thin assemblers over registries.
// This suite fails when one of them grows back, or when a command, route, table or page
// is added outside the registry that the assembler reads.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFile(join(root, path), 'utf8');
const list = async (directory: string, extension: string) => (await readdir(join(root, directory))).filter(name => name.endsWith(extension)).sort();
const lines = (text: string) => text.split('\n').length;

// Line and byte budgets. A thin assembler stays a page; the modules it assembles stay
// readable. Raise a budget only with a matching split, never to make a growth pass.
const budgets: Record<string, { lines: number; bytes: number }> = {
  'src/cli.ts': { lines: 12, bytes: 800 },
  'src/server.ts': { lines: 12, bytes: 1_000 },
  'src/model.ts': { lines: 24, bytes: 1_200 },
  'src/store.ts': { lines: 12, bytes: 800 },
  'src/cli/index.ts': { lines: 70, bytes: 4_000 },
  'src/server/index.ts': { lines: 150, bytes: 10_000 },
  'web/main.tsx': { lines: 100, bytes: 10_000 },
  'docs/protocol.md': { lines: 40, bytes: 4_000 },
  'docs/README.md': { lines: 80, bytes: 6_000 },
};
const moduleBudget = { lines: 320, bytes: 28_000 };
const moduleDirectories = ['src/cli', 'src/server', 'src/server/routes', 'src/model', 'src/store', 'src/store/tables', 'web/pages', 'web/components'];

test('unit:hotspot-registry — the former hotspot files stay within their size budgets', async () => {
  for (const [file, budget] of Object.entries(budgets)) {
    const text = await read(file);
    assert.ok(lines(text) <= budget.lines, `${file} has ${lines(text)} lines; budget ${budget.lines}. Move the growth into a module under its registry`);
    assert.ok(text.length <= budget.bytes, `${file} is ${text.length} bytes; budget ${budget.bytes}`);
  }
  for (const directory of moduleDirectories) {
    for (const name of await list(directory, '.ts')) {
      const text = await read(`${directory}/${name}`);
      assert.ok(lines(text) <= moduleBudget.lines && text.length <= moduleBudget.bytes, `${directory}/${name} exceeds the module budget (${lines(text)} lines, ${text.length} bytes); split it by concern`);
    }
  }
  for (const name of await list('docs/protocol', '.md')) assert.ok(lines(await read(`docs/protocol/${name}`)) <= 120, `docs/protocol/${name} exceeds 120 lines; split the topic`);
});

test('unit:hotspot-registry — every CLI command module is registered and the help text is generated from the registry', async () => {
  const names = commands.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, 'command names are unique');
  for (const entry of commands) {
    if (entry.help.length) assert.ok(entry.help[0].startsWith(`  ${entry.name} `) || entry.help[0].startsWith(`  ${entry.name}\n`) || entry.help[0].trimStart().startsWith(entry.name), `${entry.name}: the first help line names the command`);
    assert.equal(typeof entry.run, 'function');
  }
  const help = renderHelp();
  for (const entry of commands) for (const line of entry.help) assert.ok(help.includes(line), `help prints ${entry.name}`);
  // Every module that defines commands is listed by the index; a module added beside the
  // registry without being registered is unreachable, and this is where that is caught.
  const index = await read('src/cli/index.ts');
  for (const name of await list('src/cli', '.ts')) {
    if (!(await read(`src/cli/${name}`)).includes('defineCommands(')) continue;
    const exported = Object.values(await import(join(root, 'src/cli', name)) as Record<string, unknown>).filter(Array.isArray).flat();
    assert.ok(exported.length, `src/cli/${name} exports its command list`);
    for (const entry of exported) assert.ok(commands.includes(entry), `src/cli/index.ts lists ${entry.name} from ${name} in the registry`);
  }
  assert.doesNotMatch(index.replace(/command === '(help|--help)'/g, ''), /command === '/, 'src/cli/index.ts dispatches through the registry, not through command literals');
  assert.doesNotMatch(await read('src/cli.ts'), /process\.argv|parseArgs|=== '/, 'src/cli.ts is an entry point only');
});

test('unit:hotspot-registry — every route module is registered and the route table is generated from the registry', async () => {
  const modules: RouteModule[] = [...publicRoutes, ...apiRoutes, staticRoutes];
  const seen = new Set<string>();
  for (const module of modules) for (const route of module.routes) {
    assert.ok(['GET', 'POST', '*'].includes(route.method), `${module.name}: method ${route.method}`);
    assert.equal(typeof route.handle, 'function', `${module.name}: handler`);
    const key = `${route.method} ${String(route.path)}`;
    assert.ok(!seen.has(key), `${module.name}: duplicate route ${key}`);
    seen.add(key);
  }
  const index = await read('src/server/index.ts');
  for (const name of await list('src/server/routes', '.ts')) {
    const exported = Object.values(await import(join(root, 'src/server/routes', name)) as Record<string, RouteModule>).filter(value => value && Array.isArray(value.routes));
    assert.ok(exported.length, `src/server/routes/${name} exports its route module`);
    for (const module of exported) assert.ok(modules.includes(module), `src/server/index.ts lists ${module.name} from ${name} in a route table`);
  }
  assert.doesNotMatch(index, /pathname === '|pathname\.match\(/, 'src/server/index.ts matches routes through the table, not through path literals');
  assert.doesNotMatch(await read('src/server.ts'), /createServer|pathname/, 'src/server.ts is an entry point only');
});

test('unit:hotspot-registry — the ledger backup table list is derived from the store registry', async () => {
  const created = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(match => match[1]);
  const caches = tables.filter(table => table.cache).map(table => table.name);
  assert.deepEqual(ledgerTables, created.filter(name => !caches.includes(name)), 'every table the migration creates is a ledger table or a declared cache, in migration order');
  assert.equal(new Set(ledgerTables).size, ledgerTables.length, 'table names are unique');
  for (const table of tables) assert.ok(ledgerOrder[table.name], `${table.name} declares an export order`);
  for (const { table, column } of ledgerSequences) assert.match(migration, new RegExp(`${table}[\\s\\S]*${column} bigserial`), `${table}.${column} is a serial column`);
  assert.ok(migration.indexOf('CREATE OR REPLACE FUNCTION graphyard_immutable()') < migration.indexOf('EXECUTE FUNCTION graphyard_immutable()'), 'the append-only trigger function precedes its first use');
  // Every table module is spread into the registry; a table defined beside it is not in
  // the migration and never reaches a backup, so it is refused here.
  for (const name of await list('src/store/tables', '.ts')) {
    const exported = Object.values(await import(join(root, 'src/store/tables', name)) as Record<string, unknown>).filter((value): value is { name: string } => !!value && typeof value === 'object' && !Array.isArray(value) && 'ddl' in value);
    assert.ok(exported.length, `src/store/tables/${name} defines its tables with defineTable`);
    for (const table of exported) assert.ok(tables.includes(table as (typeof tables)[number]), `src/store/schema.ts lists ${table.name} from ${name} in the registry`);
  }
});

test('unit:hotspot-registry — dashboard pages are registered and the sidebar is generated from the view registry', async () => {
  const ids = views.map(view => view.id);
  assert.equal(new Set(ids).size, ids.length, 'view ids are unique');
  for (const view of views) { assert.ok(view.icon && view.label, `${view.id} has an icon and a label`); assert.equal(typeof view.render, 'function'); }
  const main = await read('web/main.tsx');
  assert.doesNotMatch(main, /view === '/, 'web/main.tsx selects the page through the registry, not through view literals');
  assert.match(main, /views\.map\(/, 'the sidebar is generated from the registry');
  const registry = await read('web/pages/index.tsx');
  for (const name of await list('web/pages', '.tsx')) {
    if (['index.tsx', 'login.tsx', 'work-details.tsx', 'create-work.tsx'].includes(name)) continue;
    assert.ok(registry.includes(`from './${name.replace(/\.tsx$/, '')}'`), `web/pages/index.tsx registers ${name}`);
  }
});

test('unit:hotspot-registry — the split modules keep control-plane truth independent of the session runtime', async () => {
  for (const directory of ['src/model', 'src/store', 'src/store/tables', 'src/server', 'src/server/routes'])
    for (const name of await list(directory, '.ts')) assert.doesNotMatch(await read(`${directory}/${name}`), /herdr/i, `${directory}/${name}`);
});

test('manual:hotspot-dev-docs — docs indexes are generated and docs/development.md says where new features go', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [join(root, 'scripts/check-docs.mjs')], { cwd: root });
  assert.match(stdout, /generated indexes resolve/);
  for (const file of ['docs/README.md', 'docs/protocol.md']) assert.match((await read(file)).split('\n').slice(0, 2).join('\n'), /<!-- generated by scripts\/check-docs\.mjs/, `${file} is generated in full`);
  for (const name of await list('docs/protocol', '.md')) assert.match(await read(`docs/protocol/${name}`), /^<!-- page: Agent protocol \| \d+ \| .+ -->/, `docs/protocol/${name} declares its index entry`);
  const development = await read('docs/development.md');
  for (const fragment of ['src/cli/', 'src/server/routes/', 'src/model/', 'src/store/tables/', 'web/pages/', 'docs/protocol/', 'docs:check', 'Where a new feature goes', 'size budget'])
    assert.ok(development.includes(fragment), `docs/development.md must mention ${fragment}`);
});
