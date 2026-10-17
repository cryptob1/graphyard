import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig, type MasterRun } from '../src/master.js';
import type { HerdrAgent } from '../src/master/herdr.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { detectConsentPrompt, detectNoticeDialog } from '../src/consent-prompt.js';
import { deliverPrompt, PromptNotAcceptedError } from '../src/master.js';
import { masterSessionStep, masterWakeHeldKey } from '../src/daemon/cycle-master.js';
import { emptyMasterSession } from '../src/daemon/state.js';

// GY-1872: the canonical master session sat idle on Claude Code's autocompact suggestion — "We
// recommend compacting earlier … esc not now" — and the loop's event wake typed into the dialog
// instead of the prompt, so the master stopped acting until a human pressed esc by hand. The wake
// now reads the pane first, answers a settings-suggestion dialog with the not-now key its own
// footer offers, reads again to confirm it closed, and only then delivers the wake; a dialog it
// cannot answer holds the wake and is recorded — a credential or payment, Claude Code's Settings
// Warning, or a menu no rule answers (GY-1872 rework: the classifier names no prompt for those, so
// the hold is read off the pane, on the first read and on the re-read after esc alike). Proofs and
// their company: unit:settings-suggestion-dialog-dismissed, unit:master-wake-answers-dialog-first,
// unit:master-wake-holds-unanswerable-dialog, unit:master-wake-holds-dialog-still-showing,
// unit:master-wake-holds-settings-warning, unit:master-wake-holds-unclassified-menu,
// unit:master-wake-holds-dialog-after-esc, unit:master-wake-hold-outlives-failed-send,
// unit:settings-dialog-delivered-as-notice (the merge with GY-1863: a prompt delivery puts the
// same dialog away with its own key instead of refusing it as a consent dialog).

