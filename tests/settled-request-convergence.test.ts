import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Observation, Work } from '../src/model.js';
import type { DispatchRequest } from '../src/model/dispatch.js';
import { requestAttemptLimit, settledAnswerGraceMs, unansweredRequest, type RequestProgress } from '../src/model/dispatch.js';
import { buildMasterStatus } from '../src/master.js';
import { sessionRetries } from '../src/producer.js';
import { unansweredRequestAttention } from '../src/cli/master-status.js';
import { classifyAttention } from '../src/model/fault-classes.js';

// GY-533: manual:fault-class-session-liveness. Three session-liveness faults in 24 hours, each an
// `unanswered-request` on a producer request whose single session had just settled `completed`:
//   GY-523 07:41:43Z — unit proofs, trusted passing evidence recorded, the request 25s old;
//   GY-368 07:38:33Z — manual proofs, trusted passing evidence recorded, the request 1m old;
//   GY-491 07:37:13Z — unit proofs, evidence recorded as not exercising its criterion, 8m old.
// Their shared cause: a settled session was judged unanswered the moment it settled, and every
// such request read "no further attempt is scheduled" whatever answered it — its evidence being
// read, the relaunch the loop owes it on its next tick (GY-193), or the rework decision its
// unexercised evidence calls for (GY-193 AC-3). Against the base each instance below is a
// session-liveness fault; against the change none is.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('c5'), B = sha40('b5');
const iso = (at: number) => new Date(at).toISOString();

