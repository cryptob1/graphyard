import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { assertDispatchable, awaitRuntimeStart, consentHold, dispatchWork, loadMasterConfig, saveProducerProfile, SessionStartError, setupMaster, startAgentSession, type HerdrAgent, type WorkerProfile } from '../src/master.js';
import { consentAnswers, consentHoldMs, detectConsentPrompt, readConsentHolds, writeConsentHold } from '../src/consent-prompt.js';
import { consentHoldItems } from '../src/cli/master-status.js';
import { assignmentSurrender, consentHoldProbe, supervise } from '../src/supervisor.js';
import { launchProducer, readProducerLedger, saveProducerLedger } from '../src/producer.js';
import { expandTypedCommand } from './helpers/launch-shell.js';

// GY-130: a runtime that stops on a first-run consent prompt is not a started session. The
// launcher reads the prompt off the pane, answers only the prompts on its allow-list with their
// least-privilege option, holds a worker on any other prompt with one attention item, and the
// watch supervisor gives the slot back once the hold outlives its bound. One case per proof:
// unit:consent-prompt-detected, integration:known-consent-answered-unknown-escalated,
// integration:unconsented-session-releases-its-slot, manual:consent-prompt-docs-review.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-23T05:00:00.000Z';
const clock = Date.parse(at);
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));

/** The dialogs the runtimes draw, as `pane read --source recent-unwrapped` returns them. */
const hooksDialog = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.63.0)                                    │',
  '╰──────────────────────────────────────────────────────────────╯',
  '',
  '  1 hook is new or changed. Hooks can run outside the sandbox after you trust them.',
  '',
  '› 1. Review hooks',
  '  2. Trust all and continue',
  '  3. Continue without trusting (hooks won\'t run)',
  '',
  '  Press enter to confirm or esc to go back',
].join('\n');
const folderDialog = [
  ' Do you trust the files in this folder?',
  '',
  ' /home/vish/code/project/.graphyard/worktrees/GY-130-1',
  '',
  ' Claude Code may read, write, or execute files contained in this directory. This can pose security risks, so only use files from trusted sources.',
  '',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
].join('\n');
const loginDialog = [' Welcome to Codex', '', ' Sign in with ChatGPT to use Codex as part of your paid plan', ' or connect an API key for usage-based access', '', '> 1. Sign in with ChatGPT', '  2. Provide your own API key'].join('\n');
const paymentDialog = [' You have reached your usage limit.', ' Upgrade to Pro to keep working, or wait for your limit to reset. Crash reports help us improve.', '', '❯ 1. Upgrade to Pro ($200/month)', '  2. No, stop here'].join('\n');
const telemetryDialog = [' Help improve Gemini CLI', ' Allow Google to collect anonymous usage statistics and crash reports?', '', '● 1. Yes, send usage statistics', '  2. No, do not send'].join('\n');
const workingScreen = '❯ Implement GY-130: A runtime that stops on a first-run trust prompt\n\n∙ Reading src/master.ts… (esc to interrupt)\n';

/**
 * A Herdr pane on a virtual clock whose runtime draws `screen` until it is sent the keys it
 * accepts, and then takes its request: Herdr reports it `idle` while the dialog is up — exactly
 * what a started session looks like — and `working` once it is answered.
 */
class ConsentPane {
  calls: string[][] = [];
  keys: string[][] = [];
  now = clock;
  answered = false;
  renamed: string | null = null;
  constructor(private kind: string, private screen: string, private accepts: string[] | null = null) {}
  wait = (ms: number) => { this.now += ms; };
  bounds() { return { clock: () => this.now, wait: this.wait }; }
  run = (_command: string, args: string[]): string => {
    this.calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') return json({ root_pane: { pane_id: 'w1V:pC1', tab_id: 'w1V:tC1' } });
    if (args[0] === 'pane' && args[1] === 'run') { this.kind = expandTypedCommand(args[3]).kind; return ''; }
    if (args[0] === 'pane' && args[1] === 'send-keys') { this.keys.push(args.slice(3)); if (this.accepts && args.slice(3).join(' ') === this.accepts.join(' ')) this.answered = true; return ''; }
    if (args[0] === 'pane' && args[1] === 'read') return this.answered ? workingScreen : this.screen;
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: this.kind, agent_status: this.answered ? 'working' : 'idle', pane_id: args[2] } });
    if (args[0] === 'agent' && args[1] === 'rename') { this.renamed = args[3]; return json({ agent: { agent: this.kind, name: args[3] } }); }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    return json({});
  };
}

