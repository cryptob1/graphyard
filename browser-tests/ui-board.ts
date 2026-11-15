// The GY-161 board: the dashboard audit fixture (scripts/dashboard-fixture.mjs) plus the three
// shapes it does not have — an item parked on a decision only the human may make, one being
// merged, and one whose CI is still running — so every group and every pull-request step has a
// row. GY-3396 completes it into a seed of the whole install: every page's read (costs, releases,
// test cases, the product brief, operator automation) answers over the same sanitized copy of this
// install's data — no tokens, no emails — so a browser test loads one fixture and every dashboard
// page has something real to show (`seededApi`), or nothing to list (`emptyApi`).
// The browser suite serves it as the API (browser-tests/screenshots.spec.ts) and the unit
// tests render the same items (tests/ui-dashboard.test.ts), so a screenshot and an assertion are
// about the same board.
// @ts-expect-error Dependency-free fixture script.
import { NOW, fixtureApi, fixtureStatus, fixtureWork } from '../scripts/dashboard-fixture.mjs';
import { boardFromStatus } from '../src/model/board';
import { costSummary, type UsageRow } from '../src/model/token-costs';
import { emptyRegistry } from '../src/model/registry';

export { NOW };
const minute = 60_000, hour = 60 * minute;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const allPassed = () => ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const refusing = (reasons: Record<string, string[]>) => allPassed().map(gate => reasons[gate.name]?.length ? { ...gate, passed: false, reasons: reasons[gate.name] } : gate);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A merged fixture item as live: the release was recorded serving its merge ten minutes after it
 * landed, so it is Shipped, not still at Deploy (web/groups.ts, `servedAt`).
 */
export function live<T>(item: T): T {
  const work = item as any;
  if (work.stage !== 'done' || !work.delivery || work.delivery.deployment) return item;
  const observedAt = new Date(Date.parse(work.delivery.mergedAt) + 10 * minute).toISOString();
  return { ...work, delivery: { ...work.delivery, deployment: { sha: work.delivery.mergeSha, mergeSha: work.delivery.mergeSha, source: 'endpoint', covers: 'exact', observedAt, at: observedAt, observer: 'master' } } };
}

