// One authoritative home per rule. A rule restated on a second page drifts from the first, so
// this reports every normative sentence that two pages say in nearly the same words: the pair,
// the similarity and where each copy lives. The fix is to keep one copy and link to it.
//
// `node scripts/docs-duplication.mjs` prints the duplicates and exits non-zero when any pair is
// at or above the threshold; `--json` prints the same report for a test to assert on.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusPaths } from './docs-budget.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** How alike two sentences may be before one of them is a restatement. */
export const threshold = 0.75;
/** Shorter sentences repeat legitimately ("Terms follow the glossary."), so only these are compared. */
export const minimumWords = 12;
/** A sentence states a rule when it says what must, may, may not or never happens. */
export const normative = /\b(must|may|cannot|can(?:not)? only|never|always|only|shall|needs?|refuses?|refused|requires?|required|authoriz|allowed|forbidden|recorded|refusal)\b/i;

/**
 * Prose sentences of one page: no code fences, tables, headings, comments or link targets.
 * The managed `AGENTS.md` blocks are excluded because they are rendered by `graphyard init`
 * and `master init` from templates in `src/`, for repositories that do not carry these guides;
 * `tests/master-verification.test.ts` requires them to restate the coordination loop, so they
 * are a generated copy rather than a second authoritative home.
 */
export function sentences(text) {
  const prose = text
    .replace(/<!-- graphyard(?:-master)? -->[\s\S]*?<!-- \/graphyard(?:-master)? -->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n')
    .filter(line => !/^\s*[|#]/.test(line))
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return prose.split(/(?<=[.:!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
}

/** The comparable shape of a sentence: lowercase words, no markup, no punctuation. */
export function words(sentence) {
  return sentence.toLowerCase().replace(/[`*_>]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Jaccard similarity over word bigrams, which ignores reordering but not rewording. */
export function similarity(a, b) {
  const shingles = list => new Set(list.slice(0, -1).map((word, index) => `${word} ${list[index + 1]}`));
  const [left, right] = [shingles(a), shingles(b)];
  const shared = [...left].filter(entry => right.has(entry)).length;
  const union = new Set([...left, ...right]).size;
  return union ? shared / union : 0;
}

export function duplicates(root = repositoryRoot) {
  const candidates = [];
  for (const path of corpusPaths(root)) {
    for (const sentence of sentences(readFileSync(join(root, path), 'utf8'))) {
      const tokens = words(sentence);
      if (tokens.length >= minimumWords && normative.test(sentence)) candidates.push({ path, sentence, tokens });
    }
  }
  const found = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (candidates[i].path === candidates[j].path) continue;
      const score = similarity(candidates[i].tokens, candidates[j].tokens);
      if (score >= threshold) found.push({ score: Math.round(score * 100) / 100, pages: [candidates[i].path, candidates[j].path], sentences: [candidates[i].sentence, candidates[j].sentence] });
    }
  }
  return { threshold, minimumWords, compared: candidates.length, duplicates: found.sort((a, b) => b.score - a.score) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = duplicates();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else for (const entry of report.duplicates) console.error(`${entry.score} ${entry.pages[0]} / ${entry.pages[1]}\n  ${entry.sentences[0]}\n  ${entry.sentences[1]}`);
  console.log(`${report.compared} normative sentences compared, ${report.duplicates.length} restated across pages`);
  process.exit(report.duplicates.length ? 1 : 0);
}
