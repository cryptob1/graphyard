import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { workerLaunchStatus } from '../src/master/dispatch.js';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1850: reviewer profiles exist before the first review, and a review launch refused for an
 * unknown profile is the configuration fault it is. Two proofs:
 * - unit:up-writes-profiles: `up`'s accounts step runs the same profile write `master environments
 *   --apply` runs, and the accounts checklist lines are green only once a worker and a reviewer
 *   profile exist.
 * - unit:unknown-profile-escalates: three consecutive review launches refused for an unknown
 *   reviewer profile raise one configuration attention naming the profile and the command that
 *   writes the profiles; the launch boundary then backs off to one attempt every five minutes
 *   until the profiles change, and a launch past the profile lookup clears the fault.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('c1'), B = sha40('b1');
const UP_SERVER = 'http://127.0.0.1:4310', UP_ADMIN = 'a'.repeat(40);

/** A master checkout with its own credential directory and no reviewer profiles yet. */
async function reviewerMaster(label: string) {
  const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-cred`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials }, coordinator as typeof fetch);
  return root;
}

/** A control-plane-observed item, so a launch needs no reviewer App to reach the profile lookup; review itself is not required, so a launch past the lookup stops there. */
function work(clock: number): Work {
  const candidate = { sha: H, baseSha: B, pr: 1850, branch: 'graphyard/gy-1850-1', author: 'implementer' };
  const at = new Date(clock).toISOString();
  return {
    id: 'work-1850', key: 'GY-1850', title: 'Reviewer profiles before the first review', description: '', type: 'bug', priority: 0, dependencies: [],
    plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Review', proofs: ['unit:x'] }],
    policy: { checks: [], review: false }, stage: 'review', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 1850 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { source: 'control-plane', candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true },
    blocker: null, gates: [], violations: [],
  } as unknown as Work;
}

test('unit:unknown-profile-escalates — three review launches refused for an unknown reviewer profile raise one configuration attention naming the profile and graphyard master environments --apply, later attempts back off to once per five minutes until the profiles change, and the attention rides master status', async () => {
  const root = await reviewerMaster('unknown-reviewer-profile');
  // Late-bound so the file loads, and its cases fail, on a tree without the change (the proof's exercise).
  const { readReviewerProfileRefusal, reviewerProfileRefusalAttention } = await import('../src/reviewer.js');
  let clock = 1_700_000_000_000;
  const launch = (name: string) => launchReview(root, work(clock), name, [], new Date(clock).toISOString(), { now: () => new Date(clock) });
  const config = await loadMasterConfig(root);
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });

  // Three consecutive launches refused for the one unknown profile: each is counted, the last attempt dated.
  await assert.rejects(launch('review-codex'), /^Error: Unknown reviewer profile review-codex$/);
  await assert.rejects(launch('review-codex'), /^Error: Unknown reviewer profile review-codex$/);
  await assert.rejects(launch('review-codex'), /^Error: Unknown reviewer profile review-codex$/);
  const counted = await readReviewerProfileRefusal(config);
  assert.equal(counted?.profile, 'review-codex');
  assert.equal(counted?.refusals, 3);
  assert.equal(counted?.at, new Date(clock).toISOString());

  // One configuration attention: the profile named, the command that writes the profiles named, owned by the master, classified setup/configuration.
  const [attention] = reviewerProfileRefusalAttention(await readReviewerProfileRefusal(config));
  assert.ok(attention, 'the attention stands at the limit');
  assert.match(attention.subject, /review-codex/);
  assert.match(attention.text, /graphyard master environments --apply/);
  assert.equal(attention.next, 'Run graphyard master environments --apply; it writes the reviewer and worker profiles, and the loop\'s next review launch succeeds and clears this');
  assert.equal(attention.role, 'master');
  assert.equal(attention.human, false);
  assert.equal(attention.kind, 'setup');
  assert.equal(attention.faultClass, 'configuration');
  // Before the limit it stands down: the dispatcher's first widening retries are answer enough.
  assert.deepEqual(reviewerProfileRefusalAttention({ version: 1, profile: 'review-codex', refusals: 2, at: counted!.at, profiles: counted!.profiles }), []);
  // The profiles changed since the refusals (the missing one written, no launch yet to clear the record): the stale record raises nothing.
  assert.deepEqual(reviewerProfileRefusalAttention(counted, { workers: config.workers, reviewers: [...config.reviewers, { name: 'review-codex', agentName: 'review-codex-1', kind: 'codex' }] as typeof config.reviewers }), [], 'a record of profiles since changed is stale');
  // master status carries it beside the never-starting accounts (GY-417's wiring).
  const status = await workerLaunchStatus(root, await loadMasterConfig(root));
  assert.ok(status.items.some(item => item.subject === attention.subject && item.text.includes('graphyard master environments --apply')), 'master status raises the configuration attention');

  // Inside five minutes the launch boundary refuses the knock without making an attempt: nothing is recounted, the last attempt stands.
  clock += 60_000;
  await assert.rejects(launch('review-codex'), /refused 3 launches in a row.*backing off to one attempt every 5 minutes until the profiles change — write them with graphyard master environments --apply/);
  const held = await readReviewerProfileRefusal(config);
  assert.equal(held?.refusals, 3, 'a knock inside the window counts no attempt');
  assert.equal(held?.at, counted?.at);

  // Past five minutes the boundary attempts again: the refusal is counted and dated now.
  clock += 5 * 60_000;
  await assert.rejects(launch('review-codex'), /^Error: Unknown reviewer profile review-codex$/);
  const again = await readReviewerProfileRefusal(config);
  assert.equal(again?.refusals, 4);
  assert.equal(again?.at, new Date(clock).toISOString());

  // The profiles change: review-codex exists, the launch gets past the profile lookup, and the record — with it the attention and the backoff — is gone.
  clock += 60_000;
  await saveReviewerProfile(root, { name: 'review-codex', agentName: 'review-codex-1', kind: 'codex' });
  await assert.rejects(launch('review-codex'), /does not require independent review/, 'the launch is refused no longer for the profile but by the item itself');
  assert.equal(await readReviewerProfileRefusal(config), null, 'the profiles changed, so the fault is over');
  assert.deepEqual(reviewerProfileRefusalAttention(await readReviewerProfileRefusal(config)), []);
  assert.equal((await workerLaunchStatus(root, await loadMasterConfig(root))).items.length, 0, 'master status raises no attention once the profiles are written');
});

