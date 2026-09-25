// The GY-161 board: the dashboard audit fixture (scripts/dashboard-fixture.mjs) plus the three
// shapes it does not have — an item parked on a decision only the human may make, one being
// merged, and one whose CI is still running — so every group and every pull-request step has a
// row. The browser suite serves it as the API (browser-tests/screenshots.spec.ts) and the unit
// tests render the same items (tests/ui-dashboard.test.ts), so a screenshot and an assertion are
// about the same board.
// @ts-expect-error Dependency-free fixture script.
import { NOW, fixtureApi, fixtureStatus, fixtureWork, flowApi } from '../scripts/dashboard-fixture.mjs';
import { boardFromStatus } from '../src/model/board';

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
  const make = (n: number, title: string, fields: Record<string, unknown>) => ({ ...template, id: id(n), key: `GY-${n}`, title, description: `${title}.`, ...fields });
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
    make(20, 'Prove the one-command install on a real cloud host', { stage: 'build', stageEnteredAt: at(-10 * hour), epoch: 1, humanRequest,
      blocker: `Waiting on a human-only decision (spending money or opening third-party accounts): ${humanRequest.needed}`,
      gates: refusing({ ready: [`Waiting on a human-only decision (spending money or opening third-party accounts): ${humanRequest.needed}`], build: ['Worker has not submitted implementation for this attempt'], review: ['Independent approval of the current commit is required'] }) }),
    make(21, 'Cut the documentation to a short set', { stage: 'merge', stageEnteredAt: at(-minute), epoch: 1, submission: { epoch: 1, pr: 44 }, candidate: candidate(44, merging),
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
  return { ...fixtureStatus(role), repository: 'fixture/shop' };
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
  if (route.startsWith('analytics/flow')) return flowApi(work, role)(path);
  if (route === 'interventions') return { total: 1, deliveries: 3, ratePerDelivery: 0.33, window: { days: 30 }, open: 1, waitedMs: 10 * hour, ledger: { truncated: false, rows: 40 },
    byKindAndStage: [], costliest: [], patterns: [], policy: { threshold: 3, windowDays: 7 }, judgements: [], interventions: [],
    trend: Array.from({ length: 5 }, (_, index) => ({ from: at((index - 5) * 7 * 24 * hour), interventions: index === 4 ? 1 : 0, deliveries: index % 2, waitedMs: index === 4 ? 10 * hour : 0 })) };
  if (route === 'agent-registry') return { configured: false, attention: [], roles: [], accounts: [], runtimes: [], models: [], sessions: [], refusals: [] };
  return fixtureApi(path, role);
}
