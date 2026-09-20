// The dashboard audit fixture: ten work items that cover every place an item can be (not
// started, waiting for a worker after a lapsed claim, never claimed, being built, in review,
// proving, stuck on a blocker, and three shipped), with the flow and attribution reports
// computed by the real aggregations from ledger events for the same items. Importing it gives
// the fixture to tests (tests/dashboard-simplification.test.ts); running it reproduces the
// audit views as screenshots and prints the visible word count of each:
//
//   npm run build && npx tsx scripts/dashboard-fixture.mjs [OUT_DIR]
//
// It serves dist/ with this fixture as the API on a local port and drives headless Chromium
// through @playwright/test. Nothing leaves the machine and no real data is read.
import { computeFlow, deriveFacts, flowDrilldown } from '../src/flow-analytics.ts';
import { computeAttribution } from '../src/attribution.ts';

export const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const at = offset => new Date(NOW + offset).toISOString();
const sha = seed => seed.repeat(40).slice(0, 40);
const base = sha('b');

const blocked = (reason, n = 1) => ({ ready: [], build: ['Worker has not submitted implementation for this attempt', 'Pull request has not been independently observed', 'No workspace registered'], review: ['Independent approval of the current commit is required'], test: ['Required CI check test has not passed on the current candidate', 'Required CI check typecheck has not passed on the current candidate'], merge: ['GitHub observation missing or older than two minutes', 'Required Graphyard check and merge-queue branch protection have not been verified', 'Pull request is not mergeable against the current base'], ...reason, _n: n });
const proofReason = (ac, proof) => `${ac}: ${proof} needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy`;
function gates(reasons, criteria) {
  const acceptance = reasons.acceptance ?? criteria.flatMap(c => c.proofs.map(p => proofReason(c.id, p)));
  return ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => {
    const list = name === 'acceptance' ? acceptance : reasons[name] ?? [];
    return { name, passed: list.length === 0, reasons: list };
  });
}
function observation(pr, headSha, when, { reviews = [], merged = false, opened = when - 2 * hour } = {}) {
  return { candidate: { sha: headSha, baseSha: base, pr, branch: `graphyard/pr-${pr}`, author: 'worker', createdAt: at(opened) },
    checks: [{ name: 'test', result: 'success', appId: 1 }, { name: 'typecheck', result: 'success', appId: 1 }], reviews, protected: true, mergeable: true,
    merged, mergeSha: merged ? sha(String(pr % 10)) : null, mergedAt: merged ? at(when) : null, files: ['src/app.ts'], scopeFiles: [], at: at(Math.min(when, -minute)) };
}
function item(n, title, fields) {
  const criteria = fields.criteria ?? [{ id: 'AC-1', text: 'The change works for a signed-in customer.', proofs: [`integration:gy-${n}`] }];
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, key: `GY-${n}`, title, description: fields.description ?? `${title}.`, type: 'feature', priority: 2,
    dependencies: [], criteria, policy: { checks: ['test', 'typecheck'], review: true, reviewProvider: 'github' }, plannedFiles: ['src/'], scenarioRequirements: [],
    stage: 'ready', revision: 1, policyRevision: 1, createdAt: at(-10 * day), updatedAt: at(-hour), stageEnteredAt: at(-day), ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, evidence: [], observation: null, blocker: null, violations: [],
    ...fields, criteria, gates: gates(fields.reasons ?? blocked({}), criteria), reasons: undefined,
  };
}
const passedEvidence = (proof, headSha, when) => ({ id: `evidence-${proof}`, proof, sha: headSha, baseSha: base, policyRevision: 1, producer: 'ci', trusted: true, result: 'pass', executed: 8, skipped: 0, at: at(when) });
const assigned = (owner, displayName, epoch, expires) => ({ lease: { owner, epoch, expiresAt: at(expires) }, lastAssignment: { owner, epoch, displayName, runtime: 'Claude', claimedAt: at(expires - 3 * hour) }, epoch });
const workspace = (owner, epoch, n) => [{ host: 'build-1', path: `/work/gy-${n}-${epoch}`, branch: `graphyard/gy-${n}-${epoch}`, epoch, owner }];

