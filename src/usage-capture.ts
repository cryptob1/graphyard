// Concern: collecting what each session's runtime reported of its tokens (GY-3289), on the loop's
// host. A headless review notes its run's report beside the run; a worker run's report stays in its
// run log; the master's is its runtime's own transcript. The loop reports them all to the control
// plane, where each row replaces itself, so nothing here needs to remember what it sent.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runtimeReport, transcriptUsage, type UsageRow } from './model/token-costs.js';
import { fleetRequest, type FleetConfig } from './fleet.js';
import { readWorkerRecord, runLogTail, workerRunsDirectory } from './headless-session.js';
import { runFiles } from './runner/pi.js';
import { listRunDirectories, runsDirectory } from './runner/registry.js';
import type { Conversation } from './master/conversation.js';

const outbox = (root: string) => resolve(root, '.graphyard', 'usage-outbox');
type Session = Pick<UsageRow, 'id' | 'work' | 'role' | 'account' | 'runtime' | 'at'>;

/** A run's rows: its tokens by model, or one 'not reported' row for a runtime that printed no usage. */
export function usageRows(session: Session, output: string): UsageRow[] {
  const usage = runtimeReport(output).usage;
  if (!usage) return [{ ...session, model: null, reported: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }];
  return usage.map(({ model, tokens }) => ({ ...session, id: `${session.id}:${model ?? ''}`, model, reported: true, ...tokens }));
}

/** Notes one ended run's usage for the loop's next report: called where the run's output is at hand, before its directory is removed. */
export function noteRunUsage(root: string, session: Session, output: string) {
  try {
    mkdirSync(outbox(root), { recursive: true, mode: 0o700 });
    writeFileSync(join(outbox(root), `${session.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify(usageRows(session, output)), { mode: 0o600 });
  } catch { /* a full disk loses one run's figures, never the run */ }
}

const reportedMarker = 'usage-reported';
/** The ended worker runs not yet reported, each with the marker its report leaves. */
function workerUsage(root: string): { rows: UsageRow[]; done: () => void }[] {
  let names: string[];
  try { names = readdirSync(workerRunsDirectory(root)); } catch { return []; }
  return names.flatMap(name => {
    const directory = join(workerRunsDirectory(root), name), marker = join(directory, reportedMarker), exit = runFiles(directory).exit;
    if (existsSync(marker) || !existsSync(exit)) return [];
    const record = readWorkerRecord(directory);
    if (!record) return [];
    const rows = usageRows({ id: record.id, work: record.work, role: 'worker', account: record.account, runtime: record.kind, at: statSync(exit).mtime.toISOString() }, runLogTail(root, record.id, 512 * 1024) ?? '');
    return [{ rows, done: () => writeFileSync(marker, '') }];
  });
}

/** The ended producer runs not yet reported: the run registry keeps each a day, with its runtime's own JSON records. */
function producerUsage(root: string): { rows: UsageRow[]; done: () => void }[] {
  return listRunDirectories(runsDirectory(root)).flatMap(({ directory, owner, record }) => {
    const marker = join(directory, reportedMarker);
    if (!record || owner.role !== 'producer' || existsSync(marker)) return [];
    let output = '';
    try { output = readFileSync(runFiles(directory).stdout, 'utf8'); } catch { /* a run that printed nothing reported nothing */ }
    const account = typeof owner.context.account === 'string' ? owner.context.account : null;
    return [{ rows: usageRows({ id: directory.split('/').pop()!, work: owner.work, role: 'producer', account, runtime: record.runtime, at: record.endedAt ?? record.startedAt }, output), done: () => writeFileSync(marker, '') }];
  });
}

/** The master transcripts read so far: how far, what they held, and what was last reported of each day. */
const transcripts = new Map<string, { offset: number; pending: string; decoder: StringDecoder; usage: ReturnType<typeof transcriptUsage>; sent: Map<string, string> }>();
/** The master session's rows that changed since the last report: its transcript is read on from where the last read stopped. */
function masterUsage(conversation: Conversation): { rows: UsageRow[]; done: () => void }[] {
  const state = transcripts.get(conversation.transcript) ?? { offset: 0, pending: '', decoder: new StringDecoder('utf8'), usage: transcriptUsage(conversation.runtime), sent: new Map<string, string>() };
  transcripts.set(conversation.transcript, state);
  let fd: number;
  try { fd = openSync(conversation.transcript, 'r'); } catch { return []; }
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (let read = readSync(fd, buffer, 0, buffer.length, state.offset); read > 0; read = readSync(fd, buffer, 0, buffer.length, state.offset)) {
      state.offset += read;
      const lines = (state.pending + state.decoder.write(buffer.subarray(0, read))).split('\n');
      state.pending = lines.pop()!;
      for (const line of lines) { try { state.usage.read(JSON.parse(line)); } catch { /* a partial row */ } }
    }
  } finally { closeSync(fd); }
  const changed = [...state.usage.days()].flatMap(([key, day]) => {
    const row: UsageRow = { id: `master:${conversation.nativeId}:${key}`, work: null, role: 'master', account: conversation.account, runtime: conversation.runtime, model: day.model, reported: true, at: day.at, ...day.tokens };
    return state.sent.get(key) === JSON.stringify(row) ? [] : [{ key, row }];
  });
  return changed.length ? [{ rows: changed.map(entry => entry.row), done: () => { for (const { key, row } of changed) state.sent.set(key, JSON.stringify(row)); } }] : [];
}

let lastCollected = 0;
/** Reports are made at most this often: the loop's cycle is much shorter than anyone reads costs. */
export const usageReportMs = 60_000;
/**
 * Reports every session's usage this host holds and has not reported: noted review runs, ended
 * worker and producer runs and the master transcript's growth. A batch the control plane did not take is kept
 * and reported again next time.
 */
export async function collectUsage(root: string, config: Required<Pick<FleetConfig, 'url'>> & Pick<FleetConfig, 'credentialFile'>, master: Conversation | null, options: { now?: number; fetch?: typeof fetch } = {}) {
  const now = options.now ?? Date.now();
  if (now - lastCollected < usageReportMs) return;
  lastCollected = now;
  let noted: string[] = [];
  try { noted = readdirSync(outbox(root)); } catch { /* nothing noted yet */ }
  const batches = [
    ...noted.flatMap(name => { const file = join(outbox(root), name); try { return [{ rows: JSON.parse(readFileSync(file, 'utf8')) as UsageRow[], done: () => rmSync(file, { force: true }) }]; } catch { rmSync(file, { force: true }); return []; } }),
    ...workerUsage(root), ...producerUsage(root), ...(master ? masterUsage(master) : []),
  ];
  for (let index = 0; index < batches.length; index += 50) {
    const batch = batches.slice(index, index + 50);
    await fleetRequest(config, 'usage', { body: { rows: batch.flatMap(entry => entry.rows) }, fetch: options.fetch });
    for (const entry of batch) entry.done();
  }
}
