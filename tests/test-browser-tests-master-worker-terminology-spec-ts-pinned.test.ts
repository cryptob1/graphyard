import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3357: e2e:master-worker-terminology failed once on main and passed its re-run. It opens the
// Master page from the menu, and that page's terminal fetched xterm.js from the live CDN: GY-3261
// served it locally only in specs that open the page by its URL (&master), so the specs reaching it
// through the menu, the palette or a shortcut still depended on the network. Every spec that shows
// the Master page now serves xterm.js locally.
const dir = join(process.cwd(), 'browser-tests');

test('unit:test-browser-tests-master-worker-terminology-spec-ts-pinned — every spec that opens the Master page serves xterm.js locally', () => {
  const specs = readdirSync(dir).filter(name => name.endsWith('.spec.ts')).map(name => ({ name, spec: readFileSync(join(dir, name), 'utf8') }))
    .filter(({ spec }) => spec.includes('&master`') || spec.includes("name: 'Master', exact: true"));
  assert.ok(specs.some(({ name }) => name === 'master-worker-terminology.spec.ts'), 'master-worker-terminology is among the specs that open the Master page');
  for (const { name, spec } of specs) assert.ok(spec.includes('serveXterm('), `${name} opens the Master page and serves xterm.js locally`);
});
