import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { leftToCiRun, selfVerification, verifyWorkingTree } from '../src/cli/verify.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { submissionPolicyRule } from '../src/master/harness.js';
import { environmentKinds } from '../src/master/profiles.js';

/** A throwaway git checkout with one commit, so verify has a HEAD to bind its record to. */
async function gitCheckout(root: string) {
  const workdir = join(root, 'work');
  await mkdir(workdir, { recursive: true });
  execFileSync('git', ['init', '-q', workdir]);
  execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', workdir, 'config', 'user.name', 'T'], { stdio: 'ignore' });
  await writeFile(join(workdir, 'README.md'), '# Test\n');
  execFileSync('git', ['-C', workdir, 'add', '.']);
  execFileSync('git', ['-C', workdir, 'commit', '-q', '-m', 'init']);
  return workdir;
}

test('unit:verify-sandbox-left-to-ci — a criterion\'s own failing test blocks, a sandbox-only crash around passing cases is left to CI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verify-sandbox-scope-'));
  try {
    const workdir = await gitCheckout(root);
    const tests = join(workdir, 'tests');
    await mkdir(tests, { recursive: true });
    // The ordinary shape: the item plans production code only, and its criterion's proof lives in a
    // test file no planned file names. Its own case fails, so its criterion fails — the file being
    // outside planned files never excuses it.
    await writeFile(join(tests, 'own.test.ts'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('unit:own-criterion fails on its own case', () => { assert.equal(1, 2); });
`);
    // The sandbox shape: every case of the proof passes, and an unrelated suite crashing around
    // them — a hook a nested sandbox trips, reported against the file — fails the run, not the proof.
    await writeFile(join(tests, 'sandbox.test.ts'), `
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
test('unit:sandbox-proof passes every case of its own', () => { assert.ok(true); });
after(() => { throw new Error('nested-sandbox probe crashes the run around the proof'); });
`);
    // Both at once: the proof's own case fails and the run also crashes around it. The crash never
    // excuses the proof's own failure.
    await writeFile(join(tests, 'both.test.ts'), `
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
test('unit:crashed-own-failure fails on its own case', () => { assert.equal(1, 2); });
after(() => { throw new Error('nested-sandbox probe crashes the run around the proof'); });
`);
    execFileSync('git', ['-C', workdir, 'add', '.']);
    execFileSync('git', ['-C', workdir, 'commit', '-q', '-m', 'proofs']);

    const record = await verifyWorkingTree({
      key: 'GY-TEST',
      criteria: [
        { id: 'AC-1', proofs: ['unit:own-criterion'] },
        { id: 'AC-2', proofs: ['unit:sandbox-proof'] },
        { id: 'AC-3', proofs: ['unit:crashed-own-failure'] },
      ],
    }, workdir);

    const own = record.ran.find(entry => entry.proof === 'unit:own-criterion');
    assert.equal(own?.result, 'fail', 'the criterion\'s own failing case fails its proof');
    assert.ok(!own?.leftToCi, 'a criterion\'s own failing test is never left to CI, whatever file it lives in');
    const sandbox = record.ran.find(entry => entry.proof === 'unit:sandbox-proof');
    assert.equal(sandbox?.result, 'fail', 'the crashed run fails even though the proof\'s cases passed');
    assert.ok((sandbox?.executed ?? 0) > 0 && sandbox?.failed === 0, 'the proof\'s own cases all passed');
    assert.ok(sandbox?.leftToCi, 'a run whose proof cases all passed but which crashed around them is left to CI');
    assert.match(String(sandbox?.abnormal), /not as a test case/, 'the deferral names the run failure the proof\'s cases did not cause');

    const both = record.ran.find(entry => entry.proof === 'unit:crashed-own-failure');
    assert.equal(both?.result, 'fail');
    assert.ok(both?.abnormal, 'the run around the proof also crashed');
    assert.ok(!both?.leftToCi, 'an abnormal run never excuses a failed case of the proof itself');
    // The counts decide, not the abnormal exit alone: a failed, skipped or unexecuted case blocks.
    const crashed = { result: 'fail' as const, abnormal: 'after hook threw', executed: 1, failed: 0, skipped: 0 };
    assert.equal(leftToCiRun(crashed), true);
    assert.equal(leftToCiRun({ ...crashed, failed: 1 }), false, 'a failed case of the proof blocks');
    assert.equal(leftToCiRun({ ...crashed, skipped: 1 }), false, 'a skipped case of the proof blocks');
    assert.equal(leftToCiRun({ ...crashed, executed: 0 }), false, 'a proof that never executed blocks');
    assert.equal(leftToCiRun({ ...crashed, abnormal: undefined }), false, 'a plain failure is not a sandbox crash');
    // What complete reports: the item's own criteria did not pass, and the deferral never hides that.
    const failing = await selfVerification(workdir, 'GY-TEST');
    assert.equal(failing.state, 'failing');
    assert.equal(failing.ran.find(entry => entry.proof === 'unit:sandbox-proof')?.leftToCi, true);

    // With the criterion's own test passing, the deferred run is named as left to CI instead of
    // being claimed as a pass.
    await verifyWorkingTree({ key: 'GY-TEST-CI', criteria: [{ id: 'AC-2', proofs: ['unit:sandbox-proof'] }] }, workdir);
    const deferred = await selfVerification(workdir, 'GY-TEST-CI');
    assert.equal(deferred.state, 'passing', 'the item\'s own criteria passed');
    assert.match(deferred.reason, /left to CI/, 'the report names the deferred run as left to CI');
    assert.match(deferred.reason, /unit:sandbox-proof/, 'the report names the deferred proof');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:worker-submits-sandbox-failures-to-ci — every worker runtime\'s launch prompt carries the submission policy', () => {
  const config = { cliPath: '/graphyard/bin/graphyard.mjs' };
  const work = { key: 'GY-853', title: 'Workers submit when their own criteria pass; sandbox-only suite failures outside their files go to CI, not a self-block' };
  // One prompt builder serves every runtime the launcher configures, so the rule is asserted on the
  // prompt each of them receives.
  for (const kind of environmentKinds) {
    const prompt = workerPrompt(config, work, { principal: `graphyard-${kind}-worker` }, 6);
    assert.match(prompt, /full test suite is CI's gate/, `${kind}: the prompt states the full suite is CI's gate`);
    assert.match(prompt, /run the build and the tests for your own criteria/, `${kind}: the prompt names what the worker runs`);
    assert.match(prompt, /submit with complete/, `${kind}: the prompt says to submit when its own criteria pass`);
    assert.match(prompt, /naming in the pull request any full-suite failures that come only from your sandbox and lie outside your planned files/, `${kind}: the prompt says to name sandbox-only failures in the pull request`);
    assert.match(prompt, /instead of recording a blocker/, `${kind}: the prompt rules out a blocker for sandbox-only failures`);
  }
  // The prompt's rule is the harness's own exported policy text, so the harness rules and the
  // launch prompt cannot drift apart.
  assert.equal(submissionPolicyRule.trim().length > 0, true);
  assert.match(submissionPolicyRule, /full test suite is CI's gate/);
});
