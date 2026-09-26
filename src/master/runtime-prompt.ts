// Concern: a blocked session's runtime prompt — reading it off the screen and the safe answer the loop gives.
/**
 * A runtime's own safety prompt, read off a blocked session's screen (GY-197).
 *
 * Runtimes keep some prompts beyond every approval flag they take — Claude Code asks before an
 * `rm` whose target it cannot resolve even under `--dangerously-skip-permissions` — and a session
 * that stops on one waits for a person no one will be. The loop answers the shapes it knows with
 * the answer that does nothing: a Yes/No (or proceed/cancel) menu whose "yes" runs a destructive
 * command is declined, and the session is then told how to carry on without that command. Any
 * other prompt is `unknown`, and the loop fails the attempt on it rather than waiting.
 */
export interface RuntimePrompt {
  /** `destructive-command` is a known shape with a safe answer; `unknown` is everything else a blocked screen shows. */
  kind: 'destructive-command' | 'unknown';
  /** The prompt's own words, collapsed to one line and bounded, as the record quotes it. */
  text: string;
  /** The keys that choose the non-destructive answer, and that answer's label; null for an unknown prompt. */
  keys: string[] | null; answer: string | null;
}
export const runtimePromptTextLimit = 400;
const menuOption = /^\s*(?:[❯>›▶→]\s*)?(\d)[.)]\s+(.+?)\s*$/;
const affirmative = /^(?:yes|proceed|continue|allow|run|approve)\b/i, negative = /^(?:no|cancel|deny|decline|reject|abort)\b/i;
/** The runtime's own words for a prompt whose "yes" cannot be taken back. */
const runtimeWarning = /\b(?:dangerous|destructive|irreversible|cannot be undone|permanently (?:delete|remove))/i;
/**
 * A command the prompt shows, classified by its verb at a command position (the start of a line,
 * after `(`, `;`, `&&`, `|`, a backtick, `$(`, `sudo` or `xargs`): a deletion, move or overwrite,
 * or a git command that discards work (GY-223). A word such as "remove" or "force" in the prompt's
 * prose does not make it destructive; the command it would run does.
 */
const destructiveCommand = /(?:^|[;&|(`]|\$\(|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*)\s*(?:(?:rm|rmdir|unlink|shred|mv|truncate|dd)\s|git\s+(?:clean\b|reset\s+--hard\b|push\b.*(?:--force\b|\s-f\b)|branch\s+-D\b|checkout\s+--\s))/i;
/** A command's own confirmation, such as `rm: remove regular file 'x'?` or `mv: overwrite 'y'?`. */
const commandConfirmation = /^(?:rm|rmdir|unlink|shred|mv|cp):\s/i;
/** Box borders, bullets and a shell's `$` before a command on a runtime's screen. */
const screenFrame = /^[\s│┃║╎┆>$●⎿•]+/;
/** Whether a prompt's "yes" is destructive: the runtime says so, or a command it shows is one. */
export function destructivePrompt(lines: string[]) {
  if (runtimeWarning.test(lines.join(' '))) return true;
  return lines.some(entry => { const line = entry.replace(screenFrame, ''); return destructiveCommand.test(line) || commandConfirmation.test(line); });
}
const collapse = (lines: string[]) => {
  const text = lines.map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  return text.length > runtimePromptTextLimit ? `${text.slice(0, runtimePromptTextLimit - 1)}…` : text;
};
/**
 * The prompt a blocked session's screen shows. Only the bottom of the screen is read — the last
 * menu on it and the lines just above that menu — so a command the session ran earlier and that
 * scrolled up cannot make the current prompt look destructive. Null when there is no screen.
 */
export function classifyRuntimePrompt(screen: string | null | undefined): RuntimePrompt | null {
  if (screen === null || screen === undefined) return null;
  const lines = screen.split('\n').map(entry => entry.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd());
  const filled = lines.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.trim());
  if (!filled.length) return null;
  // The last run of numbered options is the prompt's menu; the prompt is the lines above it.
  let end = -1;
  for (let at = filled.length - 1; at >= 0; at--) if (menuOption.test(filled[at].entry)) { end = at; break; }
  if (end >= 0) {
    let start = end;
    while (start > 0 && menuOption.test(filled[start - 1].entry)) start--;
    const options = filled.slice(start, end + 1).map(({ entry }) => { const [, number, label] = menuOption.exec(entry)!; return { number, label }; });
    const question = filled.slice(Math.max(0, start - 8), start).map(({ entry }) => entry);
    const text = collapse([...question, ...options.map(option => `${option.number}. ${option.label}`)]);
    const yes = options.find(option => affirmative.test(option.label)), no = options.find(option => negative.test(option.label));
    if (yes && no && destructivePrompt(question)) return { kind: 'destructive-command', text, keys: [no.number], answer: `${no.number}. ${no.label}` };
    return { kind: 'unknown', text, keys: null, answer: null };
  }
  const tail = filled.slice(-4).map(({ entry }) => entry);
  // An inline yes/no question, such as `Proceed? [y/N]`, is declined with `n`.
  if (/[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]/i.test(tail.at(-1) ?? '') && destructivePrompt(tail)) return { kind: 'destructive-command', text: collapse(tail), keys: ['n', 'Enter'], answer: 'n' };
  return { kind: 'unknown', text: collapse(tail), keys: null, answer: null };
}
/** The one instruction a session gets after the loop declined its destructive-command prompt: carry on with a safe alternative. */
export function continueAfterDecline(key: string, prompt: Pick<RuntimePrompt, 'text' | 'answer'>, directory: string | null) {
  const where = directory ? `explicit paths inside your worktree ${directory}` : 'explicit paths inside your own checkout';
  return `Graphyard answered your runtime's destructive-command prompt for you with "${prompt.answer}", because no person will answer it: "${prompt.text}". Continue ${key} without that command. `
    + `Use a safe alternative that needs no confirmation: name ${where}, or create a scratch directory with mktemp -d and remove only that directory by its exact path. `
    + 'Never give rm or mv a glob or a variable as its target outside a directory you created with mktemp -d. Do not stop or ask anyone; carry on with your task.';
}
