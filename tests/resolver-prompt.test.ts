import { test } from 'node:test';
import assert from 'node:assert/strict';
// A namespace import, so on a tree without the extension each allowlist case fails as a case.
import * as pi from '../integrations/pi/index.js';
import { boundedInput, doctorBounds, doctorDue, doctorIntervalMs, doctorPrompt, type DoctorInput } from '../src/daemon/doctor.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import { workerReclaimBoundMs, workerSubmissionBoundMs } from '../src/model/attempt-bound.js';

// GY-2004 AC-1 (unit:resolver-prompt): the doctor's prompt is the resolver's short charter. It
// acts on stalled, ready-but-idle, blocked and parked items with the master CLI, never asks a
// person, and files an item only for a code change judged needed — and it fits the length bound.
// Every instant here derives from the test's fixed `now`; the file reads no wall clock.

const minute = 60_000;
const now = 1_800_000_000_000;
const since = (offsetMinutes: number) => new Date(now - offsetMinutes * minute).toISOString();
const cli = '/srv/graphyard/bin/graphyard.mjs';
const prompt = (input: DoctorInput = { items: [], faults: [] }) => doctorPrompt({ repository: 'owner/project', cliPath: cli }, input);

test('unit:resolver-prompt — the resolver\'s prompt is short and tells it to act on stalled, ready-but-idle, blocked and parked items with the master CLI, never a person, filing only a needed code change', () => {
  const text = prompt();
  // Short: the whole built prompt, evidence line included, fits the length bound.
  assert.ok(text.split('\n').length < 60, `the resolver prompt is ${text.split('\n').length} lines; the bound is under 60`);
  // The stalls it acts on: the 20-minute idle rule and the worker bound, one declaration behind both.
  assert.match(text, /an unreleased backlog item idle 20 minutes or more/);
  assert.match(text, new RegExp(`more than ${doctorBounds.workerMinutes} min without a submission`));
  assert.equal(doctorBounds.workerMinutes * minute, workerSubmissionBoundMs, 'the worker bound the charter names is the product bound');
  // Ready-but-idle, blocked and parked, each with its master CLI action.
  assert.match(text, /an item ready with no worker/);
  assert.match(text, /a blocked item whose blocker no longer holds/);
  assert.match(text, /a parked item/);
  // The actions: re-dispatch, unblock, rework with a concrete reason, close as obsolete or
  // duplicate with a reason, decide scope or requirements within the item's intent.
  // Release is only for unreleased backlog work (the ready endpoint refuses the rest); an overdue
  // lease-holder is the loop's own reclaim, never a release.
  assert.match(text, /master release GY-N\) and the loop dispatches it; release refuses any other item/);
  assert.match(text, new RegExp(`the loop ends it past ${workerReclaimBoundMs / minute} min and dispatches the item again`));
  assert.doesNotMatch(text.split('\n').find(line => line.includes('holding its lease'))!, /master release/);
  assert.match(text, /master unblock GY-N with a quoted reason/);
  assert.match(text, /send it back for rework with a concrete reason/);
  assert.match(text, /master decide GY-N rework REASON/);
  assert.match(text, /close it with a reason/);
  assert.match(text, /--obsolete/);
  assert.match(text, /--duplicate-of GY-M/);
  assert.match(text, /a scope or requirements ask within the item's intent: decide it/);
  // The charter's discipline: never a person, simplest action, and an item only for a code change.
  assert.match(text, /you never ask a person/);
  assert.match(text, /take the simplest action/);
  assert.match(text, /File an item only for a code change you judge needed, quoting the why after the file/);
  assert.match(text, /the guard refuses a create with no reason stated/, 'the charter names the guard that holds creation to its reason');
  // The failed actions and attention lines are named as things it acts on.
  assert.match(text, /every failed action and attention line below/);
  // The evidence marker stands once, last, so the run's evidence is exactly what follows it.
  const marker = 'The evidence, as JSON:\n';
  assert.equal(text.split(marker).length - 1, 1, 'the evidence section begins once');
  assert.ok(text.endsWith(JSON.stringify(boundedInput({ items: [], faults: [] }))), 'the evidence JSON is the prompt\'s last line');
});

