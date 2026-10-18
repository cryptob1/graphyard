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
 *
 * GY-2012: the pin is the commit whose subject is exactly the hotfix subject. A body-matching
 * `git log -F --grep -n 1` selected merge 9bc46db8f4e8 (PR #1347 cites the subject in its body);
 * that merge's first-parent diff fails the 4× ratio even though the hotfix itself passes it.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const removed = [
  'src/cli/merger.ts', 'src/cli/install-merger.ts', 'tests/helpers/legacy-merger.ts', 'tests/main-write-protection.test.ts',
  'tests/merger-default.test.ts', 'tests/merger-setting.test.ts', 'tests/shadow-attention-after-switch.test.ts', 'tests/soak-shadow-attention-switches.test.ts',
];
const subject = 'Hotfix: the control-plane merger is the only delivery mode';
/** The merge that landed GY-1978: its body cites `subject`, so a body-matching grep selected it at this tip. */
const mergeCitingSubject = '9bc46db8f4e8509e11f06ebf64e4bc79f5423ff0';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Lines added and deleted by `git show --numstat` for one commit (binary files skipped). */
function numstat(sha: string): { added: number; deleted: number } {
  let added = 0, deleted = 0;
  for (const line of git('show', '--numstat', '--format=', sha).split('\n').filter(Boolean)) {
    const [plus, minus] = line.split('\t');
    if (plus !== '-') { added += Number(plus); deleted += Number(minus); }
  }
  return { added, deleted };
}

/** The newest commit whose subject is exactly `subject`, or '' when history does not carry it. */
function hotfixSha(): string {
  try {
    for (const line of git('log', '--format=%H%x00%s', '-F', `--grep=${subject}`, 'HEAD').split('\n').filter(Boolean)) {
      const nul = line.indexOf('\0');
      if (nul >= 0 && line.slice(nul + 1) === subject) return line.slice(0, nul);
    }
  } catch { /* empty history or shallow clone without the commit */ }
  return '';
}

test('unit:control-plane-only-net-deletion — the GitHub merger modules and their tests are gone, the merger type admits only control-plane, and the hotfix deletes at least four lines per line added', async () => {
  for (const path of removed) assert.equal(existsSync(join(root, path)), false, `${path} is removed`);
  const mode = await readFile(join(root, 'src/merger-mode.ts'), 'utf8');
  assert.match(mode, /export type MergerMode = 'control-plane';/);
  assert.doesNotMatch(mode, /policy\.merger\.set'/, 'no merger event kind is written or read');
  const sha = hotfixSha();
  if (!sha) return;
  const { added, deleted } = numstat(sha);
  assert.ok(deleted >= 4 * added, `the hotfix deletes ${deleted} lines against ${added} added`);
});

test('unit:control-plane-only-net-deletion-merge-body-grep — against 9bc46db8f4e8 a body-matching grep selected the merge whose first-parent diff fails the 4× pin; the hotfix is the commit whose subject equals the pin', () => {
  // Reproduce the pre-fix lookup at the broken tip: -F --grep -n 1 matches the merge body and
  // measures that merge's first-parent diff, which fails the 4× ratio the hotfix itself meets.
  const naive = git('log', '--format=%H', '-F', `--grep=${subject}`, '-n', '1', mergeCitingSubject);
  assert.equal(naive, mergeCitingSubject, 'at 9bc46db8f4e8 body-matching -n 1 selects the merge');
  assert.notEqual(git('log', '-1', '--format=%s', naive), subject, 'the merge subject is not the hotfix pin');
  assert.match(git('log', '-1', '--format=%B', naive), new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const merge = numstat(naive);
  assert.ok(merge.deleted < 4 * merge.added, `at ${mergeCitingSubject.slice(0, 12)} the merge deletes ${merge.deleted} against ${merge.added} added — under 4×`);
  const sha = hotfixSha();
  assert.ok(sha && sha !== naive, 'exact subject is a different commit from the body-matching merge');
  assert.equal(git('log', '-1', '--format=%s', sha), subject);
  const hotfix = numstat(sha);
  assert.ok(hotfix.deleted >= 4 * hotfix.added, `the hotfix deletes ${hotfix.deleted} lines against ${hotfix.added} added`);
});
