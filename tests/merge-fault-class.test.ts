import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { GitHub } from '../src/github.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState, reconcilePendingActions, storeAction } from '../src/master-daemon.js';
import { trackFaults } from '../src/model/fault-classes.js';

// GY-1087 names this file for its proof: manual:fault-class-merge. The master loop filed 4 merge
// faults in 24 hours on 1 October 2026. They shared one cause: a merge-path step the control plane
// had made itself was then read back as a fault.
//
//   - merge-refused (GY-1063): publishing a speculative tip pushed the pull request's branch twice,
//     once to reset it to the reviewed head and once for the merge onto it. GitHub raised a
//     pull_request event for each push, and both resolved to the tip. CI's per-PR concurrency
//     cancelled one of the two runs. The cancelled one was the later-created run (36876948155, no
//     jobs), so GitHub read the head's three required CI checks as expected. Auto-merge sat BLOCKED
//     for seven hours, and the merge-now probe was refused: "3 of 4 required status checks are expected".
//   - contaminated (GY-417, GY-971): each was counted seconds after its own ejection, while the
//     restore the ejection owes, which the reconciliation job runs on its own, had not run yet.
//   - action:merge (GY-999): a restart interrupted the guarded merge request. Resuming it is a
//     retry, and it merged on that retry twelve minutes later.
//
// Each instance is replayed below from the ledger and GitHub as they stood when the loop recorded
// it, and asserted not to recur. The file imports nothing the base lacks, so against the base each
// subtest loads and fails on its own assertion: the instance reproduces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const instances = [
  { id: 'action:merge|GY-999|2026-10-01T11:28:27.729Z', kind: 'action:merge', subject: 'GY-999', at: '2026-10-01T11:28:27.729Z' },
  { id: 'contaminated|GY-417|2026-10-01T13:39:08.701Z', kind: 'contaminated', subject: 'GY-417', at: '2026-10-01T13:39:08.701Z' },
  { id: 'merge-refused|GY-1063|2026-10-01T16:57:44.689Z', kind: 'merge-refused', subject: 'GY-1063', at: '2026-10-01T16:57:44.689Z' },
  { id: 'contaminated|GY-971|2026-10-01T22:16:21.164Z', kind: 'contaminated', subject: 'GY-971', at: '2026-10-01T22:16:21.164Z' },
] as const;

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'cryptob1/graphyard', baseBranch: 'main', githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
function item(key: string, at: string, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], stage: 'build', revision: 1, policyRevision: 2,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}

test('manual:fault-class-merge — the item lists 4 instances, and every one is replayed below', () => {
  assert.equal(new Set(instances.map(instance => instance.id)).size, 4);
  assert.deepEqual([...new Set(instances.map(instance => instance.kind))].sort(), ['action:merge', 'contaminated', 'merge-refused']);
});

// ---- merge-refused: one new head, one push ---------------------------------------------------------

/**
 * GitHub as the GY-1063 publication met it: the branch at the earlier tip efccf9dd over the
 * reviewed head d903bbfa, the base branch at 55193b8c, and the merge producing 5e71d9d8. Every
 * write that moves the pull request's branch is a push GitHub raises a pull_request event for.
 */
function gy1063() {
  const branch = 'graphyard/gy-1063-1', login = 'graphyard-cryptob1-graphyard[bot]';
  const reviewed = 'd903bbfaef344efe33cd7c31a6b5b133558b0313', earlierTip = 'efccf9dd69b33ec7f0883032647c14693f27cbfe';
  const base = '55193b8c5915665695b2205451be306005418a6d', tip = '5e71d9d873ce99eb5189929081609b1f327020c6';
  const refs = new Map<string, string>([[`heads/${branch}`, earlierTip], ['heads/main', base]]);
  const pushes: string[] = [];
  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => login;
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (path === '/pulls/538') return { number: 538, state: 'open', draft: false, user: { login: 'implementer' }, head: { sha: refs.get(`heads/${branch}`), ref: branch }, base: { ref: 'main' } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (path === `/commits/${earlierTip}`) return { sha: earlierTip, commit: { message: 'Graphyard speculative tip for GY-1063 behind GY-980', tree: { sha: `f${earlierTip.slice(1)}` } }, parents: [{ sha: reviewed }, { sha: 'a69c4b53d5be9e29086992347c21734174706f31' }], author: { login, type: 'Bot' } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) { const sha = path.slice(9); return { sha, commit: { message: 'GY-1063', tree: { sha: `f${sha.slice(1)}` } }, parents: [{ sha: base }], author: { login: 'implementer', type: 'User' } }; }
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path === '/merges' && method === 'POST') {
      // A merge onto the pull request's branch is a push of the merge commit to it.
      if (body.base === branch) pushes.push(`merge ${tip.slice(0, 12)}`);
      refs.set(`heads/${body.base}`, tip);
      return { sha: tip };
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/')) {
      const name = decodeURIComponent(path.slice('/git/refs/'.length));
      if (name === `heads/${branch}`) pushes.push(`move ${String(body.sha).slice(0, 12)}`);
      refs.set(name, body.sha);
      return { object: { sha: body.sha } };
    }
    if (method !== 'GET') return {};
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const work = item('GY-1063', '2026-10-01T14:31:11.704Z', { stage: 'merge', candidate: { sha: earlierTip, baseSha: 'a69c4b53d5be9e29086992347c21734174706f31', pr: 538, branch } as Work['candidate'],
    submission: { epoch: 2, pr: 538 } as Work['submission'], queue: { sequence: 3, enqueuedAt: '2026-10-01T12:53:51.784Z', policyRevision: 2, speculation: null } as unknown as Work['queue'] });
  const placement = { id: work.id, key: work.key, position: 0, size: 3, sequence: 3, enqueuedAt: '2026-10-01T12:53:51.784Z', waitMs: 0, predecessors: [], predictedBase: base, tip: null,
    base: { sha: base, tree: `f${base.slice(1)}` }, binding: null, current: false, publishable: true, reasons: [] };
  return { github, work, placement: placement as any, pushes, refs, branch, tip };
}