// Review thread on 28d1bbcb642f (reviewer.ts): a replacement profile the dispatcher now selects launches, so the obsolete record clears too.
test('unit:unknown-profile-escalates — a launch through a replacement profile clears the refusal of the old name, so no obsolete attention stands while reviews launch', async () => {
  const root = await reviewerMaster('unknown-reviewer-profile-replaced');
  const { readReviewerProfileRefusal } = await import('../src/reviewer.js');
  const clock = 1_700_000_000_000;
  const launch = (name: string) => launchReview(root, work(clock), name, [], new Date(clock).toISOString(), { now: () => new Date(clock) });
  await saveReviewerProfile(root, { name: 'review-y', agentName: 'review-y-1', kind: 'claude' });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(launch('review-x'), /^Error: Unknown reviewer profile review-x$/);
  const config = await loadMasterConfig(root);
  assert.equal((await readReviewerProfileRefusal(config))?.refusals, 3);
  await assert.rejects(launch('review-y'), /does not require independent review/, 'the replacement gets past the profile lookup');
  assert.equal(await readReviewerProfileRefusal(config), null, 'the old name\'s record is gone once a review launches');
  assert.equal((await workerLaunchStatus(root, await loadMasterConfig(root))).items.length, 0);
});

/** The private file the refusals are counted in: beside the master credential, outside the checkout. */
test('unit:unknown-profile-escalates — the refusal record lives beside the master credential at 0600, never in the checkout', async () => {
  const root = await reviewerMaster('unknown-reviewer-profile-file');
  const { stat } = await import('node:fs/promises');
  const { reviewerProfileRefusalPath } = await import('../src/reviewer.js');
  const config = await loadMasterConfig(root);
  let clock = 1_700_000_000_000;
  await assert.rejects(launchReview(root, work(clock), 'review-codex', [], new Date(clock).toISOString(), { now: () => new Date(clock) }), /Unknown reviewer profile/);
  const file = reviewerProfileRefusalPath(config);
  assert.match(file, /^.+\.reviewer-profile-refusals\.json$/);
  assert.ok(!file.startsWith(root), 'the record is outside the checkout, beside the credential');
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'the record is private');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'profile', 'profiles', 'refusals', 'version']);
});

