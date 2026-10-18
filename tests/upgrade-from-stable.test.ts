import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// @ts-expect-error Dependency-free gate script.
import { assertionNames, loopVerdict, main, observeThroughCli, resolvePrevious, seedThroughCli } from '../scripts/upgrade-from-stable.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const previousSha = 'a'.repeat(40), candidateSha = 'c'.repeat(40);
const pinned = (sha: string) => `jobs:\n  release:\n    steps:\n      - run: npx -y github:cryptob1/graphyard#${sha} release cut\n`;

/**
 * An in-memory control plane answering the CLI commands the gate seeds and reads back with. It
 * keeps the real lifecycle's prerequisites: `master decide` and `master release` need the
 * operator-agent identity `master autonomy` provisions from the admin credential on stdin, new work
 * is unreleased and only released work is claimable, and `master run --once` exits 0 after a
 * failed cycle, reporting it as failedCycles.
 */
function fakePlane() {
  const state = { item: null as any, events: [] as any[], decisions: [] as any[], health: { version: '2026.10.16', commit: previousSha } as any, loopBroken: false, cycles: 0, operatorAgent: false };
  const event = (kind: string, payload: unknown) => state.events.push({ id: state.events.length + 1, kind, payload });
  const operator = () => { if (!state.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply'); };
  const cli = async (args: string[], token?: string | null, _extra?: unknown, input?: string) => {
    const [command, ...rest] = args;
    if (command === 'master' && rest[0] === 'autonomy') {
      assert.deepEqual(rest.slice(1), ['--admin-token-stdin', '--apply']);
      if (input?.trim() !== 'admin-token') throw new Error('Autonomy setup needs the admin credential once, on stdin');
      state.operatorAgent = true; return { applied: true, changes: ['fixture-operator-agent: provisioned'] };
    }
    if (command === 'create') {
      const body = JSON.parse(await readFile(rest[0], 'utf8'));
      state.item = { id: 'w-1', key: 'GY-1', type: 'feature', ...body, createdAt: 'recorded-at-create', revision: 1, ready: false };
      event('work.created', body); return structuredClone(state.item);
    }
    if (command === 'master' && rest[0] === 'release') {
      operator(); if (state.item.ready) throw new Error('Only unreleased backlog work can be released');
      state.item.ready = true; state.item.revision++; event('work.ready', { reason: rest[2] }); return structuredClone(state.item);
    }
    if (command === 'claim') {
      assert.equal(token, 'worker-token', 'the lease is claimed by the install\'s worker');
      if (!state.item.ready) throw new Error('Task is not ready or has a blocker');
      event('lease.claimed', { epoch: 1, owner: 'fixture-worker-1' }); return { epoch: 1 };
    }
    if (command === 'status') return structuredClone(state.item);
    if (command === 'events') return { events: state.events.map(row => structuredClone(row)) };
    if (command === 'master' && rest[0] === 'decide') {
      operator();
      const decision = { id: 'd-1', action: rest[2], input: JSON.parse(rest[3]), reason: rest[4], requestedBy: 'fixture-operator', state: 'requested' };
      state.decisions.push(decision); event('decision.requested', { id: decision.id }); return structuredClone(decision);
    }
    if (command === 'master' && rest[0] === 'decisions') return { decisions: state.decisions.map(entry => structuredClone(entry)) };
    if (command === 'master' && rest[0] === 'run') {
      if (state.loopBroken) return { cycles: 0, failedCycles: 1, stopped: 'completed', last: null, lastFailure: { error: 'cycle failed' } };
      state.cycles++; event('loop.cycle', {}); return { cycles: 1, failedCycles: 0, stopped: 'completed', last: { cycle: 1 }, lastFailure: null };
    }
    throw new Error(`unexpected command ${args.join(' ')}`);
  };
  return { state, cli };
}

/** The gate's steps with the install and the upgrade stubbed: seed and read-back run as written, against the fake plane. */
async function stubbedRun(violate?: (plane: ReturnType<typeof fakePlane>['state'], repoRoot: string) => Promise<void> | void, overrides: Record<string, unknown> = {}) {
  const scratch = await temporaryDirectory('upgrade-from-stable');
  const repoRoot = join(scratch, 'repo'), report = join(scratch, 'report.json');
  const plane = fakePlane();
  const calls: string[] = [];
  const cli = (args: string[], token?: string | null, extra?: unknown, input?: string) => plane.cli(args, token === undefined ? 'admin-token' : token, extra, input);
  const install = { cli, plane: { url: 'http://127.0.0.1:4399', admin: 'admin-token', worker: 'worker-token' }, repoRoot,
    fetch: async (url: string) => { calls.push(`GET ${url}`); return { json: async () => plane.state.health }; } };
  const steps = {
    resolvePrevious: async () => ({ version: '2026.10.16', revision: previousSha }),
    install: async (previous: { version: string }) => {
      calls.push(`install ${previous.version}`);
      await mkdir(join(repoRoot, '.github/workflows'), { recursive: true });
      await writeFile(join(repoRoot, '.github/workflows/graphyard-release-candidate.yml'), pinned(previousSha));
      return install;
    },
    seed: (context: typeof install) => seedThroughCli(context as any),
    upgrade: async (_: unknown, options: { candidate: string }) => {
      calls.push(`upgrade --to 2026.10.17`);
      plane.state.health = { version: '2026.10.17', commit: options.candidate };
      for (const name of ['graphyard-release-candidate.yml', 'graphyard-promotion.yml']) await writeFile(join(repoRoot, '.github/workflows', name), pinned(options.candidate));
      await violate?.(plane.state, repoRoot);
      return { version: '2026.10.17', sha: options.candidate };
    },
    observe: (context: typeof install, seeded: any) => observeThroughCli(context as any, seeded),
    ...overrides,
  };
  const errors: string[] = [], logs: string[] = [];
  const original = { error: console.error, log: console.log };
  console.error = (line: string) => errors.push(line); console.log = (line: string) => logs.push(line);
  let code: number;
  try { code = await main(['--previous', 'stable', '--candidate', candidateSha, '--work', scratch, '--report', report], () => steps); }
  finally { Object.assign(console, original); }
  return { code, errors, logs, calls, plane: plane.state, verdict: JSON.parse(await readFile(report, 'utf8')) };
}

test('unit:upgrade-from-stable — scripts/upgrade-from-stable.mjs installs, seeds, upgrades and reads back, exiting non-zero naming the first failed assertion; each assertion fails the script when violated', async () => {
  const passed = await stubbedRun();
  assert.equal(passed.code, 0, passed.errors.join('\n'));
  assert.equal(passed.verdict.result, 'passed');
  assert.deepEqual(passed.verdict.checks.map((check: { name: string }) => check.name), assertionNames);
  assert.ok(passed.verdict.checks.every((check: { ok: boolean }) => check.ok));
  assert.deepEqual(passed.calls, ['install 2026.10.16', 'upgrade --to 2026.10.17', 'GET http://127.0.0.1:4399/healthz']);
  assert.equal(passed.plane.cycles, 1, 'the loop ran one cycle on the upgraded install');
  assert.deepEqual(passed.plane.events.map((row: { kind: string }) => row.kind), ['work.created', 'decision.requested', 'work.ready', 'lease.claimed', 'loop.cycle'], 'the item, the decision, its release and its lease were recorded through the CLI before the upgrade; rows after it are allowed');
  assert.match(passed.logs.join('\n'), /upgrade gate passed: 2026\.10\.16 upgraded to 2026\.10\.17 \(cccccccccccc\)/);

  const violations: Record<string, (plane: any, repoRoot: string) => Promise<void> | void> = {
    'health-reports-candidate': plane => { plane.health = { version: '2026.10.16', commit: previousSha }; },
    'item-unchanged': plane => { plane.item.title = 'Rewritten by the upgrade'; },
    'history-unchanged': plane => { plane.events[3].payload.owner = 'someone-else'; },
    'decision-unchanged': plane => { plane.decisions[0].reason = 'Rewritten by the upgrade'; },
    'loop-cycle': plane => { plane.loopBroken = true; },
    'workflows-pin-candidate': (_, repoRoot) => writeFile(join(repoRoot, '.github/workflows/graphyard-promotion.yml'), pinned(previousSha)),
  };
  assert.deepEqual(Object.keys(violations), assertionNames, 'every assertion is violated once');
  for (const [name, violate] of Object.entries(violations)) {
    const failed = await stubbedRun(violate);
    assert.equal(failed.code, 1, `${name} violated fails the script`);
    assert.equal(failed.verdict.result, 'failed');
    assert.equal(failed.verdict.failed, name, `the first failed assertion is ${name}`);
    assert.match(failed.errors.join('\n'), new RegExp(`^upgrade gate failed at ${name}: `));
  }
  // A lost history row and a decision that no longer reads back fail as surely as a rewritten one.
  assert.equal((await stubbedRun(plane => { plane.events.splice(0, 1); })).verdict.failed, 'history-unchanged');
  assert.equal((await stubbedRun(plane => { plane.decisions.length = 0; })).verdict.failed, 'decision-unchanged');
  assert.equal((await stubbedRun(async (_, repoRoot) => { await writeFile(join(repoRoot, '.github/workflows/graphyard-release-candidate.yml'), 'jobs: {}\n'); await writeFile(join(repoRoot, '.github/workflows/graphyard-promotion.yml'), 'jobs: {}\n'); })).verdict.failed, 'workflows-pin-candidate', 'no pin at all is no pin of the candidate');

  // The seed provisions the operator-agent identity before deciding and releases before claiming;
  // without that identity it stops at seed, before any upgrade.
  const unprovisioned = await stubbedRun(undefined, { seed: (context: any) => seedThroughCli({ ...context, cli: (args: string[], ...rest: unknown[]) => args[1] === 'autonomy' ? { applied: false } : context.cli(args, ...rest) }) });
  assert.equal(unprovisioned.verdict.failed, 'seed');
  assert.match(unprovisioned.verdict.detail, /master autonomy provisioned no operator-agent identity/);
  assert.ok(!unprovisioned.calls.includes('upgrade --to 2026.10.17'));
  const refusedAutonomy = await stubbedRun(undefined, { seed: (context: any) => seedThroughCli({ ...context, plane: { ...context.plane, admin: 'not-the-admin' } }) });
  assert.equal(refusedAutonomy.verdict.failed, 'seed', 'the admin credential reaches master autonomy on stdin');
  // A loop result naming a failed cycle, or no cycle, fails loop-cycle though the command exited 0.
  assert.deepEqual(loopVerdict({ cycles: 1, failedCycles: 0 }), { ok: true });
  assert.equal(loopVerdict({ cycles: 0, failedCycles: 0 }).ok, false, 'a held cycle is no cycle');
  assert.equal(loopVerdict({ cycles: 2, failedCycles: 1, lastFailure: { error: 'x' } }).ok, false);
  assert.equal(loopVerdict('not json').ok, false);
  assert.match((await stubbedRun(plane => { plane.loopBroken = true; })).verdict.detail, /1 cycle\(s\) failed: \{"error":"cycle failed"\}/);

  // A step that fails stops the gate there, naming the step.
  const broken = await stubbedRun(undefined, { install: async () => { throw new Error('compose up failed'); } });
  assert.equal(broken.code, 1); assert.equal(broken.verdict.failed, 'install');
  assert.match(broken.errors.join('\n'), /upgrade gate failed at install: compose up failed/);
  const refused = await stubbedRun(undefined, { upgrade: async () => { throw new Error('upgrade stopped at redeploy'); } });
  assert.equal(refused.code, 1); assert.equal(refused.verdict.failed, 'upgrade');

  // The previous release is read from the source checkout's tags; without one the gate skips.
  const source = await temporaryDirectory('upgrade-from-stable-source');
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'gate@example.invalid'); git('config', 'user.name', 'gate'); git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
  await writeFile(join(source, 'README.md'), 'old\n'); git('add', '.'); git('commit', '-qm', 'old');
  assert.deepEqual(resolvePrevious(source, 'stable'), { skip: 'no stable release exists yet' });
  git('tag', '2026.10.15'); git('tag', 'stable');
  assert.match(resolvePrevious(source, 'stable').skip, /2026\.10\.15 predates graphyard upgrade/);
  await mkdir(join(source, 'src/cli'), { recursive: true }); await writeFile(join(source, 'src/cli/upgrade.ts'), '\n'); git('add', '.'); git('commit', '-qm', 'upgrade');
  git('tag', '2026.10.16'); git('tag', '2026.10.16.1'); git('tag', '-f', 'stable');
  assert.deepEqual(resolvePrevious(source, 'stable'), { version: '2026.10.16.1', revision: git('rev-parse', 'HEAD') });
});

test('unit:upgrade-gate-wiring — the release-candidate workflow runs scripts/upgrade-from-stable.mjs against the previous stable tag before promote, promote needs it, and with no previous stable tag the gate records a skip', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const jobs = new Map([...workflow.split(/\njobs:\n/)[1].matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n)*)/gm)].map(match => [match[1], match[2]]));
  const upgrade = jobs.get('upgrade'), promote = jobs.get('promote');
  assert.ok(upgrade && promote, 'the workflow has an upgrade job and a promote job');
  assert.match(upgrade, /needs: candidate\n/);
  assert.match(upgrade, /ref: '\$\{\{ env\.CANDIDATE_SHA \}\}', fetch-depth: 0/, 'the gate runs the candidate\'s checkout with its tags, where the stable tag is read');
  assert.match(upgrade, /run: node --import tsx scripts\/upgrade-from-stable\.mjs --previous stable --candidate "\$CANDIDATE_SHA"/);
  assert.doesNotMatch(upgrade, /continue-on-error|GH_TOKEN|GRAPHYARD_TOKEN|secrets\./, 'the gate decides and holds no credential');
  assert.match(promote, /needs: \[[^\]]*\bupgrade\b[^\]]*\]/, 'promote needs the upgrade job');
  assert.match(promote, /if: [^\n]*needs\.upgrade\.result == 'success'/, 'promote runs only once the gate passed or recorded its skip');
  assert.ok([...jobs.keys()].indexOf('upgrade') < [...jobs.keys()].indexOf('promote'));

  // With no previous stable tag the script records a skip, never a pass, and exits 0.
  const scratch = await temporaryDirectory('upgrade-gate-wiring');
  const output = join(scratch, 'output'), summary = join(scratch, 'summary'), report = join(scratch, 'report.json');
  const saved = { output: process.env.GITHUB_OUTPUT, summary: process.env.GITHUB_STEP_SUMMARY };
  process.env.GITHUB_OUTPUT = output; process.env.GITHUB_STEP_SUMMARY = summary;
  const original = console.log; const logs: string[] = []; console.log = (line: string) => logs.push(line);
  const touched: string[] = [];
  const steps = { resolvePrevious: async () => ({ skip: 'no stable release exists yet' }), install: async () => { touched.push('install'); }, seed: async () => {}, upgrade: async () => {}, observe: async () => {} };
  let code: number;
  try { code = await main(['--previous', 'stable', '--candidate', candidateSha, '--work', scratch, '--report', report], () => steps); }
  finally {
    console.log = original;
    for (const [name, value] of [['GITHUB_OUTPUT', saved.output], ['GITHUB_STEP_SUMMARY', saved.summary]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  assert.equal(code, 0);
  assert.deepEqual(touched, [], 'nothing is installed when there is no previous release');
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), { result: 'skipped', reason: 'no stable release exists yet' });
  assert.equal(await readFile(output, 'utf8'), 'result=skipped\n');
  assert.equal(await readFile(summary, 'utf8'), 'upgrade gate skipped: no stable release exists yet\n');
  assert.deepEqual(logs, ['upgrade gate skipped: no stable release exists yet']);
});
