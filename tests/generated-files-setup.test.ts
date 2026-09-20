import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredGeneratedFiles, parseGeneratedFiles } from '../src/generated-files.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable } from '../src/install/generated-files.js';
import { installationOwner } from '../src/master.js';
import { applyProposal, scanProposal } from '../src/repository-setup.js';

// GY-77 AC-1 / AC-2: the installers derive GRAPHYARD_GENERATED_FILES from the managed
// repository's generated-file manifest and set it beside GRAPHYARD_PRINCIPALS, master status
// reports drift against the manifest with the exact command to fix it, and the documented
// command yields a value the server parses while an unparseable one refuses start-up.

const repository = fileURLToPath(new URL('..', import.meta.url));

const manifestScript = `#!/usr/bin/env node
const generated = ['docs/index.md', 'docs/list.md'];
if (process.argv.includes('--list')) { console.log(generated.join(',')); process.exit(0); }
if (process.argv.includes('--manifest')) { console.log(JSON.stringify({ generated, regenerate: 'node scripts/check-docs.mjs --write' })); process.exit(0); }
process.exit(1);
`;

// The real predecessor of the manifest script: it does not know `--list`, so the flag falls
// through to the full docs check, which exits 0 and prints a sentence — never a path list.
const predecessorScript = `#!/usr/bin/env node
const generated = ['docs/index.md', 'docs/list.md'];
if (process.argv.includes('--manifest')) { console.log(JSON.stringify({ generated, regenerate: 'node scripts/check-docs.mjs --write' })); process.exit(0); }
console.log('Checked 12 Markdown files; all relative links, anchors and generated indexes resolve.');
`;

