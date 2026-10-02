import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Evidence, Work } from '../src/model.js';
import type { ScenarioRun } from '../src/model/test-cases.js';
import type { CaseSummary } from '../src/test-runs.js';
import type { Scenario } from '../src/scenarios.js';
// @ts-expect-error the checked-in dashboard fixture is plain JavaScript
import { fixtureApi, fixtureStatus, fixtureWork, NOW } from '../scripts/dashboard-fixture.mjs';
import { live } from '../browser-tests/ui-board.js';
import { predictQueue } from '../src/merge-queue.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import WorkDetails from '../web/pages/work-details.js';
import { TestCasesView } from '../web/components/test-cases.js';
import { TestsView } from '../web/pages/tests.js';
import { primaryEntries, viewFor, visibleViews } from '../web/pages/index.js';

// GY-162: the work item page lists the end-to-end cases linked to its pull request with their
// result on the current head, and the Tests page lists every case with its latest result, last
// change and failure history.
const head = 'a'.repeat(40), old = 'b'.repeat(40), base = 'c'.repeat(40);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const scenario = (id: string, title: string, testPath = `tests/e2e/${id}.spec.ts`, revision = 1) =>
  ({ id, title, purpose: `${title}.`, setup: [], steps: ['Do it'], expected: ['It works'], environment: 'staging', runner: 'Playwright', testPath, revision, hash: 'h', createdAt: iso(-86_400_000), createdBy: 'operator' }) as Scenario;
const evidence = (proof: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: `ev-${proof}-${overrides.sha ?? head}-${overrides.result ?? 'pass'}`, proof, sha: head, baseSha: base, policyRevision: 1, producer: 'e2e-producer', trusted: true,
  result: 'pass', executed: 4, skipped: 0, at: iso(-60_000), scenarioRevision: 1, environment: 'staging', ...overrides });

/** An item in review whose criteria name four cases, each in a different state on the current head. */
function linkedItem(): Work {
  const base0 = (fixtureWork() as any[]).map(live)[0] as Work;
  const proofs = ['e2e:checkout-pays', 'e2e:refund-issued', 'e2e:receipt-mailed', 'e2e:login-works', 'e2e:search-finds'];
  return { ...base0, id: 'gy-162-probe', key: 'GY-162', stage: 'review', implementers: ['builder'], workspaces: [], lease: null, lastAssignment: undefined,
    criteria: [{ id: 'AC-1', text: 'Checkout works end to end', proofs: proofs.slice(0, 3) }, { id: 'AC-2', text: 'Signing in and searching work', proofs: proofs.slice(3) }],
    scenarioRequirements: proofs.map(proof => ({ proof, revision: 1, environment: 'staging', hash: 'h' })),
    candidate: { sha: head, baseSha: base, pr: 162, branch: 'graphyard/gy-162-1', author: 'builder' }, policyRevision: 1,
    observation: { ...(base0.observation ?? {}), candidate: { sha: head, baseSha: base, pr: 162, branch: 'graphyard/gy-162-1', author: 'builder' }, files: ['src/checkout.ts', 'tests/e2e/cart-totals.spec.ts'] } as Work['observation'],
    evidence: [
      evidence('e2e:checkout-pays', { ciRun: undefined, provenance: { provider: 'github-actions', repository: 'o/r', workflowCommit: head, runId: '4242', runAttempt: 2, artifact: { id: 1, name: 'report', digest: 'sha256:x', url: 'https://example.test/a', createdAt: iso(0) } } }),
      evidence('e2e:refund-issued', { result: 'fail' }),
      evidence('e2e:receipt-mailed', { executed: 3, skipped: 1 }),
      // A pass on an older head, and a builder's own assertion on this one: neither is a result on the current head.
      evidence('e2e:login-works', { sha: old }),
      evidence('e2e:search-finds', { producer: 'builder', trusted: false }),
    ] };
}
const registry = [scenario('checkout-pays', 'Checkout takes payment'), scenario('refund-issued', 'Refunds are issued'), scenario('cart-totals', 'Cart totals add up'), scenario('cart-totals', 'Cart totals (first draft)', 'tests/e2e/old.spec.ts', 0)];

