import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
 * `GRAPHYARD_PI_ROLE` (approver | producer | research | decomposition | diagnostician | doctor | triage) selects the role's tool; unset, the approver's
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
// GY-1402: the proof form `master create` accepts (src/model/proof.ts proofSchema), checked at the call so the agent corrects it in its run.
const proof: JsonSchema = { type: 'string', minLength: 1, maxLength: 200, pattern: '^(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+$', description: 'A proof id: unit:, integration:, e2e: or manual: then letters, digits and ._/- only, such as unit:fault-class-loop' };

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

/** The split of a broad item (GY-1126, src/runner/payloads.ts decompositionPayloadSchema): child items naming the parent's criteria by ID, or none to keep it whole. */
export const decomposeParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['reason', 'children'],
  properties: {
    reason: text(2000, 'Why this split (or why the item stays whole)'),
    children: { type: 'array', maxItems: 10, description: 'Two to ten child items, or an empty list to keep the item whole',
      items: { type: 'object', additionalProperties: false, required: ['title', 'criteria', 'plannedFiles'], properties: {
        title: text(200, 'The child item title'), description: text(6000, 'What this child builds'),
        criteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^[A-Z]+-\\d+$', description: 'A criterion ID of the parent, such as AC-2; each goes to exactly one child' } },
        plannedFiles: { type: 'array', minItems: 1, maxItems: 100, items: text(500, 'A file or directory this child changes, inside the parent\'s planned files and narrower than them') },
        after: { type: 'array', maxItems: 9, items: { type: 'integer', minimum: 0, maximum: 9, description: 'The 0-based position of an earlier child this one must land after' } },
      } } },
  },
};
/** The pipeline doctor's report (GY-711, src/runner/payloads.ts doctorReportPayloadSchema): what was stuck, what it did, what it filed. */
export const doctorReportParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['findings', 'actions', 'filed'],
  properties: {
    findings: { type: 'array', maxItems: 50, description: 'One entry per finding: the work item key or status-level subject, the check whose bound it passed, and what was stuck',
      items: { type: 'object', additionalProperties: false, required: ['subject', 'check', 'detail'],
        properties: {
          subject: text(200, 'The work item key the finding is on, such as GY-711, or a status-level subject such as installation'),
          check: { type: 'string', enum: ['blocked', 'worker', 'ci', 'review-request', 'launch', 'proofs', 'mergeable', 'decision', 'containment', 'refusal', 'overdue'], description: 'The check whose fault bound the finding passed' },
          detail: text(2000, 'What was stuck, since when, and why'),
          unactionable: { type: 'boolean', description: 'true when you could not act on it: a human-only decision, or a fault class with no item to act through' },
        } } },
    actions: { type: 'array', maxItems: 50, description: 'One entry per sanctioned command you ran: what it was and what became of it',
      items: { type: 'object', additionalProperties: false, required: ['subject', 'command', 'outcome', 'detail'],
        properties: { subject: text(200, 'The work item key the command acted on'), command: text(500, 'The command, as you ran it'), outcome: { type: 'string', enum: ['applied', 'refused'], description: 'applied when the control plane accepted it' }, detail: text(1000, 'What it changed, or the refusal the control plane gave') } } },
    filed: { type: 'array', maxItems: 20, description: 'One entry per fault item to file for a finding no open item covers (the loop files it and deduplicates it against open items)',
      items: { type: 'object', additionalProperties: false, required: ['faultClass', 'title', 'description', 'priority', 'criteria', 'plannedFiles'],
        properties: {
          faultClass: { type: 'string', enum: ['session-liveness', 'review-convergence', 'decision', 'scope', 'overlap-hold', 'observation', 'deployment', 'configuration', 'containment', 'merge', 'proof', 'capacity', 'resources', 'loop', 'human-decision', 'stalled-gate', 'unclassified'], description: 'The fault class the finding belongs to' },
          title: text(200, 'The fault item title'), description: text(20000, 'What is wrong, the evidence, and what should change'),
          priority: { type: 'integer', minimum: 0, description: '0 (P0) or 1 (P1): a fault the doctor files is urgent, never lower' },
          criteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'proofs'],
            properties: { id: { type: 'string', pattern: '^[A-Z]+-\\d+$', description: 'AC-1, AC-2, ...' }, text: text(4000, 'A testable criterion'), proofs: { type: 'array', minItems: 1, maxItems: 10, items: proof } } } },
          plannedFiles: { type: 'array', minItems: 1, maxItems: 100, items: text(500, 'A file or directory the fix changes') },
        } } },
  },
};

