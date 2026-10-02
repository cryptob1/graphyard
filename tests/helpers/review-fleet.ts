import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../../src/model.js';
import { reconcileAutoDispatch } from '../../src/model/dispatch.js';
import { setupMaster, type HerdrAgent, type MasterConfig } from '../../src/master.js';
import { bindReviewer, launchReview, reconcileReviews, saveReviewerProfile } from '../../src/reviewer.js';
import type { DispatchEffects } from '../../src/auto-dispatch.js';
import { temporaryDirectory } from './temp-dirs.js';

// The automatic-review fleet (GY-1072): a master bound to a reviewer App over a stubbed Herdr, and
// review requests for it, shared by tests/automatic-review-concurrency.test.ts and the soak.

const launcher = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));
export const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
export const B = sha40('b1');
const at = '2026-10-01T10:00:00.000Z';
export const requestId = (n: number) => createHash('sha256').update(`gy-1072-review-${n}`).digest('hex').slice(0, 32);

function observation(candidate: { sha: string; baseSha: string; pr: number; branch: string }): Observation {
  return { candidate: { ...candidate, author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/server/routes/a.ts'], scopeFiles: [{ path: 'src/server/routes/a.ts', status: 'modified' as const, sha: sha40('s'), additions: 1, deletions: 1, binary: false }], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true };
}
/** A submitted, observed candidate for item N (its HEAD-th head) with an open review request under a fixed id. */
export function requested(n: number, head = 1): Work {
  const now = new Date();
  const candidate = { sha: sha40(head === 1 ? `a${n}` : `a${n}e${head}`), baseSha: B, pr: 500 + n, branch: `graphyard/gy-${500 + n}-1`, author: 'implementer' };
  const item = { id: `work-${500 + n}`, key: `GY-${500 + n}`, title: `Item ${n}`, description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Unit', proofs: ['unit:review'] }],
    policy: { checks: ['test', 'typecheck'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: `/w/gy-${500 + n}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: candidate.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [] } as unknown as Work;
  // The review request follows the head's mechanical proofs (GY-115): it is the one a proven twin raises.
  const twin = structuredClone(item);
  twin.evidence = [{ id: 'twin-unit', proof: 'unit:review', sha: candidate.sha, baseSha: B, policyRevision: 1, producer: 'independent-runner', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at }] as Work['evidence'];
  reconcileAutoDispatch(twin, [twin], now);
  item.autoDispatch = { ...twin.autoDispatch!, producers: [], review: { ...twin.autoDispatch!.review!, id: requestId(head === 1 ? n : n * 100 + head) } };
  return item;
}

/**
 * A master bound to a reviewer App with a stubbed Herdr: every typed launch becomes a visible agent,
 * and `pane close` removes one unless the test makes Herdr refuse it: `refuseClose` maps a pane to
 * how many more closes Herdr refuses (Infinity: every one). `closes` lists every close asked for.
 */
export async function fleet(reviewer: Record<string, unknown>, automatic: string | null) {
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
  const refuseClose = new Map<string, number>();
  const closes: string[] = [];
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab' && args[1] === 'create') { panes++; return JSON.stringify({ result: { root_pane: { pane_id: `pane-${panes}`, tab_id: `tab-${panes}` } } }); }
    if (args[0] === 'pane' && (args[1] === 'run' || args[1] === 'read')) return '';
    if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { agent: 'claude', agent_status: 'working', pane_id: args[2] } } });
    if (args[0] === 'agent' && args[1] === 'rename') { agents.push({ name: args[3], pane_id: args[2], agent_status: 'working' }); return JSON.stringify({ result: {} }); }
    if (args[0] === 'pane' && args[1] === 'close') {
      closes.push(args[2]);
      const refusals = refuseClose.get(args[2]) ?? 0;
      if (refusals > 0) { refuseClose.set(args[2], refusals - 1); throw new Error('herdr: timed out closing the pane'); }
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
  return { root, agents, calls, closes, run, mint, refuseClose, effects, cleanup };
}
export const starts = (calls: string[][]) => calls.filter(call => call[0] === 'agent' && call[1] === 'rename').map(call => call[3]);

