import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';

// GY-3455: on a host that already has the rootless Docker tools, gy-compute's ~/.graphyard is never
// created by a download, yet the script chowns it: the printed script must still reach Ready.

const proof = 'integration:host-prepare-tools-present';
const curls = async (dir: string) => (await readFile(join(dir, 'log'), 'utf8')).split('\n').filter(line => line.startsWith('curl '));

test(`${proof} — with the rootless tools installed and no ~/.graphyard, the printed script completes and prints Ready; with them missing it still downloads them`, async () => {
  const fixture = await fakeHosts('host-prepare-tools-present', [{ name: 'box' }, { name: 'bare', rootlessExtrasMissing: true }]);
  assert.match(fixture.prepareOutput('box'), /Ready\. On the Graphyard machine run: graphyard host add gy-compute@box\s*$/);
  assert.equal((await curls(fixture.host('box'))).length, 0, 'nothing is downloaded when the tools are installed');
  assert.match(fixture.prepareOutput('bare'), /Ready\./);
  assert.equal((await curls(fixture.host('bare'))).length, 3, 'the rootless extras, slirp4netns and its checksums are downloaded');
});
