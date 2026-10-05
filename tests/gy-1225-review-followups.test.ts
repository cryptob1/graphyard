import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsProgram, supervisorArgv } from '../src/master/launch.js';

test('manual:review-followups-triaged GY-1225.1: only the word a -c wrapper runs is split, so an argument naming the program is not the runtime (Finding 1)', () => {
  assert.equal(runsProgram(['vim', 'notes claude'], 'claude'), false);
  assert.equal(runsProgram(['grep', 'run claude'], 'claude'), false);
  assert.equal(runsProgram(['less', '/var/log/x claude'], 'claude'), false);
  // A wrapper's -c string (or -lc) is still split, and a bare word still counts.
  assert.ok(runsProgram(['/bin/sh', '-c', '/usr/lib/codex/bin/codex.mjs exec go'], 'codex'));
  assert.ok(runsProgram(['/bin/bash', '-lc', 'exec claude --print'], 'claude'));
  assert.ok(runsProgram(['/home/u/.local/bin/claude', '--print'], 'claude'));
});

test('manual:review-followups-triaged GY-1225.2: a supervisor is `watch` right after the graphyard CLI, not any bare watch (Finding 2)', () => {
  assert.equal(supervisorArgv(['sudo', 'watch', '-n', '1', '--', 'ls']), false);
  assert.equal(supervisorArgv(['env', 'watch', '-n', '1', '--', 'ls']), false);
  assert.equal(supervisorArgv(['/bin/sh', '-c', 'sudo watch -n 1 -- ls']), false);
  assert.equal(supervisorArgv(['grep', 'node /w/bin/graphyard.mjs watch GY-1 1 -- claude']), false);
  assert.ok(supervisorArgv(['/usr/bin/node', '/w/bin/graphyard.mjs', 'watch', 'GY-1225', '1', '--', 'claude']));
  assert.ok(supervisorArgv(['/usr/local/bin/graphyard', 'watch', 'GY-1225', '1', '--', 'claude']));
  assert.ok(supervisorArgv(['/bin/sh', '-c', '/usr/bin/node /w/bin/graphyard.mjs watch GY-1225 1 -- claude go']));
});
