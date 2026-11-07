// Replays the affected-test selection over the last merges into main (GY-3192): what the selector
// at this checkout picks for each merge's change against the selector at an older revision, in test
// files and in test minutes (the per-file durations of the last recorded timing baseline), and
// whether a test file that failed on main after a merge — in the batch gate or the daily full suite,
// with that merge its culprit — and that the old selector picked is one the new selector skips.
// Read-only.
//
//   node scripts/selection-replay.mjs [--merges N] [--old REV]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changedDeclarations, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from './ci-tests.mjs';

// Test files that failed on main, as the batch gate and the daily full suite filed them, and the
// merge whose change made them fail (`null`: a flake no change caused).
export const mainFailures = [
  { file: 'tests/cycle-step-timings.test.ts', item: 'GY-2815', culprit: 'GY-1984' },
  { file: 'tests/model-purity.test.ts', item: 'GY-3138', culprit: 'GY-3095' },
  { file: 'tests/slow-tick-repeat-receipt.test.ts', item: 'GY-3155', culprit: null },
];
// The selector on main before GY-3192.
export const oldSelector = '07565b69c72ff83b5cf8179c4ac0bfbb45d53166';

/**
 * The replay over the last `merges` first-parent `Merge GY-` merges of `root`: per merge, the old and
 * the new selection; the summary of each (median files and test minutes, how many ran everything);
 * and `lost`, each culprit merge whose main failure the old selector picked and the new one skips.
 */
export async function replay({ root = repositoryRoot, merges: count = 120, old = oldSelector, failures = mainFailures } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const oldPath = join(mkdtempSync(join(tmpdir(), 'selection-replay-')), 'ci-tests.mjs');
  writeFileSync(oldPath, git('show', `${old}:scripts/ci-tests.mjs`));
  const before = await import(pathToFileURL(oldPath).href);
  const deleted = git('log', '-1', '--format=%H', '--diff-filter=D', 'HEAD', '--', 'tests/helpers/timing-baseline.json').trim();
  const durations = deleted ? JSON.parse(git('show', `${deleted}^:tests/helpers/timing-baseline.json`)).files : {};
  const known = Object.values(durations).sort((a, b) => a - b), fallback = known[known.length >> 1] ?? 1000;
  const minutes = files => files.reduce((sum, file) => sum + (durations[file] ?? fallback), 0) / 60000;

  const tests = listTestFiles(root), map = dependencyMap(root, tests), oldMap = before.dependencyMap(root, tests);
  const rows = git('log', 'HEAD', '--first-parent', '--merges', '--format=%H %s').trim().split('\n').filter(line => / Merge GY-\d+/.test(line)).slice(0, count).map(line => {
    const [sha] = line.split(' '), key = line.match(/GY-\d+/)[0];
    const changed = git('diff', '--name-only', '--diff-filter=ACMR', `${sha}^1`, sha).trim().split('\n').filter(Boolean);
    return { key, changed: changed.length, now: selectAffected(changed, map, tests, changedDeclarations(changed, `${sha}^1`, root, sha)), then: before.selectAffected(changed, oldMap, tests) };
  });
  const median = values => [...values].sort((a, b) => a - b)[(values.length - 1) >> 1];
  const summary = pick => ({
    files: median(rows.map(row => pick(row).files.length)), minutes: median(rows.map(row => minutes(pick(row).files))),
    everything: rows.filter(row => pick(row).files.length === tests.length).length,
  });
  const checks = failures.flatMap(failure => rows.filter(row => row.key === failure.culprit && row.then.files.includes(failure.file)).map(row => ({ ...failure, kept: row.now.files.includes(failure.file) })));
  return { tests: tests.length, totalMinutes: minutes(tests), rows: rows.map(row => ({ ...row, minutes: minutes(row.now.files) })), old: summary(row => row.then), new: summary(row => row.now), checks, lost: checks.filter(check => !check.kept) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
  const result = await replay({ merges: Number(option('--merges', '120')), old: option('--old', oldSelector) });
  const share = (part, whole) => `${Math.round((100 * part) / whole)}%`;
  console.log(`${result.rows.length} merges, ${result.tests} test files, ${result.totalMinutes.toFixed(1)} test minutes in all`);
  for (const label of ['old', 'new']) {
    const { files, minutes, everything } = result[label];
    console.log(`${label}: median ${files} test files (${share(files, result.tests)}), ${minutes.toFixed(1)} test minutes (${share(minutes, result.totalMinutes)}); ran everything ${everything} (${share(everything, result.rows.length)})`);
  }
  for (const failure of mainFailures) {
    const row = result.rows.find(entry => entry.key === failure.culprit);
    console.log(`  ${failure.file} failed on main (${failure.item}): ${!failure.culprit ? 'a flake, no culprit merge' : !row ? `culprit ${failure.culprit} is outside these merges` : `culprit ${failure.culprit} — old ${row.then.files.includes(failure.file) ? 'picks' : 'skips'} it, new ${row.now.files.includes(failure.file) ? 'picks' : 'SKIPS'} it`}`);
  }
  console.log(`lost dependencies: ${result.lost.length} of ${result.checks.length}`);
  for (const row of result.rows) console.log(`${row.key} ${row.changed} changed: old ${row.then.files.length}, new ${row.now.files.length} files (${row.minutes.toFixed(1)} min) ${row.now.mode === 'full' ? row.now.reason : ''}`);
}
