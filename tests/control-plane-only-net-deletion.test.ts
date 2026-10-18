import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GY-1978 AC-2: making the control plane the only delivery mode removes far more than it adds. The
 * merger command, its install step, the shadow-switch tests and the legacy-merger helper are gone,
 * and when the hotfix commit is in the checkout's history its own diff deletes at least four lines
 * for every line it adds (a shallow CI checkout keeps only the static half).
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const removed = [
  'src/cli/merger.ts', 'src/cli/install-merger.ts', 'tests/helpers/legacy-merger.ts', 'tests/main-write-protection.test.ts',
  'tests/merger-default.test.ts', 'tests/merger-setting.test.ts', 'tests/shadow-attention-after-switch.test.ts', 'tests/soak-shadow-attention-switches.test.ts',
];
const subject = 'Hotfix: the control-plane merger is the only delivery mode';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

test('unit:control-plane-only-net-deletion — the GitHub merger modules and their tests are gone, the merger type admits only control-plane, and the hotfix deletes at least four lines per line added', async () => {
  for (const path of removed) assert.equal(existsSync(join(root, path)), false, `${path} is removed`);
  const mode = await readFile(join(root, 'src/merger-mode.ts'), 'utf8');
  assert.match(mode, /export type MergerMode = 'control-plane';/);
  assert.doesNotMatch(mode, /policy\.merger\.set'/, 'no merger event kind is written or read');
  let sha = '';
  try { sha = git('log', '--format=%H', '-F', `--grep=${subject}`, '-n', '1', 'HEAD'); } catch { sha = ''; }
  if (!sha) return;
  let added = 0, deleted = 0;
  for (const line of git('show', '--numstat', '--format=', sha).split('\n').filter(Boolean)) {
    const [plus, minus] = line.split('\t');
    if (plus !== '-') { added += Number(plus); deleted += Number(minus); }
  }
  assert.ok(deleted >= 4 * added, `the hotfix deletes ${deleted} lines against ${added} added`);
});
