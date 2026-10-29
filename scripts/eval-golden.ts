// The golden eval (GY-2970): a fixed set of ten golden items replayed against one Graphyard
// release, twice, on a scratch install — and, between two releases, which items flipped.
//
//   node --import tsx scripts/eval-golden.ts --release SHA --runs 2 --repo OWNER/SCRATCH-REPO [--port N] [--bound-minutes 90]
//   node --import tsx scripts/eval-golden.ts --compare eval/results/OLD.json eval/results/NEW.json
//
// It spends fleet time and runs by hand: not part of npm test or the merge trial.
// docs/development.md tells when to run it and how to read a flip.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { configHome, e2ePrincipalId, installDirectory, readToken } from '../src/install/secrets.js';
import { installIdFor } from '../src/install/types.js';

/** What a run measured for one item: how it ended, what it cost, how long it took. */
export type GoldenOutcome = 'done' | 'blocked' | 'timed out';

/** One golden item, as `eval/golden/<name>/item.json` records it beside its `scaffold.tar`. */
export interface GoldenItem {
  name: string;
  title: string;
  description: string;
  type: 'feature' | 'bug' | 'chore';
  priority: number;
  criteria: { id: string; text: string; proofs: string[] }[];
}

/** One row of a result file: one item in one run. */
export interface GoldenRow {
  item: string;
  run: number;
  outcome: GoldenOutcome;
  attempts: number;
  reworkRounds: number;
  minutes: number;
  tokens?: number;
}

/** What settling one filed item measured; the row keeps the item and run beside it. */
export interface SettledRow { outcome: GoldenOutcome; attempts: number; reworkRounds: number; minutes: number; tokens?: number }

export interface GoldenResult {
  release: string;
  runs: number;
  rows: GoldenRow[];
}

/** A filed item's handle: the control plane's id and key. */
export interface Filed { key: string; id: string }

/**
 * The install the planning step drives. The compose scratch install below implements it over the
 * control-plane API; a test drives the step with a fake.
 */
export interface GoldenInstall {
  /** File one golden item against its own fresh scaffold copy and release it to the loop. */
  file(item: GoldenItem, scaffold: string, run: number): Promise<Filed>;
  /** Wait for the filed item up to `boundMs`, then read what the run measured. */
  settle(filed: Filed, boundMs: number): Promise<SettledRow>;
  /** Remove the scratch install, whatever the outcome was. */
  dispose(): Promise<void>;
}

/** The eval/golden directory this script ships. */
export const goldenDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '../eval/golden');

/** Where a hand run writes its result files. */
export const resultsDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '../eval/results');

/** The ten golden items of `dir`, in their directory-name order, each named by its directory. */
export async function loadGoldenItems(dir: string = goldenDir()): Promise<GoldenItem[]> {
  const names = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return Promise.all(names.map(async name => ({ name, ...JSON.parse(await readFile(join(dir, name, 'item.json'), 'utf8')) })));
}

/** Extract one item's scaffold tarball into `into`, an empty directory of its own, and return it. */
export async function extractScaffold(tarball: string, into: string): Promise<string> {
  await mkdir(into, { recursive: true });
  await new Promise<void>((pass, fail) => execFile('tar', ['-xf', tarball, '-C', into], error =>
    error ? fail(new Error(`scaffold ${tarball} did not extract: ${error.message}`)) : pass()));
  return into;
}

export interface PlanInput {
  /** The release the install serves, named in the result file. */
  release: string;
  runs: number;
  /** How long one item may take before its run reads as timed out. */
  boundMs: number;
  goldenDir: string;
  /** Where the run's fresh scaffold copies are extracted; removed with the install. */
  scratch: string;
  resultsPath: string;
}

/**
 * The eval script's planning step: file every golden item once per run against a fresh copy of
 * its own scaffold, settle each within the bound, and write the result file — one row per item
 * per run. The scratch install is disposed and the scaffold copies taken away whatever the
 * outcome; the result file is written only of a completed pass.
 */
