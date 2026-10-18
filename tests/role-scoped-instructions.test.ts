import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setupMaster } from '../src/master.js';
import { managedInstructions } from '../src/repository-setup.js';
import { agentsRenderers } from '../src/cli/workspace-generated.js';
import { regenerateManagedBlocks } from '../src/sync.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1493: the master's rules leave AGENTS.md, which every worker, reviewer and producer session
// loads, and reach the master session through graphyard master guide instead.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(repositoryRoot, 'bin/graphyard.mjs');
const exec = promisify(execFile);
const url = 'https://graphyard.example';
const legacyBlock = '<!-- graphyard-master -->\n## Graphyard master agent\n\nRules an earlier master init wrote.\n<!-- /graphyard-master -->';
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
// Imported per test, so a tree without the GY-1493 exports fails each case rather than the file.
const master = async () => await import('../src/master.js') as unknown as { masterInstructions: string; withoutMasterInstructions: (existing: string) => string };

async function repository() {
  const root = await temporaryDirectory('role-instructions');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  return root;
}

test('unit:master-block-migrated — master init writes the worker block only and removes exactly an existing master block', async () => {
  const { withoutMasterInstructions } = await master();
  const pre = '# Local rules\n\nKeep this text.\n\n', post = '\n\n## After\nAnd this.\n';
  assert.equal(withoutMasterInstructions(`${pre}${legacyBlock}${post}`), `${pre}${post}`, 'every byte outside the block is kept');
  assert.equal(withoutMasterInstructions(`${pre}${post}`), `${pre}${post}`, 'a file without the block is unchanged');
  for (const malformed of [`${legacyBlock}\n${legacyBlock}`, '<!-- graphyard-master -->\nopen only\n', '<!-- /graphyard-master -->\n<!-- graphyard-master -->\n']) assert.throws(() => withoutMasterInstructions(malformed), /master markers.*AGENTS\.md/);

  const fresh = await repository(), migrated = await repository(), refused = await repository(), credentialDirectory = await temporaryDirectory('role-instructions-credentials');
  const setup = (root: string) => setupMaster(root, { url, token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory }, coordinatorStatus as typeof fetch);
  try {
    await setup(fresh);
    const written = await readFile(join(fresh, 'AGENTS.md'), 'utf8');
    assert.equal(written, managedInstructions('', url), 'a fresh AGENTS.md carries the worker block only');
    assert.doesNotMatch(written, /graphyard-master|Graphyard master agent/);

    const existing = `${pre}${managedInstructions('', url).trimStart()}\n${legacyBlock}${post}`;
    await writeFile(join(migrated, 'AGENTS.md'), existing);
    await setup(migrated);
    assert.equal(await readFile(join(migrated, 'AGENTS.md'), 'utf8'), withoutMasterInstructions(existing), 'only the master block is removed');
    assert.equal(withoutMasterInstructions(existing), existing.replace(legacyBlock, ''));

    const duplicate = `${pre}${legacyBlock}\n${legacyBlock}\n`;
    await writeFile(join(refused, 'AGENTS.md'), duplicate);
    await assert.rejects(setup(refused), /Malformed or duplicate Graphyard master markers; resolve them before updating AGENTS\.md/);
    assert.equal(await readFile(join(refused, 'AGENTS.md'), 'utf8'), duplicate, 'a refused file is left as it was');
  } finally { for (const root of [fresh, migrated, refused, credentialDirectory]) await rm(root, { recursive: true, force: true }); }
});

test('unit:master-guide-carries-role-instructions — graphyard master guide prints the master instructions before docs/master-agent.md', async () => {
  const { masterInstructions } = await master();
  const { stdout } = await exec(process.execPath, [launcher, 'master', 'guide'], { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 });
  const guide = (await readFile(join(repositoryRoot, 'docs/master-agent.md'), 'utf8')).replace(/^<!-- page:[^\n]*\n/, '');
  assert.ok(stdout.startsWith(masterInstructions), 'the role instructions lead the guide');
  assert.equal(stdout, `${masterInstructions}\n${guide}\n`);
  // Every rule the AGENTS.md block carried is in the text the master now reads.
  for (const rule of ['Autonomy is the default: act without asking.', 'graphyard master decide GY-N ACTION REASON', 'graphyard master approver GY-N DECISION', 'master browser app-permissions', 'Keep cycling: status, dispatch ready work', 'graphyard master verify-deployment GY-N', 'There is no Graphyard merge to run.', 'Never use an administrative merge bypass']) assert.ok(stdout.replace(/\s+/g, ' ').includes(rule), `master guide states: ${rule}`);
});

test('unit:agents-md-worker-block-only — sync regeneration renders the worker block and drops a master block; Graphyard\'s own AGENTS.md has none', async () => {
  const renderers = await agentsRenderers(repositoryRoot);
  assert.equal(renderers.source, 'worktree');
  const clean = managedInstructions('# Rules\n', url);
  const conflicted = `${clean.replace('Renew ownership at least every 30 seconds', '<<<<<<< HEAD\nRenew ownership at least every 20 seconds\n=======\nRenew ownership at least every 45 seconds\n>>>>>>> origin/main')}\n${legacyBlock}\n`;
  const rendered = regenerateManagedBlocks(conflicted, text => renderers.managedInstructions(renderers.withoutMasterInstructions(text), url));
  assert.equal(rendered, `${clean}\n\n`, 'the worker block is rendered afresh and the master block is gone');
  assert.equal(regenerateManagedBlocks(`${clean}${legacyBlock}${legacyBlock}`, text => renderers.managedInstructions(renderers.withoutMasterInstructions(text), url)), null, 'duplicate master markers are left for the worker');
  // A CLI released before GY-1493 probes the merged tree for managedMasterInstructions and runs it on
  // a conflicted AGENTS.md that still carries the block: the tree's export drops that block only.
  const { managedMasterInstructions } = await import('../src/master.js') as unknown as { managedMasterInstructions: (existing: string) => string };
  const earlierCli = (text: string) => { const worker = renderers.managedInstructions(text, url); return worker.includes('<!-- graphyard-master -->') ? managedMasterInstructions(worker) : worker; };
  assert.equal(regenerateManagedBlocks(conflicted, earlierCli), `${clean}\n\n`, 'an earlier CLI never turns AGENTS.md into the master text alone');
  const own = await readFile(join(repositoryRoot, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(own, /graphyard-master -->|## Graphyard master agent/);
});

test('unit:role-instructions-budget — worker, reviewer and memory prompts do not draw on the master instructions, and the docs budget is unaffected', async () => {
  const read = (path: string) => readFile(join(repositoryRoot, path), 'utf8');
  for (const source of ['src/master/dispatch.ts', 'src/reviewer.ts', 'src/model/project-memory.ts', 'src/project-memory.ts']) assert.doesNotMatch(await read(source), /master\/instructions|masterInstructions/, `${source} builds its prompt without the master instructions`);
  const config = JSON.parse(await read('graphyard.json'));
  const paths: string[] = config.documentation.wordBudget.paths;
  assert.ok(paths.length && !paths.some(path => 'AGENTS.md'.startsWith(path)), 'AGENTS.md is outside the docs word budget');
  const page = await read('docs/master-agent.md');
  const sentence = page.match(/`master guide` prints its role instructions[^\n]*?worker block\./)?.[0];
  assert.ok(sentence, 'docs/master-agent.md says where the role instructions now come from');
  assert.ok(words(sentence!) <= 15, 'the guide grows by at most 15 words');
});
