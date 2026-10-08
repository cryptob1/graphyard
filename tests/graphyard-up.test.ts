import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpDependencies, UpEvent, UpRequest } from '../src/up.js';
import type { BrowserPage, Located } from '../src/master-browser.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1419: first-run setup in one command and one page. Each test is named for the proof it
 * produces: unit:graphyard-up-resumable, unit:graphyard-up-agent-mode and unit:setup-wizard-states.
 *
 * `graphyard up` runs against a simulated host: every child command it starts is answered by the
 * world below, which changes the control plane's status the way the real command would — the
 * install binds the Apps once a person (or the agent's browser) confirms them, the registry
 * proposal connects the accounts, the restart starts the loop.
 */
// Loaded inside each test, so a tree without them fails as a test case, not at load.
const up = () => import('../src/up.js');
const checklistModule = () => import('../src/model/setup-checklist.js');

const yieldTurn = () => new Promise<void>(accept => setImmediate(accept));
const SERVER = 'http://127.0.0.1:4310';
const CODE = 'c'.repeat(43);
/** Where the simulated install saves the operator's admin credential: what mints the sign-in link. */
const OPERATOR_TOKEN = '/install/acme-shop/tokens/acme-shop-operator.token';
/** The admin credential that file holds. */
const ADMIN = 'a'.repeat(40);

interface World {
  calls: string[][]; installed: boolean; app: boolean; reviewer: boolean; accounts: boolean; loop: boolean;
  /** A self-contained host install: its credentials stay on the host and its summary carries a one-time claim link. */
  host: boolean;
  /** Herdr's plugin is bound to another server. */
  herdrElsewhere: boolean;
  /** Commands that fail once, by their joined arguments' prefix. */
  failOnce: Set<string>;
  /** Called on each sleep: where a test plays the person acting on the Setup page. */
  onSleep: (world: World, ticks: number) => void;
  ticks: number;
  /** The credential files the run minted a sign-in link from. */
  signIns: (string | null)[];
  /** The request id of each goal record (`graphyard goal FILE`). */
  creates: (string | null)[];
  /** The onboarding pull request once published, and whether it has merged. */
  onboardingPullRequest: string | null; onboardingMerged: boolean;
  /** The Hetzner server's monthly price is shown but not yet confirmed. */
  priceUnconfirmed: boolean;
  /** The plan's Apps still to create in a browser (GY-1442); absent from the plan when undefined. */
  browserApps?: string[];
  /** Turns an install waits on its App page before it pauses (exit 1, resumable); 10,000 when undefined. */
  pauseAfter?: number;
  /** Whether an install is serving its App page right now. */
  serving?: boolean;
}

function world(overrides: Partial<World> = {}): World {
  return { calls: [], installed: false, app: false, reviewer: false, accounts: false, loop: false, host: false, herdrElsewhere: false, failOnce: new Set(), onSleep: () => {}, ticks: 0, signIns: [], creates: [], onboardingPullRequest: null, onboardingMerged: false, priceUnconfirmed: false, ...overrides };
}

const status = (w: World) => w.installed ? {
  github: w.app, githubRepository: 'acme/shop', appPermissions: { missing: [], installationUrl: 'https://github.com/settings/installations/7' },
  reviewerApps: w.reviewer ? [{ id: 'claude', appId: 9 }] : [],
  fleet: w.accounts ? { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] } : { roles: [], accounts: [] },
  setup: { protection: w.app ? 'checks' : 'off', loop: w.loop },
} : null;

function dependencies(w: World, root: string, events: UpEvent[], extra: Partial<UpDependencies> = {}): UpDependencies {
  let clock = 0;
  return {
    root, pollMs: 1, emit: event => { events.push(event); },
    now: () => clock, sleep: async ms => { clock += ms; w.ticks++; w.onSleep(w, w.ticks); await yieldTurn(); },
    // A host install records the master's configuration only once it completes; a local one before its App step.
    serverUrl: async () => w.installed && (!w.host || (w.app && w.reviewer)) ? SERVER : null,
    masterToken: async () => w.installed ? 'm'.repeat(40) : null,
    signIn: async file => { w.signIns.push(file); return file === OPERATOR_TOKEN ? `${SERVER}/#sign-in=${CODE}` : null; },
    // The operator's admin credential, where the install saved it on this machine (GY-1479); a host
    // install keeps it on the host, so its path names no file here.
    operatorToken: async file => file && !w.host ? ADMIN : null,
    status: async () => status(w),
    publishOnboarding: async () => { w.calls.push(['publish-onboarding']); w.onboardingPullRequest ??= 'https://github.com/acme/shop/pull/1'; return w.onboardingMerged ? null : { pullRequest: w.onboardingPullRequest }; },
    // The person merges the onboarding pull request while up waits on it: the first read finds it open.
    onboardingMerged: async url => { assert.equal(url, w.onboardingPullRequest); w.calls.push(['onboarding-merged?']); const merged = w.onboardingMerged; w.onboardingMerged = true; return merged; },
    async cli(args, options = {}) {
      w.calls.push(args);
      const joined = args.join(' ');
      if (args[0] === 'goal') w.creates.push(options.env?.GRAPHYARD_REQUEST_ID ?? null);
      for (const prefix of w.failOnce) if (joined.startsWith(prefix)) { w.failOnce.delete(prefix); return { code: 1, stdout: '{"error":"interrupted"}' }; }
      if (args[0] === 'install' && args.includes('--plan')) {
        return { code: 0, stdout: JSON.stringify({ installId: 'acme-shop', installDirectory: '/install/acme-shop', ...(w.browserApps ? { browserApps: w.browserApps } : {}), ...(w.host ? { host: { units: [] } } : {}), principals: [{ id: 'acme-shop-operator', role: 'admin', sessionKind: 'human' }, { id: 'acme-shop-master', role: 'coordinator', sessionKind: 'ai' }],
          preflight: [{ name: 'GitHub CLI', ok: true }, ...(w.priceUnconfirmed && !args.includes('--confirm-price') ? [{ name: 'Monthly price', ok: false, detail: 'cx33 (8 GB) at fsn1: 6.49 EUR/month; not confirmed, so nothing will be created' }] : []), ...(w.herdrElsewhere && !args.includes('--no-herdr') ? [{ name: 'Herdr plugin', ok: false, detail: 'bound to https://other.example' }] : [])] }) };
      }
      if (args[0] === 'install' && args.includes('--apply')) {
        w.installed = true;
        options.onLine?.('Open http://127.0.0.1:4311 in a browser on this machine and confirm the Graphyard App');
        w.serving = true;
        try { for (let turns = 0; !(w.app && w.reviewer); turns++) { if (turns > (w.pauseAfter ?? 10_000)) return { code: 1, stdout: JSON.stringify({ resume: 'graphyard install --apply' }) }; await yieldTurn(); } }
        finally { w.serving = false; }
        return { code: 0, stdout: JSON.stringify(w.host ? { ok: true, principals: [{ id: 'acme-shop-operator', role: 'admin', tokenFile: '/var/lib/graphyard/tokens/acme-shop-operator.token' }], signIn: `${SERVER}/#claim=${CODE}`, host: { host: 'graphyard-acme-shop', masterIdentities: true, units: [] } } : { ok: true }) };
      }
      if (joined === 'master registry propose --apply') { w.accounts = true; return { code: 0, stdout: '{}' }; }
      if (joined === 'master restart') { w.loop = true; return { code: 0, stdout: '{}' }; }
      if (args[0] === 'goal') return { code: 0, stdout: JSON.stringify({ key: 'GOAL-1', stage: 'acceptance-drafting' }) };
      return { code: 0, stdout: '{}' };
    },
    ...extra,
  };
}

const request = (extra: Partial<UpRequest> = {}): UpRequest => ({ repository: 'acme/shop', provider: 'compose', agent: false, reviewer: 'claude', master: 'claude', goalFile: null, browserProfile: null, ...extra });
const installApplies = (w: World) => w.calls.filter(args => args[0] === 'install' && args.includes('--apply')).length;

