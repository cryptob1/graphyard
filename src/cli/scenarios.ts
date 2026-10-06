import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineCommands } from './registry.js';
import type { CliContext } from './context.js';
import { readCredentialFile } from '../master.js';
import { loadCases, selectCases, syncCases } from '../e2e/case.js';
import { recordRuns, runCases, summarize, type E2eReport } from '../e2e/runner.js';

const e2eUsage = 'Use e2e list | e2e sync | e2e run CASE|--tag TAG|--target uat|--all --url URL [--token-file FILE] [--environment NAME] [--step-timeout SECONDS] [--retries N] [--report FILE] [--no-record] | e2e record REPORT.json';
const switches = new Set(['all', 'no-record']);
/** `--name value` and `--name=value` pairs and bare switches after the subcommand. */
function flags(args: string[]) {
  const values = new Map<string, string>(); const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (name === 'token') throw new Error('An E2E run never takes a token as an argument: set GRAPHYARD_TOKEN or pass --token-file FILE');
    values.set(name, inline ?? (switches.has(name) ? 'true' : args[++index] ?? ''));
  }
  return { positional, one: (name: string) => values.get(name) };
}
const count = (value: string | undefined, name: string, fallback: number, max: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`--${name} is a whole number from 0 to ${max}`);
  return parsed;
};

/** The repository's E2E cases (GY-1351): validate, register, run against a URL, record. */
async function e2e(context: CliContext) {
  const { id: sub, args, api, print } = context;
  const root = context.repositoryRoot();
  const options = flags(args);
  if (sub === 'list') return print((await loadCases(root)).map(entry => ({ id: entry.definition.id, title: entry.definition.title, tags: entry.definition.tags, target: entry.definition.target, file: entry.file, steps: entry.definition.steps.length })));
  if (sub === 'sync') return print(await syncCases(api, await loadCases(root)));
  if (sub === 'record') {
    const file = options.positional[0];
    if (!file) throw new Error(e2eUsage);
    const report: E2eReport = JSON.parse(await readFile(resolve(file), 'utf8'));
    const cases = (await loadCases(root)).filter(entry => report.cases.some(outcome => outcome.id === entry.definition.id));
    const synced = await syncCases(api, cases);
    await recordRuns(api, cases, report);
    print({ synced, recorded: report.cases.map(outcome => ({ id: outcome.id, outcome: outcome.outcome, recorded: outcome.recorded })) });
    if (report.cases.some(outcome => outcome.recorded && 'error' in outcome.recorded)) process.exitCode = 1;
    return;
  }
  if (sub !== 'run') throw new Error(e2eUsage);
  const url = options.one('url');
  if (!url) throw new Error(e2eUsage);
  const target = options.one('target');
  if (target !== undefined && target !== 'uat') throw new Error('--target is uat');
  const selected = selectCases(await loadCases(root), { id: options.positional[0], tag: options.one('tag'), target: target as 'uat' | undefined, all: options.one('all') !== undefined });
  if (!selected.length) throw new Error('No E2E case matches that selection');
  const tokenFile = options.one('token-file');
  const token = tokenFile ? await readCredentialFile(resolve(tokenFile)) : await context.individualToken();
  if (!token) throw new Error('An E2E run needs the target\'s token: set GRAPHYARD_TOKEN or pass --token-file FILE');
  const runId = randomUUID();
  const report = await runCases(selected, { url, token, runId, environment: options.one('environment'),
    stepTimeoutMs: count(options.one('step-timeout'), 'step-timeout', 30, 3600) * 1000, retries: count(options.one('retries'), 'retries', 0, 5) });
  if (options.one('no-record') === undefined) await recordRuns(api, selected, report);
  const out = resolve(options.one('report') ?? join(tmpdir(), `graphyard-e2e-report-${runId}.json`));
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(summarize(report));
  console.log(`Report: ${out}`);
  if (report.failed) process.exitCode = 1;
}

/** The versioned E2E test-case registry. */
export const scenarioCommands = defineCommands([
  {
    name: 'scenarios',
    help: ['  scenarios                    List versioned E2E test-case definitions'],
    run: async ({ api, print }) => print(await api('scenarios')),
  },
  {
    name: 'scenario',
    help: ['  scenario file.json           Publish a scenario version (operator)'],
    run: async ({ id, api, print }) => print(await api('scenarios', JSON.parse(await readFile(id!, 'utf8')))),
  },
  {
    name: 'e2e',
    help: [
      '  e2e list                     Validate and list the E2E cases under e2e/cases/',
      '  e2e sync                     Register each case as a scenario revision (operator)',
      '  e2e run CASE|--tag TAG|--target uat|--all --url URL [--token-file FILE] [--retries N]',
      '          [--step-timeout SECONDS] [--environment NAME] [--report FILE] [--no-record]',
      '                               Run cases against URL with GRAPHYARD_TOKEN or the token file,',
      '                               write a JSON report, record each run; non-zero if any fails',
      '  e2e record REPORT.json       Sync the report\'s cases and record its runs (operator)',
    ],
    run: context => e2e(context),
  },
]);
