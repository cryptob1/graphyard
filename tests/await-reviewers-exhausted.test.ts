import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { botReviewerStates, dispatchEffects, dispatchSummary, emptyDispatchCursor, runDispatchTick, type BotActivity, type DispatchCursor, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-349: an automatic bot reviewer that has announced its quota is spent posts no review, so a
// reviewer launch that waits for it loses the whole wait on every round. Each test is named for
// the proof it produces: unit:exhausted-bot-not-awaited and unit:exhausted-bot-status.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const docs = fileURLToPath(new URL('../docs/master-agent.md', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-25T10:00:00.000Z', clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const codex = 'chatgpt-codex-connector[bot]';
const notice = 'You have reached your Codex usage limits for code reviews. You can see your limits in the Codex usage dashboard.';

function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false,
    baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Observation;
  return { id: 'work-64', key: 'GY-64', title: 'Exhausted bot', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:a'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: '/w/gy-64', branch: 'graphyard/gy-64-1', epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
/** A head whose unit proof passed, so the control plane has raised its review request. */
function reviewRequested(): Work {
  const proven: Evidence = { id: 'ev-a', proof: 'unit:a', sha: H, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at } as Evidence;
  const item = work({ evidence: [proven] }); reconcileAutoDispatch(item, [item], new Date(clock));
  assert.equal(item.autoDispatch?.review?.state, 'requested', 'the fixture raises a review request');
  return item;
}
function masterConfig(credentialFile: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(credentialFile, '..', 'reviewer.json'), boundAt: at }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [] });
}
function effects(item: Work, log: string[], activity: () => BotActivity[]): DispatchEffects {
  const reviews: any[] = [];
  return {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
    agents: () => [],
    credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (work, request) => { log.push(`review:${work.key}:${request.sha.slice(0, 4)}`); reviews.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    launchProducer: async () => { throw new Error('no producer is requested in this fixture'); },
    // The bot has not reviewed this head: without GY-349 every launch below would wait.
    headReviewers: async () => [],
    botActivity: async logins => { assert.deepEqual(logins, [codex]); return activity(); },
    persist: async () => {},
  };
}

async function withToken<T>(body: (config: MasterConfig) => Promise<T>) {
  const directory = await temporaryDirectory('exhausted-bot');
  try {
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    return await body(masterConfig(token));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('unit:exhausted-bot-not-awaited — a launch does not wait for a bot whose latest word is a usage-limit notice, waits when its latest activity is a review, and waits again once it reviews after the notice', async () => {
  await withToken(async config => {
    const noticeAt = iso(-30 * 60_000);
    const scenarios: { name: string; activity: BotActivity[]; launches: number }[] = [
      { name: 'the latest bot comment is a limit notice', launches: 1, activity: [{ login: codex, kind: 'review', at: iso(-3 * 3_600_000) }, { login: codex, kind: 'comment', at: noticeAt, body: notice }] },
      { name: 'the latest bot activity is a review', launches: 0, activity: [{ login: codex, kind: 'comment', at: iso(-3 * 3_600_000), body: notice }, { login: codex, kind: 'review', at: iso(-60_000) }] },
      { name: 'the bot has said nothing', launches: 0, activity: [] },
      { name: 'another login posted the notice', launches: 0, activity: [{ login: 'someone-else', kind: 'comment', at: noticeAt, body: notice }] },
    ];
    for (const scenario of scenarios) {
      const log: string[] = [], item = reviewRequested(), requested = Date.parse(item.autoDispatch!.review!.requestedAt);
      const tick = await runDispatchTick(config, emptyDispatchCursor(config), effects(item, log, () => scenario.activity), () => requested + 60_000);
      assert.equal(log.length, scenario.launches, `${scenario.name}: ${JSON.stringify(tick.waiting)}`);
      if (scenario.launches) {
        // The launch reason names the bot as exhausted and quotes the notice's time.
        assert.equal(tick.launched[0].reason, `awaited-reviewer wait skipped: ${codex} exhausted since ${noticeAt}`);
        assert.deepEqual(tick.waiting, []);
      } else assert.match(tick.waiting[0].reason, /waits up to 8 min .* for chatgpt-codex-connector\[bot\]'s review of the head/, scenario.name);
    }

    // The skip holds across ticks until the bot next reviews any head; then waiting resumes.
    let activity: BotActivity[] = [{ login: codex, kind: 'comment', at: noticeAt, body: notice }];
    const cursor: DispatchCursor = emptyDispatchCursor(config);
    const first = reviewRequested(), firstLog: string[] = [];
    await runDispatchTick(config, cursor, effects(first, firstLog, () => activity), () => Date.parse(first.autoDispatch!.review!.requestedAt) + 1000);
    assert.equal(firstLog.length, 1, 'exhausted: the launch goes ahead');
    assert.deepEqual(cursor.botReviewers.map(bot => [bot.login, bot.state, bot.since]), [[codex, 'exhausted', noticeAt]]);
    // A failed activity read keeps the last judgment: the bot is still exhausted.
    const failed = reviewRequested(), failedLog: string[] = [];
    const failing = { ...effects(failed, failedLog, () => activity), botActivity: async () => { throw new Error('gh: HTTP 502'); } };
    await runDispatchTick(config, cursor, failing, () => Date.parse(failed.autoDispatch!.review!.requestedAt) + 1000);
    assert.equal(failedLog.length, 1, 'a failed read leaves the exhausted judgment standing');
    activity = [...activity, { login: codex, kind: 'comment', at: iso(-60_000), body: notice }, { login: codex, kind: 'review', at: iso(-1000) }];
    const second = reviewRequested(), secondLog: string[] = [];
    const resumed = await runDispatchTick(config, cursor, effects(second, secondLog, () => activity), () => Date.parse(second.autoDispatch!.review!.requestedAt) + 1000);
    assert.equal(secondLog.length, 0, 'the bot reviewed after its notice: the launch waits for it again');
    assert.match(resumed.waiting[0].reason, /for chatgpt-codex-connector\[bot\]'s review of the head/);
    assert.equal(cursor.botReviewers[0].state, 'available');
  });
});

test('unit:exhausted-bot-not-awaited — the production reader ends the exhaustion with a review on a pull request nobody is waiting on, and keeps a notice that aged out of the comment read', async () => {
  const noticeAt = iso(-30 * 60_000), reviewedAt = iso(-5 * 60_000);
  // The repository as `gh api` answers it: the bot's notice on #70, then its review of #71, which
  // no review request is waiting on; #64 is the waiting pull request.
  const repository = { comments: [[codex, noticeAt, notice]] as string[][], pulls: [['71', reviewedAt], ['64', iso(-10 * 60_000)], ['12', iso(-86_400_000)]], reviews: { 71: [[codex, reviewedAt]], 64: [], 12: [[codex, iso(-86_400_000)]] } as Record<number, string[][]> };
  const calls: string[] = [];
  const run = (command: string, args: string[]) => {
    assert.equal(command, 'gh'); const path = args.find(arg => arg.startsWith('repos/'))!; calls.push(path);
    if (path.startsWith('repos/owner/project/issues/comments')) return repository.comments.map(row => row.join('\t')).join('\n');
    if (path.startsWith('repos/owner/project/pulls?')) return repository.pulls.map(row => row.join('\t')).join('\n');
    const pr = Number(/pulls\/(\d+)\/reviews/.exec(path)![1]); return (repository.reviews[pr] ?? []).map(row => row.join('\t')).join('\n');
  };
  await withToken(async config => {
    let clockNow = clock;
    const read = dispatchEffects('/outside', () => config, { snapshot: async () => ({ work: [], now: at }), run, now: () => clockNow }).botActivity!;
    const request = reviewRequested().autoDispatch!.review!;
    assert.deepEqual(botReviewerStates([codex], await read([codex], [request], []), []), [{ login: codex, state: 'available', since: null }], 'a review on #71 after the notice ends the exhaustion');
    assert.ok(calls.some(path => path.startsWith('repos/owner/project/pulls/71/reviews')), 'the pull request updated since the notice is read');
    assert.ok(!calls.some(path => path.startsWith('repos/owner/project/pulls/12/reviews')), 'one untouched since the notice is not');

    // Without that review the bot is exhausted since its notice.
    repository.reviews[71] = []; clockNow += 61_000;
    const exhausted = botReviewerStates([codex], await read([codex], [request], []), []);
    assert.deepEqual(exhausted, [{ login: codex, state: 'exhausted', since: noticeAt }]);
    // The notice ages out of the newest comments: the held judgment stands until a later review.
    repository.comments = []; clockNow += 61_000;
    assert.deepEqual(botReviewerStates([codex], await read([codex], [request], exhausted), exhausted), exhausted, 'an aged-out notice keeps the bot exhausted');
    repository.reviews[71] = [[codex, reviewedAt]]; clockNow += 61_000;
    assert.equal(botReviewerStates([codex], await read([codex], [request], exhausted), exhausted)[0].state, 'available', 'its next review on any head ends it');
  });
});

test('unit:exhausted-bot-status — master status lists each awaited bot as available or exhausted with the notice time, the skipped wait reads "skipped: <bot> exhausted since <time>", and the docs state the rule', async () => {
  const noticeAt = iso(-45 * 60_000);
  assert.deepEqual(botReviewerStates([codex, 'other-bot[bot]'], [{ login: 'ChatGPT-Codex-Connector[bot]', kind: 'comment', at: noticeAt, body: notice }, { login: 'other-bot[bot]', kind: 'review', at: noticeAt }]),
    [{ login: codex, state: 'exhausted', since: noticeAt }, { login: 'other-bot[bot]', state: 'available', since: null }], 'logins match case-insensitively; a review is availability');
  assert.equal(botReviewerStates([codex], [{ login: codex, kind: 'comment', at: noticeAt, body: 'Codex Review: no major issues found.' }])[0].state, 'available', 'an ordinary comment is not a limit notice');

  await withToken(async config => {
    const cursor = emptyDispatchCursor(config), item = reviewRequested(), log: string[] = [];
    await runDispatchTick(config, cursor, effects(item, log, () => [{ login: codex, kind: 'comment', at: noticeAt, body: notice }]), () => Date.parse(item.autoDispatch!.review!.requestedAt) + 1000);
    const summary = dispatchSummary(cursor, clock, 10_000, [codex, 'other-bot[bot]']);
    assert.deepEqual(summary.botReviewers.map(bot => bot.line), [`${codex}: exhausted since ${noticeAt}`, 'other-bot[bot]: available']);
    assert.deepEqual(summary.botReviewers.map(bot => [bot.state, bot.since]), [['exhausted', noticeAt], ['available', null]]);
    // The candidate's awaited-reviewer wait, as status carries it in the last tick's reasons.
    assert.ok(summary.lastTick!.reasons.some(reason => reason.includes(`GY-64 ${H.slice(0, 12)}`) && reason.includes(`skipped: ${codex} exhausted since ${noticeAt}`)), JSON.stringify(summary.lastTick));
  });

  const guide = await readFile(docs, 'utf8');
  for (const fragment of ['usage-limit notice', 'until it next reviews', 'skipped: <bot> exhausted since <time>', 'dispatch.botReviewers']) assert.ok(guide.includes(fragment), `docs/master-agent.md must state: ${fragment}`);
});