test('unit:graphyard-up-resumable — a fresh run walks every step in order; an interrupted run resumes without rerunning the install; a run blocked on the App step prints one Setup address and completes once the step turns green; Herdr is never repointed', async () => {
  const { runUp } = await up();
  // A fresh run: the person confirms the Apps and connects an account on the Setup page.
  const root = await temporaryDirectory('graphyard-up-fresh');
  const fresh = world({ onSleep: (w, ticks) => { if (ticks === 3) { w.app = true; w.reviewer = true; } if (ticks === 6) w.accounts = true; } });
  const events: UpEvent[] = [];
  const result = await runUp(request(), dependencies(fresh, root, events));
  assert.equal(result.exitCode, 0, result.next);
  assert.deepEqual(result.completed, ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop']);
  assert.deepEqual(fresh.calls.map(args => args.slice(0, 2).join(' ')), ['install --provider', 'install --provider', 'master init', 'master autonomy', 'init --scan', 'init --scan', 'publish-onboarding', 'master harness', 'master restart', 'onboarding-merged?', 'onboarding-merged?'], 'preflight, control plane, host supervisor, master identities, onboarding (applied, then published), harness, master loop, in order; then the onboarding pull request merges');
  // Onboarding is done only once its files are published: init --scan --apply writes them to this checkout alone.
  assert.ok(events.some(event => event.kind === 'step' && event.step === 'onboarding' && event.state === 'done' && /published in https:\/\/github\.com\/acme\/shop\/pull\/1/.test(event.detail ?? '')));
  assert.ok(events.some(event => event.kind === 'note' && /onboarding pull request .* to merge/.test(event.text)), 'it says what it waits on');
  assert.ok(result.checklist.every(item => item.done), 'the checklist is green');
  const waits = events.filter(event => event.kind === 'waiting');
  assert.equal(waits.length, 1, 'the Setup address is printed once for the whole run');
  assert.equal(result.prompts, 1);
  assert.equal(result.setupUrl, `${SERVER}/#setup`);
  // The printed address signs the person in with a one-time link the operator's own credential mints,
  // and lands on the Setup page: no token to paste, no command to run.
  assert.deepEqual(fresh.signIns, [OPERATOR_TOKEN], 'one link, minted from the operator credential the install plan names');
  const printed = `${SERVER}/#sign-in=${CODE}&setup`;
  assert.equal((waits[0] as any).setupUrl, printed);
  assert.match((waits[0] as any).sentence, new RegExp(`^Open ${printed.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} to sign in to the Setup page`));
  const { requestedView } = await checklistModule();
  const { signInCode } = await import('../web/pages/login.js');
  const opened = requestedView(new URL(printed).hash);
  assert.deepEqual(opened, { view: 'setup', hash: `#sign-in=${CODE}` }, 'the dashboard opens the Setup page');
  assert.equal(signInCode(opened.hash), CODE, 'and the sign-in page redeems the exact link fragment it knows');
  assert.ok(!fresh.calls.flat().includes('--herdr-rebind'), 'never repoints Herdr');

  // An interrupted run: onboarding fails once. The rerun skips everything recorded done, so the
  // install (which registers the identities, Apps and variables) runs exactly once overall.
  const interruptedRoot = await temporaryDirectory('graphyard-up-interrupted');
  const interrupted = world({ app: true, reviewer: true, accounts: true, failOnce: new Set(['init --scan --apply']) });
  const first = await runUp(request(), dependencies(interrupted, interruptedRoot, []));
  assert.equal(first.exitCode, 1);
  assert.match(first.next, /^onboarding: graphyard init exited 1/);
  assert.deepEqual(first.completed, ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy']);
  const resumedEvents: UpEvent[] = [];
  const resumed = await runUp(request(), dependencies(interrupted, interruptedRoot, resumedEvents));
  assert.equal(resumed.exitCode, 0, resumed.next);
  assert.equal(installApplies(interrupted), 1, 'the resumed run does not install again');
  assert.equal(interrupted.calls.filter(args => args.join(' ').startsWith('master init')).length, 1, 'nor register the supervisor again');
  assert.deepEqual(resumedEvents.filter(event => event.kind === 'step' && event.state === 'skipped').map(event => (event as any).step), ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy']);

  // Blocked on the App step: the run waits, without failing, until the App turns green.
  const blockedRoot = await temporaryDirectory('graphyard-up-blocked');
  let observedWaiting = false;
  const blocked = world({ accounts: true, onSleep: w => { if (w.ticks === 40) { observedWaiting = blockedEvents.some(event => event.kind === 'waiting') && !w.app; w.app = true; w.reviewer = true; } } });
  const blockedEvents: UpEvent[] = [];
  const done = await runUp(request(), dependencies(blocked, blockedRoot, blockedEvents));
  assert.ok(observedWaiting, 'the Setup address was printed while the App step waited');
  assert.equal(done.exitCode, 0, done.next);
  assert.deepEqual((blockedEvents.find(event => event.kind === 'waiting') as any).waitingFor, ['github-app', 'reviewer-app']);
  assert.equal(installApplies(blocked), 1);

  // A host install keeps its credentials on the host: the printed address is the install's own one-time
  // claim link, carried to the Setup page, and no link is minted from a credential this machine lacks.
  const hostRoot = await temporaryDirectory('graphyard-up-host');
  const host = world({ host: true, onSleep: (w, ticks) => { if (ticks === 3) { w.app = true; w.reviewer = true; } if (ticks === 12) w.accounts = true; } });
  const hostEvents: UpEvent[] = [];
  assert.equal((await runUp(request({ provider: 'hetzner' }), dependencies(host, hostRoot, hostEvents))).exitCode, 0);
  assert.deepEqual(hostEvents.filter(event => event.kind === 'waiting').map(event => (event as any).setupUrl), [`${SERVER}/#claim=${CODE}&setup`]);
  assert.deepEqual(host.signIns, [], 'the claim is used; nothing is minted');
  // GY-1479: the host install provisioned the master's identities on the host, where the admin credential stays; up runs no local autonomy.
  assert.ok(!host.calls.some(args => args[1] === 'autonomy'), 'no local master autonomy for a host install');
  const identities = hostEvents.find(event => event.kind === 'step' && event.step === 'master-autonomy' && event.state === 'done') as { detail?: string } | undefined;
  assert.match(identities?.detail ?? '', /provisioned on graphyard-acme-shop, where its loop runs/);
  assert.deepEqual(requestedView(`#claim=${CODE}&setup`), { view: 'setup', hash: `#claim=${CODE}` });

  // Herdr bound to another server: the install runs with --no-herdr and never with --herdr-rebind.
  const herdrRoot = await temporaryDirectory('graphyard-up-herdr');
  const herdr = world({ app: true, reviewer: true, accounts: true, herdrElsewhere: true });
  const herdrEvents: UpEvent[] = [];
  assert.equal((await runUp(request(), dependencies(herdr, herdrRoot, herdrEvents))).exitCode, 0);
  assert.ok(herdr.calls.filter(args => args[0] === 'install' && args.includes('--apply')).every(args => args.includes('--no-herdr')));
  assert.ok(!herdr.calls.flat().includes('--herdr-rebind'));
  assert.ok(herdrEvents.some(event => event.kind === 'note' && /left as it is/.test(event.text)));

  // A failed machine prerequisite stops before anything is installed, naming it.
  const preflightRoot = await temporaryDirectory('graphyard-up-preflight');
  const broken = world();
  const refused = await runUp(request(), { ...dependencies(broken, preflightRoot, []), cli: async args => { broken.calls.push(args); return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: false, detail: 'not logged in', fix: 'gh auth login' }] }) }; } });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.next, /GitHub CLI: not logged in \(fix: gh auth login\)/);
  assert.equal(broken.calls.length, 1, 'nothing past the preflight ran');

  // A new Hetzner server's price is the operator's consent: unconfirmed, up waits on it (exit 3) and creates
  // nothing; given --confirm-price and an SSH key, up passes both to every install run and carries on.
  const { upRequestFromArgs } = await up();
  const priceRoot = await temporaryDirectory('graphyard-up-price');
  const priced = world({ app: true, reviewer: true, accounts: true, priceUnconfirmed: true });
  const unconfirmed = await runUp(request({ provider: 'hetzner' }), dependencies(priced, priceRoot, []));
  assert.equal(unconfirmed.exitCode, 3, unconfirmed.next);
  assert.match(unconfirmed.next, /operator's consent to its price: cx33 .*6\.49 EUR\/month.*--confirm-price PRICE \(or --max-monthly N\); nothing has been created/);
  assert.equal(installApplies(priced), 0);
  const unconfirmedCalls = priced.calls.length;
  const consented = upRequestFromArgs(['--repo', 'acme/shop', '--provider', 'hetzner', '--confirm-price', '6.49', '--ssh-key', 'laptop']);
  assert.equal((await runUp(consented, dependencies(priced, priceRoot, []))).exitCode, 0);
  for (const args of priced.calls.slice(unconfirmedCalls).filter(args => args[0] === 'install')) {
    assert.deepEqual(args.slice(args.indexOf('--confirm-price'), args.indexOf('--confirm-price') + 2), ['--confirm-price', '6.49']);
    assert.deepEqual(args.slice(args.indexOf('--ssh-key'), args.indexOf('--ssh-key') + 2), ['--ssh-key', 'laptop']);
  }
  assert.equal(installApplies(priced), 1);

  // The onboarding files are published as one commit on the base branch's tip, on graphyard/onboarding,
  // with a pull request; the operator's checkout is untouched, and a base that already holds them publishes nothing.
  const { publishOnboarding } = await up();
  const gitRoot = await temporaryDirectory('graphyard-up-publish');
  const git = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', ...env } });
  const origin = join(gitRoot, 'origin.git'), checkout = join(gitRoot, 'checkout');
  git(gitRoot, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  git(gitRoot, ['clone', '--quiet', origin, checkout]);
  await writeFile(join(checkout, 'README.md'), 'shop\n');
  git(checkout, ['add', 'README.md']); git(checkout, ['commit', '--quiet', '-m', 'first']); git(checkout, ['push', '--quiet', 'origin', 'HEAD:main']);
  await mkdir(join(checkout, '.github/workflows'), { recursive: true });
  await writeFile(join(checkout, '.github/workflows/graphyard.yml'), 'name: Graphyard\n');
  await writeFile(join(checkout, 'AGENTS.md'), '# Agents\n');
  await writeFile(join(checkout, 'graphyard.json'), '{}\n');
  await writeFile(join(checkout, 'notes.txt'), 'not onboarding\n');
  const gh: string[][] = [];
  const runner = (opened: () => string) => (program: string, args: string[], env?: Record<string, string>) => {
    if (program === 'git') return git(checkout, args, env);
    gh.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return opened();
    if (args[0] === 'repo') return 'main\n';
    return 'https://github.com/acme/shop/pull/1\n';
  };
  assert.deepEqual(await publishOnboarding(checkout, 'acme/shop', runner(() => '\n')), { pullRequest: 'https://github.com/acme/shop/pull/1' });
  assert.deepEqual(git(origin, ['ls-tree', '-r', '--name-only', 'graphyard/onboarding']).trim().split('\n'), ['.github/workflows/graphyard.yml', 'AGENTS.md', 'README.md', 'graphyard.json'], 'only the onboarding files, on the base tip');
  assert.equal(git(origin, ['rev-parse', 'graphyard/onboarding^']).trim(), git(origin, ['rev-parse', 'main']).trim());
  assert.deepEqual(gh.find(args => args[1] === 'create')!.slice(0, 8), ['pr', 'create', '--repo', 'acme/shop', '--base', 'main', '--head', 'graphyard/onboarding']);
  assert.equal(git(checkout, ['status', '--porcelain', '--', 'AGENTS.md']).trim(), '?? AGENTS.md', 'the operator\'s index is untouched');
  // Rerun with the pull request open and its branch carrying these files: it is reused, nothing is pushed again.
  const before = gh.length, pushed = git(origin, ['rev-parse', 'graphyard/onboarding']).trim();
  assert.deepEqual(await publishOnboarding(checkout, 'acme/shop', runner(() => 'https://github.com/acme/shop/pull/1\n')), { pullRequest: 'https://github.com/acme/shop/pull/1' });
  assert.ok(!gh.slice(before).some(args => args[1] === 'create'));
  assert.equal(git(origin, ['rev-parse', 'graphyard/onboarding']).trim(), pushed);
  // Once merged into the base, there is nothing left to publish.
  git(origin, ['update-ref', 'refs/heads/main', 'graphyard/onboarding']);
  assert.equal(await publishOnboarding(checkout, 'acme/shop', runner(() => '')), null);
});

