import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commands } from '../src/cli/index.js';
import { localReleasePorts } from '../src/daemon/release-ports.js';
import { masterConfigSchema } from '../src/master.js';
import { cut, digestPromotionRefusal, type AsyncGit, type CandidateBuild, type DeploymentOutcome, type DeploymentRecord, type Git, type Ledger, type ReleaseCandidate, type UatRecord } from '../src/release-candidate.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1868: a UAT verdict may name the digests UAT serves only when an observation backed them.
 * `GRAPHYARD_DEPLOY_DIGESTS` alone deploys a candidate's recorded build by digest, but the verdict's
 * digests are stamped from what an instance observation confirmed — the `digests` suite the
 * `GRAPHYARD_INSTANCE_DIGESTS` observer runs. Without the observer the verdict names no digests, and
 * digest promotion refuses naming `GRAPHYARD_INSTANCE_DIGESTS` instead of accepting digests nothing
 * observed; with the observer and a matching report the verdict carries the digests and promotion is
 * allowed. The CLI's validate (`src/cli/release.ts`) and the loop's managed-repository validation
 * (`src/daemon/release-ports.ts`) give the same result.
 */

const now = new Date(0);
const iso = now.toISOString();
const tip = 'c'.repeat(40);
const sha256 = (digit: string) => `sha256:${digit.repeat(64)}`;
const artifacts = [{ service: 'api', digest: sha256('a') }, { service: 'web', digest: sha256('b') }];
const buildOf = (sha: string): CandidateBuild => ({
  registration: { id: 'graphyard-builder', revision: 2 },
  sourceSha: sha,
  buildInputsDigest: sha256('e'),
  artifacts,
  provenanceUrl: 'https://ci.example.test/builds/812',
});
const candidate: ReleaseCandidate = { id: '20261001T120000Z', sha: tip, cutAt: iso, trigger: 'manual', since: null, items: [], build: buildOf(tip) };

