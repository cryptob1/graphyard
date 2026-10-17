import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadCases, loadContract } from '../src/e2e/case.js';
import type { E2eLauncher, E2eLocator, E2ePage } from '../src/e2e/runner.js';
import { checkoutRepositoryPolicy } from '../src/model/repository-policy.js';
import { composeLeftovers } from '../src/compose-preview.js';
import { DeliveryDefaults } from '../web/components/delivery-slices.js';
import Sidebar from '../web/components/sidebar.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// A namespace import, so a checkout whose fixture lacks the delivery loop still loads this file and fails in its case.
// @ts-expect-error The fixture is a plain ES module the uat job runs under tsx.
import * as onboardingFixture from '../scripts/onboarding-delivery-fixture.mjs';
const { candidateRoot, createOnboardingFixture, deliveredCases, fixtureCases, runOnboardingE2e } = onboardingFixture as Record<string, any>;

// GY-1906 (GOAL-1 pilot): the complete protected GOAL-1 suite — every case the release contract binds to
// GOAL-1's seven outcomes, unchanged — runs from this head on one isolated project normally onboarded
// from it, declaring a static site and a Compose application: changes previewed, delivered in batches of
// at most five, a passing candidate promoted and verified exactly in production, a candidate failing a
// combined required case kept off production, previews cleaned up, and production drift caught.

const root = candidateRoot as string;
const goalOutcomes = ['onboarding-default-path', 'change-preview', 'preview-isolation', 'declared-app-previews', 'small-exact-candidates', 'candidate-gates-promotion', 'production-verified-exact'];
// The fixture's Compose application builds from alpine:3 alone, pulled here when the host's Docker lacks it.
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0
  && (spawnSync('docker', ['image', 'inspect', 'alpine:3'], { encoding: 'utf8' }).status === 0 || spawnSync('docker', ['pull', '-q', 'alpine:3'], { encoding: 'utf8', timeout: 300_000 }).status === 0);

/** Chromium as Playwright installs it, else the host's Chrome; null when neither launches. */
async function chromiumLauncher() {
  const { chromium } = await import('@playwright/test');
  for (const options of [{}, { channel: 'chrome' }]) {
    try { await (await chromium.launch({ headless: true, ...options })).close(); return (launch: { headless: boolean }) => chromium.launch({ ...launch, ...options }); } catch { /* try the next */ }
  }
  return null;
}

/**
 * The dashboard as onboarding-delivery-defaults' browser steps meet it, rendered from the plane's live
 * /api/status by the dashboard's own components (the test job builds no dist/): sign-in with the filled
 * token, the sidebar's Delivery button, the Delivery view. As tests/onboarding-delivery-uat-fixture.test.ts drives it.
 */
function dashboardPage(): E2ePage {
  let origin = '', token = '', markup = '';
  const read = async (path: string) => { const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } }); if (response.status !== 200) throw new Error(`${path} answered ${response.status}`); return response.json() as Promise<any>; };
  const text = () => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const locator = (actions: { click?: () => Promise<void>; fill?: (value: string) => void; visible?: () => boolean }): E2eLocator => ({
    first: () => locator(actions),
    click: async () => { if (!actions.click) throw new Error('nothing to click'); await actions.click(); },
    fill: async value => { if (!actions.fill) throw new Error('nothing to fill'); actions.fill(value); },
    waitFor: async () => { if (!actions.visible?.()) throw new Error('not visible'); },
  });
  const page: E2ePage = {
    on: () => page, close: async () => {},
    goto: async url => { origin = new URL(url).origin; markup = '<label>Access token</label><button>Open control plane</button>'; },
    getByLabel: () => locator({ fill: value => { token = value; } }),
    getByRole: (_role, { name }) => locator({ click: async () => {
      if (name === 'Open control plane') markup = renderToStaticMarkup(createElement(Sidebar, { entries: [], dashboard: { view: 'work', setView: () => {}, setSelected: () => {}, connected: true, lastUpdated: 'now', status: await read('/api/status'), signOut: () => {} } as any }));
      else if (name === 'Delivery') { if (!markup.includes('aria-label="Delivery"')) throw new Error('the Delivery button is not on the page'); markup = renderToStaticMarkup(createElement(DeliveryDefaults, { status: await read('/api/status') })); }
      else throw new Error(`no ${name} button`);
    } }),
    getByText: (wanted, { exact }) => locator({ visible: () => exact ? text().split(' ').includes(wanted) : text().includes(wanted) }),
  };
  return page;
}

