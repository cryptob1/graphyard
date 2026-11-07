// What a worker runs before complete (GY-3139): the tests scripts/ci-tests.mjs selects for the files
// this checkout changes against its merge-base with origin/main — committed, uncommitted and
// untracked — plus the test files named as arguments (the item's bound proof test files), through
// the suite's own runner. The merge writer's trial runs the same selection; `npm test` stays for
// whole-suite runs by hand.
//
//   npm run test:affected -- tests/a.test.ts tests/b.test.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedDeclarations, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from './ci-tests.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const lines = text => text.split('\n').filter(Boolean);

const mergeBaseOf = (root, base) => { try { return git(root, ['merge-base', 'HEAD', `refs/remotes/origin/${base}`]).trim(); } catch { return null; } };

/** The files changed against the merge-base with origin/`base`, or null when there is no such base. */
export function changedFiles(root = repositoryRoot, base = 'main') {
  const mergeBase = mergeBaseOf(root, base);
  if (!mergeBase) return null;
  return [...new Set([...lines(git(root, ['diff', '--name-only', '--no-renames', mergeBase])), ...lines(git(root, ['ls-files', '--others', '--exclude-standard']))])].sort();
}

/** The selection for this checkout's changes, narrowed to the declarations they touch, with the named test files appended. */
export function affectedTests(root = repositoryRoot, extra = []) {
  const tests = listTestFiles(root), changed = changedFiles(root), mergeBase = mergeBaseOf(root, 'main');
  const selection = selectAffected(changed, dependencyMap(root, tests), tests, changed && mergeBase ? changedDeclarations(changed, mergeBase, root) : undefined);
  return { ...selection, files: [...new Set([...selection.files, ...extra])] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selection = affectedTests(repositoryRoot, process.argv.slice(2));
  console.log(`${selection.mode}: ${selection.reason}${selection.files.length ? `; running ${selection.files.length} test file(s)` : '; no tests to run'}`);
  if (selection.files.length) {
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/run-tests.ts', ...selection.files], { cwd: repositoryRoot, stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  }
}
