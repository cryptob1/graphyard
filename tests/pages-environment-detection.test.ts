import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1954: on the Snake speed test the Pages deploy moved into a workflow file that is not named
// pages-deploy.yml, GitHub recorded the release under the `github-pages` environment, and the
// deployment step still read `production` because detection matched one file name. The name now
// comes from the workflows themselves: a repository whose workflows deploy with actions/deploy-pages
// reads under `github-pages` when neither run.productionEnvironment nor GRAPHYARD_PRODUCTION_ENVIRONMENT
// is set, and an explicit setting or variable still wins over the workflows.
test('unit:pages-environment-detection — a Pages deploy from any workflow file names github-pages, and an explicit setting or variable wins', async () => {
  const { deploymentEnvironmentName } = await import('../src/daemon/deployment.js');
  const config = (productionEnvironment?: string) => ({ run: { productionEnvironment } }) as never;
  const root = await temporaryDirectory('pages-environment-detection');
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  // The deploy lives in a file whose name detection by filename alone never matched.
  await writeFile(join(root, '.github', 'workflows', 'graphyard-delivery.yml'), [
    'name: delivery',
    'on: push',
    'jobs:',
    '  deploy:',
    '    permissions:',
    '      pages: write',
    '    steps:',
    '      - uses: actions/deploy-pages@v4',
    '',
  ].join('\n'));
  assert.equal(deploymentEnvironmentName(config(), root, {}), 'github-pages');
  // An explicitly configured environment, or GRAPHYARD_PRODUCTION_ENVIRONMENT, still wins.
  assert.equal(deploymentEnvironmentName(config('graphyard / production'), root, {}), 'graphyard / production');
  assert.equal(deploymentEnvironmentName(config(), root, { GRAPHYARD_PRODUCTION_ENVIRONMENT: 'prod' }), 'prod');
});
