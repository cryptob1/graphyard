/** GY-3171: the trial's secret scan reads only the commits the change adds, and its refusal names the scan. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSecretScan, secretScanArgv, secretScanCacheDirectory } from '../src/merge-writer/secret-scan.js';
import { runTrialAttempt } from '../src/merge-writer/trial.js';
import { trialFailureReason } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
// A stand-in gitleaks: reports a leak when the commits its --log-opts name add the marker.
const fakeGitleaks = `#!/bin/sh
range=HEAD; for arg in "$@"; do case "$arg" in --log-opts=*) range="\${arg#--log-opts=}";; esac; wt="$arg"; done
if git -C "$wt" log -p $range | grep -q '^+.*PLANTED-LEAK'; then echo "leaks found: 1"; exit 1; fi
`;

async function repository() {
  const root = await temporaryDirectory('scan-scope', tmpdir());
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
  const commit = async (body: string) => { await writeFile(join(root, 'notes.txt'), body); git('add', '-A'); git('commit', '-qm', body.slice(0, 20)); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  await commit('token PLANTED-LEAK\n');
  const tip = await commit('cleaned\n');
  const base = await temporaryDirectory('scan-scope-base', tmpdir());
  const cache = secretScanCacheDirectory(base);
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'gitleaks'), fakeGitleaks, { mode: 0o700 });
  return { root, base, tip, commit };
}

const trial = (repo: Awaited<ReturnType<typeof repository>>, mergeSha: string) =>
  runTrialAttempt({ root: repo.root, base: repo.base, mergeSha, baseTip: repo.tip, changedFiles: ['notes.txt'], timeoutMs: 60_000, key: 'GY-3171', environment: { PATH: process.env.PATH! }, secretScan: runSecretScan });

test('unit:secret-scan-scope — with a base tip the scan reads <tip>..HEAD; a leak only in the base history passes, one the change adds refuses', async () => {
  assert.ok(secretScanArgv('/workspace', 'gitleaks', false, 'abc123').includes('--log-opts=abc123..HEAD'));
  assert.ok(secretScanArgv('/workspace', 'gitleaks', false).includes('--log-opts=HEAD'));

  const repo = await repository();
  const clean = await trial(repo, await repo.commit('a clean change\n'));
  assert.equal(clean.build, 'pass', clean.logTail);
  assert.equal(trialFailureReason({ run: clean }), null);

  const leaking = await trial(repo, await repo.commit('new PLANTED-LEAK\n'));
  assert.deepEqual(leaking.tests.failed, ['secret-scan'], leaking.logTail);
});

test('unit:secret-scan-scope — a trial failing only its secret scan is refused for the secret scan, never a build step', async () => {
  const repo = await repository();
  const run = await trial(repo, await repo.commit('new PLANTED-LEAK\n'));
  const reason = trialFailureReason({ run })!;
  assert.match(reason, /secret scan \(gitleaks\) found leaks/);
  assert.doesNotMatch(reason, /build step/);
});
