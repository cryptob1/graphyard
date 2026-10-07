import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

interface World {
  calls: string[][]; installed: boolean; app: boolean; reviewer: boolean; accounts: boolean; loop: boolean;
  /** Herdr's plugin is bound to another server. */
  herdrElsewhere: boolean;
  /** Commands that fail once, by their joined arguments' prefix. */
  failOnce: Set<string>;
  /** Called on each sleep: where a test plays the person acting on the Setup page. */
  onSleep: (world: World, ticks: number) => void;
  ticks: number;
}

function world(overrides: Partial<World> = {}): World {
  return { calls: [], installed: false, app: false, reviewer: false, accounts: false, loop: false, herdrElsewhere: false, failOnce: new Set(), onSleep: () => {}, ticks: 0, ...overrides };
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
    serverUrl: async () => w.installed ? SERVER : null,
    masterToken: async () => w.installed ? 'm'.repeat(40) : null,
    status: async () => status(w),
    async cli(args, options = {}) {
      w.calls.push(args);
      const joined = args.join(' ');
      for (const prefix of w.failOnce) if (joined.startsWith(prefix)) { w.failOnce.delete(prefix); return { code: 1, stdout: '{"error":"interrupted"}' }; }
      if (args[0] === 'install' && args.includes('--plan')) {
        return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'GitHub CLI', ok: true }, ...(w.herdrElsewhere && !args.includes('--no-herdr') ? [{ name: 'Herdr plugin', ok: false, detail: 'bound to https://other.example' }] : [])] }) };
      }
      if (args[0] === 'install' && args.includes('--apply')) {
        w.installed = true;
        options.onLine?.('Open http://127.0.0.1:4311 in a browser on this machine and confirm the Graphyard App');
        for (let turns = 0; !(w.app && w.reviewer); turns++) { if (turns > 10_000) return { code: 1, stdout: JSON.stringify({ resume: 'graphyard install --apply' }) }; await yieldTurn(); }
        return { code: 0, stdout: '{"ok":true}' };
      }
      if (joined === 'master registry propose --apply') { w.accounts = true; return { code: 0, stdout: '{}' }; }
      if (joined === 'master restart') { w.loop = true; return { code: 0, stdout: '{}' }; }
      if (args[0] === 'master' && args[1] === 'create') return { code: 0, stdout: JSON.stringify({ key: 'GY-1', title: 'goal' }) };
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
  assert.deepEqual(result.completed, ['preflight', 'control-plane', 'host-supervisor', 'onboarding', 'accounts', 'harness', 'master-loop']);
  assert.deepEqual(fresh.calls.map(args => args.slice(0, 2).join(' ')), ['install --provider', 'install --provider', 'master init', 'init --scan', 'init --scan', 'master harness', 'master restart'], 'preflight, control plane, host supervisor, onboarding, harness, master loop, in order');
  assert.ok(result.checklist.every(item => item.done), 'the checklist is green');
  const waits = events.filter(event => event.kind === 'waiting');
  assert.equal(waits.length, 1, 'the Setup address is printed once for the whole run');
  assert.equal(result.prompts, 1);
  assert.equal(result.setupUrl, `${SERVER}/#setup`);
  assert.match((waits[0] as any).sentence, /^Open http:\/\/127\.0\.0\.1:4310\/#setup /);
  assert.ok(!fresh.calls.flat().includes('--herdr-rebind'), 'never repoints Herdr');

  // An interrupted run: onboarding fails once. The rerun skips everything recorded done, so the
  // install (which registers the identities, Apps and variables) runs exactly once overall.
  const interruptedRoot = await temporaryDirectory('graphyard-up-interrupted');
  const interrupted = world({ app: true, reviewer: true, accounts: true, failOnce: new Set(['init --scan --apply']) });
  const first = await runUp(request(), dependencies(interrupted, interruptedRoot, []));
  assert.equal(first.exitCode, 1);
  assert.match(first.next, /^onboarding: graphyard init exited 1/);
  assert.deepEqual(first.completed, ['preflight', 'control-plane', 'host-supervisor']);
  const resumedEvents: UpEvent[] = [];
  const resumed = await runUp(request(), dependencies(interrupted, interruptedRoot, resumedEvents));
  assert.equal(resumed.exitCode, 0, resumed.next);
  assert.equal(installApplies(interrupted), 1, 'the resumed run does not install again');
  assert.equal(interrupted.calls.filter(args => args.join(' ').startsWith('master init')).length, 1, 'nor register the supervisor again');
  assert.deepEqual(resumedEvents.filter(event => event.kind === 'step' && event.state === 'skipped').map(event => (event as any).step), ['preflight', 'control-plane', 'host-supervisor']);

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
});