function shipped(n, title, pr, when) {
  const headSha = sha(String.fromCharCode(96 + (n % 26)));
  const opened = when - 20 * hour;
  return item(n, title, { stage: 'done', stageEnteredAt: at(when), epoch: 1, submission: { epoch: 1, pr }, candidate: observation(pr, headSha, when, { opened }).candidate,
    observation: observation(pr, headSha, when, { opened, merged: true, reviews: [{ reviewer: 'reviewer', sha: headSha, state: 'APPROVED', id: 900 + n, submittedAt: at(when - 5 * hour) }] }),
    delivery: { mergedAt: at(when), mergeSha: sha(String(pr % 10)), authorizationRevision: 1 }, mergeAuthorization: { sha: headSha, baseSha: base, policyRevision: 1, at: at(when - hour) },
    evidence: [passedEvidence(`integration:gy-${n}`, headSha, when - 3 * hour)], lastAssignment: { owner: 'worker-2', epoch: 1, displayName: 'Sam', runtime: 'Codex' }, workspaces: workspace('worker-2', 1, n),
    reasons: { ready: [], build: [], review: [], test: [], merge: [], acceptance: [] } });
}

/** The fixture work items, in the shape `GET /api/work-snapshot` returns. */
export function fixtureWork() {
  const review = sha('d'), proving = sha('e');
  const provingCriteria = [
    { id: 'AC-1', text: 'More than ten failed logins from one address in a minute are refused.', proofs: ['integration:login-rate-limit'] },
    { id: 'AC-2', text: 'A refused login says when to try again.', proofs: ['unit:retry-after-copy'] },
    { id: 'AC-3', text: 'Normal sign-ins are not slowed down.', proofs: ['integration:login-latency'] },
  ];
  return [
    item(11, 'Let customers reset their password', { ready: false, stage: 'backlog', reasons: blocked({ ready: ['Not released from backlog'] }) }),
    item(12, 'Send booking reminders by SMS', { stage: 'build', stageEnteredAt: at(-2 * day), ...assigned('worker-7', 'Robin', 1, -3 * hour), workspaces: workspace('worker-7', 1, 12) }),
    item(13, 'Show invoice totals on the account page', { stageEnteredAt: at(-5 * hour) }),
    item(14, 'Export monthly reports as CSV', { stage: 'build', stageEnteredAt: at(-4 * hour), ...assigned('worker-3', 'Alex', 1, 90_000), workspaces: workspace('worker-3', 1, 14) }),
    item(15, 'Add dark mode to settings', { stage: 'review', stageEnteredAt: at(-6 * hour), epoch: 1, submission: { epoch: 1, pr: 42 }, candidate: observation(42, review, -6 * hour).candidate, observation: observation(42, review, -minute),
      lastAssignment: { owner: 'worker-3', epoch: 1, displayName: 'Alex', runtime: 'Claude' }, workspaces: workspace('worker-3', 1, 15),
      reasons: blocked({ build: [], test: [], merge: [] }) }),
    item(16, 'Rate-limit the login endpoint', { stage: 'acceptance', stageEnteredAt: at(-9 * hour), epoch: 1, submission: { epoch: 1, pr: 43 }, candidate: observation(43, proving, -9 * hour).candidate,
      observation: observation(43, proving, -minute, { reviews: [{ reviewer: 'reviewer', sha: proving, state: 'APPROVED', id: 816, submittedAt: at(-8 * hour) }] }),
      criteria: provingCriteria, evidence: [passedEvidence('integration:login-rate-limit', proving, -7 * hour), passedEvidence('unit:retry-after-copy', proving, -7 * hour)],
      lastAssignment: { owner: 'worker-2', epoch: 1, displayName: 'Sam', runtime: 'Codex' }, workspaces: workspace('worker-2', 1, 16),
      reasons: blocked({ build: [], review: [], test: [], merge: [], acceptance: [proofReason('AC-3', 'integration:login-latency')] }) }),
    item(17, 'Move sessions to Postgres', { blocker: 'needs a second Postgres instance', stageEnteredAt: at(-26 * hour), reasons: blocked({ ready: ['needs a second Postgres instance'] }) }),
    shipped(18, 'Fix the timezone in the weekly digest', 40, -2 * day),
    shipped(19, 'Speed up search results', 41, -4 * day),
    shipped(9, 'Add an audit log export', 31, -20 * day),
  ];
}

/**
 * A repository whose window holds `count` delivered items, each with one measured episode. The
 * phase drill-down returns one row per phase per episode, so this is how the bound at
 * `flowLimits.drilldown` is reached: the combined request is cut off past roughly a sixth of it.
 */
