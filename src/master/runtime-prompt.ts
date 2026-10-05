// Concern: a blocked session's runtime prompt — reading it off the screen and the safe answer the loop gives.
/**
 * A runtime's own safety prompt, read off a blocked session's screen (GY-197).
 *
 * Runtimes keep some prompts beyond every approval flag they take — Claude Code asks before an
 * `rm` whose target it cannot resolve even under `--dangerously-skip-permissions` — and a session
 * that stops on one waits for a person no one will be. The loop answers the shapes it knows with
 * the answer that does nothing: a Yes/No (or proceed/cancel) menu whose "yes" runs a destructive
 * command is declined, and the session is then told how to carry on without that command. Any
 * other prompt is `unknown`, and the loop fails the attempt on it rather than waiting. A runtime's
 * first-run folder-trust dialog is `folder-trust` (GY-1306): every launch records its folder
 * trusted before the runtime starts, so a session that still meets the dialog is a failed launch,
 * closed at once naming the dialog, never answered and never held as an unclassifiable prompt.
 */
export interface RuntimePrompt {
  /** `destructive-command` is a known shape with a safe answer; `folder-trust` a runtime's first-run folder-trust dialog, a failed launch; `unknown` is everything else a blocked screen shows. */
  kind: 'destructive-command' | 'folder-trust' | 'unknown';
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
 * or a git command that discards work (GY-223) — including `find … -delete`, `git rm` and
 * `rsync --delete` (GY-472). A word such as "remove" or "force" in the prompt's prose does not
 * make it destructive; the command it would run does.
 */
const destructiveCommand = /(?:^|[;&|(`]|\$\(|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*)\s*(?:(?:rm|rmdir|unlink|shred|mv|truncate|dd)\s|find\s[^;&|]*\s-delete\b|rsync\s[^;&|]*--(?:delete|remove-source-files)\b|git\s+(?:rm\s|clean\b|reset\s+--hard\b|push\b.*(?:--force\b|\s-f\b)|branch\s+-D\b|checkout\s+--\s))/i;
/**
 * A shell redirect that truncates a file: a lone `>` (or `>|`, `2>`, `&>`) after a word and a
 * space, onto a target that names a file — a path with a `/` or a name with an extension. An
 * append (`>>`), a descriptor duplication (`2>&1`), `/dev/null`, an arrow (`->`) and a comparison
 * such as `x > 5.0` are not overwrites.
 */
const overwriteRedirect = /\S\s+[0-9&]?>\|?(?![>&])\s*["']?(?!\/dev\/null\b)[\w~.$\/-]*(?:\/|\.[A-Za-z]\w*)/;
/** A command's own confirmation, such as `rm: remove regular file 'x'?` or `mv: overwrite 'y'?`. */
const commandConfirmation = /^(?:rm|rmdir|unlink|shred|mv|cp):\s/i;
/** Box borders, bullets and a shell's `$` before a command on a runtime's screen. */
const screenFrame = /^[\s│┃║╎┆>$●⎿•]+/;
/** Whether a prompt's "yes" is destructive: the runtime says so, or a command it shows is one. */
export function destructivePrompt(lines: string[]) {
  if (runtimeWarning.test(lines.join(' '))) return true;
  return lines.some(entry => { const line = entry.replace(screenFrame, ''); return destructiveCommand.test(line) || commandConfirmation.test(line) || overwriteRedirect.test(line); });
}
const collapse = (lines: string[]) => {
  const text = lines.map(entry => entry.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  return text.length > runtimePromptTextLimit ? `${text.slice(0, runtimePromptTextLimit - 1)}…` : text;
};
/**
 * A folder-trust dialog's own option, as each runtime draws it: Claude Code's "Yes, I trust this
 * folder" (numbered, or arrow-selected unnumbered), Codex's "Trust and continue", Antigravity's and
 * Cursor's "Trust this folder"/"Trust workspace". Only an option-shaped line among the screen's last
 * lines counts, so a session merely printing these words above some other prompt is not one.
 */
const folderTrustOption = /^\s*(?:[❯>›▶→]\s*)?(?:\d[.)]\s+)?(?:Yes,?\s+I\s+trust\s+(?:this|the)\s+(?:folder|files|workspace|project)|Trust\s+and\s+continue|Trust\s+(?:this\s+)?(?:folder|workspace|project))\b/i;
export const folderTrustScreenLines = 8;
function folderTrustDialog(filled: { entry: string }[]): RuntimePrompt | null {
  const tail = filled.slice(-folderTrustScreenLines).map(({ entry }) => entry);
  const at = tail.findIndex(line => folderTrustOption.test(line.replace(screenFrame, '')));
  if (at < 0) return null;
  // The dialog's own text: the lines above its option that ask, through its last option.
  const index = filled.length - tail.length + at, above = filled.slice(Math.max(0, index - 6), index).map(({ entry }) => entry);
  return { kind: 'folder-trust', text: collapse([...above, ...tail.slice(at)]), keys: null, answer: null };
}
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
  const trust = folderTrustDialog(filled);
  if (trust) return trust;
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
const forcePush = /\bgit\s+push\b[^;&|]*(?:--force\b|--force-with-lease\b|\s-f\b|\s\+\S)/i;
/** The one instruction a session gets after the loop declined its destructive-command prompt: carry on with a safe alternative. */
export function continueAfterDecline(key: string, prompt: Pick<RuntimePrompt, 'text' | 'answer'>, directory: string | null) {
  const where = directory ? `explicit paths inside your worktree ${directory}` : 'explicit paths inside your own checkout';
  // A force push is how a worker tries to take back out-of-scope edits it already pushed; the
  // remedy is one more commit, which `sync --restore` makes (GY-859).
  const remedy = forcePush.test(prompt.text) ? `A force push is never needed or allowed: if files outside plannedFiles differ from the base, run graphyard sync ${key} --restore, which restores them in one new commit, then push with a plain git push. ` : '';
  return `Graphyard answered your runtime's destructive-command prompt for you with "${prompt.answer}", because no person will answer it: "${prompt.text}". Continue ${key} without that command. ${remedy}`
    + `Use a safe alternative that needs no confirmation: name ${where}, or create a scratch directory with mktemp -d and remove only that directory by its exact path. `
    + 'Never give rm or mv a glob or a variable as its target outside a directory you created with mktemp -d. Do not stop or ask anyone; carry on with your task.';
}