test(`manual:fault-class-merge — ${instances[2].id}: a published tip is one push, so GitHub starts one CI run for the head and reads its required checks`, async () => {
  const { github, work, placement, pushes, refs, branch, tip } = gy1063();
  const speculation = await github.publishSpeculativeTip(work, placement);
  assert.equal(speculation.tip, tip, 'the tip GY-1063 published at 14:31:11');
  assert.equal(refs.get(`heads/${branch}`), tip, 'the pull request carries the tip');
  // GitHub raises one pull_request event per push, each resolving to the branch head when it is
  // delivered. Two events gave the head two CI runs in one concurrency group, and the cancelled one,
  // created later and with no jobs, left GitHub reading the required checks as expected.
  const runs = pushes.length;
  const refusal = runs > 1 ? 'GitHub refused to enqueue GY-1063: GitHub GraphQL query failed: 3 of 4 required status checks are expected.' : null;
  assert.deepEqual(pushes, [`move ${tip.slice(0, 12)}`], `the branch moved once, straight to the tip, not ${JSON.stringify(pushes)}`);
  assert.equal(refusal, null, 'one CI run binds the head: no required check is left expected and the merge is not refused');
});

test('manual:fault-class-merge — the branch restore an ejection owes is one push too (GY-971 restored 5c7065bc at 13:50:15 with two)', async () => {
  const branch = 'graphyard/gy-971-1', login = 'graphyard-cryptob1-graphyard[bot]';
  const contaminated = '424d5a53da9bba56cb1592aed548839eb35af1df', own = '5c7065bcf08a357ff8b50ddba402c2bc1f9d491b';
  const base = '55193b8c5915665695b2205451be306005418a6d', restored = 'abababababababababababababababababababab';
  const refs = new Map<string, string>([[`heads/${branch}`, contaminated]]);
  const pushes: string[] = [];
  const github = new GitHub({ repository: 'cryptob1/graphyard', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  github.controlPlaneLogin = async () => login;
  github.request = async (path: string, method = 'GET', body?: any) => {
    if (path === '/pulls/524') return { number: 524, state: 'open', draft: false, user: { login: 'implementer' }, head: { sha: contaminated, ref: branch }, base: { ref: 'main' } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: base } };
    if (path === `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`) return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha: refs.get(`heads/${branch}`) } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) { const sha = path.slice(9); return { sha, commit: { message: 'Graphyard branch restore', tree: { sha: `f${sha.slice(1)}` } }, parents: [{ sha: own }, { sha: base }], author: { login, type: 'Bot' } }; }
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path === '/merges' && method === 'POST') { if (body.base === branch) pushes.push('merge'); refs.set(`heads/${body.base}`, restored); return { sha: restored }; }
    if (method === 'PATCH' && path.startsWith('/git/refs/')) { const name = decodeURIComponent(path.slice('/git/refs/'.length)); if (name === `heads/${branch}`) pushes.push('reset'); refs.set(name, body.sha); return { object: { sha: body.sha } }; }
    if (method !== 'GET') return {};
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const work = item('GY-971', '2026-10-01T13:49:55.646Z', { candidate: { sha: contaminated, baseSha: base, pr: 524, branch } as Work['candidate'], submission: { epoch: 1, pr: 524 } as Work['submission'],
    observation: { baseTip: base } as Work['observation'] });
  const refresh = await github.restoreBranch(work, { contaminated, foreign: ['GY-980', 'GY-1063'], own, cause: 'ejection', requested: null, reason: 'ejected from the merge queue' });
  assert.deepEqual([refresh.restore!.outcome, refresh.head, refs.get(`heads/${branch}`)], ['restored', restored, restored]);
  assert.equal(pushes.length, 1, `the branch moved once, not ${JSON.stringify(pushes)}`);
});