function work(overrides: Partial<Work> = {}): Work {
  return { id: 'work-130', key: 'GY-130', title: 'A runtime that stops on a first-run trust prompt holds its worker slot silently', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Consent', proofs: ['unit:consent-prompt-detected'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' },
    stage: 'ready', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}

async function installed() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-consent-')), credentials = await mkdtemp(join(tmpdir(), 'graphyard-consent-credentials-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  const token = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  return { root, token, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}
const workerProfile = (credentialFile: string, kind: WorkerProfile['kind'] = 'claude'): WorkerProfile => ({ name: 'cursor-primary', principal: 'graphyard-cursor-1', agentName: 'eng-consent', mode: 'launch', kind, credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

test('unit:consent-prompt-detected — a launched session stopped on a first-run trust dialog while Herdr reports it idle is reported awaiting consent with the prompt\'s own text, never as a started session', async () => {
  // The detector: every consent kind the item names is recognised, with the dialog's own text;
  // a session at work, a shell, or a session merely quoting the dialog without a menu is not.
  assert.deepEqual([hooksDialog, folderDialog, telemetryDialog, loginDialog, paymentDialog].map(screen => detectConsentPrompt(screen)?.kind), ['hooks', 'folder', 'telemetry', 'credential', 'payment']);
  assert.equal(detectConsentPrompt(hooksDialog)!.text, '1 hook is new or changed. Hooks can run outside the sandbox after you trust them. / › 1. Review hooks / 2. Trust all and continue / 3. Continue without trusting (hooks won\'t run)');
  assert.equal(detectConsentPrompt(workingScreen), null);
  assert.equal(detectConsentPrompt('vish@host ~/code/project ❯ \n'), null);
  assert.equal(detectConsentPrompt('● The dialog read: 1 hook is new or changed. Hooks can run outside the sandbox after you trust them.\n❯ \n'), null, 'the words without a menu are output, not a prompt');
  assert.equal(detectConsentPrompt(null), null);

  const directory = await mkdtemp(join(tmpdir(), 'graphyard-consent-unit-'));
  try {
    // A stub runtime that draws Claude Code's folder-trust dialog and waits: Herdr reports it idle,
    // which alone would count as started. The launch is reported awaiting consent instead, with the
    // prompt's text, and nothing is typed into the dialog.
    const pane = new ConsentPane('claude', folderDialog);
    const held = startAgentSession('eng-consent', 'claude', 'w1V:pC1', ['--permission-mode', 'bypassPermissions'], 'Implement GY-130', pane.run, { directory, ...pane.bounds(), holdConsent: true });
    assert.equal(held.started.state, 'awaiting consent');
    assert.equal(held.awaiting!.kind, 'folder');
    assert.equal(held.awaiting!.prompt, 'Do you trust the files in this folder? / /home/vish/code/project/.graphyard/worktrees/GY-130-1 / Claude Code may read, write, or execute files contained in this directory. This can pose security risks, so only use files from trusted sources. / ❯ 1. Yes, proceed / 2. No, exit');
    assert.match(held.started.detail, /awaiting consent on a folder prompt/);
    assert.deepEqual(pane.keys, [], 'a prompt outside the allow-list is never answered');
    assert.equal(pane.renamed, 'eng-consent', 'the held session is named so a human can find it');

    // Without a hold the same launch is refused as awaiting consent, carrying the prompt's text.
    const refusedPane = new ConsentPane('claude', folderDialog);
    assert.throws(() => awaitRuntimeStart('w1V:pC1', 'claude', 'GY=/s; claude', refusedPane.run, refusedPane.bounds()),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent' && error.screen.startsWith('Do you trust the files in this folder?') && /outside the launcher's consent allow-list: "Do you trust the files in this folder\?/.test(error.message));

    // The worker launch itself: dispatchWork reports the session awaiting consent, not started.
    const { root, token, cleanup } = await installed();
    try {
      const workerPane = new ConsentPane('claude', folderDialog);
      const assigned = join(root, 'assigned');
      const dispatched = await dispatchWork(root, work(), workerProfile(await token('worker')), [], workerPane.run, [work()], async () => ({ epoch: 1, path: assigned, base: 'c'.repeat(40) }), async () => { throw new Error('a held session keeps its claim'); }, 5_000, at, { start: workerPane.bounds() });
      assert.equal(dispatched.started, 'awaiting consent');
      assert.equal(dispatched.consent.awaiting!.prompt, held.awaiting!.prompt);
      assert.equal(dispatched.consent.awaiting!.pane, 'w1V:pC1');
      assert.equal(dispatched.consent.awaiting!.attach, 'herdr pane attach w1V:pC1 --workspace wE');
    } finally { await cleanup(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:known-consent-answered-unknown-escalated — the launcher answers a hooks-trust dialog with "Continue without trusting" and records it on the session, holds a worker on any other prompt with one attention item, and never answers a credential or payment prompt', async () => {
  // The allow-list never grants hook execution, folder trust or a sandbox escape.
  assert.deepEqual(consentAnswers.map(rule => rule.id), ['hooks-continue-untrusted', 'telemetry-decline']);
  assert.deepEqual(detectConsentPrompt(hooksDialog)!.keys, ['3'], 'the default answer to the hooks dialog is option 3, found by its label');
  assert.deepEqual(detectConsentPrompt(telemetryDialog)!.keys, ['2']);
  for (const screen of [loginDialog, paymentDialog, folderDialog]) assert.equal(detectConsentPrompt(screen)!.keys, null, screen.split('\n')[0]);

  const { root, token, cleanup } = await installed();
  try {
    // A producer launch on Codex stopped on the hooks dialog: answered `3`, the session takes its
    // request, and the answer is kept on the session's record.
    const credential = await token('producer');
    await saveProducerProfile(root, { name: 'codex-producer', principal: 'proof-runner', agentName: 'produce-c', kind: 'codex', credentialFile: credential }, async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } }));
    const config = await loadMasterConfig(root);
    const item = work({ stage: 'review', epoch: 1, candidate: { sha: H, baseSha: B, pr: 130, branch: 'graphyard/gy-130-1', author: 'implementer' }, submission: { epoch: 1, pr: 130 },
      criteria: [{ id: 'AC-2', text: 'Consent', proofs: ['integration:known-consent-answered-unknown-escalated'] }],
      observation: { candidate: { sha: H, baseSha: B, pr: 130, branch: 'graphyard/gy-130-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true } as Work['observation'],
      gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }] });
    reconcileAutoDispatch(item, [item], new Date(clock));
    const request = item.autoDispatch!.producers[0];
    const hooks = new ConsentPane('codex', hooksDialog, ['3']);
    const produced = await launchProducer(root, item, request, config.producers[0], [], at, { run: hooks.run, start: hooks.bounds() });
    assert.deepEqual(hooks.keys, [['3']], 'one keystroke, option 3: continue without trusting');
    assert.equal(hooks.calls.some(call => call[1] === 'send-keys' && call.includes('2')), false, 'Trust all and continue is never chosen');
    const record = (await readProducerLedger(root)).producers.find(entry => entry.id === produced.producer)!;
    assert.equal(record.consent!.length, 1);
    assert.deepEqual({ rule: record.consent![0].rule, kind: record.consent![0].kind, answer: record.consent![0].answer, keys: record.consent![0].keys },
      { rule: 'hooks-continue-untrusted', kind: 'hooks', answer: 'Continue without trusting (hooks do not run)', keys: ['3'] });
    assert.match(record.consent![0].prompt, /^1 hook is new or changed/);

    // A credential prompt and a payment prompt are never answered: a producer launch is refused
    // with the prompt's text, and its pane closed; nothing is typed into either.
    // A dialog still drawn after its answer is given time to close before it is answered again,
    // and one that never closes is answered twice at most and then held like any other prompt.
    const stubborn = new ConsentPane('codex', hooksDialog);
    const stuck = awaitRuntimeStart('w1V:pC1', 'codex', 'GY=/s; codex', stubborn.run, { ...stubborn.bounds(), holdConsent: true });
    assert.deepEqual(stubborn.keys, [['3'], ['3']]);
    assert.ok(Date.parse(stuck.consent[1].at) - Date.parse(stuck.consent[0].at) >= 5_000, 'no second keystroke inside the settle period');
    assert.match(stuck.awaiting!.why, /answered it 2 times and it is still showing/);

    await saveProducerLedger(root, { version: 1, producers: [] });
    for (const [screen, kind] of [[loginDialog, 'credential'], [paymentDialog, 'payment']] as const) {
      const pane = new ConsentPane('codex', screen, ['1']);
      const closed: string[] = [];
      const run = (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'close') closed.push(args[2]); return pane.run(command, args); };
      await assert.rejects(launchProducer(root, item, request, config.producers[0], [], at, { run, start: pane.bounds() }), new RegExp(`awaiting consent in pane w1V:pC1 on a ${kind} prompt, and it is outside the launcher's consent allow-list`));
      assert.deepEqual(pane.keys, [], `a ${kind} prompt is never answered`);
      assert.ok(closed.includes('w1V:pC1'), 'a refused reviewer or producer launch does not hold a slot');
    }

    // A worker on a prompt outside the list is held, and raises exactly one attention item naming
    // the item, the pane, the prompt and the attach command — the human's, for a credential.
    const assigned = join(root, 'assigned');
    const login = new ConsentPane('codex', loginDialog, ['1']);
    const dispatched = await dispatchWork(root, work(), workerProfile(await token('worker'), 'codex'), [], login.run, [work()], async () => ({ epoch: 1, path: assigned, base: 'c'.repeat(40) }), async () => { throw new Error('a held session keeps its claim'); }, 5_000, at, { start: login.bounds() });
    assert.equal(dispatched.started, 'awaiting consent'); assert.deepEqual(login.keys, []);
    const holds = readConsentHolds(assigned);
    assert.equal(holds.length, 1);
    const leased = work({ epoch: 1, lease: { epoch: 1, owner: 'graphyard-cursor-1', expiresAt: new Date(Date.now() + 240_000).toISOString() } });
    const items = consentHoldItems([assigned, join(root, 'elsewhere')], { work: [leased], now: new Date().toISOString() });
    assert.equal(items.length, 1);
    assert.equal(items[0].subject, 'GY-130');
    for (const fragment of ['GY-130 epoch 1', 'pane w1V:pC1', 'is awaiting consent', 'Sign in with ChatGPT', 'herdr pane attach w1V:pC1 --workspace wE', 'credential prompt is outside it']) assert.ok(items[0].text.includes(fragment), fragment);
    assert.equal(items[0].role, 'human'); assert.equal(items[0].humanOnly, 'issuing credentials to people');
    assert.equal(items[0].text, dispatched.consent.awaiting!.attention);
    // Once the lease no longer holds that epoch the hold raises nothing.
    assert.deepEqual(consentHoldItems([assigned], { work: [work({ epoch: 1 })], now: new Date().toISOString() }), []);
  } finally { await cleanup(); }
});

test('integration:unconsented-session-releases-its-slot — the watch supervisor stops renewing the lease of a session still awaiting consent past the hold bound, releases the assignment, and the item is dispatchable again', async () => {
  assert.equal(consentHoldMs, 15 * 60_000);
  const checkout = await mkdtemp(join(tmpdir(), 'graphyard-consent-slot-'));
  try {
    await mkdir(join(checkout, '.graphyard/launch'), { recursive: true });
    // The control plane as far as this assignment goes: the lease the supervisor renews, and the
    // blocked/release calls its surrender makes.
    let item = work({ epoch: 1, lease: { epoch: 1, owner: 'graphyard-cursor-1', expiresAt: new Date(clock + 240_000).toISOString() } });
    const posted: { path: string; body: any }[] = [];
    const post = async (_url: string, _token: string, path: string, body: any) => {
      posted.push({ path, body });
      if (path.endsWith('/blocked')) item = { ...item, blocker: body.reason };
      if (path.endsWith('/release')) item = { ...item, lease: null };
    };
    const surrender = assignmentSurrender(1, ['node', launcher, 'watch', 'GY-130', '1', '--', 'codex'], { GRAPHYARD_URL: 'https://graphyard.example', GRAPHYARD_TOKEN: 'worker-token' }, post)!;
    assert.ok(surrender);

    // The launcher's hold, beside the launch files; the pane still shows the dialog.
    const hold = consentHold({ herdrWorkspace: 'wE' }, 'GY-130', 1, 'eng-consent', 'w1V:pC1', { prompt: detectConsentPrompt(loginDialog)!.text, kind: 'credential' }, clock);
    writeConsentHold(join(checkout, '.graphyard/launch/eng-consent'), hold);
    assert.equal(hold.releaseAt, new Date(clock + consentHoldMs).toISOString());
    let now = clock;
    const reads: string[] = [];
    const probe = consentHoldProbe(checkout, { HERDR_PANE_ID: 'w1V:pC1' }, (_command, args) => { reads.push(args[2]); return loginDialog; }, () => now);
    assert.equal(probe(), null, 'inside the bound the hold keeps the slot');

    let renewals = 0, renewedAfterRelease = 0, released = false;
    const renew = async () => {
      renewals++; if (released) renewedAfterRelease++;
      // Past the bound on the third renewal: the next check finds the hold expired.
      if (renewals === 3) now = clock + consentHoldMs;
      return { lease: { epoch: 1, expiresAt: new Date(Date.now() + 240_000).toISOString() }, updatedAt: new Date().toISOString() } as any;
    };
    const code = await supervise(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], 1, renew, {
      intervalMs: 40, graceMs: 50, platform: 'linux', detached: true,
      session: { visible: () => null, surrender: async cause => { released = true; await surrender(cause); }, unconsented: probe },
    });
    assert.equal(code, 1, 'the supervisor stopped the session');
    assert.equal(renewals, 3, 'no renewal after the hold outlived its bound');
    assert.equal(renewedAfterRelease, 0);
    assert.deepEqual(reads.every(pane => pane === 'w1V:pC1'), true, 'the supervisor reads its own pane');
    assert.deepEqual(posted.map(entry => entry.path), ['work/GY-130/blocked', 'work/GY-130/blocked', 'work/GY-130/release']);
    assert.match(posted[0].body.reason, /^Watch supervisor ended attempt 1: its session never took its request: it waited on a credential consent prompt outside the launcher's allow-list .* — "Sign in with ChatGPT/);
    assert.equal(posted[1].body.reason, null, 'the cause is recorded, then withdrawn, so no standing blocker holds the freed item');

    // The lease has ended and the item is dispatchable again, for this profile or another.
    assert.equal(item.lease, null); assert.equal(item.blocker, null);
    assert.doesNotThrow(() => assertDispatchable(item, [item], new Date(clock + consentHoldMs + 60_000).toISOString()));
    const heldItem = work({ epoch: 1, lease: { epoch: 1, owner: 'graphyard-cursor-1', expiresAt: new Date(clock + 240_000).toISOString() } });
    assert.throws(() => assertDispatchable(heldItem, [heldItem], new Date(clock).toISOString()), /active owner graphyard-cursor-1/, 'while held, the slot was the held session\'s');

    // A prompt a human answered clears the hold: the session has its request and keeps its slot.
    const answered = consentHoldProbe(checkout, { HERDR_PANE_ID: 'w1V:pC1' }, () => workingScreen, () => clock + 2 * consentHoldMs);
    assert.equal(answered(), null);
    assert.equal(existsSync(join(checkout, '.graphyard/launch/eng-consent.consent')), false, 'the hold is cleared once the prompt is off the screen');
    assert.equal(consentHoldProbe(checkout, {}, () => loginDialog, () => clock + 2 * consentHoldMs)(), null, 'no hold, nothing to release');
  } finally { await rm(checkout, { recursive: true, force: true }); }
});

test('manual:consent-prompt-docs-review — docs/master-agent.md states that a runtime may stop on a first-run consent prompt, which prompts the launcher answers and with what option, which it escalates, and how a held slot is released', async () => {
  const guide = await readFile(join(repositoryRoot, 'docs/master-agent.md'), 'utf8');
  for (const fragment of ['#### First-run consent prompts', 'awaiting consent', 'hooks-continue-untrusted', 'Continue without trusting', 'telemetry-decline', 'never one that grants hook execution or a sandbox escape',
    'credential', 'payment', 'herdr pane attach', '**15 minutes**', '.graphyard/launch/NAME.consent', 'stops renewing', 'dispatchable']) {
    assert.ok(guide.includes(fragment), `docs/master-agent.md states ${fragment}`);
  }
});