/** The diagnostician's diagnosis (GY-439, src/runner/payloads.ts diagnosisPayloadSchema): the cause, its evidence, its class, and exactly one answer. */
const faultClassNames = ['session-liveness', 'review-convergence', 'decision', 'scope', 'overlap-hold', 'observation', 'deployment', 'configuration',
  'containment', 'merge', 'proof', 'capacity', 'resources', 'loop', 'human-decision', 'stalled-gate', 'unclassified'] as const;
export const diagnoseParameters: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['subject', 'cause', 'evidence', 'faultClass'],
  properties: {
    subject: text(400, 'The work item key or invariant instance you were asked to diagnose, exactly as given'),
    cause: text(4000, 'The root cause the instances share, stated so a worker can remove it'),
    evidence: { type: 'object', additionalProperties: false, required: ['logLines', 'commands'], description: 'What the cause rests on: at least one log line or command',
      properties: { logLines: { type: 'array', maxItems: 50, items: text(1000, 'A log line, quoted exactly') }, commands: { type: 'array', maxItems: 50, items: text(1000, 'A command you ran and what it showed') } } },
    faultClass: { type: 'string', enum: faultClassNames, description: 'The fault class the cause belongs to' },
    covering: { type: 'string', pattern: '^GY-\\d+$', description: 'An existing open item that already covers this cause; omit when you give fix' },
    fix: { type: 'object', additionalProperties: false, required: ['title', 'description', 'priority', 'criteria', 'plannedFiles'], description: 'The root-cause item to file; omit when you give covering',
      properties: {
        title: text(200, 'The fix item title'), description: text(20000, 'The cause, the evidence and what to change'),
        type: { type: 'string', enum: ['feature', 'bug', 'chore'] }, priority: { type: 'integer', minimum: 0, description: 'The priority to release it at, 0 (highest) to 4' },
        criteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'proofs'],
          properties: { id: { type: 'string', pattern: '^[A-Z]+-\\d+$', description: 'AC-1, AC-2, ...' }, text: text(4000, 'A testable criterion'), proofs: { type: 'array', minItems: 1, maxItems: 10, items: proof } } } },
        plannedFiles: { type: 'array', minItems: 1, maxItems: 100, items: text(500, 'A file or directory the fix changes; name files, not the repository root') },
      } },
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
  // The research session's brief (GY-259), the diagnostician's diagnosis (GY-439) and the doctor's report (GY-711) are registered for their own roles only.
  if (role === 'diagnostician') return [tool('graphyard_diagnose', 'Graphyard diagnose', 'Record your diagnosis of the recurring fault or invariant violation you were asked to diagnose: its cause, the log lines and commands it rests on, its fault class, and either the existing open item that covers it or the fix item to file. Call it exactly once; it is your result.', diagnoseParameters, params => `diagnosis ${params.subject}`, true)];
  if (role === 'decomposition') return [tool('graphyard_decompose', 'Graphyard decompose', 'Record how the broad item you were asked to split divides into small child items, each with the parent criterion IDs it takes, its planned files and the earlier children it lands after; or an empty children list to keep it whole. Call it exactly once; it is your result.', decomposeParameters, () => 'the split', true)];
  if (role === 'doctor') return [tool(doctorReportToolName, 'Graphyard doctor report', 'Record the report of your doctor run: one entry per finding (what was stuck, under which check bound, and whether you could act), one per sanctioned command you ran and what it changed, and one per fault item to file for a finding no open item covers. Call it exactly once; it is your result.', doctorReportParameters, () => 'the doctor report', true)];
  if (role === 'research') return [tool('graphyard_research_brief', 'Graphyard research brief', 'Record the research brief for the item you were asked to research: existing code to reuse, patterns and prior art with sources, risks, the approach you recommend, and the operator\'s product questions with your recommended answers. Call it exactly once; it is your result.', researchParameters, () => 'the brief', true)];
  // The triage session's judgement of a machine-filed backlog item (GY-402), likewise for its own role only.
  if (role === 'triage') return [tool('graphyard_triage_decision', 'Graphyard triage decision', 'Record your judgement of the machine-filed backlog item you were asked to triage: release it with a priority, close it with a reason (naming the delivered item that already fixed it, if any), or merge it into another open item. Call it exactly once; it is your result.', triageParameters, () => 'the judgement', true)];
  return role === 'approver' ? [decide] : role === 'producer' ? [evidence] : [decide, evidence];
}

