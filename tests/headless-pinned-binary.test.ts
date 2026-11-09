import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

for (const sandbox of [false, true]) test(`e2e:headless-pinned-binary — spec checks and reviews execute the runtime pin${sandbox ? ' inside the sandbox' : ''}, never the host shim`, async () => {
  // The sandbox hides /tmp: keep both installations on the repository's visible filesystem.
  const parent = join(process.cwd(), '.graphyard');
  await mkdir(parent, { recursive: true });
  const base = await temporaryDirectory('headless-pinned-binary', parent);
  const root = join(base, 'coordinator'), directory = join(base, 'session');
  const pinned = join(base, 'pinned'), shims = join(base, 'shims');
  for (const path of [root, directory, pinned, shims]) await mkdir(path);
  execFileSync('git', ['init', '-q', root]);
  const hostNamespace = await readlink('/proc/self/ns/mnt');
  for (const command of ['cursor-agent', 'pi']) {
    await writeFile(join(pinned, command), `#!/bin/sh\nprintf '{"binary":"${command}","namespace":"%s"}\\n' "$(readlink /proc/self/ns/mnt)"\n`, { mode: 0o755 });
    await writeFile(join(shims, command), '#!/bin/sh\necho "host mise shim must not run" >&2\nexit 1\n', { mode: 0o755 });
  }
  // Cursor's interactive alias can itself lead back to a host mise wrapper.
  await writeFile(join(shims, 'agent'), '#!/bin/sh\necho "host agent alias invoked mise shim" >&2\nexit 1\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shims}:/usr/bin:/bin`;
  try {
    for (const route of ['spec-check', 'review'] as const) {
      for (const kind of ['cursor', 'pi']) {
        const binary = kind === 'cursor' ? 'cursor-agent' : kind;
        assert.equal(execFileSync('/bin/sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' }).trim(), join(shims, binary));
        const session = await startHeadlessSession({
          name: `pinned-${route}-${kind}`, work: 'GY-3210', subject: route,
          kind, args: [], environment: { PATH: `${pinned}:${shims}:/usr/bin:/bin`, MISE_NO_CONFIG: '1' },
          directory, coordinatorRoot: sandbox ? root : undefined, root, route, context: {}, prompt: 'Report the executed binary and mount namespace.',
          exec: spawnHeadless,
          answer: async output => {
            const answer = JSON.parse(output);
            assert.equal(answer.binary, binary);
            if (sandbox) assert.notEqual(answer.namespace, hostNamespace, 'the pinned binary runs inside the mount sandbox');
            assert.match(answer.namespace, /^mnt:\[\d+\]$/);
            return answer.binary;
          },
        });
        assert.equal(await session.settled, binary);
      }
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
