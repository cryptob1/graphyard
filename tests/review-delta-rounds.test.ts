import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMaster } from '../src/master.js';
import { earlierChangeRequest, launchReview, readReviewLedger, reviewHistory, reviewPrompt, saveReviewerProfile } from '../src/reviewer.js';
import { blockingFindings, observedReviewBody } from '../src/review-cap.js';
import { changedHunks, postReview, readReviewBinding, reviewBindingFile, ReviewPostRefusal, unchangedCodeFindings, writeReviewBinding, type ReviewPostBinding } from '../src/review-post.js';
import type { Observation, Work } from '../src/model.js';
import { expandTypedCommand, requestOf, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1988: later review rounds judge only what changed. A control-plane verdict is recorded on the
// item's observation, never on the review ledger by pull-request number, so a re-review's previous
// round — its head and its blocking findings — is read from the observation itself; the request
// names that head, the diff to it and the findings verbatim, and review post refuses a BLOCKING:
// line on code no hunk since that head changes. Round one is unchanged, and GitHub-mode reviews
// keep their text.

const B = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const H1 = sha('earlier-head'), H2 = sha('new-head');
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const reviewer = 'review-claude-1';
// The earlier round's findings; the instants here stamp records the round logic orders by head, and this file reads no wall clock.
const at = '2026-09-24T12:00:00Z';
const earlierFindings = ['src/a.ts:3 — the flag is unread', 'docs/guide.md:9 — the setting is undocumented'];
const earlierReview = { reviewer, sha: H1, state: 'CHANGES_REQUESTED', id: 11, submittedAt: at, body: 'BLOCKING: src/a.ts:3 — the flag is unread\nNit: docs/readme.md:2 — a typo', blocking: earlierFindings, source: 'control-plane' };
const binding = { key: 'GY-1988', pr: 7, sha: H2, baseSha: B, policyRevision: 1 };
const criteria = [{ id: 'AC-1', text: 'The widget counts every frob.' }];

/** A control-plane item at head H2, its observation holding `reviews` (the earlier round when given). */
function item(reviews: unknown[] = []): Work {
  const candidate = { sha: H2, baseSha: B, pr: 7, branch: 'graphyard/gy-1988-1', author: 'graphyard-claude-1' };
  const observation = { source: 'control-plane', at, candidate, checks: [], reviews, merged: false, mergeSha: null, mergeable: true, protected: false,
    files: ['src/a.ts'], scopeFiles: [], baseTip: B, baseTipContained: true } as unknown as Observation;
  return { id: randomUUID(), key: 'GY-1988', title: 'Delta rounds', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ ...criteria[0], proofs: ['unit:works'] }], policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'],
    stage: 'review', revision: 5, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-1988-1', epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-claude-1'], observation } as unknown as Work;
}

