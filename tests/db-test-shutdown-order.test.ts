import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// GY-483: a DB test that stops its embedded Postgres before its store's close() resolves can
// terminate a live pool client, which fails the run about one time in eight. This scans every test's
// after hooks and finally blocks: where one stops the database, each store the block can reach must
// be closed with an awaited close() before the stop, never by pool.end() alone or alongside it.

const directory = join(import.meta.dirname);

/** Each after hook or finally block that stops a database, up to and including its stop() call. */
function shutdownViolations(file: string, source: string) {
  const databases = [...source.matchAll(/(\w+)\s*=\s*new EmbeddedPostgres\(/g)].map(match => match[1]);
  if (!databases.length || !/new Store\(/.test(source)) return [];
  // Stores whose lifetime spans the file: module-scope declarations typed or assigned as Store.
  const moduleStores = [...source.matchAll(/^(?:let|const|var)\s+([^;=\n]*)/gm)]
    .flatMap(match => match[1].split(',').map(part => part.trim()))
    .filter(part => /:\s*Store\b/.test(part)).map(part => ({ name: part.split(/[\s:]/)[0], many: /Store\s*\[\]/.test(part) }));
  const localStores = new Set([...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*new Store\(/g)].map(match => match[1]));
  const violations: string[] = [];
  const stop = new RegExp(`\\b(${databases.join('|')})\\??\\.stop\\(\\)`, 'g');
  for (const match of source.matchAll(stop)) {
    const at = match.index!, line = source.slice(0, at).split('\n').length;
    const opener = Math.max(source.lastIndexOf('after(', at), source.lastIndexOf('finally', at));
    if (opener < 0) continue;
    const kind = source.startsWith('after(', opener) ? 'after' : 'finally';
    const block = source.slice(opener, at);
    const where = `${file}:${line}`;
    if (/Promise\.all(Settled)?\(\[[^\]]*$/.test(block)) violations.push(`${where}: stops the database alongside other shutdown work instead of after it`);
    const required = [
      ...(kind === 'after' ? moduleStores : []),
      // A finally block (or hook) that mentions a store is responsible for closing it.
      ...[...localStores, ...moduleStores.map(store => store.name)].filter(name => new RegExp(`\\b${name}\\b`).test(block)).map(name => ({ name, many: moduleStores.some(store => store.name === name && store.many) })),
    ];
    for (const { name, many } of new Map(required.map(store => [store.name, store])).values()) {
      const closed = many
        ? new RegExp(`of\\s+${name}\\)\\s*await\\s+\\w+\\??\\.close\\(\\)`).test(block)
        : new RegExp(`await\\s+${name}\\??\\.close\\(\\)`).test(block);
      if (!closed) violations.push(`${where}: stops ${match[1]} without first awaiting ${name}.close()${new RegExp(`\\b${name}\\??\\.pool\\.end\\(`).test(block) ? ' (pool.end() does not wait for its clients to close)' : ''}`);
    }
  }
  return violations;
}

test('unit:db-test-shutdown-order — no DB test stops Postgres before its store has closed', async () => {
  const files = (await readdir(directory)).filter(name => name.endsWith('.test.ts') && name !== 'db-test-shutdown-order.test.ts').sort();
  const violations: string[] = [];
  let scanned = 0;
  for (const name of files) {
    const source = await readFile(join(directory, name), 'utf8');
    if (/new EmbeddedPostgres\(/.test(source) && /new Store\(/.test(source)) scanned++;
    violations.push(...shutdownViolations(name, source));
  }
  assert.ok(scanned >= 20, `the scan reached the DB tests (${scanned} files)`);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('unit:db-test-shutdown-order — the scan flags each unsafe shutdown shape', () => {
  const header = "import EmbeddedPostgres from 'embedded-postgres';\nlet database: EmbeddedPostgres, store: Store;\nbefore(() => { database = new EmbeddedPostgres({}); store = new Store(url); });\n";
  const flagged = (hook: string) => shutdownViolations('probe.test.ts', header + hook);
  assert.deepEqual(flagged('after(async () => { await store?.close(); await database?.stop(); });'), []);
  assert.deepEqual(flagged('after(async () => { if (store) await store.close(); if (database) await database.stop(); });'), []);
  assert.match(flagged('after(async () => { await store?.pool.end(); await database?.stop(); });').join(), /without first awaiting store\.close\(\) \(pool\.end\(\)/);
  assert.match(flagged('after(async () => { store.close(); await database.stop(); });').join(), /without first awaiting store\.close\(\)/);
  assert.match(flagged('after(async () => { await database.stop(); await store.close(); });').join(), /without first awaiting/);
  assert.match(flagged('after(async () => { await database.stop(); });').join(), /without first awaiting store\.close\(\)/);
  assert.match(flagged('after(async () => { await Promise.all([store.close(), database.stop()]); });').join(), /alongside/);
  const local = "import EmbeddedPostgres from 'embedded-postgres';\ntest('x', async () => { const database = new EmbeddedPostgres({}); const store = new Store(url);\n";
  assert.deepEqual(shutdownViolations('probe.test.ts', local + '  try {} finally { await store.close(); await database.stop(); } });'), []);
  assert.match(shutdownViolations('probe.test.ts', local + '  try {} finally { store.close(); await database.stop(); } });').join(), /without first awaiting store\.close\(\)/);
  const many = "let database: EmbeddedPostgres;\nconst stores: Store[] = [];\nbefore(() => { database = new EmbeddedPostgres({}); stores.push(new Store(url)); });\n";
  assert.deepEqual(shutdownViolations('probe.test.ts', many + 'after(async () => { for (const store of stores) await store.close().catch(() => {}); await database.stop(); });'), []);
  assert.match(shutdownViolations('probe.test.ts', many + 'after(async () => { await database.stop(); });').join(), /stores\.close/);
});
