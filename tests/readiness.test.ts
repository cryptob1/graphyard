import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { completionProfiles, frameworkReportFormats, readinessChecklist, summarizeDefinitions } from '../src/readiness.js';
import { reportFormats } from '../src/report-adapters.js';
import { buildProposal } from '../src/onboarding.js';
import { mainGuardReadiness } from '../src/main-guard.js';

const example = JSON.parse(await readFile('examples/setup-proposal.json', 'utf8'));
const connected = { url: 'https://graphyard.example.test', reachable: true, role: 'admin', github: true, githubPermissions: { pull_requests: 'write', checks: 'write', contents: 'write', issues: 'write' },
  mainGuard: mainGuardReadiness({ github: true, required: ['test', 'typecheck'], revertApprover: 5678 }) };
const applied = { proposal: '.graphyard/setup-proposal.json', appliedAt: '2026-09-18T10:00:00.000Z', githubApp: { appId: 1, slug: 'graphyard-orders' }, drift: [], unreadable: [] };
const runnerPath = { environments: 1, runners: 1, collectors: 1, builders: 1, bundles: 1 };

test('a fully configured through-merge repository is ready, and every missing item names its recovery', () => {
  const ready = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: example });
  assert.equal(ready.ready, true); assert.deepEqual(ready.summary, { ready: ready.items.length, missing: 0, unknown: 0 });
  assert.ok(ready.items.every(i => i.status === 'ready' && i.recovery === null));
  assert.match(ready.next, /submit a real PR/);
  // Nothing supplied: nothing is ready, and each item says what to do. Unknown is never ready.
  const bare = readinessChecklist('through-merge', {});
  assert.equal(bare.ready, false); assert.equal(bare.summary.ready, 0);
  assert.ok(bare.items.every(i => i.status !== 'ready' && typeof i.recovery === 'string' && i.recovery.length > 20));
  const unreachable = readinessChecklist('through-merge', { repository: null, server: { url: 'http://127.0.0.1:4310', reachable: false, failure: 'fetch failed' }, setup: { proposal: null, appliedAt: null, githubApp: null, drift: [], unreadable: [] }, proposal: null });
  const byId = Object.fromEntries(unreachable.items.map(i => [i.id, i]));
  assert.equal(byId.repository.status, 'missing'); assert.match(byId.repository.recovery!, /git remote add origin/);
  assert.equal(byId.server.status, 'missing'); assert.match(byId.server.recovery!, /GRAPHYARD_URL and GRAPHYARD_TOKEN/); assert.match(byId.server.detail, /fetch failed/);
  assert.equal(byId['setup-proposal'].status, 'missing'); assert.match(byId['setup-proposal'].recovery!, /init --scan/);
  assert.equal(byId['github-app'].status, 'missing'); assert.match(byId['github-app'].recovery!, /github-setup/);
  assert.equal(byId['github-permissions'].status, 'unknown');
  assert.equal(unreachable.next, byId.repository.recovery);
});

test('missing credentials and permissions are reported with direct recovery', () => {
  const worker = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, role: 'worker' }, setup: applied, proposal: example });
  const role = worker.items.find(i => i.id === 'credential-role')!;
  assert.equal(role.status, 'missing'); assert.match(role.recovery!, /operator \(admin\) credential/);
  const limited = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, githubPermissions: { pull_requests: 'write', checks: 'read', issues: 'read' } }, setup: applied, proposal: example });
  const permissions = limited.items.find(i => i.id === 'github-permissions')!;
  assert.equal(permissions.status, 'missing'); assert.match(permissions.detail, /checks, contents/); assert.match(permissions.recovery!, /Grant checks, contents to the App/);
  // A verified App-permission preflight outranks the raw scope map and names the migration.
  const preflight = { verifiedAt: '2030-01-01T00:00:00Z', missing: [{ permission: 'contents', required: 'write', granted: 'read' }], attention: ['contents: write is required for the merge queue'] };
  const migrate = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, appPermissions: preflight }, setup: applied, proposal: example });
  const owed = migrate.items.find(i => i.id === 'github-permissions')!;
  assert.equal(owed.status, 'missing'); assert.match(owed.detail, /contents needs write \(granted read\)/); assert.match(owed.recovery!, /github-setup --update-permissions/); assert.equal(migrate.next, owed.recovery);
  const verified = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, githubPermissions: {}, appPermissions: { ...preflight, missing: [], attention: [] } }, setup: applied, proposal: example });
  assert.equal(verified.items.find(i => i.id === 'github-permissions')!.status, 'ready');
  const unverified = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, appPermissions: { ...preflight, verifiedAt: null } }, setup: applied, proposal: example });
  assert.equal(unverified.items.find(i => i.id === 'github-permissions')!.status, 'ready');
  const registered = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, github: false }, setup: applied, proposal: example });
  const app = registered.items.find(i => i.id === 'github-app')!;
  assert.equal(app.status, 'missing'); assert.match(app.detail, /registered locally but the server does not report it/); assert.match(app.recovery!, /GITHUB_APP_ID, GITHUB_INSTALLATION_ID/);
  const drifted = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: connected, setup: { ...applied, drift: ['stack changed'] }, proposal: example });
  assert.match(drifted.items.find(i => i.id === 'setup-proposal')!.recovery!, /Rerun `graphyard init --scan`/);
  const unreadable = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: connected, setup: { ...applied, unreadable: ['.graphyard/setup-proposal.json invalid'] }, proposal: example });
  assert.equal(unreadable.items.find(i => i.id === 'setup-proposal')!.status, 'missing');
});