// Fixed clock for every step run; the loop's own stamps derive from it, and this file reads the
// wall clock never.
const clock = Date.parse('2030-01-01T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;

/** The dialog observed on the master session's pane (herdr pane read, recent-unwrapped). */
const compactDialog = [
  '⚠ Context low',
  '',
  'We recommend compacting earlier to keep sessions fast. Auto-compact triggers at 20% remaining, but your sessions run long, and a compact under load loses detail.',
  '',
  'Want to autocompact at 400k tokens instead?',
  '',
  '❯ Autocompact at 400k tokens',
  '  Keep auto (1m tokens)',
  '',
  '↑/↓ choose · ←/→ change size · enter confirm · esc not now',
].join('\n');
/** The same words a session merely quotes, above its ordinary prompt: a footer, not a menu. */
const quotedDialog = [
  'The item description reads: "We recommend compacting earlier … Want to autocompact at 400k tokens instead? … ↑/↓ choose · ←/→ change size · enter confirm · esc not now"',
  '',
  '❯ type your request here',
].join('\n');
/** A dialog whose footer offers the same esc, but which asks for a credential. */
const credentialDialog = [
  'Sign in to use Claude Code',
  '',
  'Paste your API key, or sign in with your Claude account',
  '',
  '❯ Sign in with Claude account',
  '  API key (paste below)',
  '',
  '↑/↓ choose · enter confirm · esc to dismiss',
].join('\n');
/** A dialog whose footer offers the same esc, but which asks for a payment. */
const paymentDialog = [
  'You are out of included usage.',
  '',
  'Upgrade to Max to keep working this session?',
  '',
  '❯ Upgrade to Max ($200/month)',
  '  Stay on the free tier',
  '',
  '↑/↓ choose · enter confirm · esc to dismiss',
].join('\n');
/** The pane once the dialog is answered: the session's own prompt, no menu. */
const cleanScreen = '❯ the session is awake and reading its instruction\n';
/** Claude Code's "Settings Warning" dialog, as `herdr pane read` returned it for GY-159: a numbered menu the classifier names no prompt for. */
const settingsWarningScreen = [
  '  Settings Warning',
  '',
  '  /home/vish/code/graphyard/.graphyard/worktrees/GY-159-4/.claude/settings.local.json',
  '  ├ permissions.deny: Invalid permission rule "Bash(git push * :**)" was skipped: The :* pattern must be at the end. Move :* to the end for prefix matching, or use * for wildcard matching',
  '',
  '  ❯ 1. Continue',
  '    2. Fix with Claude',
  '    3. Exit and fix manually',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');
/** A numbered dialog that names no kind the allow-list knows — a context picker — which the pane still ends on. */
const contextDialog = [
  'Context left until auto-compact: 11%',
  '',
  'What would you like to do?',
  '❯ 1. Continue the conversation',
  '  2. Compact the conversation now',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

/** A master pane on the fixed clock: records every read, key send and prompt the loop makes. */
class MasterPane {
  log: string[] = [];
  prompts: string[] = [];
  keys: string[][] = [];
  reads = 0;
  constructor(public screen: string, private sticky = false, private afterEsc?: string) {}
  read = () => { this.reads += 1; this.log.push('read'); return this.screen; };
  answer = (sent: string[]) => { this.keys.push(sent); this.log.push(`keys:${sent.join(' ')}`); if (this.afterEsc) this.screen = this.afterEsc; else if (!this.sticky) this.screen = cleanScreen; };
  prompt = (text: string) => { this.prompts.push(text); this.log.push('prompt'); };
}

function config(overrides: Partial<Omit<MasterConfig, 'run'>> & { run?: Partial<MasterRun> } = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: 'coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { masterHeartbeatMinutes: 5 }, ...overrides });
}
const agent: HerdrAgent = { name: 'graphyard-master-project', pane_id: 'w1V:pQ8A', agent: 'claude', agent_status: 'idle' };

/** A one-step loop over `pane`: a live adopted master session, quiet long enough for its heartbeat. */
function stepOver(pane: MasterPane) {
  const cfg = config(), state = emptyDaemonState(cfg);
  Object.assign(state.master, { agentName: agent.name!, pane: agent.pane_id!, runtime: agent.agent, startedAt: iso(-10 * minute), adopted: true, misses: 0 });
  const effects = {
    herdr: () => ({ agents: [agent], available: true }),
    masterSession: { launch: async () => { throw new Error('the session is live; nothing launches in this test'); } },
    persist: async () => {},
    sessionOutput: () => pane.read(),
    answerSession: (_agent: HerdrAgent, keys: string[]) => pane.answer(keys),
    promptSession: (_agent: HerdrAgent, text: string) => pane.prompt(text),
  } as unknown as DaemonEffects;
  const step = (at: number) => masterSessionStep({ config: cfg, state, effects, now: () => at, clock: at, snapshot: { work: [], now: iso(0), jobs: [] },
    performed: [], agents: [], launcher: { busy: () => false, keys: () => [] },
    isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Parameters<typeof masterSessionStep>[0]);
  return { state, step };
}

test('unit:settings-suggestion-dialog-dismissed — the autocompact suggestion is recognised as a settings dialog answered with esc and "Not now (settings unchanged)"; the words quoted above an ordinary prompt, and a dialog asking for a credential or payment, are not answered', () => {
  const prompt = detectConsentPrompt(compactDialog);
  assert.ok(prompt?.rule, 'the dialog is on the launcher\'s answer list');
  assert.equal(prompt.kind, 'settings');
  assert.deepEqual(prompt.keys, ['esc'], 'answered with the one key the footer offers, never an option of the menu');
  assert.equal(prompt.rule.answer, 'Not now (settings unchanged)');
  assert.match(prompt.text, /We recommend compacting earlier/);
  assert.equal(detectConsentPrompt(quotedDialog), null, 'the words quoted above an ordinary prompt end on the prompt, not on a menu');
  const credential = detectConsentPrompt(credentialDialog);
  assert.equal(credential?.kind, 'credential', 'a dialog asking for a credential is classified, never answered');
  assert.equal(credential?.keys, null);
  const payment = detectConsentPrompt(paymentDialog);
  assert.equal(payment?.kind, 'payment', 'a dialog asking for a payment is classified, never answered');
  assert.equal(payment?.keys, null);
});

test('unit:master-wake-answers-dialog-first — with the master pane showing the autocompact suggestion, the wake sends esc, re-reads the pane, and only then sends the wake text', async () => {
  const pane = new MasterPane(compactDialog);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.log, ['read', 'read', 'keys:esc', 'read', 'prompt'],
    'the pane is read, esc is sent, the pane is read again, and only then the wake is delivered');
  assert.deepEqual(pane.keys, [['esc']]);
  assert.equal(pane.prompts.length, 1);
  assert.match(pane.prompts[0]!, /heartbeat/);
  assert.ok(state.master.lastWake, 'the wake is recorded as delivered');
  assert.equal(state.master.lastWake!.heartbeat, true);
  const wake = state.actions['wake:master:0'];
  assert.equal(wake?.state, 'done');
  assert.match(wake?.detail ?? '', /answered its settings-suggestion dialog "⚠ Context low \/ We recommend compacting earlier[^\u0000]*with "Not now \(settings unchanged\)" first/);
});

test('unit:master-wake-holds-unanswerable-dialog — a credential dialog holds the wake: no keys are sent, the wake text is never typed, and the held wake is recorded naming the dialog', async () => {
  const pane = new MasterPane(credentialDialog);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.keys, [], 'the loop never answers a credential dialog');
  assert.deepEqual(pane.prompts, [], 'the wake text is never typed into the dialog');
  assert.equal(pane.reads, 2, 'the pane is read for the supervision check and the wake, and not read again');
  const held = state.actions[masterWakeHeldKey];
  assert.equal(held?.state, 'waiting', 'the wake is held, not spent');
  assert.match(held?.detail ?? '', /credential dialog/);
  assert.match(held?.detail ?? '', /Sign in to use Claude Code/);
  assert.equal(state.master.lastWake, null, 'the held wake is made again next cycle');
  // The next cycle holds again while the dialog stands, without repeating the record.
  await step(clock + minute);
  assert.deepEqual(pane.prompts, []);
  assert.equal(state.actions[masterWakeHeldKey]?.attempts, 1, 'the standing hold is refreshed only when the dialog it names changes');
});

test('unit:master-wake-holds-dialog-still-showing — a settings dialog that stays after its esc holds the wake and reports it, and the next wake goes through once the pane is clear', async () => {
  const pane = new MasterPane(compactDialog, true);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.keys, [['esc']], 'the not-now key is sent');
  assert.deepEqual(pane.prompts, [], 'the wake text is not delivered into a dialog that is still showing');
  assert.equal(state.master.lastWake, null);
  const held = state.actions[masterWakeHeldKey];
  assert.equal(held?.state, 'waiting');
  assert.match(held?.detail ?? '', /still shows a dialog/);
  assert.match(held?.detail ?? '', /Not now \(settings unchanged\)/);
  // The dialog clears (a human answered it, or the runtime moved on): the next wake delivers, and retires the hold.
  pane.screen = cleanScreen;
  await step(clock + minute);
  assert.equal(pane.prompts.length, 1, 'the wake is made once no dialog shows');
  assert.match(pane.prompts[0]!, /heartbeat/);
  assert.ok(state.master.lastWake);
  assert.equal(state.actions[masterWakeHeldKey]?.state, 'done', 'the standing hold is retired with the wake that ends it');
});

test('unit:master-wake-clear-pane — a master pane showing no dialog is woken as before, with no keys sent', async () => {
  const pane = new MasterPane(cleanScreen);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.log, ['read', 'read', 'prompt'], 'the pane is read for the supervision check and the wake, and woken straight away');
  assert.deepEqual(pane.keys, []);
  assert.equal(pane.prompts.length, 1);
  assert.equal(state.actions[masterWakeHeldKey], undefined, 'no hold is recorded where no dialog stood');
});

test('unit:master-wake-holds-settings-warning — Claude Code\'s Settings Warning holds the wake: no key is typed into it, and the hold names the rules it skipped', async () => {
  assert.equal(detectConsentPrompt(settingsWarningScreen), null, 'the classifier names no prompt for a settings warning — the hold is read off the pane');
  const pane = new MasterPane(settingsWarningScreen);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.keys, [], 'no key is typed into the warning, "Continue" least of all');
  assert.deepEqual(pane.prompts, [], 'the wake text is never typed into the dialog');
  assert.equal(pane.reads, 2, 'the pane is read for the supervision check and the wake, and not read again');
  const held = state.actions[masterWakeHeldKey];
  assert.equal(held?.state, 'waiting', 'the wake is held, not spent');
  assert.match(held?.detail ?? '', /Held the master wake/);
  assert.match(held?.detail ?? '', /settings warning/);
  assert.match(held?.detail ?? '', /skipped 1 invalid permission rule \(Bash\(git push \* :\*\*\)\)/);
  assert.equal(state.master.lastWake, null, 'the held wake is made again next cycle');
});