export function busyFixtureWork(count) {
  return Array.from({ length: count }, (_, index) => shipped(100 + index, `Delivered item ${index + 1}`, 500 + index, -(index + 1) * hour));
}

export const fixtureStatus = (role = 'admin') => ({ actor: { id: role === 'admin' ? 'operator' : `fixture-${role}`, role, sessionKind: role === 'admin' ? 'human' : 'ai' }, github: true, reviewProviders: ['github'],
  repository: 'fixture/shop', baseBranch: 'main', jobs: [], delegation: { limits: { maxLeads: 3, maxEngineersPerLead: 2, minReviewers: 1, maxReviewers: 2 },
    slices: [{ id: 'product', name: 'Product', lead: null, workers: [], bottlenecks: [] }, { id: 'infrastructure', name: 'Infrastructure', lead: null, workers: [], bottlenecks: [] }, { id: 'docs-experience', name: 'Docs/experience', lead: null, workers: [], bottlenecks: [] }], reviewers: [] } });

/** Ledger events for the fixture, so the flow report is the real aggregation's output. */
function ledger(work) {
  const events = []; let seq = 0;
  const push = (snapshot, when, kind) => events.push({ seq: ++seq, work_id: snapshot.id, actor: 'fixture', kind, payload: { work: snapshot }, created_at: at(when) });
  for (const final of work) {
    const created = Date.parse(final.createdAt) - NOW;
    const initial = { ...final, ready: false, stage: 'backlog', stageEnteredAt: final.createdAt, lease: null, submission: null, candidate: null, observation: null, evidence: [], blocker: null, delivery: undefined, mergeAuthorization: undefined, gates: gates(blocked({ ready: ['Not released from backlog'] }), final.criteria) };
    push(initial, created, 'create');
    if (final.stage !== 'done') { push(final, Date.parse(final.stageEnteredAt) - NOW, final.lease ? 'claim' : final.candidate ? 'github.observed' : 'ready'); continue; }
    const merged = Date.parse(final.stageEnteredAt) - NOW, opened = merged - 20 * hour;
    const open = { ...final, stage: 'review', delivery: undefined, mergeAuthorization: undefined, evidence: [], observation: { ...final.observation, merged: false, mergeSha: null, mergedAt: null, reviews: [] }, gates: gates(blocked({ build: [], test: [], merge: [] }), final.criteria) };
    push({ ...open, stage: 'build', candidate: null, observation: null, lease: { owner: 'worker-2', epoch: 1, expiresAt: at(opened) } }, opened - 6 * hour, 'claim');
    push({ ...open, candidate: null, observation: null }, opened, 'submit');
    push({ ...open, stageEnteredAt: at(opened + hour) }, opened + hour, 'github.observed');
    push({ ...open, stage: 'acceptance', observation: { ...open.observation, reviews: final.observation.reviews }, gates: gates(blocked({ build: [], review: [], test: [], merge: [] }), final.criteria) }, merged - 5 * hour, 'github.observed');
    push({ ...open, stage: 'merge', evidence: final.evidence, observation: { ...open.observation, reviews: final.observation.reviews }, gates: gates({ merge: ['Merge queue position 1 of 1: GY-0 is ahead'], acceptance: [] }, final.criteria) }, merged - 3 * hour, 'evidence');
    push({ ...final, observation: { ...final.observation, merged: false, mergeSha: null, mergedAt: null }, stage: 'merge', delivery: undefined }, merged - hour, 'merge.authorize');
    push(final, merged, 'github.observed');
  }
  return events;
}
function flowDataset(work) {
  const states = new Map(), facts = [];
  for (const event of ledger(work)) { const state = states.get(event.work_id) ?? {}; states.set(event.work_id, state); facts.push(...deriveFacts(event, state)); }
  const latest = [];
  for (const fact of [...facts].reverse()) if (!latest.some(entry => entry.workId === fact.workId && entry.kind === fact.kind)) latest.push(fact);
  return { observedAt: at(0), from: at(-30 * day), to: at(0), days: 30, work, included: work, facts, latest, carryIn: [], deployments: [], mergedForDeployments: [],
    scanned: facts.length, truncated: false, workTruncated: false, deploymentsTruncated: false, deploymentMergesTruncated: false,
    projection: { lastEvent: facts.length, updatedAt: at(0), pendingEvents: 0, pendingCapped: false } };
}

/**
 * The flow-analytics API over an arbitrary work list, answered by the real aggregation and the
 * real bounded drill-down, so a test sees exactly the payload — cut-off rows included — that the
 * control plane would return for the same repository.
 */
