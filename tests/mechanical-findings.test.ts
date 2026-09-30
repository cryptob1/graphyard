import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoFixMechanicalFindings, classifyFinding, judgeBotCommit, mechanicalFixPlan, parseClassifiedFindings, verifyBotCommit, type BotCommitObservation, type MechanicalFixPlan } from '../src/mechanical-findings.js';
import { reviewPrompt } from '../src/reviewer.js';
import { computeInterventionReport, foldInterventions } from '../src/interventions.js';
import { interventionKinds, interventionPolicyDefaults, interventionRecordSchema } from '../src/model/interventions.js';
import type { Work } from '../src/model.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40), BOT = 'c'.repeat(40);
const reviewer = 'graphyard-reviewer[bot]';
const binding = { key: 'GY-7', pr: 7, sha: H, baseSha: B, policyRevision: 1 };
const criteria = [{ id: 'AC-1', text: 'The widget counts every frob.' }];
const verdict = [
  'AC-1 met.',
  'Follow-up finding: docs/widget.md:12 — "recieve" is a typo (mechanical: typo)',
  'Follow-up finding: src/widget.ts:40 — the counter variable name frobCnt does not match the frobCount convention used elsewhere (mechanical: naming)',
  'Follow-up finding: docs/operations.md:3 — this paragraph belongs in docs/widget.md (mechanical: docs-placement)',
  'Follow-up finding: src/widget.ts:9 — trailing whitespace and a blank line (mechanical: formatting)',
  'Follow-up finding: src/widget.ts:55 — the retry loop is unbounded when the source keeps failing (substantive: behavior)',
  'Follow-up finding: src/other.ts:2 — rename this, and it also returns null for an empty list (mechanical: naming)',
  'Follow-up finding: consider a cache someday',
  'Resolved threads: none', 'Follow-up threads: none', 'Overridden threads: none',
].join('\n');
const approval = { repository: 'owner/project', key: 'GY-7', pr: 7, sha: H, reviewId: 901, state: 'APPROVED', body: verdict, reviewer };
const botCommit = (plan: MechanicalFixPlan, overrides: Partial<BotCommitObservation> = {}): BotCommitObservation =>
  ({ sha: BOT, parents: [plan.head], author: { principal: 'graphyard-bot-worker', role: 'worker' }, files: plan.paths, at: '2026-09-30T12:00:00.000Z', ...overrides });