const ordersApi = {
  'package.json': JSON.stringify({ name: 'orders-api', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' }, devDependencies: { vitest: '1.0.0' } }),
  'tests/api.test.ts': 'import { test } from "vitest";\ntest.todo("orders");\n',
};

async function fixtureRepo(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-generated-files-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test('unit:generated-files-parse — the server parses exactly the comma-separated lists installers set', () => {
  assert.deepEqual(parseGeneratedFiles('docs/protocol.md,docs/README.md'), ['docs/protocol.md', 'docs/README.md']);
  assert.deepEqual(parseGeneratedFiles(' docs/protocol.md ,\tdocs/README.md , docs/protocol.md '), ['docs/protocol.md', 'docs/README.md']);
  assert.deepEqual(parseGeneratedFiles(undefined), []);
  assert.deepEqual(parseGeneratedFiles(''), []);
  // The raw manifest JSON an operator once pasted into the variable is refused, not silently
  // accepted, and so is every value that is not a list of exact repository-relative files.
  for (const value of ['{"generated":["docs/README.md"]}', '/docs/README.md', 'docs/*.md', 'docs/../README.md', 'docs\\README.md', 'docs//x.md', 'docs/./x.md', 'docs/x?.md'])
    assert.throws(() => parseGeneratedFiles(value), /GRAPHYARD_GENERATED_FILES names exact repository-relative files/, value);
  assert.deepEqual(configuredGeneratedFiles({ GRAPHYARD_GENERATED_FILES: 'docs/a.md,docs/b.md' }), ['docs/a.md', 'docs/b.md']);
  assert.throws(() => configuredGeneratedFiles({ GRAPHYARD_GENERATED_FILES: '{"generated":[]}' }), /GRAPHYARD_GENERATED_FILES names exact repository-relative files/);
});

test('integration:generated-files-setup — the documented command prints the value the server parses', async () => {
  const run = (args: string[]) => execFileSync(process.execPath, ['scripts/check-docs.mjs', ...args], { cwd: repository, encoding: 'utf8' });
  const listed = run(['--list']).trim();
  assert.equal(listed, 'docs/protocol.md,docs/README.md');
  assert.deepEqual(parseGeneratedFiles(listed), ['docs/protocol.md', 'docs/README.md']);
  assert.deepEqual(parseGeneratedFiles(listed), JSON.parse(run(['--manifest'])).generated, 'the --list form and the manifest JSON declare the same files');
  // This repository's own installer assignment derives the same value from its manifest.
  assert.equal(generatedFilesAssignment(repository)?.line, 'GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md');
});

test('integration:generated-files-setup — installers derive the assignment from a repository manifest', async () => {
  const withManifest = await fixtureRepo({ 'scripts/check-docs.mjs': manifestScript });
  try {
    assert.deepEqual(generatedFilesAssignment(withManifest), { variable: generatedFilesVariable, files: ['docs/index.md', 'docs/list.md'], value: 'docs/index.md,docs/list.md', line: 'GRAPHYARD_GENERATED_FILES=docs/index.md,docs/list.md' });
  } finally { await rm(withManifest, { recursive: true, force: true }); }
  const without = await fixtureRepo();
  try { assert.equal(generatedFilesAssignment(without), null); } finally { await rm(without, { recursive: true, force: true }); }
  // A manifest that fails, or prints a value the server would refuse, is named loudly.
  const failing = await fixtureRepo({ 'scripts/check-docs.mjs': 'process.exit(3)\n' });
  try { assert.throws(() => generatedFilesAssignment(failing), /generated-file manifest failed/); } finally { await rm(failing, { recursive: true, force: true }); }
  const lying = await fixtureRepo({ 'scripts/check-docs.mjs': 'console.log("/abs,x/**");\n' });
  try { assert.throws(() => generatedFilesAssignment(lying), /GRAPHYARD_GENERATED_FILES names exact repository-relative files/); } finally { await rm(lying, { recursive: true, force: true }); }
  const jsonOnly = await fixtureRepo({ 'scripts/check-docs.mjs': 'if (process.argv.includes("--manifest")) console.log(JSON.stringify({ generated: ["docs/a.md"], regenerate: "node scripts/check-docs.mjs --write" })); else process.exit(1);\n' });
  try { assert.equal(generatedFilesAssignment(jsonOnly)?.value, 'docs/a.md', 'a script that predates --list is read through its manifest JSON'); } finally { await rm(jsonOnly, { recursive: true, force: true }); }
  // A script that predates --list ignores the flag and still exits 0 with prose on stdout, so
  // the exit code cannot decide: the manifest JSON is the declaration of record and wins, and
  // the prose is never taken as the list.
  const predecessor = await fixtureRepo({ 'scripts/check-docs.mjs': predecessorScript });
  try {
    const derived = generatedFilesAssignment(predecessor);
    assert.equal(derived?.value, 'docs/index.md,docs/list.md', 'the manifest JSON wins over the full-check prose the script printed for --list');
    assert.ok(!derived!.value.includes('Checked'), 'the full-check sentence is not mistaken for the manifest');
  } finally { await rm(predecessor, { recursive: true, force: true }); }
  // The prose is also not accepted when no manifest JSON can back it: the derivation refuses.
  const proseOnly = await fixtureRepo({ 'scripts/check-docs.mjs': `if (process.argv.includes('--manifest')) process.exit(7);\nconsole.log('Checked 12 Markdown files; all relative links, anchors and generated indexes resolve.');\n` });
  try { assert.throws(() => generatedFilesAssignment(proseOnly), /generated-file manifest failed/); } finally { await rm(proseOnly, { recursive: true, force: true }); }
  // A manifest that declares an empty set declares nothing to exempt; it is not a failure.
  const empty = await fixtureRepo({ 'scripts/check-docs.mjs': `if (process.argv.includes('--list')) { console.log(''); process.exit(0); }\nif (process.argv.includes('--manifest')) { console.log(JSON.stringify({ generated: [], regenerate: 'node scripts/check-docs.mjs --write' })); process.exit(0); }\nprocess.exit(1);\n` });
  try { assert.equal(generatedFilesAssignment(empty), null); } finally { await rm(empty, { recursive: true, force: true }); }
  // A script that predates --manifest declares through a well-formed --list line alone.
  const listOnly = await fixtureRepo({ 'scripts/check-docs.mjs': `if (process.argv.includes('--list')) console.log('docs/a.md,docs/b.md'); else process.exit(9);\n` });
  try { assert.equal(generatedFilesAssignment(listOnly)?.value, 'docs/a.md,docs/b.md'); } finally { await rm(listOnly, { recursive: true, force: true }); }
});

test('integration:generated-files-setup — init --scan --apply sets the derived line beside GRAPHYARD_PRINCIPALS', async () => {
  const dependencies = (tokens: { count: number }) => ({ url: 'https://graphyard.example',
    githubSetup: async () => ({ appId: 1234, slug: 'graphyard-owner-repo' }),
    token: () => `secret-${++tokens.count}-`.padEnd(40, 't'), now: () => new Date('2030-01-01T00:00:00Z') });
  const declared = await fixtureRepo({ ...ordersApi, 'scripts/check-docs.mjs': manifestScript });
  try {
    const proposal = await scanProposal(declared, { url: 'https://graphyard.example', runtimes: [] });
    const result = await applyProposal(declared, proposal, dependencies({ count: 0 }));
    assert.equal(result.generatedFiles, 'GRAPHYARD_GENERATED_FILES=docs/index.md,docs/list.md');
    assert.match(result.next, /Install the principals array as GRAPHYARD_PRINCIPALS on the Graphyard deployment, with GRAPHYARD_GENERATED_FILES=docs\/index\.md,docs\/list\.md beside it/);
  } finally { await rm(declared, { recursive: true, force: true }); }
  const undeclared = await fixtureRepo(ordersApi);
  try {
    const proposal = await scanProposal(undeclared, { url: 'https://graphyard.example', runtimes: [] });
    const result = await applyProposal(undeclared, proposal, dependencies({ count: 0 }));
    assert.equal(result.generatedFiles, null);
    assert.match(result.next, /Install the principals array as GRAPHYARD_PRINCIPALS on the Graphyard deployment, no agent runtime was detected/);
  } finally { await rm(undeclared, { recursive: true, force: true }); }
});

test('integration:generated-files-setup — master status reports deployment drift with the exact command to fix it', () => {
  const manifest = generatedFilesAssignment(repository);
  assert.ok(manifest);
  // The production shape that started this item: the deployment reports the variable unset.
  const deployed: Record<string, string | null> = { GRAPHYARD_MAX_REVIEWERS: '4', [generatedFilesVariable]: null };
  const [unset] = generatedFilesDrift(deployed[generatedFilesVariable], manifest);
  assert.match(unset, /GRAPHYARD_GENERATED_FILES is unset on the deployment, so the regression guard treats every file as owned; the repository manifest declares docs\/protocol\.md,docs\/README\.md\. Set GRAPHYARD_GENERATED_FILES=docs\/protocol\.md,docs\/README\.md on the deployment\./);
  const owner = installationOwner('delegation-limits', unset);
  assert.equal(owner.role, 'master');
  assert.equal(owner.next, 'Set GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md on the deployment (Railway: railway variables --set GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md --service graphyard), then redeploy');
  // A matching value raises nothing, whatever order the operator used; a stale, refused, or
  // unreported value is raised the same way, and a repository without a manifest never drifts.
  assert.deepEqual(generatedFilesDrift('docs/README.md , docs/protocol.md', manifest), []);
  const [stale] = generatedFilesDrift('docs/README.md', manifest);
  assert.match(stale, /no longer matches the repository manifest.*Set GRAPHYARD_GENERATED_FILES=docs\/protocol\.md,docs\/README\.md on the deployment\./);
  const [garbage] = generatedFilesDrift('{"generated":["docs/README.md"]}', manifest);
  assert.match(garbage, /does not parse.*Set GRAPHYARD_GENERATED_FILES=docs\/protocol\.md,docs\/README\.md on the deployment\./);
  const [unreported] = generatedFilesDrift(undefined, manifest);
  assert.match(unreported, /does not report GRAPHYARD_GENERATED_FILES \(deploy main first\).*Set GRAPHYARD_GENERATED_FILES=docs\/protocol\.md,docs\/README\.md on the deployment\./);
  assert.deepEqual(generatedFilesDrift('docs/README.md', null), []);
});

test('integration:generated-files-setup — the server refuses an unparseable value at start-up and reports the deployed one', async () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
    cwd: repository, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GRAPHYARD_GENERATED_FILES: '{"generated":["docs/README.md"]}' },
  });
  assert.notEqual(child.status, 0, 'start-up refuses an unparseable declaration');
  assert.match(`${child.stderr}`, /GRAPHYARD_GENERATED_FILES names exact repository-relative files/);
  // The process entry augments the deployed-variables record the status route reports with the
  // configured value, and parses the declaration before anything else starts.
  const main = await readFile(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  assert.match(main, /const generatedFiles = configuredGeneratedFiles\(\);/);
  assert.match(main, /delegationLimits\.deployed\[generatedFilesVariable\] = process\.env\.GRAPHYARD_GENERATED_FILES/);
  // The wiring that carries the drift to master status and the principals instruction.
  const status = await readFile(new URL('../src/cli/master-status.ts', import.meta.url), 'utf8');
  assert.match(status, /generatedFilesAssignment\(root\)/);
  assert.match(status, /installationOwner\('delegation-limits', text\)/);
  // The drift is counted like every other attention item, so the summary count never hides it.
  assert.match(status, /attention: status\.counts\.attention \+ diskAttention\.length \+ generatedFiles\.length/);
  const setup = await readFile(new URL('../src/repository-setup.ts', import.meta.url), 'utf8');
  assert.match(setup, /generatedFilesAssignment\(root\)/);
});

