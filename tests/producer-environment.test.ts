import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { loadMasterConfig, masterConfigSchema, saveProducerProfile, setupMaster } from '../src/master.js';
import { emptyDispatchCursor, runDispatchTick, dispatchFailureLimit, dispatchRetryMaxMs, dispatchRetryMinMs, type DispatchEffects } from '../src/auto-dispatch.js';
import { ClosedQuestionsDecided, launchProducer, missingProducerEnv, needsProducerEnv, parseEnvValue, producerPrompt, producerSecretsPrefix, readProducerEnvironment, readProducerLedger } from '../src/producer.js';
import { liveInstallProof, piProducerPrompt } from '../src/runner/roles.js';
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
  assert.equal(parseEnvValue('"a\\"b"'), 'a"b', 'a backslash-escaped quote inside double quotes is part of the value, as in sh');
  assert.equal(parseEnvValue('"a\\\\" # note'), 'a\\', 'an escaped backslash does not escape the closing quote');
  assert.equal(parseEnvValue('"a\\nb"'), 'a\\nb', 'a backslash before any other character is kept');
  assert.equal(parseEnvValue("'a\\'"), 'a\\', 'single quotes take a backslash literally');
  assert.equal(parseEnvValue('a\\ b'), 'a b', 'an unquoted backslash escapes the following character as in sh');
  assert.equal(parseEnvValue('a\\\\b'), 'a\\b', 'an unquoted backslash can escape a backslash');
  assert.equal(parseEnvValue('a\\ b # note'), 'a b', 'an unquoted value with backslash-escaped space before a comment');
  for (const unpaired of ['"abc', "abc'", '"abc\'', 'a"bc', '"abc"def', '"abc\\"', 'a\\'])
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
    // A file already there, readable by others, is replaced by a new file, never rewritten under its old mode.
    await writeFile(join(directory, 'producer.env'), 'stale\n', { mode: 0o644 });
    const prefix = await producerSecretsPrefix(directory, { HCLOUD_TOKEN: token, HETZNER_SPEND_CAP_USD_MONTHLY: '25' });
    assert.ok(!prefix.some(word => word.includes(token)), 'the value is on no command line');
    assert.equal((await stat(join(directory, 'producer.env'))).mode & 0o777, 0o600);
    const printed = execFileSync(prefix[0], [...prefix.slice(1), process.execPath, '-e', 'process.stdout.write(JSON.stringify([process.env.HCLOUD_TOKEN, process.env.HETZNER_SPEND_CAP_USD_MONTHLY]))'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(printed), [token, '25']);
  } finally { await cleanup(); }
});

test('unit:producer-environment a secret holding a line break is refused before any file is written', async () => {
  const { directory, cleanup } = await scratch();
  try {
    for (const value of ['a\nexport X=1', 'a\rb', 'a\0b']) {
      await assert.rejects(producerSecretsPrefix(directory, { HCLOUD_TOKEN: value }), (error: Error) => /HCLOUD_TOKEN/.test(error.message) && !error.message.includes(value), 'refused, naming the variable but never its value');
      await assert.rejects(stat(join(directory, 'producer.env')), { code: 'ENOENT' }, 'nothing is written');
    }
  } finally { await cleanup(); }
});

test('unit:producer-environment a live-install proof names each .env value it lacks; other proofs need none', () => {
  for (const proof of ['manual:install-hetzner-live', 'manual:host-install-live']) {
    assert.deepEqual(missingProducerEnv([proof], {}), ['HCLOUD_TOKEN', 'HETZNER_SPEND_CAP_USD_MONTHLY']);
    assert.deepEqual(missingProducerEnv([proof], { HCLOUD_TOKEN: 'x' }), ['HETZNER_SPEND_CAP_USD_MONTHLY']);
    assert.deepEqual(missingProducerEnv([proof], { HCLOUD_TOKEN: 'x', HETZNER_SPEND_CAP_USD_MONTHLY: '5' }), []);
    assert.equal(needsProducerEnv(['unit:install-plan', proof]), true);
  }
  assert.deepEqual(missingProducerEnv(['manual:install-railway-live', 'unit:install-plan'], {}), []);
  assert.equal(needsProducerEnv(['manual:install-railway-live', 'unit:install-plan', 'integration:x']), false, '.env is read only for a proof that needs it');
});