test('unit:mechanical-findings-auto-fixed — review findings are classified, and an approved head\'s mechanical ones are fixed by a worker bot commit before the fresh read, which is shown only substance', async () => {
  // Every finding carries a classification and a category.
  const classified = parseClassifiedFindings(verdict);
  assert.deepEqual(classified.map(finding => [finding.path, finding.classification, finding.category]), [
    ['docs/widget.md', 'mechanical', 'typo'],
    ['src/widget.ts', 'mechanical', 'naming'],
    ['docs/operations.md', 'mechanical', 'docs-placement'],
    ['src/widget.ts', 'mechanical', 'formatting'],
    ['src/widget.ts', 'substantive', 'behavior'],
    // A mechanical label never outranks a sign of behaviour, a criterion or the scope.
    ['src/other.ts', 'substantive', 'behavior'],
    // What the classifier cannot place stays with the reviewer.
    [null, 'substantive', 'behavior'],
  ]);
  assert.equal(classified[0]!.text, 'docs/widget.md:12 — "recieve" is a typo', 'the label is read off the finding');
  // Unlabelled findings are classified by their words: mechanical ones by kind, substantive by behaviour, criteria or scope.
  const unlabelled = (text: string) => classifyFinding({ path: 'src/x.ts', line: 1, text });
  assert.equal(unlabelled('misspelled word in the comment').category, 'typo');
  assert.equal(unlabelled('indentation is off by two spaces').category, 'formatting');
  assert.equal(unlabelled('AC-1 is not shown on the dashboard').category, 'criteria');
  assert.equal(unlabelled('this touches src/y.ts, out of scope for the item').category, 'scope');
  assert.equal(unlabelled('it crashes on an empty list').classification, 'substantive');

  // Only an approval gets a bot: a REQUEST_CHANGES head is reworked by its worker.
  assert.equal(mechanicalFixPlan({ ...approval, state: 'CHANGES_REQUESTED' }), null);
  assert.equal(mechanicalFixPlan({ ...approval, body: 'AC-1 met.\nFollow-up finding: src/a.ts:1 — the retry is unbounded' }), null, 'nothing mechanical, nothing to fix');

  // The approved head's mechanical findings go to one worker-class bot commit on that head.
  let prompted = '';
  const outcome = await autoFixMechanicalFindings(approval, async (plan, prompt) => { prompted = prompt; return botCommit(plan); });
  assert.ok('fresh' in outcome, JSON.stringify(outcome));
  const { plan, fresh } = outcome as Extract<typeof outcome, { fresh: unknown }>;
  assert.deepEqual(plan.paths, ['docs/operations.md', 'docs/widget.md', 'src/widget.ts']);
  assert.equal(plan.mechanical.length, 4);
  for (const fragment of ['"recieve" is a typo', 'frobCnt', `whose only parent is ${H}`, 'change only docs/operations.md, docs/widget.md, src/widget.ts', 'change no behaviour']) assert.ok(prompted.includes(fragment), `bot prompt: ${fragment}`);
  assert.ok(!prompted.includes('retry loop is unbounded'), 'the bot is never handed a substantive finding');

  // The independent reviewer's fresh read is of the bot's head, and its findings are the substantive ones only.
  assert.equal(fresh.sha, BOT);
  assert.deepEqual(fresh.findings.map(finding => finding.classification), ['substantive', 'substantive', 'substantive']);
  assert.equal(fresh.botCommit.bot, 'graphyard-bot-worker');
  const prompt = reviewPrompt({ repository: 'owner/project' }, { ...binding, sha: BOT }, undefined, undefined, criteria, undefined, undefined, null, fresh.botCommit);
  assert.ok(prompt.includes(`bot commit ${BOT}`) && prompt.includes(`git show ${BOT}`));
  for (const mechanical of ['recieve', 'frobCnt', 'trailing whitespace', 'belongs in docs/widget.md']) assert.ok(!prompt.includes(mechanical), `the fresh read is not shown the mechanical finding "${mechanical}"`);
  // Every review asks for the classification on each finding line.
  const plain = reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria);
  for (const fragment of ['(mechanical: CATEGORY)', 'typo, docs-placement, formatting, naming', '(substantive: CATEGORY)', 'behavior, criteria, scope']) assert.ok(plain.includes(fragment), fragment);
  assert.ok(!plain.includes('bot commit'), 'no bot section without a bot commit at the head');

  // The bot commit is accepted only as planned: a worker identity other than the reviewer, on the approved head, within the findings' files.
  const plannedFix = mechanicalFixPlan(approval)!;
  assert.match((verifyBotCommit(plannedFix, botCommit(plannedFix, { author: { principal: 'producer-1', role: 'producer' } }), reviewer) as { reason: string }).reason, /not a worker identity/);
  assert.match((verifyBotCommit(plannedFix, botCommit(plannedFix, { author: { principal: reviewer, role: 'worker' } }), reviewer) as { reason: string }).reason, /independent/);
  assert.match((verifyBotCommit(plannedFix, botCommit(plannedFix, { parents: [B] }), reviewer) as { reason: string }).reason, /approved head/);
  assert.match((verifyBotCommit(plannedFix, botCommit(plannedFix, { files: ['docs/widget.md', 'src/limits.ts'] }), reviewer) as { reason: string }).reason, /src\/limits\.ts, outside/);
  // A refused, failed or empty bot run leaves the findings to follow-up filing, and no fresh read of a bot head.
  assert.match((await autoFixMechanicalFindings(approval, async plan => botCommit(plan, { files: ['src/limits.ts'] })) as { fallback: string }).fallback, /outside/);
  assert.equal((await autoFixMechanicalFindings(approval, async () => null) as { fallback: string }).fallback, 'the bot fixed nothing');
  assert.match((await autoFixMechanicalFindings(approval, async () => { throw new Error('pane gone'); }) as { fallback: string }).fallback, /pane gone/);
});

