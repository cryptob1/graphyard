import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { autonomyContract } from '../../src/autonomy';

/**
 * The Graphyard Pi extension (GY-169). A Pi session Graphyard starts through its headless runner
 * (src/runner/pi.ts) loads this and nothing else. It gives the agent Graphyard's actions as typed
 * tools, so the session's result is a validated tool call rather than prose; it puts the autonomy
 * contract in the session's system prompt; and it guards the one class of command a session must
 * never run blindly. Nothing here asks a person anything: there is no UI call anywhere in this
 * file, and a refused call returns its reason to the agent so it retries safely.
 *
 * `GRAPHYARD_PI_ROLE` (approver | producer | research | triage) selects the role's tool; unset, the approver's
 * and the producer's are registered.
 * The tools submit nothing to the control plane themselves: the runner hands the validated payload
 * to the loop, which applies it through the same routes a terminal session uses, and the gates
 * decide. The extension is self-contained apart from the one contract text it shares with every
 * other launched session.
 */

// ---- A minimal Pi extension surface: only what this extension uses ----------------------------
export interface ToolResult { content: { type: 'text'; text: string }[]; details: unknown; terminate?: boolean }
export interface ToolDefinition { name: string; label: string; description: string; promptSnippet?: string; parameters: JsonSchema; execute: (callId: string, params: any) => Promise<ToolResult> }
export interface ExtensionApi {
  registerTool(tool: ToolDefinition): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
}

// ---- Tool schemas and their validation -------------------------------------------------------
export type JsonSchema = { type: 'object' | 'string' | 'boolean' | 'integer' | 'number' | 'array'; description?: string; properties?: Record<string, JsonSchema>; required?: string[];
  additionalProperties?: boolean; enum?: readonly string[]; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number; items?: JsonSchema; minItems?: number; maxItems?: number };

const text = (maxLength: number, description: string): JsonSchema => ({ type: 'string', minLength: 1, maxLength, description });
const sha = (description: string): JsonSchema => ({ type: 'string', pattern: '^[0-9a-fA-F]{40}$', description });
const count = (description: string): JsonSchema => ({ type: 'integer', minimum: 0, description });

export const decideParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['decision', 'approve', 'reason'],
  properties: {
    decision: text(100, 'The id of the decision you judged, exactly as Graphyard lists it'),
    approve: { type: 'boolean', description: 'true to approve the decision, false to refuse it' },
    reason: text(2000, 'Why, weighed against the item\'s criteria and the operator\'s goals'),
  },
};
export const evidenceParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['proof', 'sha', 'baseSha', 'policyRevision', 'result', 'executed', 'skipped', 'exercise'],
  properties: {
    proof: text(200, 'The proof id, such as unit:runner-pi-events'),
    sha: sha('The exact head you ran'), baseSha: sha('The exact base you were given'),
    policyRevision: { type: 'integer', minimum: 1, description: 'The policy revision you were given' },
    result: { type: 'string', enum: ['pass', 'fail'], description: 'pass only when every case ran and passed' },
    executed: count('The number of cases that actually ran'), skipped: count('The number of cases skipped'),
    exercise: { type: 'object', additionalProperties: false, required: ['behaviour', 'result', 'executed'], description: 'The same proof run against a tree with the criterion\'s behaviour removed',
      properties: { criterion: text(80, 'The criterion id, such as AC-1'), behaviour: text(300, 'The behaviour you removed'), result: { type: 'string', enum: ['pass', 'fail'] }, executed: count('Cases that ran against the stripped tree') } },
    environment: text(100, 'The runtime and how the result was produced'),
    scopeFiles: { type: 'array', minItems: 1, maxItems: 100, items: text(500, 'A path the proof depends on') },
  },
};