test('unit:review-round-carries-earlier-findings — a re-review takes the earlier change request from the item\u2019s observation: the prompt names that head, the diff to it and each finding verbatim, asking one Earlier: line apiece', async () => {
  // The newest CHANGES_REQUESTED of an earlier head is the round; approvals, older rounds and this head's own reviews are not.
  const observation = item().observation!;
  observation.reviews = [earlierReview,
    { reviewer, sha: H1, state: 'APPROVED', id: 12, submittedAt: at },
    { reviewer, sha: sha('older'), state: 'CHANGES_REQUESTED', id: 10, submittedAt: '2026-09-24T10:00:00Z', blocking: ['stale.ts:1 — old'] },
    { reviewer, sha: H2, state: 'CHANGES_REQUESTED', id: 13, submittedAt: at, blocking: ['same-head.ts:1 — not an earlier round'] }] as Observation['reviews'];
  const earlier = earlierChangeRequest(observation, H2);
  assert.deepEqual(earlier, { head: H1, findings: earlierFindings });
  assert.equal(earlierChangeRequest(item().observation, H2), null, 'a first round has no earlier change request');

  // The history carries the head and the findings verbatim, ledger or not.
  const history = reviewHistory([], binding, reviewer, earlier);
  assert.deepEqual(history, { previousHead: H1, earlierFindings, changesRequested: 0 });
  const prompt = reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, criteria, history, undefined, null, null, null, null, null, { head: H2, baseTip: B });
  assert.ok(prompt.includes(`You already reviewed an earlier head of this item, ${H1}: this round judges only what changed since then.`));
  assert.ok(prompt.includes(`git diff ${H1} ${H2}`), 'the prompt gives the diff from the earlier head to the new one');
  for (const finding of earlierFindings) assert.ok(prompt.includes(finding), 'each earlier finding is named verbatim');
  assert.ok(prompt.includes('exactly "Earlier: <finding> — FIXED" when this head fixes it or "Earlier: <finding> — NOT FIXED" when it does not'));
  assert.ok(prompt.includes('a new finding on code unchanged since'), 'the prompt states the unchanged-code rule');
  assert.ok(prompt.includes('"Nit: PATH:LINE — FINDING" line — an advisory note'), 'a new finding on unchanged code is a Nit, kept advisory');

  // A settled ledger record of the same round keeps the observation's findings beside the ledger's head.
  const withLedger = reviewHistory([{ id: randomUUID(), key: 'GY-1988', pr: 7, sha: H1, baseSha: B, policyRevision: 1, profile: 'delta-reviewer', agentName: reviewer, pane: null, sessionDirectory: '/tmp/none',
    requestedAt: at, tokenExpiresAt: at, state: 'completed', closedAt: at, verdict: { state: 'CHANGES_REQUESTED', reviewer, reviewId: 11, submittedAt: at } } as never], binding, reviewer, earlier);
  assert.deepEqual([withLedger.previousHead, withLedger.earlierFindings], [H1, earlierFindings]);

  // The launch reads the observation, records the round, and starts the reviewer on that request.
  const master = await planeMaster();
  try {
    const calls: string[][] = [];
    let request = null as string | null;
    const run = (_command: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') { const typed = expandTypedCommand(args[3]); request = requestOf(typed.kind, typed.args); }
      calls.push(args);
      return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    };
    await launchReview(master.root, item([earlierReview]), 'delta-reviewer', [], at, { run, registerLaunch: async () => ({ launch: 'launch-1' }) });
    assert.ok(request, 'the reviewer session started on its request');
    assert.ok(request!.includes(`You already reviewed an earlier head of this item, ${H1}`));
    assert.ok(request!.includes(`git diff ${H1} ${H2}`));
    assert.ok(request!.includes('NOT FIXED'));
    const [record] = (await readReviewLedger(master.root)).reviews;
    assert.deepEqual(record!.reviewRound, { previousHead: H1, earlierFindings, changesRequested: 0 }, 'the record keeps the round, so a retry repeats the delta text');
    const tab = calls.filter(args => args[0] === 'tab' && args[1] === 'create').at(-1)!;
    const sessionBinding = JSON.parse(await readFile(join(tab.find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length), reviewBindingFile), 'utf8')) as ReviewPostBinding;
    assert.deepEqual([sessionBinding.previousHead, sessionBinding.earlierPaths], [H1, ['src/a.ts', 'docs/guide.md']], 'the binding carries the earlier head and the paths its findings named');
  } finally { await master.cleanup(); }
});

const TOKEN = 'f'.repeat(64);
const diff = ['diff --git a/src/b.ts b/src/b.ts', 'index 1111111..2222222 100644', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -10,3 +12,5 @@ unchanged context', ' unchanged', ' unchanged', '+added one', '+added two',
  'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+brand new',
  'diff --git a/src/guard.ts b/src/guard.ts', 'index 3333333..4444444 100644', '--- a/src/guard.ts', '+++ b/src/guard.ts', '@@ -40,3 +39,0 @@', '-const guard = makeGuard();', '-check(guard);', '-export guard;',
  'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-gone one', '-gone two',
  'diff --git a/src/with space.ts b/src/with space.ts', 'index 5555555..6666666 100644', '--- a/src/with space.ts', '+++ b/src/with space.ts', '@@ -3 +3 @@', '-old line', '+new line'].join('\n');
const threads = 'Resolved threads: none\nFollow-up threads: none\nOverridden threads: none';
const deltaBinding = (fields: Partial<ReviewPostBinding> = {}): ReviewPostBinding => ({ repository: 'owner/project', key: 'GY-1988', pr: 7, sha: H2, baseSha: B, policyRevision: 1, criteriaOnly: true, threadsListed: [],
  mode: 'control-plane', head: H2, baseTip: B, verdictToken: TOKEN, ...fields });

