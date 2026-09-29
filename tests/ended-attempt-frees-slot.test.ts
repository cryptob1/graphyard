import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definiteRenewalRefusal, supervise } from '../src/supervisor.js';

// GY-894 AC-1: when an implementation attempt ends (submitted, blocked, failed or otherwise
// settled), the supervisor terminates the session runtime so the Herdr agent name and the worker
// profile slot free within one liveness interval, without a human or the master sending keys.
//
// The attempt ends on the server: `complete` clears the lease, so the supervisor's next renewal
// is refused (409). The refusal is therefore the supervisor's signal to stop the session — and it
// is also why the supervisor must not surrender: the server already recorded the attempt's end,
// so blocked/release posts for an epoch whose lease is gone would record a false cause on the
// ledger and are refused. Terminating the runtime is what frees the name and the slot.

const leaseMs = 120_000;
const renewal = () => ({ updatedAt: new Date().toISOString(), lease: { epoch: 2, expiresAt: new Date(Date.now() + leaseMs).toISOString() } });
/** The refusal a submitted attempt's next heartbeat carries (src/model/refusal.ts: 409 Conflict). */
const submittedRefusal = () => Promise.reject(Object.assign(new Error('GY-894 epoch 2 ended when the implementation was submitted'), { status: 409 }));

test('unit:ended-attempt-frees-slot — a submitted attempt ends the session: the supervisor terminates the runtime and frees the name within one liveness interval', async () => {
  let killed = false, renewals = 0, settled = 0;
  const surrendered: string[] = [], signals: NodeJS.Signals[] = [];
  // The containment scope holds the session runtime: alive until the supervisor signals it, then
  // verified empty. The signals are the supervisor's own, never a human's keystrokes. The scope's
  // command is what the supervisor spawns, so it names a real runtime; the child is a stub that
  // lives a moment past the test, since only the supervisor's own judgement ends this attempt.
  const child = { command: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 800)"] };
  const containment = {
    ...child,
    signal: (signal: NodeJS.Signals) => { signals.push(signal); killed = true; },
    empty: () => killed,
  };
  // Herdr lists the session while the runtime runs; the name is gone once it is dead.
  const visible = () => !killed;
  const started = performance.now();
  const code = await supervise(child.command, child.args, 2,
    async () => { renewals++; return renewals < 3 ? renewal() : submittedRefusal(); },
    { containment, detached: false, intervalMs: 20, graceMs: 25, shutdownPollMs: 5,
      session: { visible, surrender: async cause => { surrendered.push(cause); } },
      quarantine: { establish: async () => {}, settle: async () => { settled++; } } });
  const elapsed = performance.now() - started;

  assert.equal(code, 1, 'the supervisor stopped the worker whose attempt the server ended');
  assert.ok(renewals >= 3, `the supervisor renewed until the server refused the submitted attempt (${renewals} renewals)`);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'the session runtime is terminated through its containment scope, without a human or the master sending keys');
  assert.equal(settled, 1, 'the shutdown settles the containment quarantine, so nothing fences the freed item');
  assert.equal(visible(), false, 'the Herdr agent name is gone once the runtime is dead, so the worker profile slot is free');
  assert.ok(elapsed < leaseMs, `the slot freed at ${Math.round(elapsed)} ms, inside one ${leaseMs} ms lease period and one liveness interval`);
  assert.deepEqual(surrendered, [], 'the server already ended the submitted attempt, so the supervisor records no surrender for an epoch whose lease is gone');
  // Nothing is renewed again once the attempt has ended.
  const renewalsAtEnd = renewals;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(renewals, renewalsAtEnd, 'nothing is renewed after the attempt has ended');
});

test('unit:ended-attempt-frees-slot — a 409 after a submission is a definite refusal, a transient failure is not', () => {
  // The proof above depends on the refusal being definite: a 409 Conflict is the server's answer
  // that the epoch no longer holds a lease, so the supervisor stops instead of retrying. A
  // transient failure says nothing about the attempt and must never end it.
  assert.equal(definiteRenewalRefusal(Object.assign(new Error('GY-894 epoch 2 ended when the implementation was submitted'), { status: 409 })), true);
  assert.equal(definiteRenewalRefusal(new TypeError('fetch failed')), false);
});