// GY-1850 AC-1: the accounts step writes the profiles before the loop starts, and the checklist answers for them.
// Every wait is bounded, so a tree without the change fails these cases rather than waiting on them.
const request = (extra: Partial<UpRequest> = {}): UpRequest => ({ waitMs: 20, repository: 'owner/project', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, merger: 'control-plane', ...extra });

/** Minimal master.json, as install --apply leaves it: configured, with no reviewer or worker profiles yet. */
const bareMasterConfig = (credentialFile: string) => ({ version: 1, url: UP_SERVER, credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 0, hostId: 'test-host', masterAgentName: 'master-1', workers: [], reviewers: [], producers: [] });

/** An agent-mode control-plane world: install writes master.json, the proposal readies the fleet, and `master environments --apply` writes what PROFILES says. */
function upWorld(checkout: string, events: UpEvent[], profiles: { workers: number; reviewers: number } | null) {
  let installed = false, fleetReady = false, loop = false, clock = 0;
  const calls: string[][] = [];
  /** A self-contained host's write (`install --profiles-only`): what the host's master environments --apply reports, its master.json being the host's. */
  const hostReport = () => ({ host: 'gy-host', profiles: { counts: { environments: 1, loggedIn: 1, workers: profiles?.workers ?? 0, reviewers: profiles?.reviewers ?? 0, producers: 0 } } });
  const writeProfiles = async () => {
    const file = join(checkout, '.graphyard/master.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.reviewers = Array.from({ length: profiles?.reviewers ?? 0 }, (_, index) => ({ name: `review-claude-${index}`, agentName: `review-claude-${index + 1}`, kind: 'claude' }));
    config.workers = Array.from({ length: profiles?.workers ?? 0 }, (_, index) => ({ name: `claude-${index + 1}`, principal: `owner-project-worker-${index + 1}`, agentName: `worker-claude-${index + 1}`, mode: 'launch', kind: 'claude', credentialFile: `/creds/worker-${index + 1}.token` }));
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  };
  return {
    calls,
    deps: {
      root: checkout, pollMs: 1, emit: event => { events.push(event); },
      now: () => clock, sleep: async ms => { clock += ms; },
      serverUrl: async () => installed ? UP_SERVER : null,
      masterToken: async () => installed ? 'm'.repeat(40) : null,
      operatorToken: async () => UP_ADMIN,
      signIn: async () => null,
      status: async () => installed ? {
        repository: 'owner/project', mergeWriter: { merger: 'control-plane' },
        fleet: fleetReady
          ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] }
          : { roles: [], accounts: [] },
        setup: { protection: 'off', loop },
      } : null,
      publishOnboarding: async () => null,
      onboardingMerged: async () => true,
      installDirectory: () => join(checkout, 'install-dir'),
      ensureDeployKey: async (installDir: string, repository: string) => join(installDir, 'deploy-key'),
      setMerger: async () => {},
      gh: async args => args[0] === 'repo' && args[1] === 'view' ? { code: 0, stdout: '{"name":"project"}' } : { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` },
      async cli(args) {
        calls.push(args);
        const joined = args.join(' ');
        if (args[0] === 'install' && args.includes('--profiles-only')) return { code: 0, stdout: JSON.stringify(hostReport()) };
        if (args[0] === 'install' && args.includes('--plan')) {
          return { code: 0, stdout: JSON.stringify({ installId: 'owner-project', installDirectory: join(checkout, 'install-dir'), principals: [{ id: 'owner-project-operator', role: 'admin', sessionKind: 'human' }], preflight: [{ name: 'GitHub CLI', ok: true }], browserApps: [] }) };
        }
        if (args[0] === 'install' && args.includes('--apply')) {
          installed = true;
          // What install --apply leaves behind: the configured checkout, with no profiles yet.
          await mkdir(join(checkout, '.graphyard'), { recursive: true });
          await writeFile(join(checkout, '.graphyard/master.json'), JSON.stringify(bareMasterConfig(join(checkout, 'install-dir', 'master.token'))), { mode: 0o600 });
          return { code: 0, stdout: JSON.stringify({ ok: true, installDirectory: join(checkout, 'install-dir'), principals: [{ id: 'owner-project-operator', role: 'admin' }] }) };
        }
        if (joined === 'master registry propose --apply') { fleetReady = true; return { code: 0, stdout: '{}' }; }
        if (joined === 'master environments --apply') {
          await writeProfiles();
          return { code: 0, stdout: JSON.stringify({ counts: { environments: 1, loggedIn: 1, workers: profiles?.workers ?? 0, reviewers: profiles?.reviewers ?? 0, producers: 0 } }) };
        }
        if (joined === 'master restart') { loop = true; return { code: 0, stdout: '{}' }; }
        return { code: 0, stdout: '{}' };
      },
    } as UpDependencies,
  };
}

test('unit:up-writes-profiles — up\'s accounts step runs the profile write master environments --apply, so master.json holds a reviewer and a worker profile, and an account line is not green while either is missing', async () => {
  const { runUp } = await import('../src/up.js');

  // The host has logged-in environments: the write puts a reviewer and a worker profile in master.json, and the accounts step ends green.
  const checkout = await temporaryDirectory('up-writes-profiles');
  const events: UpEvent[] = [];
  const world = upWorld(checkout, events, { workers: 1, reviewers: 1 });
  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  const order = world.calls.map(args => args.join(' '));
  assert.ok(order.includes('master environments --apply'), 'the accounts step runs the profile write');
  assert.ok(order.indexOf('master registry propose --apply') < order.indexOf('master environments --apply'), 'the profile write follows the registry proposal');
  const stored = JSON.parse(await readFile(join(checkout, '.graphyard/master.json'), 'utf8'));
  assert.ok(stored.reviewers.length >= 1, 'master.json holds a reviewer profile for the logged-in environment');
  assert.ok(stored.workers.some((worker: { mode?: string }) => worker.mode === 'launch'), 'master.json holds a worker profile');
  for (const id of ['account:worker', 'account:reviewer'] as const) assert.equal(result.checklist.find(item => item.id === id)?.done, true, `${id} is green once both profiles exist`);

  // The write finds no profile to make (nothing logged in verifies): the fleet is green but the account lines are not, and up waits rather than finishing.
  const empty = await temporaryDirectory('up-writes-profiles-empty');
  const emptyEvents: UpEvent[] = [];
  const emptyWorld = upWorld(empty, emptyEvents, { workers: 0, reviewers: 0 });
  const held = await runUp(request({ waitMs: 20 }), emptyWorld.deps);
  assert.equal(held.exitCode, 3, held.next);
  for (const id of ['account:worker', 'account:reviewer'] as const) {
    const item = held.checklist.find(entry => entry.id === id);
    assert.equal(item?.done, false, `${id} is not green while its profile is missing`);
    assert.match(item?.line ?? '', /no agent profile/, `${id} says what is missing in plain language`);
    assert.doesNotMatch(item?.line ?? '', /graphyard|master\.json|--apply/, `${id} names no command or path: the checklist is plain language`);
  }
  assert.ok(emptyEvents.some(event => event.kind === 'step' && event.step === 'accounts' && event.state === 'waiting'), 'the accounts step is a wait, not a failure');
  assert.ok(!held.completed.includes('accounts'), 'the accounts step did not complete');
});

test('unit:up-writes-profiles — supervised setup (up --local) launches no reviewer, so a worker profile alone turns its account line green', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('up-writes-profiles-local');
  const world = upWorld(checkout, [], { workers: 1, reviewers: 0 });
  const result = await runUp(request({ provider: 'local' }), world.deps);
  assert.ok(world.calls.some(args => args.join(' ') === 'master environments --apply'), 'the accounts step runs the profile write');
  assert.equal(result.checklist.find(item => item.id === 'account:worker')?.done, true, result.next);
  assert.ok(result.completed.includes('accounts'), 'the accounts step completes without a reviewer profile');
});

test('unit:up-writes-profiles — a resumed run whose profile write fails stops naming it, rather than passing the account lines unchecked', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('up-writes-profiles-resumed');
  const first = upWorld(checkout, [], { workers: 1, reviewers: 1 });
  assert.equal((await runUp(request(), first.deps)).exitCode, 0);
  const again = upWorld(checkout, [], { workers: 1, reviewers: 1 });
  const cli = again.deps.cli;
  again.deps.cli = async args => args.join(' ') === 'master environments --apply' ? { code: 1, stdout: '', stderr: 'profile write broke' } : cli(args);
  const result = await runUp(request(), again.deps);
  assert.notEqual(result.exitCode, 0, 'the failed write is not swallowed');
  assert.match(result.next ?? '', /accounts/);
});

// Review of 28d1bbcb642f, finding 1: a self-contained host's loop, login homes and master.json are on the host, so the write runs there.
test('unit:up-writes-profiles — on a self-contained host the accounts step writes the profiles there through install --profiles-only, fresh and resumed, and holds the account lines while the host reports either profile missing', async () => {
  const { runUp } = await import('../src/up.js');
  const hostWrite = (args: string[]) => args[0] === 'install' && args.includes('--profiles-only');

  // Fresh: the host reports a reviewer and a worker profile; this machine's checkout writes none.
  const checkout = await temporaryDirectory('up-writes-profiles-host');
  const world = upWorld(checkout, [], { workers: 1, reviewers: 1 });
  const result = await runUp(request({ provider: 'host' }), world.deps);
  assert.ok(world.calls.some(hostWrite), 'the accounts step writes the profiles on the host');
  const written = world.calls.find(hostWrite)!;
  assert.ok(written.includes('--apply') && written.includes('--provider') && written[written.indexOf('--provider') + 1] === 'host', `the write is the host install's: ${written.join(' ')}`);
  assert.ok(!world.calls.some(args => args.join(' ') === 'master environments --apply'), 'nothing is written on this machine for a host install');
  for (const id of ['account:worker', 'account:reviewer'] as const) assert.equal(result.checklist.find(item => item.id === id)?.done, true, `${id}: ${result.next}`);

  // Resumed over the completed accounts step: the host write runs again, and its failure stops the run naming the step.
  const again = upWorld(checkout, [], { workers: 1, reviewers: 1 });
  const cli = again.deps.cli;
  again.deps.cli = async (args, options) => hostWrite(args) ? { code: 1, stdout: '', stderr: 'master environments --apply did not complete on gy-host' } : cli(args, options);
  const failed = await runUp(request({ provider: 'host' }), again.deps);
  assert.notEqual(failed.exitCode, 0, 'the failed host write is not swallowed');
  assert.match(failed.next ?? '', /accounts/);

  // The host has logged-in accounts but its write made no reviewer profile: the account lines are held and up waits.
  const missing = await temporaryDirectory('up-writes-profiles-host-missing');
  const held = await runUp(request({ provider: 'host', waitMs: 20 }), upWorld(missing, [], { workers: 1, reviewers: 0 }).deps);
  assert.equal(held.exitCode, 3, held.next);
  for (const id of ['account:worker', 'account:reviewer'] as const) assert.equal(held.checklist.find(item => item.id === id)?.done, false, `${id} is not green while the host lacks its reviewer profile`);
});

// Review of 4e263adf0b03: --plan prints and changes nothing, so a plan session (any run without --apply) must not write the host's profiles.
test('unit:up-writes-profiles — install --profiles-only refuses a plan session before any host transport, so only --apply writes the profiles there', async () => {
  const { installProfilesOnly } = await import('../src/install/index.js');
  const touched: string[] = [];
  const transport = { exec: async (command: string, args: string[]) => { touched.push([command, ...args].join(' ')); throw new Error('transport exec reached'); } };
  // An apply holds the installation's apply lock (GY-1876), taken under its directory.
  const directory = await temporaryDirectory('up-writes-profiles-lock');
  const session = (mode: 'plan' | 'apply') => ({
    mode, directory, deps: { now: () => 0 }, inputs: { repository: 'owner/project', provider: 'host' }, record: { url: 'https://graphyard.example' },
    context: { provider: 'host', host: { local: true, layout: {} }, transport },
  }) as unknown as Parameters<typeof installProfilesOnly>[0];
  await assert.rejects(installProfilesOnly(session('plan')), /--apply/);
  assert.deepEqual(touched, [], 'a plan session reaches no transport');
  // The same session in apply mode goes on to the host: the write is attempted through its transport.
  await assert.rejects(installProfilesOnly(session('apply')), /transport exec reached/);
  assert.equal(touched.length, 1, `an apply session runs the write on the host: ${touched.join('; ')}`);
});

test('unit:up-writes-profiles — an account signed in while the accounts step waits gets its profile: a write that left a profile missing runs again on each wait, and the step ends green once both exist', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('up-writes-profiles-late');
  const profiles = { workers: 1, reviewers: 0 };
  const world = upWorld(checkout, [], profiles);
  const cli = world.deps.cli;
  let writes = 0;
  world.deps.cli = async (args, options) => {
    // The reviewer account finishes signing in after the step's first write.
    if (args.join(' ') === 'master environments --apply' && ++writes === 2) profiles.reviewers = 1;
    return cli(args, options);
  };
  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(writes >= 2, 'the write ran again while a profile was missing');
  assert.ok(result.completed.includes('accounts'));
  const stored = JSON.parse(await readFile(join(checkout, '.graphyard/master.json'), 'utf8'));
  assert.equal(stored.reviewers.length, 1, 'master.json holds the reviewer profile written during the wait');
});