/** Every item on the board, in the shape `GET /api/work-snapshot` returns. */
export function boardWork(): any[] {
  const audit = fixtureWork() as any[];
  const template = audit.find(item => item.key === 'GY-13');
  const make = (n: number, title: string, fields: Record<string, unknown>) => ({ ...template, id: id(n), key: `GY-${n}`, title, description: `${title}.`,
    criteria: [{ id: 'AC-1', text: 'The change works for a signed-in customer.', proofs: [`integration:gy-${n}`] }], ...fields });
  const candidate = (pr: number, head: string) => ({ sha: head, baseSha: sha('b'), pr, branch: `graphyard/pr-${pr}`, author: 'worker', createdAt: at(-3 * hour) });
  const observed = (pr: number, head: string, checks: { name: string; result: string }[], reviews: unknown[] = []) =>
    ({ candidate: candidate(pr, head), checks: checks.map(check => ({ ...check, appId: 1 })), reviews, protected: true, mergeable: true, merged: false, mergeSha: null, mergedAt: null, files: ['src/app.ts'], scopeFiles: [], at: at(-minute) });
  const merging = sha('m'), testing = sha('t');
  const humanRequest = { id: '11111111-2222-4333-8444-555555555555', kind: 'money-or-accounts', reason: 'The live install proof needs a cloud account with a spending cap.',
    needed: 'Approve a spending cap for test installs and add a cloud API token', requestedBy: 'worker-3', epoch: 1, at: at(-10 * hour) };
  // Agent sessions for the Workers page: a builder at work, a reviewer, one recorded running but
  // not seen for forty minutes, and two that ended (one the runtime stopped reporting).
  const session = (id: string, kind: string, principal: string, agentName: string, subject: string, started: number, seen: number, extra: Record<string, unknown> = {}) =>
    ({ id, kind, principal, epoch: null, runtime: 'claude', host: 'build-1', workspace: 'w1', tab: null, pane: `w1:${id}`, agentName, role: kind === 'coordination' ? 'approver' : null, head: null,
      attach: `herdr pane attach w1:${id}`, transcript: null, subject, startedAt: at(started), updatedAt: at(seen), endedAt: null, state: 'running', outcome: null, ...extra });
  const sessions: Record<string, unknown[]> = {
    'GY-14': [session('s14', 'implementation', 'worker-3', 'claude-1', 'Implement GY-14', -18 * minute, -minute)],
    'GY-15': [session('r15', 'review', 'reviewer-1', 'reviewer-gy-15', 'Review PR #42', -6 * minute, -minute),
      session('a15', 'coordination', 'approver-1', 'approver-gy-15', 'Approve the rework request', -40 * minute, -20 * minute, { state: 'finished', endedAt: at(-20 * minute), outcome: 'Approved the rework request', transcript: '/work/transcripts/a15.md' })],
    'GY-12': [session('s12', 'implementation', 'worker-7', 'codex-2', 'Implement GY-12', -2 * hour, -40 * minute)],
    'GY-16': [session('p16', 'proof', 'producer-1', 'producer-gy-16', 'Prove integration:login-latency', -3 * hour, -2 * hour, { state: 'finished', endedAt: at(-2 * hour),
      outcome: `vanished: the claude runtime on build-1 has not reported pane w1:p16 for 70s, 130s after its last observed activity at ${at(-2 * hour - 130_000)}` })],
  };
  return [
    ...audit.map(live).map(item => sessions[item.key] ? { ...item, sessions: sessions[item.key] } : item),
    make(20, 'Prove the one-command install on a real cloud host', { stage: 'build', stageEnteredAt: at(-10 * hour), epoch: 1, owner: 'operator', humanRequest,
      blocker: `Waiting on a human-only decision (spending money or opening third-party accounts): ${humanRequest.needed}`,
      gates: refusing({ ready: [`Waiting on a human-only decision (spending money or opening third-party accounts): ${humanRequest.needed}`], build: ['Worker has not submitted implementation for this attempt'], review: ['Independent approval of the current commit is required'] }) }),
    make(21, 'Cut the documentation to a short set', { stage: 'merge', stageEnteredAt: at(-minute), epoch: 1, owner: 'operator', submission: { epoch: 1, pr: 44 }, candidate: candidate(44, merging),
      // The merge writer's trial of this head is out (GY-2010): the row names where the merge is,
      // the strip counts it, and the item page's Tests panel reads its verdict.
      mergeLedger: { key: 'GY-21', state: 'pushed', head: merging, baseTip: sha('b'), mergeSha: sha('m'), risk: 'ordinary', intentAt: at(-9 * minute), pushedAt: at(-2 * minute), observedTip: sha('b'), refusal: null,
        trial: { head: merging, mergeSha: sha('m'), proofs: { 'unit:docs-words': { executed: 4, failed: 0 } }, build: 'pass', testFiles: 12, preview: null }, events: 3 },
      observation: observed(44, merging, [{ name: 'test', result: 'success' }, { name: 'typecheck', result: 'success' }], [{ reviewer: 'reviewer', sha: merging, state: 'APPROVED', id: 921, submittedAt: at(-20 * minute) }]),
      lastAssignment: { owner: 'worker-2', epoch: 1, displayName: 'Sam', runtime: 'Codex' }, gates: allPassed() }),
    make(22, 'Show the delivery date on each order', { stage: 'review', stageEnteredAt: at(-4 * minute), epoch: 1, submission: { epoch: 1, pr: 45 }, candidate: candidate(45, testing),
      observation: observed(45, testing, [{ name: 'test', result: 'in_progress' }, { name: 'typecheck', result: 'success' }]),
      lastAssignment: { owner: 'worker-7', epoch: 1, displayName: 'Robin', runtime: 'Claude' },
      gates: refusing({ review: ['Independent approval of the current commit is required'], test: ['Required CI check test has not passed on the current candidate'], acceptance: ['AC-1: integration:gy-22 needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy'] }) }),
  ];
}