export function flowApi(work, role = 'admin') {
  const dataset = flowDataset(work);
  const report = computeFlow(dataset, { days: 30 });
  return path => {
    const url = new URL(path.replace(/^\/?(api\/)?/, 'http://fixture/api/'));
    if (!url.pathname.endsWith('/drilldown')) return report;
    return flowDrilldown(dataset, report, { metric: url.searchParams.get('metric'), key: url.searchParams.get('key'), authorized: role !== 'reader' });
  };
}

/** The fixture API: the JSON body the control plane would return for `path` (with its query). */
export function fixtureApi(path, role = 'admin') {
  const url = new URL(path.replace(/^\/?(api\/)?/, 'http://fixture/api/'));
  const route = url.pathname.slice('/api/'.length);
  const work = fixtureWork();
  if (route === 'status') return fixtureStatus(role);
  if (route === 'work-snapshot') return { work, jobs: [], now: at(0) };
  if (route === 'work') return work;
  if (route === 'events') return [{ seq: 3, kind: 'work.claimed', actor: 'worker-3', created_at: at(-4 * hour) }, { seq: 2, kind: 'work.ready', actor: 'operator', created_at: at(-day) }, { seq: 1, kind: 'work.created', actor: 'operator', created_at: at(-10 * day) }];
  if (route.startsWith('analytics/flow')) return flowApi(work, role)(path);
  if (route.startsWith('analytics/attribution')) {
    const empty = { observedAt: at(0), from: at(-30 * day), to: at(0), days: 30, records: [], recordsTruncated: false, requests: [], requestsTruncated: false, environments: {}, blockedNow: [] };
    return route.endsWith('/drilldown') ? { rows: [], columns: [], total: 0, truncated: false } : computeAttribution(empty);
  }
  if (route === 'shipping-pulse') {
    const done = work.filter(w => w.stage === 'done');
    const week = index => ({ start: at((index - 12) * 7 * day), end: at((index - 11) * 7 * day), count: done.filter(w => { const t = Date.parse(w.delivery.mergedAt) - NOW; return t >= (index - 12) * 7 * day && t < (index - 11) * 7 * day; }).length });
    return { generatedAt: at(0), range: { start: at(-84 * day), end: at(0), weeks: 12, semantics: 'repository-utc-inclusive' }, completeness: 'complete', truncated: false,
      counts: { days7: done.filter(w => Date.parse(w.delivery.mergedAt) > NOW - 7 * day).length, days30: done.length }, intentToMerge: { medianHours: 240, sampleSize: done.length, excluded: 0 },
      prToProduction: { averageHours: null, medianHours: null, p90Hours: null, sampleSize: 0, eligible: done.length, excluded: done.length, coveragePercent: 0, sparse: true, exclusions: { 'no-verifiable-production-deployment': done.length }, split: { prToMergeAverageHours: 20, mergeToProductionAverageHours: null } },
      weeks: Array.from({ length: 12 }, (_, index) => week(index + 1)),
      recent: done.map(w => ({ key: w.key, title: w.title, pullRequest: w.candidate.pr, mergeSha: w.delivery.mergeSha, mergedAt: w.delivery.mergedAt, quality: { passingProofs: 1, requiredProofs: 1, violations: [] } })) };
  }
  if (route === 'delivery') return { environments: [], releases: [], rollbacks: [], now: at(0) };
  if (route.startsWith('validation')) return { requests: [], candidates: [], nextCursor: null };
  if (route === 'proof-grants') return { authorities: [{ principalId: 'ci', role: 'producer', patterns: ['integration:*', 'unit:*'], source: 'grant' }], grants: [] };
  if (route === 'operator-agents') return [];
  return [];
}

/**
 * The words a person sees in rendered markup, each with whether it carries a hover definition:
 * text outside `hidden` elements and outside the body of a closed <details> (its <summary>
 * counts), not counting elements marked `data-title` (item titles, which are the operator's own
 * words). Attributes, tooltips included, never count as words. A word is `explained` when it sits
 * inside a <Term>, the shared glossary's `<abbr class="term" title="…">`; another element's title
 * (a card's "In this step for 3h", say) is not a definition and never counts as one.
 */