test('unit:graphyard-up-agent-mode — up --agent reaches a green checklist with zero prompts when no device approval is needed, hands off exactly one step when one is, and submits the goal from a file', async () => {
  const { browserAppDriver, recordedAppDriver, runUp, upBrowserProfile, upRequestFromArgs } = await up();
  assert.deepEqual(upRequestFromArgs(['--repo', 'acme/shop', '--agent', '--goal', 'goal.txt']), { repository: 'acme/shop', provider: 'compose', agent: true, reviewer: 'claude', master: 'claude', goalFile: 'goal.txt', browserProfile: null,
    install: { confirmPrice: null, maxMonthly: null, sshKey: null, sshHost: null, sshUser: null } });
  assert.throws(() => upRequestFromArgs(['--provider', 'compose']), /--repo OWNER\/NAME/);

  // No device approval: the browser drive confirms both Apps, the registry proposal connects the accounts.
  const root = await temporaryDirectory('graphyard-up-agent');
  await writeFile(join(root, 'goal.txt'), 'A sign-up page that sends a welcome email\nIt should use the existing mailer.');
  const quiet = world();
  const events: UpEvent[] = [];
  const result = await runUp(request({ agent: true, goalFile: 'goal.txt' }), dependencies(quiet, root, events, {
    driveApp: async () => { quiet.app = true; quiet.reviewer = true; return { state: 'done' }; },
  }));
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(result.checklist.every(item => item.done), 'green checklist');
  assert.equal(result.prompts, 0, 'agent mode never prints the Setup address and waits');
  assert.deepEqual(result.handoffs, [], 'nothing is handed to a person');
  assert.ok(quiet.calls.some(args => args.join(' ') === 'master registry propose --apply'), 'accounts come from login homes on the host');
  const create = quiet.calls.find(args => args[0] === 'goal')!;
  assert.ok(create, 'the goal is submitted');
  assert.equal(result.goal, 'GOAL-1');
  assert.ok(quiet.calls.findIndex(args => args[0] === 'goal') > quiet.calls.findLastIndex(args => args[0] === 'onboarding-merged?'), 'the goal is submitted only once the onboarding pull request has merged');
  assert.ok(result.completed.includes('goal'));
  assert.ok(events.every(event => JSON.parse(JSON.stringify(event)).kind), 'every event is JSON');

  // A GitHub Mobile approval: exactly one handed-off step, as one sentence with its code; the run resumes on its own.
  const deviceRoot = await temporaryDirectory('graphyard-up-device');
  const device = world();
  const deviceResult = await runUp(request({ agent: true }), dependencies(device, deviceRoot, [], {
    driveApp: async (_url, handoff) => {
      for (let poll = 0; poll < 3; poll++) { handoff('Approve the GitHub Mobile prompt on your phone and choose 42', { code: '42', url: 'https://github.com/sessions/sudo' }); await yieldTurn(); }
      device.app = true; device.reviewer = true; return { state: 'done' };
    },
  }));
  assert.equal(deviceResult.exitCode, 0, deviceResult.next);
  assert.equal(deviceResult.handoffs.length, 1, 'exactly one handed-off step');
  assert.deepEqual(deviceResult.handoffs[0], { step: 'control-plane', sentence: 'Approve the GitHub Mobile prompt on your phone and choose 42', url: 'https://github.com/sessions/sudo', code: '42' });

  // No browser profile: agent mode stops before anything but the read-only plan runs rather than hand
  // App creation to a person; the plan says whether an App saved on this machine covers it (GY-1476).
  const bareRoot = await temporaryDirectory('graphyard-up-agent-bare');
  const bare = world();
  const refusedAgent = await runUp(request({ agent: true }), dependencies(bare, bareRoot, []));
  assert.equal(refusedAgent.exitCode, 2);
  assert.match(refusedAgent.next, /--browser-profile PROFILE/);
  assert.deepEqual(refusedAgent.handoffs, [], 'App creation is never handed to a person');
  assert.deepEqual(bare.calls.map(args => args.slice(0, 1).concat(args.filter(arg => arg === '--plan' || arg === '--apply'))), [['install', '--plan']], 'only the read-only plan ran');
  // --reuse-app lifts that stop only when the reused Apps cover every App the install would create in a
  // browser: up always registers a reviewer, so reusing the control-plane App alone still stops (GY-1442).
  const partial = world({ browserApps: ['reviewer'] });
  const partlyReused = await runUp(request({ agent: true, reuseApps: ['graphyard-acme-shop'] }), dependencies(partial, await temporaryDirectory('graphyard-up-agent-partial'), []));
  assert.equal(partlyReused.exitCode, 2);
  assert.match(partlyReused.next, /--reuse-app covers no reviewer App "claude"/);
  assert.deepEqual(partial.calls.map(args => args.slice(0, 1).concat(args.filter(arg => arg === '--plan' || arg === '--apply'))), [['install', '--plan']], 'only the read-only plan ran');
  assert.deepEqual(partlyReused.handoffs, []);
  const covered = world({ app: true, reviewer: true, accounts: true, browserApps: [] });
  const fullyReused = await runUp(request({ agent: true, reuseApps: ['graphyard-acme-shop', 'acme-shop-review-claude'] }), dependencies(covered, await temporaryDirectory('graphyard-up-agent-covered'), []));
  assert.equal(fullyReused.exitCode, 0, fullyReused.next);
  assert.ok(covered.calls.some(args => args[0] === 'install' && args.includes('--apply') && args.includes('acme-shop-review-claude')), 'both reused Apps reach install');
  // The profile is the one passed, else the one the master recorded.
  assert.equal(upBrowserProfile(bareRoot, request({ agent: true })), null);
  await mkdir(join(bareRoot, '.graphyard'), { recursive: true });
  await writeFile(join(bareRoot, '.graphyard/master.json'), JSON.stringify({ url: SERVER, browser: { profile: 'Default' } }));
  assert.deepEqual(upBrowserProfile(bareRoot, request({ agent: true })), { profile: 'Default' });
  assert.deepEqual(upBrowserProfile(bareRoot, request({ agent: true, browserProfile: 'Work' })), { profile: 'Work' });

  // An interrupted goal submission replays the same request id, so the control plane creates the goal once.
  const goalRoot = await temporaryDirectory('graphyard-up-goal');
  await writeFile(join(goalRoot, 'goal.txt'), 'A sign-up page that sends a welcome email');
  const goalWorld = world({ app: true, reviewer: true, accounts: true, failOnce: new Set(['goal']) });
  const goalDeps = () => dependencies(goalWorld, goalRoot, [], { driveApp: async () => ({ state: 'done' }) });
  assert.equal((await runUp(request({ agent: true, goalFile: 'goal.txt' }), goalDeps())).exitCode, 1);
  assert.equal((await runUp(request({ agent: true, goalFile: 'goal.txt' }), goalDeps())).exitCode, 0);
  assert.equal(goalWorld.creates.length, 2);
  assert.ok(goalWorld.creates[0] && goalWorld.creates[0] === goalWorld.creates[1], 'both tries carry one request id');

  // An onboarding pull request that never merges holds the goal back: the run stops resumable (exit 3) and submits nothing.
  const unmergedRoot = await temporaryDirectory('graphyard-up-unmerged');
  await writeFile(join(unmergedRoot, 'goal.txt'), 'A sign-up page that sends a welcome email');
  const unmerged = world({ app: true, reviewer: true, accounts: true });
  const held = await runUp(request({ agent: true, goalFile: 'goal.txt' }), dependencies(unmerged, unmergedRoot, [], { humanWaitMs: 10, driveApp: async () => ({ state: 'done' }), onboardingMerged: async () => false }));
  assert.equal(held.exitCode, 3, held.next);
  assert.match(held.next, /onboarding pull request https:\/\/github\.com\/acme\/shop\/pull\/1 to merge/);
  assert.deepEqual(unmerged.creates, [], 'no goal while the base lacks the delivery workflows');

  // The browser drive itself: a Confirm-access page is the one handoff, then the App installs on the repository alone.
  const opened: string[] = [], clicked: string[] = [];
  let sudoPolls = 0;
  const controls: Record<string, Located> = {
    'button:Register Graphyard App →': { selector: '#register', tag: 'button', checked: null, value: null, text: '' },
    'button:Create GitHub App for acme': { selector: '#create', tag: 'button', checked: null, value: null, text: '' },
    'link:Install GitHub App': { selector: '#install-link', tag: 'a', checked: null, value: null, text: '', href: 'https://github.com/apps/graphyard-acme-shop/installations/new' },
    'button:Install': { selector: '#install', tag: 'button', checked: null, value: null, text: '' },
  };
  const page: BrowserPage = {
    open: url => { opened.push(url); }, url: () => sudoPolls > 0 && sudoPolls < 3 ? 'https://github.com/sessions/sudo' : 'https://github.com/settings/apps',
    text: () => sudoPolls > 0 && sudoPolls < 3 ? 'Confirm access\nUse GitHub Mobile\n42' : '', meta: () => null,
    locate: (kind, text) => controls[`${kind}:${text}`] ?? null, click: selector => { clicked.push(selector); if (selector === '#create') sudoPolls = 1; },
    setChecked: () => {}, select: () => {}, screenshot: () => {}, wait: () => {}, close: () => {},
  };
  const handed: string[] = [];
  const drive = browserAppDriver({ page, repository: 'acme/shop', ids: () => ({ owner: 11, repository: 22 }), sleep: async () => { if (sudoPolls) sudoPolls++; } });
  assert.deepEqual(await drive('http://127.0.0.1:4311', sentence => { if (!handed.includes(sentence)) handed.push(sentence); }), { state: 'done' });
  // GY-1457: every Confirm-access handoff ends with the App-import route that needs no live moment.
  assert.deepEqual(handed, [`Approve the GitHub Mobile prompt on your phone and choose 42\n${(await import('../src/github-setup.js')).appImportRoute('acme/shop', ' --agent')}`]);
  assert.deepEqual(clicked, ['#register', '#create', '#install']);
  assert.ok(opened.includes('https://github.com/apps/graphyard-acme-shop/installations/new/permissions?suggested_target_id=11&repository_ids[]=22'), 'installs on the one repository');

  // GitHub's passkey-first Confirm-access page (GY-1442): the drive hands off the passkey or password
  // confirmation at the page's link and waits for it, never triggering GitHub Mobile on its own.
  let mobile = false, approved = false, polls = 0;
  const passkey: BrowserPage = {
    ...page, url: () => approved ? 'https://github.com/settings/apps' : 'https://github.com/sessions/sudo',
    text: () => approved ? '' : mobile ? 'Confirm access\n37' : 'Confirm access\nUse your passkey\nHaving problems?\nUse GitHub Mobile',
    locate: (kind, text) => kind === 'link' && text === 'Use GitHub Mobile' && !mobile ? { selector: '#mobile', tag: 'a', checked: null, value: null, text, href: 'https://github.com/sessions/sudo?mobile=1' } : controls[`${kind}:${text}`] ?? null,
    click: selector => { if (selector === '#mobile') mobile = true; },
  };
  const passkeyHanded: { sentence: string; url: string | null; code: string | null }[] = [];
  const passkeyDrive = browserAppDriver({ page: passkey, repository: 'acme/shop', ids: () => ({ owner: 11, repository: 22 }), sleep: async () => { if (++polls === 2) approved = true; } });
  assert.deepEqual(await passkeyDrive('http://127.0.0.1:4311', (sentence, link) => { passkeyHanded.push({ sentence, url: link.url ?? null, code: link.code ?? null }); }), { state: 'done' });
  assert.equal(mobile, false, 'GitHub Mobile is not triggered while the page offers a passkey');
  const importRoute = (await import('../src/github-setup.js')).appImportRoute('acme/shop', ' --agent');
  assert.deepEqual(passkeyHanded, [{ sentence: "Confirm access once in your own Chrome at https://github.com/settings/apps/new with your passkey or password: GitHub then holds sudo mode for the session the agent's browser shares, and the flow continues by itself within 10 s\nGitHub's Confirm-access page (https://github.com/sessions/sudo) offers: passkey, Mobile\n" + importRoute, url: 'https://github.com/sessions/sudo', code: null }]);
  // The operator chose GitHub Mobile (--github-mobile): the drive activates it and hands off only the code it shows.
  approved = false; polls = 0;
  const mobileHanded: { sentence: string; code: string | null }[] = [];
  const mobileDrive = browserAppDriver({ page: passkey, repository: 'acme/shop', ids: () => ({ owner: 11, repository: 22 }), sudo: 'mobile', sleep: async () => { if (mobile && ++polls === 2) approved = true; } });
  assert.deepEqual(await mobileDrive('http://127.0.0.1:4311', (sentence, link) => { mobileHanded.push({ sentence, code: link.code ?? null }); }), { state: 'done' });
  assert.ok(mobile, 'GitHub Mobile was triggered');
  assert.deepEqual(mobileHanded, [{ sentence: 'Approve the GitHub Mobile prompt on your phone and choose 37\n' + importRoute, code: '37' }]);
  assert.equal(upRequestFromArgs(['--repo', 'acme/shop', '--github-mobile', '--reuse-app', 'graphyard-acme-api']).sudo, 'mobile');
  assert.deepEqual(upRequestFromArgs(['--repo', 'acme/shop', '--reuse-app', 'graphyard-acme-api']).reuseApps, ['graphyard-acme-api']);

  // The drive is a recorded master browser flow: each step and a record.json under .graphyard/master-actions.
  const recordRoot = await temporaryDirectory('graphyard-up-record');
  const shots: string[] = [];
  const recorded = recordedAppDriver(recordRoot, request({ agent: true }), { profile: 'Default' }, () => ({
    ...page, url: () => 'https://github.com/settings/apps', text: () => '', locate: () => null, click: () => {}, screenshot: file => { shots.push(file); },
  }));
  assert.deepEqual(await recorded.drive('http://127.0.0.1:4311', () => {}), { state: 'done' });
  assert.match(recorded.directory, /\.graphyard\/master-actions\/[^/]+-app-create-[0-9a-f]{8}$/);
  assert.deepEqual(await readdir(join(recordRoot, '.graphyard/master-actions')), [recorded.directory.split('/').pop()]);
  const record = JSON.parse(await readFile(join(recorded.directory, 'record.json'), 'utf8'));
  assert.equal(record.flow, 'app-create');
  assert.equal(record.outcome, 'applied');
  assert.deepEqual(record.steps.filter((entry: any) => entry.action === 'open').map((entry: any) => entry.args[0]), ['http://127.0.0.1:4311', 'http://127.0.0.1:4311']);
  assert.ok(shots.length >= 2, 'a screenshot after each navigation');
});

