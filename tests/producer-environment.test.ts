import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { loadMasterConfig, masterConfigSchema, saveProducerProfile, setupMaster } from '../src/master.js';
import { launchProducer, missingProducerEnv, parseEnvValue, producerSecretsPrefix, readProducerEnvironment, readProducerLedger } from '../src/producer.js';
import { clearRuns } from '../src/runner/registry.js';
import type { RunOptions, Runner } from '../src/runner/types.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1071: the producer's .env secrets (GY-73) — which names leave .env, how a value is read, that
// a Herdr session gets them without any command line carrying them, that a headless run gets them
// in its child's environment, and that a live-install launch without them is refused.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const H = 'e'.repeat(40), B = 'f'.repeat(40);
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const token = "hc-to'ken $HOME `x` #1";

async function scratch() {
  const directory = await realpath(await temporaryDirectory('producer-env'));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('unit:producer-environment forwards only the allowlisted .env names, and a missing .env is no environment', async () => {
  const { directory, cleanup } = await scratch();
  try {
    assert.deepEqual(await readProducerEnvironment(directory), {}, 'no .env file');
    await writeFile(join(directory, '.env'), [
      '# local secrets', 'GITHUB_TOKEN=ghp_secret', 'DATABASE_URL=postgres://x', 'GRAPHYARD_TOKEN_FILE=/elsewhere',
      'HCLOUD_TOKEN=abc123', 'HETZNER_SPEND_CAP_USD_MONTHLY=25', 'OTHER=1', ''].join('\n'));
    assert.deepEqual(await readProducerEnvironment(directory), { HCLOUD_TOKEN: 'abc123', HETZNER_SPEND_CAP_USD_MONTHLY: '25' });
    await writeFile(join(directory, '.env'), 'HCLOUD_TOKEN=\r\nexport HETZNER_SPEND_CAP_USD_MONTHLY=10\r\n');
    assert.deepEqual(await readProducerEnvironment(directory), { HETZNER_SPEND_CAP_USD_MONTHLY: '10' }, 'an empty value is not forwarded; an export prefix and CRLF are read');
  } finally { await cleanup(); }
});

test('unit:producer-environment reads quoted values as a pair, drops inline comments, and refuses unpaired quotes without naming the value', async () => {
  assert.equal(parseEnvValue('abc'), 'abc');
  assert.equal(parseEnvValue('"abc"'), 'abc');
  assert.equal(parseEnvValue("'a\"b'"), 'a"b', 'the other quote inside a pair is kept');
  assert.equal(parseEnvValue('"a # b"  # note'), 'a # b', 'a # inside the pair is the value; after it, a comment');
  assert.equal(parseEnvValue('abc # note'), 'abc');
  assert.equal(parseEnvValue('ab#c'), 'ab#c', 'a # not led by whitespace is part of the value');
  for (const unpaired of ['"abc', "abc'", '"abc\'', 'a"bc', '"abc"def'])
    assert.equal(parseEnvValue(unpaired), null, `${unpaired} is refused, not altered`);
  const { directory, cleanup } = await scratch();
  try {
    await writeFile(join(directory, '.env'), 'OTHER="unpaired\nHCLOUD_TOKEN="secret-value\n');
    await assert.rejects(readProducerEnvironment(directory), (error: Error) => /HCLOUD_TOKEN has unpaired quotes/.test(error.message) && !error.message.includes('secret-value'));
    await writeFile(join(directory, '.env'), 'OTHER="unpaired\nexport HCLOUD_TOKEN="x y" # hetzner\n');
    assert.deepEqual(await readProducerEnvironment(directory), { HCLOUD_TOKEN: 'x y' }, 'a malformed line outside the allowlist is not read at all');
  } finally { await cleanup(); }
});

test('unit:producer-environment the secrets file is private and exports each value exactly to the runtime it execs', async () => {
  const { directory, cleanup } = await scratch();
  try {
    assert.deepEqual(await producerSecretsPrefix(directory, {}), [], 'no secrets, no wrapper');
    const prefix = await producerSecretsPrefix(directory, { HCLOUD_TOKEN: token, HETZNER_SPEND_CAP_USD_MONTHLY: '25' });
    assert.ok(!prefix.some(word => word.includes(token)), 'the value is on no command line');
    assert.equal((await stat(join(directory, 'producer.env'))).mode & 0o777, 0o600);
    const printed = execFileSync(prefix[0], [...prefix.slice(1), process.execPath, '-e', 'process.stdout.write(JSON.stringify([process.env.HCLOUD_TOKEN, process.env.HETZNER_SPEND_CAP_USD_MONTHLY]))'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(printed), [token, '25']);
  } finally { await cleanup(); }
});

test('unit:producer-environment a live-install proof names each .env value it lacks; other proofs need none', () => {
  assert.deepEqual(missingProducerEnv(['manual:install-hetzner-live'], {}), ['HCLOUD_TOKEN', 'HETZNER_SPEND_CAP_USD_MONTHLY']);
  assert.deepEqual(missingProducerEnv(['manual:install-hetzner-live'], { HCLOUD_TOKEN: 'x' }), ['HETZNER_SPEND_CAP_USD_MONTHLY']);
  assert.deepEqual(missingProducerEnv(['manual:install-hetzner-live'], { HCLOUD_TOKEN: 'x', HETZNER_SPEND_CAP_USD_MONTHLY: '5' }), []);
  assert.deepEqual(missingProducerEnv(['manual:install-railway-live', 'unit:install-plan'], {}), []);
});

async function installation(pi = false) {
  const base = await realpath(await temporaryDirectory('producer-env-launch'));
  const root = join(base, 'repository'), credentials = join(base, 'credentials'), managed = join(base, 'data', 'worktrees');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'producer environment\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: managed } }, coordinatorStatus, { probe: durable });
  const credential = join(credentials, 'producer.token'); await writeFile(credential, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*', 'manual:*'] } }));
  if (pi) {
    const file = join(root, '.graphyard/master.json'), config = JSON.parse(await readFile(file, 'utf8'));
    config.run = { ...config.run, runtimes: { producer: 'pi' }, pi: { command: '/bin/false', model: 'zai/glm-5.3-flash' } };
    await writeFile(file, JSON.stringify(masterConfigSchema.parse(config), null, 2), { mode: 0o600 });
  }
  return { root, cleanup: () => { clearRuns(); return rm(base, { recursive: true, force: true }); } };
}
function work(key: string, group: string, proofs: string[]): Work {
  const candidate = { sha: H, baseSha: B, pr: 73, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  const request = { id: `request-${randomUUID().slice(0, 8)}`, kind: 'producer', sha: H, baseSha: B, policyRevision: 2, pr: 73, group, proofs, state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' };
  return { id: `id-${key}`, key, title: 'Live install', description: '', type: 'feature', priority: 1, dependencies: [], plannedFiles: [],
    criteria: [{ id: 'AC-1', text: 'Installs', proofs }], policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 2,
    createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 73 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    blocker: null, gates: [], violations: [], implementers: ['implementer'],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false },
    autoDispatch: { review: null, producers: [request], history: [] } } as unknown as Work;
}
function herdr(calls: string[][]) {
  let pane = 0;
  return (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab') { pane++; return JSON.stringify({ result: { type: 'tab_created', root_pane: { pane_id: `pane-${pane}`, tab_id: `tab-${pane}` }, tab: { tab_id: `tab-${pane}` } } }); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
}

test('integration:producer-environment a Herdr producer gets the .env secrets from its private file, never on the tab or pane command line', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), `HCLOUD_TOKEN='${token.replaceAll("'", '')}'\nHETZNER_SPEND_CAP_USD_MONTHLY=25\nGITHUB_TOKEN=ghp_never\n`);
    const item = work('GY-73', 'manual', ['manual:install-hetzner-live']), calls: string[][] = [];
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    const secret = token.replaceAll("'", '');
    assert.ok(!calls.flat().some(word => word.includes(secret) || word.includes('ghp_never') || /^(HCLOUD_TOKEN|HETZNER_SPEND_CAP_USD_MONTHLY)=/.test(word)), 'no Herdr argument carries a secret');
    const typed = expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
    assert.deepEqual(typed.words.slice(0, 6), ['sh', '-c', 'set -a; . "$1"; set +a; shift 2; exec "$@"', 'sh', join(launched.checkout, 'producer.env'), '--']);
    assert.equal(typed.kind, 'codex', 'the runtime is what the wrapper execs');
    assert.equal(await readFile(join(launched.checkout, 'producer.env'), 'utf8'), `HCLOUD_TOKEN='${secret}'\nHETZNER_SPEND_CAP_USD_MONTHLY='25'\n`);
  } finally { await cleanup(); }
});

test('integration:producer-environment a live-install launch on a host without its .env values is refused before any session or record exists', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    const item = work('GY-73', 'manual', ['manual:install-hetzner-live']), calls: string[][] = [];
    await assert.rejects(launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable }),
      /refuses to launch the GY-73 manual proofs .*HCLOUD_TOKEN is not set in .*\.env.*docs\/install\.md/);
    assert.deepEqual(calls, [], 'Herdr was never asked for a tab');
    assert.deepEqual((await readProducerLedger(root)).producers, []);
  } finally { await cleanup(); }
});

test('integration:producer-environment a headless producer receives the .env secrets in its run environment', async () => {
  const { root, cleanup } = await installation(true);
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc\nHETZNER_SPEND_CAP_USD_MONTHLY=25\nGITHUB_TOKEN=ghp_never\n');
    const seen: RunOptions<unknown>[] = [];
    const runner: Runner = { name: 'fake', start<T>(_prompt: string, options: RunOptions<T>) {
      seen.push(options as RunOptions<unknown>);
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: 'test' }, payloads: [] }) };
    } };
    const item = work('GY-74', 'unit', ['unit:install-plan']);
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { runner, filesystem: durable }) as any;
    await launched.settled.catch(() => {});
    assert.equal(seen[0].env?.HCLOUD_TOKEN, 'abc');
    assert.equal(seen[0].env?.HETZNER_SPEND_CAP_USD_MONTHLY, '25');
    assert.equal(seen[0].env?.GITHUB_TOKEN, undefined);
  } finally { await cleanup(); }
});
