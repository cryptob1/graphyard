// The upgrade gate (GY-1963): a release candidate must upgrade an install of the previous stable
// release with its work intact. In a scratch directory it installs the previous release with the
// compose provider, records a goal-free work item, a lease and a decision through that release's
// CLI, runs that CLI's `graphyard upgrade --to` towards the candidate, and reads everything back:
//
//   health-reports-candidate  /healthz reports the candidate's version and commit
//   item-unchanged            the item reads back with the fields it was recorded with
//   history-unchanged         every history row recorded before the upgrade reads back identical
//   decision-unchanged        the decision reads back with the action, input and reason it was requested with
//   loop-cycle                the loop runs one cycle (master run --once) on the candidate's CLI
//   workflows-pin-candidate   the managed repository's generated workflows pin the candidate's commit
//
//   node --import tsx scripts/upgrade-from-stable.mjs --previous stable|VERSION --candidate SHA [--source DIR] [--work DIR] [--report FILE]
//
// It exits non-zero naming the first failed step or assertion. With no previous stable release,
// or one that predates `graphyard upgrade` (GY-1962), or one at the candidate itself, it records a
// skip (report, step summary, `result=skipped` output) and exits 0: a skip is never a pass.
// The candidate's image is built locally under the date version promotion would give it, and that
// version is tagged only in the scratch CLI clone; nothing is pushed, published or sent to GitHub.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareDateVersions, datedVersionPattern, imageRepository, nextDateVersion, stableChannel } from '../src/release.ts';

export const assertionNames = ['health-reports-candidate', 'item-unchanged', 'history-unchanged', 'decision-unchanged', 'loop-cycle', 'workflows-pin-candidate'];
/** The managed repository is a fixture no GitHub account owns, so no step can write to a real one. */
export const fixtureRepository = 'upgrade-gate/fixture';
const installId = 'upgrade-gate-fixture';
const pinPattern = /github:cryptob1\/graphyard#([0-9a-f]{40})/g;
const itemFields = ['id', 'key', 'title', 'type', 'criteria', 'plannedFiles', 'createdAt'];
const decisionFields = ['id', 'action', 'input', 'reason', 'requestedBy', 'requestedAt', 'createdAt', 'precedent', 'context'];

const pick = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined).map(field => [field, value[field]]));
const canonical = value => JSON.stringify(value, (_, inner) => inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner);
const listOf = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
const rowId = row => row?.id ?? row?.seq ?? row?.sequence ?? null;

/** Every assertion over the snapshot recorded before the upgrade and the observation after it, in order; the first failure names the gate's verdict. */
export function judge(seeded, observed, candidate) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const health = observed.health ?? {};
  check('health-reports-candidate', health.version === candidate.version && String(health.commit ?? '').toLowerCase() === candidate.sha,
    `/healthz reports ${String(health.version)} at ${String(health.commit)}, not ${candidate.version} at ${candidate.sha}`);
  check('item-unchanged', canonical(pick(observed.item, itemFields)) === canonical(pick(seeded.item, itemFields)),
    `${seeded.key} reads back as ${canonical(pick(observed.item, itemFields))}, not ${canonical(pick(seeded.item, itemFields))}`);
  const after = new Map(listOf(observed.history, 'events').map(row => [rowId(row), canonical(row)]));
  const changed = listOf(seeded.history, 'events').filter(row => after.get(rowId(row)) !== canonical(row));
  check('history-unchanged', listOf(seeded.history, 'events').length > 0 && changed.length === 0,
    changed.length ? `${changed.length} history row(s) recorded before the upgrade read back changed or missing: ${changed.map(rowId).join(', ')}` : `${seeded.key} recorded no history before the upgrade`);
  const decision = listOf(observed.decisions, 'decisions').find(entry => entry?.id === seeded.decision?.id);
  check('decision-unchanged', !!seeded.decision?.id && canonical(pick(decision, decisionFields)) === canonical(pick(seeded.decision, decisionFields)),
    decision ? `decision ${seeded.decision.id} reads back as ${canonical(pick(decision, decisionFields))}` : `decision ${String(seeded.decision?.id)} on ${seeded.key} does not read back`);
  check('loop-cycle', observed.loop?.ok === true, `master run --once did not complete a cycle: ${observed.loop?.detail ?? 'not run'}`);
  const pins = observed.workflows ?? [];
  const stale = pins.filter(pin => pin.commit !== candidate.sha);
  check('workflows-pin-candidate', pins.length > 0 && stale.length === 0,
    pins.length ? `generated workflows pin another commit: ${stale.map(pin => `${pin.file} ${pin.commit}`).join(', ')}` : 'no generated workflow pins the Graphyard CLI');
  return checks;
}

