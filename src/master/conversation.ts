// Native master conversations and their full, read-only handoff records. No summaries.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

const inputReferenceSchema = z.object({ record: z.string(), runtime: z.string(), event: z.string() }).strict();
type InputReference = z.infer<typeof inputReferenceSchema>;
export const conversationSchema = z.object({
  launch: z.string(), runtime: z.string(), account: z.string().nullable(), nativeId: z.string(),
  transcript: z.string(), record: z.string(), origins: z.string(),
  predecessor: z.string().nullable(), supersededBy: z.string().nullable().default(null),
  /** The original person input a successor's first response owes; only a native-event pointer. */
  inherited: inputReferenceSchema.extend({ delivery: z.string() }).strict().nullable().optional(),
}).strict();
export type Conversation = z.infer<typeof conversationSchema>;
export const continuitySchema = z.object({ current: conversationSchema, predecessor: conversationSchema.nullable() }).strict();
export type Continuity = z.infer<typeof continuitySchema>;
export const masterRecords = (root: string) => resolve(root, '.graphyard/master-records');
export const masterInputs = (root: string, launch: string) => resolve(root, '.graphyard/launch', `${launch}.inputs.jsonl`);

/** Supported native formats, rather than silently launching a master that cannot continue. */
export function assertConversationRuntime(kind: string): asserts kind is 'claude' | 'codex' {
  if (kind !== 'claude' && kind !== 'codex') throw new Error(`Master conversation continuity is unsupported for runtime ${kind}; supported master runtimes are claude and codex. The previous conversation is retained; configure the master role with a supported runtime.`);
}
export function conversationArgs(kind: string, nativeId: string | null, resume: boolean) {
  assertConversationRuntime(kind);
  return kind === 'claude' ? [resume ? '--resume' : '--session-id', nativeId!] : resume ? ['resume', nativeId!] : [];
}

/** Persist before submission, including each delivery retry. The marker joins origin to native input. */
export async function graphyardInput(origins: string, origin: 'launch' | 'wake' | 'retry', text: string) {
  const id = randomUUID(), marker = `[Graphyard input ${id}; origin=${origin}]`;
  await mkdir(dirname(origins), { recursive: true, mode: 0o700 });
  await appendFile(origins, JSON.stringify({ id, origin, marker, text }) + '\n', { mode: 0o600 });
  return `${marker}\n${text}`;
}
const jsonLines = (text: string): any[] => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
export interface ConversationEvent { id: string; type: 'input' | 'final'; text?: string; turn?: string; ancestors?: string[] }
/** Tool results and partial output never become inputs or completed response turns. */
export function conversationEvents(kind: string, transcript: string): ConversationEvent[] {
  assertConversationRuntime(kind);
  let turn: string | undefined;
  let lastInput: string | undefined;
  const parents = new Map<string, string>();
  const finals = new Set<string>();
  return jsonLines(transcript).flatMap((row, index): ConversationEvent[] => {
    const id = row.uuid ?? row.id ?? String(index);
    if (kind === 'claude') {
      if (row.uuid && row.parentUuid) parents.set(row.uuid, row.parentUuid);
      if (row.isCompactSummary && row.uuid && lastInput) parents.set(row.uuid, lastInput);
      if (row.type === 'user' && !row.isMeta && !row.isCompactSummary && !row.isSidechain) {
        const content = row.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
        if (text) { lastInput = id; return [{ id, type: 'input', text }]; }
        return [];
      }
      if (row.type === 'assistant' && !row.isSidechain && ['end_turn', 'stop_sequence'].includes(row.message?.stop_reason)) {
        const ancestors = new Set<string>();
        let parent = parents.get(id);
        while (parent && !finals.has(parent) && !ancestors.has(parent)) { ancestors.add(parent); parent = parents.get(parent); }
        finals.add(id);
        return [{ id, type: 'final', ...(row.parentUuid ? { ancestors: [...ancestors] } : {}) }];
      }
    } else if (row.type === 'event_msg') {
      if (row.payload?.type === 'task_started') turn = row.payload.turn_id;
      const responseTurn = row.payload?.turn_id ?? turn;
      if (row.payload?.type === 'user_message') return [{ id, type: 'input', text: row.payload.message, turn: responseTurn }];
      const item = row.payload?.item;
      if (row.payload?.type === 'item_completed' && item?.type === 'UserMessage') {
        const text = item.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
        return [{ id: item.id ?? id, type: 'input', text, turn: responseTurn }];
      }
      if (row.payload?.type === 'task_complete') return [{ id, type: 'final', turn: responseTurn }];
    }
    return [];
  });
}

