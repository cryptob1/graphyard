import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';

// GY-3419: `graphyard host prepare` no longer requires dockerd-rootless-setuptool.sh to be
// installed. On a host lacking it and slirp4netns, the script it prints fetches the static Docker
// rootless extras matching the reported Docker version and a static slirp4netns into gy-compute's
// home, verifies them, and runs those; when the tools are present — or its own fetched copy is —
// it downloads nothing.

const proof = 'integration:host-prepare-rootless-extras';
const arch = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
const extras = (fixture: Awaited<ReturnType<typeof fakeHosts>>) => join(fixture.home('bare'), '.graphyard', 'rootless', 'docker-rootless-extras');
const logLines = async (fixture: Awaited<ReturnType<typeof fakeHosts>>) => (await readFile(join(fixture.host('bare'), 'log'), 'utf8')).split('\n').filter(Boolean);

test(`${proof} — on a host without dockerd-rootless-setuptool.sh and slirp4netns, the printed script fetches the static rootless extras for the reported Docker version and a static slirp4netns into gy-compute's home, verifies them, and uses them`, async () => {
  const fixture = await fakeHosts('host-prepare-rootless', [{ name: 'bare', rootlessExtrasMissing: true }]);
  const lines = await logLines(fixture);
  const curls = lines.filter(line => line.startsWith('curl '));
  // The docker stand-in reports Docker version 29.10.0: the extras fetched must match it, for this arch.
  assert.deepEqual(curls, [
    `curl https://download.docker.com/linux/static/stable/${arch}/docker-rootless-extras-29.10.0.tgz`,
    `curl https://github.com/rootless-containers/slirp4netns/releases/download/v1.3.7/slirp4netns-${arch}`,
    'curl https://github.com/rootless-containers/slirp4netns/releases/download/v1.3.7/SHA256SUMS',
  ], lines.join('\n'));
  // Into the gy-compute home: the extras the tarball held and the slirp4netns the checksum verified.
  const dir = extras(fixture);
  for (const tool of ['dockerd-rootless-setuptool.sh', 'dockerd-rootless.sh', 'rootlesskit', `slirp4netns-${arch}`, 'slirp4netns']) {
    const info = await stat(join(dir, tool));
    assert.ok(info.isFile() && (info.mode & 0o111) === 0o111, `${tool} is an executable in gy-compute's home`);
  }
  // And it uses them: the install ran through the fetched setuptool with its directory on PATH, so
  // the daemon it writes runs the fetched rootlesskit and slirp4netns.
  assert.match(lines.find(line => line.startsWith('sudo '))!, new RegExp(`sudo -u gy-compute XDG_RUNTIME_DIR=/run/user/1001 [^\\n]*PATH=[^\\n]*docker-rootless-extras:[^\\n]*gy-compute/\\.graphyard/rootless/docker-rootless-extras/dockerd-rootless-setuptool\\.sh install`));
  assert.match(lines.join('\n'), /dockerd-rootless-setuptool\.sh install for gy-compute at \/run\/user\/1001\/docker\.sock/, 'the fetched setuptool ran the install');
  await stat(join(fixture.host('bare'), 'run', 'user', '1001', 'docker.sock'));
  assert.match(fixture.prepareOutput('bare'), /Ready\. On the Graphyard machine run: graphyard host add gy-compute@bare\s*$/);
});

test(`${proof} — with its fetched copy already in the home the script downloads nothing; a host with both tools installed never downloads`, async () => {
  const fixture = await fakeHosts('host-prepare-rootless-again', [{ name: 'bare', rootlessExtrasMissing: true }]);
  const before = (await logLines(fixture)).filter(line => line.startsWith('curl ')).length;
  assert.equal(before, 3);
  const again = await fixture.prepare('bare');
  assert.match(again, /Ready\. On the Graphyard machine run: graphyard host add gy-compute@bare\s*$/);
  assert.equal((await logLines(fixture)).filter(line => line.startsWith('curl ')).length, 3, 'the second run downloaded nothing');
  // Both tools installed (the stand-ins every default fixture host carries): no curl stand-in is even reached.
  const installed = await fakeHosts('host-prepare-rootless-installed', [{ name: 'box' }]);
  assert.match(installed.prepareOutput('box'), /Ready\./);
  assert.equal((await readFile(join(installed.host('box'), 'log'), 'utf8')).split('\n').filter(line => line.startsWith('curl ')).length, 0, 'a host with the tools installed downloads nothing');
});

test(`${proof} — a slirp4netns whose checksum does not verify fails the script, so a tampered download never runs`, async () => {
  await assert.rejects(fakeHosts('host-prepare-rootless-tamper', [{ name: 'bad', rootlessExtrasMissing: true, tamperSlirpChecksum: true }]),
    /The fetched slirp4netns did not verify\./);
});