// ---- The doctor's command allowlist (GY-711) ----------------------------------------------------
/**
 * The master subcommands the doctor's operator-agent identity may run: the sanctioned intents and
 * two-party requests, never `merge`, `dispatch`, an evidence submission or a lease command. A
 * command the allowlist refuses is recorded in the doctor's report, never run.
 */
export const doctorSanctionedCommands = ['scope', 'requirements', 'unblock', 'decide', 'approver', 'settle-containment', 'close', 'create', 'release'] as const;
/** The master subcommands and root commands that only read. */
export const doctorReadOnlyCommands = ['status', 'decisions', 'context', 'guide', 'board'] as const;
/**
 * The read-only programs a doctor may consult, each with the options that would make it write, run
 * another program or reach past the checkout, refused by name (`sort -o`, `rg --pre`). GNU accepts
 * unique prefixes of its long options (`sort --out=leaked.txt` for `--output`), so `sort` refuses
 * every long option those options' first letters name — `--output`, `--compress-program`,
 * `--temporary-directory`, and `--check`, whose o/c/t space they share — and every short-option
 * cluster carrying the same letters (`-ro`, `-ofile`, `-T dir`).
 */
const doctorReadPrograms = new Map<string, RegExp | null>([
  ['cat', null], ['ls', null], ['head', null], ['tail', null], ['grep', null], ['wc', null], ['jq', null], ['diff', null], ['stat', null],
  ['rg', /^--pre(?:=|-glob|$)/], ['sort', /^(?:-[^-]*[oT]|--[oct][a-z-]*(?:=.*)?)/],
]);
/** Options git's read subcommands take that write a file or run a configured program. */
const gitWriting = /^(?:--output|--ext-diff|--textconv|--open-files-in-pager|-O$)/;
/** `git branch` options that only list; a positional is a pattern only once one of the listing options is present. */
const gitBranchListing = /^(?:-a|-r|-l|-v|-vv|--all|--remotes|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=.*|--format=.*|--color(?:=.*)?|--no-color|--column(?:=.*)?|--no-column|--verbose|--abbrev=.*|--omit-empty)$/;
const gitReads = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'blame', 'describe', 'shortlog', 'ls-files', 'branch', 'worktree']);
/** The provider CLI's read subcommands, under the groups a doctor reads. */
/** The environment variables that point gh at another repository or host without a word on the command line. */
export const doctorGhOverrides = ['GH_REPO', 'GH_HOST'] as const;
const ghReads = new Map([['pr', new Set(['view', 'list', 'checks', 'diff'])], ['run', new Set(['view', 'list'])], ['issue', new Set(['view', 'list'])]]);
/** The CLI programs a Graphyard command may be invoked through; the words after it are the CLI's own. */
const doctorCliPrograms = new Set(['graphyard']);

export interface DoctorGuardContext { cwd: string; home?: string; /** The Graphyard CLI the loop names in the prompt; `node` may run only this script. */ cli?: string; /** The environment gh would run with; process.env when absent. */ env?: NodeJS.ProcessEnv }

/**
 * Whether the raw command line redirects: a `<` or `>` outside quotes. A doctor reads; it never
 * writes a file, and a redirection is how a read would (`cat x > y`), so any is refused.
 */
export function doctorRedirects(line: string) {
  let quote: '"' | '\'' | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote === '\'') { if (char === '\'') quote = null; continue; }
    if (char === '\\') { index++; continue; }
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === '\'' || char === '"') quote = char;
    else if (char === '<' || char === '>') return true;
  }
  return false;
}

