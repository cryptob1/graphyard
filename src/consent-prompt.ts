import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * A runtime that stops on a first-run consent prompt (GY-130).
 *
 * A runtime's first launch in a fresh worktree can stop on a dialog before it reads its request:
 * Codex asks whether to trust hooks that are new or changed, Claude Code whether to trust the
 * folder, others whether to send telemetry. Herdr reports such a pane `idle`, which is also what a
 * started session looks like, so the launcher reads the pane's screen for the dialog itself rather
 * than taking the state on trust. A screen is a consent prompt only when it ends on one dialog that
 * asks one of these questions directly above a numbered choice — a session merely printing the
 * words (this item's own description quotes the dialog), or printing them above some unrelated
 * list, is not a menu waiting for a keystroke.
 *
 * The launcher answers a prompt only when a rule below names it, and only with the option the rule
 * picks off the screen by its label, never by a guessed number: the least-privilege answer, which
 * grants nothing — never one that trusts hooks, trusts a folder's settings, or leaves the sandbox.
 * A prompt that asks for a credential, a login or a payment is never answered, whatever else it
 * says. Every other prompt holds the session for a human, who has `consentHoldMs` to answer it
 * before the watch supervisor releases the slot.
 */
export type ConsentKind = 'hooks' | 'trust' | 'folder' | 'telemetry' | 'credential' | 'payment';
export interface ConsentRule {
  id: string;
  kind: ConsentKind;
  /** What the prompt asks, on the screen. */
  asks: RegExp;
  /** The least-privilege option, found on the screen by its label; its first group is the option's number. */
  choose: RegExp;
  /** The option chosen, as the documentation and the session's record name it. */
  answer: string;
}
export interface ConsentPrompt { kind: ConsentKind; text: string; rule: ConsentRule | null; keys: string[] | null }
export interface ConsentAnswer { rule: string; kind: ConsentKind; prompt: string; answer: string; keys: string[]; at: string }

/** The prompts the launcher answers by itself, and how. Nothing here grants hook execution or a sandbox escape. */
export const consentAnswers: ConsentRule[] = [
  { id: 'hooks-continue-untrusted', kind: 'hooks', asks: /hooks? (?:is|are) new or changed|hooks can run outside the sandbox/i,
    choose: /^\W*(\d)[.)]\s*Continue without trusting\b/im, answer: 'Continue without trusting (hooks do not run)' },
  { id: 'telemetry-decline', kind: 'telemetry', asks: /\b(?:telemetry|usage (?:data|statistics)|anonymous (?:usage|data)|crash reports?|analytics)\b/i,
    choose: /^\W*(\d)[.)]\s*(?:No\b|Don'?t\b|Do not\b|Decline\b|Opt[ -]out\b|Disable\b)/im, answer: 'Decline (nothing is sent)' },
];
/** What a prompt asks, for every kind the launcher recognises, answered or not. */
const promptKinds: [ConsentKind, RegExp][] = [
  ['payment', /\b(?:payment|credit card|billing|purchase|subscribe|subscription|upgrade to|pay\b)/i],
  ['credential', /\b(?:password|passphrase|api[ -]?key|access token|sign in|log ?in|login|authenticate|authorization code)\b/i],
  ['hooks', /\bhooks?\b[^\n]*\b(?:trust|new or changed|outside the sandbox)|\btrust\b[^\n]*\bhooks?\b/i],
  ['folder', /\btrust\b[^\n]*\b(?:folder|directory|workspace|files in)\b|\b(?:folder|directory|workspace)\b[^\n]*\btrust|\ballow\b[^\n]*\bwork in this (?:folder|directory)/i],
  ['telemetry', consentAnswers[1].asks],
  ['trust', /\b(?:do you trust|trust (?:all|this|these)|untrusted)\b/i],
];
/** A numbered choice waiting for a keystroke: `1. Yes`, `› 2) No`. */
const menuOption = /^\W{0,4}\d[.)]\s+\S/m;
/** The prompts that are never answered by anybody but a human, whatever rule would match them. */
export const neverAnswered: ConsentKind[] = ['credential', 'payment'];
/** How much of the screen bottom a dialog is read from, and how much of it a record keeps. */
export const consentScreenLines = 25, consentTextLimit = 400;

/**
 * The dialog the screen ends on: its last numbered menu, and the few lines just above it that ask
 * the question. A menu is options no more than one line apart (an option may carry a description
 * line); the dialog must be the last thing drawn, with at most `consentFooterLines` below its
 * last option (a key hint, a box border), and its question must sit within `consentQuestionLines`
 * of the first option. Words that ask a consent question elsewhere in the tail — output above an
 * unrelated numbered list, or a list printed long ago — are not a dialog waiting for a keystroke.
 */
export const consentQuestionLines = 5, consentFooterLines = 2;
function trailingDialog(lines: string[]): { lines: string[]; question: string[] } | null {
  let last = -1;
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 1 - consentFooterLines); index--) if (menuOption.test(lines[index])) { last = index; break; }
  if (last < 0) return null;
  let first = last;
  for (let index = last - 1; index >= 0 && first - index <= 2; index--) if (menuOption.test(lines[index])) first = index;
  const question = lines.slice(Math.max(0, first - consentQuestionLines), first);
  return { lines: [...question, ...lines.slice(first, last + 1)], question };
}

