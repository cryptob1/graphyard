import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { awaitRuntimeStart, loadMasterConfig, saveProducerProfile, SessionStartError, setupMaster, startAgentSession } from '../src/master.js';
import { consentAnswers, detectConsentPrompt } from '../src/consent-prompt.js';
import { launchProducer, readProducerLedger, saveProducerLedger } from '../src/producer.js';
import { expandTypedCommand } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { hostname } from 'node:os';
import { workFixture } from './helpers/work-fixture.js';

/** GY-3030: the registry grants every launch; each launch takes a fresh one, as each session's reservation stands until it ends. */
const registry = (role: 'worker' | 'producer') => registryFixture(hostname(), ['codex'], [role]).probe;
// Time-bomb allowance (GY-1694): the 2026-09-23 `at`/clock stamps fixture items' createdAt/updatedAt; Date.now()/new Date() build live lease expiries only.

// GY-130: a runtime that stops on a first-run consent prompt is not a started session. The
// launcher reads the prompt off the pane, answers only the prompts on its allow-list with their
// least-privilege option, and refuses the launch on any other prompt (workers run headless since
// GY-3259, so no pane is ever held). One case per proof: unit:consent-prompt-detected,
// integration:known-consent-answered-unknown-escalated, manual:consent-prompt-docs-review.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
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
    if (args[0] === 'pane' && args[1] === 'read') return this.answered ? `${this.kind === 'gemini' ? 'Gemini\n' : ''}${workingScreen}` : this.screen;
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: this.kind, agent_status: this.answered ? 'working' : 'idle', pane_id: args[2] } });
    if (args[0] === 'agent' && args[1] === 'rename') { this.renamed = args[3]; return json({ agent: { agent: this.kind, name: args[3] } }); }
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    return json({});
  };
}

function work(overrides: Partial<Work> = {}): Work {
  return workFixture({ id: 'work-130', key: 'GY-130', title: 'A runtime that stops on a first-run trust prompt holds its worker slot silently', type: 'bug', priority: 0,
    criteria: [{ id: 'AC-1', text: 'Consent', proofs: ['unit:consent-prompt-detected'] }], revision: 3, createdAt: at, updatedAt: at, stageEnteredAt: at, ...overrides });
}