/**
 * Whether one shell segment is within the doctor role's allowlist (GY-711). The segment must name
 * its program first — no assignment (`NODE_OPTIONS=…`), wrapper (`sudo`, `env`, `timeout`) or
 * expansion (`$GRAPHYARD_TOKEN_FILE`, `$(…)`) whose value cannot be checked before it runs.
 * `graphyard` and `node <the Graphyard CLI>` are judged by their command word: the sanctioned
 * subcommands, the read-only ones, and nothing else — `master merge`, `master dispatch`, an
 * evidence submission and a lease command are refused by name. `node` runs the Graphyard CLI
 * script and nothing else: no option (`-e`, `--require`) and no other script. The read-only
 * programs and git's and gh's read subcommands run with every path they name inside the checkout,
 * so the operator-agent credential, which is kept outside every checkout, is never read — and the
 * local secret files that resolve inside the checkout (`.env`, `.graphyard/credentials.json`) are
 * refused by name, because the checkout boundary is not a read boundary for them.
 */
export function doctorSegmentAllowed(words: ShellWord[], context: DoctorGuardContext = { cwd: process.cwd(), cli: process.env.GRAPHYARD_DOCTOR_CLI }): GuardVerdict {
  const { index, wrapped } = commandIndex(words);
  const program = words[index]?.value.split('/').pop() ?? '';
  if (index !== 0 || wrapped) return { allow: false, reason: doctorRefusal(`a command run through an assignment or ${words[index - 1]?.value ?? 'a wrapper'}`) };
  // A word the shell would expand — variable, substitution or pathname glob — cannot be checked
  // before it runs: `cat {README.md,/etc/passwd}` is a glob, and its matches are read verbatim.
  const expanded = words.find(word => word.dynamic || word.glob);
  if (expanded) return { allow: false, reason: doctorRefusal(`the expansion "${expanded.value}", whose value or matches cannot be checked before it runs,`) };
  // The program by its bare name, found on PATH: never a script of the same name in the checkout.
  if (words[0].value !== program) return { allow: false, reason: doctorRefusal(`${words[0].value} (run programs by their bare name)`) };
  const rest = words.slice(1);
  if (doctorCliPrograms.has(program)) return doctorCommandWords(rest.map(word => word.value));
  if (program === 'node') {
    // node runs only the Graphyard CLI script, with no options or variable expansion
    if (rest.length < 1 || rest[0].value.startsWith('-') || rest[0].dynamic) return { allow: false, reason: doctorRefusal('node (node runs only the Graphyard CLI script, with no options or expansions)') };
    if (!doctorCliScript(rest[0].value, context)) return { allow: false, reason: doctorRefusal(`node ${rest[0].value} (node runs only the Graphyard CLI script)`) };
    return doctorCommandWords(rest.slice(1).map(word => word.value));
  }
  const reads = doctorReadPrograms.get(program);
  let allowed = reads !== undefined && !rest.some(word => reads?.test(word.value));
  if (program === 'git') allowed = gitRead(rest.map(word => word.value));
  if (program === 'gh') {
    // gh reads the repository this checkout serves only: a `-R`/`--repo` flag or its prefix, any
    // URL — any scheme, any host, any letter case (`https://GitHub.com/…`, `git://…`, an enterprise
    // host) — an scp-style `git@host:path` or `host.tld:path`, or any `github.`-containing word
    // names a repository another way, so all are refused rather than resolved against the checkout.
    const override = rest.find(word => {
      const value = word.value;
      return value.startsWith('-R') || value.startsWith('--rep') || value.includes('://')
        || /^git@/i.test(value) || /github\./i.test(value) || /^[\w.-]*\w\.[\w.-]+:\w/.test(value);
    });
    if (override) return { allow: false, reason: doctorRefusal(`gh ${override.value} (gh reads the repository this checkout serves; no repository override)`) };
    // An ambient GH_REPO or GH_HOST selects another repository with no word on the line; the
    // extension clears both for the doctor, and gh is refused should either still be set.
    const ambient = doctorGhOverrides.find(name => (context.env ?? process.env)[name]);
    if (ambient) return { allow: false, reason: doctorRefusal(`gh while ${ambient} is set (gh reads the repository this checkout serves; no repository override)`) };
    // -w/--web opens a browser under the coordinator's account: a headless doctor reads, never launches.
    const web = rest.find(word => word.value.startsWith('--web') || /^-[a-zA-Z]*w/.test(word.value));
    if (web) return { allow: false, reason: doctorRefusal(`gh ${web.value} (the doctor reads headless; no browser launch)`) };
    allowed = ghReads.get(rest[0]?.value ?? '')?.has(rest[1]?.value ?? '') ?? false;
  }
  if (!allowed) return { allow: false, reason: doctorRefusal(`${program}${rest[0] ? ` ${rest[0].value}` : ''}`) };
  const recursive = doctorRecursiveReads.get(program);
  if (recursive) {
    const rec = rest.find(word => recursive.test(word.value));
    if (rec) return { allow: false, reason: doctorRefusal(`a recursive read with ${rec.value}`) };
  }
  const secret = rest.find(word => doctorSecretFile(word.value, context));
  if (secret) return { allow: false, reason: doctorRefusal(`reading ${secret.value}, a local secret file the checkout boundary does not cover,`) };
  const outside = rest.find(word => doctorPathOutside(word.value, context));
  return outside ? { allow: false, reason: doctorRefusal(`reading ${outside.value}, a path outside the checkout ${context.cwd},`) } : { allow: true };
}
function gitRead(args: string[]) {
  const [subcommand, ...rest] = args;
  if (!gitReads.has(subcommand ?? '') || rest.some(arg => gitWriting.test(arg))) return false;
  if (subcommand === 'worktree') {
    // Only `git worktree list` is safe; `add` and `remove` write and can erase worktrees
    return (rest.length === 1 && rest[0] === 'list') || (rest[0] === 'list' && rest.slice(1).every(arg => ['--porcelain', '-v', '--verbose', '-z'].includes(arg)));
  }
  if (subcommand === 'branch') {
    // Only listing options are safe; `-D`, `-d`, `-m`, `-c` are destructive
    const options = rest.filter(arg => arg.startsWith('-'));
    if (!options.every(arg => gitBranchListing.test(arg))) return false;
    // Allow only if all args are listing options, or at least one listing option makes it a list command
    return rest.length === options.length || options.some(arg => /^(?:-a|-r|-l|--all|--remotes|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(arg));
  }
  return true;
}
/** Whether `script` is the Graphyard CLI the loop named, or, when it named none, a `graphyard.mjs` launcher. */
function doctorCliScript(script: string, context: DoctorGuardContext) {
  const physicalOf = (path: string) => { try { return realpathSync(resolve(context.cwd, path)); } catch { return resolve(context.cwd, path); } };
  return context.cli ? physicalOf(script) === physicalOf(context.cli) : basename(script) === 'graphyard.mjs';
}
/** Whether a word names a path outside the checkout: absolute, home-relative, `..`, or a link that resolves out. `--opt=PATH` is judged by its PATH. */
function doctorPathOutside(value: string, context: DoctorGuardContext) {
  const path = value.startsWith('-') ? value.includes('=') ? value.slice(value.indexOf('=') + 1) : '' : path_without_flag(value);
  if (!path) return false;
  const root = physical(resolve(context.cwd), true);
  const within = (candidate: string) => candidate === root || inside(candidate, root);
  if (path.startsWith('~')) return !within(physical(resolve(path.replace(/^~/, context.home ?? homedir())), true));
  // A revision range or pathspec a git read names (`HEAD..main`, `:/src`) is not a file.
  const absolute = path.startsWith('/'), parent = path.split('/').includes('..');
  if (!absolute && !parent) {
    try { statSync(resolve(context.cwd, path)); } catch { return false; }
  }
  return !within(physical(resolve(context.cwd, path), true));
}
function path_without_flag(value: string) { return value.startsWith('-') ? '' : value; }
const doctorRecursiveReads = new Map<string, RegExp>([
  ['grep', /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--(?:recursive|dereference-recursive)(?:=.*)?)$/],
  ['ls', /^(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive(?:=.*)?)$/],
  ['diff', /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive(?:=.*)?)$/],
]);
/**
 * Whether a word names a local secret file, wherever it sits: an environment file, Graphyard's
 * installation credentials, App keys, tokens, package-registry auth files, a git directory (its
 * config can hold a credential), or the classic credential files a clone can carry.
 * These resolve inside the checkout, so the checkout boundary is not a read boundary for them;
 * naming one is refused whether or not the file exists, because probing a secret path is itself
 * information. A git revision path (`HEAD:.env`) and an option's path (`--ignore-file=.env`) are
 * judged by their path.
 */