test('unit:master-wake-holds-unclassified-menu — a numbered dialog naming no kind the allow-list knows holds the wake too, named by its text', async () => {
  assert.equal(detectConsentPrompt(contextDialog), null, 'the classifier names no prompt for it');
  const pane = new MasterPane(contextDialog);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.keys, []);
  assert.deepEqual(pane.prompts, [], 'the wake text is never typed into the dialog');
  const held = state.actions[masterWakeHeldKey];
  assert.equal(held?.state, 'waiting');
  assert.match(held?.detail ?? '', /no rule answers/);
  assert.match(held?.detail ?? '', /What would you like to do\?/);
  assert.equal(state.master.lastWake, null);
});

test('unit:master-wake-holds-dialog-after-esc — a settings dialog answered with esc that is followed by a dialog no rule answers holds the wake: the re-read runs the same test as the first read', async () => {
  const pane = new MasterPane(compactDialog, false, settingsWarningScreen);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.deepEqual(pane.keys, [['esc']], 'the not-now key is sent for the settings dialog');
  assert.deepEqual(pane.prompts, [], 'the wake is not delivered into the dialog that follows');
  assert.equal(state.master.lastWake, null);
  const held = state.actions[masterWakeHeldKey];
  assert.equal(held?.state, 'waiting');
  assert.match(held?.detail ?? '', /Not now \(settings unchanged\)/);
  assert.match(held?.detail ?? '', /then showed/);
  assert.match(held?.detail ?? '', /settings warning/);
});

