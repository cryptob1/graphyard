import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3261: the batch gate's check test:browser-tests/ failed once and passed its re-run. Two causes:
// the terminal specs fetched xterm.js from the live CDN, so a slow or failed fetch left the page on
// "xterm.js did not load"; and e2e:master-page-ux wrote the pane's new output after dropping the
// socket, racing the reconnect's re-read 250 ms later. The suite now serves the CDN files from the
// pinned devDependency, and the output is written before the drop.
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('unit:test-browser-tests-pinned — the terminal specs serve xterm.js locally with the bytes the page pins, and master-page-ux changes the pane before it drops the socket', () => {
  const component = read('web/components/live-terminal.tsx');
  const version = /cdn\.jsdelivr\.net\/npm\/@xterm\/xterm@([\d.]+)/.exec(component)?.[1];
  assert.ok(version, 'the live terminal names the xterm.js version it loads');
  assert.equal(JSON.parse(read('package.json')).devDependencies?.['@xterm/xterm'], version, 'the suite pins the same xterm.js version as a devDependency');
  for (const [file, integrity] of [...component.matchAll(/\$\{xterm\}\/([\w/.-]+)`,\s*integrity: '(sha384-[^']+)'/g)].map(match => [match[1]!, match[2]!])) {
    const local = `sha384-${createHash('sha384').update(readFileSync(join(root, 'node_modules/@xterm/xterm', file))).digest('base64')}`;
    assert.equal(local, integrity, `node_modules/@xterm/xterm/${file} matches the integrity hash the page checks`);
  }
  const terminalSpecs = readdirSync(join(root, 'browser-tests')).filter(name => name.endsWith('.spec.ts') && read(`browser-tests/${name}`).includes('&master`'));
  assert.ok(terminalSpecs.length >= 4, `the terminal specs are found: ${terminalSpecs.join(', ')}`);
  for (const name of terminalSpecs) {
    const spec = read(`browser-tests/${name}`);
    const opened = spec.match(/\.newPage\(\)/g)?.length ?? 0, served = spec.match(/serveXterm\(/g)?.length ?? 0;
    assert.ok(served >= 1 && (served >= opened || spec.includes('serveXterm(context)')), `${name} serves xterm.js locally on every page it opens`);
  }
  const ux = read('browser-tests/master-page-ux.spec.ts');
  for (const gap of ['output produced during the gap', 'output while offline'])
    assert.match(ux, new RegExp(`f\\.current\\.gap = '${gap}'; await f\\.save\\(\\);\\n\\s*f\\.child\\.send\\('drop-terminals'\\)`), `master-page-ux writes '${gap}' just before it drops the socket`);
});
