import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { installDirectory } from '../src/install/secrets.js';
import { writeMergeToken } from '../src/install/merge-token.js';
import { defaultMergeTokenFile, mergeWriterSettings, mergeWriterSettingsSchema } from '../src/master/merge-writer-settings.js';
import { mergeAskpassName, mergeWriterRemote, pushArgs, pushEnvironment } from '../src/merge-writer/executor.js';
import { trialHiddenPaths } from '../src/merge-writer/trial.js';
import { credentialMaskFor } from '../src/master/confinement.js';
import { harness } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3220 AC-1: the merge writer's fine-grained token, the alternative to the deploy key.

const TOKEN = 'github_pat_fixture_token_value';

test('unit:merge-writer-token — the token file is 0600, its askpass answers git, and the environment carries only the file path', async () => {
  const directory = await temporaryDirectory('merge-writer-token');
  const file = await writeMergeToken(directory, TOKEN);
  assert.equal(file, join(directory, 'merge-writer.token'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const env = pushEnvironment({ tokenFile: file }, { PATH: process.env.PATH!, GITHUB_TOKEN: 'ambient' });
  assert.equal(env.GIT_ASKPASS, join(directory, mergeAskpassName));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GRAPHYARD_MERGE_TOKEN_FILE, file);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.ok(!JSON.stringify(env).includes(TOKEN), 'the token is not in the environment');
  const ask = (prompt: string) => execFileSync(env.GIT_ASKPASS, [prompt], { env, encoding: 'utf8' }).trim();
  assert.equal(ask("Username for 'https://github.com': "), 'x-access-token');
  assert.equal(ask("Password for 'https://x-access-token@github.com': "), TOKEN);

  assert.equal(mergeWriterRemote('owner/project', file, {}), 'https://github.com/owner/project.git');
  assert.equal(mergeWriterRemote('owner/project', file, { GRAPHYARD_MERGE_WRITER_GIT_URL: 'http://127.0.0.1:1/r.git' }), 'http://127.0.0.1:1/r.git');
  assert.equal(mergeWriterRemote('owner/project', undefined, { GRAPHYARD_MERGE_WRITER_GIT_URL: 'http://127.0.0.1:1/r.git' }), 'origin', 'a deploy key install keeps origin');
  const args = pushArgs('main', 'a'.repeat(40), 'b'.repeat(40), mergeWriterRemote('owner/project', file, {}));
  assert.ok(!args.join(' ').includes(TOKEN) && args[1] === 'https://github.com/owner/project.git');
  assert.equal(pushArgs('main', 'a', 'b')[1], 'origin');
});

test('unit:merge-writer-token — exactly one of deployKeyFile and tokenFile is set', async () => {
  assert.throws(() => mergeWriterSettingsSchema.parse({ deployKeyFile: '/k', tokenFile: '/t' }), /not both/);
  assert.deepEqual(mergeWriterSettings({ mergeWriter: { tokenFile: '~/t' } }, 'owner-project', '/home/loop'), { tokenFile: '/home/loop/t', parallel: 3 });
  assert.deepEqual(mergeWriterSettings({ mergeWriter: { deployKeyFile: '/k' } }, 'owner-project', '/home/loop'), { deployKeyFile: '/k', parallel: 3 });
  const home = await temporaryDirectory('merge-token-home');
  assert.ok(mergeWriterSettings({}, 'owner-project', home).deployKeyFile, 'no token file: the deploy key');
  const tokenFile = defaultMergeTokenFile('owner-project', home);
  mkdirSync(join(home, '.config', 'graphyard', 'owner-project'), { recursive: true });
  writeFileSync(tokenFile, TOKEN);
  assert.deepEqual(mergeWriterSettings({}, 'owner-project', home), { tokenFile, parallel: 3 }, 'the install\'s stored token is the credential');
});

test('unit:merge-writer-token — the token file is hidden from trials and masked from confined sessions', () => {
  const environment = { GRAPHYARD_CONFIG_HOME: '/cfg' };
  assert.ok(trialHiddenPaths('/keys/merge-writer.token', environment, 1000).includes('/keys/merge-writer.token'));
  assert.ok(credentialMaskFor({ run: { mergeWriter: { tokenFile: '/keys/merge-writer.token' } } }, {}, '/home/x').extraPaths.includes('/keys/merge-writer.token'));
});

test('unit:merge-writer-token — a token install plans github.merge-token, stores the file, and never records the value', async () => {
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--merge-token-stdin', '--apply']);
    assert.equal(request.mergeToken, true);
    const session = await prepareInstall(fixture.root, request, { ...fixture.deps, mergeToken: TOKEN }, 'apply');
    const plan = await buildPlan(session);
    assert.deepEqual(plan.actions.filter(action => /^github\.(deploy-key|merge-token)$/.test(action.id)).map(action => action.id), ['github.merge-token']);
    const summary = await applyInstall(session, plan);
    const directory = installDirectory('owner-project', fixture.configHome);
    assert.equal(summary.mergeCredential, 'token');
    assert.equal(summary.deployKey, null);
    assert.equal((await stat(join(directory, 'merge-writer.token'))).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(plan).includes(TOKEN) && !JSON.stringify(summary).includes(TOKEN), 'neither the plan nor the summary holds the token');
    assert.ok(!fixture.commandLines().join('\n').includes(TOKEN), 'no command line holds the token');
    assert.equal(fixture.commandLines().filter(line => line.startsWith('gh repo deploy-key')).length, 0, 'no deploy key is registered');
  } finally { await fixture.cleanup(); }
});