test('unit:master-wake-hold-outlives-failed-send — a hold is retired only by the wake that went through: a send that fails after the dialog cleared leaves it standing, and the next delivered wake retires it', async () => {
  const pane = new MasterPane(credentialDialog);
  const { state, step } = stepOver(pane);
  await step(clock);
  assert.equal(state.actions[masterWakeHeldKey]?.state, 'waiting');
  // The dialog clears, but the delivery itself fails: the hold is not recorded as a wake that went.
  pane.screen = cleanScreen;
  const sending = pane.prompt;
  pane.prompt = () => { throw new Error('herdr: the pane vanished mid-delivery'); };
  await assert.rejects(step(clock + minute), /vanished mid-delivery/);
  assert.equal(state.master.lastWake, null, 'nothing was delivered');
  assert.equal(state.actions[masterWakeHeldKey]?.state, 'waiting', 'the hold stands until a wake goes through');
  pane.prompt = sending;
  await step(clock + 2 * minute);
  assert.equal(pane.prompts.length, 1);
  assert.ok(state.master.lastWake);
  assert.equal(state.actions[masterWakeHeldKey]?.state, 'done', 'the delivered wake retires the hold');
});

/** A settings-suggestion dialog the notice catalogue names no kind for: the same footer, another preference. */
const themeDialog = ['Try the new high-contrast theme?', '', '❯ Switch to high contrast', '  Keep the current theme', '', '↑/↓ choose · enter confirm · esc not now'].join('\n');
const herdrOk = JSON.stringify({ result: {} });
test('unit:settings-dialog-delivered-as-notice — a prompt delivery onto the autocompact suggestion puts it away with esc and delivers, as GY-1863 does, now that the dialog is also a settings consent prompt; a credential dialog is still refused', async () => {
  const notice = detectNoticeDialog(compactDialog);
  assert.equal(notice?.kind, 'autocompact', 'the catalogue still names the dialog the consent classifier now answers');
  assert.deepEqual(notice?.keys, ['esc']);
  assert.equal(detectNoticeDialog(themeDialog)?.kind, 'settings', 'a settings-suggestion footer the catalogue does not name is a notice put away with its own key');
  assert.equal(detectNoticeDialog(credentialDialog), null, 'a credential dialog is never a notice');
  // The session's own transcript above the dialog is not read for a credential: GY-1863's fixture, a bullet naming a login above the notice.
  assert.equal(detectConsentPrompt(['● Implemented login handling for the settings page', '  Tests pass.', ...compactDialog.split('\n')].join('\n'))?.kind, 'settings');
  assert.equal(detectConsentPrompt(['● Done.', ...credentialDialog.split('\n')].join('\n'))?.kind, 'credential', 'the dialog\'s own words still name a credential');
  const log: string[][] = [];
  let reads = 0;
  const run = (_command: string, args: string[]) => {
    log.push(args);
    const sub = `${args[0]} ${args[1]}`;
    if (sub === 'agent read') return reads++ === 0 ? compactDialog : cleanScreen;
    return herdrOk;
  };
  const delivered = await deliverPrompt('w1V:pQ8A', 'the wake text', run, { acceptMs: 1_000, pauseMs: 0 });
  assert.equal(delivered.accepted, true);
  assert.deepEqual(delivered.dismissed, ['autocompact']);
  assert.deepEqual(log.map(args => `${args[0]} ${args[1]}`), ['agent read', 'agent send-keys', 'agent prompt'], 'the pane is read, esc is sent, and only then the text is submitted');
  assert.deepEqual(log[1]!.slice(2), ['w1V:pQ8A', 'esc']);
  const refused: string[][] = [];
  await assert.rejects(deliverPrompt('w1V:pQ8A', 'the wake text', (_command: string, args: string[]) => { refused.push(args); return `${args[0]} ${args[1]}` === 'agent read' ? credentialDialog : herdrOk; }, { acceptMs: 1_000, pauseMs: 0 }),
    (error: unknown) => error instanceof PromptNotAcceptedError && /credential consent dialog/.test(error.message));
  assert.ok(!refused.some(args => `${args[0]} ${args[1]}` === 'agent send-keys'), 'no keystroke reaches a credential dialog');
  assert.ok(!refused.some(args => `${args[0]} ${args[1]}` === 'agent prompt'), 'nothing is submitted into it');
});
