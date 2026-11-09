import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3202: init --scan of a pnpm monorepo lists its workspace packages, the Railway config each app
// deploys from (a root railway-<app>.json or the package's own railway.json), and a node application
// for every package that starts.

test('e2e:onboarding-monorepo-discovery — init --scan lists workspace packages, per-app railway files and node application proposals', async () => {
  const root = await temporaryDirectory('monorepo-discovery');
  try {
    const files: Record<string, string> = {
      '.gitignore': '.graphyard/\n',
      'package.json': JSON.stringify({ name: 'monorepo', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - packages/*\n",
      'apps/web/package.json': JSON.stringify({ name: '@acme/web', scripts: { build: 'next build', start: 'next start' } }),
      'apps/web/railway.json': '{}',
      'apps/pm/package.json': JSON.stringify({ name: '@acme/pm', scripts: { build: 'tsc', start: 'node dist/index.js' } }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', scripts: { build: 'tsc' } }),
      'railway-pm.json': '{}',
    };
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/monorepo.git'], { cwd: root });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GRAPHYARD_') && !key.startsWith('HERDR_')));
    const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '../bin/graphyard.mjs'), 'init', '--scan'], { cwd: root, env });
    const { proposal } = JSON.parse(stdout);

    assert.deepEqual(proposal.workspacePackages, [
      { name: '@acme/pm', directory: 'apps/pm', scripts: { build: 'tsc', start: 'node dist/index.js' } },
      { name: '@acme/web', directory: 'apps/web', scripts: { build: 'next build', start: 'next start' } },
      { name: '@acme/ui', directory: 'packages/ui', scripts: { build: 'tsc' } },
    ]);
    assert.deepEqual(proposal.railway, [
      { app: 'web', file: 'apps/web/railway.json' },
      { app: 'pm', file: 'railway-pm.json' },
    ]);
    assert.deepEqual(proposal.proposedApplications, [
      { id: 'pm', kind: 'node', directory: 'apps/pm', build: 'npm --prefix apps/pm run build', start: 'npm --prefix apps/pm run start' },
      { id: 'web', kind: 'node', directory: 'apps/web', build: 'npm --prefix apps/web run build', start: 'npm --prefix apps/web run start' },
    ]);
    assert.equal(proposal.deploy.target, 'railway', 'per-app railway files make Railway the deploy target');
    assert.deepEqual(proposal.deploy.evidence, ['apps/web/railway.json', 'railway-pm.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