/** The instances the observer reports running: exactly the recorded build's digests. */
const running = [{ service: 'api', instance: 'api-1', digest: sha256('a') }, { service: 'web', instance: 'web-1', digest: sha256('b') }];
/** The adapter commands the tests name: real ones for the CLI's shell, distinctive strings for the loop's stubbed runner. */
const deployCommand = 'do-deploy', instancesCommand = 'print-instances';
const shellDeployCommand = `${process.execPath} -e "console.log('deployed')"`;
const shellInstancesCommand = `${process.execPath} -e "console.log(JSON.stringify([{service:'api',instance:'api-1',digest:'${sha256('a')}'},{service:'web',instance:'web-1',digest:'${sha256('b')}'}]))"`;
/** A managed repository's one required case: UAT answers 200 on /healthz. */
const smokeCase = { id: 'smoke', title: 'UAT serves the candidate', tags: [], target: 'uat', required: true,
  steps: [{ kind: 'http', name: 'health', method: 'GET', path: '/healthz', status: 200 }] };

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare origin and a working clone of it, with main carrying one merge to cut a candidate from. */
async function repository() {
  const root = await temporaryDirectory('uat-digests-observed');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  run(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run(work, 'config', key, value);
  run(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  run(work, 'push', '-q', 'origin', 'HEAD:main');
  const branch = 'graphyard/gy-900-1';
  run(work, 'checkout', '-q', '-b', branch, 'origin/main');
  run(work, 'commit', '-q', '--allow-empty', '-m', 'GY-900 change');
  run(work, 'checkout', '-q', '--detach', 'origin/main');
  run(work, 'merge', '-q', '--no-ff', branch, '-m', 'Merge pull request #901 from owner/graphyard/gy-900-1', '-m', 'GY-900: the change');
  run(work, 'push', '-q', 'origin', 'HEAD:main');
  run(work, 'fetch', '-q', 'origin');
  return { origin, work, git: (args: string[]) => run(work, ...args), sha: run(work, 'rev-parse', 'HEAD') };
}

/** A real UAT deployment's `/healthz`, in its own process, always serving `sha`. */
function uatServer(sha: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      const body = new URL(request.url, 'http://uat').pathname === '/healthz'
        ? { ok: true, version: '0.1.0', revision: 'unknown', schema: 3, commit: ${JSON.stringify(sha)} }
        : { page: 'home' };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const printed = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', chunk => resolve(String(chunk).trim().split('\n')[0]));
    child.on('error', reject);
  });
  return {
    url: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const port = await Promise.race([printed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the UAT server printed no port')), 20_000); })]);
      clearTimeout(timer);
      return `http://127.0.0.1:${port}`;
    },
    close: () => child.kill(),
  };
}

/** The digest variables the CLI's adapter reads from the environment, set for the call and restored after. */
async function withReleaseEnvironment<T>(variables: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const names = ['GRAPHYARD_DEPLOY_DIGESTS', 'GRAPHYARD_INSTANCE_DIGESTS', 'GRAPHYARD_E2E_REPORT', 'GRAPHYARD_UAT_TOKEN'];
  const saved = names.map(name => [name, process.env[name]] as const);
  try {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(variables)) if (value !== undefined) process.env[name] = value;
    return await body();
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

const release = commands.find(command => command.name === 'release')!;
/** One `graphyard release` subcommand, in-process against a real checkout, with what it printed. */
async function releaseCommand(id: string, args: string[], root: string) {
  const printed: any[] = [];
  await release.run({ id, args, api: async () => { throw new Error('the tests name no control plane'); }, print: (value: unknown) => { printed.push(value); }, repositoryRoot: () => root } as any, undefined);
  return printed;
}

/** Which ledger list a tag (or a `for-each-ref` prefix) belongs to. */
const deploymentTagPrefix = 'rc-deploy/', deploymentOutcomeTagPrefix = 'rc-deployed/';
const ledgerKey = (tag: string): keyof Ledger => tag.startsWith('rc-production/') ? 'production' : tag.startsWith('rc/') ? 'candidates' : tag.startsWith('rc-uat/') ? 'uat'
  : tag.startsWith(deploymentTagPrefix) ? 'deployments' : tag.startsWith(deploymentOutcomeTagPrefix) ? 'deployed' : 'soak';
const uatGeneration = (generation: number): DeploymentRecord =>
  ({ environment: 'uat', generation, id: candidate.id, sha: candidate.sha, at: iso, mode: 'digest', digests: artifacts });
const settled = (generation: number): DeploymentOutcome => ({ environment: 'uat', generation, id: candidate.id, result: 'succeeded', at: iso });
/** UAT put to serve the candidate's recorded digests as generation `generation`, settled. */
const digestServed = (generation: number) => ({ deployments: [uatGeneration(generation)], deployed: [settled(generation)] });

/**
 * The candidate ledger in memory: `for-each-ref` reads the tag records, a written tag joins them (so
 * the validation's own records are readable back), every other command answers empty unless a
 * handler names it, and every call is kept.
 */
function ledgerGit(ledger: Partial<Ledger>, handlers: Record<string, (args: string[]) => string> = {}) {
  const calls: string[][] = [];
  const lists: Partial<Record<keyof Ledger, unknown[]>> = Object.fromEntries(Object.entries(ledger).map(([key, list]) => [key, [...(list as unknown[])]]));
  const git: Git = args => {
    calls.push(args);
    if (handlers[args[0]]) return handlers[args[0]](args);
    if (args[0] === 'for-each-ref') {
      const prefix = args[3].slice('refs/tags/'.length);
      return ((lists[ledgerKey(prefix)] ?? []) as { id: string }[]).map(record => `${prefix}${record.id}\0${JSON.stringify(record, null, 2)}`).join('\0\0\n');
    }
    if (args[4] === 'tag' && args[5] === '-a') (lists[ledgerKey(args[6])] ??= []).push(JSON.parse(args[args.indexOf('-m') + 1]));
    return '';
  };
  const asyncGit: AsyncGit = async args => git(args);
  return { git, asyncGit, calls, pushes: () => calls.filter(args => args[0] === 'push').map(args => args.join(' ')) };
}

const masterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', retrials: 2 } } });

/** The loop's ports over the in-memory ledger: git answered by it, the adapter commands by the stub. */
async function managedPorts(environment: Record<string, string>) {
  const repo = ledgerGit({ candidates: [candidate], ...digestServed(1) }, { 'ls-remote': () => '' });
  const sh: string[] = [];
  const run = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (command === 'git') {
      // The managed validation checks the candidate out of the ledger's objects; give the checkout its case.
      if (args[0] === 'worktree' && args[1] === 'add') {
        const checkout = args[args.indexOf('--detach') + 1]!;
        await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
        await writeFile(join(checkout, 'e2e', 'cases', 'smoke.json'), JSON.stringify(smokeCase));
      }
      return repo.git(args);
    }
    sh.push(`${args[1]} for ${options?.env?.GRAPHYARD_DEPLOY_ENVIRONMENT}`);
    return args[1] === instancesCommand ? `${JSON.stringify(running)}\n` : 'deployed\n';
  };
  const base = await temporaryDirectory('uat-digests-managed');
  const ports = localReleasePorts(masterConfig, '/checkout', run, { base, record: async () => ({}), now: () => 0, environment })!;
  return { ports, sh, written: () => repo.calls.filter(args => args[4] === 'tag' && args[5] === '-a').map(args => JSON.parse(args[args.indexOf('-m') + 1]) as any) };
}

test('unit:uat-digests-require-observation — a UAT verdict names the digests UAT serves only when the instance observation backed them: with GRAPHYARD_DEPLOY_DIGESTS set and no GRAPHYARD_INSTANCE_DIGESTS the verdict records none and digest promotion refuses naming it, with the observer and a matching report it records them and promotion is allowed, and the CLI and the loop\'s managed validation give the same result', async () => {
  // The refusal itself names the missing observer, and only fires when a recorded build has no backed record.
  const unobserved: UatRecord = { id: candidate.id, sha: tip, result: 'passed', deployedSha: tip, at: iso, suites: [{ name: 'endpoints', passed: true, detail: 'ok' }], followUp: null };
  const refusal = digestPromotionRefusal(candidate, unobserved)!;
  assert.match(refusal, /names no digests/);
  assert.match(refusal, /GRAPHYARD_INSTANCE_DIGESTS/, 'the refusal names the observer that would have backed the digests');
  assert.equal(digestPromotionRefusal(candidate, { ...unobserved, digests: artifacts }), null, 'a record naming the recorded build\'s digests promotes');

  // ——— The CLI path: `release uat`, `release validate`, `release promote` over a real repository. ———
  const observedRepo = await repository();
  const sha = observedRepo.sha;
  const { candidate: cutCandidate } = cut(observedRepo.git, { base: 'main', trigger: 'manual', now, push: true, build: () => buildOf(sha) }) as any;
  const server = uatServer(sha);
  const savedExit = process.exitCode;
  try {
    // The observer set and its report matching the manifest: the verdict carries the digests and promotion is allowed.
    await withReleaseEnvironment({ GRAPHYARD_DEPLOY_DIGESTS: shellDeployCommand, GRAPHYARD_INSTANCE_DIGESTS: shellInstancesCommand }, async () => {
      await releaseCommand('uat', [cutCandidate.id, '--base', 'main'], observedRepo.work);
      const [validated] = await releaseCommand('validate', [cutCandidate.id, '--url', await server.url(), '--wait', '1', '--base', 'main'], observedRepo.work);
      assert.equal(validated.record.result, 'passed');
      assert.deepEqual(validated.record.digests, artifacts, 'the observation matched, so the verdict names the digests it tested');
      assert.ok(validated.record.suites.some((suite: { name: string; passed: boolean }) => suite.name === 'digests' && suite.passed), 'the digests suite ran and passed');
      const [promoted] = await releaseCommand('promote', [cutCandidate.id, '--base', 'main'], observedRepo.work);
      assert.equal(promoted.promoted, true);
      assert.equal(promoted.mode, 'digest');
      assert.deepEqual(promoted.digests, artifacts, 'promotion by digest is allowed on the observed record');
      assert.equal(process.exitCode, savedExit);
    });

    // The observer unset: the same digest deployment, a verdict that names no digests, promotion refused.
    const unobservedRepo = await repository();
    const unobservedSha = unobservedRepo.sha;
    const { candidate: second } = cut(unobservedRepo.git, { base: 'main', trigger: 'manual', now, push: true, build: () => buildOf(unobservedSha) }) as any;
    const bareServer = uatServer(unobservedSha);
    try {
      await withReleaseEnvironment({ GRAPHYARD_DEPLOY_DIGESTS: shellDeployCommand, GRAPHYARD_INSTANCE_DIGESTS: undefined }, async () => {
        await releaseCommand('uat', [second.id, '--base', 'main'], unobservedRepo.work);
        const [validated] = await releaseCommand('validate', [second.id, '--url', await bareServer.url(), '--wait', '1', '--base', 'main'], unobservedRepo.work);
        assert.equal(validated.record.result, 'passed');
        assert.equal(validated.record.digests, undefined, 'nothing observed the instances, so the verdict names no digests');
        assert.ok(!validated.record.suites.some((suite: { name: string }) => suite.name === 'digests'), 'no digests suite ran without the observer');
        const [refused] = await releaseCommand('promote', [second.id, '--base', 'main'], unobservedRepo.work);
        assert.equal(refused.promoted, false);
        assert.match(refused.refusals.join(' '), /GRAPHYARD_INSTANCE_DIGESTS/);
        assert.match(refused.refusals.join(' '), /names no digests/);
        assert.equal(process.exitCode, 1, 'the refusal fails the command');
        process.exitCode = savedExit;
      });
    } finally { bareServer.close(); }
  } finally { server.close(); process.exitCode = savedExit; }

  // ——— The daemon path: the loop's managed-repository validation gives the same result. ———
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string) => new URL(String(url)).pathname === '/healthz'
    ? new Response(JSON.stringify({ ok: true, version: '0.1.0', revision: 'unknown', schema: 3, commit: tip }))
    : new Response(JSON.stringify({ ok: true }))) as typeof fetch;
  try {
    // The observer set and its report matching: the attested candidate validates with its attestation
    // among the suites, records the observed digests, and promotes by digest.
    const attested = await managedPorts({ GRAPHYARD_UAT_URL: 'https://uat.example.test', GRAPHYARD_DEPLOY_DIGESTS: deployCommand, GRAPHYARD_INSTANCE_DIGESTS: instancesCommand });
    const { record } = await attested.ports.validate(candidate.id);
    assert.equal(record.result, 'passed');
    const written = attested.written().find(tag => tag.id === candidate.id && 'suites' in tag) as UatRecord;
    assert.deepEqual(written.digests, artifacts, 'the managed verdict records the digests the observation backed, like the CLI\'s');
    assert.ok(written.suites.find(suite => suite.name === 'digests')?.passed, 'the attestation rode the validating call');
    assert.deepEqual(await attested.ports.promote(candidate.id), { promoted: true, sha: tip }, 'the observed digests promote');
    assert.ok(attested.sh.some(entry => entry.startsWith(`${instancesCommand} for uat`)), 'the observation asked the adapter for UAT\'s instances');

    // The observer unset: the same digest deployment records a verdict with no digests, and promotion
    // refuses naming GRAPHYARD_INSTANCE_DIGESTS before anything is deployed.
    const unobserved = await managedPorts({ GRAPHYARD_UAT_URL: 'https://uat.example.test', GRAPHYARD_DEPLOY_DIGESTS: deployCommand });
    const plain = await unobserved.ports.validate(candidate.id);
    assert.equal(plain.record.result, 'passed');
    const plainWritten = unobserved.written().find(tag => tag.id === candidate.id && 'suites' in tag) as UatRecord;
    assert.equal(plainWritten.digests, undefined, 'the managed verdict records no digests without the observer, like the CLI\'s');
    const refused = await unobserved.ports.promote(candidate.id);
    assert.equal(refused.promoted, false);
    assert.match(refused.refusals.join(' '), /GRAPHYARD_INSTANCE_DIGESTS/);
    assert.deepEqual(unobserved.sh.filter(entry => entry.startsWith(`${deployCommand} for`)), [], 'nothing UAT never named is deployed');
  } finally { globalThis.fetch = realFetch; }
});
