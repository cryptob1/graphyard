// GY-3200: a pnpm workspace with two apps and one shared package linked with workspace:*, and no
// registry dependencies, so its frozen install needs the registry only to fetch pnpm itself.
// Each app's build reads the shared package's built output, so building an app without first
// building its dependency fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const appBuild = `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('built.txt', readFileSync('node_modules/shared/dist/index.txt', 'utf8'));
`;
const app = (name: string) => JSON.stringify({ name, version: '1.0.0', private: true, scripts: { build: 'node build.mjs' }, dependencies: { shared: 'workspace:*' } }, null, 2);
const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  apps/one:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../../packages/shared

  apps/two:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../../packages/shared

  packages/shared: {}
`;

export const pnpmWorkspaceFiles: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'workspace', private: true, packageManager: 'pnpm@10.34.9', scripts: { test: 'node -e 0' } }, null, 2),
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
  'pnpm-lock.yaml': lockfile,
  '.gitignore': 'node_modules\ndist\nbuilt.txt\n',
  'apps/one/package.json': app('one'),
  'apps/one/build.mjs': appBuild,
  'apps/two/package.json': app('two'),
  'apps/two/build.mjs': appBuild,
  'packages/shared/package.json': JSON.stringify({ name: 'shared', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' } }, null, 2),
  'packages/shared/build.mjs': `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.txt', 'shared');\n`,
};

/** Write the workspace's files under `root`, `overrides` replacing or adding any of them. */
export function writePnpmWorkspace(root: string, overrides: Record<string, string> = {}) {
  for (const [path, content] of Object.entries({ ...pnpmWorkspaceFiles, ...overrides })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
