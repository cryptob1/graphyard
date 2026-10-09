import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerPrompt } from '../src/master.js';
import { appliedReworkBrief, readReworkDecisions, ReworkDecisionsUnreadError, reworkBriefMax, reworkBriefSection, type ReworkDecisionRow } from '../src/master/rework-brief.js';
import { planeWideFailure } from '../src/model/blocker-class.js';

// GY-1569 names this file for its proof: manual:intervention-pattern-scope-widening-review. Five
// scope-widening interventions were needed at the review stage between 2026-10-02 and 2026-10-09,
// each a master requirements revision that added a criterion and the files it names to
// plannedFiles. Each, judged from the ledger rows it names:
//
//   - GY-1543 (requirements#2407920, requirements#2408030) and GY-1519 (requirements#2412963): the
//     master had already written the findings into applied rework decisions (GY-1543 rework#2407838,
//     #2407882; GY-1519 rework#2411892, #2411974, #2412361), but the worker launched for each round
//     was never told them: its request named the item and its criteria only. Each round resubmitted
//     the same head (GY-1543 26053312, GY-1519 bd5a721c), so the master restated the reason as a new
//     criterion and added the files it names, which the fold reads as a widening. Removed here: the
//     launcher reads the applied rework decision and puts its reason in the worker's request.
//   - GY-1564 (requirements#2439767) and GY-1424 (requirements#2352276): a new defect found after the
//     item was filed (a second unexplained shadow disagreement; production serving read from a
//     lagging deployment record) was added as a new criterion. That is a requirements change the
//     item did not yet carry, not a step the product skipped, so nothing removes it; the two left are
//     under the threshold of 3 in 7 days.

// The reasons of the applied rework decisions, as the ledger's rework rows record them.
const reasons = {
  'GY-1543-2407838': "Reviewer findings at head 26053312 (AC-1, BLOCKING) plus CI failures: your cuts removed text that other tests pin verbatim. Restore it and cut equivalent UNPINNED prose elsewhere. (1) docs/onboarding.md must again contain 'the loop's single re-prompt' and 'the reviewer's reminder' (tests/launch-prompt-delivery.test.ts:496) and whatever manual:launch-authorization-onboarding-review reads. (2) docs/operations-reference.md must again contain '55% own-change', '33% conflicts' and 'raw median 2' (tests/rework-causes.test.ts:204-206, unit:rework-rounds-split-by-cause).",
  'GY-1543-2407882': "Attempt 3 resubmitted the SAME head (26053312) with no commit, so CI still fails and the reviewer's blocking findings stand. You MUST make a new commit. Exact edits needed against your current head: (A) docs/onboarding.md: restore '(the loop's single re-prompt, the reviewer's reminder, master wakes)' after 'launcher pastes' (the sentence now reads 'launcher pastes need no confirmation'); restore '(trade-off: unattended)' after the approvals link.",
  'GY-1519-2411974': 'GY-1519 is in review round 8, past its cap of 3, and graphyard-reviewer[bot] names a blocking finding on bd5a721c7535: DOCS — src/server/routes/main-watch.ts:47 exposes GET /api/main-watch and src/cli/master/operations.ts:81 adds graphyard master main-watch status, while docs/recovery.md:44 names neither. Document these user-visible interfaces and what policy/status they return, while keeping the page and repository.',
  'GY-1519-2412361': 'GY-1519 is in review round 9, past its cap of 3, and graphyard-reviewer[bot] names a blocking finding on 3965b37fba49: DOCS — docs/recovery.md:44 says “Read them with GET /api/main-watch or graphyard master main-watch status,” but GET returns policy, not unexplained commits. State what each read interface actually returns within the 60-word paragraph budget.',
} as const;

const config = { cliPath: '/opt/graphyard/bin/graphyard.mjs', repository: 'acme/widgets' };
const profile = { principal: 'graphyard-worker-1' };
const item = (key: string, sha: string, pr: number, handedIn: string) => ({
  key, title: `${key} item`, submission: { epoch: 3, pr }, candidate: { sha: sha.padEnd(40, '0'), pr } as any,
  pipeline: { attempts: [], submittedAt: '2026-10-08T07:00:00.000Z', resubmittedAt: handedIn, reworkRounds: 2, interventions: { blocked: 0, requirements: 0 } },
});
const decision = (id: string, reason: string, approvedAt: string, state = 'applied', action = 'rework'): ReworkDecisionRow => ({ id, action, state, reason, approvedAt });

