import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GY-1978 AC-2: making the control plane the only delivery mode removes far more than it adds. The
 * merger command, its install step, the shadow-switch tests and the legacy-merger helper are gone.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const removed = [
  'src/cli/merger.ts', 'src/cli/install-merger.ts', 'tests/helpers/legacy-merger.ts', 'tests/main-write-protection.test.ts',
  'tests/merger-default.test.ts', 'tests/merger-setting.test.ts', 'tests/shadow-attention-after-switch.test.ts', 'tests/soak-shadow-attention-switches.test.ts',
];

test('unit:control-plane-only-net-deletion — the GitHub merger modules and their tests are gone and the merger type admits only control-plane', async () => {
  for (const path of removed) assert.equal(existsSync(join(root, path)), false, `${path} is removed`);
  const mode = await readFile(join(root, 'src/merger-mode.ts'), 'utf8');
  assert.match(mode, /export type MergerMode = 'control-plane';/);
  assert.doesNotMatch(mode, /policy\.merger\.set'/, 'no merger event kind is written or read');
});