/** Real Chromium for every page but the fixture plane's dashboard root (`dashboard()`'s origin), which `dashboardPage` renders: a page is bound on its first navigation. */
function pilotLauncher(launch: (options: { headless: boolean }) => Promise<any>, dashboard: () => string | null): E2eLauncher {
  return { launch: async options => {
    const browser = await launch(options);
    return { close: () => browser.close(), newPage: async () => {
      let bound: E2ePage | null = null;
      const listeners: [string, (...args: any[]) => void][] = [];
      const current = () => { if (!bound) throw new Error('the page has not navigated yet'); return bound; };
      const page: E2ePage = {
        on: (event: string, listener: (...args: any[]) => void) => { if (bound) bound.on(event as never, listener as never); else listeners.push([event, listener]); return page; },
        close: async () => { await bound?.close(); },
        goto: async (url: string, ...rest: unknown[]) => {
          if (!bound) {
            const target = new URL(url);
            bound = target.pathname === '/' && target.origin === dashboard() ? dashboardPage() : await browser.newPage() as E2ePage;
            for (const [event, listener] of listeners) bound.on(event as never, listener as never);
          }
          return (bound.goto as (...args: unknown[]) => Promise<unknown>)(url, ...rest);
        },
        getByText: (...args) => current().getByText(...args), getByRole: (...args) => current().getByRole(...args), getByLabel: (...args) => current().getByLabel(...args),
      } as E2ePage;
      return page;
    } };
  } } as E2eLauncher;
}