/** Visible text of rendered markup: what a person reads. */
const visible = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const render = async (state: any) => { const { SetupView } = await import('../web/pages/setup.js'); return renderToStaticMarkup(createElement(SetupView, { status: state, onConnect: () => {}, onSubmitGoal: () => {} })); };
/** A command, a sha or a file path: what the Setup page never shows. */
const JARGON: [string, RegExp][] = [
  ['a command', /\b(graphyard|gy|gh|npm|node|git) [a-z-]+|(^|\s)--[a-z]/],
  ['a sha', /\b[0-9a-f]{7,40}\b/],
  ['a file path', /\.graphyard|~\/|\b[\w.-]+\/[\w.-]+\.(ts|tsx|js|mjs|json|md|toml|pem)\b|\/(home|etc|var|tmp)\//],
];

test('unit:setup-wizard-states — the Setup page shows each checklist state with its one action, offers the goal box only when every item is green, and shows no command, sha or file path', async () => {
  const { setupChecklist } = await checklistModule();
  const green = { github: true, githubRepository: 'acme/shop', appPermissions: { missing: [] }, reviewerApps: [{ id: 'claude', appId: 9 }],
    fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
    setup: { protection: 'complete', loop: true } };
  const states: { name: string; status: any; item: string; action: RegExp | null }[] = [
    { name: 'nothing installed yet', status: null, item: 'github-app', action: /<a [^>]*data-setup-action="github-app"[^>]*href="http:\/\/127\.0\.0\.1:4311"[^>]*>Create the GitHub App<\/a>/ },
    { name: 'App missing permissions', status: { ...green, appPermissions: { missing: [{ permission: 'checks', required: 'write' }], installationUrl: 'https://github.com/settings/installations/7' } }, item: 'github-app', action: /data-setup-action="github-app"[^>]*href="https:\/\/github\.com\/settings\/installations\/7"[^>]*>Accept the new permissions</ },
    { name: 'no reviewer App', status: { ...green, reviewerApps: [] }, item: 'reviewer-app', action: />Create the reviewer App</ },
    { name: 'no account for writing code', status: { ...green, fleet: { roles: [], accounts: [] } }, item: 'account:worker', action: /<button[^>]*data-setup-action="account:worker"[^>]*>Connect an account<\/button>/ },
    { name: 'a signed-out account', status: { ...green, fleet: { ...green.fleet, accounts: [{ name: 'claude-a', enabled: true, loggedIn: false }] } }, item: 'account:reviewer', action: />Connect an account</ },
    { name: 'an account no session may use (quota spent, no model configured)', status: { ...green, fleet: { ...green.fleet, accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: false }] } }, item: 'account:worker', action: />Connect an account</ },
    { name: 'branch unprotected', status: { ...green, setup: { protection: 'off', loop: true } }, item: 'branch-protection', action: /href="https:\/\/github\.com\/acme\/shop\/settings\/branches"[^>]*>Open branch settings</ },
    { name: 'loop not running', status: { ...green, setup: { protection: 'checks', loop: false } }, item: 'master-loop', action: /data-setup-action="master-loop"[^>]*>Check again</ },
    { name: 'every item green', status: green, item: '', action: null },
  ];
  for (const state of states) {
    const markup = await render(state.status);
    const items = setupChecklist(state.status);
    if (state.action) {
      assert.match(markup, new RegExp(`data-setup-item="${state.item.replace(':', '\\:')}" data-done="no"`), `${state.name}: ${state.item} is not done`);
      assert.match(markup, state.action, `${state.name}: the action shown`);
      assert.doesNotMatch(markup, /Describe what you want built/, `${state.name}: no goal box until every item is green`);
    } else {
      assert.ok(items.every(item => item.done));
      assert.match(markup, /<form aria-label="Describe what you want built"/, 'the goal box once every item is green');
      assert.doesNotMatch(markup, /data-setup-action=/, 'no action once every item is done');
      assert.match(visible(markup), /Everything is ready\./);
    }
    // Every item carries one plain-language line and at most one action.
    for (const item of items) assert.equal((markup.match(new RegExp(`data-setup-action="${item.id}"`, 'g')) ?? []).length, item.done ? 0 : 1, `${state.name}: ${item.id} has ${item.done ? 'no' : 'one'} action`);
    const text = visible(markup);
    for (const [what, pattern] of JARGON) assert.doesNotMatch(text, pattern, `${state.name}: the page shows ${what}: ${text.match(pattern)?.[0]}`);
  }
  // Settings → Agents opens the Setup page for the admin who signed in another way.
  const { default: FleetPage } = await import('../web/pages/fleet.js');
  const fleetPage = (onOpenSetup?: () => void) => renderToStaticMarkup(createElement(FleetPage, { api: async () => ({}), status: null, observedAt: 0, onOpenSetup }));
  assert.match(fleetPage(() => {}), /<button data-open-setup="true">Open the first-run Setup checklist<\/button>/);
  assert.doesNotMatch(fleetPage(), /data-open-setup/, 'only for the admin');
  // Partially protected (the repository's checks only) is enough to start; the line says what follows.
  assert.equal(setupChecklist({ ...green, setup: { protection: 'checks', loop: true } }).find(item => item.id === 'branch-protection')!.done, true);
});

test('unit:up-goal-uses-pipeline — `up --goal FILE` and the Setup page submit a goal record through the goals API, as `graphyard goal` does, and create no plain work item', async () => {
  const { runUp } = await up();
  const { goalSubmission } = await checklistModule();
  const { goalInputSchema, recordGoal } = await import('../src/model/goal.js');
  const { submitGoal } = await import('../web/pages/setup.js');
  const text = '  A sign-up page that sends a welcome email\r\nUse the existing mailer.  ';

  // The goal box's text becomes a goal input the goals API accepts: the acceptance role drafts it.
  const input = goalSubmission(text);
  assert.equal(input.statement, 'A sign-up page that sends a welcome email\nUse the existing mailer.');
  const recorded = recordGoal(goalInputSchema.parse(input), 'GOAL-1', { actor: { id: 'acme-shop-operator', role: 'admin' } as any, at: new Date(0).toISOString() });
  assert.equal(recorded.key, 'GOAL-1');
  assert.equal(recorded.stage, 'acceptance-drafting', 'a recorded goal waits on the acceptance role');
  assert.throws(() => goalSubmission('short'), /at least 10 characters/);
  assert.throws(() => goalSubmission('x'.repeat(2001)), /under 2000 characters/);
  assert.doesNotThrow(() => goalInputSchema.parse(goalSubmission('x'.repeat(2000))), 'the box\'s limit fits a goal statement');

  // `up --goal FILE` runs `graphyard goal FILE` with that input, never a work item create.
  const root = await temporaryDirectory('graphyard-up-goal-pipeline');
  await writeFile(join(root, 'goal.txt'), text);
  const w = world({ app: true, reviewer: true, accounts: true });
  const result = await runUp(request({ agent: true, goalFile: 'goal.txt' }), dependencies(w, root, [], { driveApp: async () => ({ state: 'done' }) }));
  assert.equal(result.exitCode, 0, result.next);
  assert.equal(result.goal, 'GOAL-1');
  const goals = w.calls.filter(args => args[0] === 'goal');
  assert.equal(goals.length, 1, 'one goal record');
  assert.deepEqual(goalInputSchema.parse(JSON.parse(await readFile(goals[0][1], 'utf8'))), input, 'the file holds the goal input `graphyard goal` reads');
  assert.equal(w.calls.filter(args => args.includes('create') || args[0] === 'work').length, 0, 'no plain work item');

  // The Setup page's 'Describe what you want built' posts to the goals API, never to work.
  const posts: { path: string; body: unknown }[] = [];
  const key = await submitGoal(async (path: string, body?: unknown) => { posts.push({ path, body }); return { key: 'GOAL-2', stage: 'acceptance-drafting' }; }, text);
  assert.equal(key, 'GOAL-2');
  assert.deepEqual(posts, [{ path: 'goals', body: input }]);
  assert.doesNotThrow(() => goalInputSchema.parse(posts[0].body));
});

test('unit:up-agent-keeps-serving — in agent mode a drive that gives up on Confirm access leaves the App page served and up waiting, handing the operator the manual route, instead of exiting', async () => {
  const { runUp } = await up();
  // The drive gives up (its 600 s Confirm-access wait ended); the install pauses once and is served again;
  // the operator then finishes the page in their own browser.
  const root = await temporaryDirectory('graphyard-up-keeps-serving');
  let drives = 0, gaveUpAt = -1, servedAfter = 0;
  const w = world({ accounts: true, pauseAfter: 50, onSleep: (current, ticks) => {
    if (gaveUpAt < 0) return;
    if (current.serving) servedAfter++;
    if (ticks === gaveUpAt + 120) { current.app = true; current.reviewer = true; }
  } });
  const result = await runUp(request({ agent: true }), dependencies(w, root, [], {
    driveApp: async () => { drives++; gaveUpAt = w.ticks; return { state: 'failed', reason: 'Confirm access was not completed within 600 s' }; },
  }));
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(servedAfter > 0, 'the App page was still served after the drive gave up');
  assert.ok(installApplies(w) >= 2, 'a paused install is served again rather than up exiting');
  assert.equal(drives, 1, 'the page is the operator\'s once the drive gave up: it is never driven again, so no App is registered twice');
  assert.equal(result.handoffs.length, 1, 'the manual route is handed off once');
  assert.equal(result.handoffs[0].url, 'http://127.0.0.1:4311');
  assert.match(result.handoffs[0].sentence, /could not finish the App page \(Confirm access was not completed within 600 s\)\. Open http:\/\/127\.0\.0\.1:4311 in your own browser \(on SSH, forward port 4311 to this machine first\) and finish it there: graphyard up keeps serving it/);
  assert.ok(result.completed.includes('control-plane'));

  // Up to its overall wait only: past it, the run stops resumable (exit 3, waiting), naming why, never as a failure.
  const late = world({ accounts: true, pauseAfter: 5 });
  const stopped = await runUp(request({ agent: true }), dependencies(late, await temporaryDirectory('graphyard-up-keeps-serving-late'), [], {
    humanWaitMs: 1, driveApp: async () => ({ state: 'failed', reason: 'Confirm access was not completed within 600 s' }),
  }));
  assert.equal(stopped.exitCode, 3, stopped.next);
  assert.match(stopped.next, /the browser could not finish the App page \(Confirm access was not completed within 600 s\).*rerun graphyard up to resume/);
});