const doctorSecretBasenames = new Set(['.git-credentials', '.netrc', '.npmrc', '.pypirc', '.yarnrc.yml', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
function doctorSecretFile(value: string, context?: DoctorGuardContext) {
  const cwd = context?.cwd ?? process.cwd();
  for (const part of value.split(':')) {
    const rawPath = part.startsWith('-') ? part.includes('=') ? part.slice(part.indexOf('=') + 1) : '' : part;
    if (!rawPath) continue;
    const path = isAbsolute(rawPath) ? relative(cwd, resolve(cwd, rawPath)) : rawPath;
    const base = path.split('/').pop() ?? '';
    if (/^\.env(?:\.|$)/.test(base)) return true;
    if (base.endsWith('.pem') || base.endsWith('.token')) return true;
    if (doctorSecretBasenames.has(base)) return true;
    if (path === '.graphyard' || path.startsWith('.graphyard/') || /(?:^|\/)\.(?:graphyard|config\/graphyard)(?:\/|$)/.test(path)) return true;
    // A git directory's config can carry a credential (an extraheader, a tokenised remote URL).
    if (path === '.git' || path.startsWith('.git/') || /(?:^|\/)\.git(?:\/|$)/.test(path)) return true;
    if (path !== '.' && path !== './' && !path.startsWith('..')) {
      try {
        const full = resolve(cwd, path);
        if (existsSync(full) && statSync(full).isDirectory()) {
          if (existsSync(join(full, '.graphyard')) || existsSync(join(full, '.env'))) return true;
          const entries = readdirSync(full, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.endsWith('.pem') || entry.name.endsWith('.token') || /^\.env(?:\.|$)/.test(entry.name) || doctorSecretBasenames.has(entry.name)) return true;
            if (entry.isDirectory() && entry.name === '.graphyard') return true;
          }
        }
      } catch {}
    }
  }
  return false;
}
function doctorCommandWords(words: string[]): GuardVerdict {
  const command = words.find(word => !word.startsWith('-') && word !== 'master');
  const isMaster = words[0] === 'master';
  const name = isMaster ? words[1] : command;
  if (isMaster && doctorSanctionedCommands.includes(name as never)) return { allow: true };
  if (command === 'evidence') return { allow: false, reason: doctorRefusal('graphyard evidence') };
  if (doctorReadOnlyCommands.includes(name as never)) return { allow: true };
  return { allow: false, reason: doctorRefusal(name ? `graphyard ${isMaster ? 'master ' : ''}${name}` : 'that command') };
}
/** The refusal a command outside the doctor's allowlist gets: recorded, never run. */
const doctorRefusal = (what: string) => `Graphyard refused this command for the doctor role: ${what} is outside the doctor's command allowlist, so it was not run. The doctor's sanctioned commands are master ${doctorSanctionedCommands.join(', master ')}; everything else it may do is read-only. Record the refused command in your graphyard_doctor_report instead of retrying it.`;

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

/**
 * GNU mktemp's options, parsed as mktemp parses them (GY-564): whether it creates a directory,
 * whether it creates anything at all, and the directory a `-p`/`--tmpdir` names. An option it does
 * not take, or more than one template, is `null` — a line nobody can say mktemp made.
 */
export function mktempOptions(words: string[]): { directory: boolean; dryRun: boolean; parent: string | null } | null {
  let directory = false, dryRun = false, parent: string | null = null, templates = 0, options = true;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (options && word === '--') { options = false; continue; }
    if (options && word.startsWith('--')) {
      const [name, value] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, null];
      if (name === '--directory') directory = true;
      else if (name === '--dry-run') dryRun = true;
      else if (name === '--quiet') { /* no effect on what is created */ }
      else if (name === '--tmpdir') parent = value;
      else if (name === '--suffix') { if (value === null) index++; }
      else return null;
      continue;
    }
    if (options && word.startsWith('-') && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const flag = word[at];
        if (flag === 'd') directory = true;
        else if (flag === 'u') dryRun = true;
        else if (flag === 'q' || flag === 't') { /* quiet; template under the temporary root */ }
        else if (flag === 'p') { parent = word.slice(at + 1) || words[++index] || null; if (parent === null) return null; break; }
        else return null;
      }
      continue;
    }
    if (++templates > 1) return null;
  }
  return { directory, dryRun, parent };
}