// ---- contaminated: the restore an ejection owes, seconds after the ejection -----------------------

const contaminations = [
  { instance: instances[1], head: 'b101278aabeb07afef8469847a7ef27c7c27adba', own: 'f83043604467769c5626b75c8a4c58198bd93745', ejectedAt: '2026-10-01T13:38:53.610Z',
    reason: 'Speculative merge of a69c4b53d5be into graphyard/gy-417-1 conflicts and cannot be resolved by Graphyard' },
  { instance: instances[3], head: 'd6717310407eefa08d89cd6fedbd179abfe18f09', own: '5c7065bcf08a357ff8b50ddba402c2bc1f9d491b', ejectedAt: '2026-10-01T22:15:28.651Z',
    reason: 'Landing speculative tip d6717310407e on 44118686e5bc would revert work outside its planned files: docs/github.md' },
];
for (const entry of contaminations) {
  test(`manual:fault-class-merge — ${entry.instance.id}: an ejected tip whose restore is owed is a handoff in motion, not a merge fault`, () => {
    const key = entry.instance.subject, now = Date.parse(entry.instance.at), branch = `graphyard/${key.toLowerCase()}-1`;
    const base = '55193b8c5915665695b2205451be306005418a6d';
    const ejected = (ejectedAt: string) => item(key, ejectedAt, {
      candidate: { sha: entry.head, baseSha: base, pr: 500, branch } as Work['candidate'], submission: { epoch: 1, pr: 500 } as Work['submission'],
      observation: { candidate: { sha: entry.head, baseSha: base, pr: 500, branch }, merged: false, prState: 'open', checks: [], reviews: [], files: [], scopeFiles: [], at: entry.instance.at, baseTip: base } as unknown as Work['observation'],
      queueEjection: { at: ejectedAt, sequence: 977, reason: entry.reason, sha: entry.head, policyRevision: 2, predecessors: ['GY-1063'] },
      queueHistory: [{ at: ejectedAt, event: 'predicted', sequence: 977, tip: entry.head, predecessors: ['GY-1063'], from: entry.own }] as Work['queueHistory'],
    });
    // GY-1063 had not landed at either instant: its unlanded commits are what the tip carried.
    const predecessor = item('GY-1063', entry.ejectedAt, { stage: 'merge' });
    const faults = (work: Work) => cycleFaults(emptyDaemonState(config()), [work, predecessor], now, { config: config() }).filter(fault => fault.subject === key && fault.kind === 'contaminated');
    assert.deepEqual(faults(ejected(entry.ejectedAt)), [], `seconds after the ejection (${entry.ejectedAt}), the owed restore is the control plane's own next step`);
    // Not weakened: the same head, its restore still owed long after the ejection, is a merge fault.
    assert.equal(faults(ejected(new Date(Date.parse(entry.ejectedAt) - 2 * 3_600_000).toISOString())).length, 1, 'a restore owed for two hours still counts');
  });
}

// ---- action:merge: a guarded merge a restart interrupted ------------------------------------------

test(`manual:fault-class-merge — ${instances[0].id}: a merge request a restart interrupted is retried, not counted as a merge fault`, () => {
  const now = Date.parse(instances[0].at);
  const state = emptyDaemonState(config());
  const head = '0a8649094eb12adcfb40fecc0b5c7f6ad5b7b449', key = `merge:work-GY-999:${head}:8f0e21d734c4652cf2b2b2b15af3832873bf5cbf:1`;
  storeAction(state, key, { kind: 'merge', work: 'GY-999', principal: null, state: 'started', detail: 'Requesting the guarded merge of GY-999', attempts: 1, epoch: 1, cycle: 0, at: new Date(now - 60_000).toISOString() });
  const unmerged = item('GY-999', instances[0].at, { stage: 'merge', candidate: { sha: head, baseSha: '8f0e21d734c4652cf2b2b2b15af3832873bf5cbf', pr: 530, branch: 'graphyard/gy-999-1' } as Work['candidate'] });
  const [resumed] = reconcilePendingActions(state, [unmerged], now);
  assert.equal(resumed.detail, 'Resumed: no merge was observed; the guarded merge may be attempted again');
  assert.equal(resumed.state, 'failed', 'the merge is still owed, so the loop asks again');
  assert.equal(resumed.faultClass ?? null, null, 'the retry carries no fault class');
  trackFaults(state.faults, [], new Date(now).toISOString());
  assert.deepEqual(state.faults.instances.filter(entry => entry.kind === 'action:merge'), [], 'no merge fault instance is recorded');
  // Not weakened: a merge request that itself fails is still a merge fault.
  storeAction(state, 'merge:refused', { kind: 'merge', work: 'GY-999', principal: null, state: 'failed', detail: 'GitHub refused the guarded merge', attempts: 1, epoch: 1, cycle: 1, at: new Date(now).toISOString() });
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'action:merge').length, 1);
});