test('unit:up-resume-from-state — a resumed up takes --repo and --provider from .graphyard/up.json and refuses only a conflicting value, naming both', async () => {
  const { recordedUp, runUp, upRequestFromArgs, upStateFile } = await up();
  const root = await temporaryDirectory('graphyard-up-resume-state');
  assert.equal(recordedUp(root), null, 'no run recorded here');
  assert.throws(() => upRequestFromArgs(['--agent'], recordedUp(root)), /--repo OWNER\/NAME/, 'a first run still needs --repo');
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(upStateFile(root), JSON.stringify({ version: 1, repository: 'acme/shop', provider: 'hetzner', completed: ['preflight', 'control-plane', 'host-supervisor', 'master-autonomy', 'onboarding', 'accounts', 'harness', 'master-loop'], noHerdr: false, goal: null }));
  assert.deepEqual(recordedUp(root), { repository: 'acme/shop', provider: 'hetzner' });

  // Resumed without --repo or --provider: both come from the recorded run, which then skips every done step.
  const resumed = upRequestFromArgs(['--agent'], recordedUp(root));
  assert.equal(resumed.repository, 'acme/shop');
  assert.equal(resumed.provider, 'hetzner');
  assert.equal(upRequestFromArgs(['--repo', 'acme/shop', '--agent'], recordedUp(root)).provider, 'hetzner', 'the same --repo, with --provider omitted');
  const w = world({ app: true, reviewer: true, accounts: true, installed: true, loop: true, onboardingMerged: true });
  const result = await runUp(resumed, dependencies(w, root, [], { driveApp: async () => ({ state: 'done' }) }));
  assert.equal(result.exitCode, 0, result.next);
  assert.equal(w.calls.filter(args => args[0] === 'install').length, 0, 'the recorded run resumes: nothing is installed again');

  // A conflicting value is refused, naming both.
  assert.throws(() => upRequestFromArgs(['--repo', 'acme/other', '--agent'], recordedUp(root)), /--repo acme\/other conflicts with acme\/shop, which the run recorded in \.graphyard\/up\.json resumes/);
  assert.throws(() => upRequestFromArgs(['--provider', 'compose'], recordedUp(root)), /--provider compose conflicts with hetzner/);
});

test('unit:up-signal-forwarding — SIGINT or SIGTERM to up reaches its install child; both exit and the App page port is freed', async () => {
  const root = await temporaryDirectory('graphyard-up-signals');
  // The stub stands in for `graphyard install`: its plan passes preflight; --apply serves an App page and waits forever.
  const stub = join(root, 'stub-cli.mjs');
  await writeFile(stub, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--plan')) { console.log(JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }] })); process.exit(0); }
const server = createServer((_, response) => response.end('App page')).listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  writeFileSync(process.env.STUB_SERVING, JSON.stringify({ pid: process.pid, port }));
  console.error('Open http://127.0.0.1:' + port + ' in a browser on this machine and confirm the Graphyard App');
});
`);
  const listening = (port: number) => new Promise<boolean>(accept => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); accept(true); }); socket.once('error', () => accept(false)); });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== 'ESRCH'; } };
  const launcher = resolve(import.meta.dirname, '../bin/graphyard.mjs');
  await Promise.all((['SIGINT', 'SIGTERM'] as const).map(async signal => {
    const serving = join(root, `${signal}.json`);
    const upProcess = spawn(process.execPath, [launcher, 'up', '--repo', 'acme/shop'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GRAPHYARD_CLI: stub, GRAPHYARD_REPOSITORY_ROOT: root, STUB_SERVING: serving } });
    let output = '';
    upProcess.stdout.on('data', chunk => { output += chunk; }); upProcess.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise<number | null>(accept => upProcess.once('exit', code => accept(code)));
    let child: { pid: number; port: number } | null = null;
    try {
      for (let waited = 0; !child; waited += 100) {
        assert.ok(waited < 60_000 && upProcess.exitCode === null, `${signal}: the install child never served its page: ${output}`);
        child = await readFile(serving, 'utf8').then(text => JSON.parse(text), () => null);
        if (!child) await new Promise(accept => setTimeout(accept, 100));
      }
      assert.ok(await listening(child.port), `${signal}: the child serves its App page`);
      upProcess.kill(signal);
      assert.equal(await exited, signal === 'SIGINT' ? 130 : 143, `${signal}: up exits once its child has: ${output}`);
      assert.equal(alive(child.pid), false, `${signal}: no install child survives up`);
      assert.equal(await listening(child.port), false, `${signal}: its port is free`);
    } finally {
      // A failed assertion leaves nothing running behind the test.
      if (child && alive(child.pid)) process.kill(child.pid, 'SIGKILL');
      if (upProcess.exitCode === null && upProcess.signalCode === null) upProcess.kill('SIGKILL');
    }
  }));
});

test('unit:up-provisions-master-autonomy — up gives the master its operator-agent identity with the admin credential the install saved, lists the step, and master create then succeeds with no further command', async () => {
  const { runUp } = await up();
  const { agentToken, loadStoredMasterConfig, runAutonomyCommand, setupMaster } = await import('../src/master.js');
  const { derivedIntent } = await import('../src/cli/planned-files-intent.js');
  // The control plane, as the master, the admin and the identity autonomy provisions each reach it.
  const masterToken = 'm'.repeat(40), agents: { id: string; token: string }[] = [], created: { credential: string; body: any }[] = [];
  const plane: typeof fetch = async (input, init) => {
    const path = String(input).replace(`${SERVER}/api/`, ''), bearer = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const answer = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === 'status') return bearer === ADMIN ? answer({ actor: { id: 'acme-shop-operator', role: 'admin' } }) : answer({ actor: { id: 'acme-shop-master', role: 'coordinator' }, repository: 'acme/shop', baseBranch: 'main', githubAppId: 1234 });
    if (path === 'operator-agents' && bearer === ADMIN) { if (body) agents.push({ id: body.id, token: body.token }); return answer(body ? { id: body.id } : agents.map(({ id }) => ({ id, capabilities: [], scope: {}, revision: 1 }))); }
    if (path === 'work' && agents.some(agent => agent.token === bearer && /-operator$/.test(agent.id))) { created.push({ credential: bearer, body }); return answer({ key: 'GY-1', revision: 1 }); }
    return answer({ error: 'forbidden' }, 403);
  };
  const runInstall = async (label: string, admin: string | null) => {
    const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-credentials`);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: root });
    const w = world({ app: true, reviewer: true, accounts: true });
    const base = dependencies(w, root, [], { operatorToken: async file => file === OPERATOR_TOKEN ? admin : null });
    // `master init` and `master autonomy` are the real commands, against the simulated control plane.
    const cli: UpDependencies['cli'] = async (args, options = {}) => {
      if (args[0] === 'master' && args[1] === 'init') { w.calls.push(args); assert.equal(options.stdin, masterToken); await setupMaster(root, { url: SERVER, token: options.stdin!, cliPath: resolve(import.meta.dirname, '../bin/graphyard.mjs'), credentialDirectory: credentials }, plane); return { code: 0, stdout: '{}' }; }
      if (args[0] === 'master' && args[1] === 'autonomy') {
        w.calls.push(args);
        await runAutonomyCommand(root, await loadStoredMasterConfig(root), 'autonomy', args.slice(2), { coordinator: async () => ({}), readSecret: async () => options.stdin ?? '', agents: () => [], daemonLock: async () => null, fetcher: plane });
        return { code: 0, stdout: '{}' };
      }
      return base.cli(args, options);
    };
    return { root, w, result: await runUp(request(), { ...base, cli }) };
  };
  // `graphyard master create FILE REASON`, as src/cli/master/intent.ts runs it.
  const masterCreate = async (root: string) => {
    const config = await loadStoredMasterConfig(root), file = join(root, 'intent.json');
    await writeFile(file, JSON.stringify({ title: 'Sign-up page', criteria: [{ id: 'AC-1', text: 'It creates a new .gitignore file.', proofs: ['unit:x'] }], plannedFiles: ['.gitignore'] }));
    return derivedIntent(root, config, 'create', [file, 'operator goal'], { coordinator: async () => ({ work: [] }), tree: async () => ({ ref: 'origin/main', files: new Set(['README.md']) }),
      token: () => agentToken(root, config, 'operatorAgent'),
      mutate: async (path, data, _id, credential) => { const response = await plane(`${SERVER}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}` }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result; } });
  };

  const { root, w, result } = await runInstall('graphyard-up-autonomy', ADMIN);
  assert.equal(result.exitCode, 0, result.next);
  assert.ok(result.completed.includes('master-autonomy'), 'the step is on up\'s checklist');
  assert.deepEqual(w.calls.find(args => args[1] === 'autonomy'), ['master', 'autonomy', '--admin-token-stdin', '--apply', '--harness', 'claude'], 'the admin credential goes on stdin, never in the arguments');
  assert.deepEqual(agents.map(agent => agent.id), ['graphyard-master-shop-operator', 'graphyard-approver-shop']);
  const config = await loadStoredMasterConfig(root);
  assert.equal(config.operatorAgent?.id, 'graphyard-master-shop-operator', 'recorded in the master configuration');
  const answer = await masterCreate(root);
  assert.equal(answer.key, 'GY-1', 'master create succeeds right after up');
  assert.equal(created[0].credential, agents[0].token, 'as the master\'s operator-agent identity');
  assert.ok(created[0].body.plannedFiles.includes('.gitignore'));
  // A rerun leaves the done step alone: the identity is provisioned once.
  assert.equal((await runUp(request(), { ...dependencies(w, root, []), operatorToken: async () => ADMIN })).exitCode, 0);
  assert.equal(w.calls.filter(args => args[1] === 'autonomy').length, 1);

  // With no admin credential on this machine, up stops (exit 2) at that step naming the one command, and master create is refused as before.
  agents.length = 0; created.length = 0;
  const missing = await runInstall('graphyard-up-autonomy-missing', null);
  assert.equal(missing.result.exitCode, 2, missing.result.next);
  assert.match(missing.result.next, /^master-autonomy: the operator's admin credential is not on this machine .*graphyard master autonomy --admin-token-stdin --apply/);
  assert.deepEqual(missing.result.completed, ['preflight', 'control-plane', 'host-supervisor']);
  await assert.rejects(masterCreate(missing.root), /No master operator-agent identity is provisioned/);
  // Once the operator has provisioned it by hand, the resumed run keeps that identity and carries on.
  const { setupAutonomy } = await import('../src/master.js');
  await setupAutonomy(missing.root, { adminToken: ADMIN, apply: true }, plane);
  const kept = await runUp(request(), { ...dependencies(missing.w, missing.root, []), operatorToken: async () => null });
  assert.equal(kept.exitCode, 0, kept.next);
  assert.ok(kept.completed.includes('master-autonomy'));
  assert.equal((await masterCreate(missing.root)).key, 'GY-1');
});

/**
 * GY-1478: the onboarding pull request is filed as a work item the loop owns, so no person merges it.
 * The stubbed loop below plays what the real one does once it runs: the repository's checks pass on
 * its candidate, the reviewer approves it, the control plane merges it.
 */
