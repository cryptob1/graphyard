import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../../src/child-runner.js';
import { hostShimScript } from '../../src/host-shim.js';
import { remoteShardSession } from '../../src/merge-writer/remote-shards.js';
import { trialImage } from '../../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './temp-dirs.js';
import { sshdHost } from './shard-hosts.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const image = trialImage(root);

/** Real SSH, restricted shim and rootless Docker; no local runner or fallback exists here. */
export async function remotePostgresShard() {
  const socket = `unix:///run/user/${process.getuid!()}/docker.sock`;
  const security = execFileSync('/usr/bin/docker', ['--host', socket, 'info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8' });
  assert.match(security, /rootless/, 'the regression requires rootless Docker');
  const scratch = await temporaryDirectory('remote-postgres-shard');
  const home = join(scratch, 'home'), bin = join(scratch, 'bin'), shim = join(scratch, 'shim');
  await mkdir(home); await mkdir(bin);
  await writeFile(shim, hostShimScript, { mode: 0o755 });
  const server = await sshdHost(scratch, shim, home, '/usr/bin', bin);
  const run: ChildRun = (program, args, options) => defaultChildRun(program, args, { ...options,
    env: { ...process.env, ...options?.env, PATH: `${bin}:/usr/bin:/bin`, DOCKER_HOST: socket } });
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const session = remoteShardSession({ root, sha, image, run, deadline: Date.now() + 600_000 });
  const target = `${server.user}@127.0.0.1`;
  const files = ['tests/action-priority.test.ts'];
  const argv = (list: string, records: string) => ['node', '--import', 'tsx', 'tests/helpers/run-tests.ts', '--files-from', list, '--durations', records];
  try {
    // The same real shard at UID 0 reproduces the operational initdb refusal.
    await writeFile(shim, hostShimScript.replace("'user': '1000:0'", "'user': '0:0'"));
    await assert.rejects(session.run(target, 0, files, argv, 1), /cannot be run as root|unprivileged user/);
    await writeFile(shim, hostShimScript);
    const result = await session.run(target, 1, files, argv, 1);
    assert.equal(result.ok, true, result.out);
    const records = result.records.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.file === files[0] && record.passed === true), result.records);
    assert.ok(records.every(record => record.passed === true), result.records);
  } finally { await session.close(); server.kill(); }
}
