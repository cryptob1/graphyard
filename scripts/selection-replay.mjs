// Replays the affected-test selection over the last merges into main (GY-3192): what the selector
// at this checkout picks for each merge's change against the selector at OLD, in test files and in
// test minutes (the per-file durations of the last recorded timing baseline), and whether any test
// file that later failed on main — in the batch gate or the daily full suite — and that the old
// selector picked is one the new selector skips. Read-only.
//
//   node scripts/selection-replay.mjs [--merges N] [--old REV]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedDeclarations, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from './ci-tests.mjs';

// Test files that failed on main after a merge, as the batch gate and the daily full suite filed them.
export const mainFailures = [
  { file: 'tests/cycle-step-timings.test.ts', at: '2026-10-21T09:47:58Z', item: 'GY-2815' },
  { file: 'tests/model-purity.test.ts', at: '2026-11-05T10:34:08Z', item: 'GY-3138' },
  { file: 'tests/slow-tick-repeat-receipt.test.ts', at: '2026-11-05T23:26:48Z', item: 'GY-3155' },
];

const option = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const git = (...args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1 << 26 });
const count = Number(option('--merges', '120'));
// The old selector: scripts/ci-tests.mjs on main before GY-3192, unless named.
const oldPath = join(mkdtempSync(join(tmpdir(), 'selection-replay-')), 'ci-tests.mjs');
writeFileSync(oldPath, git('show', `${option('--old', '07565b69c72ff83b5cf8179c4ac0bfbb45d53166')}:scripts/ci-tests.mjs`));
const before = await import(pathToFileURL(oldPath).href);

const deleted = git('log', '-1', '--format=%H', '--diff-filter=D', 'HEAD', '--', 'tests/helpers/timing-baseline.json').trim();
const durations = deleted ? JSON.parse(git('show', `${deleted}^:tests/helpers/timing-baseline.json`)).files : {};
const known = Object.values(durations).sort((a, b) => a - b), fallback = known[known.length >> 1] ?? 1000;
const minutes = files => files.reduce((sum, file) => sum + (durations[file] ?? fallback), 0) / 60000;

const tests = listTestFiles(), map = dependencyMap(repositoryRoot, tests), oldMap = before.dependencyMap(repositoryRoot, tests);
const merges = git('log', 'HEAD', '--first-parent', '--merges', '--format=%H %cI %s').trim().split('\n').filter(line => / Merge GY-\d+/.test(line)).slice(0, count);
const rows = merges.map(line => {
  const [sha, at] = line.split(' '), key = line.match(/GY-\d+/)[0];
  const changed = git('diff', '--name-only', '--diff-filter=ACMR', `${sha}^1`, sha).trim().split('\n').filter(Boolean);
  const now = selectAffected(changed, map, tests, changedDeclarations(changed, `${sha}^1`, repositoryRoot, sha)), then = before.selectAffected(changed, oldMap, tests);
  return { key, at, changed: changed.length, now, then };
});

const median = values => [...values].sort((a, b) => a - b)[(values.length - 1) >> 1];
const share = (picked, total) => `${Math.round((100 * picked) / total)}%`;
const totalMinutes = minutes(tests);
for (const [label, pick] of [['old', row => row.then], ['new', row => row.now]]) {
  const files = rows.map(row => pick(row).files.length), spent = rows.map(row => minutes(pick(row).files)), everything = rows.filter(row => pick(row).files.length === tests.length).length;
  console.log(`${label}: ${rows.length} merges, ${tests.length} test files (${totalMinutes.toFixed(1)} test minutes); median ${median(files)} files (${share(median(files), tests.length)}), ${median(spent).toFixed(1)} test minutes (${share(median(spent), totalMinutes)}); p90 ${[...files].sort((a, b) => a - b)[Math.floor((files.length - 1) * 0.9)]} files; ran everything ${everything} (${share(everything, rows.length)})`);
}
const reasons = {};
for (const row of rows.filter(row => row.now.files.length === tests.length)) reasons[row.now.reason.replace(/^\S+ /, '')] = (reasons[row.now.reason.replace(/^\S+ /, '')] ?? 0) + 1;
console.log('new, why everything ran:', reasons);

// AC-3: no lost dependency.
let checked = 0;
const lost = [];
for (const failure of mainFailures) for (const row of rows) {
  if (Date.parse(row.at) >= Date.parse(failure.at) || !row.then.files.includes(failure.file)) continue;
  checked++;
  if (!row.now.files.includes(failure.file)) lost.push(`${row.key} skips ${failure.file} (failed on main, ${failure.item})`);
}
console.log(`lost dependencies: ${lost.length} of ${checked} (merge, later main failure the old selector picked) pairs`);
for (const line of lost) console.log(`  ${line}`);
for (const row of rows.slice(0, 15)) console.log(`${row.key} ${row.changed} changed: old ${row.then.files.length}, new ${row.now.files.length} files (${minutes(row.now.files).toFixed(1)} min)`);