test('unit:resolver-prompt — the built prompt carries every sanctioned command, and the loop\'s failed actions and attention lines reach the evidence it reads', () => {
  const text = prompt();
  for (const command of ['scope', 'requirements', 'unblock', 'decide', 'approver', 'settle-containment', 'close', 'create', 'release', 'checkout-restore']) {
    assert.ok(text.includes(`master ${command}`), `the charter names master ${command}`);
  }
  const evidence: DoctorInput = {
    items: [`GY-7 [blocked since ${since(30)} blocker: scope refused]`],
    faults: [`${since(5)} launch on GY-7: the launch was never acknowledged`],
    failedActions: [`${since(4)} dispatch on GY-7: the worker profile was held by a live attempt`],
    attention: ['loop: Cycle 12 spent 90s on its own work, longer than the 10s interval'],
  };
  const withEvidence = prompt(evidence);
  const parsed = JSON.parse(withEvidence.slice(withEvidence.indexOf('The evidence, as JSON:\n') + 'The evidence, as JSON:\n'.length)) as DoctorInput;
  assert.ok(parsed.items.some(line => line.includes('GY-7')), 'the stalled item reaches the evidence');
  assert.ok(parsed.failedActions?.some(line => line.includes('the worker profile was held')), 'the loop\'s failed actions reach the evidence');
  assert.ok(parsed.attention?.some(line => line.includes('Cycle 12')), 'the loop\'s attention lines reach the evidence');
  // The bound drops whole lines from the end, and the omitted note says so, as before.
  const bounded = boundedInput({ items: [], faults: [], failedActions: ['a'.repeat(60_000), 'b'.repeat(60_000)], attention: ['kept'] }, 70_000);
  assert.ok((bounded.failedActions?.length ?? 0) < 2, 'the bounding drops lines from the failed actions too');
  assert.match(bounded.omitted ?? '', /line\(s\) left out to fit the evidence bound/);
  assert.deepEqual(bounded.attention, ['kept'], 'the attention lines are bounded last');
});

// GY-2005 AC-2 (unit:resolver-allowlist): the resolver's powers are its allowlist grammar —
// re-dispatch, unblock, rework, close, scope and decide run; item creation is refused with no
// reason stated past the file — and its cadence is the five-minute interval plus the progress
// watchdog's due mark. Every instant here derives from the test's fixed `now`.
test('unit:resolver-allowlist — the allowlist permits re-dispatch, unblock, rework, close, scope and decide, refuses creation without a stated code-change reason, and the schedule is five minutes plus the watchdog', () => {
  const context = { cwd: process.cwd(), cli };
  // The six sanctioned intents, as the prompt teaches them, run under the guard.
  for (const line of [
    `node ${cli} master release GY-7 'unreleased backlog item idle 25 min'`,
    `node ${cli} master unblock GY-7 'the scope refusal was granted'`,
    `node ${cli} master decide GY-7 rework 'the candidate fails the trial merge on tests/x'`,
    `node ${cli} master close GY-7 --obsolete 'the delivered GY-2 fixed it'`,
    `node ${cli} master close GY-7 --duplicate-of GY-2 'same cause, one item'`,
    `node ${cli} master scope GY-7 'adds the test the criterion names'`,
    `node ${cli} master decide GY-7 unblock 'the ask is within the item'`,
  ]) assert.equal(pi.doctorCommandVerdict(line, context).allow, true, `${line} is sanctioned`);
  // A create with nothing stated past the file is refused at the gate, so a notice never files an item.
  for (const line of [`node ${cli} master create plan.json`, `graphyard master create plan.json`, `node ${cli} master create plan.json --allow-broad-scope`]) {
    const verdict = pi.doctorCommandVerdict(line, context);
    assert.equal(verdict.allow, false, `${line} is refused`);
    if (!verdict.allow) {
      assert.match(verdict.reason, /create-reason rule/);
      assert.match(verdict.reason, /no reason stated past the file/);
    }
  }
  const stated = pi.doctorCommandVerdict(`node ${cli} master create plan.json 'the retry loop drops submissions and needs a code change'`, context);
  assert.equal(stated.allow, true, 'a create with the why stated past the file runs');
  // The schedule: five minutes by default, read by the due check over run.doctor.intervalMinutes.
  const settings = doctorSettingsSchema.parse({});
  assert.equal(settings.intervalMinutes, 5, 'the resolver runs every five minutes by default');
  assert.equal(doctorIntervalMs(settings), 5 * minute, 'the due check reads the five-minute interval');
  const lastRun = (offsetMinutes: number) => ({ doctor: { runs: [{ at: since(offsetMinutes), state: 'reported' as const, runs: [], findings: [], actions: [], filed: [], detail: '' }] } });
  assert.equal(doctorDue(lastRun(4), now, settings), false, 'four minutes after a run the resolver waits');
  assert.equal(doctorDue(lastRun(5), now, settings), true, 'five minutes after a run the resolver is due');
  // And at once when the loop's progress watchdog fired: the mark is due inside the interval,
  // while the guards it must not cross still hold.
  const marked = { doctor: { ...lastRun(1).doctor, watchdogDue: true } };
  assert.equal(doctorDue(marked, now, settings), true, 'the watchdog mark is due inside the interval');
  const inFlight = { doctor: { ...marked.doctor, runs: [{ ...marked.doctor.runs[0], state: 'running' as const }] } };
  assert.equal(doctorDue(inFlight, now, settings), false, 'a run in flight is never overlapped, watchdog or not');
  assert.equal(doctorDue(marked, now, { ...settings, enabled: false }), false, 'the watchdog never starts a doctor that is off');
});
