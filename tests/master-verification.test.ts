import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadMasterConfig, managedMasterInstructions, masterConfigSchema, setupMaster, type MasterConfig } from '../src/master.js';
import { managedInstructions } from '../src/repository-setup.js';
import { assessDeploymentVerification, checkoutRelease, deploymentFreshnessMs, emitInstructions, masterLoopStatements, missingLoopStatements, verificationEffects, verifyDeployment, type EmittedInstructions } from '../src/master-verification.js';
import type { Work } from '../src/model.js';

// integration:master-loop-deployment-verification — the deployment-verification step of the
// perpetual master loop, proven against a stubbed deployed release: an endpoint that reports
// the commit it serves, and a clean checkout of exactly that commit whose CLI emits the
// instructions. Everything weaker is refused and nothing is recorded.

const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin/graphyard.mjs');
const nodeModules = fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules');
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const hour = 3_600_000;
const iso = (base: number, offsetMs = 0) => new Date(base + offsetMs).toISOString();
// Tests run inside a worker environment; none of it may reach the processes under test.
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GRAPHYARD_')));

/** A clean checkout of this repository's HEAD: the release the stub endpoint claims to serve. */
async function releaseCheckout() {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-release-'));
  const checkout = join(directory, 'graphyard');
  execFileSync('git', ['clone', '-q', '--shared', '--no-hardlinks', root, checkout]);
  await symlink(nodeModules, join(checkout, 'node_modules'), 'dir');
  const sha = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { directory, checkout, cliPath: join(checkout, 'bin/graphyard.mjs'), sha };
}

function delivered(mergeSha: string, mergedAt: string, overrides: Partial<Work> = {}): Work {
  return { id: 'e4b2a3c8-1c0e-4d0a-9b4e-1f2a3b4c5d6e', key: 'GY-42', title: 'Perpetual master loop', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:master'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'done', revision: 12, policyRevision: 1, createdAt: mergedAt, updatedAt: mergedAt, stageEnteredAt: mergedAt, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], delivery: { mergedAt, mergeSha, authorizationRevision: 5 }, ...overrides } as Work;
}

function config(cliPath: string, url: string, run: Partial<MasterConfig['run']> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url, credentialFile: '/private/master.token', cliPath, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'graphyard-master-project', run: { deploymentUrl: `${url}/release`, deploymentShaField: 'commit', ...run } });
}

