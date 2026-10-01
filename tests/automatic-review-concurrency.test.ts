import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { automaticReviewerConcurrency, loadMasterConfig, profileConcurrency, setupMaster, withReviewerDefaults, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { assertNameAvailable } from '../src/master-resources.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, saveReviewerProfile } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, selectReviewerProfile, type DispatchEffects } from '../src/auto-dispatch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1072: on 2026-10-01 every automatic review went to the one profile run.reviewerProfile named,
// whose concurrency was unset (one session), and a finished reviewer left idle in its pane held
// that profile's only name, so 26 launches in an hour were refused at the agent-name bound. Each
// test is named for the proof it produces: unit:automatic-reviews-run-in-parallel and
// unit:settled-reviewer-releases-name.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const B = sha40('b1');
const at = '2026-10-01T10:00:00.000Z';
const requestId = (n: number) => createHash('sha256').update(`gy-1072-review-${n}`).digest('hex').slice(0, 32);

function observation(candidate: { sha: string; baseSha: string; pr: number; branch: string }): Observation {
  return { candidate: { ...candidate, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/server/routes/a.ts'], scopeFiles: [{ path: 'src/server/routes/a.ts', status: 'modified' as const, sha: sha40('s'), additions: 1, deletions: 1, binary: false }], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
/** A submitted, observed candidate for item N with an open review request under a fixed id. */
function requested(n: number): Work {
  const now = new Date();
  const candidate = { sha: sha40(`a${n}`), baseSha: B, pr: 500 + n, branch: `graphyard/gy-${500 + n}-1`, author: 'implementer' };
  const item = { id: `work-${500 + n}`, key: `GY-${500 + n}`, title: `Item ${n}`, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:review'] }],
    policy: { checks: ['test', 'typecheck'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: `/w/gy-${500 + n}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [] } as unknown as Work;
  // The review request follows the head's mechanical proofs (GY-115): it is the one a proven twin raises.
  const twin = structuredClone(item);
  twin.evidence = [{ id: 'twin-unit', proof: 'unit:review', sha: candidate.sha, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at }] as Work['evidence'];
  reconcileAutoDispatch(twin, [twin], now);
  item.autoDispatch = { ...twin.autoDispatch!, producers: [], review: { ...twin.autoDispatch!.review!, id: requestId(n) } };
  return item;
}

/**
 * A master bound to a reviewer App with a stubbed Herdr: every typed launch becomes a visible agent,
 * and `pane close` removes one unless the test makes Herdr refuse it.
 */
async function fleet(reviewer: Record<string, unknown>, automatic: string | null) {
  const root = await temporaryDirectory('auto-review'), credentialDirectory = await temporaryDirectory('auto-review-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wC' }, coordinatorStatus as typeof fetch);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, reviewer);
  await saveReviewerProfile(root, { name: 'spare-reviewer', agentName: 'review-spare', kind: 'claude' });
  if (automatic) {
    const file = join(root, '.graphyard/master.json');
    const current = JSON.parse(await readFile(file, 'utf8'));
    current.run.reviewerProfile = automatic;
    await writeFile(file, JSON.stringify(current, null, 2), { mode: 0o600 });
  }
  const agents: HerdrAgent[] = [];
  const calls: string[][] = [];
  const refuseClose = new Set<string>();
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') { panes++; return JSON.stringify({ result: { root_pane: { pane_id: `pane-${panes}`, tab_id: `tab-${panes}` } } }); }
    if (args[0] === 'pane' && (args[1] === 'run' || args[1] === 'read')) return '';
    if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { agent: 'claude', agent_status: 'working', pane_id: args[2] } } });
    if (args[0] === 'agent' && args[1] === 'rename') { agents.push({ name: args[3], pane_id: args[2], agent_status: 'working' }); return JSON.stringify({ result: {} }); }
    if (args[0] === 'pane' && args[1] === 'close') {
      if (refuseClose.has(args[2])) throw new Error('herdr: timed out closing the pane');
      const index = agents.findIndex(agent => agent.pane_id === args[2]); if (index >= 0) agents.splice(index, 1); return JSON.stringify({ result: {} });
    }
    if (args[0] === 'pane' && args[1] === 'list') return JSON.stringify({ result: { panes: [] } });
    return JSON.stringify({ result: {} });
  };
  const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });
  const effects = (items: () => Work[], config: () => MasterConfig, observe: NonNullable<Parameters<typeof reconcileReviews>[2]>['observe'] = () => null): DispatchEffects => ({
    snapshot: async () => ({ work: items(), now: new Date().toISOString() }),
    agents: () => [...agents],
    credentials: async list => Object.fromEntries(list.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: (work, herdr) => reconcileReviews(root, config(), { run, work, agents: herdr, observe }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: (work, request, profile, herdr, observedAt) => launchReview(root, work, profile.name, herdr, observedAt, { run, mint, requestId: request.id }),
    launchProducer: async () => { throw new Error('no producer is launched here'); },
    persist: async () => {},
  }) as DispatchEffects;
  const cleanup = async () => { await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); };
  return { root, agents, calls, run, mint, refuseClose, effects, cleanup };
}
const starts = (calls: string[][]) => calls.filter(call => call[0] === 'agent' && call[1] === 'rename').map(call => call[3]);

test('unit:automatic-reviews-run-in-parallel — with run.reviewerProfile set and its concurrency unset, three concurrent review requests all launch at once and none is refused for the agent-name bound', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    assert.equal(config.run.reviewerProfile, 'claude-reviewer');
    assert.equal(config.reviewers[0].concurrency, undefined, 'the profile declares no concurrency of its own');
    assert.ok(automaticReviewerConcurrency > 1, 'the documented default runs several sessions');
    // The automatic profile reads the default; every other profile keeps one session.
    const { profile } = selectReviewerProfile(config);
    assert.equal(profileConcurrency(profile!), automaticReviewerConcurrency);
    assert.equal(profileConcurrency(withReviewerDefaults(config).reviewers.find(entry => entry.name === 'spare-reviewer')!), 1);
    assert.equal(JSON.parse(await readFile(join(host.root, '.graphyard/master.json'), 'utf8')).reviewers[0].concurrency, undefined, 'the default is read, never written into master.json');

    const items = [requested(1), requested(2), requested(3)];
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => items, () => config), Date.now);
    assert.deepEqual(tick.refused, [], 'no launch is refused');
    assert.deepEqual(tick.waiting.filter(entry => entry.kind === 'review'), [], 'no request waits on the namespace or the limit');
    assert.deepEqual(tick.launched.filter(entry => entry.kind === 'review').map(entry => [entry.work, entry.profile]), [['GY-501', 'claude-reviewer'], ['GY-502', 'claude-reviewer'], ['GY-503', 'claude-reviewer']]);
    const pending = (await readReviewLedger(host.root)).reviews.filter(record => record.state === 'pending');
    assert.equal(pending.length, 3);
    assert.deepEqual(pending.map(record => record.agentName), items.map(item => `claude-reviewer-${item.autoDispatch!.review!.id.slice(0, 8)}`), 'each session is named for its request');
    assert.deepEqual(host.agents.map(agent => agent.name), pending.map(record => record.agentName), 'all three run at once');
    // A fourth review still has a name to take: the namespace is not at its bound.
    assert.doesNotThrow(() => assertNameAvailable('reviewer', profile!, host.agents));

    // Three launches answering three requests at the same moment, outside the dispatcher's turns.
    const parallel = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
    try {
      const more = [requested(4), requested(5), requested(6)];
      const results = await Promise.allSettled(more.map(item => launchReview(parallel.root, item, 'claude-reviewer', [], new Date().toISOString(), { run: parallel.run, mint: parallel.mint, requestId: item.autoDispatch!.review!.id })));
      assert.deepEqual(results.map(result => result.status === 'rejected' ? String(result.reason) : 'launched'), ['launched', 'launched', 'launched']);
      assert.equal(new Set(starts(parallel.calls)).size, 3);
    } finally { await parallel.cleanup(); }

    // A profile that declares its own concurrency keeps it, and without run.reviewerProfile nothing changes.
    assert.equal(profileConcurrency(withReviewerDefaults({ ...config, reviewers: [{ ...config.reviewers[0], concurrency: 2 }] }).reviewers[0]), 2);
    assert.equal(profileConcurrency(withReviewerDefaults({ ...config, run: { ...config.run, reviewerProfile: undefined } }).reviewers[0]), 1);
  } finally { await host.cleanup(); }
});

test('unit:automatic-reviews-run-in-parallel — docs describe the reviewer concurrency default', async () => {
  const text = await readFile(fileURLToPath(new URL('../docs/master-agent.md', import.meta.url)), 'utf8');
  assert.match(text, new RegExp(`run\\.reviewerProfile[^\\n]*${automaticReviewerConcurrency} sessions`), 'docs/master-agent.md states the automatic reviewer profile\'s default concurrency');
});

test('unit:settled-reviewer-releases-name — a reviewer whose request settled but whose pane was left idle is closed on the next pass and the next review launches on its name', async () => {
  // One session at a time, declared: the fixed name is the only one the profile has.
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 1 }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const first = requested(1), second = requested(2);
    const launched = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first], () => config), Date.now);
    assert.deepEqual(launched.launched.map(entry => entry.work), ['GY-501']);
    assert.deepEqual(starts(host.calls), ['claude-reviewer']);
    const pane = host.agents[0].pane_id!;

    // The verdict is posted; Herdr fails to close the pane, so the settled reviewer stays idle in it.
    host.refuseClose.add(pane);
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 501, submittedAt: new Date().toISOString() };
    await reconcileReviews(host.root, config, { run: host.run, work: [first], agents: [...host.agents], observe: record => record.key === 'GY-501' ? verdict : null });
    const settled = (await readReviewLedger(host.root)).reviews.find(record => record.key === 'GY-501')!;
    assert.equal(settled.state, 'completed', 'the request is settled');
    assert.match(settled.closeFailure ?? '', /could not close pane/);
    host.agents[0].agent_status = 'idle';
    assert.deepEqual(host.agents.map(agent => [agent.name, agent.pane_id, agent.agent_status]), [['claude-reviewer', pane, 'idle']]);
    // While it sits there it holds the only name: a launch on it is refused.
    await assert.rejects(launchReview(host.root, second, 'claude-reviewer', [...host.agents], new Date().toISOString(), { run: host.run, mint: host.mint, requestId: second.autoDispatch!.review!.id }), /claude-reviewer is already visible in Herdr/);

    // The next dispatcher pass closes the settled session's pane and launches the next review on the name, in that one tick.
    host.refuseClose.clear();
    const next = await runDispatchTick(config, emptyDispatchCursor(config), host.effects(() => [first, second], () => config), Date.now);
    assert.ok(host.calls.some(call => call[0] === 'pane' && call[1] === 'close' && call[2] === pane), 'the stale pane is closed');
    assert.deepEqual(next.refused, []);
    assert.deepEqual(next.launched.map(entry => entry.work), ['GY-502'], 'the next review launches');
    assert.equal(starts(host.calls).at(-1), 'claude-reviewer', 'on the name the settled reviewer held');
    const ledger = (await readReviewLedger(host.root)).reviews;
    assert.equal(ledger.find(record => record.key === 'GY-501')!.closeFailure, undefined, 'the close failure is cleared once the pane is gone');
    assert.equal(ledger.find(record => record.key === 'GY-502')!.state, 'pending');
    assert.deepEqual(host.agents.map(agent => agent.name), ['claude-reviewer']);
    assert.notEqual(host.agents[0].pane_id, pane);

    // A pending record holding the name is never closed by this pass: the live reviewer keeps its pane.
    const closes = host.calls.filter(call => call[0] === 'pane' && call[1] === 'close').length;
    await reconcileReviews(host.root, config, { run: host.run, work: [first, second], agents: [...host.agents, { name: 'claude-reviewer', pane_id: pane, agent_status: 'idle' }], observe: () => null });
    assert.equal(host.calls.filter(call => call[0] === 'pane' && call[1] === 'close').length, closes);
  } finally { await host.cleanup(); }
});