/** Copy exactly the native transcript; associate recorded automated inputs by native event id. */
async function conversationRecord(conversation: Conversation) {
  const transcript = await readFile(conversation.transcript, 'utf8');
  const origins = jsonLines(await readFile(conversation.origins, 'utf8').catch(() => ''));
  const recorded = new Map(origins.filter(origin => origin.id && origin.marker).map(origin => [origin.id, origin]));
  const associations = new Map(origins.filter(origin => origin.input && origin.event).map(origin => [origin.input, origin.event]));
  const legacyEvents = new Set(origins.filter(origin => origin.origin && origin.event).map(origin => origin.event));
  const automated = new Set<string>();
  const deliveries = new Map<string, string>();
  const events = conversationEvents(conversation.runtime, transcript);
  for (const event of events) if (event.type === 'input') {
    if (legacyEvents.has(event.id)) automated.add(event.id);
    // One recorded delivery identifies one native input. A later person quoting that delivery
    // remains person input, even when it includes the marker and the whole original request.
    for (const marker of (event.text ?? '').matchAll(/\[Graphyard input ([0-9a-f-]+); origin=(?:launch|wake|retry)\]/g)) {
      const origin = recorded.get(marker[1]);
      if (!origin || (associations.has(origin.id) && associations.get(origin.id) !== event.id)
        || !event.text?.includes(`${origin.marker}\n${origin.text}`)) continue;
      automated.add(event.id);
      deliveries.set(event.id, origin.marker);
      if (!associations.has(origin.id)) {
        const association = { input: origin.id, event: event.id };
        associations.set(origin.id, event.id);
        await appendFile(conversation.origins, JSON.stringify(association) + '\n');
      }
      break;
    }
  }
  let unanswered: (ConversationEvent & { source: InputReference })[] = [];
  const inherited = conversation.inherited;
  const inheritedEvents = inherited ? inherited.record === conversation.record && inherited.runtime === conversation.runtime ? events
    : conversationEvents(inherited.runtime, await readFile(inherited.record, 'utf8')) : [];
  const inheritedText = inherited ? inheritedEvents.find(event => event.id === inherited.event && event.type === 'input')?.text : null;
  if (inherited && inheritedText === undefined) throw new Error(`The inherited person input ${inherited.event} is missing from ${inherited.record}; retaining the current conversation`);
  for (const event of events) {
    if (event.type === 'final') {
      unanswered = unanswered.filter(input => (event.turn && input.turn && event.turn !== input.turn)
        || (event.ancestors && !event.ancestors.includes(input.id)));
    } else if (!automated.has(event.id)) unanswered.push({ ...event, source: { record: conversation.record, runtime: conversation.runtime, event: event.id } });
    else if (inherited && inheritedText !== null && deliveries.get(event.id) === inherited.delivery) {
      // A resumed session's new launch explicitly carries the pending question into this turn.
      unanswered = unanswered.filter(input => input.source.record !== inherited.record || input.source.event !== inherited.event);
      unanswered.push({ ...event, text: inheritedText, source: { record: inherited.record, runtime: inherited.runtime, event: inherited.event } });
    }
  }
  await mkdir(dirname(conversation.record), { recursive: true, mode: 0o700 });
  const staged = `${conversation.record}.${randomUUID()}`;
  await writeFile(staged, transcript, { mode: 0o400 });
  await rename(staged, conversation.record);
  const last = unanswered.at(-1);
  return { unanswered: last?.text ?? null, input: last?.source ?? null };
}

export async function captureConversation(conversation: Conversation) { return (await conversationRecord(conversation)).unanswered; }
export async function continuationContext(previous: Conversation) {
  const { unanswered, input } = await conversationRecord(previous);
  return { input, handover: `Continue the authoritative master conversation from runtime ${previous.runtime}, account ${previous.account ?? 'default'}, native session ${previous.nativeId}, launch ${previous.launch}. Read its full read-only transcript at ${previous.record} on demand.\nLast unanswered person message: ${unanswered === null ? 'none' : JSON.stringify(unanswered)}` };
}
export async function conversationHandover(previous: Conversation) { return (await continuationContext(previous)).handover; }