test('unsupported test formats are named with a recovery, and every supported framework maps to a shipped adapter', () => {
  for (const mapping of Object.values(frameworkReportFormats)) assert.ok(reportFormats.includes(mapping.format));
  const cypress = readinessChecklist('through-merge', { repository: 'owner/app', server: connected, setup: applied, proposal: { ...example, stack: { ...example.stack, frameworks: ['cypress', 'vitest'] } } });
  const formats = cypress.items.find(i => i.id === 'test-formats')!;
  assert.equal(formats.status, 'missing'); assert.match(formats.detail, /cypress → unsupported/); assert.match(formats.detail, /vitest → junit-xml-v1/);
  assert.match(formats.recovery!, /cypress: no adapter/); assert.match(formats.recovery!, /graphyard runner adapters/);
  const none = readinessChecklist('through-merge', { repository: 'owner/app', server: connected, setup: applied, proposal: { ...example, stack: { ...example.stack, frameworks: [] } } });
  assert.equal(none.items.find(i => i.id === 'test-formats')!.status, 'missing'); assert.match(none.items.find(i => i.id === 'test-formats')!.recovery!, /never invents coverage/);
  // A scanned repository declaring Playwright and pytest is fully supported.
  const scanned = buildProposal({ files: ['package.json', 'tests/app.spec.ts', '.github/workflows/ci.yml'], contents: { 'package.json': JSON.stringify({ scripts: { test: 'playwright test' }, devDependencies: { '@playwright/test': '1.63.0', vitest: '3.0.0' } }), '.github/workflows/ci.yml': 'on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n' } }, { repository: 'owner/app' });
  const supported = readinessChecklist('preview-validation', { repository: 'owner/app', server: connected, setup: applied, proposal: scanned, validation: runnerPath });
  assert.equal(supported.items.find(i => i.id === 'test-formats')!.status, 'ready');
  assert.equal(supported.items.find(i => i.id === 'e2e-suite')!.status, 'ready');
});

test('preview validation adds the runner path, and production verification stays honest about D3', () => {
  const merge = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: example });
  assert.ok(!merge.items.some(i => ['runner-registration', 'approved-bundle', 'e2e-suite'].includes(i.id)));
  const preview = readinessChecklist('preview-validation', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: example });
  const ids = preview.items.map(i => i.id);
  for (const id of ['e2e-suite', 'validation-environment', 'runner-registration', 'collector-registration', 'builder-registration', 'approved-bundle', 'deploy-target']) assert.ok(ids.includes(id), id);
  assert.equal(preview.items.find(i => i.id === 'e2e-suite')!.status, 'missing', 'the example declares vitest only');
  assert.ok(preview.items.filter(i => i.id.endsWith('-registration')).every(i => i.status === 'unknown' && /validation definitions/.test(i.recovery!)));
  const registered = readinessChecklist('preview-validation', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: { ...example, stack: { ...example.stack, frameworks: ['@playwright/test'] } }, validation: { ...runnerPath, bundles: 0 } });
  assert.equal(registered.ready, false);
  const bundle = registered.items.find(i => i.id === 'approved-bundle')!;
  assert.equal(bundle.status, 'missing'); assert.match(bundle.recovery!, /bundle-digest/); assert.match(bundle.recovery!, /reportFormat/);
  assert.equal(readinessChecklist('preview-validation', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: { ...example, stack: { ...example.stack, frameworks: ['@playwright/test'] } }, validation: runnerPath }).ready, true);
  const production = readinessChecklist('production-verification', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: { ...example, stack: { ...example.stack, frameworks: ['@playwright/test'] } }, validation: runnerPath });
  assert.equal(production.ready, false);
  const observation = production.items.find(i => i.id === 'production-observation')!;
  assert.equal(observation.status, 'missing'); assert.match(observation.detail, /not shipped/); assert.match(observation.recovery!, /manual proof/);
  assert.throws(() => readinessChecklist('done' as any, {}), /Unknown completion profile/);
  assert.deepEqual([...completionProfiles], ['through-merge', 'preview-validation', 'production-verification']);
});

