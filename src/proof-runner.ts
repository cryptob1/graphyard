// Concern: how a unit or integration proof's cases are counted (GY-3170), one function for the merge trial and `graphyard verify`.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
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
/** A pytest case's name without the parameter suffix a parametrised case carries: `test_unit_report[late]` is `test_unit_report`. */
const pytestName = (name: string) => name.replace(/\[[^\]]*\]$/, '');

export const proofRunnerOutputs = ['tap', 'junit'] as const;
/** One runner a repository declares in graphyard.json `delivery.proofRunners`: the test files it owns, the command that runs them, and the output that carries the counts. */
export const proofRunnerSchema = z.object({
  /** The test files this runner owns, as globs from the repository root (`**`, `*`, `?`). */
  files: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  /** The command, run with `sh -c` in `cwd`: `{files}` becomes the proof's files (relative to `cwd`, quoted), `{report}` the report path for `junit`. */
  command: z.string().trim().min(1).max(500).refine(command => command.includes('{files}'), 'a proof runner command names {files}, where the proof\'s test files go'),
  /** `tap`: the command prints TAP on stdout. `junit`: it writes JUnit XML to `{report}`. */
  output: z.enum(proofRunnerOutputs),
  /** The directory the command runs in, relative to the repository root; the root when absent. */
  cwd: z.string().trim().min(1).max(200).refine(path => !path.startsWith('/') && !path.split('/').includes('..'), 'cwd is a directory inside the repository').optional(),
}).strict().superRefine((runner, context) => {
  if (runner.output === 'junit' && !runner.command.includes('{report}')) context.addIssue({ code: 'custom', path: ['command'], message: 'a junit proof runner command names {report}, where its JUnit XML goes' });
});
export const proofRunnersSchema = z.array(proofRunnerSchema).min(1).max(10);
export type DeclaredProofRunner = z.infer<typeof proofRunnerSchema>;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const entities: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const unescapeXml = (text: string) => text.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (_, name: string) =>
  name[0] === '#' ? String.fromCodePoint(Number(name.slice(1).replace(/^x/i, '0x'))) : entities[name]!);

/** `declared` is a runner graphyard.json names: its JUnit cases are matched either way. */
export type ProofRunnerName = 'vitest' | 'pytest' | 'declared';
export interface JunitCase { name: string; failed: boolean; skipped: boolean }
/** The test cases of a JUnit report, as vitest's and pytest's reporters write them. */
export const junitCases = (xml: string): JunitCase[] => [...xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, attributes, body = '']) => ({
  name: unescapeXml(/\bname="([^"]*)"/.exec(attributes!)?.[1] ?? ''), failed: /<(failure|error)\b/.test(body), skipped: /<skipped\b/.test(body),
}));