/** The research brief (GY-259, src/research.ts researchBriefSchema): what exists, what is proven, what could go wrong, what to do, and what only the operator may decide. */
export const researchParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['existingCode', 'patterns', 'risks', 'approach', 'questions'],
  properties: {
    existingCode: { type: 'array', maxItems: 40, description: 'Existing code and conventions in this checkout to reuse',
      items: { type: 'object', additionalProperties: false, required: ['path', 'note'], properties: { path: text(500, 'A path in this checkout'), note: text(1000, 'What it offers the item') } } },
    patterns: { type: 'array', maxItems: 20, description: 'Relevant external patterns and prior art',
      items: { type: 'object', additionalProperties: false, required: ['pattern', 'source'], properties: { pattern: text(1000, 'The pattern or prior art'), source: text(500, 'Where it comes from: a URL, library, standard or path') } } },
    risks: { type: 'array', maxItems: 20, items: text(1000, 'A risk or edge case the build must handle') },
    approach: text(6000, 'The approach you recommend the worker take'),
    questions: { type: 'array', maxItems: 10, description: 'Product-experience questions only the operator may answer; the build proceeds on each recommendation until answered',
      items: { type: 'object', additionalProperties: false, required: ['question', 'why', 'recommendation'], properties: { question: text(1000, 'The question'), why: text(1000, 'Why the answer matters'), recommendation: text(1000, 'The answer you recommend') } } },
  },
};

/** The triage judgement (GY-402, src/model/machine-backlog.ts triageJudgementSchema): release at a priority, close with a reason, or merge into another item. */
export const triageParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['outcome', 'reason'],
  properties: {
    outcome: { type: 'string', enum: ['release', 'close', 'merge'], description: 'release: real work still worth doing; close: already fixed or not worth doing; merge: another open item already covers it' },
    priority: { type: 'integer', minimum: 0, maximum: 4, description: 'For release only: 0 is the most urgent, 4 the least' },
    ref: text(40, 'For close only, when already fixed: the delivered item that fixed it, such as GY-123; omit when it is not worth doing'),
    into: text(40, 'For merge only: the open item that already covers it, such as GY-123'),
    reason: text(2000, 'Why, with the evidence an approver can check'),
  },
};

/** Every reason `value` does not match `schema`; empty when it does. */
export function schemaErrors(schema: JsonSchema, value: unknown, path = 'input'): string[] {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type === 'integer' ? !Number.isInteger(value) : schema.type !== type) return [`${path} must be ${schema.type === 'integer' ? 'an integer' : `a ${schema.type}`}`];
  const errors: string[] = [];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) errors.push(`${path} must not be empty`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} must match ${schema.pattern}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`);
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} must have at least ${schema.minItems} entries`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} must have at most ${schema.maxItems} entries`);
    if (schema.items) value.forEach((entry, index) => errors.push(...schemaErrors(schema.items!, entry, `${path}[${index}]`)));
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (record[name] === undefined) errors.push(`${path}.${name} is required`);
    for (const [name, entry] of Object.entries(record)) {
      const property = schema.properties?.[name];
      if (property) { if (entry !== undefined) errors.push(...schemaErrors(property, entry, `${path}.${name}`)); }
      else if (schema.additionalProperties === false) errors.push(`${path}.${name} is not a field of this tool`);
    }
  }
  return errors;
}

/**
 * The Graphyard tools. Each rejects a malformed call by throwing, which Pi returns to the agent
 * as a failed tool result naming every problem, and accepts one submission per subject (a
 * decision, a proof): the first accepted call is the answer.
 */
export function graphyardTools(role: string | undefined = process.env.GRAPHYARD_PI_ROLE): ToolDefinition[] {
  const tool = (name: string, label: string, description: string, parameters: JsonSchema, subject: (params: any) => string, terminate: boolean): ToolDefinition => {
    const submitted = new Set<string>();
    return { name, label, description, parameters, promptSnippet: description,
      async execute(_callId, params) {
        const errors = schemaErrors(parameters, params);
        if (errors.length) throw new Error(`${name} was not recorded: ${errors.join('; ')}. Correct the call and make it again.`);
        const key = subject(params);
        if (submitted.has(key)) throw new Error(`${name} already recorded ${key} in this session; the first submission stands`);
        submitted.add(key);
        return { content: [{ type: 'text', text: `${name} recorded ${key}. Graphyard applies it and its gates decide; do not repeat it.` }], details: params, terminate };
      } };
  };
  const decide = tool('graphyard_decide', 'Graphyard decide', 'Record your verdict on the Graphyard decision you were asked to judge: approve true or false, with your reason. Call it exactly once; it is your answer.', decideParameters, params => `decision ${params.decision}`, true);
  const evidence = tool('graphyard_submit_evidence', 'Graphyard evidence', 'Submit one proof\'s result on the exact head, base and policy revision you were given, with the exercise run against the tree with the criterion\'s behaviour removed. Call it once per proof, pass or fail.', evidenceParameters, params => `proof ${params.proof}`, false);
  // The research session's brief (GY-259) is registered for its own role only.
  if (role === 'research') return [tool('graphyard_research_brief', 'Graphyard research brief', 'Record the research brief for the item you were asked to research: existing code to reuse, patterns and prior art with sources, risks, the approach you recommend, and the operator\'s product questions with your recommended answers. Call it exactly once; it is your result.', researchParameters, () => 'the brief', true)];
  // The triage session's judgement of a machine-filed backlog item (GY-402), likewise for its own role only.
  if (role === 'triage') return [tool('graphyard_triage_decision', 'Graphyard triage decision', 'Record your judgement of the machine-filed backlog item you were asked to triage: release it with a priority, close it with a reason (naming the delivered item that already fixed it, if any), or merge it into another open item. Call it exactly once; it is your result.', triageParameters, () => 'the judgement', true)];
  return role === 'approver' ? [decide] : role === 'producer' ? [evidence] : [decide, evidence];
}

// ---- The destructive-command guard -------------------------------------------------------------
export interface GuardContext { cwd: string; home?: string; sessionDirectories?: Iterable<string> }
export type GuardVerdict = { allow: true } | { allow: false; reason: string };

/** The end of a command substitution opened just before `start`: the index of its closing `)` (or backtick), honouring nesting and quotes. */
function substitutionEnd(line: string, start: number, backtick: boolean) {
  let depth = 0, quote: '"' | '\'' | null = null;
  for (let index = start; index < line.length; index++) {
    const char = line[index];
    if (quote === '\'') { if (char === '\'') quote = null; continue; }
    if (char === '\\') { index++; continue; }
    if (backtick) { if (char === '`') return index; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === '\'' || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') { if (depth === 0) return index; depth--; }
  }
  return line.length;
}