test('unit:graphyard-up-agent-mode — up --agent reaches a green checklist with zero prompts when no device approval is needed, hands off exactly one step when one is, and submits the goal from a file', async () => {
  const { browserAppDriver, runUp, upRequestFromArgs } = await up();
  assert.deepEqual(upRequestFromArgs(['--repo', 'acme/shop', '--agent', '--goal', 'goal.txt']), { repository: 'acme/shop', provider: 'compose', agent: true, reviewer: 'claude', master: 'claude', goalFile: 'goal.txt', browserProfile: null });
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
  const create = quiet.calls.find(args => args[0] === 'master' && args[1] === 'create')!;
  assert.ok(create, 'the goal is submitted');
  assert.equal(result.goal, 'GY-1');
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
  assert.deepEqual(handed, ['Approve the GitHub Mobile prompt on your phone and choose 42']);
  assert.deepEqual(clicked, ['#register', '#create', '#install']);
  assert.ok(opened.includes('https://github.com/apps/graphyard-acme-shop/installations/new/permissions?suggested_target_id=11&repository_ids[]=22'), 'installs on the one repository');
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
  const { goalWorkItem, setupChecklist } = await checklistModule();
  const green = { github: true, githubRepository: 'acme/shop', appPermissions: { missing: [] }, reviewerApps: [{ id: 'claude', appId: 9 }],
    fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, smoke: { result: 'pass' } }] },
    setup: { protection: 'complete', loop: true } };
  const states: { name: string; status: any; item: string; action: RegExp | null }[] = [
    { name: 'nothing installed yet', status: null, item: 'github-app', action: /<a [^>]*data-setup-action="github-app"[^>]*href="http:\/\/127\.0\.0\.1:4311"[^>]*>Create the GitHub App<\/a>/ },
    { name: 'App missing permissions', status: { ...green, appPermissions: { missing: [{ permission: 'checks', required: 'write' }], installationUrl: 'https://github.com/settings/installations/7' } }, item: 'github-app', action: /data-setup-action="github-app"[^>]*href="https:\/\/github\.com\/settings\/installations\/7"[^>]*>Accept the new permissions</ },
    { name: 'no reviewer App', status: { ...green, reviewerApps: [] }, item: 'reviewer-app', action: />Create the reviewer App</ },
    { name: 'no account for writing code', status: { ...green, fleet: { roles: [], accounts: [] } }, item: 'account:worker', action: /<button[^>]*data-setup-action="account:worker"[^>]*>Connect an account<\/button>/ },
    { name: 'a signed-out account', status: { ...green, fleet: { ...green.fleet, accounts: [{ name: 'claude-a', enabled: true, loggedIn: false }] } }, item: 'account:reviewer', action: />Connect an account</ },
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
  // Partially protected (the repository's checks only) is enough to start; the line says what follows.
  assert.equal(setupChecklist({ ...green, setup: { protection: 'checks', loop: true } }).find(item => item.id === 'branch-protection')!.done, true);
  // The goal becomes a first work item the master refines.
  const goal = goalWorkItem('  A sign-up page that sends a welcome email\nUse the existing mailer.  ');
  assert.equal(goal.title, 'A sign-up page that sends a welcome email');
  assert.match(goal.description, /Use the existing mailer\.$/);
  assert.deepEqual(goal.criteria.map(criterion => criterion.proofs), [['manual:goal-delivered']]);
  assert.throws(() => goalWorkItem('short'), /at least 10 characters/);
});
