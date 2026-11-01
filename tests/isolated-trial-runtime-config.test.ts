import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryClaudeConfig, trustClaudeFolder } from '../src/harness.js';
import { loadMasterConfig, prepareSessionHarness, setupMaster, startAgentSession } from '../src/master.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('integration:isolated-trial-runtime-config — nested durable scratch excludes unrelated ancestor settings with an isolated HOME, while project settings remain guarded', async () => {
  const operator = await temporaryDirectory('operator-home');
  const account = await temporaryDirectory('claude-account', operator);
  await symlink(account, join(operator, '.claude'));
  const ancestorSettings = join(operator, '.claude/settings.json');
  await writeFile(ancestorSettings, '{"hooks":{}}\n');
  const durable = join(operator, '.gy/tmp');
  await mkdir(durable, { recursive: true });
  const trial = await temporaryDirectory('trial', durable);
  const home = await temporaryDirectory('isolated-home', trial);
  const runtimeHome = await temporaryDirectory('runtime-account', trial);
  await writeFile(join(runtimeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-only', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  const root = await temporaryDirectory('repository', trial);
  const credentials = await temporaryDirectory('credentials', trial);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await setupMaster(root, { url: 'https://graphyard.example', token: 'fixture-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'fixture' },
      (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
    const environment = { HOME: home, CLAUDE_CONFIG_DIR: runtimeHome };
    assert.equal(await repositoryClaudeConfig(root, environment), ancestorSettings, 'the symlinked ancestor is the exact source of the original refusal');
    await assert.rejects(trustClaudeFolder(root, environment), error => error instanceof Error && error.message.includes(ancestorSettings));
    const config = await loadMasterConfig(root);
    const harness = await prepareSessionHarness(root, config, { role: 'worker', kind: 'claude', profile: 'fixture', branch: 'graphyard/gy-3049-1' });
    assert.deepEqual(harness.args, ['--setting-sources', 'user', '--settings', harness.file]);
    const typed: string[] = [];
    const run = (_command: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'run') typed.push(args[3]);
      return startedAtOnce(args) ?? JSON.stringify({ result: {} });
    };
    await startAgentSession('fixture-worker', 'claude', 'fixture-pane', ['--permission-mode', 'bypassPermissions', ...harness.args], 'Fixture task', run,
      { directory: root, environment, role: harness.role, confinement: false });
    assert.ok(expandTypedCommand(typed[0]).args.includes('--setting-sources'));
    const projects = JSON.parse(await readFile(join(runtimeHome, '.claude.json'), 'utf8')).projects;
    assert.deepEqual(Object.keys(projects), [root], 'only the launched folder is trusted, never its operator-home ancestor');
    assert.equal(projects[root].hasTrustDialogAccepted, true);
    assert.equal(await readFile(ancestorSettings, 'utf8'), '{"hooks":{}}\n');

    const project = await temporaryDirectory('project', trial);
    await mkdir(join(project, '.claude'));
    const settings = join(project, '.claude/settings.json');
    await writeFile(settings, '{"hooks":{}}\n');
    assert.equal(await repositoryClaudeConfig(project, environment), settings);
    await assert.rejects(trustClaudeFolder(project, environment), error => error instanceof Error && error.message.includes(settings));
    const projectHarness = await prepareSessionHarness(project, config, { role: 'reviewer', kind: 'claude', profile: 'project' });
    assert.equal(projectHarness.args[1], 'user');
    await trustClaudeFolder(project, environment, projectHarness.args);
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
});
