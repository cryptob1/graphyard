import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitRunnerFor, observeHead } from '../src/merge-writer/local-observation.js';
import { riskDelta, riskOf } from '../src/model/risk-class.js';
import type { Work } from '../src/model/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2082: a control-plane head's risk class reads only its own merge delta. The observation of a
// submitted head once diffed straight against the base tip, so a tip that moved past the head's
// merge base named the base's own new files (an installation change the base merged, say) as the
// head's scope, and the class read them sensitive: queued heads were refused a reviewer and a
// rework round they did not owe. The proof runs the real observeHead over a real repository whose
// base tip advances after the head was cut, and judges the class from what it observes.

const root = () => temporaryDirectory('risk-delta-base-advance');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with a base branch, and a head branch cut at it that changes only its own files. */
async function fixture(own: Record<string, string>) {
  const repo = await root();
  git(repo, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T']]) git(repo, 'config', key, value);
  const commit = async (branch: string, files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
      git(repo, 'add', '--', path);
    }
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', branch);
  };
  await commit('main', { 'src/model/lane.ts': 'export const lane = 0;\n', 'src/install/index.ts': 'export const install = 0;\n' }, 'base');
  git(repo, 'checkout', '-q', '-b', 'graphyard/gy-2082-1', 'main');
  const head = await commit('graphyard/gy-2082-1', own, "the head's own change");
  git(repo, 'checkout', '-q', 'main');
  await commit('main', { 'src/install/adapters.ts': 'export const adapter = 1;\n', 'src/server/routes/health.ts': 'export const health = 1;\n' }, 'the base tip gains an installation change of its own');
  const baseTip = git(repo, 'rev-parse', 'main');
  const observation = await observeHead(gitRunnerFor(repo), { head, base: 'main', branch: 'graphyard/gy-2082-1', author: 'graphyard-cursor-2' });
  const work = {
    candidate: { sha: head, baseSha: baseTip, pr: 0, branch: 'graphyard/gy-2082-1', author: 'graphyard-cursor-2' },
    observation,
  } as unknown as Pick<Work, 'candidate' | 'observation'>;
  return { repo, baseTip, head, observation, work };
}

const ownFiles = (observation: Work['observation']) =>
  [...new Set((observation?.scopeFiles ?? []).map(file => file.path))].sort();

test('unit:risk-delta-ignores-base-advance — a base tip that gains a sensitive commit after a normal-risk head was submitted leaves the head normal: the observed delta names only the files the head adds, and no reason names a file the base gained', async () => {
  const { baseTip, head, observation, work } = await fixture({
    'src/model/policy.ts': 'export const policy = 1;\n',
    'tests/policy.test.ts': "import { test } from 'node:test';\ntest('unit:policy — the policy answers', () => {});\n",
  });
  // The scenario's precondition: the head was cut before the tip moved, so it does not contain it.
  assert.equal(observation.baseTip, baseTip, 'the observation reads the advanced base tip');
  assert.equal(observation.baseTipContained, false, 'the head does not contain the advanced tip');
  // The delta is the head's own merge delta: its two files, never the base's new ones.
  assert.deepEqual(ownFiles(observation), ['src/model/policy.ts', 'tests/policy.test.ts']);
  assert.deepEqual(riskDelta(work).files.map(file => file.path).sort(), ['src/model/policy.ts', 'tests/policy.test.ts']);
  // The class is normal with no reasons: the base's src/install/adapters.ts and health route name nothing.
  assert.deepEqual(riskOf(work), { risk: 'normal', reasons: [], source: 'scope' });
  assert.ok(!head.includes(baseTip), 'the head and the tip are distinct commits');
});

test('unit:risk-delta-keeps-own-sensitive-path — a head whose own merge delta touches a sensitive path stays sensitive after the base advances, and its reason names only that path of its own, never a file the base gained', async () => {
  const { repo, baseTip, observation, work } = await fixture({
    'src/install/index.ts': 'export const install = 1;\n',
    'docs/onboarding.md': '# Onboarding\n',
  });
  assert.equal(observation.baseTipContained, false, 'the head is behind the advanced tip');
  assert.deepEqual(ownFiles(observation), ['docs/onboarding.md', 'src/install/index.ts']);
  const verdict = riskOf(work);
  assert.equal(verdict.risk, 'sensitive');
  assert.deepEqual(verdict.reasons, ['src/install/index.ts: installation']);
  assert.equal(verdict.source, 'scope');
  // The base blob each file is compared against is the base tip's, as a provider observation compares with the bound base.
  const install = observation.scopeFiles!.find(file => file.path === 'src/install/index.ts')!;
  assert.equal(install.baseSha, git(repo, 'rev-parse', `${baseTip}:src/install/index.ts`), 'the base blob is the base tip\'s own version');
});