/**
 * The directory a `mktemp -d` call printed. Only a command that is nothing but that one mktemp
 * invocation counts, and only its single line of output (GY-391): a line a second command printed
 * beside it (`mktemp -d && ls -d /tmp/*`) is not a directory the session created. The line is kept
 * only when it is a real directory under the temporary root and, when `-p`/`--tmpdir` names a
 * parent, under that parent — a `--tmpdir` template may carry slashes and mktemp creates only its
 * final component, so an existing parent can hold it at any depth (GY-564).
 */
export function mktempDirectories(command: string, output: string, root = tmpdir()): string[] {
  const segments = shellWords(command);
  if (segments.length !== 1) return [];
  const [program, ...words] = segments[0];
  if (program.dynamic || program.value.split('/').pop() !== 'mktemp' || words.some(word => word.dynamic || word.glob)) return [];
  const options = mktempOptions(words.map(word => word.value));
  if (!options?.directory || options.dryRun) return [];
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return [];
  const [line] = lines, base = resolve(root);
  if (!isAbsolute(line) || !inside(resolve(line), base) || resolve(line).split(sep).includes('..')) return [];
  if (options.parent && (!isAbsolute(options.parent) || !inside(resolve(line), resolve(options.parent)))) return [];
  try { return statSync(line).isDirectory() ? [line] : []; } catch { return []; }
}