type ShellWord = { value: string; dynamic: boolean; glob: boolean };

/**
 * Split a shell line into the words of each simple command, honouring quotes; marks words whose
 * value the shell would expand. The body of every command substitution — `$(…)` or backticks,
 * quoted or not — is a command line of its own, so its commands are returned as segments too.
 */
function shellWords(line: string): ShellWord[][] {
  const segments: { words: ShellWord[] }[] = [{ words: [] }], nested: ShellWord[][] = [];
  let word: ShellWord | null = null, quote: '"' | '\'' | null = null;
  const push = () => { if (word) segments.at(-1)!.words.push(word); word = null; };
  const current = () => word ??= { value: '', dynamic: false, glob: false };
  const substitution = (index: number) => {
    const backtick = line[index] === '`', start = index + (backtick ? 1 : 2), end = substitutionEnd(line, start, backtick);
    nested.push(...shellWords(line.slice(start, end)));
    current().dynamic = true;
    current().value += line.slice(index, end + 1);
    return end;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === '\'') { if (char === '\'') quote = null; else current().value += char; continue; }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '\\' && index + 1 < line.length) current().value += line[++index];
      else if (char === '`' || (char === '$' && line[index + 1] === '(')) index = substitution(index);
      else { if (char === '$') current().dynamic = true; current().value += char; }
      continue;
    }
    if (char === '\'' || char === '"') { quote = char; current(); continue; }
    if (char === '\\' && index + 1 < line.length) { current().value += line[++index]; continue; }
    if (char === '`' || (char === '$' && line[index + 1] === '(')) { index = substitution(index); continue; }
    if (/\s/.test(char) && char !== '\n') { push(); continue; }
    if (char === '\n' || char === ';' || char === '|' || char === '&' || char === '(' || char === ')') { push(); segments.push({ words: [] }); continue; }
    if (char === '$') current().dynamic = true;
    if ('*?[{'.includes(char)) current().glob = true;
    if (char === '~' && !word) current().dynamic = !line.slice(index + 1).match(/^(\/|\s|$)/);
    current().value += char;
  }
  push();
  return [...segments.map(segment => segment.words), ...nested].filter(words => words.length);
}

const inside = (path: string, directory: string) => { const rel = relative(directory, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };
/** The path with every symbolic link it passes through resolved, as far as the path exists; a final component without a trailing slash is the link itself, as rm and mv treat it. */
function physical(path: string, trailingSlash: boolean) {
  const real = (entry: string): string => { try { return realpathSync(entry); } catch { const parent = dirname(entry); return parent === entry ? entry : join(real(parent), basename(entry)); } };
  return trailingSlash ? real(path) : join(real(dirname(path)), basename(path));
}
/** Words that open or continue a compound command: the simple command starts after them. */
const reserved = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'coproc']);
/**
 * Programs that run the command after them, with the options of each that take a separate
 * argument and how many plain arguments come before the command (timeout's duration, flock's file).
 */