test('unit:review-post-refuses-blocking-on-unchanged-code — a control-plane re-review\u2019s REQUEST_CHANGES is refused when a BLOCKING: line names a PATH:LINE no hunk since the previous head changes, no earlier finding\u2019s path and no AC-N; the same body is accepted inside a hunk, on an earlier path, or naming a criterion', async () => {
  const hunks = changedHunks(diff);
  assert.deepEqual([...hunks.get('src/b.ts')!], [[12, 16]], 'the hunk reader reads the new side');
  assert.deepEqual([...hunks.get('src/new.ts')!], [[1, 2]]);
  assert.equal(hunks.get('src/unchanged.ts'), undefined);
  assert.deepEqual([...hunks.get('src/guard.ts')!], [[39, 40]], 'a hunk that only deletes lines counts as the lines around its new-side position');
  assert.deepEqual([...hunks.get('src/gone.ts')!], [[1, 2]], 'a wholly deleted file changes the lines it lost, named from its diff --git line');
  assert.deepEqual([...hunks.get('src/with space.ts')!], [[3, 3]], 'a path with spaces is read from its +++ header');
  const unchanged = 'src/unchanged.ts:50 — the retry swallows aborts';
  const directory = await temporaryDirectory('delta-rounds-post');
  try {
    const environment = { GH_CONFIG_DIR: directory, GRAPHYARD_REVIEW: `GY-1988@${H2}`, GRAPHYARD_URL: 'https://graphyard.example' };
    const attempt = async (body: string, event = 'REQUEST_CHANGES', overrides: Partial<ReviewPostBinding> = {}) => {
      await rm(join(directory, reviewBindingFile), { force: true });
      await writeReviewBinding(directory, deltaBinding({ previousHead: H1, earlierPaths: ['src/a.ts'], ...overrides }));
      const gits: string[][] = [], calls: string[] = [];
      const run = async (_command: string, args: string[]) => { if (args[0] === 'diff') { gits.push(args); return diff; } throw new Error(`unexpected command ${args.join(' ')}`); };
      const fetcher = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(JSON.stringify({ recorded: true, reviewId: 41 }), { status: 200 }); }) as unknown as typeof fetch;
      try { return { posted: await postReview({ event, body: `${body}\n${threads}`, cliPath: launcher, environment }, { run, fetch: fetcher }), gits, calls }; }
      catch (error) { return { refused: error as Error, gits, calls }; }
    };
    // Unchanged code, a path no earlier finding named, no criterion: refused, naming the line and the Nit: form, posting nothing.
    const { refused, gits, calls } = await attempt(`BLOCKING: ${unchanged}`);
    assert.ok(refused instanceof ReviewPostRefusal, String(refused));
    assert.ok(refused!.message.includes(`"${unchanged}" names code unchanged since the earlier head ${H1}`));
    assert.ok(refused!.message.includes('move it to a "Nit: PATH:LINE — FINDING" line') && refused!.message.includes('AC-N'));
    assert.deepEqual(gits, [['diff', '-U0', H1, H2]], 'the hunk check reads the diff from the previous head');
    assert.deepEqual(calls, [], 'a refused verdict posts nothing');
    // Inside a changed hunk: stands. Deleted code is exactly what changed: a finding on a deletion-only hunk's lines stands too.
    assert.deepEqual([ (await attempt('BLOCKING: src/b.ts:13 — the added retry swallows aborts')).posted!.reviewId, (await attempt('BLOCKING: src/new.ts:1 — the new branch leaks')).gits.length ], [41, 1]);
    assert.ok((await attempt('BLOCKING: src/guard.ts:39 — this head removed the auth/abort guard')).posted, 'a finding on deleted code stands');
    assert.ok((await attempt('BLOCKING: src/gone.ts:1 — this head deleted the whole module')).posted, 'a finding on a wholly deleted file stands');
    assert.ok((await attempt('BLOCKING: src/guard.ts:44 — untouched code breaks')).refused instanceof ReviewPostRefusal, 'a line outside the deletion hunk\u2019s range is still refused');
    // An earlier finding's path re-raised, and an unmet acceptance criterion named: stand.
    assert.ok((await attempt('BLOCKING: src/a.ts:99 — the flag is still unread')).posted, 'an earlier finding\u2019s path stands');
    assert.ok((await attempt('BLOCKING: src/unchanged.ts:50 — AC-1 is unmet: the widget misses frobs')).posted, 'a criterion naming finding stands');
    // A Nit: line on unchanged code is no finding and no refusal: it rides with a standing BLOCKING line.
    const nits = await attempt('Nit: src/unchanged.ts:50 — a typo\nBLOCKING: src/new.ts:2 — the new branch leaks');
    assert.deepEqual([nits.posted!.reviewId, nits.gits.length], [41, 1]);
    // An approval is never hunk-checked.
    const approving = await attempt('Every criterion is met.', 'APPROVE');
    assert.deepEqual([approving.posted!.reviewId, approving.gits.length], [41, 0]);
    assert.deepEqual(unchangedCodeFindings(`BLOCKING: src/unchanged.ts:50 — x\nBLOCKING: src/b.ts:12 — y\nBLOCKING: src/a.ts:7 — z\nBLOCKING: src/unchanged.ts:51 — AC-2 unmet`, { previousHead: H1, earlierPaths: ['src/a.ts'] }, diff), ['src/unchanged.ts:50 — x']);

    // A first-round binding (no previous head) applies no hunk check and reads no diff.
    const first = await attempt(`BLOCKING: ${unchanged}`, 'REQUEST_CHANGES', { previousHead: undefined, earlierPaths: undefined });
    assert.deepEqual([first.posted!.reviewId, first.gits.length, first.calls.length], [41, 0, 1], 'round one posts unchanged-code findings untouched');
  } finally { await rm(directory, { recursive: true, force: true }); }

  // A diff read that fails judges nothing: the post stands rather than a review dying on a missing object.
  const failing = await temporaryDirectory('delta-rounds-failing');
  try {
    await writeReviewBinding(failing, deltaBinding({ previousHead: H1 }));
    const posted = await postReview({ event: 'REQUEST_CHANGES', body: `BLOCKING: ${unchanged}\n${threads}`, cliPath: launcher, environment: { GH_CONFIG_DIR: failing, GRAPHYARD_REVIEW: `GY-1988@${H2}`, GRAPHYARD_URL: 'https://graphyard.example' } },
      { run: (async () => { throw new Error('git diff failed: object missing'); }) as never, fetch: (async () => new Response(JSON.stringify({ recorded: true, reviewId: 43 }), { status: 200 })) as unknown as typeof fetch });
    assert.equal(posted.reviewId, 43);
  } finally { await rm(failing, { recursive: true, force: true }); }
});

