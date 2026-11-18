import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heavyTrial } from '../src/daemon/cycle-merge-writer.js';
import { acquireVerificationSlot, gateSlot, heldSlots, projectVariable, slotsDirectoryVariable, type HeldSlot } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3460: overnight on 18 November the host's one heavy-job slot went, release after release, to
// newer core trials, while another install's reviewed candidate (Lumina GY-30) and a worker's
// verification waited over an hour: a freed slot went to whichever poller looked first. Waiters now
// queue across installs, and a freed slot goes to the oldest.

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 20_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(10); }
}
const ordinary = (directory: string) => heldSlots(directory).filter(entry => entry.slot < gateSlot);
const previous = { ...process.env }, stop = new AbortController();
after(() => { stop.abort(); process.env[slotsDirectoryVariable] = previous[slotsDirectoryVariable]; process.env[projectVariable] = previous[projectVariable]; });

/** One host with a budget of one ordinary slot; this process is the first install's loop (`acme/core`). */
async function host(label: string) {
  const scratch = await temporaryDirectory(label), directory = join(scratch, 'heavy-jobs');
  mkdirSync(directory);
  writeFileSync(join(directory, 'limit'), '1\n');
  process.env[slotsDirectoryVariable] = directory;
  process.env[projectVariable] = 'acme/core';
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, ordinary(directory).length); }, 2);
  after(() => clearInterval(watch));
  return { scratch, directory, peak: () => Math.max(peak, ordinary(directory).length) };
}

/** The second install's loop, its own process: one heavy job through `entry` (`withHeavyJob` or the merge writer's `heavyTrial`), running until `go-<id>` exists. */
function secondInstall(fixture: Awaited<ReturnType<typeof host>>, entry: 'verification' | 'trial', id: string) {
  const started = join(fixture.scratch, `started-${id}`), go = join(fixture.scratch, `go-${id}`), source = (path: string) => JSON.stringify(join(import.meta.dirname, '..', path));
  const job = `async () => { writeFileSync(${JSON.stringify(started)}, ''); while (!existsSync(${JSON.stringify(go)})) await new Promise(done => setTimeout(done, 10)); }`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
    ${entry === 'trial'
      ? `import { heavyTrial } from ${source('src/daemon/cycle-merge-writer.ts')}; await heavyTrial(${JSON.stringify(id)}, step => console.error(step), undefined, ${job});`
      : `import { withHeavyJob } from ${source('src/master/verification-slots.ts')}; await withHeavyJob('worker verification ${id}', ${job});`}
  `], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, [slotsDirectoryVariable]: fixture.directory, [projectVariable]: 'acme/site' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  after(() => { child.kill('SIGKILL'); });
  return { started: () => existsSync(started), waiting: () => /waiting for a host heavy-job slot|waits for a host heavy-job slot/.test(stderr), finish: async () => { writeFileSync(go, ''); await closed; }, stderr: () => stderr };
}

/** A first-install job arriving now and polling fast, as a newly launched trial does the moment a slot frees. */
function arrival(fixture: Awaited<ReturnType<typeof host>>, label: string) {
  let held: HeldSlot | null = null;
  const taken = acquireVerificationSlot({ directory: fixture.directory, label, project: 'acme/core', pollMs: 5, signal: stop.signal }).then(slot => { held = slot; return slot; });
  taken.catch(() => {});
  return { taken, held: () => held };
}

test('integration:shared-heavy-job-fairness — with one shared slot, a second install\'s older worker verification gets the freed slot ahead of the first install\'s newer arrivals, which then run oldest first, never more than the limit at once', { timeout: 120_000 }, async () => {
  const fixture = await host('heavy-fairness');
  const first = await acquireVerificationSlot({ directory: fixture.directory, label: 'merge trial GY-3450', project: 'acme/core' });
  const verification = secondInstall(fixture, 'verification', 'GY-30');
  await until(verification.waiting, 'the second install\'s worker verification waits');
  // The first install keeps submitting while the slot is held.
  const next = arrival(fixture, 'merge trial GY-3465');
  await sleep(50);
  const later = arrival(fixture, 'merge trial GY-3466');
  await sleep(50);
  first.release();
  await until(() => verification.started() || !!next.held() || !!later.held(), 'the freed slot is taken');
  await sleep(200);
  assert.equal(verification.started(), true, 'the older waiter from the other install takes the freed slot');
  assert.equal(next.held() ?? later.held(), null, 'no newer arrival overtakes it');
  await verification.finish();
  (await next.taken).release();
  await later.taken;
  assert.ok(next.held() && later.held(), 'the first install\'s jobs run in arrival order');
  later.held()!.release();
  assert.equal(fixture.peak(), 1, 'never more than the host limit at once');
});

test('e2e:shared-heavy-job-fairness — a reviewed candidate from a second install gets its merge trial when the shared slot frees, while the first install keeps submitting trials and its batch gate runs at once in the reserved slot', { timeout: 120_000 }, async () => {
  const fixture = await host('heavy-fairness-e2e');
  const holder = await acquireVerificationSlot({ directory: fixture.directory, label: 'merge trial GY-3450', project: 'acme/core' });
  const candidate = secondInstall(fixture, 'trial', 'GY-31');
  await until(candidate.waiting, 'the candidate\'s trial waits for the shared slot');
  // The first install submits a new trial every 20 ms, before and after the slot frees.
  const submitted: ReturnType<typeof arrival>[] = [];
  let submitting = true;
  const stream = (async () => { for (let n = 0; submitting; n++) { submitted.push(arrival(fixture, `merge trial GY-${4000 + n}`)); await sleep(20); } })();
  try {
    await sleep(100);
    // The batch gate is the deploy path: it starts at once in its reserved slot, ahead of every waiter.
    let gateRan = false;
    await heavyTrial('batch-gate', undefined, undefined, async () => { gateRan = true; }, undefined, true);
    assert.equal(gateRan, true, 'the batch gate ran at once in the reserved slot');
    holder.release();
    await until(() => candidate.started() || submitted.some(job => job.held()), 'the freed slot is taken');
    await sleep(200);
    assert.equal(candidate.started(), true, 'the second install\'s candidate trial runs');
    assert.equal(submitted.some(job => job.held()), false, 'none of the first install\'s newer trials overtook it');
  } finally { submitting = false; await stream; }
  await candidate.finish();
  for (const job of submitted) (await job.taken).release();
  assert.equal(fixture.peak(), 1, 'never more than the host limit of ordinary jobs at once');
});