function dashboard(work: Work[]): Dashboard {
  return { token: 'fixture', work, status: fixtureStatus('admin'), error: '', connected: true, lastUpdated: '12:00:00', view: 'work', setView: noop, filter: null, setFilter: noop,
    selected: null, setSelected: noop, creating: false, setCreating: noop, busy: false, setBusy: noop, observedAt: NOW, jobs: [], query: '', setQuery: noop,
    operatorAgents: [], operatorAgentsError: null, features: {} as any, events: [], editingRequirements: false, setEditingRequirements: noop, codexAvailable: false,
    queue: predictQueue(work, NOW), sessionEpoch: { current: 0 }, api: async (path: string) => fixtureApi(path, 'admin'), refresh: async () => {}, action: async () => {},
    setError: noop, signOut: noop } as unknown as Dashboard;
}

test('unit:test-case-repository-ui — a work item page lists the end-to-end cases linked to its pull request with their result on the current head', () => {
  const item = linkedItem();
  const html = renderToStaticMarkup(createElement(TestCasesView, { item, registry, now: new Date(NOW) }));
  const row = (id: string) => text(new RegExp(`<li data-case="${id}">([\\s\\S]*?)</li>`).exec(html)![1]);
  assert.match(text(html), /Test cases 1 of 5 passed on the current head/);
  assert.match(row('checkout-pays'), /✓ passed e2e:checkout-pays Checkout takes payment · AC-1 · v1 in staging/);
  assert.match(row('checkout-pays'), /4 executed \/ 0 skipped · github-actions run 4242 attempt 2 · e2e-producer/);
  assert.match(row('refund-issued'), /× failed e2e:refund-issued Refunds are issued/);
  assert.match(row('receipt-mailed'), /◌ skipped e2e:receipt-mailed/, 'a skipped run is its own state, never a pass');
  assert.match(row('login-works'), /○ not run on this head e2e:login-works · AC-2/, 'a pass on an older head is not a result on this one');
  assert.match(row('search-finds'), /○ not run on this head/, 'a builder\'s own assertion is never a result');
  // A registered case whose test file the pull request changes is listed apart, and never as required.
  assert.match(text(html), /Touched by this pull request · not required e2e: cart-totals Cart totals add up · changes tests\/e2e\/cart-totals\.spec\.ts/);
  // Without a pull request there is no head to report on.
  const unsubmitted = { ...item, candidate: null, observation: null };
  assert.match(text(renderToStaticMarkup(createElement(TestCasesView, { item: unsubmitted, registry: null, now: new Date(NOW) }))), /0 of 5 passed on no head yet.*○ no pull request yet e2e:checkout-pays/);
  // An item with no end-to-end case shows no section at all.
  const plain = { ...item, criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }], observation: { ...item.observation!, files: [] } };
  assert.equal(renderToStaticMarkup(createElement(TestCasesView, { item: plain, registry, now: new Date(NOW) })), '');
  // On the page itself it sits between Pull request and Activity.
  const page = renderToStaticMarkup(createElement(WorkDetails, { ...dashboard([item]), item }));
  const order = ['aria-label="Pull request"', 'aria-label="Test cases"', 'aria-label="Activity"'].map(label => page.indexOf(label));
  assert.ok(order.every(index => index > 0) && order[0] < order[1] && order[1] < order[2], `section order ${order}`);
});

const at = (seq: number, result: ScenarioRun['result'], sha = head, extra: Partial<ScenarioRun> = {}): ScenarioRun => ({ seq, scenarioId: 'checkout-pays', proof: 'e2e:checkout-pays', result, scenarioRevision: 1, environment: 'staging', executed: 4, skipped: result === 'skipped' ? 1 : 0,
  sha, baseSha: base, policyRevision: 1, workId: 'w', workKey: 'GY-162', pr: 162, run: { kind: 'github-actions', id: String(9000 + seq), attempt: 1, url: `https://example.test/${seq}` }, evidenceId: `e${seq}`, producer: 'e2e-producer', at: iso(-seq * 60_000), ...extra });
const summary = (overrides: Partial<CaseSummary>): CaseSummary => ({ id: 'checkout-pays', title: 'Checkout takes payment', purpose: 'Paying completes an order.', testPath: 'tests/e2e/checkout.spec.ts', environment: 'staging', revision: 2,
  changed: { at: iso(-3_600_000), by: 'operator' }, links: [{ key: 'GY-162', title: 'Tests page', stage: 'review', criteria: ['AC-1'] }], latest: null, staleRevision: false, runs: 0, failures: 0, lastFailure: null, flaky: false, flakyReason: null, history: [], ...overrides });

