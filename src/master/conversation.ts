// Native master conversations and their full, read-only handoff records. No summaries.
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

export const conversationSchema = z.object({
  launch: z.string(), runtime: z.string(), account: z.string().nullable(), nativeId: z.string(),
  transcript: z.string(), record: z.string(), origins: z.string(),
  predecessor: z.string().nullable(), supersededBy: z.string().nullable().default(null),
}).strict();
export type Conversation = z.infer<typeof conversationSchema>;
export const continuitySchema = z.object({ current: conversationSchema, predecessor: conversationSchema.nullable() }).strict();
export type Continuity = z.infer<typeof continuitySchema>;
export const masterRecords = (root: string) => resolve(root, '.graphyard/master-records');
export const masterInputs = (root: string, launch: string) => resolve(root, '.graphyard/launch', `${launch}.inputs.jsonl`);

/** Supported native formats, rather than silently launching a master that cannot continue. */
export function assertConversationRuntime(kind: string) {
  if (kind !== 'claude' && kind !== 'codex') throw new Error(`Master conversation continuity is unsupported for runtime ${kind}; supported master runtimes are claude and codex. The previous conversation is retained; configure the master role with a supported runtime.`);
}
export const conversationArgs = (kind: string, nativeId: string | null, resume: boolean) =>
  kind === 'claude' ? [resume ? '--resume' : '--session-id', nativeId!] : resume ? ['resume', nativeId!] : [];

/** Persist before submission, including each delivery retry. The marker joins origin to native input. */
export async function graphyardInput(origins: string, origin: 'launch' | 'wake' | 'retry', text: string) {
  const id = randomUUID(), marker = `[Graphyard input ${id}; origin=${origin}]`;
  await mkdir(dirname(origins), { recursive: true, mode: 0o700 });
  await appendFile(origins, JSON.stringify({ id, origin, marker, text }) + '\n', { mode: 0o600 });
  return `${marker}\n${text}`;
}
const jsonLines = (text: string): any[] => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
export interface ConversationEvent { id: string; type: 'input' | 'final'; text?: string }
/** Tool results and partial output never become inputs or completed response turns. */
export function conversationEvents(kind: string, transcript: string): ConversationEvent[] {
  assertConversationRuntime(kind);
  return jsonLines(transcript).flatMap((row, index): ConversationEvent[] => {
    const id = row.uuid ?? row.id ?? String(index);
    if (kind === 'claude') {
      if (row.type === 'user' && !row.isMeta && !row.isCompactSummary && !row.isSidechain) {
        const content = row.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
        return text ? [{ id, type: 'input', text }] : [];
      }
      if (row.type === 'assistant' && !row.isSidechain && ['end_turn', 'stop_sequence'].includes(row.message?.stop_reason)) return [{ id, type: 'final' }];
    } else if (row.type === 'event_msg') {
      if (row.payload?.type === 'user_message') return [{ id, type: 'input', text: row.payload.message }];
      const item = row.payload?.item;
      if (row.payload?.type === 'item_completed' && item?.type === 'UserMessage') {
        const text = item.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
        return [{ id: item.id ?? id, type: 'input', text }];
      }
      if (row.payload?.type === 'task_complete') return [{ id, type: 'final' }];
    }
    return [];
  });
}

/** Copy exactly the native transcript; associate recorded automated inputs by native event id. */
export async function captureConversation(conversation: Conversation) {
  const transcript = await readFile(conversation.transcript, 'utf8');
  const origins = jsonLines(await readFile(conversation.origins, 'utf8').catch(() => ''));
  const automated = new Set<string>();
  const events = conversationEvents(conversation.runtime, transcript);
  for (const event of events) if (event.type === 'input') {
    if (origins.some(origin => origin.event === event.id && origin.origin)) automated.add(event.id);
    const origin = origins.find(origin => origin.marker && event.text?.includes(`${origin.marker}\n${origin.text}`));
    if (origin) {
      automated.add(event.id);
      if (!origins.some(row => row.input === origin.id && row.event === event.id)) {
        const association = { input: origin.id, event: event.id };
        origins.push(association);
        await appendFile(conversation.origins, JSON.stringify(association) + '\n');
      }
    }
  }
  let unanswered: string | null = null;
  for (const event of events) {
    if (event.type === 'final') unanswered = null;
    else if (!automated.has(event.id)) unanswered = event.text ?? null;
  }
  await mkdir(dirname(conversation.record), { recursive: true, mode: 0o700 });
  await chmod(conversation.record, 0o600).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(conversation.record, transcript, { mode: 0o400 });
  await chmod(conversation.record, 0o400);
  return unanswered;
}

export async function conversationHandover(previous: Conversation) {
  const unanswered = await captureConversation(previous);
  return `Continue the authoritative master conversation from runtime ${previous.runtime}, account ${previous.account ?? 'default'}, native session ${previous.nativeId}, launch ${previous.launch}. Read its full read-only transcript at ${previous.record} on demand.\nLast unanswered person message: ${unanswered === null ? 'none' : JSON.stringify(unanswered)}`;
}

/** Claude names its id before launch; Codex writes session_meta with its native id and cwd. */
export async function discoverConversation(kind: string, environment: Record<string, string>, root: string, since: number, nativeId: string | null): Promise<{ nativeId: string; transcript: string } | null> {
  assertConversationRuntime(kind);
  if (kind === 'claude') {
    const home = environment.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const folder = join(home, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
    if (nativeId) {
      const transcript = join(folder, `${nativeId}.jsonl`);
      try { await readFile(transcript); return { nativeId, transcript }; } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
    }
    const files = await readdir(folder).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
    const candidates = await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(async file => ({ file, modified: (await stat(join(folder, file))).mtimeMs })));
    const latest = candidates.filter(file => file.modified >= since).sort((a, b) => b.modified - a.modified)[0];
    return latest ? { nativeId: latest.file.slice(0, -6), transcript: join(folder, latest.file) } : null;
  }
  const home = environment.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
  };
  for (const transcript of (await walk(join(home, 'sessions'))).sort().reverse()) {
    if (!transcript.endsWith('.jsonl')) continue;
    if (nativeId && !transcript.endsWith(`${nativeId}.jsonl`)) continue;
    if (!nativeId && (await stat(transcript)).mtimeMs < since) continue;
    const row = jsonLines(await readFile(transcript, 'utf8')).find(row => row.type === 'session_meta');
    if (row?.payload?.cwd === root && (nativeId ? row.payload.id === nativeId : Date.parse(row.payload.timestamp ?? row.timestamp) >= since)) return { nativeId: row.payload.id, transcript };
  }
  return null;
}

/** Initialize a pre-upgrade/adopted pane from its account's native record and known deliveries. */
export async function adoptConversation(root: string, input: { runtime: string; account: string | null; environment: Record<string, string>; since: number; prompts: { origin: 'launch' | 'wake'; text: string }[] }) : Promise<Continuity> {
  const found = await discoverConversation(input.runtime, input.environment, root, input.since, null);
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

export async function awaitConversation(kind: string, environment: Record<string, string>, root: string, since: number, nativeId: string | null, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  do {
    const found = await discoverConversation(kind, environment, root, since, nativeId);
    if (found) return found;
    if (Date.now() >= until) break;
    await sleep(100);
  } while (true);
  throw new Error(`The ${kind} master did not record native conversation ${nativeId ?? 'identity'}; the previous authoritative conversation is retained, without a fresh fallback`);
}