// ---- base-conflict: self-handled base refresh conflict in rework or under 30 minutes (GY-1129) ----

const gy1129Instances = [
  { id: 'base-conflict|GY-501|2026-10-03T01:48:21.031Z', kind: 'base-conflict', subject: 'GY-501', at: '2026-10-03T01:48:21.031Z',
    head: 'bfe5c971a12513ea32dbf6828557343e7c8449c2', base: '1f8c8d17a255304a991873ea2f64fa4c5ea2c2bf',
    conflict: 'Candidate bfe5c971a125 cannot be brought onto base branch tip 1f8c8d17a255 without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of 1f8c8d17a255 into graphyard-merge-check/gy-501 conflicts and cannot be resolved by Graphyard. Run graphyard sync GY-501, resolve it and push; the approval and proofs bound to bfe5c971a125 do not survive the resolution.',
    stage: 'merge', reworkRequested: true },
  { id: 'base-conflict|GY-1073|2026-10-03T02:08:38.001Z', kind: 'base-conflict', subject: 'GY-1073', at: '2026-10-03T02:08:38.001Z',
    head: 'cf391b944d4fd37ab8706fa2bbcfba4bbd698e4f', base: 'e7ab679fb2ebaa0d087b32873afda18e8d8ee5ff',
    conflict: 'Candidate cf391b944d4f cannot be brought onto base branch tip e7ab679fb2eb without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of e7ab679fb2eb into graphyard-merge-check/gy-1073 conflicts and cannot be resolved by Graphyard. Run graphyard sync GY-1073, resolve it and push; the approval and proofs bound to cf391b944d4f do not survive the resolution.',
    stage: 'build', reworkRequested: false },
  { id: 'base-conflict|GY-417|2026-10-03T02:14:59.107Z', kind: 'base-conflict', subject: 'GY-417', at: '2026-10-03T02:14:59.107Z',
    head: '938b292d6ea58324dbec487c44f4089d0063ebee', base: 'e7ab679fb2ebaa0d087b32873afda18e8d8ee5ff',
    conflict: 'Candidate 938b292d6ea5 cannot be brought onto base branch tip e7ab679fb2eb without resolving a conflict, which is content nobody reviewed or proved: Speculative merge of e7ab679fb2eb into graphyard-merge-check/gy-417 conflicts and cannot be resolved by Graphyard. Run graphyard sync GY-417, resolve it and push; the approval and proofs bound to 938b292d6ea5 do not survive the resolution.',
    stage: 'merge', reworkRequested: false },
] as const;

for (const entry of gy1129Instances) {
  test(`manual:fault-class-merge — ${entry.id}: a base conflict in rework or under 30 minutes is self-handled, not a merge fault`, () => {
    const key = entry.subject, now = Date.parse(entry.at), branch = `graphyard/${key.toLowerCase()}-1`;
    const conflicting = (at: string, reworkRequested = entry.reworkRequested, stage = entry.stage) => item(key, at, {
      stage: stage as Work['stage'],
      reworkRequested,
      candidate: { sha: entry.head, baseSha: entry.base, pr: 500, branch } as Work['candidate'],
      submission: { epoch: 1, pr: 500 } as Work['submission'],
      observation: { candidate: { sha: entry.head, baseSha: entry.base, pr: 500, branch }, merged: false, prState: 'open', checks: [], reviews: [], files: [], scopeFiles: [], at, baseTip: entry.base } as unknown as Work['observation'],
      baseRefresh: { from: { sha: entry.head, baseSha: entry.base }, base: entry.base, baseTree: '', policyRevision: 2, at, head: null, conflict: entry.conflict, merge: null, carry: null } as Work['baseRefresh'],
    });
    const faults = (work: Work, testNow = now) => cycleFaults(emptyDaemonState(config()), [work], testNow, { config: config() }).filter(fault => fault.subject === key && fault.kind === 'base-conflict');
    assert.deepEqual(faults(conflicting(entry.at)), [], `at recorded time (${entry.at}), the base conflict is in rework or motion and not counted as a merge fault`);
    // Not weakened: the same conflict unhandled after two hours with no rework requested is a merge fault.
    assert.equal(faults(conflicting(new Date(now - 2 * 3_600_000).toISOString(), false, 'merge'), now).length, 1, 'a base conflict unhandled for two hours still counts as a merge fault');
    assert.equal(faults(conflicting(new Date(now - 2 * 3_600_000).toISOString(), false, 'build'), now).length, 1, 'returned to build with no rework decided for two hours, it still counts as a merge fault');
  });
}