/**
 * The gate: resolve the previous release, install it, seed it, upgrade it, observe it, judge it.
 * `steps` are the effects; each receives the context the earlier ones returned.
 */
export async function upgradeFromStable(options, steps) {
  const previous = await steps.resolvePrevious(options);
  if (previous.skip) return { result: 'skipped', reason: previous.skip };
  if (previous.revision === options.candidate) return { result: 'skipped', reason: `the previous stable release ${previous.version} is the candidate ${options.candidate.slice(0, 12)} itself` };
  let stage = 'install';
  try {
    const install = await steps.install(previous, options);
    stage = 'seed';
    const seeded = await steps.seed(install);
    stage = 'upgrade';
    const candidate = await steps.upgrade(install, options);
    stage = 'observe';
    const observed = await steps.observe(install, seeded);
    const checks = judge(seeded, observed, candidate);
    const failed = checks.find(entry => !entry.ok);
    return failed
      ? { result: 'failed', failed: failed.name, detail: failed.detail, previous: previous.version, candidate, checks }
      : { result: 'passed', previous: previous.version, candidate, checks };
  } catch (error) {
    return { result: 'failed', failed: stage, detail: String(error?.message ?? error), previous: previous.version };
  } finally { await steps.teardown?.(); }
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const sh = (command, args, options) => {
  const run = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
  if (run.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${run.status ?? run.signal}: ${(run.stderr || run.stdout || '').trim().split('\n').slice(-20).join('\n')}`);
  return run.stdout;
};

/** The release `--previous` names in the source checkout's tags, or the reason the gate skips. */
export function resolvePrevious(source, previous) {
  if (!previous) return { skip: 'no previous release was named' };
  if (previous !== stableChannel && !datedVersionPattern.test(previous)) throw new Error(`--previous names ${stableChannel} or a dated release, not ${previous}`);
  const revision = tryGit(source, 'rev-parse', '--verify', '--quiet', `refs/tags/${previous}^{commit}`);
  if (!revision) return { skip: `no ${previous} release exists yet` };
  const version = previous === stableChannel
    ? (git(source, 'tag', '--points-at', revision).split('\n').filter(tag => datedVersionPattern.test(tag)).sort(compareDateVersions).at(-1) ?? null)
    : previous;
  if (!version) return { skip: `the ${stableChannel} tag names ${revision.slice(0, 12)}, which carries no dated release` };
  if (tryGit(source, 'cat-file', '-e', `${revision}:src/cli/upgrade.ts`) === null) return { skip: `the previous stable release ${version} predates graphyard upgrade, so it cannot upgrade itself` };
  return { version, revision };
}

/** The real effects: Docker, Git, npm and the two releases' own CLIs, in `work`. */
export function liveSteps(options) {
  const source = resolve(options.source ?? '.'), work = options.work;
  const cliRoot = join(work, 'cli'), repoRoot = join(work, 'repo'), configHome = join(work, 'config');
  // No GitHub credential reaches either release's CLI: the fixture repository exists nowhere.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['GH_TOKEN', 'GITHUB_TOKEN', 'GRAPHYARD_TOKEN', 'GRAPHYARD_URL', 'DATABASE_URL'].includes(name)));
  const plane = { url: null, admin: null, worker: null, database: null };
  // Synchronous; the seed and the read-back await it, so a test may hand them an asynchronous one.
  const cli = (args, token = plane.admin, extra = {}) => {
    const out = sh(process.execPath, [join(cliRoot, 'bin/graphyard.mjs'), ...args], { cwd: repoRoot, env: { ...environment, GRAPHYARD_CONFIG_HOME: configHome, ...(plane.url ? { GRAPHYARD_URL: plane.url } : {}), ...(token ? { GRAPHYARD_TOKEN: token } : {}), ...extra } });
    try { return JSON.parse(out); } catch { return out; }
  };
  const read = async file => (await readFile(file, 'utf8')).trim();
  return {
    resolvePrevious: () => resolvePrevious(source, options.previous),
    async install(previous) {
      await mkdir(work, { recursive: true });
      sh('git', ['clone', '--quiet', '--no-checkout', source, cliRoot]);
      git(cliRoot, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', previous.revision);
      sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: cliRoot });
      sh('git', ['init', '--quiet', '-b', 'main', repoRoot]);
      for (const [key, value] of [['user.name', 'upgrade gate'], ['user.email', 'upgrade-gate@example.invalid'], ['commit.gpgsign', 'false']]) git(repoRoot, 'config', key, value);
      await writeFile(join(repoRoot, 'README.md'), '# Upgrade gate fixture\n');
      git(repoRoot, 'add', '.'); git(repoRoot, 'commit', '--quiet', '-m', 'fixture');
      git(repoRoot, 'remote', 'add', 'origin', `https://github.com/${fixtureRepository}.git`);
      cli(['install', '--provider', 'compose', '--repo', fixtureRepository, '--no-github-app', '--no-herdr', '--workers', '1', '--image', `${imageRepository}:${previous.version}`, '--apply'], null);
      const directory = join(configHome, installId);
      plane.url = JSON.parse(await readFile(join(directory, 'install.json'), 'utf8')).url;
      plane.admin = await read(join(directory, 'tokens', `${installId}-operator.token`));
      plane.worker = await read(join(directory, 'tokens', `${installId}-worker-1.token`));
      // The compose database is published nowhere; the upgrade's backup reaches it on its container address.
      const container = `graphyard-${installId}-db-1`;
      const env = sh('docker', ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', container]);
      const password = /^POSTGRES_PASSWORD=(.*)$/m.exec(env)?.[1];
      const address = sh('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', container]).trim().split(' ')[0];
      plane.database = `postgres://graphyard:${encodeURIComponent(password ?? '')}@${address}:5432/graphyard`;
      // The previous release renders the generated workflows first, so the upgrade has a pin to move.
      cli(['init', '--scan', '--url', plane.url]); cli(['init', '--scan', '--apply', '--url', plane.url]);
      git(repoRoot, 'add', '.'); git(repoRoot, 'commit', '--quiet', '--allow-empty', '-m', `graphyard ${previous.version}`);
      return { cli, plane, repoRoot, fetch };
    },
    seed: install => seedThroughCli(install),
    async upgrade(install, gate) {
      const version = nextDateVersion(new Date(), git(source, 'tag', '--list').split('\n'));
      sh('docker', ['build', '--build-arg', `GRAPHYARD_VERSION=${version}`, '--build-arg', `GRAPHYARD_BUILD_REVISION=${gate.candidate}`, '--tag', `${imageRepository}:${version}`, source], { stdio: ['ignore', 'inherit', 'inherit'] });
      git(cliRoot, 'tag', version, gate.candidate);
      install.cli(['upgrade', '--to', version], install.plane.admin, { DATABASE_URL: install.plane.database });
      return { version, sha: gate.candidate };
    },
    observe: (install, seeded) => observeThroughCli(install, seeded),
    async teardown() { spawnSync('docker', ['compose', '--project-name', `graphyard-${installId}`, 'down', '--volumes'], { stdio: 'ignore' }); },
  };
}