test('unit:test-case-repository-ui — the Tests page lists every case with its latest result, last change and failure history, and flags flaky cases', () => {
  const flaky = summary({ latest: at(3, 'fail'), staleRevision: true, runs: 25, failures: 2, lastFailure: at(3, 'fail'), flaky: true, flakyReason: `passed and failed on commit ${head.slice(0, 8)}`,
    history: [at(3, 'fail'), at(2, 'pass'), at(1, 'fail', old, { withdrawn: true })] });
  const steady = summary({ id: 'refund-issued', title: 'Refunds are issued', latest: at(5, 'skipped'), runs: 1, history: [at(5, 'skipped')] });
  const never = summary({ id: 'login-works', title: 'Signing in works', links: [] });
  const orphan = summary({ id: 'retired-case', title: null, revision: null, changed: null, latest: at(7, 'pass'), runs: 1, history: [at(7, 'pass')] });
  const data = { window: 20, cases: [flaky, steady, never, orphan] };
  const render = (filter: 'all' | 'fail' | 'flaky' | 'never' = 'all') => renderToStaticMarkup(createElement(TestsView, { data, error: '', loading: false, filter, setFilter: noop, retry: noop, api: async () => ({}), canEdit: true, setView: noop }));
  const html = render();
  const row = (id: string) => text(new RegExp(`<tr data-case="${id}">([\\s\\S]*?)</tr>`).exec(html)![1]);
  assert.deepEqual([...html.matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['checkout-pays', 'refund-issued', 'login-works', 'retired-case'], 'every case is listed');
  // Latest result, bound to its commit and pull request; the revision it measured when the case has since changed.
  assert.match(row('checkout-pays'), new RegExp(`× failed ${head.slice(0, 8)} · PR #162`));
  assert.match(row('checkout-pays'), /measured v1; the case is now v2/);
  // Last change: the latest definition's revision, time and author.
  assert.match(row('checkout-pays'), /v2 · .* by operator/);
  // Failure history: how many, the last one, and every recorded run with its commit and run.
  assert.match(row('checkout-pays'), new RegExp(`2 last .* on ${head.slice(0, 8)}`));
  assert.match(row('checkout-pays'), /History · 25 runs/);
  assert.match(row('checkout-pays'), /github-actions run 9002 attempt 1/);
  assert.match(row('checkout-pays'), new RegExp(`× failed ${old.slice(0, 8)} .* withdrawn`), 'a withdrawn run stays visible, marked');
  assert.match(html, /Show older runs/, 'older runs page from the run ledger');
  assert.match(row('checkout-pays'), /flaky: passed and failed on commit aaaaaaaa/);
  assert.match(text(html), /changed result twice or more in its last 20 runs/, 'the flaky window is named');
  assert.match(row('checkout-pays'), /GY-162 AC-1/, 'linked work items');
  assert.match(row('refund-issued'), /◌ skipped/); assert.match(row('refund-issued'), /none/);
  assert.match(row('login-works'), /○ never run/);
  assert.match(row('retired-case'), /not in the registry/);
  // Filters narrow to failing, flaky and never-run cases, each with its count.
  assert.match(text(html), /All 4 Failing 1 Flaky 1 Never run 1/);
  assert.deepEqual([...render('never').matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['login-works']);
  assert.deepEqual([...render('flaky').matchAll(/<tr data-case="([^"]+)"/g)].map(match => match[1]), ['checkout-pays']);
  // Empty, loading and failed reads each say what they are.
  const view = (props: object) => text(renderToStaticMarkup(createElement(TestsView, { data: null, error: '', loading: false, filter: 'all', setFilter: noop, retry: noop, api: async () => ({}), canEdit: false, ...props })));
  assert.match(view({ data: { window: 20, cases: [] } }), /No test cases yet/);
  assert.match(view({ loading: true }), /Loading tests/);
  assert.match(view({ error: 'unavailable' }), /unavailable Retry loading tests/);
});

test('unit:test-case-repository-ui — Tests is a live sidebar entry, shown before any run, and not offered to operator agents', () => {
  const as = (role: string) => ({ ...dashboard([]), status: fixtureStatus(role) }) as Dashboard;
  assert.equal(viewFor('tests').section, 'tests');
  assert.ok(primaryEntries(as('admin')).some(entry => entry!.id === 'tests'));
  assert.ok(primaryEntries(as('reader')).some(entry => entry!.id === 'tests'));
  assert.ok(!visibleViews(as('operator-agent')).some(view => view.id === 'tests'), 'the scoped operator-agent API refuses the read');
});