/** The consent prompt on a pane's screen, or null when the screen is not stopped on one. */
export function detectConsentPrompt(screen: string | null | undefined): ConsentPrompt | null {
  if (!screen) return null;
  const tail = screen.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(-consentScreenLines);
  const dialog = trailingDialog(tail);
  if (!dialog) return null;
  const { lines } = dialog, asked = dialog.question.join('\n'), bottom = lines.join('\n');
  // The question decides the kind; the options only ever pick the answer.
  const kind = promptKinds.find(([, asks]) => asks.test(asked))?.[0];
  if (!kind) return null;
  // The prompt's own text: from the first line that asks through the last option offered.
  const first = lines.findIndex(line => promptKinds.some(([, asks]) => asks.test(line)));
  const shown = lines.slice(Math.max(0, first)).join(' / ');
  const text = shown.length > consentTextLimit ? `${shown.slice(0, consentTextLimit - 1)}…` : shown;
  if (neverAnswered.includes(kind)) return { kind, text, rule: null, keys: null };
  for (const rule of consentAnswers) {
    if (!rule.asks.test(asked)) continue;
    const option = rule.choose.exec(bottom)?.[1];
    if (option) return { kind: rule.kind, text, rule, keys: [option] };
  }
  return { kind, text, rule: null, keys: null };
}

/**
 * How long a session held on a prompt nobody answered keeps its slot: long enough for a human who
 * sees the attention item to attach and answer, short against a lease a supervisor would otherwise
 * renew all night. Past it the watch supervisor stops renewing, releases the lease and stops.
 */
export const consentHoldMs = 15 * 60_000;
/** A held session's record, beside its launch files: `.graphyard/launch/NAME.consent`. */
export interface ConsentHold {
  key: string; epoch: number; agentName: string; pane: string; attach: string; prompt: string; kind: ConsentKind; since: string; releaseAt: string;
  /** A runtime prompted after it starts (no request contract) has not been sent its request: the file holding it, pasted once the prompt clears. */
  request?: string | null;
}
export const consentHoldSuffix = '.consent';
export const consentHoldPath = (stem: string) => `${stem}${consentHoldSuffix}`;
export function writeConsentHold(stem: string, hold: ConsentHold) {
  writeFileSync(consentHoldPath(stem), `${JSON.stringify(hold, null, 2)}\n`, { mode: 0o600 });
  return consentHoldPath(stem);
}
/** The holds recorded in a checkout's launch directory; one checkout runs one session, so there is at most one in practice. */
export function readConsentHolds(checkout: string): (ConsentHold & { path: string })[] {
  const folder = resolve(checkout, '.graphyard/launch');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => name.endsWith(consentHoldSuffix)).flatMap(name => {
    const path = resolve(folder, name);
    try {
      const hold = JSON.parse(readFileSync(path, 'utf8')) as ConsentHold;
      return typeof hold?.key === 'string' && Number.isInteger(hold.epoch) && typeof hold.since === 'string' ? [{ ...hold, path }] : [];
    } catch { return []; }
  });
}
export function clearConsentHold(path: string) { try { unlinkSync(path); } catch { /* already gone */ } }

/** The one attention line for a held session: the item, the pane, the prompt and the attach command. */
export function consentHoldAttention(hold: ConsentHold) {
  return `${hold.key} epoch ${hold.epoch}: session ${hold.agentName} in pane ${hold.pane} is awaiting consent and has not taken its request — "${hold.prompt}". `
    + `The launcher answers only its allow-list, and this ${hold.kind} prompt is outside it; attach with ${hold.attach} and answer it, or the watch supervisor releases the slot at ${hold.releaseAt}`;
}

/**
 * What the watch supervisor does about its session's hold on each check: nothing while there is
 * none, `cleared` once the prompt is off the screen (a human answered it), `release` once the hold
 * has outlived its bound and a successful read shows the prompt still up.
 */
export function consentHoldVerdict(hold: ConsentHold | null, screen: string | null, now: number): 'none' | 'holding' | 'cleared' | 'release' {
  if (!hold) return 'none';
  // A screen that could not be read is a signal not collected: the prompt may already be answered,
  // so the hold stays pending until a read confirms it either way, however late that is.
  if (screen === null) return 'holding';
  if (!detectConsentPrompt(screen)) return 'cleared';
  return now >= Date.parse(hold.releaseAt) ? 'release' : 'holding';
}

/** An answered prompt as a session record keeps it. */
export const consentAnswerSchema = z.object({
  rule: z.string().min(1).max(80), kind: z.enum(['hooks', 'trust', 'folder', 'telemetry', 'credential', 'payment']),
  prompt: z.string().min(1).max(consentTextLimit + 1), answer: z.string().min(1).max(200), keys: z.array(z.string().min(1).max(20)).min(1).max(4), at: z.string().min(1).max(40),
}).strict();