/** The stubbed deployed release plus the coordinator API the CLI talks to. */
async function stubServer(state: { sha: string; work: Work[]; records: any[]; now?: () => string }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const json = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname === '/release') return json(200, { commit: state.sha });
    if (request.headers.authorization !== `Bearer ${coordinatorToken}`) return json(401, { error: 'unauthorized' });
    if (url.pathname === '/api/status') return json(200, { actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 });
    if (url.pathname === '/api/work-snapshot') return json(200, { work: state.work, now: (state.now ?? (() => new Date().toISOString()))() });
    const record = url.pathname.match(/^\/api\/work\/([^/]+)\/deployment$/);
    if (record && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const item = state.work.find(work => work.id === record[1]);
      if (!item?.delivery || item.delivery.deployment) return json(400, { error: 'Delivery already has a recorded deployment observation' });
      const data = JSON.parse(body); state.records.push({ id: record[1], ...data });
      item.delivery.deployment = { ...data, covers: data.sha === data.mergeSha ? 'exact' : 'descendant', at: new Date().toISOString(), observer: 'master' };
      return json(200, item);
    }
    json(404, { error: `unexpected ${request.method} ${url.pathname}` });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}` };
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('integration:master-loop-deployment-verification — the generated instructions and the guide carry every statement the verifier checks', async () => {
  const worker = managedInstructions('# Rules\n', 'https://graphyard.example');
  const master = managedMasterInstructions(worker);
  const guide = await readFile(join(root, 'docs/master-agent.md'), 'utf8');
  for (const [name, text] of [['worker section', worker], ['master section', master], ['master guide', guide]] as const) assert.deepEqual(missingLoopStatements(text), [], `${name} carries the loop`);
  assert.equal(masterLoopStatements.length, 6);
  // The statements are the real content, not a coincidence of the wrapper: an earlier
  // generation that stopped at the observed merge fails every one of them.
  const before = managedInstructions('# Rules\n', 'https://graphyard.example').replace(/A dedicated master coordinator must keep cycling[\s\S]*?sessions as part of the cycle\.\n/, '');
  assert.equal(missingLoopStatements(before).length, 6);
});

test('integration:master-loop-deployment-verification — verification is recorded only against the exact release observed, fresh, from a clean checkout of that release', async () => {
  const release = await releaseCheckout();
  const state = { sha: release.sha, work: [] as Work[], records: [] as any[] };
  const { server, url } = await stubServer(state);
  const clock = Date.now();
  state.work = [delivered(release.sha, iso(clock, -hour))];
  try {
    const master = config(release.cliPath, url);
    const mutations: string[] = [];
    const effects = verificationEffects(master, { snapshot: async () => ({ work: state.work, now: iso(clock) }), mutate: async (path, data) => { mutations.push(path); state.records.push(data); return data; } });
    const result = await verifyDeployment(state.work[0], effects);
    assert.equal(result.result, 'verified', result.refusals.join('; '));
    assert.deepEqual(result.checks, { guide: 'pass', init: 'pass' });
    assert.equal(result.recorded, 'now'); assert.equal(result.release.sha, release.sha); assert.equal(result.release.source, 'endpoint'); assert.equal(result.release.covers, 'exact');
    assert.deepEqual(result.checkout, { sha: release.sha, clean: true });
    assert.deepEqual(mutations, [`work/${state.work[0].id}/deployment`]);
    assert.deepEqual(state.records, [{ sha: release.sha, mergeSha: release.sha, source: 'endpoint', observedAt: result.release.observedAt }]);
    assert.ok(Date.now() - Date.parse(result.release.observedAt!) < deploymentFreshnessMs, 'the record carries the observation time, not a copy of the merge time');

    // Same release, already recorded: idempotent, nothing written twice.
    state.work[0].delivery!.deployment = { sha: release.sha, mergeSha: release.sha, source: 'endpoint', observedAt: result.release.observedAt!, covers: 'exact', at: iso(clock), observer: 'master' };
    const again = await verifyDeployment(state.work[0], effects);
    assert.equal(again.result, 'verified'); assert.equal(again.recorded, 'existing'); assert.equal(mutations.length, 1);

    // Local-only: the checkout that emits the instructions carries uncommitted changes.
    delete state.work[0].delivery!.deployment;
    await writeFile(join(release.checkout, 'docs/master-agent.md'), '# Local edit\n');
    const dirty = await verifyDeployment(state.work[0], effects);
    assert.equal(dirty.result, 'refused'); assert.equal(dirty.recorded, null); assert.deepEqual(dirty.checkout, { sha: release.sha, clean: false });
    assert.match(dirty.refusals.join('\n'), /emitted by a local checkout .* with uncommitted changes, not by the deployed release/);
    assert.deepEqual(dirty.checks, { guide: 'unobserved', init: 'unobserved' }, 'a refused preflight never emits instructions from the wrong checkout');
    execFileSync('git', ['-C', release.checkout, 'checkout', '-q', '--', 'docs/master-agent.md']);

    // Local-only: the deployed release moved on; this checkout is no longer what serves.
    const rolledForward = 'f'.repeat(40); state.sha = rolledForward;
    const compare = (_command: string, args: string[]) => { if (args[0] === 'api' && args[1].includes(`compare/${release.sha}...${rolledForward}`)) return JSON.stringify({ status: 'ahead' }); throw new Error(`unexpected ${args.join(' ')}`); };
    const moved = await verifyDeployment(state.work[0], verificationEffects(master, { snapshot: effects.snapshot, mutate: async () => assert.fail('nothing is recorded from a checkout that is not the deployed release'), run: (command, args, options) => command === 'gh' ? compare(command, args) : execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }));
    assert.equal(moved.result, 'refused'); assert.equal(moved.release.sha, rolledForward); assert.equal(moved.release.covers, null);
    assert.match(moved.refusals.join('\n'), new RegExp(`emitted by a local checkout at ${release.sha}, not by the deployed release ${rolledForward}`));
    assert.equal(mutations.length, 1);
    state.sha = release.sha;

    // The release does not serve the merge yet: pending, not verified.
    const behind = await verifyDeployment(delivered('a'.repeat(40), iso(clock, -hour)), verificationEffects(master, { snapshot: async () => ({ work: [delivered('a'.repeat(40), iso(clock, -hour))], now: iso(clock) }), mutate: async () => assert.fail('nothing is recorded for a release that does not serve the merge'), run: (command, args, options) => command === 'gh' ? JSON.stringify({ status: 'behind' }) : execFileSync(command, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }));
    assert.equal(behind.result, 'refused'); assert.match(behind.refusals.join('\n'), /does not serve GY-42 merge commit a{40} yet/);

    // No observation at all: unavailable is a refusal with the endpoint's reason, never a pass
    // (the stub answers 401 off the release path, as a probe behind the wrong credential would).
    const silent = await verifyDeployment(state.work[0], verificationEffects(config(release.cliPath, url, { deploymentUrl: `${url}/missing` }), { snapshot: effects.snapshot, mutate: async () => assert.fail('nothing is recorded without an observation') }));
    assert.equal(silent.result, 'refused'); assert.match(silent.refusals[0], /deployed release is unobserved: Deployment endpoint answered 401/);
  } finally { await close(server); await rm(release.directory, { recursive: true, force: true }); }
});

test('integration:master-loop-deployment-verification — stale observations, undelivered work, and instructions without the loop are refused before anything is recorded', async () => {
  const clock = Date.parse('2030-01-01T12:00:00Z');
  const sha = 'c'.repeat(40);
  const item = delivered(sha, iso(clock, -hour));
  const observation = { source: 'endpoint' as const, sha, at: iso(clock), reason: null, deployed: ['GY-42'], pending: [] };
  const release = { sha, clean: true, repository: 'owner/project', reason: null };
  const good = managedInstructions('# Rules\n', 'https://graphyard.example');
  const emitted: EmittedInstructions = { guide: await readFile(join(root, 'docs/master-agent.md'), 'utf8'), init: good };

  const fresh = assessDeploymentVerification(item, { observation, release, emitted, now: clock + deploymentFreshnessMs });
  assert.equal(fresh.verifiable, true); assert.deepEqual(fresh.refusals, []); assert.deepEqual(fresh.record, { sha, mergeSha: sha, source: 'endpoint', observedAt: observation.at }); assert.equal(fresh.covers, 'exact');
  const stale = assessDeploymentVerification(item, { observation, release, emitted, now: clock + deploymentFreshnessMs + 1000 });
  assert.equal(stale.verifiable, false); assert.match(stale.refusals[0], /stale \(301s old; limit 300s\); observe the release again/);
  const future = assessDeploymentVerification(item, { observation, release, emitted, now: clock - 1000 });
  assert.match(future.refusals[0], /ahead of the coordinator clock/);
  const undelivered = assessDeploymentVerification({ ...item, stage: 'merge', delivery: undefined }, { observation, release, emitted, now: clock });
  assert.match(undelivered.refusals[0], /GY-42 is not delivered; deployment verification follows the observed merge/);
  const descendant = assessDeploymentVerification(delivered('a'.repeat(40), iso(clock, -hour)), { observation, release, emitted, now: clock });
  assert.equal(descendant.verifiable, true); assert.equal(descendant.covers, 'descendant'); assert.equal(descendant.record!.mergeSha, 'a'.repeat(40));
  const moved = assessDeploymentVerification(delivered(sha, iso(clock, -hour), { delivery: { mergedAt: iso(clock, -hour), mergeSha: sha, authorizationRevision: 5, deployment: { sha: 'd'.repeat(40), mergeSha: sha, source: 'endpoint', observedAt: iso(clock, -hour / 2), covers: 'descendant', at: iso(clock, -hour / 2), observer: 'master' } } }), { observation, release, emitted, now: clock });
  assert.match(moved.refusals[0], /already records deployment d{40} .*; a later rollout to c{40} is verified through a follow-up item/);
  const unidentified = assessDeploymentVerification(item, { observation, release: { sha: null, clean: false, repository: null, reason: 'fatal: not a git repository' }, emitted, now: clock });
  assert.match(unidentified.refusals[0], /has no release identity: fatal: not a git repository/);
  // Instructions that stop at the observed merge do not verify, and the checks say which side failed.
  const stopped = good.replace(/A dedicated master coordinator must keep cycling[\s\S]*?sessions as part of the cycle\.\n/, '');
  const lacking = assessDeploymentVerification(item, { observation, release, emitted: { guide: emitted.guide, init: stopped }, now: clock });
  assert.equal(lacking.verifiable, false); assert.deepEqual(lacking.checks, { guide: 'pass', init: 'fail' });
  assert.match(lacking.refusals[0], /^A fresh init from the deployed release emits instructions lacking the perpetual cycle, deployment verification as a step of the cycle, the terminal condition/);
  const preflight = assessDeploymentVerification(item, { observation, release, now: clock });
  assert.equal(preflight.verifiable, false); assert.deepEqual(preflight.refusals, []); assert.deepEqual(preflight.checks, { guide: 'unobserved', init: 'unobserved' });
  // A launcher that is a checkout of another repository emits nothing about the managed one:
  // the release's coverage of the merge is the whole check, and no scratch init is attempted.
  const product = { sha: 'b'.repeat(40), clean: false, repository: 'owner/graphyard', reason: null };
  const unrelated = assessDeploymentVerification(item, { observation, release: product, now: clock, repository: 'owner/product' });
  assert.equal(unrelated.verifiable, true); assert.deepEqual(unrelated.checks, { guide: 'not-applicable', init: 'not-applicable' }); assert.deepEqual(unrelated.record, fresh.record);
  const strict = assessDeploymentVerification(item, { observation, release: { ...product, repository: null }, now: clock, repository: 'owner/product' });
  assert.match(strict.refusals[0], /emitted by a local checkout at b{40} with uncommitted changes/, 'a checkout without a GitHub origin is judged as the managed one');
  const recorded: unknown[] = [];
  const productVerified = await verifyDeployment(item, { snapshot: async () => ({ work: [item], now: iso(clock) }), observe: async () => observation, release: () => product, emit: async () => assert.fail('an unrelated checkout never emits'), record: async (_work, data) => { recorded.push(data); }, repository: 'owner/product', now: () => clock });
  assert.equal(productVerified.result, 'verified'); assert.equal(productVerified.recorded, 'now'); assert.deepEqual(recorded, [fresh.record]);

  // The executor re-reads the clock after emitting, so a slow emission cannot ride on an
  // observation that went stale while the scratch checkout was being written.
  let now = clock; const emissions: number[] = [];
  const slow = await verifyDeployment(item, { snapshot: async () => ({ work: [item], now: iso(clock) }), observe: async () => observation, release: () => release, emit: async () => { emissions.push(now); now += deploymentFreshnessMs + 1; return emitted; }, record: async () => assert.fail('a stale observation is never recorded'), now: () => now });
  assert.equal(slow.result, 'refused'); assert.equal(emissions.length, 1); assert.match(slow.refusals[0], /stale/); assert.deepEqual(slow.checks, { guide: 'pass', init: 'pass' });
  // Undelivered work never reaches the probe, which reads each item's merge commit: the
  // executor observes nothing for it, and the refusal names the missing delivery first.
  const undeliveredItem = { ...item, stage: 'merge' as const, delivery: undefined };
  const observed: Work[][] = [];
  const notDelivered = await verifyDeployment(undeliveredItem, { snapshot: async () => ({ work: [undeliveredItem], now: iso(clock) }), observe: async delivered => { observed.push(delivered); assert.ok(delivered.every(candidate => candidate.delivery), 'only delivered work reaches the deployment probe'); return { source: 'unavailable', sha: null, at: iso(clock), reason: 'No delivered work is awaiting deployment verification', deployed: [], pending: [] }; }, release: () => release, emit: async () => assert.fail('undelivered work never emits'), record: async () => assert.fail('undelivered work is never recorded'), now: () => clock });
  assert.equal(notDelivered.result, 'refused'); assert.equal(notDelivered.recorded, null); assert.deepEqual(observed, [[]]);
  assert.equal(notDelivered.refusals[0], 'GY-42 is not delivered; deployment verification follows the observed merge');
  assert.match(notDelivered.refusals[1], /^The deployed release is unobserved: No delivered work is awaiting deployment verification/);
  assert.deepEqual(notDelivered.release, { sha: null, source: 'unavailable', observedAt: iso(clock), covers: null });
});

test('integration:master-loop-deployment-verification — the checkout identity and the emitted instructions are read from the real CLI', async () => {
  const release = await releaseCheckout();
  const outside = await mkdtemp(join(tmpdir(), 'graphyard-not-a-checkout-'));
  try {
    assert.deepEqual(checkoutRelease(release.cliPath), { sha: release.sha, clean: true, repository: null, reason: null }, 'a clone of a local path has no GitHub origin, so it is judged as the managed checkout');
    execFileSync('git', ['-C', release.checkout, 'remote', 'set-url', 'origin', 'git@github.com:Owner/Project.git']);
    assert.equal(checkoutRelease(release.cliPath).repository, 'Owner/Project');
    const missing = checkoutRelease(join(outside, 'bin/graphyard.mjs'));
    assert.equal(missing.sha, null); assert.equal(missing.clean, false); assert.ok(missing.reason);
    const emitted = await emitInstructions(config(release.cliPath, 'https://graphyard.example'));
    assert.match(emitted.guide, /^# Master-agent operating mode/); assert.doesNotMatch(emitted.guide, /^<!-- page:/);
    assert.match(emitted.init, /This repository uses Graphyard at https:\/\/graphyard\.example/);
    assert.deepEqual(missingLoopStatements(emitted.guide), []); assert.deepEqual(missingLoopStatements(emitted.init), []);
    assert.equal(execFileSync('git', ['-C', release.checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '', 'emitting instructions leaves the release checkout untouched');
  } finally { await rm(release.directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('integration:master-loop-deployment-verification — master verify-deployment records the observed release through the coordinator credential and exits nonzero on refusal', async () => {
  const release = await releaseCheckout();
  const repository = await mkdtemp(join(tmpdir(), 'graphyard-managed-'));
  const credentialDirectory = await mkdtemp(join(tmpdir(), 'graphyard-master-credentials-'));
  execFileSync('git', ['init', '-q', repository]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: repository });
  const clock = Date.now();
  const state = { sha: release.sha, work: [delivered(release.sha, iso(clock, -hour))], records: [] as any[] };
  const { server, url } = await stubServer(state);
  try {
    await setupMaster(repository, { url, token: coordinatorToken, cliPath: release.cliPath, credentialDirectory, run: { deploymentUrl: `${url}/release` } });
    assert.equal((await loadMasterConfig(repository)).run.deploymentUrl, `${url}/release`);
    const env = cleanEnvironment();
    const verified = JSON.parse((await promisify(execFile)(process.execPath, [launcher, 'master', 'verify-deployment', 'GY-42'], { cwd: repository, env })).stdout);
    assert.equal(verified.result, 'verified'); assert.equal(verified.recorded, 'now'); assert.equal(verified.release.sha, release.sha);
    assert.deepEqual(state.records, [{ id: state.work[0].id, sha: release.sha, mergeSha: release.sha, source: 'endpoint', observedAt: verified.release.observedAt }]);
    assert.equal(state.work[0].delivery!.deployment!.sha, release.sha);
    // A local-only reading — the launcher checkout no longer matches what it emitted from — is
    // refused with exit status 1 and no second record.
    delete state.work[0].delivery!.deployment;
    await writeFile(join(release.checkout, 'src/master.ts'), '// local edit\n', { flag: 'a' });
    const refused = await promisify(execFile)(process.execPath, [launcher, 'master', 'verify-deployment', 'GY-42'], { cwd: repository, env }).then(() => assert.fail('a refusal exits nonzero'), (error: any) => error);
    assert.equal(refused.code, 1);
    const report = JSON.parse(refused.stdout);
    assert.equal(report.result, 'refused'); assert.equal(report.recorded, null); assert.deepEqual(report.checkout, { sha: release.sha, clean: false });
    assert.match(report.refusals.join('\n'), /local checkout .* with uncommitted changes, not by the deployed release/);
    assert.equal(state.records.length, 1);
    // Undelivered work through the real CLI and the real deployment probe: the documented
    // refusal on stdout, exit status 1, no stack trace, and nothing recorded.
    state.work.push(delivered(release.sha, iso(clock, -hour), { id: 'f5c3b4d9-2d1f-4e1b-8c5f-2a3b4c5d6e7f', key: 'GY-43', stage: 'merge', delivery: undefined }));
    const undelivered = await promisify(execFile)(process.execPath, [launcher, 'master', 'verify-deployment', 'GY-43'], { cwd: repository, env }).then(() => assert.fail('undelivered work is refused with a nonzero exit'), (error: any) => error);
    assert.equal(undelivered.code, 1); assert.equal(undelivered.stderr, '');
    const undeliveredReport = JSON.parse(undelivered.stdout);
    assert.equal(undeliveredReport.result, 'refused'); assert.equal(undeliveredReport.recorded, null); assert.equal(undeliveredReport.release.sha, null);
    assert.equal(undeliveredReport.refusals[0], 'GY-43 is not delivered; deployment verification follows the observed merge');
    assert.match(undeliveredReport.refusals.join('\n'), /The deployed release is unobserved: No delivered work is awaiting deployment verification/);
    assert.equal(state.records.length, 1);
    await assert.rejects(promisify(execFile)(process.execPath, [launcher, 'master', 'verify-deployment'], { cwd: repository, env }), /Use master verify-deployment GY-N/);
  } finally { await close(server); await rm(release.directory, { recursive: true, force: true }); await rm(repository, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});