/** A JUnit case proves `proof` as a TAP title does (vitest prefixes a nested case with its suites, ` > ` between them), or, in pytest, by its exact name, with or without a parameter suffix. */
export function countJunitCases(cases: readonly JunitCase[], proof: string, runner: ProofRunnerName) {
  const title = proofTitle(proof), named = pytestCase(proof);
  let executed = 0, failed = 0, skipped = 0;
  for (const entry of cases) {
    const byName = pytestName(entry.name) === named, byTitle = entry.name.split(' > ').some(part => title.test(part));
    if (!(runner === 'pytest' ? byName : runner === 'vitest' ? byTitle : byName || byTitle)) continue;
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
  /** Runs a test runner in `root` and answers its stdout; a runner that exits non-zero resolves, its report answers. */
  runner: (command: string, args: string[]) => Promise<unknown>;
  git: ChildRun;
}

/** A runner as countByRunner runs it: the files it owns, how a proof's files are found, and the command that runs them. */
interface RunnerSpec {
  name: ProofRunnerName;
  output: 'tap' | 'junit';
  /** git pathspecs of the files it owns. */
  paths: string[];
  word: boolean;
  needles: (proof: string) => string[];
  invoke: (report: string, files: string[]) => { command: string; args: string[] };
}

/** A declared glob as a git pathspec: `**` any directories, `*` within one segment. */
const declaredSpec = ({ files, command, output, cwd }: DeclaredProofRunner): RunnerSpec => ({
  name: 'declared', output, paths: files.map(glob => `:(glob)${glob}`), word: output === 'junit',
  needles: proof => output === 'junit' ? [proof, pytestCase(proof)] : [proof],
  invoke: (report, named) => {
    const relative = named.map(file => cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file);
    return { command: 'sh', args: ['-c', `cd ${shellQuote(cwd ?? '.')} && ${command.replaceAll('{files}', relative.map(shellQuote).join(' ')).replaceAll('{report}', shellQuote(report))}`] };
  },
});

/**
 * The cases of `proofs` by the repository's own runner: the runners graphyard.json
 * `delivery.proofRunners` declares, else vitest when package.json declares it and pytest when a
 * Python file defines tests. Each runs once, over the files that name a proof, and every count comes
 * from its JUnit report (or, for a declared `tap` runner, its stdout). A repository with no runner
 * answers nothing, so its TAP counts stand; a proof with no count carries the reason.
 */
export async function countByRunner({ root, proofs, scratch, runner, git }: ProofRunnerInput): Promise<Record<string, RunnerCount>> {
  const grep = async (patterns: string[], paths: string[], word = false) => {
    try { return String(await git('git', ['-C', root, 'grep', '-l', '--untracked', ...(word ? ['-w'] : []), '-F', ...patterns.flatMap(pattern => ['-e', pattern]), '--', ...paths, ':(exclude).graphyard'])).split('\n').filter(Boolean); }
    catch (error) { if ((error as { status?: number | null }).status === 1) return []; throw error; }
  };
  const failAll = (reason: string): Record<string, RunnerCount> => Object.fromEntries(proofs.map(proof => [proof, { executed: 0, failed: 0, skipped: 0, files: [], reason }]));
  const declared = await readFile(join(root, 'graphyard.json'), 'utf8').then(text => JSON.parse(text)?.delivery?.proofRunners as unknown).catch(() => undefined);
  let runners: RunnerSpec[];
  if (declared !== undefined && declared !== null) {
    const parsed = proofRunnersSchema.safeParse(declared);
    if (!parsed.success) return failAll(`graphyard.json delivery.proofRunners does not parse: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'proofRunners'}: ${issue.message}`).join('; ')}`);
    runners = parsed.data.map(declaredSpec);
  } else {
    const vitest = await readFile(join(root, 'package.json'), 'utf8').then(text => Boolean(JSON.parse(text)?.devDependencies?.vitest)).catch(() => false);
    runners = [
      ...(vitest ? [{ name: 'vitest' as const, output: 'junit' as const, paths: ['*.test.*', '*.spec.*'], word: false, needles: (proof: string) => [proof], invoke: (report: string, files: string[]) => ({ command: 'npx', args: ['vitest', 'run', '--reporter=junit', `--outputFile=${report}`, ...files] }) }] : []),
      ...((await grep(['def test_'], ['*.py'])).length ? [{ name: 'pytest' as const, output: 'junit' as const, paths: ['*.py'], word: true, needles: (proof: string) => [pytestCase(proof)], invoke: (report: string, files: string[]) => ({ command: 'python', args: ['-m', 'pytest', `--junitxml=${report}`, ...files] }) }] : []),
    ];
  }
  if (!runners.length) return {};
  const counts: Record<string, RunnerCount> = Object.fromEntries(proofs.map(proof => [proof, { executed: 0, failed: 0, skipped: 0, files: [], reason: 'no test file names it' }]));
  for (const [index, { name, output, paths, word, needles, invoke }] of runners.entries()) {
    const named = (await Promise.all(proofs.map(async proof => [proof, await grep(needles(proof), paths, word)] as const))).filter(([, files]) => files.length);
    if (!named.length) continue;
    const report = join(scratch, `${name}-${index}-report.xml`), files = [...new Set(named.flatMap(([, files]) => files))];
    const { command, args } = invoke(report, files);
    const stdout = String(await runner(command, args) ?? '');
    const xml = output === 'junit' ? await readFile(report, 'utf8').catch(() => null) : null, cases = xml?.includes('<testsuite') ? junitCases(xml) : null;
    for (const [proof, proofFiles] of named) {
      const seen = counts[proof]!, found = output === 'tap' ? countProofCases(stdout, proof) : countJunitCases(cases ?? [], proof, name);
      const executed = seen.executed + found.executed, failed = seen.failed + found.failed, skipped = seen.skipped + found.skipped;
      counts[proof] = { executed, failed, skipped, files: [...seen.files, ...proofFiles], ...(executed || skipped ? {} : { reason: output === 'tap' || cases ? 'its files hold no case titled with it' : 'the runner ended abnormally' }) };
    }
  }
  return counts;
}