function observation(key: string, candidate: { sha: string; baseSha: string }, at: string): Observation {
  return { candidate: { ...candidate, pr: 500, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
/** A submitted candidate with one live producer request for `group` proofs, requested at `requestedAt`. */
function item(key: string, group: 'unit' | 'manual', proofs: string[], requestedAt: number, evidence: Evidence[] = []): { work: Work; request: DispatchRequest } {
  const at = iso(requestedAt - 60_000), candidate = { sha: H, baseSha: B, pr: 500, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  const request: DispatchRequest = { id: `${key}-producer`, kind: 'producer', sha: H, baseSha: B, policyRevision: 1, pr: 500, group, proofs, requestedAt: iso(requestedAt), reason: `${group} proofs requested`, state: 'requested' };
  const work = { id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'The behaviour', proofs }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'test', revision: 5, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: `/w/${key}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr: 500 }, reworkRequested: false, scenarioRequirements: [], evidence, observation: observation(key, candidate, at), blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'acceptance', passed: false, reasons: ['AC-1 needs trusted passing evidence'] }], violations: [],
    autoDispatch: { review: null, producers: [request], history: [] } } as unknown as Work;
  return { work, request };
}
/** The producer ledger's record of the request's one session, as `summarizeProducers` reports it. */
const settled = (request: DispatchRequest, startedAt: number, closedAt: number, resolution: string, attempt = 1) => ({ producer: `${request.id}-s${attempt}`, requestId: request.id, attempt, work: '', pr: 500, sha: H, policyRevision: 1,
  group: request.group, proofs: request.proofs, profile: 'claude-producer', principal: 'graphyard-producer', agentName: 'proof-claude-1', state: 'completed', outcome: 'done', requestedAt: iso(startedAt),
  expiresAt: iso(startedAt + 3_600_000), closedAt: iso(closedAt), resolution, attention: null, delivery: null, activity: null, acknowledgedAt: iso(startedAt + 5000), repromptedAt: null, neverStarted: false });

/** What `master status` and the loop's fault counter make of the rows at `now`: the path both read (master-status.ts `derivedAttention`). */
function faults(rows: { work: Work; records: ReturnType<typeof settled>[] }[], now: number) {
  const records = rows.flatMap(row => row.records);
  const status = buildMasterStatus({ work: rows.map(row => row.work), now: iso(now) }, [], [], {}, {}, { pending: [], completed: [] }, 'main', undefined,
    { producers: { pending: [], completed: records }, failures: [], retries: sessionRetries(records.map(record => ({ ...record })), now) });
  return classifyAttention(unansweredRequestAttention(status.work));
}

// The three instances, at the times the loop recorded them.
const gy523At = Date.parse('2026-09-26T07:41:43.095Z'), gy368At = Date.parse('2026-09-26T07:38:33.294Z'), gy491At = Date.parse('2026-09-26T07:37:13.798Z');
const gy523 = (() => {
  const { work, request } = item('GY-523', 'unit', ['unit:attestation-carries-exercise'], gy523At - 25_000);
  return { work, records: [settled(request, gy523At - 24_000, gy523At - 5_000, 'trusted passing evidence recorded for unit:attestation-carries-exercise')] };
})();
const gy368 = (() => {
  const { work, request } = item('GY-368', 'manual', ['manual:review-followups-triaged'], gy368At - 60_000);
  return { work, records: [settled(request, gy368At - 58_000, gy368At - 10_000, 'trusted passing evidence recorded for manual:review-followups-triaged')] };
})();
const finding = 'unit:report-pool-isolated does not exercise AC-2: it passed against the tree with "Report reads routed back to store.pool" removed as well as against the change';
const gy491 = (() => {
  const unexercised: Evidence = { id: 'ev-unexercised', proof: 'unit:report-pool-isolated', sha: H, baseSha: B, policyRevision: 1, producer: 'graphyard-producer', trusted: false, result: 'pass', executed: 4, skipped: 0,
    at: iso(gy491At - 8 * 60_000 + 50_000), unexercised: finding } as Evidence;
  const { work, request } = item('GY-491', 'unit', ['unit:report-pool-isolated'], gy491At - 8 * 60_000, [unexercised]);
  return { work, records: [settled(request, gy491At - 8 * 60_000 + 2_000, gy491At - 8 * 60_000 + 55_000, `evidence does not exercise its criterion: ${finding}, so it is recorded untrusted`)] };
})();

test('manual:fault-class-session-liveness — a producer request whose session just settled with trusted evidence is an answer in progress, not an unanswered request (GY-523, GY-368)', () => {
  assert.deepEqual(faults([gy523], gy523At), [], 'GY-523: evidence recorded 5s ago resolves the request on the next observation');
  assert.deepEqual(faults([gy368], gy368At), [], 'GY-368: evidence recorded 10s ago resolves the request on the next observation');
  // Still an answer in progress at the edge of the grace, and named once it has passed.
  assert.deepEqual(faults([gy368], gy368At - 10_000 + settledAnswerGraceMs - 1), []);
  const late = faults([gy368], gy368At - 10_000 + settledAnswerGraceMs + 60_000);
  assert.equal(late.length, 1, 'a request its settled session left standing past the grace is named');
  assert.equal(late[0].kind, 'unanswered-request');
  // ...and the line says what answers it: the relaunch the loop owes it, not "nothing".
  assert.match(late[0].text, /^Producer request for manual proofs for GY-368 has stood unanswered for 6m: its session completed without a verdict after attempt 1 — trusted passing evidence recorded/);
  assert.match(late[0].text, new RegExp(`nothing is running for it, and attempt 2 of ${requestAttemptLimit} has been due on the loop's next dispatch tick since the session settled 6m ago$`));
  assert.doesNotMatch(late[0].text, /no further attempt is scheduled/);
});

test('manual:fault-class-session-liveness — a producer request whose evidence did not exercise its criterion names the rework decision it awaits, a decision fault and not a session one (GY-491)', () => {
  const lines = faults([gy491], gy491At);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].kind, lines[0].faultClass], ['request-remedy', 'decision']);
  assert.doesNotMatch(lines[0].text, /has stood unanswered for|no further attempt is scheduled/);
  assert.match(lines[0].text, /^Producer request for unit proofs for GY-491 awaits the rework decision its evidence calls for, 8m after it was requested: its session completed without a verdict after attempt 1 — evidence does not exercise its criterion/);
  assert.match(lines[0].text, /unit:report-pool-isolated was recorded as not exercising its criterion on this head, so no producer is launched for it again and the loop raises the rework decision instead$/);
  assert.match(lines[0].next!, /graphyard master decide GY-491 rework REASON, then graphyard master approver GY-491 DECISION/);
  assert.equal(lines[0].approvedBy, 'approver');
  // Its wording classifies the same way where a reader drops the kind.
  const [reworded] = classifyAttention([{ subject: lines[0].subject, text: lines[0].text }]);
  assert.equal(reworded.faultClass, 'decision');
  // An unexercised `manual:` proof is re-attested, never reworked.
  const { work, request } = item('GY-374', 'manual', ['manual:x'], gy491At - 8 * 60_000,
    [{ ...gy491.work.evidence[0], proof: 'manual:x', unexercised: 'manual:x does not exercise AC-1' } as Evidence]);
  const [attest] = faults([{ work, records: [settled(request, gy491At - 7 * 60_000, gy491At - 6 * 60_000, 'evidence does not exercise its criterion')] }], gy491At);
  assert.match(attest.text, /awaits the attest decision/);
  assert.match(attest.next!, /graphyard master decide GY-374 attest \{"proof":"manual:x"\} REASON/);
});

test('manual:fault-class-session-liveness — all three instances together raise no session-liveness fault; a request nothing answers still reads so', () => {
  const now = gy523At;
  assert.deepEqual(faults([gy523, gy368, gy491], now).filter(line => line.faultClass === 'session-liveness'), []);
  // A request whose sessions reached the attempt limit is the one nothing will answer, and says so.
  const { work, request } = item('GY-9', 'unit', ['unit:x'], now - 3_600_000);
  const spent = faults([{ work, records: [settled(request, now - 1_800_000, now - 1_200_000, 'the session finished (done) without trusted evidence for unit:x (missing)', requestAttemptLimit)] }], now);
  assert.equal(spent.length, 1);
  assert.equal(spent[0].faultClass, 'session-liveness');
  assert.match(spent[0].text, /after attempt 12 — .*; nothing is running for it and no further attempt is scheduled$/);
  // A failed session whose retry is scheduled is an answer in progress wherever the reader gets its
  // retries — the loop's own attention pass used to hand it none (master-status.ts derivedAttention).
  const progress: RequestProgress = { requestId: 'r', sinceMs: 600_000, session: { state: 'failed', attempt: 1, resolution: 'the run exited 1', settledMs: 400_000 },
    retry: { attempts: 1, limit: 4, nextAt: iso(now + 60_000), exhausted: false } };
  assert.equal(unansweredRequest(progress, 'producer'), null);
});