test('definition summaries count only the current, enabled revision of each definition', () => {
  const counts = summarizeDefinitions([
    { kind: 'environment', id: 'preview', revision: 1 }, { kind: 'environment', id: 'preview', revision: 2 },
    { kind: 'registration', id: 'runner-1', revision: 1, role: 'runner', enabled: true }, { kind: 'registration', id: 'runner-1', revision: 2, role: 'runner', enabled: false },
    { kind: 'registration', id: 'collector-1', revision: 1, role: 'collector', enabled: true }, { kind: 'registration', id: 'builder-1', revision: 1, role: 'builder', enabled: true },
    { kind: 'bundle', id: 'bundle-1', revision: 1 },
  ]);
  assert.deepEqual(counts, { environments: 1, runners: 0, collectors: 1, builders: 1, bundles: 1 });
});

test('unit:doctor.revert-approver-missing-names-variables — with GitHub delivery and required checks armed and no revert approver App, doctor reports the approver missing, naming its three variables and main\'s last-push-approval rule, and clears it once one is configured', () => {
  // GY-1335: on 2026-10-05 five guard reverts were refused by main's last-push-approval rule because
  // the revert approver was never configured; nothing said so until main had gone red five times.
  const unconfigured = mainGuardReadiness({ github: true, required: ['test', 'typecheck'], revertApprover: null });
  assert.equal(unconfigured.armed, true);
  const doctor = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, mainGuard: unconfigured }, setup: applied, proposal: example });
  const item = doctor.items.find(entry => entry.id === 'revert-approver')!;
  assert.equal(item.status, 'missing');
  for (const variable of ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY']) assert.ok(item.recovery!.includes(variable), `the recovery names ${variable}: ${item.recovery}`);
  assert.match(item.recovery!, /last-push-approval rule \(require_last_push_approval\)/);
  assert.match(item.recovery!, /stay red until an unrelated merge re-runs CI/);
  assert.match(item.detail, /armed on test, typecheck with no revert approver App/);
  assert.equal(doctor.ready, false);
  assert.equal(doctor.next, item.recovery, 'the missing approver is doctor\'s next action');

  // Configured: the item is ready and nothing is owed.
  const configured = readinessChecklist('through-merge', { repository: 'owner/orders-api', server: connected, setup: applied, proposal: example });
  assert.deepEqual(configured.items.find(entry => entry.id === 'revert-approver'), { id: 'revert-approver', title: 'Main guard revert approver configured', status: 'ready', detail: 'revert approver App 5678 approves the guard\'s reverts', recovery: null, profiles: ['through-merge', 'preview-validation', 'production-verification'] });
  assert.equal(configured.ready, true);
  // Not armed — no GitHub delivery, or no required check to judge main by — owes nothing either.
  for (const facts of [{ github: false, required: ['test'], revertApprover: null }, { github: true, required: [], revertApprover: null }]) {
    const idle = mainGuardReadiness(facts);
    assert.equal(idle.armed, false); assert.equal(idle.attention, null);
    assert.equal(readinessChecklist('through-merge', { repository: 'owner/orders-api', server: { ...connected, mainGuard: idle }, setup: applied, proposal: example }).items.find(entry => entry.id === 'revert-approver')!.status, 'ready');
  }
  // A server that does not report the guard is unknown, never ready.
  const { mainGuard: _omitted, ...older } = connected;
  assert.equal(readinessChecklist('through-merge', { repository: 'owner/orders-api', server: older, setup: applied, proposal: example }).items.find(entry => entry.id === 'revert-approver')!.status, 'unknown');
});
