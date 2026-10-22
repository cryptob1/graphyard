import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectConsentPrompt, detectNoticeDialog } from '../src/consent-prompt.js';
import { deliverPrompt, PromptNotAcceptedError } from '../src/master.js';

// GY-1872: the master session sat idle on Claude Code's autocompact suggestion until a human
// pressed esc. The classifier recognises that settings-suggestion dialog and answers it with the
// not-now key its own footer offers, while a credential or payment dialog is never answered; a
// prompt delivery puts the same dialog away with that key before it submits (GY-1863).

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
/**
 * The production autocompact screen, as GY-1863 read it off the master session's pane
 * (tests/fault-class-session-liveness.test.ts): at that pane's width the footer wraps, so the
 * screen ends on "… esc not" and then "now", and the menu's options are unnumbered.
 */
const wrappedCompactDialog = [
  '✻ Brewed for 1m 25s · done 7:33 PM',
  ' We recommend compacting earlier',
  '   Each message re-sends the whole conversation, so long',
  '   conversations use up your plan\'s usage limits faster.',
  '   With your current settings, Claude Code autocompacts',
  '   (replaces older messages with a summary) at 1m tokens',
  '   (default via auto setting). Compacting earlier can',
  '   reduce usage, but it happens more often, and some',
  '   details can be lost each time.',
  '   Want to autocompact at 400k tokens instead? Your model',
  '   doesn\'t change. Switch back any time with',
  '   /autocompact.',
  '     Autocompact at ‹ 400k › tokens',
  '     Keep auto (1m tokens)',
  '   ↑/↓ choose · ←/→ change size · enter confirm · esc not',
  '   now',
].join('\n');
/** The footer quoted whole on one line, above a last line that merely continues the session's output: no wrapped footer. */
const quotedFooterAboveOutput = ['The dialog read "↑/↓ choose · enter confirm · esc not now" and the loop', 'now'].join('\n');
/** The wrapped production footer under a dialog that asks for a credential. */
const wrappedCredentialDialog = ['Sign in to use Claude Code', 'Paste your API key, or sign in with your Claude account', '  Sign in with Claude account', '  API key (paste below)', '   ↑/↓ choose · enter confirm · esc not', '   now'].join('\n');
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

test('unit:settings-suggestion-dialog-wrapped-footer — the production autocompact screen, its footer wrapped onto "esc not" / "now", is the same settings dialog answered with esc; a footer quoted whole above a last line, and a wrapped footer under a credential question, are not answered', () => {
  const prompt = detectConsentPrompt(wrappedCompactDialog);
  assert.equal(prompt?.kind, 'settings');
  assert.deepEqual(prompt?.keys, ['esc'], 'the not-now key read off the joined footer');
  assert.equal(prompt?.rule?.answer, 'Not now (settings unchanged)');
  assert.match(prompt?.text ?? '', /Want to autocompact at 400k tokens instead\?[^\u0000]*esc not now$/);
  assert.equal(detectConsentPrompt(quotedFooterAboveOutput), null, 'a footer already whole above the last line is a quotation, not a wrapped footer');
  assert.equal(detectConsentPrompt(`${wrappedCompactDialog}\n❯ `), null, 'the dialog\'s words above an ordinary prompt are not answered');
  const credential = detectConsentPrompt(wrappedCredentialDialog);
  assert.equal(credential?.kind, 'credential');
  assert.equal(credential?.keys, null, 'a credential question is never answered, wrapped footer or not');
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