test('unit:mechanical-mislabel-caught — a substantive finding misclassified as mechanical is caught: the fresh read sees the full diff, rejects the bot commit, and the misclassification is an intervention signal for the retro', async () => {
  // The classifier takes the reviewer's label at its word when no substantive sign shows: this one changes a limit.
  const mislabelled = 'AC-1 met.\nFollow-up finding: src/limits.ts:4 — tidy the MAX constant (mechanical: formatting)';
  const outcome = await autoFixMechanicalFindings({ ...approval, body: mislabelled }, async plan => ({ sha: BOT, parents: [plan.head], author: { principal: 'graphyard-bot-worker', role: 'worker' }, files: ['src/limits.ts'], at: '2026-09-30T12:00:00.000Z' }));
  const { fresh } = outcome as Extract<typeof outcome, { fresh: unknown }>;
  assert.equal(fresh.botCommit.findings[0]!.classification, 'mechanical');

  // The fresh read still reviews the whole diff, bot commit included, and is told how to reject it.
  const prompt = reviewPrompt({ repository: 'owner/project' }, { ...binding, sha: BOT }, undefined, undefined, criteria, undefined, undefined, null, fresh.botCommit);
  for (const fragment of ['gh pr diff 7 --repo owner/project', 'You still review the whole diff, the bot commit included', `"Rejected bot commit: ${BOT} — `, 'misclassified', 'REQUEST_CHANGES']) assert.ok(prompt.includes(fragment), fragment);

  // Verdicts on the bot's head: an approval accepts it, a change request without the line is ordinary rework, another head says nothing.
  const review = (state: string, body: string, sha = BOT) => ({ state, commit_id: sha, body, submitted_at: '2026-09-30T12:20:00.000Z' });
  assert.deepEqual(judgeBotCommit(fresh.botCommit, review('APPROVED', 'AC-1 met.'), { key: 'GY-7' }), { outcome: 'accepted' });
  assert.deepEqual(judgeBotCommit(fresh.botCommit, review('CHANGES_REQUESTED', 'AC-1 unmet: the count is wrong.'), { key: 'GY-7' }), { outcome: 'rework' });
  assert.deepEqual(judgeBotCommit(fresh.botCommit, review('CHANGES_REQUESTED', `Rejected bot commit: ${BOT} — x`, H), { key: 'GY-7' }), { outcome: 'pending' });
  assert.deepEqual(judgeBotCommit(fresh.botCommit, review('CHANGES_REQUESTED', `Rejected bot commit: ${'d'.repeat(40)} — another commit`), { key: 'GY-7' }), { outcome: 'rework' }, 'a rejection of some other commit is not this one');

  // The rejection: a REQUEST_CHANGES naming the bot commit, by full or short sha.
  const rejected = judgeBotCommit(fresh.botCommit, review('CHANGES_REQUESTED', `AC-1 unmet.\nRejected bot commit: ${BOT.slice(0, 12)} — it raised MAX from 10 to 100, a behaviour change, not formatting`), { key: 'GY-7' });
  assert.equal(rejected.outcome, 'rejected');
  const { reason, signal } = rejected as Extract<typeof rejected, { outcome: 'rejected' }>;
  assert.equal(reason, 'it raised MAX from 10 to 100, a behaviour change, not formatting');
  // The signal is an intervention the control plane records as it records any other (POST /api/interventions).
  assert.ok(interventionKinds.includes('misclassified-finding'));
  const parsed = interventionRecordSchema.parse(signal);
  assert.equal(parsed.kind, 'misclassified-finding');
  assert.equal(parsed.work, 'GY-7');
  assert.equal(parsed.trigger, 'formatting', 'the category that was wrong');
  assert.match(parsed.blocked, /src\/limits\.ts:4 \(formatting\)/);
  assert.match(parsed.resolution, /rejected the bot commit: it raised MAX/);

  // Recorded, it reaches the retro synthesis: the intervention report counts it by kind and stage, and its recurrence rule sees it.
  const item = { id: '00000000-0000-4000-8000-000000000007', key: 'GY-7', title: 'Widget', stage: 'review' } as unknown as Work;
  const recorded = { id: '11111111-1111-4111-8111-111111111111', kind: parsed.kind, work: { id: item.id, key: 'GY-7', title: 'Widget' }, stage: parsed.stage, blocked: parsed.blocked, trigger: parsed.trigger, since: parsed.since, at: '2026-09-30T12:20:00.000Z', resolution: parsed.resolution };
  const folded = foldInterventions([{ seq: 1, workId: item.id, actor: 'graphyard-master', kind: 'intervention.recorded', at: recorded.at, details: {}, payload: recorded }], [item], '2026-09-30T13:00:00.000Z');
  assert.equal(folded.interventions.length, 1);
  assert.equal(folded.interventions[0]!.kind, 'misclassified-finding');
  assert.equal(folded.interventions[0]!.waitedMs, 20 * 60_000, 'from the bot commit to its rejection');
  const report = computeInterventionReport(folded, [item], interventionPolicyDefaults, { days: 7, now: '2026-09-30T13:00:00.000Z' });
  assert.deepEqual(report.byKind.map(entry => [entry.kind, entry.count]), [['misclassified-finding', 1]]);
  assert.ok(report.patterns.some(pattern => pattern.kind === 'misclassified-finding' && pattern.stage === 'review' && pattern.count === 1));
});
