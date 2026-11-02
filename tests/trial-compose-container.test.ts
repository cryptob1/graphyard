import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { containerTrialE2e, trialContainerWords } from '../src/merge-writer/trial-container.js';
import { defaultChildRun } from '../src/child-runner.js';
import { trialEnvironment, trialHomeVariables } from '../src/merge-writer/trial.js';
import { composeLeftovers, composeProjectPrefix } from '../src/compose-preview.js';

test('Compose bound E2E uses trusted orchestration and private-root case commands with no host mounts', { timeout: 120_000 }, async () => {
  // Nested candidate tests have no engine. The real stack runs at the trusted
  // orchestration boundary; here assert that candidate tests cannot become it.
  if (existsSync('/etc/graphyard-trial')) {
    assert.equal(existsSync('/var/run/docker.sock'), false);
    assert.throws(() => execFileSync('docker', ['info'], { stdio: 'ignore' }), /ENOENT/);
    return;
  }
  const base = await temporaryDirectory('compose-trial', process.cwd());
  const worktree = join(base, 'checkout'), scratch = join(base, 'scratch'), home = join(base, 'home');
  for (const path of [worktree, scratch, home]) await mkdir(path);
  await mkdir(join(worktree, 'e2e/cases'), { recursive: true });
  await writeFile(join(home, 'sentinel'), 'protected');
  const environment = { ...trialEnvironment(), ...trialHomeVariables(scratch), PATH: '/usr/local/bin:/usr/bin:/bin' };
  const compose = (extra = {}) => JSON.stringify({ services: { api: {
    image: 'graphyard-trial:local', command: ['node', '/nested/service/serve.mjs'],
    volumes: ['./serve.mjs:/nested/service/serve.mjs:ro', './content:/nested/content:ro'], secrets: ['fixture'], configs: [{ source: 'inline', target: '/nested/config' }], ...extra,
  } }, secrets: { fixture: { file: './content/body.json' } }, configs: { inline: { content: 'fixture config' } } });
  await mkdir(join(worktree, 'content'));
  await writeFile(join(worktree, 'content/body.json'), '{"message":"compose served"}');
  await writeFile(join(worktree, 'serve.mjs'), `import http from 'node:http'; import fs from 'node:fs';
http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); if (fs.readFileSync('/nested/config', 'utf8') !== 'fixture config') throw new Error('config missing'); if (fs.readFileSync('/run/secrets/fixture', 'utf8') !== fs.readFileSync('/nested/content/body.json', 'utf8')) throw new Error('secret missing'); res.end(fs.readFileSync('/nested/content/body.json')); }).listen(8080, '0.0.0.0');`);
  await writeFile(join(worktree, 'compose.json'), compose());
  await writeFile(join(worktree, 'graphyard.json'), JSON.stringify({ delivery: {
    mode: 'local', applications: [{ id: 'api', kind: 'compose', file: 'compose.json', service: 'api', port: 8080 }], cases: { 'compose-bound': 'api' },
  } }));
  await writeFile(join(worktree, 'e2e/cases/compose-bound.json'), JSON.stringify({
    id: 'compose-bound', title: 'The Compose application answers inside its network', target: 'any', required: false,
    steps: [
      { kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'compose served' }] },
      { kind: 'command', name: 'Private root and writable checkout', run: `node -e 'const fs=require("node:fs"),a=require("node:assert/strict");a.equal(fs.existsSync("/var/run/docker.sock"),false);a.equal(fs.existsSync(${JSON.stringify(join(home, 'sentinel'))}),false);fs.writeFileSync("edited", "allowed")'` },
    ],
  }));
  const git = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  const wrapper = (network = 'bridge') => trialContainerWords([worktree, scratch], [], undefined, network);
  const run = () => containerTrialE2e({ worktree, scratch, mergeSha: git('rev-parse', 'HEAD'), proofs: ['e2e:compose-bound'],
    env: environment, wrapper: wrapper(), networkWrapper: wrapper, budgetMs: 60_000, run: defaultChildRun, log: () => {} });
  const cases = await run();
  assert.deepEqual(cases, [{ proof: 'e2e:compose-bound', case: 'compose-bound', executed: 1, failed: 0 }]);
  assert.equal(await readFile(join(worktree, 'edited'), 'utf8'), 'allowed');
  // The trusted launcher strips binds before engine creation, then copies their
  // checked content. A candidate cannot turn that facility into a host mount.
  for (const extra of [{ privileged: true }, { network_mode: 'host' }, { label_file: [join(home, 'sentinel')] }, { volumes: [home + ':/host'] }, { volumes: ['/var/run/docker.sock:/engine'] }]) {
    await writeFile(join(worktree, 'compose.json'), compose(extra));
    const refused = await run();
    assert.equal(refused[0]?.failed, 1, JSON.stringify(refused));
    assert.match(refused[0]?.failingStep ?? '', /cannot be previewed in isolation/);
  }
  assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'protected');
  const generated = await defaultChildRun('docker', ['ps', '--all', '--format', '{{.Names}}', '--filter', 'label=com.docker.compose.project']);
  assert.equal(generated.split('\n').filter(line => line.startsWith(composeProjectPrefix + 'trial-e2e-api')).length, 0);
  // No project state may survive a successful or refused case.
  const entries = await import('node:fs/promises').then(fs => fs.readdir(scratch));
  for (const entry of entries.filter(name => name.startsWith('compose-'))) {
    const path = join(scratch, entry, 'compose.preview.json');
    if (!existsSync(path)) continue;
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.services.api.secrets, undefined);
    assert.equal(config.services.api.configs, undefined);
    assert.ok(config.services.api.volumes.every((volume: { type: string }) => volume.type !== 'bind'));
    const left = await composeLeftovers(config.name);
    assert.ok(Object.values(left).every(items => items.length === 0), JSON.stringify(left));
  }
});