function onboardingLoop(w: World) {
  const filings: { url: string; operatorTokenFile: string | null; requestId: string }[] = [];
  let item: any = null, polls = 0;
  const gates = (test: boolean, review: boolean) => [{ name: 'build', passed: true }, { name: 'review', passed: review }, { name: 'test', passed: test }, { name: 'merge', passed: false }];
  return {
    filings, item: () => item,
    fileOnboarding: async (url: string, operatorTokenFile: string | null, requestId: string) => {
      filings.push({ url, operatorTokenFile, requestId });
      item ??= { key: 'GY-7', title: 'Add Graphyard onboarding', description: `${url}\n\nFiled by graphyard up.`, createdAt: new Date(0).toISOString(), stage: 'build',
        workspaces: [{ epoch: 1, branch: 'graphyard/onboarding' }], submission: { epoch: 1, pr: 1 }, gates: gates(false, false) };
      return { key: item.key };
    },
    // Each read is one loop tick, and only once the loop runs: checks pass, then the review, then the merge.
    work: async () => {
      if (item && w.loop && item.stage !== 'done') {
        polls++;
        if (polls === 2) item.gates = gates(true, false);
        if (polls === 3) item.gates = gates(true, true);
        if (polls === 4) { item.stage = 'done'; item.delivery = { mergedAt: new Date(0).toISOString(), mergeSha: 'a'.repeat(40) }; w.onboardingMerged = true; }
      }
      return item ? [{ key: 'GY-3', title: 'Something else', workspaces: [] }, item] : [];
    },
    onboardingMerged: async (url: string) => { assert.equal(url, w.onboardingPullRequest); w.calls.push(['onboarding-merged?']); return w.onboardingMerged; },
  };
}

