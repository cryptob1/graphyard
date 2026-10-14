import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEPLOY_KEY_FILE, deployKeyTitle, ensureDeployKey, publicKeyFingerprint } from '../src/install/deploy-key.js';
import type { GitHubCli } from '../src/install/github.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The merge writer's deploy key (GY-1551): one ed25519 pair under the install directory, registered
// read-write on the repository through the operator's gh login only when its fingerprint is not
// already listed, and never shown to anyone.

// The fake private key's armor is assembled here, never written as a literal: the secrets scan's
// private-key rule reads a PEM block in a committed file as a leak (GY-1186, GY-1352, GY-1461).
const armor = (edge: string) => `-----${edge} OPENSSH PRIVATE KEY-----`;
const PRIVATE = `${armor('BEGIN')}\nSENTINEL-PRIVATE-KEY-MATERIAL\n${armor('END')}\n`;
// A real ed25519 public key line: its fingerprint is what GitHub would list for it.
const PUBLIC_BODY = 'AAAAC3NzaC1lZDI1NTE5AAAAIFzs4bbnB6bJVeLLB+C7aK2b6qJ9fcQ0Y6hVwLrjQJvQ';
const OTHER_BODY = 'AAAAC3NzaC1lZDI1NTE5AAAAIO6YdF1p3nqlEWpqTXzmXb5Gc0Ztw1KqHoNfk2xzXyAB';

interface Fixture { gh: GitHubCli; calls: string[][]; keygens: string[][]; registry: { id: number; key: string; title: string }[] }

