// The documentation word budget. Length is a defect in guides that are read under time
// pressure, so the total and the per-page size are measured and enforced like any other
// contract: `node scripts/docs-budget.mjs` prints the counts and exits non-zero above a
// limit, `--json` prints the same report for a test to assert on.
//
// The corpus is AGENTS.md plus every Markdown page under docs/ (docs/protocol/ and
// docs/history/ included) — the pages GY-80 measured at 109,374 words.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const budget = { total: 32_800, page: 2_500, baseline: 109_374 };

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function markdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = join(directory, entry.name);
    return entry.isDirectory() ? markdown(target) : entry.name.endsWith('.md') ? [target] : [];
  });
}

/** Every page the budget covers, as repository-relative paths in a stable order. */
export function corpusPaths(root = repositoryRoot) {
  return ['AGENTS.md', ...markdown(join(root, 'docs')).map(path => relative(root, path)).sort()];
}

/**
 * A word is a whitespace-separated token of the file, exactly as `wc -w` counts one. The
 * baseline above was measured that way, so code samples, tables and prose are all counted
 * and no page can buy budget by moving prose into a fence.
 */
export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

export function measure(root = repositoryRoot) {
  const pages = corpusPaths(root).map(path => ({ path, words: countWords(readFileSync(join(root, path), 'utf8')) }));
  const total = pages.reduce((sum, page) => sum + page.words, 0);
  const oversized = pages.filter(page => page.words > budget.page);
  return {
    budget, total, pages: pages.slice().sort((a, b) => b.words - a.words), oversized,
    reduction: Math.round((1 - total / budget.baseline) * 1000) / 10,
    failures: [
      ...(total > budget.total ? [`Documentation is ${total} words; the budget is ${budget.total}`] : []),
      ...oversized.map(page => `${page.path} is ${page.words} words; no page may exceed ${budget.page}`),
    ],
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = measure();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const page of report.pages) console.log(`${String(page.words).padStart(6)}  ${page.path}`);
    console.log(`${String(report.total).padStart(6)}  total (budget ${budget.total}, baseline ${budget.baseline}, ${report.reduction}% smaller)`);
  }
  for (const failure of report.failures) console.error(failure);
  process.exit(report.failures.length ? 1 : 0);
}
