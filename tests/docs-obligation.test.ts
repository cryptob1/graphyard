import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { workerPrompt } from '../src/master.js';
import { reviewPrompt } from '../src/reviewer.js';
import { collectScanInput } from '../src/onboarding.js';
import { proposeDocumentation, readDocumentationConfig, writeDocumentationConfig } from '../src/repository-setup.js';
import { documentationGlobMatches } from '../src/model/documentation-glob.js';
import { decideScopeRequest, documentationScopes } from '../src/model/scope.js';
import { configuredDocumentation, defaultDocumentationPolicy, documentationAssignment, documentationCheck, documentationCriterionTitle, documentationObligation, repositoryConfigFile, type DocumentationPolicy } from '../src/model/documentation.js';
import type { Observation, Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-215: every ticket keeps its project's documentation current. Documentation is a
// per-repository setting (its committed graphyard.json, deployed as GRAPHYARD_DOCUMENTATION), the
// control plane stamps every feature and bug with the standard criterion naming those paths, the
// worker's request states it, and the reviewer judges it. Each test is named for the proof it produces.
const root = fileURLToPath(new URL('..', import.meta.url));
const operator: Principal = { id: 'docs-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'docs-implementer', role: 'worker', sessionKind: 'ai' };
const siteRepository: DocumentationPolicy = { paths: ['site/'], changelog: 'CHANGELOG.md' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);
let database: EmbeddedPostgres, store: Store, engine: Engine, dataDirectory: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_DOCS_OBLIGATION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 215);
  dataDirectory = await temporaryDirectory('docs-obligation-db');
  database = new EmbeddedPostgres({ databaseDir: dataDirectory, user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('docs_obligation_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/docs_obligation_test`); await store.init();
  engine = new Engine(store, [15368], 300, 'owner/site-repository'); engine.submissionObserver = null;
});
after(async () => {
  await store?.pool.end();
  await database?.stop();
  await rm(dataDirectory, { recursive: true, force: true });
});

const create = (type: 'feature' | 'bug' | 'chore', title: string) => engine.execute(operator, 'create', null,
  { title, type, plannedFiles: ['src/cli/deploy.ts'], criteria: [{ id: 'AC-1', text: 'The deploy command takes --region', proofs: ['unit:deploy-region'] }] }, randomUUID());
async function submitted(work: Work, files: string[], statement?: string) {
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'docs-host', path: `/tmp/docs-obligation/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
  const pr = 2150 + work.epoch + Number(work.key.slice(3));
  const observed: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr, branch: work.workspaces[0].branch, author: implementer.id },
    checks: [], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files, scopeFiles: [], at: new Date().toISOString() };
  return engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr, ...(statement ? { documentation: statement } : {}) }, randomUUID(), { observation: observed });
}

test('unit:docs-paths-per-repository — the repository configuration names its documentation paths, onboarding proposes them from the checkout, and scope reads them instead of the hardcoded default', async () => {
  // Onboarding proposes what the repository actually holds: a site, a changelog, per-package READMEs.
  const proposed = proposeDocumentation({ files: ['site/index.md', 'site/guide/deploy.md', 'CHANGELOG.md', 'README.md', 'packages/api/README.md', 'packages/web/README.md', 'src/cli/deploy.ts', '.github/README.md'] });
  assert.deepEqual(proposed, { paths: ['site/', 'README.md', 'packages/*/README.md'], changelog: 'CHANGELOG.md' });
  assert.deepEqual(proposeDocumentation({ files: ['docs/a.md', 'doc/b.md', 'wiki/Home.md', 'AGENTS.md', 'README.rst', 'HISTORY.md'] }), { paths: ['docs/', 'doc/', 'wiki/', 'README.rst', 'AGENTS.md'], changelog: 'HISTORY.md' });
  assert.deepEqual(proposeDocumentation({ files: ['main.go'] }), { paths: ['README.md'], changelog: null }, 'a repository with no docs is proposed its README');

  // …and writes it to the repository's committed Graphyard configuration, keeping an existing choice.
  const repository = await temporaryDirectory('docs-paths');
  try {
    for (const file of ['site/index.md', 'CHANGELOG.md', 'src/cli/deploy.ts']) { await mkdir(join(repository, dirname(file)), { recursive: true }); await writeFile(join(repository, file), '# page\n'); }
    const scanned = proposeDocumentation(await collectScanInput(repository));
    assert.deepEqual(scanned, siteRepository);
    assert.equal((await writeDocumentationConfig(repository, scanned)).state, 'written');
    assert.deepEqual(JSON.parse(await readFile(join(repository, repositoryConfigFile), 'utf8')), { documentation: siteRepository });
    assert.deepEqual(await readDocumentationConfig(repository), siteRepository);
    assert.equal((await writeDocumentationConfig(repository, scanned)).state, 'unchanged');
    const drift = await writeDocumentationConfig(repository, { paths: ['docs/'], changelog: null });
    assert.equal(drift.state, 'drift'); assert.deepEqual(drift.policy, siteRepository, 'the committed choice wins over a later scan');
  } finally { await rm(repository, { recursive: true, force: true }); }

  // The control plane serves the deployed policy; the default applies only when none is configured.
  assert.deepEqual(configuredDocumentation({}), defaultDocumentationPolicy);
  assert.deepEqual(defaultDocumentationPolicy.paths, [...documentationScopes]);
  assert.deepEqual(configuredDocumentation({ GRAPHYARD_DOCUMENTATION: documentationAssignment(siteRepository).value }), siteRepository);
  assert.throws(() => configuredDocumentation({ GRAPHYARD_DOCUMENTATION: 'site/' }), /GRAPHYARD_DOCUMENTATION must be the JSON documentation policy/);

  // Globs: a tree, a file, and one README per package.
  assert.ok(documentationGlobMatches('packages/*/README.md', 'packages/api/README.md'));
  assert.ok(!documentationGlobMatches('packages/*/README.md', 'packages/api/src/README.md'));
  assert.ok(documentationGlobMatches('site/', 'site/guide/deploy.md') && documentationGlobMatches('README*', 'README.md'));

  // An item of a repository configured with site/ and CHANGELOG.md implies those paths, not docs/.
  const item = { plannedFiles: ['src/cli/deploy.ts'], criteria: [{ id: 'AC-1', text: 'The deploy command takes --region' }], documentation: documentationObligation('feature', siteRepository) };
  for (const path of ['site/guide/deploy.md', 'CHANGELOG.md'])
    assert.equal(decideScopeRequest(item, { paths: [path] }).state, 'approved', `${path} is this repository's documentation`);
  const docs = decideScopeRequest(item, { paths: ['docs/deploy.md'] });
  assert.equal(docs.state, 'refused', 'docs/ is not this repository\'s documentation'); assert.match(docs.reason, /docs\/deploy\.md is outside/);
  assert.equal(decideScopeRequest(item, { paths: ['README.md'] }).state, 'refused', 'nor is a README it does not configure');
  // An item created before any configuration keeps the default.
  assert.equal(decideScopeRequest({ ...item, documentation: undefined }, { paths: ['docs/deploy.md'] }).state, 'approved');
  assert.equal(decideScopeRequest({ ...item, documentation: undefined }, { paths: ['site/index.md'] }).state, 'refused');
});

test('unit:docs-obligation-on-every-item — create stamps "Documentation reflects this change" with the repository\'s paths on every feature and bug, submission satisfies it by a docs diff or a statement, and the worker request names the paths', async () => {
  engine.documentation = siteRepository;
  const feature = await create('feature', 'Add a region flag to deploy');
  const bug = await create('bug', 'Deploy ignores the region');
  const chore = await create('chore', 'Bump the lockfile');
  for (const work of [feature, bug]) {
    assert.equal(work.documentation?.id, 'DOCS');
    assert.ok(work.documentation!.text.startsWith(`${documentationCriterionTitle}:`), work.documentation!.text);
    assert.deepEqual(work.documentation!.paths, ['site/']); assert.equal(work.documentation!.changelog, 'CHANGELOG.md');
    assert.match(work.documentation!.text, /site\//); assert.match(work.documentation!.text, /CHANGELOG\.md/); assert.doesNotMatch(work.documentation!.text, /docs\//);
    assert.deepEqual(work.criteria.map(criterion => criterion.id), ['AC-1'], 'the author\'s criteria are untouched');
  }
  assert.equal(chore.documentation, undefined, 'a chore carries no documentation obligation');
  // Persisted on the item, not only in the create response.
  assert.deepEqual((await store.list()).find(item => item.id === feature.id)!.documentation, feature.documentation);

  // The worker's launch request states the obligation and names the repository's paths.
  const request = workerPrompt({ cliPath: '/opt/graphyard/bin/graphyard.mjs' }, feature, { principal: implementer.id }, 1);
  assert.match(request, new RegExp(`standard criterion "${documentationCriterionTitle}"`));
  assert.match(request, /\(site\/\) and add an entry to CHANGELOG\.md/);
  assert.match(request, new RegExp(`complete ${feature.key} 1 PR --no-docs "`));
  assert.doesNotMatch(workerPrompt({ cliPath: '/opt/graphyard/bin/graphyard.mjs' }, chore, { principal: implementer.id }, 1), /Documentation reflects this change/);

  // Satisfied at submission by a diff inside the documentation paths…
  const byDiff = await submitted(feature, ['src/cli/deploy.ts', 'site/guide/deploy.md', 'CHANGELOG.md']);
  assert.deepEqual(byDiff.documentation!.submission, { epoch: 1, pr: byDiff.submission!.pr, at: byDiff.documentation!.submission!.at, files: ['site/guide/deploy.md', 'CHANGELOG.md'], statement: null, satisfiedBy: 'diff' });
  // …or by the worker's explicit statement that no documented behaviour changed…
  const byStatement = await submitted(bug, ['src/cli/deploy.ts'], 'The region was already documented; this only fixes the parser to honour it');
  assert.equal(byStatement.documentation!.submission!.satisfiedBy, 'statement');
  assert.match(byStatement.documentation!.submission!.statement!, /already documented/);
  // …and neither is recorded as unsatisfied, for the reviewer to judge.
  const neither = await submitted(await create('feature', 'Rename the deploy command'), ['src/cli/deploy.ts']);
  assert.equal(neither.documentation!.submission!.satisfiedBy, null);
  assert.deepEqual(neither.documentation!.submission!.files, []);
  engine.documentation = defaultDocumentationPolicy;
});

test('unit:reviewer-checks-docs — the reviewer prompt carries the documentation check with the repository\'s paths, and a CLI change with no docs diff and no statement is flagged', () => {
  const obligation = documentationObligation('feature', siteRepository)!;
  const config = { repository: 'owner/site-repository' };
  const binding = { key: 'GY-9', pr: 9, sha: head, baseSha: base, policyRevision: 1 };
  const criteria = [{ id: 'AC-1', text: 'The deploy command takes --region' }];

  const flagged = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, { obligation, files: ['src/cli/deploy.ts'] });
  assert.match(flagged, /\[DOCS\] Documentation reflects this change/, 'the standard criterion is judged beside the item\'s own');
  assert.match(flagged, /Documentation check \(the standard criterion "Documentation reflects this change"\): confirm the diff updates this repository's documentation paths \(site\/, CHANGELOG\.md\)/);
  assert.match(flagged, /Request changes when user-visible behaviour, commands, configuration or APIs changed without a matching documentation update/);
  assert.match(flagged, /The worker made no no-docs statement at submission/);
  assert.match(flagged, /Graphyard flags this submission: Documentation is missing: the change touches user-visible surface src\/cli\/deploy\.ts with no change under site\/, CHANGELOG\.md and no statement/);
  assert.match(flagged, /BLOCKING finding/);

  const check = documentationCheck(obligation, ['src/cli/deploy.ts']);
  assert.equal(check.state, 'missing'); assert.deepEqual(check.surfaces, ['src/cli/deploy.ts']); assert.ok(check.flag);

  // A docs diff, or a statement for the reviewer to verify, is not flagged.
  const documented = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, { obligation, files: ['src/cli/deploy.ts', 'site/guide/deploy.md'] });
  assert.doesNotMatch(documented, /Graphyard flags this submission/); assert.match(documented, /Documentation files in the diff: site\/guide\/deploy\.md/);
  const stated = reviewPrompt(config, binding, undefined, undefined, criteria, undefined, { obligation: { ...obligation, submission: { epoch: 1, pr: 9, at: new Date().toISOString(), files: [], statement: 'Internal refactor, output unchanged', satisfiedBy: 'statement' } }, files: ['src/cli/deploy.ts'] });
  assert.doesNotMatch(stated, /Graphyard flags this submission/);
  assert.match(stated, /The worker's statement at submission: "Internal refactor, output unchanged"/);
  assert.match(stated, /or, when the worker stated the change alters no documented behaviour, that the statement is true/);
  // A change to internal code only is judged by the reviewer, not flagged by the heuristic.
  assert.equal(documentationCheck(obligation, ['src/engine/internal.ts']).flag, null);
  // An item without the obligation (a chore) gets no documentation section.
  assert.doesNotMatch(reviewPrompt(config, binding, undefined, undefined, criteria), /Documentation check/);
});

test('unit:graphyard-docs-policy-configured — Graphyard\'s own repository configures docs/, README.md and AGENTS.md through graphyard.json, and docs/onboarding.md explains the setting', async () => {
  const own = await readDocumentationConfig(root);
  assert.deepEqual(own, { paths: ['docs/', 'README.md', 'AGENTS.md'], changelog: null });
  // The same mechanism: onboarding's scan of this checkout proposes exactly what is committed…
  assert.deepEqual(proposeDocumentation(await collectScanInput(root)), own);
  // …the deployment value round-trips to the policy the control plane serves…
  assert.deepEqual(configuredDocumentation({ GRAPHYARD_DOCUMENTATION: documentationAssignment(own!).value }), own);
  // …and an item created under it implies those paths.
  const item = { criteria: [{ id: 'AC-1', text: 'A behaviour change' }], documentation: documentationObligation('feature', own!) };
  for (const path of ['docs/onboarding.md', 'README.md', 'AGENTS.md']) assert.equal(decideScopeRequest(item, { paths: [path] }).state, 'approved', path);
  assert.equal(decideScopeRequest(item, { paths: ['site/index.md'] }).state, 'refused');

  const guide = await readFile(join(root, 'docs/onboarding.md'), 'utf8');
  for (const needle of [repositoryConfigFile, 'GRAPHYARD_DOCUMENTATION', documentationCriterionTitle, '--no-docs', '"changelog"'])
    assert.ok(guide.includes(needle), `docs/onboarding.md explains ${needle}`);
});