/**
 * Delivered items in the shape the real board returns them (GY-161, AC-11 and AC-12), modelled on
 * GY-163 as `GET /api/work-snapshot` served it: merged, with a `delivery` that carries no per-item
 * `deployment` (that record is written only when the policy asks for a post-deployment smoke
 * proof), a merge gate still refusing on a speculative tip and a leftover queue entry — and the
 * older shapes seen beside it: no observation at all, an observation without reviews, and no
 * candidate or submission.
 */
export function realDeliveredWork(): any[] {
  const template = (fixtureWork() as any[]).find(item => item.key === 'GY-13');
  const merge = (n: number) => sha(String(n % 10));
  const delivered = (n: number, title: string, mergedHoursAgo: number, fields: Record<string, unknown> = {}) => {
    const mergedAt = at(-mergedHoursAgo * hour);
    const head = sha('a'), candidate = { pr: 100 + n, sha: head, author: 'cryptob1', branch: `graphyard/gy-${n}-1`, baseSha: sha('b'), createdAt: at(-(mergedHoursAgo + 5) * hour) };
    return { ...template, id: id(n), key: `GY-${n}`, title, description: `${title}.`, type: 'feature', stage: 'done', ready: true, epoch: 14, lease: null, blocker: null,
      createdAt: at(-(mergedHoursAgo + 30) * hour), updatedAt: mergedAt, stageEnteredAt: mergedAt, policy: { checks: ['test', 'typecheck'], review: true },
      submission: { pr: candidate.pr, epoch: 14 }, candidate, evidence: [], violations: [], sessions: [], reviewRequest: null, mergeAuthorization: null, mergeExecution: null,
      lastAssignment: { epoch: 14, owner: 'graphyard-claude-1', runtime: 'Claude', claimedAt: at(-(mergedHoursAgo + 2) * hour), displayName: 'Juniper' },
      delivery: { mergeSha: merge(n), mergedAt, evidenceAsOf: mergedAt, mergedAtRepository: mergedAt, authorizationRevision: 810, repositoryClockOffsetMs: -141 },
      observation: { at: mergedAt, draft: false, files: ['web/app.tsx'], checks: [{ id: 1, name: 'test', appId: 15368, result: 'success' }, { id: 2, name: 'typecheck', appId: 15368, result: 'success' }],
        merged: true, baseTip: merge(n), prState: 'closed', reviews: [{ id: 5303188884, sha: head, state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', submittedAt: at(-(mergedHoursAgo + 1) * hour) }],
        mergeSha: merge(n), mergedAt, candidate, mergeable: true, protected: true, reviewIds: [5303188884], scopeFiles: [], conversations: { unresolved: 0 } },
      gates: refusing({ merge: [`Speculative tip on predicted base ${sha('b').slice(0, 12)} is stale`] }),
      queue: { sequence: 191, enqueuedAt: at(-(mergedHoursAgo + 1) * hour), speculation: null }, ...fields };
  };
  return [
    delivered(163, 'Resolve review threads the reviewer listed', 2),
    delivered(164, 'Bound the health check query', 20, { observation: null }),
    delivered(165, 'Record the merge window size', 30, { observation: { at: at(-30 * hour), merged: true, mergeSha: merge(165), mergedAt: at(-30 * hour), checks: [], files: [], candidate: { pr: 265, sha: sha('c'), author: 'cryptob1', branch: 'graphyard/gy-165-1', baseSha: sha('b'), createdAt: at(-40 * hour) } } }),
    delivered(166, 'Delivered before candidates were recorded', 60, { observation: null, candidate: null, submission: null, gates: allPassed(), queue: null }),
  ];
}

/** The status read for the board: the audit fixture's, with the human-only row the server derives for GY-20. */
export function boardStatus(role = 'admin') {
  return { ...fixtureStatus(role), repository: 'fixture/shop',
    // The Delivery view reads the effective delivery declaration the status carries (GY-1901).
    project: { delivery: { previews: 'local', mode: 'managed', candidateMaxChanges: 400, productionVerification: false,
      applications: [{ id: 'shop-web', kind: 'compose', file: 'compose.yaml', service: 'web', port: 8080 }], cases: {} } } };
}

/** The JSON body the control plane would return for `path` over this board. */
export function boardApi(path: string, role = 'admin') {
  const url = new URL(path.replace(/^\/?(api\/)?/, 'http://fixture/api/'));
  const route = url.pathname.slice('/api/'.length);
  const work = boardWork();
  if (route === 'status') return boardStatus(role);
  if (route === 'work-snapshot') return { work, jobs: [], now: at(0) };
  // GET /api/board (GY-200): the server's own module over this board, which the Work page renders.
  if (route === 'board') return boardFromStatus(work as any, NOW, boardStatus(role));
  if (route === 'work') return work;
  // The Tests page (GY-162): one flaky case with history, one skipped, one never run.
  if (route === 'tests') return testsSummary();
  if (route === 'agent-registry') return { configured: false, attention: [], roles: [], accounts: [], runtimes: [], models: [], sessions: [], refusals: [] };
  // The seed's own pages (GY-3396): every read a page makes answers with sanitized install data.
  if (route === 'costs') return seededCosts();
  if (route === 'delivery') return seededDelivery();
  if (route === 'scenarios') return seededScenarios();
  if (route === 'product-brief') return seededProductBrief();
  if (route === 'operator-agents') return seededOperatorAgents();
  return fixtureApi(path, role);
}

/**
 * The same API with nothing to list (GY-3396): every page's read answers with the shape it serves
 * when the install holds none of it, so the empty state each page draws is the one a fresh install
 * shows — the counterpart the seeded pages are compared against.
 */
export function emptyApi(path: string, role = 'admin') {
  const url = new URL(path.replace(/^\/?(api\/)?/, 'http://fixture/api/'));
  const route = url.pathname.slice('/api/'.length);
  if (route === 'status') return boardStatus(role);
  if (route === 'work-snapshot') return { work: [], jobs: [], now: at(0) };
  if (route === 'board') return boardFromStatus([], NOW, boardStatus(role));
  if (route === 'work') return [];
  if (route === 'tests') return { window: 20, cases: [] };
  if (route === 'costs') return costSummary([], { models: [], accounts: [] }, new Set(), NOW);
  if (route === 'delivery') return { environments: [], releases: [], rollbacks: [], now: at(0) };
  if (route === 'scenarios' || route === 'operator-agents' || route === 'events') return [];
  if (route === 'product-brief') return { brief: null };
  if (route === 'agent-registry') return { configured: false, attention: [], roles: [], accounts: [], runtimes: [], models: [], sessions: [], refusals: [] };
  return fixtureApi(path, role);
}

/** What `GET /api/tests` answers over this board: every case with its latest result and history. */
export function testsSummary() {
  const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
  const run = (seq: number, result: 'pass' | 'fail' | 'skipped', commit: number, scenarioId = 'checkout-pays') => ({ seq, scenarioId, proof: `e2e:${scenarioId}`, result, scenarioRevision: 1, environment: 'staging',
    executed: 4, skipped: result === 'skipped' ? 1 : 0, sha: sha(commit), baseSha: sha(9), policyRevision: 1, workId: 'w', workKey: 'GY-16', pr: 40 + commit,
    run: { kind: 'github-actions', id: String(9000 + seq), attempt: 1, url: null }, evidenceId: `e${seq}`, producer: 'e2e-producer', at: at(-seq * hour) });
  // Where each case last ran (GY-3396): the merge writer's test merge, the batch gate on main, the served release.
  const cell = (result: 'pass' | 'fail' | 'skipped', place: string, link: { item: string; key: string } | { url: string } | null, detail: string): { result: 'pass' | 'fail' | 'skipped'; at: string; link: { item: string; key: string } | { url: string } | null; detail: string } =>
    ({ result, at: at(-2 * hour), link, detail: `${place}: ${detail}` });
  const matrix = (cells: Record<string, ReturnType<typeof cell>>) => cells;
  const entry = (id: string, title: string, runs: ReturnType<typeof run>[], extra: Record<string, unknown> = {}) => ({ id, title, purpose: `${title}.`, testPath: `tests/e2e/${id}.spec.ts`, environment: 'staging', revision: 1,
    changed: { at: at(-72 * hour), by: 'operator' }, links: [{ key: 'GY-16', title: 'Checkout', stage: 'review', criteria: ['AC-1'] }], latest: runs[0] ?? null, staleRevision: false,
    runs: runs.length, failures: runs.filter(r => r.result === 'fail').length, lastFailure: runs.find(r => r.result === 'fail') ?? null, flaky: false, flakyReason: null, history: runs, ...extra });
  return { window: 20, cases: [
    entry('checkout-pays', 'Checkout takes payment', [run(1, 'fail', 3), run(2, 'pass', 3), run(3, 'pass', 2)], { flaky: true, flakyReason: `passed and failed on commit ${sha(3).slice(0, 8)}`,
      matrix: matrix({ trial: cell('pass', 'the test merge of GY-21', { item: id(21), key: 'GY-21' }, '12 test files ran, none failed'), main: cell('fail', 'the batch gate on main', { item: id(22), key: 'GY-22' }, 'step 3 expects the totals in dollars'), served: cell('pass', 'the served release', { url: 'https://example.test/run/9003' }, '4 executed, 0 skipped') }) }),
    entry('refund-issued', 'Refunds are issued', [run(4, 'skipped', 3, 'refund-issued')], { matrix: matrix({ trial: cell('skipped', 'the test merge of GY-21', null, 'its environment was busy: 1 skipped') }) }),
    entry('login-works', 'Signing in works', [], { links: [] }),
  ] };
}

/** What `GET /api/costs` answers (GY-3396): the real `costSummary` over sanitized usage of this board's sessions. */
export function seededCosts() {
  const model = (name: string, input: number | null, output: number | null) => ({ name, id: null, cost: input === null ? { inputPerMTok: null, outputPerMTok: null } : { inputPerMTok: input, outputPerMTok: output, asOf: '2026-09-01' }, capability: { tier: 'strong', contextTokens: null } });
  const registry = { ...emptyRegistry(), models: [model('claude-fable-5-2', 8, 40), model('glm-5.3', 1.4, 4.4), model('gpt-6-astra', null, null)], accounts: [{ name: 'claude-a' }, { name: 'zai' }] };
  const row = (id: string, role: UsageRow['role'], account: string, model: string, input: number, output: number, work: string | null): UsageRow =>
    ({ id, work, role, account, runtime: 'stub', model, reported: true, input, output, cacheRead: 0, cacheWrite: 0, at: at(-2 * hour) });
  const rows = [row('u1', 'worker', 'claude-a', 'claude-fable-5-2', 1_000_000, 100_000, 'GY-21'), row('u2', 'reviewer', 'zai', 'glm-5.3', 500_000, 50_000, 'GY-21'), row('u3', 'master', 'claude-a', 'gpt-6-astra', 250_000, 50_000, null)];
  return costSummary(rows, registry as any, new Set(['GY-163']), NOW);
}

/** What `GET /api/delivery` answers (GY-3396): one production environment serving a verified release of this board's delivered work. */
export function seededDelivery() {
  const member = (n: number) => ({ workId: id(n), mergeSha: sha(String(n % 10)), included: true, key: `GY-${n}` });
  const release = { id: 'shop-2026-09-18', revision: 2, environment: { id: 'production', revision: 1 }, sourceSha: sha('a'), buildId: '11111111-1111-4111-8111-111111111111',
    manifest: [{ service: 'web', digest: `sha256:${'0'.repeat(64)}` }], manifestHash: `sha256:${'1'.repeat(64)}`, members: [member(163), member(164)], createdAt: at(-26 * hour), createdBy: 'operator' };
  const environment = { environmentId: 'production', generation: 4,
    expected: { releaseId: release.id, releaseRevision: release.revision, sourceSha: sha('a'), manifestHash: release.manifestHash, buildId: release.buildId, policyRevision: 1, approvalId: null, selectedAt: at(-25 * hour), selectedBy: 'operator' },
    history: [{ generation: 3, releaseId: release.id, releaseRevision: 1, policyRevision: 1, selectedAt: at(-3 * 24 * hour), selectedBy: 'operator', outcome: 'superseded' as const, supersededAt: at(-25 * hour) }],
    coverage: {}, verification: { generation: 4, status: 'verified' as const, reasons: [], interval: { from: at(-24 * hour), to: at(-minute) }, evaluatedAt: at(-minute), verifiedAt: at(-minute) },
    incidents: [], cursor: 12 };
  return { environments: [environment], releases: [release], rollbacks: [], now: at(0) };
}

/** What `GET /api/scenarios` answers (GY-3396): the case registry the Tests page's cases come from, one with two versions. */
export function seededScenarios() {
  const scenario = (id: string, title: string, revision: number) => ({ id, title, purpose: `${title}, stated so a newcomer can check it.`,
    setup: ['A control plane with one signed-in operator'], steps: ['Open the page', 'Read what it states'], expected: ['The page states its facts in plain words', 'Nothing scrolls sideways'],
    environment: 'staging', runner: 'Playwright', testPath: `tests/e2e/${id}.spec.ts`, revision, hash: sha(`${id}:${revision}`), createdAt: at(-revision * 24 * hour), createdBy: 'operator' });
  return [scenario('checkout-pays', 'Checkout takes payment', 2), scenario('checkout-pays', 'Checkout takes payment', 1), scenario('login-works', 'Signing in works', 1)];
}

/** What `GET /api/product-brief` answers (GY-3396): this install's own brief, in the sections the master keeps. */
export function seededProductBrief() {
  return { brief: {
    markdown: [
      '## Problem', 'Building software with AI agents still needs a human to coordinate work, which caps how much one person can ship.',
      '## Users', '- The owner, filing goals from a phone over the tailnet.\n- Projects run on the factory, each with its own install.',
      '## What success looks like', '- A new repository is onboarded with one command and no hand fixes.\n- Stuck items surface at once.',
      '## Current bets', '- The kitchen-style dashboard.',
      '## Open questions', '- When to schedule isolating the credentials workers run under.',
    ].join('\n\n'),
    updatedAt: at(-30 * hour), by: 'master', why: 'Owner direction 2026-09-18', history: [],
  } };
}

/** What `GET /api/operator-agents` answers (GY-3396): the one scoped identity an install past bootstrap carries. */
export function seededOperatorAgents() {
  return [{ id: 'master-loop', displayName: 'Master loop', capabilities: ['work.create', 'work.ready'], scope: { repositories: ['fixture/shop'], workItems: ['*'] },
    fingerprints: ['SHA256:2f2f'], revision: 2, revokedAt: null, lastMutation: { kind: 'update', actor: 'operator', at: at(-40 * hour), reason: 'Scope the loop to this repository' } }];
}