/** Claude names its id before launch; Codex writes session_meta with its native id and cwd. */
export async function discoverConversation(kind: string, environment: Record<string, string>, root: string, since: number, nativeId: string | null, initialInput?: string): Promise<{ nativeId: string; transcript: string } | null> {
  assertConversationRuntime(kind);
  if (kind === 'claude') {
    const home = environment.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const folder = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
    if (nativeId) {
      const transcript = join(folder, `${nativeId}.jsonl`);
      try {
        const text = await readFile(transcript, 'utf8');
        if (initialInput && !conversationEvents(kind, text).some(event => event.type === 'input' && event.text?.includes(initialInput))) return null;
        return { nativeId, transcript };
      } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    }
    const files = await readdir(folder).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
    const candidates = await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(async file => ({ file, modified: (await stat(join(folder, file))).mtimeMs })));
    const matching: { nativeId: string; transcript: string }[] = [];
    for (const candidate of candidates.filter(file => file.modified >= since).sort((a, b) => b.modified - a.modified)) {
      const transcript = join(folder, candidate.file);
      if (initialInput && !conversationEvents(kind, await readFile(transcript, 'utf8')).some(event => event.type === 'input' && event.text?.includes(initialInput))) continue;
      matching.push({ nativeId: candidate.file.slice(0, -6), transcript });
      if (initialInput) break;
    }
    if (matching.length > 1) throw new Error('Cannot identify the adopted master among multiple native conversations without a recorded launch input; retaining its state');
    return matching[0] ?? null;
  }
  const home = environment.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
  };
  const matching: { nativeId: string; transcript: string; modified: number }[] = [];
  for (const transcript of await walk(join(home, 'sessions'))) {
    if (!transcript.endsWith('.jsonl')) continue;
    if (nativeId && !transcript.endsWith(`${nativeId}.jsonl`)) continue;
    const modified = (await stat(transcript)).mtimeMs;
    if (!nativeId && modified < since) continue;
    const text = await readFile(transcript, 'utf8');
    const row = jsonLines(text).find(row => row.type === 'session_meta');
    if (typeof row?.payload?.id !== 'string' || row.payload.cwd !== root) continue;
    if (nativeId && row.payload.id !== nativeId) continue;
    if (!nativeId && Date.parse(row.payload.timestamp ?? row.timestamp) < since) continue;
    if (initialInput && !conversationEvents(kind, text).some(event => event.type === 'input' && event.text?.includes(initialInput))) continue;
    matching.push({ nativeId: row.payload.id, transcript, modified });
  }
  if (!initialInput && !nativeId && matching.length > 1) throw new Error('Cannot identify the adopted master among multiple native conversations without a recorded launch input; retaining its state');
  const latest = matching.sort((a, b) => b.modified - a.modified)[0];
  return latest ? { nativeId: latest.nativeId, transcript: latest.transcript } : null;
}

/** Initialize a pre-upgrade/adopted pane from its account's native record and known deliveries. */
export async function adoptConversation(root: string, input: { runtime: string; account: string | null; environment: Record<string, string>; prompts: { origin: 'launch' | 'wake'; text: string }[] }) : Promise<Continuity> {
  const request = input.prompts.find(prompt => prompt.origin === 'launch')?.text;
  const found = await discoverConversation(input.runtime, input.environment, root, 0, null, request);
  if (!found) throw new Error(`Cannot recover the existing ${input.runtime} master conversation on ${input.account ?? 'default'}; retaining its state instead of starting cold`);
  const launch = randomUUID(), origins = masterInputs(root, launch);
  await mkdir(dirname(origins), { recursive: true, mode: 0o700 });
  const events = conversationEvents(input.runtime, await readFile(found.transcript, 'utf8'));
  for (const event of events) for (const prompt of input.prompts) if (event.type === 'input' && event.text?.includes(prompt.text))
    await appendFile(origins, JSON.stringify({ origin: prompt.origin, event: event.id }) + '\n', { mode: 0o600 });
  const current: Conversation = { launch, runtime: input.runtime, account: input.account, ...found, origins, record: join(masterRecords(root), `${launch}.jsonl`), predecessor: null, supersededBy: null };
  await captureConversation(current);
  return { current, predecessor: null };
}

export async function awaitConversation(kind: string, environment: Record<string, string>, root: string, since: number, nativeId: string | null, timeoutMs: number, initialInput?: string) {
  const until = Date.now() + timeoutMs;
  do {
    const found = await discoverConversation(kind, environment, root, since, nativeId, initialInput);
    if (found) return found;
    if (Date.now() >= until) break;
    await sleep(100);
  } while (true);
  throw new Error(`The ${kind} master did not record native conversation ${nativeId ?? 'identity'}; the previous authoritative conversation is retained, without a fresh fallback`);
}