// The adapters run `npx` and `gh`, so they are exercised against a fixture repository with a
// recording shim on PATH: what reaches `railway variable set` is the assertion, not the source
// text. `src` and the dependency install are linked in so the copied adapter resolves them.
async function adapterFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-adapter-'));
  await symlink(join(repository, 'src'), join(root, 'src'), 'dir');
  const resolved = createRequire(import.meta.url).resolve('tsx/esm/api');
  await symlink(resolved.slice(0, resolved.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length), join(root, 'node_modules'), 'dir');
  for (const [path, content] of Object.entries({ 'scripts/provision-railway.mjs': await readFile(join(repository, 'scripts/provision-railway.mjs'), 'utf8'), ...files })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const record = join(root, 'npx-calls.txt');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'bin/npx'), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(record)}; done\ncat > /dev/null\n`, { mode: 0o755 });
  return { root, record };
}

test('integration:generated-files-setup — the Railway adapter sets the derived variable beside GRAPHYARD_PRINCIPALS', async () => {
  const credentials = JSON.stringify([{ id: 'operator', role: 'admin', token: 'a'.repeat(40) }, { id: 'agent-1', role: 'worker', token: 'b'.repeat(40) }]);
  const declared = await adapterFixture({ 'scripts/check-docs.mjs': manifestScript, '.graphyard/credentials.json': credentials });
  try {
    const run = spawnSync(process.execPath, ['scripts/provision-railway.mjs'], { cwd: declared.root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PATH: `${join(declared.root, 'bin')}:${process.env.PATH}`, GRAPHYARD_URL: '' } });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const set = (await readFile(declared.record, 'utf8')).split('\n');
    assert.ok(set.includes('GRAPHYARD_GENERATED_FILES=docs/index.md,docs/list.md'), `the adapter set ${set.filter(entry => entry.startsWith('GRAPHYARD_')).join(' ')}`);
    assert.ok(set.includes('GRAPHYARD_MAX_REVIEWERS=2'), 'the capacity variables are still set beside it');
    assert.match(run.stdout, /GRAPHYARD_GENERATED_FILES=docs\/index\.md,docs\/list\.md/);
  } finally { await rm(declared.root, { recursive: true, force: true }); }
  // A managed repository that declares no manifest sets no exemption at all.
  const undeclared = await adapterFixture({ '.graphyard/credentials.json': credentials });
  try {
    const run = spawnSync(process.execPath, ['scripts/provision-railway.mjs'], { cwd: undeclared.root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PATH: `${join(undeclared.root, 'bin')}:${process.env.PATH}`, GRAPHYARD_URL: '' } });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.ok(!(await readFile(undeclared.record, 'utf8')).includes(generatedFilesVariable));
  } finally { await rm(undeclared.root, { recursive: true, force: true }); }
});

test('integration:generated-files-setup — every other adapter deploys the same derived value', async () => {
  const source = (name: string) => readFile(join(repository, name), 'utf8');
  // The integrations adapter stages variables one by one through its own secret-safe path, so the
  // derived value travels in the same record as GRAPHYARD_PRINCIPALS and the capacity variables.
  const integrations = await source('scripts/configure-integrations.mjs');
  assert.match(integrations, /generated = generatedFilesAssignment\(fileURLToPath\(root\)\)/);
  // A manifest it cannot read names itself rather than hiding behind the stage message.
  assert.match(integrations, /catch \(error\) \{ throw Object\.assign\(new Error\(error\.message\), \{ visible: true \}\); \}/);
  assert.match(integrations, /GRAPHYARD_PRINCIPALS: JSON\.stringify\(roster\), \.\.\.limits\.variables, \.\.\.\(generated \? \{ \[generated\.variable\]: generated\.value \} : \{\}\)/);
  // Applying the Railway configuration must not drop what the adapters set.
  assert.match(await source('.railway/railway.ts'), new RegExp(`${generatedFilesVariable}: preserve\\(\\)`));
  // The Compose install copies .env.example, so the variable is declared there too.
  assert.match(await source('.env.example'), new RegExp(`^${generatedFilesVariable}=`, 'm'));
});
