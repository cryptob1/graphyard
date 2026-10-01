import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type ContainmentAssessment, type MasterConfig } from '../src/master.js';
import { actionableSubjects, emptyDaemonState, loopAttention, loopLiveness, trackSilence, type DaemonState } from '../src/master-daemon.js';

// GY-426: three loop-silence faults in a day (GY-393, GY-402, GY-404) shared one cause. The silence
// measure counted as the loop's own a wait that belonged to another owner, one no cycle of the loop
// could end, so past twenty minutes it said "nothing has acted" and filed a loop fault:
//
// - GY-393: a lapsed containment quarantine this host could not verify dead (the launch's
//   supervisor scope still held a process). The loop escalated it with its refusals; the
//   containment class carries it. There was no settle for the loop to perform.
// - GY-402: proofs for a head the build gate refused (a conflict with the moved base). The
//   control plane cancels producers for such a head; the wait was the build's.
// - GY-404: proofs a producer request pending for the head answered for, within the producer
//   timeout. The dispatcher owned that wait, bounded like every obligation the control plane holds.
//
// Each instance is replayed through the loop's own measure for longer than the bound and must not
// breach it, while a subject the loop does own still breaches: the bound is not weakened.

const clock = Date.parse('2030-01-01T12:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const head = 'b'.repeat(40), base = 'a'.repeat(40);

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });
}
const gate = (name: string, passed: boolean, reasons: string[] = []) => ({ name, passed, reasons: passed ? [] : reasons });
function item(key: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 1, policyRevision: 1,
    createdAt: iso(clock - 3 * 60 * minute), updatedAt: iso(clock), stageEnteredAt: iso(clock - 60 * minute), ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}
/** A submitted head missing unit evidence, with its build gate as given. */
function submitted(key: string, build: boolean, overrides: Partial<Work> = {}): Work {
  return item(key, {
    criteria: [{ id: 'AC-1', text: 'unit proof', proofs: ['unit:a', 'unit:b'] }] as Work['criteria'],
    submission: { epoch: 1, pr: 221, submittedAt: iso(clock - 2 * minute) } as unknown as Work['submission'],
    candidate: { sha: head, baseSha: base, pr: 221 } as unknown as Work['candidate'],
    gates: [gate('ready', true), gate('build', build, ['Candidate cannot be brought onto base branch tip without resolving a conflict']), gate('review', false, ['Independent approval of the current commit is required']),
      gate('acceptance', false, ['AC-1: unit:a needs trusted passing evidence'])] as Work['gates'],
    ...overrides,
  });
}
const producerRequest = (requestedAt: number) => ({ id: 'request-1', pr: 221, sha: head, baseSha: base, kind: 'producer', group: 'unit', state: 'requested',
  proofs: ['unit:a', 'unit:b'], reason: 'no trusted evidence binds the head', requestedAt: iso(requestedAt), policyRevision: 1 });
function quarantined(key: string): Work {
  return item(key, {
    workspaces: [{ host: 'machine-a', path: `/repo/.graphyard/worktrees/${key}-1`, epoch: 1, owner: 'graphyard-codex-2', branch: `graphyard/${key.toLowerCase()}-1` }] as Work['workspaces'],
    containmentQuarantine: { owner: 'graphyard-codex-2', epoch: 1, at: iso(clock - 30 * minute), settlementHash: 'c'.repeat(64),
      leaseExpiresAt: iso(clock - 25 * minute), launchExpiresAt: iso(clock - 28 * minute), launchAcknowledgedAt: iso(clock - 30 * minute) } as Work['containmentQuarantine'],
  });
}
const assessment = (work: Work, settleable: boolean): ContainmentAssessment => ({ key: work.key, id: work.id, epoch: 1, owner: 'graphyard-codex-2', at: iso(clock - 30 * minute),
  host: 'machine-a', workspacePath: work.workspaces[0].path, scope: null, settleable,
  refusals: settleable ? [] : ['The supervisor scope still holds process 4242 (the pane shell the failed launch left behind)'], attestation: '', verification: null });