/** A fake gh that answers deploy-key list from REGISTRY and records every call, and a fake ssh-keygen that writes a known pair. */
function fixture(registry: Fixture['registry'] = []): Fixture {
  const calls: string[][] = []; const keygens: string[][] = [];
  const gh: GitHubCli = async args => {
    calls.push(args);
    if (args[2] === 'list') return { stdout: JSON.stringify(registry), stderr: '', code: 0 };
    if (args[2] === 'add') { registry.push({ id: registry.length + 1, key: `ssh-ed25519 ${PUBLIC_BODY}`, title: args[args.indexOf('--title') + 1]! }); return { stdout: '✓ Deploy key added\n', stderr: '', code: 0 }; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls, keygens, registry };
}
const keygenFor = (fixture: Fixture) => async (args: string[]) => {
  fixture.keygens.push(args);
  if (args[0] === '-y') return { stdout: `ssh-ed25519 ${PUBLIC_BODY} derived\n`, stderr: '', code: 0 };
  const file = args[args.indexOf('-f') + 1]!;
  await writeFile(file, PRIVATE, { mode: 0o600 });
  await writeFile(`${file}.pub`, `ssh-ed25519 ${PUBLIC_BODY} ${args[args.indexOf('-C') + 1]}\n`, { mode: 0o600 });
  return { stdout: '', stderr: '', code: 0 };
};
const mode = async (path: string) => (await stat(path)).mode & 0o777;

test('unit:deploy-key-idempotent — ensureDeployKey generates the ed25519 pair once (directory 0700, files 0600), registers the public key read-write under graphyard-merge-writer-<hostname> only while its fingerprint is unlisted, derives a missing .pub from the private key, and returns the private path every time', async () => {
  const home = await temporaryDirectory('deploy-key');
  const installDir = join(home, 'owner-project');
  const fx = fixture();
  const first = await ensureDeployKey(installDir, 'owner/project', fx.gh, { keygen: keygenFor(fx), hostname: 'box-1' });
  assert.equal(first, join(installDir, DEPLOY_KEY_FILE));
  assert.deepEqual(fx.keygens, [['-q', '-t', 'ed25519', '-N', '', '-C', 'graphyard-merge-writer-box-1', '-f', first]]);
  assert.equal(await mode(installDir), 0o700);
  assert.equal(await mode(first), 0o600);
  assert.equal(await mode(`${first}.pub`), 0o600);
  assert.deepEqual(fx.calls, [
    ['repo', 'deploy-key', 'list', '-R', 'owner/project', '--json', 'id,key,title'],
    ['repo', 'deploy-key', 'add', `${first}.pub`, '-R', 'owner/project', '--allow-write', '--title', 'graphyard-merge-writer-box-1'],
  ]);
  assert.equal(deployKeyTitle('box-1'), 'graphyard-merge-writer-box-1');
  assert.deepEqual(fx.registry.map(entry => entry.title), ['graphyard-merge-writer-box-1']);

  // A second run finds the pair and the registration: no key is generated, none is added.
  fx.calls.length = 0; fx.keygens.length = 0;
  const second = await ensureDeployKey(installDir, 'owner/project', fx.gh, { keygen: keygenFor(fx), hostname: 'box-1' });
  assert.equal(second, first);
  assert.deepEqual(fx.keygens, []);
  assert.deepEqual(fx.calls.map(call => call[2]), ['list']);
  assert.equal(await readFile(first, 'utf8'), PRIVATE, 'the private key is kept, not rotated');

  // Registration compares fingerprints, not titles or comments: the same key under another title
  // (or comment) is registered, a different key under this title is not.
  const renamed = fixture([{ id: 7, key: `ssh-ed25519 ${PUBLIC_BODY} someone@elsewhere`, title: 'legacy' }]);
  await ensureDeployKey(installDir, 'owner/project', renamed.gh, { keygen: keygenFor(renamed), hostname: 'box-1' });
  assert.deepEqual(renamed.calls.map(call => call[2]), ['list']);
  const other = fixture([{ id: 8, key: `ssh-ed25519 ${OTHER_BODY}`, title: 'graphyard-merge-writer-box-1' }]);
  await ensureDeployKey(installDir, 'owner/project', other.gh, { keygen: keygenFor(other), hostname: 'box-1' });
  assert.deepEqual(other.calls.map(call => call[2]), ['list', 'add']);
  assert.notEqual(publicKeyFingerprint(`ssh-ed25519 ${PUBLIC_BODY}`), publicKeyFingerprint(`ssh-ed25519 ${OTHER_BODY}`));
  assert.equal(publicKeyFingerprint(`ssh-ed25519 ${PUBLIC_BODY} a`), publicKeyFingerprint(`ssh-ed25519 ${PUBLIC_BODY} b`));
  assert.equal(publicKeyFingerprint('not a key'), null);

  // A lost .pub is derived from the private key (ssh-keygen -y); the private key is not regenerated.
  const { rm } = await import('node:fs/promises');
  await rm(`${first}.pub`);
  const derived = fixture(other.registry);
  await ensureDeployKey(installDir, 'owner/project', derived.gh, { keygen: keygenFor(derived), hostname: 'box-1' });
  assert.deepEqual(derived.keygens, [['-y', '-f', first]]);
  assert.equal(await readFile(`${first}.pub`, 'utf8'), `ssh-ed25519 ${PUBLIC_BODY} derived\n`);
  assert.equal(await mode(`${first}.pub`), 0o600);
  assert.equal(await readFile(first, 'utf8'), PRIVATE);

  // The default ssh-keygen invocation produces a pair whose fingerprint matches what ssh-keygen -lf prints.
  let keygenAvailable = true;
  try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (error: any) { keygenAvailable = error?.code !== 'ENOENT'; }
  if (keygenAvailable) {
    const realDir = join(home, 'real-install');
    const real = fixture();
    const privateKeyFile = await ensureDeployKey(realDir, 'owner/project', real.gh, { hostname: 'box-2' });
    const publicKey = await readFile(`${privateKeyFile}.pub`, 'utf8');
    assert.match(publicKey, /^ssh-ed25519 \S+ graphyard-merge-writer-box-2\n$/);
    assert.ok((await readFile(privateKeyFile, 'utf8')).startsWith(armor('BEGIN')), 'ssh-keygen wrote an OpenSSH private key');
    const printed = execFileSync('ssh-keygen', ['-lf', `${privateKeyFile}.pub`], { encoding: 'utf8' });
    assert.ok(printed.includes(publicKeyFingerprint(publicKey)!), `${printed.trim()} carries the computed fingerprint`);
    assert.equal(await mode(realDir), 0o700); assert.equal(await mode(privateKeyFile), 0o600); assert.equal(await mode(`${privateKeyFile}.pub`), 0o600);
  }
});

test('unit:deploy-key-never-printed — nothing ensureDeployKey writes to stdout or stderr, passes to gh or ssh-keygen, or throws names the private key material; gh receives the public file alone and the private key file is never read', async () => {
  const home = await temporaryDirectory('deploy-key-quiet');
  const installDir = join(home, 'owner-project');
  const fx = fixture();
  const output: string[] = [];
  const spies = [process.stdout, process.stderr].map(stream => {
    const original = stream.write.bind(stream);
    (stream as any).write = (chunk: any, ...rest: any[]) => { output.push(String(chunk)); return original(chunk, ...rest); };
    return () => { (stream as any).write = original; };
  });
  const consoleOriginals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(consoleOriginals) as (keyof typeof consoleOriginals)[]) (console as any)[name] = (...args: unknown[]) => output.push(args.map(String).join(' '));
  try {
    const privateKeyFile = await ensureDeployKey(installDir, 'owner/project', fx.gh, { keygen: keygenFor(fx), hostname: 'box-1' });
    // The private key exists only in its file. A stripped mode is repaired to 0600 on the next run,
    // and that run still shows the material nowhere: the module names the file, never opens it.
    const { chmod } = await import('node:fs/promises');
    await chmod(privateKeyFile, 0o000);
    const again = await ensureDeployKey(installDir, 'owner/project', fx.gh, { keygen: keygenFor(fx), hostname: 'box-1' });
    assert.equal(again, privateKeyFile);
    assert.equal(await mode(privateKeyFile), 0o600, 'the mode is restored to 0600 on every run');
    const everything = [...output, ...fx.calls.flat(), ...fx.keygens.flat()].join('\n');
    assert.ok(!everything.includes('SENTINEL-PRIVATE-KEY-MATERIAL'), 'the private key material never leaves its file');
    assert.ok(!everything.includes('PRIVATE KEY'), 'no private key block is echoed');
    assert.equal(output.length, 0, `ensureDeployKey prints nothing, got: ${output.join('|')}`);
    for (const call of fx.calls) {
      for (const argument of call) assert.notEqual(argument, privateKeyFile, 'gh never receives the private key path');
      if (call[2] === 'add') assert.equal(call[3], `${privateKeyFile}.pub`);
    }
  } finally {
    for (const restore of spies) restore();
    Object.assign(console, consoleOriginals);
  }
});