export async function plan(install: GoldenInstall, input: PlanInput): Promise<GoldenResult> {
  const items = await loadGoldenItems(input.goldenDir);
  const rows: GoldenRow[] = [];
  try {
    for (let run = 1; run <= input.runs; run++) {
      for (const item of items) {
        const scaffold = await extractScaffold(join(input.goldenDir, item.name, 'scaffold.tar'), join(input.scratch, `${item.name}-run-${run}`));
        const filed = await install.file(item, scaffold, run);
        rows.push({ item: item.name, run, ...(await install.settle(filed, input.boundMs)) });
      }
    }
  } finally {
    await install.dispose();
    await rm(input.scratch, { recursive: true, force: true });
  }
  const result: GoldenResult = { release: input.release, runs: input.runs, rows };
  await mkdir(dirname(input.resultsPath), { recursive: true });
  await writeFile(input.resultsPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Read one written result file back. */
export async function readResult(path: string): Promise<GoldenResult> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * What changed between two result files: one line per flipped row — its outcome left done or
 * reached it, or its attempts moved by more than one — before the totals. Unchanged rows are
 * named nowhere.
 */
export function compare(a: GoldenResult, b: GoldenResult): string {
  const byItem = (result: GoldenResult) => {
    const items = new Map<string, Map<number, GoldenRow>>();
    for (const row of result.rows) {
      if (!items.has(row.item)) items.set(row.item, new Map());
      items.get(row.item)!.set(row.run, row);
    }
    return items;
  };
  const left = byItem(a), right = byItem(b);
  const lines: string[] = [];
  let compared = 0;
  for (const item of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const runs = [...new Set([...(left.get(item)?.keys() ?? []), ...(right.get(item)?.keys() ?? [])])].sort((x, y) => x - y);
    for (const run of runs) {
      const row = left.get(item)?.get(run), other = right.get(item)?.get(run);
      if (!row || !other) continue;
      compared++;
      if ((row.outcome === 'done') !== (other.outcome === 'done') || Math.abs(row.attempts - other.attempts) > 1)
        lines.push(`  ${item} run ${run}: ${row.outcome} → ${other.outcome} (attempts ${row.attempts} → ${other.attempts})`);
    }
  }
  const totals = (result: GoldenResult) => (['done', 'blocked', 'timed out'] as const)
    .map(outcome => `${result.rows.filter(row => row.outcome === outcome).length} ${outcome}`).join(', ');
  return [
    ...(lines.length ? ['flipped:', ...lines] : ['flipped: none']),
    `totals: ${a.release} ${totals(a)} — ${b.release} ${totals(b)}; ${lines.length} of ${compared} rows flipped`,
  ].join('\n');
}

const composeFile = (directory: string) => join(directory, 'compose', 'compose.yaml');
const pollMs = 15_000;
/** Claim→end minutes, to one decimal; an end that never came reads as zero. */
const minutesBetween = (from: string | null | undefined, to: string | null | undefined) =>
  from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 6_000) / 10 : 0;

/**
 * The scratch install a hand run creates: one compose-provider install of `repository` with its
 * own port and Herdr instance, filed items go to over the control-plane API, and everything it
 * owns — containers, volumes, credentials — is taken down by `dispose` whatever the outcome.
 */
export class ComposeScratchInstall implements GoldenInstall {
  readonly directory: string;
  readonly base: string;

  constructor(readonly input: { repository: string; port: number; sourceRoot: string; cliPath?: string }) {
    this.directory = installDirectory(installIdFor(input.repository), configHome());
    this.base = `http://127.0.0.1:${input.port}`;
  }

  /** Bring the scratch install up. Its loop (`graphyard master run` against it) releases and dispatches what `file` files. */
  async up(): Promise<this> {
    const cli = this.input.cliPath ?? resolve(dirname(fileURLToPath(import.meta.url)), '../bin/graphyard.mjs');
    await new Promise<void>((pass, fail) => {
      const child = spawn(process.execPath, [cli, 'install', '--provider', 'compose', '--repo', this.input.repository, '--herdr-instance',
        '--port', String(this.input.port), '--apply', '--source-root', this.input.sourceRoot], { stdio: 'inherit' });
      child.on('error', fail);
      child.on('exit', code => code === 0 ? pass() : fail(new Error(`graphyard install --apply exited ${code}`)));
    });
    return this;
  }

  private principal() {
    return e2ePrincipalId(installIdFor(this.input.repository));
  }

  private async request(path: string, body?: unknown, key: string = randomUUID()): Promise<any> {
    const principal = this.principal();
    const token = await readToken(this.directory, principal);
    if (!token) throw new Error(`The scratch install holds no credential for ${principal} at ${join(this.directory, 'tokens')}: run --apply first`);
    const response = await fetch(`${this.base}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answered = await response.json();
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(answered)}`);
    return answered;
  }

  async file(item: GoldenItem, scaffold: string, run: number): Promise<Filed> {
    const work = await this.request('work', {
      title: item.title,
      description: `${item.description}\n\nGolden eval ${item.name} run ${run}: this run's fresh scaffold copy stands at ${scaffold}.`,
      type: item.type,
      priority: item.priority,
      criteria: item.criteria,
    }, `golden-${item.name}-run${run}`);
    return { key: work.key, id: work.id };
  }

  async settle(filed: Filed, boundMs: number): Promise<SettledRow> {
    const deadline = Date.now() + boundMs;
    for (;;) {
      const work = await this.request(`work/${encodeURIComponent(filed.id)}`);
      const attempts = work.pipeline?.attempts?.length ?? 0;
      const claimedAt: string | null = work.pipeline?.attempts?.[0]?.claimedAt ?? work.createdAt ?? null;
      const tokens = Number.isFinite(work.tokens) ? work.tokens : undefined;
      if (work.stage === 'done' || work.blocker) {
        const ended: string | null = work.stage === 'done' ? work.pipeline?.submittedAt ?? work.updatedAt : work.updatedAt;
        return { outcome: work.stage === 'done' ? 'done' : 'blocked', attempts, reworkRounds: work.pipeline?.reworkRounds ?? 0, minutes: minutesBetween(claimedAt, ended), ...(tokens === undefined ? {} : { tokens }) };
      }
      if (Date.now() >= deadline) return { outcome: 'timed out', attempts, reworkRounds: work.pipeline?.reworkRounds ?? 0, minutes: minutesBetween(claimedAt, null), ...(tokens === undefined ? {} : { tokens }) };
      await new Promise(accept => setTimeout(accept, pollMs));
    }
  }

  async dispose(): Promise<void> {
    // A compose install that never came up leaves nothing for down to do; either way the
    // directory and everything the install owns goes.
    if (existsSync(composeFile(this.directory))) await new Promise<void>(pass => {
      const child = spawn('docker', ['compose', '--project-directory', join(this.directory, 'compose'), '-f', composeFile(this.directory),
        'down', '--volumes', '--remove-orphans'], { stdio: 'inherit' });
      child.on('error', () => pass());
      child.on('exit', () => pass());
    });
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    release: { type: 'string' }, runs: { type: 'string' }, repo: { type: 'string' }, port: { type: 'string' },
    'bound-minutes': { type: 'string' }, golden: { type: 'string' }, compare: { type: 'boolean' },
  }, allowPositionals: true });
  if (values.compare) {
    const [left, right] = positionals;
    if (!left || !right) throw new Error('--compare takes two result files');
    console.log(compare(await readResult(left), await readResult(right)));
    return;
  }
  if (!values.release) throw new Error('Use --release SHA --runs 2 --repo OWNER/SCRATCH-REPO, or --compare A B');
  const repository = values.repo;
  if (!repository) throw new Error('Run mode needs --repo OWNER/SCRATCH-REPO: the scratch repository the scratch install files the golden items on');
  const runs = Number(values.runs ?? 2);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs takes a whole number of runs');
  const port = Number(values.port ?? 4390);
  const boundMs = Number(values['bound-minutes'] ?? 90) * 60_000;
  const scratch = await mkdtemp(join(tmpdir(), 'graphyard-golden-'));
  const install = new ComposeScratchInstall({ repository, port, sourceRoot: process.cwd() });
  try { await install.up(); } catch (error) { await install.dispose(); throw error; }
  const resultsPath = join(resultsDir(), `${values.release}.json`);
  const result = await plan(install, { release: values.release, runs, boundMs, goldenDir: values.golden ?? goldenDir(), scratch, resultsPath });
  console.log(`Wrote ${resultsPath}: ${result.rows.length} rows over ${runs} run${runs === 1 ? '' : 's'} of ${result.rows.length / runs} items`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