/** A goal-free item, its lease (claimed by the install's worker) and a requested decision, each through the CLI, then the snapshot to compare with. */
export async function seedThroughCli({ cli, plane, repoRoot }) {
  const file = join(repoRoot, '..', 'upgrade-item.json');
  await writeFile(file, JSON.stringify({ title: 'Upgrade gate: this item survives the upgrade', plannedFiles: ['README.md'], criteria: [{ id: 'AC-1', text: 'The item reads back after the upgrade', proofs: ['unit:upgrade-gate-fixture'] }] }));
  const created = await cli(['create', file]);
  const key = created?.key;
  if (!key) throw new Error(`create returned no key: ${JSON.stringify(created)}`);
  await cli(['claim', key], plane.worker);
  const requested = await cli(['master', 'decide', key, 'release', '{}', 'Upgrade gate: this decision survives the upgrade']);
  const id = requested?.id ?? requested?.decision?.id;
  const decision = listOf(await cli(['master', 'decisions', key]), 'decisions').find(entry => entry?.id === id);
  if (!decision) throw new Error(`master decide recorded no decision on ${key} that master decisions lists: ${JSON.stringify(requested)}`);
  return { key, item: await cli(['status', key]), history: await cli(['events', key, '--all', '--payload', 'full', '--order', 'asc']), decision };
}