async function installed() {
  const root = await temporaryDirectory('consent'), credentials = await temporaryDirectory('consent-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus as typeof fetch);
  const token = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  return { root, token, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

test('unit:consent-prompt-detected — a launched session stopped on a first-run trust dialog while Herdr reports it idle is reported awaiting consent with the prompt\'s own text, never as a started session', async () => {
  // The detector: every consent kind the item names is recognised, with the dialog's own text;
  // a session at work, a shell, or a session merely quoting the dialog without a menu is not.
  assert.deepEqual([hooksDialog, folderDialog, telemetryDialog, loginDialog, paymentDialog].map(screen => detectConsentPrompt(screen)?.kind), ['hooks', 'folder', 'telemetry', 'credential', 'payment']);
  assert.equal(detectConsentPrompt(hooksDialog)!.text, '1 hook is new or changed. Hooks can run outside the sandbox after you trust them. / › 1. Review hooks / 2. Trust all and continue / 3. Continue without trusting (hooks won\'t run)');
  assert.equal(detectConsentPrompt(workingScreen), null);
  assert.equal(detectConsentPrompt('vish@host ~/code/project ❯ \n'), null);
  assert.equal(detectConsentPrompt('● The dialog read: 1 hook is new or changed. Hooks can run outside the sandbox after you trust them.\n❯ \n'), null, 'the words without a menu are output, not a prompt');
  assert.equal(detectConsentPrompt(null), null);
  // The question and its menu must be one dialog, the last thing on screen: consent words in
  // ordinary output above an unrelated numbered list, or a dialog long scrolled away, are not one.
  assert.equal(detectConsentPrompt(['● Sign in support is complete.', '', '● Next I will:', 'a', 'b', 'c', 'd', 'e', 'f', '1. Update the docs', '2. Run the tests'].join('\n')), null, 'a question far above an unrelated list');
  assert.equal(detectConsentPrompt([' Sign in support is complete.', '1. Update the docs', '2. Run the tests', '', '∙ Reading src/master.ts… (esc to interrupt)', 'x', 'y', '❯ '].join('\n')), null, 'a menu scrolled up under later output');
  assert.equal(detectConsentPrompt(`${hooksDialog}\n● Continued without trusting.\n● Reading src/master.ts\n∙ Working… (esc to interrupt)\n`), null, 'an answered dialog with the session at work below it');

  const directory = await temporaryDirectory('consent-unit');
  try {
    // A stub runtime that draws a sign-in dialog and waits: Herdr reports it idle, which alone would
    // count as started. The launch is refused as awaiting consent instead, with the prompt's text, and
    // nothing is typed into the dialog: a sign-in is a credential only a human gives.
    const pane = new ConsentPane('codex', loginDialog);
    await assert.rejects(startAgentSession('eng-consent', 'codex', 'w1V:pC1', ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'], 'Implement GY-130', pane.run, { directory, ...pane.bounds() }),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent' && error.message.includes('on a credential prompt') && error.message.includes('Sign in with ChatGPT to use Codex as part of your paid plan / or connect an API key for usage-based access / > 1. Sign in with ChatGPT / 2. Provide your own API key'));
    assert.deepEqual(pane.keys, [], 'a prompt outside the allow-list is never answered');

    // A pane read that fails rules nothing out: an idle runtime whose screen could not be read is
    // still starting and read again, so the dialog behind it is found, never taken as started. The
    // folder dialog stays detected: it is the safety net for a trust record the runtime ignored, and
    // fails the launch naming it even for a worker that would be held on any other prompt (GY-1152).
    const flaky = new ConsentPane('claude', folderDialog);
    let unread = 3;
    const flakyRun = (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'read' && unread-- > 0) throw new Error('herdr: pane read failed'); return flaky.run(command, args); };
    await assert.rejects(awaitRuntimeStart('w1V:pC1', 'claude', 'GY=/s; claude', flakyRun, flaky.bounds()),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent' && /stopped at a workspace-trust prompt/.test(error.message));
    assert.equal(unread, -1, 'the dialog was found once a read succeeded');
    const blind = new ConsentPane('claude', folderDialog);
    const blindRun = (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'read') throw new Error('herdr: pane read failed'); return blind.run(command, args); };
    await assert.rejects(awaitRuntimeStart('w1V:pC1', 'claude', 'GY=/s; claude', blindRun, blind.bounds()),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'still starting' && /Herdr reports the claude runtime idle but its pane could not be read, so a consent prompt is not ruled out/.test(error.message));

    // Without a hold the same launch is refused as awaiting consent, carrying the prompt's text.
    const refusedPane = new ConsentPane('claude', folderDialog);
    await assert.rejects(awaitRuntimeStart('w1V:pC1', 'claude', 'GY=/s; claude', refusedPane.run, refusedPane.bounds()),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent' && error.screen.startsWith('Do you trust the files in this folder?') && /workspace-trust prompt in pane w1V:pC1 although its launch records the folder trusted, so the launch failed rather than holding the lease for a human: "Do you trust the files in this folder\?/.test(error.message));

  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:known-consent-answered-unknown-escalated — the launcher answers a hooks-trust dialog with "Continue without trusting" and records it on the session, and never answers a credential or payment prompt', async () => {
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
    // Dispatch opens no producer request any more (GY-1235); the launcher still binds one, built by hand.
    item.autoDispatch!.producers.push({ id: 'producer-integration', kind: 'producer', group: 'integration', proofs: ['integration:known-consent-answered-unknown-escalated'], sha: H, baseSha: B, policyRevision: item.policyRevision, pr: 130, requestedAt: at, reason: 'unproven', state: 'requested' });
    const request = item.autoDispatch!.producers[0];
    const hooks = new ConsentPane('codex', hooksDialog, ['3']);
    const produced = await launchProducer(root, item, request, config.producers[0], [], at, { run: hooks.run, start: hooks.bounds(), probe: registry('producer') });
    assert.deepEqual(hooks.keys, [['3']], 'one keystroke, option 3: continue without trusting');
    assert.equal(hooks.calls.some(call => call[1] === 'send-keys' && call.includes('2')), false, 'Trust all and continue is never chosen');
    const record = (await readProducerLedger(root)).producers.find(entry => entry.id === produced.producer)!;
    assert.equal(record.consent!.length, 1);
    assert.deepEqual({ rule: record.consent![0].rule, kind: record.consent![0].kind, answer: record.consent![0].answer, keys: record.consent![0].keys },
      { rule: 'hooks-continue-untrusted', kind: 'hooks', answer: 'Continue without trusting (hooks do not run)', keys: ['3'] });
    assert.match(record.consent![0].prompt, /^1 hook is new or changed/);

    // A credential prompt and a payment prompt are never answered: a producer launch is refused
    // with the prompt's text, and its pane closed; nothing is typed into either.
    // A dialog still drawn after its answer is answered twice at most and then refused like any other prompt.
    const stubborn = new ConsentPane('codex', hooksDialog);
    await assert.rejects(awaitRuntimeStart('w1V:pC1', 'codex', 'GY=/s; codex', stubborn.run, stubborn.bounds()), /answered it 2 times and it is still showing/);
    assert.deepEqual(stubborn.keys, [['3'], ['3']]);
    // Attempts are counted per dialog: a second dialog the same rule matches, drawn after the first
    // took both its answers, still gets its own least-privilege answer.
    const crashDialog = [' Send crash reports?', ' Allow the CLI to send crash reports when it fails?', '', '● 1. Yes, send crash reports', '  2. No, do not send'].join('\n');
    const second = new ConsentPane('gemini', telemetryDialog);
    const secondRun = (command: string, args: string[]) => {
      const result = second.run(command, args);
      // The first dialog ignores both its answers, then gives way to the crash-report question.
      if (args[0] === 'pane' && args[1] === 'send-keys' && second.keys.length === 2) Object.assign(second as unknown as { screen: string; accepts: string[] }, { screen: crashDialog, accepts: ['2'] });
      return result;
    };
    const both = await awaitRuntimeStart('w1V:pC1', 'gemini', 'GY=/s; gemini', secondRun, second.bounds());
    assert.equal(both.state, 'ready');
    assert.deepEqual(both.consent.map(answer => answer.rule), ['telemetry-decline', 'telemetry-decline', 'telemetry-decline']);
    assert.equal(both.consent[0].prompt, both.consent[1].prompt); assert.match(both.consent[2].prompt, /crash reports when it fails/);
    assert.deepEqual(second.keys, [['2'], ['2'], ['2']]);

    await saveProducerLedger(root, { ...await readProducerLedger(root), producers: [] });
    for (const [screen, kind] of [[loginDialog, 'credential'], [paymentDialog, 'payment']] as const) {
      const pane = new ConsentPane('codex', screen, ['1']);
      const closed: string[] = [];
      const run = (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'close') closed.push(args[2]); return pane.run(command, args); };
      await assert.rejects(launchProducer(root, item, request, config.producers[0], [], at, { run, start: pane.bounds(), probe: registry('producer') }), new RegExp(`awaiting consent in pane w1V:pC1 on a ${kind} prompt, and it is outside the launcher's consent allow-list`));
      assert.deepEqual(pane.keys, [], `a ${kind} prompt is never answered`);
      assert.ok(closed.includes('w1V:pC1'), 'a refused reviewer or producer launch does not hold a slot');
    }

  } finally { await cleanup(); }
});