/** The tool name the doctor's session submits its report through; the one non-bash tool it holds. */
export const doctorReportToolName = 'graphyard_doctor_report';

/** The refusal a tool outside the doctor's surface gets: recorded, never run. */
const doctorToolRefusal = (what: string) => `Graphyard refused this tool for the doctor role: ${what} is outside the doctor's tool surface, so it was not run. The doctor runs bash under its command allowlist and its ${doctorReportToolName} tool; every other tool — read, edit, write, any built-in — is refused. Record the refused call in your graphyard_doctor_report instead of retrying it.`;

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
  // The doctor's bash children inherit this process's environment: an ambient repository or host
  // selection is cleared so gh reads the repository the checkout serves (GY-711).
  if (process.env.GRAPHYARD_PI_ROLE === 'doctor') for (const name of doctorGhOverrides) delete process.env[name];
  pi.on('tool_call', (event, ctx) => {
    const tool = String(event?.toolName ?? '');
    // The doctor role holds every tool, not only bash (GY-711): no built-in read, edit or write
    // may bypass the checkout boundary or the sanctioned commands, so every tool but bash and the
    // doctor's own report tool is refused before anything runs.
    if (process.env.GRAPHYARD_PI_ROLE === 'doctor' && tool !== 'bash' && tool !== doctorReportToolName)
      return { block: true, reason: doctorToolRefusal(tool || 'an unnamed tool') };
    if (tool !== 'bash') return undefined;
    const command = String(event.input?.command ?? '');
    const context = { cwd: ctx?.cwd ?? process.cwd(), sessionDirectories };
    // The doctor role is judged by its command allowlist (GY-711) before the destructive-command
    // guard: a command outside it is blocked with the reason to record, never run.
    if (process.env.GRAPHYARD_PI_ROLE === 'doctor') {
      if (doctorRedirects(command)) return { block: true, reason: doctorRefusal('a redirection (< or >)') };
      for (const words of shellWords(command)) {
        const verdict = doctorSegmentAllowed(words, { cwd: context.cwd, cli: process.env.GRAPHYARD_DOCTOR_CLI });
        if (!verdict.allow) return { block: true, reason: verdict.reason };
      }
    }
    const verdict = guardCommand(command, context);
    return verdict.allow ? undefined : { block: true, reason: verdict.reason };
  });
  pi.on('tool_result', event => {
    if (event?.toolName !== 'bash' || event?.isError) return undefined;
    for (const directory of mktempDirectories(String(event.input?.command ?? ''), outputText(event))) sessionDirectories.add(directory);
    return undefined;
  });
}