test('unit:first-round-review-unchanged — a first-round control-plane review gets the prompt it got before, with no hunk check on post, and a Nit: line of a recorded verdict stays in the body out of the blocking findings', async () => {
  // The prompt without an earlier round is the prompt without history at all, byte for byte, and carries none of the delta text.
  const checkout = { directory: '/managed/review/GY-1988', worktree: '/managed/review/GY-1988/checkout' };
  const first = reviewPrompt({ repository: 'owner/project' }, binding, checkout, undefined, criteria, undefined, undefined, null, null, null, null, null, { head: H2, baseTip: B });
  assert.equal(first, reviewPrompt({ repository: 'owner/project' }, binding, checkout, undefined, criteria, { changesRequested: 0 }, undefined, null, null, null, null, null, { head: H2, baseTip: B }), 'an empty history adds nothing');
  assert.ok(!first.includes('Earlier:') && !first.includes(`git diff ${H1}`) && !first.includes('judges only what changed'), 'round one carries no delta section');

  // The launch of a first-round item records no previous head and no delta text.
  const master = await planeMaster();
  try {
    const calls: string[][] = [];
    let request = null as string | null;
    const run = (_command: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') { const typed = expandTypedCommand(args[3]); request = requestOf(typed.kind, typed.args); }
      calls.push(args);
      return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
    };
    await launchReview(master.root, item(), 'delta-reviewer', [], at, { run, registerLaunch: async () => ({ launch: 'launch-1' }) });
    const [record] = (await readReviewLedger(master.root)).reviews;
    assert.deepEqual(record!.reviewRound, { changesRequested: 0 }, 'no previous head without an earlier change request');
    const tab = calls.filter(args => args[0] === 'tab' && args[1] === 'create').at(-1)!;
    const sessionBinding = JSON.parse(await readFile(join(tab.find(value => value.startsWith('GH_CONFIG_DIR='))!.slice('GH_CONFIG_DIR='.length), reviewBindingFile), 'utf8')) as ReviewPostBinding;
    assert.deepEqual([sessionBinding.previousHead, sessionBinding.earlierPaths], [undefined, undefined]);
    assert.ok(request && !request.includes('Earlier:') && !request.includes('judges only what changed'));
  } finally { await master.cleanup(); }

  // A recorded verdict keeps its Nit: lines in the observation's body; they are not blocking findings.
  const verdict = 'AC-1 met.\nBLOCKING: src/a.ts:3 — the flag is unread\nNit: src/unchanged.ts:50 — a typo\nNit: docs/readme.md:2 — another';
  assert.deepEqual(blockingFindings(verdict), ['src/a.ts:3 — the flag is unread']);
  const kept = observedReviewBody(verdict);
  assert.deepEqual([kept.body.includes('Nit: src/unchanged.ts:50 — a typo'), kept.blocking], [true, ['src/a.ts:3 — the flag is unread']]);
});

/** A master root with one reviewer profile and no reviewer App: control-plane launches run without GitHub. */
async function planeMaster() {
  const root = await temporaryDirectory('delta-rounds-master'), credentialDirectory = await temporaryDirectory('delta-rounds-credentials');
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wD' }, coordinatorStatus as typeof fetch);
    await saveReviewerProfile(root, { name: 'delta-reviewer', agentName: reviewer, kind: 'claude' });
    return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
  } catch (error) { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); throw error; }
}