/** Cycles every thirty seconds for `span`, acting on nothing, as the loop measures them; the attention it would raise at the end. */
function replay(work: Work[], span: number, context: Parameters<typeof actionableSubjects>[3] = {}) {
  const master = config();
  // A record of its own: the schema's default silence object is one shared value.
  const state: DaemonState = { ...emptyDaemonState(master), silence: { subjects: {}, lastActionAt: null } };
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(clock), heartbeatAt: iso(clock) } as DaemonState['lock'];
  let silence = trackSilence(state, actionableSubjects(master, work, clock, context), [], clock);
  for (let at = clock; at <= clock + span; at += 30_000) {
    silence = trackSilence(state, actionableSubjects(master, work, at, context), [], at);
    state.lastCycleAt = iso(at);
  }
  const liveness = loopLiveness(state, clock + span, master.run.intervalSeconds * 1000);
  return { silence, attention: loopAttention({ liveness, silence }).filter(entry => entry.kind === 'loop-silence') };
}
const span = 60 * minute;

test('GY-426 GY-393: a lapsed quarantine this host cannot verify dead is the containment class, not the loop\'s silence', () => {
  const work = quarantined('GY-393');
  const unverifiable = replay([work], span, { assessments: { [work.id]: assessment(work, false) } });
  assert.deepEqual(unverifiable.silence.subjects.filter(subject => subject.kind === 'settle'), [], 'no settle is the loop\'s to perform');
  assert.deepEqual(unverifiable.attention, [], 'an hour on it files no loop fault');
  // Another host's quarantine is that host's loop to settle: nothing here can act on it either.
  assert.deepEqual(replay([work], span, { assessments: {} }).attention, []);
  // One this host verified dead is the loop's to settle, and an hour without settling it still breaches.
  const settleable = replay([work], span, { assessments: { [work.id]: assessment(work, true) } });
  assert.equal(settleable.attention.length, 1);
  assert.match(settleable.attention[0].text, /Nothing has acted on GY-393 holds a lapsed containment quarantine from epoch 1 for 60 minutes, past the 20-minute bound/);
});

test('GY-426 GY-402: a head the build gate refuses is owed no proof, so its missing evidence is not the loop\'s silence', () => {
  const conflicting = replay([submitted('GY-402', false)], span);
  assert.deepEqual(conflicting.silence.subjects.filter(subject => subject.kind === 'proof'), [], 'no proof is the loop\'s to request for a head the build refuses');
  assert.deepEqual(conflicting.attention, []);
  // The same head past its build gate, with nobody producing its proofs, is still the loop's and still breaches.
  const unowned = replay([submitted('GY-402', true)], span);
  assert.equal(unowned.attention.length, 1);
  assert.match(unowned.attention[0].text, /Nothing has acted on GY-402 is missing trusted evidence for unit:a, unit:b for 60 minutes/);
});

test('GY-426 GY-404: proofs a pending producer request answers for are the dispatcher\'s wait, bounded by the producer timeout', () => {
  const requested = clock - minute;
  const pending = submitted('GY-404', true, { autoDispatch: { review: null, producers: [producerRequest(requested)], history: [] } as unknown as Work['autoDispatch'] });
  const owned = replay([pending], span);
  assert.deepEqual(owned.silence.subjects.filter(subject => subject.kind === 'proof'), [], 'the pending request owns the proofs it names');
  assert.deepEqual(owned.attention, [], 'an hour waiting on a producer inside its timeout files no loop fault');
  // Past the producer timeout (120 minutes by default) the request no longer answers for them: the
  // proofs are the loop's again and their wait is measured from there.
  const expired = replay([pending], 150 * minute);
  assert.equal(expired.attention.length, 1);
  assert.match(expired.attention[0].text, /Nothing has acted on GY-404 is missing trusted evidence for unit:a, unit:b/);
  // A request for another head answers for nothing on this one.
  const stale = submitted('GY-404', true, { autoDispatch: { review: null, producers: [{ ...producerRequest(requested), sha: 'd'.repeat(40) }], history: [] } as unknown as Work['autoDispatch'] });
  assert.equal(replay([stale], span).attention.length, 1);
});
