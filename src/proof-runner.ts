// Concern: how a unit or integration proof's cases are counted (GY-3170), one function for the merge trial and `graphyard verify`.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from './child-runner.js';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A proof's cases are the ones whose title is the proof id, alone or followed by a space. */
export const proofTitle = (proof: string) => new RegExp(`^${escape(proof)}(\\s|$)`);

/** The proof's cases in a TAP stream, attributed by title prefix. */
export function countProofCases(tap: string, proof: string) {
  const title = proofTitle(proof);
  let executed = 0, failed = 0, skipped = 0;
  for (const line of tap.split('\n')) {
    const match = line.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!match || !title.test(match[2]!)) continue;
    if (match[3]) skipped++; else { executed++; if (match[1] === 'not ok') failed++; }
  }
  return { executed, failed, skipped };
}

/** The one pytest function that proves `proof`: `unit:report` is `test_unit_report`, and `test_unit_report_ready` is another proof's. */
export const pytestCase = (proof: string) => `test_${proof.replace(/\W/g, '_')}`;

const entities: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const unescapeXml = (text: string) => text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (_, name: string) =>
  name[0] === '#' ? String.fromCodePoint(Number(name.slice(1).replace(/^x/i, '0x'))) : entities[name]!);

export type ProofRunnerName = 'vitest' | 'pytest';
export interface JunitCase { name: string; failed: boolean; skipped: boolean }
/** The test cases of a JUnit report, as vitest's and pytest's reporters write them. */
export const junitCases = (xml: string): JunitCase[] => [...xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, attributes, body = '']) => ({
  name: unescapeXml(/\bname="([^"]*)"/.exec(attributes!)?.[1] ?? ''), failed: /<(failure|error)\b/.test(body), skipped: /<skipped\b/.test(body),
}));

/** A JUnit case proves `proof` as a TAP title does (vitest prefixes a nested case with its suites, ` > ` between them), or, in pytest, by its exact name. */
export function countJunitCases(cases: readonly JunitCase[], proof: string, runner: ProofRunnerName) {
  const title = proofTitle(proof), named = pytestCase(proof);
  let executed = 0, failed = 0, skipped = 0;
  for (const entry of cases) {
    if (!(runner === 'pytest' ? entry.name === named : entry.name.split(' > ').some(part => title.test(part)))) continue;
    if (entry.skipped) skipped++; else { executed++; if (entry.failed) failed++; }
  }
  return { executed, failed, skipped };
}

export interface RunnerCount { executed: number; failed: number; skipped: number; files: string[]; reason?: string }
export interface ProofRunnerInput {
  /** The tree the proofs run in. */
  root: string;
  proofs: readonly string[];
  /** A directory the runner may write its report in. */
  scratch: string;
  /** Runs a test runner in `root`; a runner that exits non-zero resolves, its report answers. */
  runner: (command: string, args: string[]) => Promise<unknown>;
  git: ChildRun;
}

/**
 * The cases of `proofs` by the repository's own runner: vitest when package.json declares it,
 * pytest when a Python file defines tests. Each runs once, over the files that name a proof, and
 * every count comes from its JUnit report. A repository with neither answers nothing, so its TAP
 * counts stand; a proof with no count carries the reason.
 */
export async function countByRunner({ root, proofs, scratch, runner, git }: ProofRunnerInput): Promise<Record<string, RunnerCount>> {
  const grep = async (patterns: string[], paths: string[], word = false) => {
    try { return String(await git('git', ['-C', root, 'grep', '-l', '--untracked', ...(word ? ['-w'] : []), '-F', ...patterns.flatMap(pattern => ['-e', pattern]), '--', ...paths, ':(exclude).graphyard'])).split('\n').filter(Boolean); }
    catch (error) { if ((error as { status?: number | null }).status === 1) return []; throw error; }
  };
  const vitest = await readFile(join(root, 'package.json'), 'utf8').then(text => Boolean(JSON.parse(text)?.devDependencies?.vitest)).catch(() => false);
  const runners = [
    ...(vitest ? [{ name: 'vitest' as const, paths: ['*.test.*', '*.spec.*'], word: false, needle: (proof: string) => proof, command: 'npx', args: (report: string) => ['vitest', 'run', '--reporter=junit', `--outputFile=${report}`] }] : []),
    ...((await grep(['def test_'], ['*.py'])).length ? [{ name: 'pytest' as const, paths: ['*.py'], word: true, needle: pytestCase, command: 'python', args: (report: string) => ['-m', 'pytest', `--junitxml=${report}`] }] : []),
  ];
  if (!runners.length) return {};
  const counts: Record<string, RunnerCount> = Object.fromEntries(proofs.map(proof => [proof, { executed: 0, failed: 0, skipped: 0, files: [], reason: 'no test file names it' }]));
  for (const { name, paths, word, needle, command, args } of runners) {
    const named = (await Promise.all(proofs.map(async proof => [proof, await grep([needle(proof)], paths, word)] as const))).filter(([, files]) => files.length);
    if (!named.length) continue;
    const report = join(scratch, `${name}-report.xml`), files = [...new Set(named.flatMap(([, files]) => files))];
    await runner(command, [...args(report), ...files]);
    const xml = await readFile(report, 'utf8').catch(() => null), cases = xml?.includes('<testsuite') ? junitCases(xml) : null;
    for (const [proof, proofFiles] of named) {
      const seen = counts[proof]!, found = countJunitCases(cases ?? [], proof, name);
      const executed = seen.executed + found.executed, failed = seen.failed + found.failed, skipped = seen.skipped + found.skipped;
      counts[proof] = { executed, failed, skipped, files: [...seen.files, ...proofFiles], ...(executed || skipped ? {} : { reason: cases ? 'its files hold no case titled with it' : 'the runner ended abnormally' }) };
    }
  }
  return counts;
}