export function readableWords(html) {
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = []; const words = [];
  const skipping = () => stack.some(entry => entry.skip);
  const explained = () => stack.some(entry => entry.term);
  for (const token of html.replace(/<!--[\s\S]*?-->/g, '').split(/(<[^>]+>)/)) {
    if (!token) continue;
    const tag = /^<\/?([a-zA-Z0-9-]+)([^>]*)>$/.exec(token);
    if (!tag) {
      if (!skipping()) for (const word of token.replace(/&[a-z#0-9]+;/gi, ' ').split(/\s+/)) if (/[\p{L}\p{N}]/u.test(word)) words.push({ word, explained: explained() });
      continue;
    }
    const name = tag[1].toLowerCase(), attributes = tag[2];
    if (token.startsWith('</')) {
      const index = stack.map(entry => entry.name).lastIndexOf(name);
      if (index >= 0) stack.splice(index);
      if (name === 'summary') { const details = stack.findLast(entry => entry.name === 'details'); if (details && !details.open) details.skip = true; }
      continue;
    }
    if (voids.has(name) || token.endsWith('/>')) continue;
    const hidden = /\shidden(\s|=|$)/.test(attributes) || /\sdata-title(\s|=|$)/.test(attributes) || /aria-hidden="true"/.test(attributes);
    // A closed <details> shows only its <summary>: the rest is skipped once the summary closes.
    stack.push({ name, skip: hidden, open: name === 'details' && /\sopen(\s|=|$)/.test(attributes), term: name === 'abbr' && /class="term"/.test(attributes) && /\stitle="/.test(attributes) });
  }
  return words;
}

/** The words a person sees, in order. */
export const visibleWords = html => readableWords(html).map(entry => entry.word);
/** The visible words that carry no glossary definition: what a newcomer cannot look up in place. */
export const unexplainedWords = html => readableWords(html).filter(entry => !entry.explained).map(entry => entry.word);

async function main() {
  const [{ createServer }, { readFile }, { extname, join, resolve }, { mkdir }, { chromium }] = await Promise.all([import('node:http'), import('node:fs/promises'), import('node:path'), import('node:fs/promises'), import('@playwright/test')]);
  const out = resolve(process.argv[2] ?? '.graphyard/screenshots/dashboard-fixture');
  const dist = resolve('dist');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/api/')) { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify(fixtureApi(request.url))); }
    const file = join(dist, request.url.split('?')[0]);
    try { const body = await readFile(extname(file) ? file : join(dist, 'index.html')); response.setHeader('content-type', types[extname(file)] ?? 'text/html'); response.end(body); }
    catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.clock.setFixedTime(new Date(NOW));
  page.on('pageerror', error => console.error(`page error: ${error.message}`));
  const shot = async (name, scope = 'body') => {
    await page.waitForTimeout(300);
    const text = await page.locator(scope).first().evaluate(root => { const clone = root.cloneNode(true); clone.querySelectorAll('[data-title]').forEach(e => e.remove()); document.body.append(clone); clone.style.cssText = 'position:absolute;left:-99999px;top:0;width:1440px'; const value = clone.innerText; clone.remove(); return value; });
    const count = text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    console.log(`${name.padEnd(20)} ${String(count).padStart(5)} visible words (excluding item titles) -> ${join(out, `${name}.png`)}`);
  };
  await page.goto(origin);
  await page.getByLabel('Access token').fill('fixture');
  await page.getByRole('button', { name: 'Open control plane' }).click();
  await page.getByRole('heading', { name: 'Work', level: 1 }).waitFor();
  await shot('01-home');
  await page.getByRole('button', { name: /Rate-limit the login endpoint/ }).click();
  await shot('02-item-view', '[role=dialog]');
  await page.getByText('More details', { exact: true }).click();
  await shot('03-item-view-details', '[role=dialog]');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Shipped/ }).first().click();
  await shot('04-shipped');
  await page.getByRole('button', { name: /Insights/ }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Flow analytics' }).click();
  await page.getByRole('heading', { name: 'Where work is waiting' }).waitFor();
  await shot('05-flow-analytics');
  await page.getByText('Show details', { exact: true }).click();
  await shot('06-flow-analytics-details');
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.waitForLoadState('networkidle');
  await shot('07-settings');
  await page.getByRole('button', { name: 'How Graphyard works' }).click();
  await shot('08-how-graphyard-works');
  await page.getByRole('button', { name: /Work/ }).first().click();
  await page.getByRole('button', { name: '＋ New work item' }).click();
  await shot('09-create-form', '[role=dialog]');
  await browser.close(); server.close();
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