for (const [instance, sha, pr, handedIn, approvedAt] of [
  ['GY-1543-2407838', '26053312', 1011, '2026-10-08T08:58:00.000Z', '2026-10-08T09:02:41.000Z'],
  ['GY-1543-2407882', '26053312', 1011, '2026-10-08T09:04:00.000Z', '2026-10-08T09:05:04.000Z'],
  ['GY-1519-2411974', 'bd5a721c7535', 1014, '2026-10-08T10:57:00.000Z', '2026-10-08T10:59:11.000Z'],
  ['GY-1519-2412361', '3965b37fba49', 1014, '2026-10-08T11:13:00.000Z', '2026-10-08T11:15:52.000Z'],
] as const) {
  test(`manual:intervention-pattern-scope-widening-review — ${instance}: the rework round's worker request carries the applied decision's reason`, () => {
    const work = item(instance.slice(0, 7), sha, pr, handedIn);
    const decisions = [decision('earlier', 'an earlier round, already answered', '2026-10-08T06:00:00.000Z'), decision('this', reasons[instance], approvedAt)];
    const brief = appliedReworkBrief(work, decisions);
    assert.deepEqual(brief, { id: 'this', reason: reasons[instance], approvedAt });
    const prompt = workerPrompt(config, work, profile, 4, null, null, undefined, null, null, brief);
    assert.ok(prompt.includes(reasons[instance]), 'the worker reads the findings the round was sent back for, so no criterion has to restate them');
    assert.match(prompt, new RegExp(`rework round of PR #${pr} at head ${sha.slice(0, 8)}`));
    assert.match(prompt, /resubmitting the same head answers nothing/);
    assert.match(prompt, /scope-request/, 'a file the finding needs is asked for by the worker, which the loop decides, not added by a requirements revision');
  });
}

test('manual:intervention-pattern-scope-widening-review — only the applied decision that sent back the last hand-in is the brief', () => {
  const work = item('GY-1543', '26053312', 1011, '2026-10-08T09:04:00.000Z');
  // Applied before the last hand-in: an earlier round's, already answered.
  assert.equal(appliedReworkBrief(work, [decision('old', 'answered', '2026-10-08T09:02:41.000Z')]), null);
  // Requested, refused, or not a rework: never a brief.
  assert.equal(appliedReworkBrief(work, [decision('r', 'waiting', '2026-10-08T09:10:00.000Z', 'requested'), decision('x', 'declined', '2026-10-08T09:10:00.000Z', 'refused'), decision('m', 'merge', '2026-10-08T09:10:00.000Z', 'applied', 'merge')]), null);
  // An item never submitted has no rework round.
  assert.equal(appliedReworkBrief({ ...work, submission: null }, [decision('new', 'reason', '2026-10-08T09:10:00.000Z')]), null);
  // With no hand-in time recorded, the latest applied decision is the brief.
  assert.equal(appliedReworkBrief({ ...work, pipeline: undefined }, [decision('a', 'first', '2026-10-08T09:00:00.000Z'), decision('b', 'second', '2026-10-08T09:10:00.000Z')])?.id, 'b');
});

test('manual:intervention-pattern-scope-widening-review — a first attempt carries no brief, and a long reason is bounded with where to read the rest', () => {
  const first = workerPrompt(config, { key: 'GY-1', title: 'first' }, profile, 1, null, null, undefined, null, null, null);
  assert.doesNotMatch(first, /rework round/);
  const work = item('GY-2', 'abcdef123456', 7, '2026-10-08T09:00:00.000Z');
  const section = reworkBriefSection(work, { id: 'd-1', reason: 'x'.repeat(reworkBriefMax + 500), approvedAt: '2026-10-08T09:10:00.000Z' });
  assert.ok(section.includes(`${'x'.repeat(reworkBriefMax)}… (truncated; read the whole reason on the decision d-1)`));
  assert.ok(!section.includes('x'.repeat(reworkBriefMax + 1)));
});

test('manual:intervention-pattern-scope-widening-review — a decisions read that fails refuses the rework launch, never starts it without its brief', async () => {
  const credentialFile = join(await mkdtemp(join(tmpdir(), 'rework-brief-')), 'master.token');
  await writeFile(credentialFile, 'master-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = { url: 'https://graphyard.example', credentialFile }, work = { id: 'w-1', key: 'GY-7' };
  const answer = (response: () => Response | Promise<Response>) => (async () => response()) as unknown as typeof fetch;
  // A refusal, a network failure, a timeout and a body without the decisions list each refuse it, naming the item and the read.
  for (const [fetcher, cause] of [
    [answer(() => new Response('{}', { status: 503 })), /\(HTTP 503\)/],
    [answer(() => { throw new TypeError('fetch failed'); }), /\(fetch failed\)/],
    [answer(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }), /\(The operation was aborted due to timeout\)/],
    [answer(() => new Response('{"key":"GY-7"}', { status: 200 })), /\(the response carries no decisions list\)/],
  ] as const) {
    const refused = await readReworkDecisions(config, work, fetcher).then(() => null, (error: unknown) => error);
    assert.ok(refused instanceof ReworkDecisionsUnreadError);
    assert.match(refused.message, /^the rework decisions of GY-7 could not be read from https:\/\/graphyard\.example\/api\/work\/w-1\/decisions /);
    assert.match(refused.message, cause);
    assert.match(refused.message, /refused before anything is claimed rather than starting a rework round without the reason it was sent back for/);
  }
  // An unavailable plane is read as plane-wide: retried, never counted toward a dispatch block.
  assert.ok(planeWideFailure(new ReworkDecisionsUnreadError('GY-7', 'https://graphyard.example/api/work/w-1/decisions', 'HTTP 503').message));
  // A read that succeeds hands the decisions back as the plane returned them.
  const rows = [decision('d', 'reason', '2026-10-08T09:10:00.000Z')];
  assert.deepEqual(await readReworkDecisions(config, work, answer(() => new Response(JSON.stringify({ key: 'GY-7', decisions: rows })))), rows);
});
