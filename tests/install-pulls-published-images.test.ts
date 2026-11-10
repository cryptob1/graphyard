import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeAdapter, type AdapterContext } from '../src/install/adapters.js';
import { fakeTransport } from '../src/install/transport.js';
import { pulledTrialImageFile, trialContainerImage, trialImage } from '../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3214: an install pulls the images Graphyard published for its source commit instead of
// building them, and builds them here as before when that commit is not published.

async function sourceCheckout() {
  const root = await temporaryDirectory('install-pulls');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, '.gitignore'), '.graphyard/\n');
  git('add', '.'); git('commit', '-q', '-m', 'release');
  return { root, commit: git('rev-parse', 'HEAD') };
}
const context = (sourceRoot: string, transport: ReturnType<typeof fakeTransport>) => ({ sourceRoot, image: 'graphyard-local:owner-project', transport }) as unknown as AdapterContext;

test('unit:tests/install-pulls-published-images.test.ts — a published commit is pulled: the control plane under the install\'s own tag, the trial image named for the release tree\'s trials; nothing is built', async () => {
  const { root, commit } = await sourceCheckout(), transport = fakeTransport();
  const server = `ghcr.io/cryptob1/graphyard:${commit}`, trial = `ghcr.io/cryptob1/graphyard-trial:${commit}`;
  await composeAdapter.provision(context(root, transport), {} as never);
  assert.deepEqual(transport.commands.map((_, index) => transport.line(index)),
    [`docker pull ${trial}`, `docker pull ${server}`, `docker tag ${server} graphyard-local:owner-project`, `docker image rm ${server}`]);
  assert.equal(transport.files.get(pulledTrialImageFile(root))?.content, `${trial}\n`);
  const actions = composeAdapter.plan(context(root, transport), { database: false, app: false } as never);
  assert.match(actions.find(action => action.id === 'provider.image')!.title, new RegExp(`^Pull the Graphyard image ${server.replace(/\./g, '\\.')} as graphyard-local:owner-project`));
  assert.match(actions.find(action => action.id === 'provider.trial-image')!.title, new RegExp(`^Pull the private-root merge-trial image ${trial.replace(/\./g, '\\.')}`));

  // Trials run the image the release tree names, and the one built on this host otherwise.
  assert.equal(trialImage(root), trialContainerImage);
  await mkdir(join(root, '.graphyard'));
  await writeFile(pulledTrialImageFile(root), `${trial}\n`);
  assert.equal(trialImage(root), trial);
});

test('unit:tests/install-pulls-published-images.test.ts — a commit that is not published, or a checkout with changes, builds both images here as before', async () => {
  const { root } = await sourceCheckout();
  const unpublished = fakeTransport({ responses: [{ match: 'docker pull', result: { stdout: '', stderr: 'manifest unknown', code: 1 } }] });
  await composeAdapter.provision(context(root, unpublished), {} as never);
  const lines = unpublished.commands.map((_, index) => unpublished.line(index));
  assert.equal(lines.filter(line => line.startsWith('docker pull ')).length, 2);
  assert.ok(lines.some(line => line.startsWith('docker buildx build ') && line.includes(`--tag ${trialContainerImage} `)), lines.join('\n'));
  assert.ok(lines.some(line => line.startsWith('docker build ') && line.includes('--tag graphyard-local:owner-project ')), lines.join('\n'));
  assert.equal(unpublished.files.size, 0, 'no pulled trial image is named');

  await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n# changed\n');
  const dirty = fakeTransport();
  await composeAdapter.provision(context(root, dirty), {} as never);
  assert.ok(!dirty.commands.some((_, index) => dirty.line(index).startsWith('docker pull ')), 'no published image holds a changed tree');
  assert.match(composeAdapter.plan(context(root, dirty), { database: false, app: false } as never).find(action => action.id === 'provider.image')!.title, /^Build the Graphyard image /);
});