test('unit:host-install-live-producer-env needsProducerEnv and missingProducerEnv treat manual:host-install-live as a live-install proof', () => {
  assert.deepEqual(missingProducerEnv(['manual:host-install-live'], {}), ['HCLOUD_TOKEN', 'HETZNER_SPEND_CAP_USD_MONTHLY']);
  assert.deepEqual(missingProducerEnv(['manual:host-install-live'], { HCLOUD_TOKEN: 'x' }), ['HETZNER_SPEND_CAP_USD_MONTHLY']);
  assert.deepEqual(missingProducerEnv(['manual:host-install-live'], { HETZNER_SPEND_CAP_USD_MONTHLY: '5' }), ['HCLOUD_TOKEN']);
  assert.deepEqual(missingProducerEnv(['manual:host-install-live'], { HCLOUD_TOKEN: 'x', HETZNER_SPEND_CAP_USD_MONTHLY: '5' }), []);
  assert.equal(needsProducerEnv(['manual:host-install-live']), true);
  assert.equal(needsProducerEnv(['unit:install-plan', 'manual:host-install-live']), true);
  assert.equal(needsProducerEnv(['manual:install-railway-live', 'unit:install-plan', 'integration:x']), false, 'proofs that provision nothing still read no .env');
  assert.deepEqual(missingProducerEnv(['manual:install-railway-live', 'unit:install-plan'], {}), []);
});

test('unit:host-install-live-producer-env a launch for manual:host-install-live reads .env, passes both names to the producer, and is refused when .env lacks one', async () => {
  const { root, cleanup } = await installation();
  try {
    const item = work('GY-717', 'manual', ['manual:host-install-live']);
    let calls: string[][] = [];

    // Refused before any session when the host's .env lacks one (missing HCLOUD_TOKEN)
    await writeFile(join(root, '.env'), 'HETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    await assert.rejects(
      launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable }),
      /refuses to launch the GY-717 manual proofs .*HCLOUD_TOKEN is not set in .*\.env.*docs\/install\.md/
    );
    assert.deepEqual(calls, [], 'Herdr was never asked for a tab');
    assert.deepEqual((await readProducerLedger(root)).producers, []);

    // Refused before any session when the host's .env lacks one (missing HETZNER_SPEND_CAP_USD_MONTHLY)
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc\n');
    await assert.rejects(
      launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable }),
      /refuses to launch the GY-717 manual proofs .*HETZNER_SPEND_CAP_USD_MONTHLY is not set in .*\.env.*docs\/install\.md/
    );
    assert.deepEqual(calls, [], 'Herdr was never asked for a tab');
    assert.deepEqual((await readProducerLedger(root)).producers, []);

    // A launch for it reads .env and passes both names to the producer
    const secret = token.replaceAll("'", '');
    await writeFile(join(root, '.env'), `HCLOUD_TOKEN='${secret}'\nHETZNER_SPEND_CAP_USD_MONTHLY=25\nGITHUB_TOKEN=ghp_never\n`);
    calls = [];
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    assert.ok(!calls.flat().some(word => word.includes(secret) || word.includes('ghp_never') || /^(HCLOUD_TOKEN|HETZNER_SPEND_CAP_USD_MONTHLY)=/.test(word)), 'no Herdr argument carries a secret');
    const typed = expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
    assert.deepEqual(typed.words.slice(0, 6), ['sh', '-c', 'set -a; . "$1"; set +a; shift 2; exec "$@"', 'sh', join(launched.checkout, 'producer.env'), '--']);
    assert.equal(typed.kind, 'codex', 'the runtime is what the wrapper execs');
    assert.equal(await readFile(join(launched.checkout, 'producer.env'), 'utf8'), `HCLOUD_TOKEN='${secret}'\nHETZNER_SPEND_CAP_USD_MONTHLY='25'\n`);
    assert.ok(relative(join(launched.checkout, 'checkout'), join(launched.checkout, 'producer.env')).startsWith('..'), 'producer.env is outside the git checkout');

    // Proofs that provision nothing still read no .env: a malformed .env does not refuse them, and no secrets file is created
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN="unpaired\nHETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    const noProvisionItem = work('GY-75', 'manual', ['manual:install-railway-live']);
    calls = [];
    const noProvisionLaunched = await launchProducer(root, noProvisionItem, noProvisionItem.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    const noProvisionTyped = expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
    assert.notEqual(noProvisionTyped.words[0], 'sh', 'no secrets wrapper');
    assert.ok(!calls.flat().some(word => word.includes('HETZNER_SPEND_CAP_USD_MONTHLY')));
    await assert.rejects(stat(join(noProvisionLaunched.checkout, 'producer.env')), { code: 'ENOENT' });
  } finally { await cleanup(); }
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
    // The file is in the session directory, beside the git checkout the producer works in, so nothing
    // run in that checkout can stage it.
    assert.ok(relative(join(launched.checkout, 'checkout'), join(launched.checkout, 'producer.env')).startsWith('..'), 'producer.env is outside the git checkout');
  } finally { await cleanup(); }
});

