import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listTestFiles, repositoryRoot } from '../scripts/ci-tests.mjs';
import { serveStaticSite } from '../src/merge-writer/preview.js';
import { buildStaticSite, projectCaseSuite } from '../src/release-project.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1983 removed release candidates; what merge previews use stays, and the long suites that only
// candidates ran are in the ordinary suite.

test('unit:previews-and-suites-after-candidate-removal — a merge preview still serves a static site and runs the project\'s cases through projectCaseSuite; the soak and timing budgets are ordinary tests; no candidate workflow is left', { timeout: 60_000 }, async () => {
  const root = await temporaryDirectory('previews-after-candidates');
  const write = async (path: string, content: unknown) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content)); };
  const read = (path: string) => ({ kind: 'http', name: `read ${path}`, method: 'GET', path, status: 200, expect: [] });
  await write('site/scores.json', { best: 42 });
  await write('e2e/cases/scores.json', { id: 'scores', title: 'Scores are served', tags: ['api'], target: 'uat', required: true, steps: [{ ...read('/scores.json'), expect: [{ path: 'best', equals: 42 }] }] });
  assert.equal(await buildStaticSite('mkdir -p dist && cp -R site/. dist/', root, 30_000), null, 'the static build passes');
  const sha = 'd'.repeat(40), served = await serveStaticSite(join(root, 'dist'), sha);
  try {
    assert.deepEqual(await (await fetch(`${served.url}/healthz`)).json(), { ok: true, commit: sha });
    const suite = (cases: string) => projectCaseSuite(cases, 'preview-token', { stepTimeoutMs: 5_000, signal: new AbortController().signal, withholdSecrets: true });
    const passing = await suite(root).run(served.url, { id: 'preview' });
    assert.equal(passing.passed, true, passing.detail);
    await write('e2e/cases/missing.json', { id: 'missing', title: 'A page the site lacks', tags: ['api'], target: 'uat', required: true, steps: [read('/missing.json')] });
    const failing = await suite(root).run(served.url, { id: 'preview' });
    assert.equal(failing.passed, false);
    assert.match(failing.detail, /missing/);
  } finally { await served.close(); }

  const affected = execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'affected', 'package.json'], { cwd: repositoryRoot, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  assert.match(affected[0]!, /^full: /);
  assert.deepEqual(affected.slice(1), listTestFiles(), 'the ordinary selection is every test file');
  for (const file of ['tests/soak-merge-writer.test.ts', 'tests/work-snapshot-latency.test.ts', 'tests/server-scale.test.ts', 'tests/healthz-bounded.test.ts'])
    assert.ok(affected.includes(file), `${file} runs in the ordinary suite`);
  const workflowsDir = join(repositoryRoot, '.github/workflows');
  const workflows = existsSync(workflowsDir) ? readdirSync(workflowsDir) : [];
  assert.deepEqual(workflows.filter(name => /release-candidate|soak|deploy-smoke/.test(name)), [], 'no release-candidate, soak or deploy-smoke workflow');
  assert.ok(!workflows.includes('release.yml'), 'no release workflow: installs build the image locally');
});