test('unit:onboarding-pr-self-merges — up files the onboarding pull request as a loop-owned work item, the loop reviews and merges it, and up carries on with no operator action', async () => {
  const { runUp } = await up();
  const root = await temporaryDirectory('graphyard-up-onboarding-merge');
  await writeFile(join(root, 'goal.txt'), 'A sign-up page that sends a welcome email to every new user.');
  const w = world();
  const loop = onboardingLoop(w);
  const events: UpEvent[] = [];
  const result = await runUp(request({ agent: true, goalFile: 'goal.txt' }), dependencies(w, root, events, {
    driveApp: async () => { w.app = true; w.reviewer = true; return { state: 'done' }; },
    fileOnboarding: loop.fileOnboarding, work: loop.work, onboardingMerged: loop.onboardingMerged,
  }));
  assert.equal(result.exitCode, 0, result.next);
  assert.equal(result.goal, 'GOAL-1', 'the goal is submitted once the onboarding pull request merged');
  assert.deepEqual(result.handoffs, [], 'nothing is handed to a person: no review, approval or merge by hand');
  assert.equal(result.prompts, 0);
  // Filed once, during onboarding, with the operator credential the install named and a request id fixed before the first try.
  assert.equal(loop.filings.length, 1);
  assert.equal(loop.filings[0].url, 'https://github.com/acme/shop/pull/1');
  assert.equal(loop.filings[0].operatorTokenFile, OPERATOR_TOKEN);
  const saved = JSON.parse(await readFile(join(root, '.graphyard/up.json'), 'utf8'));
  assert.equal(saved.onboardingWork, 'GY-7');
  assert.equal(saved.onboardingRequest, loop.filings[0].requestId);
  assert.equal(saved.onboardingPullRequest, null, 'the wait ends once it merged');
  assert.ok(events.some(event => event.kind === 'step' && event.step === 'onboarding' && event.state === 'done' && /filed as GY-7 for the loop to review and merge/.test(event.detail ?? '')));
  // The stubbed loop reviewed it (checks, then review) and merged it; up showed each wait as it changed.
  const waits = events.flatMap(event => event.kind === 'onboarding' ? [event.wait] : []);
  assert.deepEqual(waits.map(wait => wait.waitingFor), [['checks', 'review'], ['review'], ['merge'], []]);
  assert.equal(waits.at(-1)?.merged, true);
  assert.equal(loop.item().stage, 'done');
  assert.equal(result.onboarding?.merged, true);
  assert.ok(w.calls.findIndex(args => args[0] === 'goal') > w.calls.findLastIndex(args => args[0] === 'onboarding-merged?'), 'the goal waits for the merge');

  // A rerun after the run finished files nothing again.
  const again = await runUp(request({ agent: true, goalFile: 'goal.txt' }), dependencies(w, root, [], { fileOnboarding: loop.fileOnboarding, work: loop.work, onboardingMerged: loop.onboardingMerged }));
  assert.equal(again.exitCode, 0, again.next);
  assert.equal(loop.filings.length, 1);

  // The filing itself: the item requires independent review and the repository's own checks, and is
  // created, released, claimed, given the onboarding branch and submitted under the operator's credential,
  // each step with an idempotency key derived from the fixed request id.
  const { fileOnboardingWork, onboardingChecks } = await import('../src/onboarding.js');
  const checkout = await temporaryDirectory('graphyard-up-onboarding-checks');
  assert.equal(await onboardingChecks(checkout), null, 'no graphyard.json: the control plane default');
  await writeFile(join(checkout, 'graphyard.json'), JSON.stringify({ delivery: { mode: 'release-candidate', candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null },
    mergeGate: { preMerge: [{ check: 'test', command: 'npm test', source: 'script', reason: 'fast unit tests' }, { check: 'lint', command: 'npm run lint', source: 'script', reason: 'static analysis' }],
      perCandidate: [{ check: 'e2e', command: 'npm run e2e', source: 'script', reason: 'long suite' }] } } }));
  const checks = await onboardingChecks(checkout);
  // The item as GET /api/work/:id reads it between the release and the claim; the claim answers the next epoch.
  let stored: any = { id: 'w-1', key: 'GY-7', epoch: 0, lease: null, submission: null };
  const posted: { method: string; path: string; key: string | null; auth: string | null; body: any }[] = [];
  const fetcher = (async (input: any, init: any) => {
    const path = new URL(String(input)).pathname, headers = init.headers as Record<string, string>;
    posted.push({ method: init.method, path, key: headers['Idempotency-Key'] ?? null, auth: headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    const answer = path === '/api/work' ? { id: 'w-1', key: 'GY-7' } : path === '/api/work/w-1' ? stored
      : path.endsWith('/claim') ? { id: 'w-1', key: 'GY-7', lease: { epoch: stored.epoch + 1 } } : { id: 'w-1', key: 'GY-7' };
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const token = 'a'.repeat(40), clock = Date.parse('2026-10-07T10:00:00Z');
  const fileWith = () => fileOnboardingWork({ server: SERVER, token, url: 'https://github.com/acme/shop/pull/1', checks, host: 'laptop', path: '/repo/.graphyard/onboarding', requestId: 'r-1' }, fetcher, () => clock);
  const filed = await fileWith();
  assert.deepEqual(filed, { key: 'GY-7', id: 'w-1' });
  assert.deepEqual(posted.map(entry => `${entry.method} ${entry.path}`), ['POST /api/work', 'POST /api/work/w-1/ready', 'GET /api/work/w-1', 'POST /api/work/w-1/claim', 'POST /api/work/w-1/workspace', 'POST /api/work/w-1/submit']);
  assert.deepEqual(posted.map(entry => entry.key), ['r-1-create', 'r-1-ready', null, 'r-1-claim-0', 'r-1-workspace-1', 'r-1-submit-1']);
  assert.ok(posted.every(entry => entry.auth === `Bearer ${token}`));
  const first = [...posted];
  // A rerun after the earlier try's lease lapsed claims a new epoch, not the expired claim's receipt.
  posted.length = 0; stored = { ...stored, epoch: 1, lease: { owner: 'operator', epoch: 1, expiresAt: new Date(clock - 1).toISOString() } };
  await fileWith();
  assert.deepEqual(posted.map(entry => entry.key), ['r-1-create', 'r-1-ready', null, 'r-1-claim-1', 'r-1-workspace-2', 'r-1-submit-2']);
  assert.deepEqual(posted.at(-1)?.body, { epoch: 2, pr: 1 });
  // A rerun within the earlier try's live lease acts under it; one after the submission files nothing more.
  posted.length = 0; stored = { ...stored, lease: { owner: 'operator', epoch: 1, expiresAt: new Date(clock + 60_000).toISOString() } };
  await fileWith();
  assert.deepEqual(posted.map(entry => entry.key), ['r-1-create', 'r-1-ready', null, 'r-1-workspace-1', 'r-1-submit-1']);
  posted.length = 0; stored = { ...stored, lease: null, submission: { epoch: 1, pr: 1 } };
  assert.deepEqual(await fileWith(), { key: 'GY-7', id: 'w-1' });
  assert.deepEqual(posted.map(entry => entry.path), ['/api/work', '/api/work/w-1/ready', '/api/work/w-1']);
  posted.splice(0, posted.length, ...first);
  const created = posted[0].body;
  assert.equal(created.title, 'Add Graphyard onboarding');
  assert.equal(created.type, 'chore', 'no documentation obligation: it changes no documented behaviour');
  assert.deepEqual(created.policy, { checks: ['test', 'lint'], review: true }, 'independent review and the checks branch protection requires');
  assert.match(created.description, /^https:\/\/github\.com\/acme\/shop\/pull\/1\n/);
  assert.deepEqual(posted[4].body, { epoch: 1, host: 'laptop', path: '/repo/.graphyard/onboarding', branch: 'graphyard/onboarding' });
  assert.deepEqual(posted[5].body, { epoch: 1, pr: 1 });
  // The item is valid input to the control plane's create.
  const { createSchema } = await import('../src/model/work.js');
  assert.ok(createSchema.safeParse(created).success, JSON.stringify(createSchema.safeParse(created).error?.issues));
});

test('unit:onboarding-pr-visible — while the onboarding pull request is open, up and the Setup page show it as the current step with its URL, what it waits for and the time waited', async () => {
  const { onboardingWait } = await import('../src/model/onboarding-work.js');
  const { describeUpEvent } = await up();
  const filed = Date.parse('2026-10-07T10:00:00Z'), now = filed + 12 * 60_000;
  const item = { key: 'GY-7', title: 'Add Graphyard onboarding', description: 'https://github.com/acme/shop/pull/1\n\nFiled by graphyard up.', createdAt: new Date(filed).toISOString(), stage: 'review',
    workspaces: [{ epoch: 1, branch: 'graphyard/onboarding' }], submission: { epoch: 1, pr: 1 }, gates: [{ name: 'review', passed: false }, { name: 'test', passed: true }] };
  const wait = onboardingWait(item, now);
  assert.deepEqual({ key: wait.key, url: wait.url, waitingFor: wait.waitingFor, merged: wait.merged, waitedMs: wait.waitedMs }, { key: 'GY-7', url: 'https://github.com/acme/shop/pull/1', waitingFor: ['review'], merged: false, waitedMs: 12 * 60_000 });
  assert.equal(wait.line, 'The change that adds Graphyard\'s delivery workflows to your repository is waiting for an independent review. It has waited 12 min and merges by itself; nothing is needed from you.');
  assert.deepEqual(onboardingWait({ ...item, gates: [] }, now).waitingFor, ['checks', 'review']);
  // up's line: the item, its URL, what it waits for and how long.
  assert.equal(describeUpEvent({ kind: 'onboarding', wait }), '· onboarding: GY-7 (https://github.com/acme/shop/pull/1) waits for review, 12 min so far; the loop reviews and merges it');

  // The Setup page: every other item green, yet the page is not "ready" and offers no goal box while the change is open.
  const green = { github: true, githubRepository: 'acme/shop', appPermissions: { missing: [] }, reviewerApps: [{ id: 'claude', appId: 9 }],
    fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
    setup: { protection: 'complete', loop: true } };
  const { SetupView } = await import('../web/pages/setup.js');
  const page = (work: any[] | null, workUnread = false) => renderToStaticMarkup(createElement(SetupView, { status: green, work, workUnread, now, onConnect: () => {}, onSubmitGoal: () => {} }));
  const open = page([{ key: 'GY-3', title: 'Other', workspaces: [] }, item]);
  assert.match(open, /<li data-setup-item="onboarding" data-done="no" data-waiting-for="review" aria-current="step">/);
  assert.match(open, /<a [^>]*data-setup-action="onboarding"[^>]*href="https:\/\/github\.com\/acme\/shop\/pull\/1"[^>]*>Open the change<\/a>/);
  const text = visible(open);
  assert.ok(text.includes(wait.line), 'the checklist line names what it waits for and the time waited');
  assert.match(text, /1 of 7 steps left/);
  assert.doesNotMatch(open, /Describe what you want built/, 'the goal waits for the merge, as up does');
  for (const [what, pattern] of JARGON) assert.doesNotMatch(text, pattern, `the onboarding step shows no ${what}`);
  // Merged, on merge evidence: the step is done and the goal box is offered.
  const delivered = { ...item, stage: 'done', delivery: { mergedAt: new Date(now).toISOString(), mergeSha: 'a'.repeat(40) } };
  const merged = page([delivered]);
  assert.match(merged, /data-setup-item="onboarding" data-done="yes"/);
  assert.match(merged, /<form aria-label="Describe what you want built"/);
  assert.match(visible(merged), /Everything is ready\./);
  // Closed without merging (done with a closure): the workflows never landed, so it is not merged and the goal box stays closed.
  const closedWait = onboardingWait({ ...item, stage: 'done', closure: { kind: 'superseded' } }, now);
  assert.deepEqual({ merged: closedWait.merged, closed: closedWait.closed, waitingFor: closedWait.waitingFor }, { merged: false, closed: true, waitingFor: [] });
  const closed = page([{ ...item, stage: 'done', closure: { kind: 'superseded' } }]);
  assert.match(closed, /data-setup-item="onboarding" data-done="no"/);
  assert.match(visible(closed), /closed without merging/);
  assert.doesNotMatch(closed, /Describe what you want built/);
  assert.match(describeUpEvent({ kind: 'onboarding', wait: closedWait }), /^· onboarding: GY-7: .*closed without merging/);
  // Until the work items are read (or while the read fails), whether it merged is unknown: no goal box.
  const unread = page(null, true);
  assert.doesNotMatch(unread, /Describe what you want built/);
  assert.match(visible(unread), /Checking whether the onboarding change has merged/);
});

test('unit:onboarding-generates-workflow — onboarding a repository with no CI writes a delivery workflow (build and test for its stack, then Graphyard\'s gate) into the onboarding change, up claims only the workflows the apply wrote, and publishOnboarding refuses naming a file it means to publish that is missing', async () => {
  const { buildProposal, collectScanInput, deliveryGateJob, deliveryWorkflowFile, detectStack, hasNoCi, renderDeliveryWorkflow, writeDeliveryWorkflow } = await import('../src/onboarding.js');
  const detectStackName = (input: Parameters<typeof detectStack>[0]) => detectStack(input).name;
  const { applyProposal, repositoryScanDifference, saveProposal, scanProposal } = await import('../src/repository-setup.js');
  const { publishOnboarding, runUp } = await up();
  const gitRoot = await temporaryDirectory('graphyard-up-greenfield');
  const git = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', ...env } });
  const origin = join(gitRoot, 'origin.git'), checkout = join(gitRoot, 'checkout');
  git(gitRoot, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  git(gitRoot, ['clone', '--quiet', origin, checkout]);
  git(checkout, ['remote', 'set-url', 'origin', 'git@github.com:acme/game.git']);
  // A greenfield game: a Node package with a test script and no CI workflow at all.
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'game', scripts: { build: 'tsc', test: 'node --test' } }));
  await writeFile(join(checkout, 'index.html'), '<canvas></canvas>\n');
  git(checkout, ['add', '.']); git(checkout, ['commit', '--quiet', '-m', 'first']);
  git(checkout, ['push', '--quiet', origin, 'HEAD:main']);

  const proposal = await scanProposal(checkout, { url: 'https://graphyard.example', runtimes: [] });
  assert.equal(proposal.ci.system, 'none');
  await saveProposal(checkout, proposal);
  const applyDeps = { url: 'https://graphyard.example', githubSetup: async () => ({ appId: 1, slug: 'graphyard-acme-game' }), now: () => new Date('2030-01-01T00:00:00Z') };
  const applied = await applyProposal(checkout, proposal, applyDeps);
  assert.deepEqual(applied.delivery!.workflows, [deliveryWorkflowFile], 'the apply reports the workflow it wrote');
  assert.ok(applied.applied.includes(deliveryWorkflowFile));
  const workflow = await readFile(join(checkout, deliveryWorkflowFile), 'utf8');
  assert.equal(workflow, renderDeliveryWorkflow({ name: 'node', frameworks: ['node:test'], commands: proposal.commands }).content);
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \["main"\]\n/m);
  assert.match(workflow, /  build:\n[\s\S]*npm ci; else npm install[\s\S]*- run: npm run build\n/);
  assert.match(workflow, /  test:\n[\s\S]*- run: npm test\n/);
  assert.match(workflow, new RegExp(`  ${deliveryGateJob}:\\n    needs: \\[build, test\\]\\n    if: always\\(\\)`));
  // The generated workflow is Graphyard's own output: a rescan still sees no CI, and a rerun changes nothing.
  assert.equal(hasNoCi(await collectScanInput(checkout)), true);
  assert.deepEqual(repositoryScanDifference(await scanProposal(checkout, { url: 'https://graphyard.example', runtimes: [] }), proposal), []);
  assert.ok((await applyProposal(checkout, proposal, applyDeps)).unchanged.includes(deliveryWorkflowFile));
  assert.deepEqual(await writeDeliveryWorkflow(checkout, 'main'), { path: deliveryWorkflowFile, state: 'unchanged' });
  // A repository with CI of its own gets none.
  const withCi = buildProposal({ files: ['package.json', '.github/workflows/ci.yml'], contents: { 'package.json': '{"scripts":{"test":"vitest"}}', '.github/workflows/ci.yml': 'on: [pull_request]\njobs:\n  unit:\n    runs-on: ubuntu-latest\n' } }, { repository: 'acme/game' });
  assert.equal(withCi.ci.system, 'github-actions');
  const ciRepo = await temporaryDirectory('graphyard-up-has-ci');
  await mkdir(join(ciRepo, '.github/workflows'), { recursive: true });
  await writeFile(join(ciRepo, '.github/workflows/ci.yml'), 'on: [pull_request]\n');
  assert.equal(await writeDeliveryWorkflow(ciRepo, 'main'), null);
  // A workflow that never runs on pull requests (a stale-issue bot, a push-only deploy) is not CI: a pull
  // request could wait on none of its checks, so the repository still gets the delivery workflow and its gate.
  const botsOnly = { files: ['package.json', '.github/workflows/stale.yml', '.github/workflows/deploy.yml'], contents: {
    'package.json': '{"scripts":{"test":"node --test"}}',
    '.github/workflows/stale.yml': 'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  stale:\n    runs-on: ubuntu-latest\n',
    '.github/workflows/deploy.yml': 'on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n' } };
  assert.equal(hasNoCi(botsOnly), true);
  assert.deepEqual(buildProposal(botsOnly, { repository: 'acme/game' }).policy.checks, [deliveryGateJob], 'work items wait for the gate job, not checks no pull request reports');
  await writeFile(join(ciRepo, '.github/workflows/ci.yml'), 'on:\n  push:\n');
  assert.deepEqual(await writeDeliveryWorkflow(ciRepo, 'main'), { path: deliveryWorkflowFile, state: 'written' });
  // An operator's edit to the generated workflow is kept and reported as drift, never overwritten by a rerun.
  const edited = workflow.replace(/- run: npm test\n/, '- run: npm test -- --coverage\n');
  await writeFile(join(checkout, deliveryWorkflowFile), edited);
  const reapplied = await applyProposal(checkout, proposal, applyDeps);
  assert.equal(await readFile(join(checkout, deliveryWorkflowFile), 'utf8'), edited);
  assert.ok(reapplied.drift.some(line => line.startsWith(`${deliveryWorkflowFile} differs from the generated workflow`)), reapplied.drift.join('; '));
  assert.ok(!reapplied.applied.includes(deliveryWorkflowFile));
  assert.deepEqual(reapplied.delivery!.workflows, [deliveryWorkflowFile], 'the kept workflow is still published');
  await writeFile(join(checkout, deliveryWorkflowFile), workflow);
  // Other stacks still get a build and a test job.
  assert.match(renderDeliveryWorkflow({ name: 'python', frameworks: ['pytest'], commands: [] }).content, /- run: python -m pytest -q\n/);
  assert.match(renderDeliveryWorkflow({ name: 'unknown', frameworks: [], commands: [] }).content, /No test step was detected/);

  // The publish carries the workflow on the base tip, and the pull request names it.
  const gh: string[][] = [];
  const runner = (program: string, args: string[], env?: Record<string, string>) => {
    if (program === 'git') return git(checkout, args.map(arg => arg === 'origin' ? origin : arg), env);
    gh.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return '\n';
    if (args[0] === 'repo') return 'main\n';
    return 'https://github.com/acme/game/pull/1\n';
  };
  assert.deepEqual(await publishOnboarding(checkout, 'acme/game', runner, [deliveryWorkflowFile]), { pullRequest: 'https://github.com/acme/game/pull/1' });
  const tree = git(origin, ['ls-tree', '-r', '--name-only', 'graphyard/onboarding']).trim().split('\n');
  assert.ok(tree.includes(deliveryWorkflowFile) && tree.includes('AGENTS.md') && tree.includes('graphyard.json') && tree.includes('.gitignore'), tree.join(', '));
  assert.match(gh.find(args => args[1] === 'create')!.at(-1)!, new RegExp(`delivery workflows \\(${deliveryWorkflowFile.replace(/[./]/g, '\\$&')}\\)`));
  // A pull request already open from an earlier run or an older CLI, whose branch lacks the delivery
  // workflow, is not reported as carrying it: its branch is rebuilt and force-pushed before it is reused.
  const stale = git(origin, ['rev-parse', 'main']).trim();
  git(origin, ['update-ref', 'refs/heads/graphyard/onboarding', stale]);
  const reopened = (program: string, args: string[], env?: Record<string, string>) => program === 'gh' && args[0] === 'pr' && args[1] === 'list' ? 'https://github.com/acme/game/pull/1\n' : runner(program, args, env);
  const created = gh.filter(args => args[1] === 'create').length;
  assert.deepEqual(await publishOnboarding(checkout, 'acme/game', reopened, [deliveryWorkflowFile]), { pullRequest: 'https://github.com/acme/game/pull/1' });
  assert.ok(git(origin, ['ls-tree', '-r', '--name-only', 'graphyard/onboarding']).includes(deliveryWorkflowFile), 'the open pull request now carries the workflow it is reported with');
  assert.equal(gh.filter(args => args[1] === 'create').length, created, 'the open pull request is reused, not duplicated');

  // The pull request waits for the check the generated workflow reports — its gate job — whatever the
  // stack's scripts are named: typecheck, lint and pytest run inside its jobs and never report on their own.
  const { requiredPullRequestChecks } = await import('../src/model/delivery-policy.js');
  assert.deepEqual(applied.delivery!.requiredChecks, [deliveryGateJob]);
  assert.deepEqual(requiredPullRequestChecks(JSON.parse(await readFile(join(checkout, 'graphyard.json'), 'utf8')).delivery), [deliveryGateJob], 'the committed policy requires the gate job');
  assert.deepEqual(proposal.policy.checks, [deliveryGateJob]);
  const emitted = (stack: Parameters<typeof renderDeliveryWorkflow>[0]) => [...renderDeliveryWorkflow(stack).content.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
  for (const [label, input] of [
    ['a Node repository with typecheck and lint scripts', { files: ['package.json'], contents: { 'package.json': JSON.stringify({ scripts: { build: 'tsc', typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run', 'test:e2e': 'playwright test' }, devDependencies: { vitest: '1' } }) } }],
    ['a pytest repository', { files: ['pyproject.toml', 'tests/test_game.py'], contents: { 'pyproject.toml': '[tool.pytest.ini_options]\n# pytest\n' } }],
    ['a repository with no detected commands', { files: ['main.go'], contents: {} }],
  ] as const) {
    const scanned = buildProposal(input as any, { repository: 'acme/game' });
    assert.equal(scanned.ci.system, 'none', label);
    const required = requiredPullRequestChecks(scanned.delivery!);
    assert.deepEqual(required, [deliveryGateJob], `${label}: pull requests require only the gate job`);
    assert.deepEqual(scanned.policy.checks, [deliveryGateJob], `${label}: work items wait for the gate job`);
    const jobs = emitted({ name: detectStackName(input as any), frameworks: [], commands: [] });
    for (const check of required) assert.ok(jobs.includes(check), `${label}: ${check} is a job the generated workflow emits (${jobs.join(', ')})`);
    assert.ok(scanned.delivery!.mergeGate.perCandidate.every(entry => entry.command), `${label}: a per-candidate check is one the candidate workflow runs`);
  }

  // A file the publish means to carry that is missing is refused by name; nothing is pushed.
  const missing = join(gitRoot, 'missing');
  await mkdir(missing, { recursive: true });
  await writeFile(join(missing, 'AGENTS.md'), '# Agents\n');
  await writeFile(join(missing, 'graphyard.json'), '{}\n');
  let ran = 0;
  await assert.rejects(publishOnboarding(missing, 'acme/game', () => { ran++; return ''; }, [deliveryWorkflowFile]), new RegExp(`publishOnboarding refuses: ${deliveryWorkflowFile.replace(/[./]/g, '\\$&')} is missing`));
  await assert.rejects(publishOnboarding(missing, 'acme/game', () => { ran++; return ''; }, ['.github/workflows/ci.yml', 'graphyard.json']), /\.github\/workflows\/ci\.yml is missing/);
  assert.equal(ran, 0, 'a refused publish runs nothing');

  // up passes the workflows the apply reported to the publish and claims exactly those; with none it claims none.
  for (const workflows of [[deliveryWorkflowFile], []]) {
    const w = world({ app: true, reviewer: true, accounts: true, loop: true, onboardingMerged: true });
    const root = await temporaryDirectory('graphyard-up-onboarding-claims');
    const events: UpEvent[] = [];
    const published: string[][] = [];
    const deps = dependencies(w, root, events);
    const cli = deps.cli;
    const result = await runUp(request(), { ...deps,
      cli: async (args, options) => args.join(' ').startsWith('init --scan --apply') ? (w.calls.push(args), { code: 0, stdout: JSON.stringify({ delivery: { workflows } }) }) : cli(args, options),
      publishOnboarding: async files => { published.push(files); w.onboardingPullRequest = 'https://github.com/acme/shop/pull/1'; return { pullRequest: w.onboardingPullRequest }; } });
    assert.equal(result.exitCode, 0, result.next);
    assert.deepEqual(published, [workflows]);
    const detail = events.find((event): event is Extract<UpEvent, { kind: 'step' }> => event.kind === 'step' && event.step === 'onboarding' && event.state === 'done')!.detail!;
    if (workflows.length) assert.match(detail, /graphyard-delivery\.yml published in/);
    else { assert.doesNotMatch(detail, /workflow applied|delivery workflows? published/); assert.match(detail, /no delivery workflow was written/); }
  }
});

test('unit:up-preflight-clean-cli — up refuses at preflight, naming the dirty paths, before installing anything when the CLI checkout the master loop runs from holds uncommitted work; a loop that refuses to start fails the master-loop step with its cause instead of stalling', async () => {
  const { runUp, upExitCodes } = await up();
  // A dirty CLI checkout: preflight refuses with the paths and nothing is planned or installed.
  const dirty = world();
  const events: UpEvent[] = [];
  const refused = await runUp(request(), { ...dependencies(dirty, await temporaryDirectory('graphyard-up-dirty-cli'), events),
    cliCheckout: async () => ({ root: '/opt/graphyard', dirty: ['src/up.ts', 'tests/new.test.ts'] }) });
  assert.equal(refused.exitCode, upExitCodes.prerequisite);
  assert.match(refused.next, /^preflight: the Graphyard CLI checkout the master loop runs from \(\/opt\/graphyard\) holds uncommitted work.*src\/up\.ts, tests\/new\.test\.ts/);
  assert.deepEqual(refused.completed, []);
  assert.equal(dirty.calls.filter(args => args[0] === 'install').length, 0, 'nothing is planned or installed');

  // A clean checkout passes preflight; a loop that then refuses to start is a failed step naming the cause, long before the machine wait ends.
  const w = world({ app: true, reviewer: true, accounts: true, onboardingMerged: true });
  let checks = 0;
  const loopEvents: UpEvent[] = [];
  const cause = 'the master loop refuses to start, self-upgrade or restart from the coordinator checkout at /opt/graphyard: it holds uncommitted work';
  const stalled = await runUp(request(), { ...dependencies(w, await temporaryDirectory('graphyard-up-loop-refuses'), loopEvents), machineWaitMs: 600_000,
    cliCheckout: async () => { checks++; return { root: '/opt/graphyard', dirty: [] }; },
    loopRefusal: async () => w.calls.some(args => args.join(' ') === 'master restart') ? cause : null,
    status: async () => { const current = status(w); return current && { ...current, setup: { ...current.setup, loop: false } }; } });
  assert.equal(stalled.exitCode, upExitCodes.failed);
  assert.equal(stalled.next, `master-loop: the master loop refuses to run: ${cause}`);
  assert.ok(stalled.completed.includes('preflight') && !stalled.completed.includes('master-loop'));
  assert.ok(checks >= 2, 'the checkout is read at preflight and again before the loop starts');
  assert.ok(w.ticks < 5, 'the refusal is reported at once, not after the machine wait');

  // Even when the checklist reads the loop as live, a refusing loop fails the step.
  const live = world({ app: true, reviewer: true, accounts: true, loop: true, onboardingMerged: true });
  const green = await runUp(request(), { ...dependencies(live, await temporaryDirectory('graphyard-up-loop-live'), []), loopRefusal: async () => cause });
  assert.equal(green.exitCode, upExitCodes.failed);
  assert.match(green.next, /^master-loop: the master loop refuses to run/);

  // A resumed run whose checkout was dirtied after an earlier run's preflight passed is refused before it installs anything.
  const resumed = world();
  const resumedRoot = await temporaryDirectory('graphyard-up-resumed-dirty');
  await mkdir(join(resumedRoot, '.graphyard'), { recursive: true });
  await writeFile(join(resumedRoot, '.graphyard/up.json'), JSON.stringify({ version: 1, repository: 'acme/shop', provider: 'compose', completed: ['preflight'], noHerdr: false, goal: null }));
  const resumedResult = await runUp(request(), { ...dependencies(resumed, resumedRoot, []), cliCheckout: async () => ({ root: '/opt/graphyard', dirty: ['src/up.ts'] }) });
  assert.equal(resumedResult.exitCode, upExitCodes.prerequisite);
  assert.match(resumedResult.next, /^preflight: .*src\/up\.ts/);
  assert.deepEqual(resumed.calls.filter(args => args[0] === 'install'), [], 'a resumed run installs nothing from a dirty checkout');

  // A checkout dirtied after preflight is refused again before the loop restarts.
  const late = world({ app: true, reviewer: true, accounts: true, onboardingMerged: true });
  let reads = 0;
  const lateResult = await runUp(request(), { ...dependencies(late, await temporaryDirectory('graphyard-up-late-dirty'), []), cliCheckout: async () => ({ root: '/opt/graphyard', dirty: reads++ === 0 ? [] : ['src/up.ts'] }) });
  assert.equal(lateResult.exitCode, upExitCodes.prerequisite);
  assert.match(lateResult.next, /^master-loop: .*src\/up\.ts/);
  assert.ok(!late.calls.some(args => args.join(' ') === 'master restart'), 'the loop is not restarted onto a dirty checkout');
});

test('unit:research-worktree-managed-repo — the loop makes its research scratch worktree from the managed repository\'s own checkout, not from the Graphyard CLI checkout, when the two differ', async () => {
  const { openResearchScratch, researchScratchSource } = await import('../src/daemon/run.js');
  const repository = async (name: string, file: string) => {
    const directory = await temporaryDirectory(name);
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
    await mkdir(join(directory, 'bin'), { recursive: true });
    await writeFile(join(directory, file), `${name}\n`);
    git('add', '.'); git('commit', '-q', '-m', name);
    return { directory, head: git('rev-parse', 'HEAD') };
  };
  const cli = await repository('graphyard-cli', 'bin/graphyard.mjs');
  const managed = await repository('managed-game', 'game.js');
  const config = { cliPath: join(cli.directory, 'bin', 'graphyard.mjs'), repository: 'acme/game', run: { worktreeRoot: await temporaryDirectory('research-scratch-root') } } as any;
  // The source is the managed repository the loop runs for; only a loop given none falls back to the CLI's checkout.
  assert.equal(researchScratchSource(config, managed.directory), resolve(managed.directory));
  assert.equal(researchScratchSource(config), resolve(cli.directory));
  const logs: string[] = [];
  const scratch = await openResearchScratch(researchScratchSource(config, managed.directory), config, managed.head, line => logs.push(line));
  assert.deepEqual(logs, [], 'the managed commit is found where the worktree is made');
  assert.ok(scratch && scratch.endsWith('checkout'), `the scratch holds a worktree of the release (${scratch})`);
  const inScratch = (...args: string[]) => execFileSync('git', ['-C', scratch!, ...args], { encoding: 'utf8' }).trim();
  assert.equal(inScratch('rev-parse', 'HEAD'), managed.head);
  assert.equal(resolve(scratch!, inScratch('rev-parse', '--git-common-dir')), resolve(managed.directory, '.git'), 'the worktree belongs to the managed repository');
  assert.ok(!execFileSync('git', ['-C', cli.directory, 'worktree', 'list'], { encoding: 'utf8' }).includes(scratch!), 'the CLI checkout holds no research worktree');
  // The CLI checkout holds no commit of the managed repository: a worktree made there fails as the pilot's did.
  const fromCli: string[] = [];
  const config2 = { ...config, run: { worktreeRoot: await temporaryDirectory('research-scratch-cli-root') } };
  await openResearchScratch(researchScratchSource(config2), config2, managed.head, line => fromCli.push(line));
  assert.match(fromCli.join('\n'), /holds no worktree of/);
});
