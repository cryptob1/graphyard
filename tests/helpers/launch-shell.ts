// The pane's shell, for tests of session launches (GY-121). A launcher types one short line into
// an interactive shell — `GY=STEM; [SUPERVISOR…] KIND ARGS… --append-system-prompt-file "$GY.role"
// "$(cat "$GY.request")"` — and the shell expands the two references from the files under STEM
// before the runtime starts. Tests that stub Herdr use this to read the launch the way the
// runtime would: the runtime kind, its arguments after expansion, and the request it starts on.
import { readFileSync } from 'node:fs';

export interface TypedLaunch { stem: string | null; words: string[]; kind: string; args: string[] }

/** What the shell hands the runtime: bare and single-quoted words, the role reference as its path, the request reference as the file's text. */
export function expandTypedCommand(command: string): TypedLaunch {
  const bound = /^GY=(\S+); (.*)$/s.exec(command);
  const stem = bound ? bound[1].replace(/^'(.*)'$/s, '$1').replaceAll("'\\''", "'") : null;
  const words: string[] = [];
  for (const match of (bound ? bound[2] : command).matchAll(/'((?:[^']|'\\'')*)'|("\$GY\.role")|("\$\(cat "\$GY\.request"\)")|(\S+)/g)) {
    if (match[1] !== undefined) words.push(match[1].replaceAll("'\\''", "'"));
    else if (match[2]) words.push(`${stem}.role`);
    else if (match[3]) words.push(readFileSync(`${stem}.request`, 'utf8'));
    else words.push(match[4]);
  }
  // A supervised worker: `node CLI watch KEY EPOCH -- KIND ARGS…`; otherwise the runtime leads.
  const separator = words.indexOf('--');
  const runtime = separator >= 0 ? words.slice(separator + 1) : words;
  return { stem, words, kind: runtime[0], args: runtime.slice(1) };
}

/** The instruction the runtime would read from its own arguments, per the real CLI contracts. */
export function requestOf(kind: string, args: string[]) {
  const flag = ({ opencode: '--prompt', gemini: '--prompt-interactive', qwen: '--prompt-interactive', copilot: '--interactive' } as Record<string, string>)[kind];
  if (flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] ?? null : null; }
  if (!['claude', 'codex', 'cursor', 'pi', 'muse'].includes(kind)) return null;
  // Positional: the one argument that is neither a flag nor a flag's value.
  const valued = new Set(['--permission-mode', '--setting-sources', '--settings', '--append-system-prompt', '--append-system-prompt-file', '--ask-for-approval', '--sandbox', '-c', '--add-dir', '--model', '--approval-mode']);
  for (let index = 0; index < args.length; index++) {
    if (valued.has(args[index])) { index++; continue; }
    if (!args[index].startsWith('-')) return args[index];
  }
  return null;
}

/** The role authorization the runtime would load from its role file, or null when the launch carries none. */
export function roleOf(args: string[]) {
  const index = args.indexOf('--append-system-prompt-file');
  return index >= 0 ? readFileSync(args[index + 1], 'utf8') : null;
}

/**
 * The Herdr answers a stub gives a launch that starts at once: the typed line is accepted, the
 * runtime it names is seen ready under the pane, and the rename succeeds. Anything else is null,
 * for the stub's own answers.
 */
let typedKind = 'claude';
export function startedAtOnce(args: string[], status = 'idle'): string | null {
  const json = (result: unknown) => JSON.stringify({ result });
  if (args[0] === 'pane' && args[1] === 'run') { typedKind = expandTypedCommand(args[3]).kind; return ''; }
  if (args[0] === 'pane' && args[1] === 'read') return `${typedKind} ready\n`;
  if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: typedKind, agent_status: status, pane_id: args[2] } });
  if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: typedKind, agent_status: status, name: args[3] } });
  return null;
}
