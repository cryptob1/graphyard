// Unit contracts. A `unit:*` proof names one protected test file and the exact test titles that
// make up its case inventory. The trusted runner copies that file from the protected checkout
// over the candidate's copy and executes it against the candidate's own source, so a candidate
// can neither narrow nor rename the cases its proof requires; what it can do is fail them.
//
// Unlike an integration contract, the judged code and the judge share a process here: the test
// file imports the candidate's modules. The lane therefore certifies that the protected inventory
// passed against the candidate, not that the candidate could not have interfered with its own test
// process — and the control plane additionally accepts a passing report only from a job GitHub
// reports as successful, so a report rewritten after the runner judged it never publishes.
import { createInventory as createCaseInventory } from './case-inventory.mjs';

/**
 * `cases` maps each case id to the exact title of the test that decides it. Titles are matched
 * verbatim against the TAP stream; a title that never reports is a skipped case.
 */
export function defineUnitContract({ file, cases }) {
  if (typeof file !== 'string' || !/^tests\/[\w.-]+\.test\.ts$/.test(file)) throw new Error(`Unit contract file must be a tests/*.test.ts path: ${file}`);
  const requiredCases = Object.keys(cases);
  if (!requiredCases.length) throw new Error(`Unit contract ${file} declares no cases`);
  return { kind: 'unit', file, titles: { ...cases }, requiredCases, createInventory: () => createCaseInventory(requiredCases) };
}

/** Parse a node:test TAP stream into one result per test title; a directive marks a skipped or todo test. */
export function parseTap(text) {
  const results = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match) continue;
    const [, verdict, title, directive] = match;
    results.set(title, directive ? 'skipped' : verdict === 'ok' ? 'pass' : 'fail');
  }
  return results;
}

/** The fixed inventory judged from the TAP stream: pass, fail, or skipped for a title that never reported. */
export function judgeUnitCases(contract, tap) {
  const results = parseTap(tap);
  return contract.requiredCases.map(id => ({ id, result: results.get(contract.titles[id]) ?? 'skipped' }));
}
