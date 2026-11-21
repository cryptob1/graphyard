import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCredentialsMasked, masterCredentialMask, reviewerCredentialDirectory, sessionMountNamespaceWorks, type MaskProbe } from '../src/master/confinement.js';
import { masterSessionConfinement } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3565: the first review session creates the reviewers directory beside the master's
// credential. The master's mask hid it as another install's directory while its launch granted it
// writable, so the mask probe read it and refused every master launch after the first review.

/** A coordinator checkout, and a config home holding this install (its credential file directly in it), the reviewers directory a review created, and another install. */
function fixture(base: string) {
  const root = join(base, 'coordinator');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const configHome = join(base, 'config'), credentialFile = join(configHome, 'install', 'master.token'), other = join(configHome, 'other-install');
  for (const file of [credentialFile, join(other, 'tokens', 'other.token')]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'secret\n', { mode: 0o600 }); }
  const reviewers = reviewerCredentialDirectory({ credentialFile });
  mkdirSync(join(reviewers, 'sessions'), { recursive: true });
  return { root, configHome, credentialFile, other, reviewers };
}
const launch = (f: ReturnType<typeof fixture>) => masterSessionConfinement('claude', f.root, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true }, [f.reviewers], undefined, masterCredentialMask({ credentialFile: f.credentialFile }, [], f.configHome));

test('unit:master-mask-keeps-reviewers — the master mask keeps its granted reviewers directory and still hides another install', async () => {
  const f = fixture(await temporaryDirectory('master-mask-reviewers'));
  const mask = masterCredentialMask({ credentialFile: f.credentialFile }, [], f.configHome);
  assert.ok(!mask.hostPaths?.includes(f.reviewers), 'the reviewers directory is not masked');
  assert.ok(mask.hostPaths?.includes(f.other), 'another install stays masked');
  // The sandbox reads exactly what the launch binds back in: the granted state directories.
  const { wrapper } = await launch(f);
  const granted = wrapper.filter((_, index) => wrapper[index - 1] === '--bind');
  const probe: MaskProbe = (_command, args) => args.slice(args.lastIndexOf('sh') + 1).filter(path => granted.some(kept => path === kept || path.startsWith(`${kept}/`))).map(path => `readable\t${path}\n`).join('');
  await assertCredentialsMasked(wrapper, { coordinatorRoot: f.root, sessionDirectory: f.root, credentialMask: mask, maskProbe: probe });
});

test('e2e:master-mask-keeps-reviewers — under real bwrap a confined master launches after a review created the reviewers directory, writes there, and cannot read another install', async () => {
  // The fixture lives in this checkout: the sandbox replaces /tmp with its own scratch.
  const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  const f = fixture(await temporaryDirectory('master-mask-reviewers-e2e', join(checkout, '.graphyard')));
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
  const { wrapper } = await launch(f);
  const hostProbe: MaskProbe = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await assertCredentialsMasked(wrapper, { coordinatorRoot: f.root, sessionDirectory: f.root, credentialMask: masterCredentialMask({ credentialFile: f.credentialFile }, [], f.configHome), maskProbe: hostProbe });
  const binding = join(f.reviewers, 'sessions', 'binding.json'), otherToken = join(f.other, 'tokens', 'other.token');
  const ran = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', 'echo "{}" > "$1" && echo WROTE; if test -r "$2"; then echo LEAKED; fi', 'sh', binding, otherToken], { encoding: 'utf8', timeout: 60_000 });
  const output = `${ran.stdout}\n${ran.stderr}`;
  assert.equal(ran.status, 0, `the confined master ran: ${output.slice(-800)}`);
  assert.ok(output.includes('WROTE') && !output.includes('LEAKED'), `the master writes its reviewer binding and reads no other install: ${output.slice(-800)}`);
});