const wrappers = new Map<string, { arguments?: string[]; positional?: number }>([
  ['sudo', { arguments: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir', '--chroot', '--close-from', '--other-user', '--role', '--type', '--command-timeout'] }],
  ['doas', { arguments: ['-u', '-C'] }], ['command', {}], ['builtin', {}], ['nohup', {}], ['setsid', {}], ['unbuffer', {}], ['chronic', {}],
  ['time', { arguments: ['-f', '-o', '--format', '--output'] }], ['exec', { arguments: ['-a'] }],
  ['env', { arguments: ['-u', '-C', '--unset', '--chdir'] }], ['nice', { arguments: ['-n', '--adjustment'] }],
  ['ionice', { arguments: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'] }], ['stdbuf', { arguments: ['-i', '-o', '-e', '--input', '--output', '--error'] }],
  ['timeout', { arguments: ['-s', '-k', '--signal', '--kill-after'], positional: 1 }], ['chrt', { positional: 1 }], ['taskset', { positional: 1 }],
  ['flock', { arguments: ['-w', '-E', '--timeout', '--conflict-exit-code'], positional: 1 }],
]);
const indirect = new Set(['xargs', 'eval', 'bash', 'sh', 'zsh', 'dash', 'find', 'parallel', 'watch', 'su', 'runuser', 'script']);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The index of the word that names the simple command a segment runs, past reserved words, assignments and wrappers with their options and arguments, and whether a wrapper was passed. */
function commandIndex(words: ShellWord[]) {
  let index = 0, wrapped = false;
  for (;;) {
    while (index < words.length && (reserved.has(words[index].value) || assignment.test(words[index].value))) index++;
    const wrapper = wrappers.get(words[index]?.value.split('/').pop() ?? '');
    if (!wrapper) return { index, wrapped };
    wrapped = true;
    index++;
    let positional = wrapper.positional ?? 0;
    while (index < words.length) {
      const value = words[index].value;
      if (value === '--') { index++; break; }
      if (value.startsWith('-') && value.length > 1) { index += wrapper.arguments?.includes(value) ? 2 : 1; continue; }
      if (assignment.test(value)) { index++; continue; }
      if (positional > 0) { positional--; index++; continue; }
      break;
    }
    while (positional-- > 0 && index < words.length) index++;
  }
}

/**
 * Whether a bash command may run. rm and mv are refused when a target is a glob, a variable or
 * any other expansion, a path that cannot be resolved statically, or a path outside the worktree
 * — except inside a directory this session created with mktemp. A command that runs rm or mv
 * through another program (xargs, eval, sh -c, find -exec) is refused too, since its targets are
 * not on the line. The reason says what to do instead.
 */
export function guardCommand(command: string, context: GuardContext): GuardVerdict {
  const home = context.home ?? homedir(), worktree = physical(resolve(context.cwd), true), sessions = [...(context.sessionDirectories ?? [])].map(entry => physical(resolve(entry), true));
  const retry = `Retry with each target spelled out as a literal path inside the worktree ${worktree}${sessions.length ? ` or inside your mktemp directory ${sessions.join(', ')}` : ' or inside a directory you created with mktemp -d'}.`;
  let cwd: string | null = worktree;
  for (const words of shellWords(command)) {
    const { index, wrapped } = commandIndex(words);
    const name = words[index]?.value.split('/').pop() ?? '';
    if (name === 'cd') { const target = words[index + 1]; cwd = target && !target.dynamic && !target.glob && cwd ? resolve(cwd, target.value.replace(/^~(?=\/|$)/, home)) : null; continue; }
    if (indirect.has(name) && words.slice(index + 1).some(entry => /(^|\/|\s)(rm|mv)(\s|$)/.test(entry.value)))
      return { allow: false, reason: `Graphyard refused this command: it runs rm or mv through ${name}, so its targets cannot be checked. Run rm or mv directly. ${retry}` };
    // A wrapper whose arguments were not recognised could hide rm or mv behind them: refuse rather than guess.
    if (wrapped && name !== 'rm' && name !== 'mv' && words.slice(index + 1).some(entry => /^(rm|mv)$/.test(entry.value.split('/').pop() ?? '')))
      return { allow: false, reason: `Graphyard refused this command: it runs rm or mv behind ${words[0].value} with arguments Graphyard cannot parse, so its targets cannot be checked. Run rm or mv directly. ${retry}` };
    if (name !== 'rm' && name !== 'mv') continue;
    let options = true, redirect = false;
    for (const target of words.slice(index + 1)) {
      // A redirection is the shell's, not a target: `2>/dev/null`, or `>` and the word after it.
      if (redirect) { redirect = false; continue; }
      if (/^\d*(>>?|<)&?$/.test(target.value)) { redirect = true; continue; }
      if (/^\d*(>>?|<)/.test(target.value)) continue;
      if (options && target.value === '--') { options = false; continue; }
      if (options && target.value.startsWith('-') && !target.dynamic) continue;
      if (target.dynamic) return { allow: false, reason: `Graphyard refused this command: ${name} target "${target.value}" is a variable or expansion whose value cannot be checked before it runs. ${retry}` };
      if (target.glob) return { allow: false, reason: `Graphyard refused this command: ${name} target "${target.value}" is a glob whose matches cannot be checked before it runs. ${retry}` };
      if (!cwd && !isAbsolute(target.value) && !target.value.startsWith('~')) return { allow: false, reason: `Graphyard refused this command: ${name} target "${target.value}" is relative to a directory changed through an expansion, so it cannot be resolved. ${retry}` };
      const lexical = resolve(cwd ?? worktree, target.value.replace(/^~(?=\/|$)/, home));
      // Resolve symbolic links too: `rm -rf link/` on a link to a directory outside deletes outside.
      const path = physical(lexical, /\/\.?$/.test(target.value));
      if (sessions.some(directory => path === directory || inside(path, directory))) continue;
      if (!inside(path, worktree)) return { allow: false, reason: `Graphyard refused this command: ${name} target "${target.value}" resolves to ${path}, outside the worktree. ${retry}` };
    }
  }
  return { allow: true };
}

/** Directories a mktemp call printed: kept only when each is a real directory under the temporary root. */
export function mktempDirectories(command: string, output: string, root = tmpdir()): string[] {
  if (!/\bmktemp\b/.test(command)) return [];
  const base = resolve(root);
  return output.split('\n').map(line => line.trim()).filter(line => isAbsolute(line) && inside(resolve(line), base) && !resolve(line).split(sep).includes('..'))
    .filter(line => { try { return statSync(line).isDirectory(); } catch { return false; } });
}

// ---- The extension -----------------------------------------------------------------------------
/** The section Graphyard adds to every Pi session's system prompt. */
export const systemPromptSection = `${autonomyContract} You run headless: nobody reads this session while it runs and nothing you print reaches a person. Your answer is the Graphyard tool call your request names, and nothing else counts as an answer. When a command is refused, read the reason and retry safely; never wait for anyone.`;

const outputText = (event: any) => [event?.content, event?.result?.content].flatMap(content => Array.isArray(content) ? content : []).map(part => part?.type === 'text' ? String(part.text ?? '') : '').join('\n');

export default function graphyard(pi: ExtensionApi) {
  const sessionDirectories = new Set<string>();
  for (const tool of graphyardTools()) pi.registerTool(tool);
  pi.on('before_agent_start', event => {
    const options = event?.systemPromptOptions;
    if (options?.sections) options.sections.graphyard_autonomy = systemPromptSection;
    else if (typeof event?.systemPrompt === 'string') return { systemPrompt: `${event.systemPrompt}\n\n${systemPromptSection}` };
    return undefined;
  });
  pi.on('tool_call', (event, ctx) => {
    if (event?.toolName !== 'bash') return undefined;
    const verdict = guardCommand(String(event.input?.command ?? ''), { cwd: ctx?.cwd ?? process.cwd(), sessionDirectories });
    return verdict.allow ? undefined : { block: true, reason: verdict.reason };
  });
  pi.on('tool_result', event => {
    if (event?.toolName !== 'bash' || event?.isError) return undefined;
    for (const directory of mktempDirectories(String(event.input?.command ?? ''), outputText(event))) sessionDirectories.add(directory);
    return undefined;
  });
}