// Review of eb35104f347d, thread PRRT_kwDOUZby-s6tdp2R: a resumed run whose one write reports no profile waits with the rewrite, not in a later wait that writes nothing.
test('unit:up-writes-profiles — a resumed run over a completed accounts step whose write reports a profile missing writes again while it waits, so an account signed in then gets its profile and the run ends green', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('up-writes-profiles-resumed-late');
  // One world for both passes, so the resumed one sees the installed server and ready fleet the first left.
  const profiles = { workers: 1, reviewers: 1 };
  const world = upWorld(checkout, [], profiles);
  assert.equal((await runUp(request(), world.deps)).exitCode, 0);
  profiles.workers = 0; profiles.reviewers = 0;
  const cli = world.deps.cli;
  let writes = 0;
  world.deps.cli = async (args, options) => {
    // The resumed pass's first write finds nothing signed in; the account finishes signing in before the next.
    if (args.join(' ') === 'master environments --apply' && ++writes === 2) { profiles.workers = 1; profiles.reviewers = 1; }
    return cli(args, options);
  };
  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(writes >= 2, 'the resumed run wrote the profiles again while they were missing');
  for (const id of ['account:worker', 'account:reviewer'] as const) assert.equal(result.checklist.find(item => item.id === id)?.done, true, `${id} is green once the profiles exist`);
});