test('integration:producer-environment a launch whose proofs need no secret neither reads .env nor gets a secrets file', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN="unpaired\nHETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    const item = work('GY-75', 'manual', ['manual:install-railway-live']), calls: string[][] = [];
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    const typed = expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
    assert.notEqual(typed.words[0], 'sh', 'no secrets wrapper');
    assert.ok(!calls.flat().some(word => word.includes('HETZNER_SPEND_CAP_USD_MONTHLY')));
    await assert.rejects(stat(join(launched.checkout, 'producer.env')), { code: 'ENOENT' });
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

test('integration:producer-environment a live-install proof a closed question decides needs no .env, and one it leaves is still refused', async () => {
  const { root, cleanup } = await installation();
  try {
    const item = work('GY-73', 'manual', ['manual:install-hetzner-live']), calls: string[][] = [], config = (await loadMasterConfig(root)).producers[0];
    (item as any).closedQuestions = [{ criterion: 'AC-1', proof: 'manual:install-hetzner-live', question: 'Installed?', criteria: ['yes', 'no'], pass: 'yes', state: [{ kind: 'criterion' }] }];
    const launch = (verdict: 'decided' | 'escalated') => launchProducer(root, item, item.autoDispatch!.producers[0] as any, config, [], new Date().toISOString(),
      { run: herdr(calls), filesystem: durable, judge: async () => ({ verdict }) });
    // No .env on this host: a decided proof launches no session, so it is not refused for want of a credential.
    await assert.rejects(launch('decided'), (error: Error) => error instanceof ClosedQuestionsDecided && !/HCLOUD_TOKEN/.test(error.message));
    await assert.rejects(launch('escalated'), /refuses to launch the GY-73 manual proofs .*HCLOUD_TOKEN and HETZNER_SPEND_CAP_USD_MONTHLY are not set/);
    assert.deepEqual(calls, [], 'Herdr was never asked for a tab');
    assert.deepEqual((await readProducerLedger(root)).producers, []);
  } finally { await cleanup(); }
});

test('integration:producer-environment a headless unit producer gets no .env secret, and a malformed .env does not refuse it', async () => {
  const { root, cleanup } = await installation(true);
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN="unpaired\nHETZNER_SPEND_CAP_USD_MONTHLY=25\nGITHUB_TOKEN=ghp_never\n');
    const seen: RunOptions<unknown>[] = [];
    const runner: Runner = { name: 'fake', start<T>(_prompt: string, options: RunOptions<T>) {
      seen.push(options as RunOptions<unknown>);
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => ({ ok: false as const, failure: { reason: 'no-payload' as const, detail: 'test' }, payloads: [] }) };
    } };
    const item = work('GY-74', 'unit', ['unit:install-plan']);
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { runner, filesystem: durable }) as any;
    await launched.settled.catch(() => {});
    assert.equal(seen.length, 1, 'the run started');
    assert.equal(seen[0].env?.HCLOUD_TOKEN, undefined);
    assert.equal(seen[0].env?.HETZNER_SPEND_CAP_USD_MONTHLY, undefined);
    assert.equal(seen[0].env?.GITHUB_TOKEN, undefined);
  } finally { await cleanup(); }
});

