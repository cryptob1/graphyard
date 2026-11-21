import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun } from '../src/child-runner.js';
import { remoteShardSession } from '../src/merge-writer/remote-shards.js';
import { git, shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3577: a remote shard's container has a read-only root; only its run directory, /tmp and /run
// are writable. The pre-submit rerun made its scratch in /var/tmp alone, so on a compute host it
// never started its child and both cases of tests/complete-rerun-bounded.test.ts failed every trial
// that ran the file there. Docker is the fixture's stand-in, here with Docker's read-only root.

const image = 'graphyard-trial:rerun-bounded';
const source = fileURLToPath(new URL('..', import.meta.url));
const file = 'tests/complete-rerun-bounded.test.ts';

test('integration:rerun-bounded-on-remote-shard — tests/complete-rerun-bounded.test.ts runs through the remote shard runner on a host with a read-only root and its cases pass', { timeout: 180_000 }, async () => {
  const hosts = await shardHosts('rerun-bounded-on-remote-shard', ['box'], { [image]: `sha256:${'3577'.repeat(16)}` });
  await mkdir(hosts.state('box'), { recursive: true });
  await writeFile(join(hosts.state('box'), 'read-only-root'), '');
  // The test file is the real one, byte for byte; its imports reach this checkout's sources through links.
  const repository = await shardRepository('rerun-bounded-repo', [], { 'package.json': JSON.stringify({ name: 'fixture', type: 'module' }), [file]: readFileSync(join(source, file), 'utf8') });
  for (const path of ['src', 'tests/helpers']) symlinkSync(join(source, path), join(repository.root, path));
  git(repository.root, 'add', '-A'); git(repository.root, 'commit', '-qm', 'link the sources');
  const previous = process.env.PATH;
  process.env.PATH = `${hosts.bin}:${previous}`;
  const session = remoteShardSession({ root: repository.root, sha: git(repository.root, 'rev-parse', 'HEAD'), image, run: defaultChildRun, deadline: Date.now() + 150_000 });
  try {
    // Node's test runner runs the file; the record says the shard reached its verdict.
    const ended = await session.run('gy-compute@box', 0, [file], (_list, records) => ['sh', '-c', '"$0" --import "$1" --test --test-reporter=spec "$2"; code=$?; echo ran > "$3"; exit $code',
      process.execPath, import.meta.resolve('tsx'), file, records], 2);
    assert.equal(ended.ok, true, ended.out);
    for (const name of ['unit:complete-rerun-runs-only-failing-files', 'unit:complete-rerun-killed-at-bound']) assert.ok(ended.out.includes(`✔ ${name}`), ended.out);
  } finally { await session.close(); process.env.PATH = previous; }
});