// Review of eb35104f347d, thread PRRT_kwDOUZby-s6tdp2T: nonzero global counts from account A say nothing of account B, which a role still waits on.
test('unit:up-writes-profiles — with profiles already written for account A, an account B signed in while a role waits for it gets its own profile before the accounts step ends', async () => {
  const { runUp } = await import('../src/up.js');
  const checkout = await temporaryDirectory('up-writes-profiles-second-account');
  const profiles = { workers: 1, reviewers: 1 };
  const world = upWorld(checkout, [], profiles);
  const status = world.deps.status, cli = world.deps.cli;
  let signedIn = false, polls = 0;
  world.deps.status = async () => {
    const served: any = await status();
    if (!served?.fleet?.roles?.length) return served;
    // The reviewer role waits for account B, which signs in on the third poll; A's profiles exist throughout.
    if (++polls >= 3) signedIn = true;
    return { ...served, fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: signedIn ? ['claude-b'] : [] }],
      accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }, ...(signedIn ? [{ name: 'claude-b', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] : [])] } };
  };
  world.deps.cli = async (args, options) => {
    // master environments --apply makes a reviewer profile for every logged-in environment: B's once B is signed in.
    if (args.join(' ') === 'master environments --apply') profiles.reviewers = signedIn ? 2 : 1;
    return cli(args, options);
  };
  const result = await runUp(request(), world.deps);
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(result.completed.includes('accounts'));
  const stored = JSON.parse(await readFile(join(checkout, '.graphyard/master.json'), 'utf8'));
  assert.equal(stored.reviewers.length, 2, 'master.json holds a reviewer profile for account B, signed in during the wait');
});