test('integration:goal-rapid-delivery-pilot — the complete protected seven-case GOAL-1 suite passes unchanged from this head on a static and Compose project normally onboarded and delivered automatically: two multi-change batches, a failing combined candidate kept off production, previews cleaned up and production drift caught, with no worker credential granted', { timeout: 1_800_000 }, async t => {
  if (!docker) { assert.ok(!process.env.CI, 'CI runs the Compose application'); t.skip('no Docker Compose or alpine:3 image on this host'); return; }
  const launch = await chromiumLauncher();
  if (!launch) { assert.ok(!process.env.CI, 'CI opens the previews in a browser'); t.skip('no Chromium or Chrome to open the previews in'); return; }

  // The protected suite: exactly the cases the release contract binds to GOAL-1's seven outcomes, each required, run as shipped.
  const contract = await loadContract(root), policy = checkoutRepositoryPolicy(root);
  const bound = goalOutcomes.flatMap(id => contract.outcomes.find(outcome => outcome.id === id)!.cases).sort();
  const cases = (await loadCases(root)).filter(entry => bound.includes(entry.definition.id));
  assert.deepEqual(cases.map(entry => entry.definition.id).sort(), bound);
  assert.equal(bound.length, 7);
  assert.ok(cases.every(entry => entry.definition.required && entry.definition.target === 'uat' && entry.definition.steps.length > 0), 'every case is required, targets uat and keeps its steps');
  assert.deepEqual([...fixtureCases].sort(), bound, 'every GOAL-1 case runs on the normally onboarded fixture');
  assert.deepEqual([...deliveredCases ?? []].sort(), ['candidate-batches-five', 'candidate-gates-promotion', 'production-exact-verification']);

  let made: any = null, snapshot: any = null;
  const launcher = pilotLauncher(launch, () => made && new URL(made.url).origin);
  const fixture = async () => {
    made = await createOnboardingFixture({ root, launcher, allocate: () => temporaryDirectory('goal-rapid-delivery-pilot') });
    const close = made.close;
    // What the run left on the plane and the fixture, read before the fixture is removed.
    made.close = async () => {
      const read = async (path: string) => (await fetch(`${made.url}/api/${path}`, { headers: { Authorization: `Bearer ${made.token}` } })).json() as Promise<any>;
      snapshot = { delivered: [...made.releases.delivered], released: [...made.releases.released], identity: made.production.identity, candidates: (await read('candidates')).candidates,
        delivery: await read('delivery'), principals: await read('principals'), merger: await read('merger'), status: await read('status'), notes: [...made.loop.notes], scratch: made.scratch };
      await close();
    };
    return made;
  };
  const report = await runOnboardingE2e(cases, { url: 'http://127.0.0.1:9', token: 'unused: every GOAL-1 case runs on the fixture', fixture, root, contract, policy, launcher });

  // Every protected case passed on the fixture, in one report bound to this head.
  assert.deepEqual(Object.fromEntries(report.cases.map((outcome: any) => [outcome.id, outcome.verdict])), Object.fromEntries(bound.map(id => [id, 'passed'])),
    JSON.stringify(report.cases.filter((outcome: any) => outcome.verdict !== 'passed').map((outcome: any) => [outcome.id, outcome.failingStep]), null, 1));
  assert.equal(report.targets.length, 1, 'one fixture served every case');
  assert.equal(report.sha, made.sha, 'the run is bound to this head');

  // Normal onboarding: local previews, candidates of at most five, required production verification, the control plane merging.
  assert.deepEqual([snapshot.status.project.delivery.previews, snapshot.status.project.delivery.candidateMaxChanges, snapshot.status.project.delivery.productionVerification, snapshot.merger.mode], ['local', 5, true, 'control-plane']);
  assert.deepEqual(snapshot.status.project.delivery.applications.map((application: any) => application.kind).sort(), ['compose', 'static']);

  // Multi-change batches: five changes in one candidate, the sixth alone in the next; each promoted on its pass.
  const releases = snapshot.released as { candidate: string; release: string; result: string; promoted: boolean }[];
  const byId = (id: string) => snapshot.candidates.find((candidate: any) => candidate.id === id);
  assert.ok(releases.some(entry => byId(entry.candidate)?.members.length === 5 && entry.result === 'passed' && entry.promoted), JSON.stringify(releases));
  assert.ok(snapshot.candidates.every((candidate: any) => candidate.members.length <= 5));
  // Failed combined validation: the breaking change passed its own preview, failed the static home in its candidate, was never promoted and left main.
  const failed = releases.filter(entry => entry.result === 'failed');
  assert.equal(failed.length, 1, JSON.stringify(releases));
  assert.equal(failed[0].promoted, false);
  assert.ok(byId(failed[0].candidate).validation.failed.includes('fixture-static-home'));
  assert.equal(byId(failed[0].candidate).promotion, null);
  // Production: the last promoted candidate expected, observed by the plane from production's own identity, which drifted.
  const production = snapshot.delivery.environments.find((environment: any) => environment.id === 'production');
  const last = releases.filter(entry => entry.promoted).at(-1)!;
  assert.equal(production.expected.releaseId, last.release);
  assert.equal(production.verification.status, 'mismatched', 'the redeployed build is drift');
  assert.match(production.verification.reasons.join(' '), /Production runs artifact sha256:[0-9a-f]{64}, not tree:[0-9a-f]{40}/);
  assert.equal(snapshot.identity.release, last.release);
  // Cleanup: every preview recorded cleaned or still owned by the loop until close; nothing of the fixture is left.
  assert.ok(snapshot.notes.some((note: string) => /Ended .*'s preview of .* \(delivered\)/.test(note)), 'a delivered change\'s preview was ended');
  assert.equal(existsSync(snapshot.scratch), false, 'the fixture removed its scratch directory');
  await assert.rejects(fetch(`${made.url}/healthz`), 'the fixture plane is stopped');
  const leftovers = spawnSync('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project', '--format', '{{.Label "com.docker.compose.project"}}'], { encoding: 'utf8' }).stdout.split('\n').filter(name => /^graphyard-preview-(rc-|gy-)/.test(name));
  for (const project of new Set(leftovers)) { const left = await composeLeftovers(project); assert.equal(left.containers.length + left.volumes.length + left.networks.length, 0, `${project} was removed`); }
  // No worker credential: the fixture's plane knows its operator and the loop's coordinator, and grants nothing else.
  assert.deepEqual((snapshot.principals.principals ?? snapshot.principals).map((principal: any) => principal.role).sort(), ['admin', 'coordinator']);
});