test('integration:producer-environment the dispatcher records a missing-credential refusal once per attempt on its backoff, and launches once .env is provisioned', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    const config = await loadMasterConfig(root), item = work('GY-73', 'manual', ['manual:install-hetzner-live']), calls: string[][] = [];
    let clock = Date.parse('2026-10-02T00:00:00Z'), launches = 0;
    const effects: DispatchEffects = {
      snapshot: async () => ({ work: [item], now: new Date(clock).toISOString() }), agents: () => [],
      credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }), launchReview: async () => {},
      launchProducer: (work, request, profile, agents, observedAt) => { launches++; return launchProducer(root, work, request, profile, agents, observedAt, { run: herdr(calls), filesystem: durable }); },
      persist: async () => {},
    };
    const cursor = emptyDispatchCursor(config), requestId = item.autoDispatch!.producers[0].id;
    const first = await runDispatchTick(config, cursor, effects, () => clock);
    assert.equal(first.refused.length, 1); assert.equal(first.refused[0].attempts, 1);
    assert.match(first.refused[0].reason, /HCLOUD_TOKEN is not set/);
    assert.deepEqual(calls, [], 'no tab was created');
    clock += 1000;
    const held = await runDispatchTick(config, cursor, effects, () => clock);
    assert.equal(launches, 1, 'inside the backoff the refusal is not retried');
    assert.match(held.waiting[0].reason, /launch refused 1 time\(s\): .*HCLOUD_TOKEN is not set.*next attempt at/);
    // Each later attempt is one more refusal, until the limit stops automatic attempts.
    while (cursor.failures[requestId].attempts < dispatchFailureLimit) { clock += dispatchRetryMaxMs + 1; await runDispatchTick(config, cursor, effects, () => clock); }
    assert.equal(launches, dispatchFailureLimit);
    clock += dispatchRetryMaxMs + 1;
    const stopped = await runDispatchTick(config, cursor, effects, () => clock);
    assert.equal(launches, dispatchFailureLimit); assert.match(stopped.waiting[0].reason, /no further automatic attempt/);
    // Provisioned within the limit, the next attempt launches and clears the failure.
    cursor.failures[requestId] = { ...cursor.failures[requestId], attempts: 1, nextAt: new Date(clock).toISOString() };
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc\nHETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    clock += dispatchRetryMinMs;
    const launched = await runDispatchTick(config, cursor, effects, () => clock);
    assert.equal(launched.launched.length, 1); assert.equal(cursor.failures[requestId], undefined);
  } finally { await cleanup(); }
});

// GY-1170: manual:host-install-live provisions a real Hetzner server too, so it is a live-install
// proof by the one match every producer path reads, and the session has an SSH key for the adapter.
test('unit:host-install-live-receives-producer-env every Hetzner live-install proof needs the .env credential, by one match', () => {
  for (const proof of ['manual:install-hetzner-live', 'manual:host-install-live']) {
    assert.equal(liveInstallProof(proof), true, proof);
    assert.equal(needsProducerEnv(['unit:install-plan', proof]), true, proof);
    assert.deepEqual(missingProducerEnv([proof], {}), ['HCLOUD_TOKEN', 'HETZNER_SPEND_CAP_USD_MONTHLY'], proof);
    assert.deepEqual(missingProducerEnv([proof], { HCLOUD_TOKEN: 'x', HETZNER_SPEND_CAP_USD_MONTHLY: '5' }), [], proof);
  }
  for (const proof of ['manual:install-railway-live', 'manual:speed-ci-proofs-live', 'manual:throughput-without-master-live', 'manual:gap-live-witness', 'unit:host-install-live', 'manual:install-plan'])
    assert.equal(needsProducerEnv([proof]), false, proof);
});

test('unit:host-install-live-receives-producer-env a manual:host-install-live session gets the secrets through its 0600 env file and the instructions naming them', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc123\nHETZNER_SPEND_CAP_USD_MONTHLY=25\nGITHUB_TOKEN=ghp_never\n');
    const item = work('GY-717', 'manual', ['manual:host-install-live']), calls: string[][] = [];
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    const typed = expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
    assert.deepEqual(typed.words.slice(0, 6), ['sh', '-c', 'set -a; . "$1"; set +a; shift 2; exec "$@"', 'sh', join(launched.checkout, 'producer.env'), '--']);
    assert.equal(await readFile(join(launched.checkout, 'producer.env'), 'utf8'), `HCLOUD_TOKEN='abc123'\nHETZNER_SPEND_CAP_USD_MONTHLY='25'\n`);
    assert.equal((await stat(join(launched.checkout, 'producer.env'))).mode & 0o777, 0o600);
    assert.ok(!calls.flat().some(word => word.includes('abc123') || word.includes('ghp_never')), 'no Herdr argument carries a secret');
    const prompt = producerPrompt({ repository: 'owner/project', cliPath: launcher }, { ...item.autoDispatch!.producers[0] as any, key: 'GY-717', checkout: launched.checkout }, { principal: 'proof-runner' });
    assert.match(prompt, /live install proofs \(manual:host-install-live\), HCLOUD_TOKEN and HETZNER_SPEND_CAP_USD_MONTHLY are available in your environment/);
    assert.doesNotMatch(producerPrompt({ repository: 'owner/project', cliPath: launcher }, { ...item.autoDispatch!.producers[0] as any, key: 'GY-717', proofs: ['manual:install-railway-live'], checkout: launched.checkout }, { principal: 'proof-runner' }), /HCLOUD_TOKEN/);
  } finally { await cleanup(); }
});

