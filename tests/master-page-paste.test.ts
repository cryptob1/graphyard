import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { terminalStream } from '../src/master/terminal-session.js';

test(`unit:test-browser-tests-master-page-paste-spec-ts-pinned — a read-only viewer's control request refused by the operator's stream
falls back to watching, even when herdr exits before its refusal line is read, instead of refusing the viewer outright`, async () => {
  const site = await mkdtemp(join(tmpdir(), 'gy-3453-'));
  const saved = { ...process.env };
  // A herdr whose `control` refusal reaches stdout only after the process has exited (a descendant still
  // holds the pipe), as a loaded host reorders it; `observe` shows the pane.
  const frame = JSON.stringify({ type: 'terminal.frame', bytes: Buffer.from('screen').toString('base64') });
  const closed = JSON.stringify({ type: 'terminal.closed', reason: 'terminal attach failed: terminal already has an attached client; retry with --takeover' });
  await writeFile(join(site, 'herdr'), `#!/bin/sh
[ "$1 $2" = "terminal session" ] || exit 0
if [ "$3" = control ]; then (sleep 0.3; echo '${closed}') & exit 0; fi
echo '${frame}'; exec cat >/dev/null
`);
  await chmod(join(site, 'herdr'), 0o755);
  Object.assign(process.env, { PATH: `${site}${delimiter}${process.env.PATH}`, GRAPHYARD_HERDR_CONFIG_HOME: '', HERDR_SOCKET_PATH: '' });
  const frames: string[] = [], exits: string[] = [];
  const stream = terminalStream({ control: false, pane: 'w1:master', cols: '100', rows: '30' }, {
    line: line => { if (JSON.parse(line).type === 'terminal.frame') frames.push(line); },
    exit: reason => { exits.push(reason); },
  }, undefined, null);
  try {
    for (const deadline = Date.now() + 8_000; !frames.length && !exits.length && Date.now() < deadline;) await new Promise(done => setTimeout(done, 50));
    assert.deepEqual(exits, [], 'the refusal is a cue to watch, not a failure');
    assert.equal(frames.length, 1, 'the viewer watches the pane');
  } finally {
    stream.end(); process.env = saved;
    await rm(site, { recursive: true, force: true });
  }
});