/** What the candidate serves after the upgrade, read back through its own CLI. */
export async function observeThroughCli({ cli, plane, repoRoot, fetch: get }, seeded) {
  const health = await (await get(`${plane.url}/healthz`)).json();
  let loop;
  try { await cli(['master', 'run', '--once']); loop = { ok: true }; } catch (error) { loop = { ok: false, detail: String(error?.message ?? error) }; }
  const directory = join(repoRoot, '.github/workflows');
  const workflows = [];
  for (const name of (await readdir(directory).catch(() => [])).filter(name => /\.ya?ml$/.test(name)).sort())
    for (const match of (await readFile(join(directory, name), 'utf8')).matchAll(pinPattern)) workflows.push({ file: name, commit: match[1] });
  return { health, item: await cli(['status', seeded.key]), history: await cli(['events', seeded.key, '--all', '--payload', 'full', '--order', 'asc']), decisions: await cli(['master', 'decisions', seeded.key]), loop, workflows };
}

export function parseArguments(argv) {
  const options = { previous: '', candidate: '', source: '.', work: null, report: null };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].replace(/^--/, '');
    if (!(name in options)) throw new Error(`Unknown option ${argv[index]}`);
    options[name] = argv[++index] ?? '';
  }
  if (!/^[0-9a-f]{40}$/.test(options.candidate)) throw new Error('Use --candidate with the candidate\'s full 40-character commit SHA');
  return options;
}

/** Runs the gate and records its verdict; the exit code is non-zero exactly when it failed. */
export async function main(argv, stepsFor = liveSteps) {
  const options = parseArguments(argv);
  options.work ??= await mkdtemp(join(tmpdir(), 'graphyard-upgrade-'));
  const verdict = await upgradeFromStable(options, stepsFor(options));
  const line = verdict.result === 'skipped' ? `upgrade gate skipped: ${verdict.reason}`
    : verdict.result === 'passed' ? `upgrade gate passed: ${verdict.previous} upgraded to ${verdict.candidate.version} (${verdict.candidate.sha.slice(0, 12)}) with its work intact`
      : `upgrade gate failed at ${verdict.failed}: ${verdict.detail}`;
  (verdict.result === 'failed' ? console.error : console.log)(line);
  if (options.report) await writeFile(options.report, `${JSON.stringify(verdict, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `result=${verdict.result}\n`);
  return verdict.result === 'failed' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
