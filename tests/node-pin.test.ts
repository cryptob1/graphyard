import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFetchArgv, nodePin, pinnedNodePath } from '../src/node-pin.js';
import { guideText } from '../src/guide.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3207: the Node major a checkout declares, and the PATH its commands run under.

const checkout = async (files: Record<string, string>) => {
  const root = await temporaryDirectory('node-pin', tmpdir());
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  return root;
};
const engines = (node: string) => ({ 'package.json': JSON.stringify({ name: 'x', engines: { node } }) });

test('unit:tests/node-pin.test.ts — each source file pins its major: .nvmrc, .node-version, mise.toml (both forms), .tool-versions and package.json engines.node', async () => {
  assert.equal(nodePin(await checkout({ '.nvmrc': 'v22.1.0\n' })), 22);
  assert.equal(nodePin(await checkout({ '.node-version': '20\n' })), 20);
  assert.equal(nodePin(await checkout({ 'mise.toml': '[env]\nnode = "18"\n\n[tools]\npnpm = "10"\nnode = "22" # the runtime\n' })), 22);
  assert.equal(nodePin(await checkout({ 'mise.toml': '[tools]\nnode = { version = "24.1", postinstall = "corepack enable" }\n' })), 24);
  assert.equal(nodePin(await checkout({ '.tool-versions': 'python 3.12\nnodejs 22.3.0 20.1.0\n' })), 22);
  assert.equal(nodePin(await checkout({ '.tool-versions': 'node 24\n' })), 24);
  assert.equal(nodePin(await checkout(engines('^22'))), 22);
});

test('unit:tests/node-pin.test.ts — precedence: .nvmrc, then .node-version, mise.toml, .tool-versions, then engines.node', async () => {
  const sources: [string, string, number][] = [
    ['.nvmrc', '18\n', 18], ['.node-version', '19\n', 19], ['mise.toml', '[tools]\nnode = "20"\n', 20], ['.tool-versions', 'nodejs 21\n', 21], ['package.json', JSON.stringify({ engines: { node: '22' } }), 22],
  ];
  for (let first = 0; first < sources.length; first++) {
    assert.equal(nodePin(await checkout(Object.fromEntries(sources.slice(first).map(([file, content]) => [file, content])))), sources[first]![2]);
  }
});

test('unit:tests/node-pin.test.ts — accepted and rejected forms: a value pins only when it yields a numeric major, and an engines range only as caret, tilde, exact or x-range', async () => {
  for (const [value, pin] of [['v22.1.0', 22], ['22', 22], ['22.x', 22], ['22.11', 22]] as const) assert.equal(nodePin(await checkout({ '.nvmrc': value })), pin, value);
  for (const [value, pin] of [['^22', 22], ['~22.1', 22], ['22', 22], ['22.x', 22], ['v22.1.0', 22]] as const) assert.equal(nodePin(await checkout(engines(value))), pin, value);
  for (const value of ['lts/*', 'lts/iron', 'node', 'latest', '>=22', '*', '']) {
    assert.equal(nodePin(await checkout({ '.nvmrc': value })), null, value);
    assert.equal(nodePin(await checkout(engines(value))), null, value);
  }
  for (const value of ['^22 || ^24', '>=22 <23', '^22.0.0 || >=24']) assert.equal(nodePin(await checkout(engines(value))), null, value);
  // Unreadable or malformed files pin nothing.
  const unreadable = await checkout({ 'package.json': '{ not json', 'mise.toml': '[tools]\npnpm = "10"\n' });
  mkdirSync(join(unreadable, '.nvmrc'));
  assert.equal(nodePin(unreadable), null);
});

test('unit:tests/node-pin.test.ts — no declaration leaves PATH unchanged and runs nothing, Graphyard\'s own checkout included; a pin that differs from the running node fetches it once through npm exec and puts its bin directory first; the guide names the rule', async () => {
  const none = async () => { throw new Error('nothing runs for a checkout that pins nothing'); };
  assert.equal(await pinnedNodePath(await checkout({ 'package.json': '{"name":"x"}' }), '/usr/bin:/bin', none), '/usr/bin:/bin');
  assert.equal(nodePin(join(import.meta.dirname, '..')), null);
  assert.equal(await pinnedNodePath(join(import.meta.dirname, '..'), '/usr/bin:/bin', none), '/usr/bin:/bin');

  const pinned = await checkout({ 'mise.toml': '[tools]\nnode = "22"\n' });
  const ran: string[][] = [];
  const running = (version: string) => async (command: string, args: string[]) => {
    ran.push([command, ...args]);
    return command === 'node' ? `${version}\n` : 'npm notice run npx\n/cache/_npx/abc/node_modules/node-linux-x64/bin/node\n';
  };
  assert.equal(await pinnedNodePath(pinned, '/shims:/usr/bin', running('26.13.0')), '/cache/_npx/abc/node_modules/node-linux-x64/bin:/shims:/usr/bin');
  assert.deepEqual(ran, [['node', '-p', 'process.versions.node'], nodeFetchArgv(22)]);
  assert.deepEqual(nodeFetchArgv(22), ['npm', 'exec', '--yes', `--package=node-${process.platform}-${process.arch}@22`, '--', 'node', '-p', 'process.execPath']);
  // The running node already is the pinned major: nothing is fetched.
  ran.length = 0;
  assert.equal(await pinnedNodePath(pinned, '/shims:/usr/bin', running('22.4.0')), '/shims:/usr/bin');
  assert.deepEqual(ran, [['node', '-p', 'process.versions.node']]);
  // A fetch that answers no node path fails the command rather than running under another major.
  await assert.rejects(pinnedNodePath(pinned, '/usr/bin', async command => command === 'node' ? '26.0.0' : 'npm error 404'), /node@22 could not be fetched: npm error 404/);

  assert.match(guideText('master'), /run under the Node major it declares: the first of \.nvmrc, \.node-version, mise\.toml, \.tool-versions and package\.json engines\.node/);
});
