import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3367: the batch gate's check test:browser-tests/master-page-compose-install.spec.ts timed out once
// and passed its re-run. The spec boots an embedded Postgres (10 s on a loaded host), forks the server and
// signs in, all inside Playwright's 30 s default, while every other database-booting spec carries its own
// budget. Every browser spec that boots a database now sets one of at least 60 s.
const root = process.cwd();

test('unit:test-browser-tests-master-page-compose-install-spec-ts-pinned — every browser spec that boots a database, master-page-compose-install included, carries a budget of at least 60 s', () => {
  const specs = readdirSync(join(root, 'browser-tests')).filter(name => name.endsWith('.spec.ts'))
    .map(name => ({ name, spec: readFileSync(join(root, 'browser-tests', name), 'utf8') }))
    .filter(({ spec }) => /signInDatabase\(\)|databaseUrl\(/.test(spec));
  assert.ok(specs.some(({ name }) => name === 'master-page-compose-install.spec.ts'), 'master-page-compose-install boots a database');
  for (const { name, spec } of specs) {
    const budgets = [...spec.matchAll(/test\.setTimeout\((\d[\d_]*)\)/g)].map(match => Number(match[1]!.replace(/_/g, '')));
    assert.ok(budgets.length > 0 && budgets.every(ms => ms >= 60_000), `${name} boots a database and sets test.setTimeout of at least 60 s (found ${budgets.join(', ') || 'none'})`);
  }
});

// The same trial then failed one-click-team-access: each retry reloaded the page and allowed its synced
// data one second to appear, which a loaded host never met. GY-3412 gave each reload poll 5 s; this pins
// that no poll falls back to one second.
test('unit:test-browser-tests-master-page-compose-install-spec-ts-pinned — one-click-team-access never gives a reload a one-second check', () => {
  const spec = readFileSync(join(root, 'browser-tests', 'one-click-team-access.spec.ts'), 'utf8');
  assert.doesNotMatch(spec, /reload\([^)]*\);[^\n]*\{ timeout: 1_000 \}/, 'no reload followed by a one-second check');
});
