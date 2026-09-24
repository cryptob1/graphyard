// The GY-161 board: the dashboard audit fixture (scripts/dashboard-fixture.mjs) plus the three
// shapes it does not have — an item parked on a decision only the human may make, one being
// merged, and one whose CI is still running — so every group and every pull-request step has a
// row. The browser suite serves it as the API (browser-tests/screenshots.spec.ts) and the unit
// tests render the same items (tests/ui-dashboard.test.ts), so a screenshot and an assertion are
// about the same board.
// @ts-expect-error Dependency-free fixture script.
import { NOW, fixtureApi, fixtureStatus, fixtureWork, flowApi } from '../scripts/dashboard-fixture.mjs';

export { NOW };
const minute = 60_000, hour = 60 * minute;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const allPassed = () => ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const refusing = (reasons: Record<string, string[]>) => allPassed().map(gate => reasons[gate.name]?.length ? { ...gate, passed: false, reasons: reasons[gate.name] } : gate);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
  return [
    ...audit,
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
  if (route === 'work') return work;
  if (route.startsWith('analytics/flow')) return flowApi(work, role)(path);
  if (route === 'interventions') return { total: 1, deliveries: 3, ratePerDelivery: 0.33, window: { days: 30 }, open: 1, waitedMs: 10 * hour, ledger: { truncated: false, rows: 40 },
    byKindAndStage: [], costliest: [], patterns: [], policy: { threshold: 3, windowDays: 7 }, judgements: [], interventions: [],
    trend: Array.from({ length: 5 }, (_, index) => ({ from: at((index - 5) * 7 * 24 * hour), interventions: index === 4 ? 1 : 0, deliveries: index % 2, waitedMs: index === 4 ? 10 * hour : 0 })) };
  if (route === 'agent-registry') return { configured: false, attention: [], roles: [], accounts: [], runtimes: [], models: [], sessions: [], refusals: [] };
  return fixtureApi(path, role);
}