test('unit:host-install-live-receives-producer-env a manual:host-install-live launch on a host whose .env lacks a value is refused with the host-configuration message', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc123\n');
    const item = work('GY-717', 'manual', ['manual:host-install-live']), calls: string[][] = [];
    await assert.rejects(launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable }),
      /refuses to launch the GY-717 manual proofs \(manual:host-install-live\): HETZNER_SPEND_CAP_USD_MONTHLY is not set in .*\.env.*docs\/install\.md/);
    assert.deepEqual(calls, [], 'Herdr was never asked for a tab');
    assert.deepEqual((await readProducerLedger(root)).producers, []);
  } finally { await cleanup(); }
});

test('unit:live-install-ssh-key-available HETZNER_SSH_KEY in .env reaches the live-install session, which is told to pass it', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc123\nHETZNER_SPEND_CAP_USD_MONTHLY=25\nHETZNER_SSH_KEY="operator key"\n');
    assert.deepEqual(await readProducerEnvironment(root), { HCLOUD_TOKEN: 'abc123', HETZNER_SPEND_CAP_USD_MONTHLY: '25', HETZNER_SSH_KEY: 'operator key' });
    const item = work('GY-717', 'manual', ['manual:host-install-live']), calls: string[][] = [];
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    const typed = expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
    const printed = execFileSync(typed.words[0], [...typed.words.slice(1, 6), process.execPath, '-e', 'process.stdout.write(process.env.HETZNER_SSH_KEY ?? "")'], { encoding: 'utf8' });
    assert.equal(printed, 'operator key', 'the session environment carries the key name');
    const prompt = producerPrompt({ repository: 'owner/project', cliPath: launcher }, { ...item.autoDispatch!.producers[0] as any, key: 'GY-717', checkout: launched.checkout }, { principal: 'proof-runner' });
    assert.match(prompt, /If HETZNER_SSH_KEY is set in your environment, pass --ssh-key "\$HETZNER_SSH_KEY"/);
  } finally { await cleanup(); }
});

test('unit:live-install-ssh-key-available without HETZNER_SSH_KEY the launch is not refused and the instructions register and delete a throwaway key', async () => {
  const { root, cleanup } = await installation();
  try {
    await writeFile(join(root, '.env'), 'HCLOUD_TOKEN=abc123\nHETZNER_SPEND_CAP_USD_MONTHLY=25\n');
    assert.deepEqual(missingProducerEnv(['manual:host-install-live'], { HCLOUD_TOKEN: 'x', HETZNER_SPEND_CAP_USD_MONTHLY: '5' }), [], 'the key name is never required');
    const item = work('GY-717', 'manual', ['manual:host-install-live']), calls: string[][] = [];
    const launched = await launchProducer(root, item, item.autoDispatch!.producers[0] as any, (await loadMasterConfig(root)).producers[0], [], new Date().toISOString(), { run: herdr(calls), filesystem: durable });
    const prompt = producerPrompt({ repository: 'owner/project', cliPath: launcher }, { ...item.autoDispatch!.producers[0] as any, key: 'GY-717', checkout: launched.checkout }, { principal: 'proof-runner' });
    const name = `graphyard-gy-717-${H.slice(0, 8)}`;
    assert.ok(prompt.includes(`ssh-keygen -t ed25519 -N '' -C ${name} -f ${join(launched.checkout, 'hetzner-ssh-key')}`), 'the key is generated inside the session directory');
    assert.ok(prompt.includes(`hcloud ssh-key create --name ${name} --public-key-from-file ${join(launched.checkout, 'hetzner-ssh-key')}.pub`), 'registered with the provided HCLOUD_TOKEN');
    assert.ok(prompt.includes(`pass --ssh-key ${name}`));
    assert.ok(prompt.includes(`hcloud ssh-key delete ${name}`), 'and deleted afterwards');
    const pi = piProducerPrompt({ repository: 'owner/project' }, { ...item.autoDispatch!.producers[0] as any, key: 'GY-717' }, item.criteria, { directory: launched.checkout, worktree: join(launched.checkout, 'checkout') }, root);
    assert.ok(pi.includes(`hcloud ssh-key delete ${name}`), 'a headless producer prompt reads the same guidance');
  } finally { await cleanup(); }
});
