import { z } from 'zod';
import type { Work } from './work.js';

/**
 * Durable session handles.
 *
 * A launched agent session is otherwise invisible to everyone but the process that launched it:
 * its pane identifier lives in that launcher's local ledger, and watching a specific agent means
 * asking a master to relay it. A handle puts the same facts on the item, where Graphyard's own
 * readers already look — what runtime and host it runs on, the workspace, tab and pane it occupies
 * there, the transcript it writes, and the one command or link that attaches to it.
 *
 * The coordinates are the runtime's own, and so is the attach command: the control plane records
 * what the launcher tells it and never names a multiplexer of its own. The handle is a record of a
 * runtime fact, not authority: it never decides a gate, never grants a lease, and a session that
 * ends keeps its handle so its transcript stays reachable.
 */

export const sessionKinds = ['implementation', 'review', 'proof', 'coordination'] as const;
export type SessionKind = typeof sessionKinds[number];
export const sessionStates = ['running', 'finished'] as const;
export type SessionState = typeof sessionStates[number];

export interface SessionHandle {
  /** Stable per session: the dispatch request id, or `principal:epoch` for an assignment. */
  id: string; kind: SessionKind;
  principal: string;
  /** The attempt epoch the session works under, when it holds one. */
  epoch: number | null;
  runtime: string; host: string;
  /** The runtime's own coordinates, when it is a multiplexer that has them. */
  workspace: string | null; tab: string | null; pane: string | null;
  /** The command or link the launcher says attaches to this session while it runs. */
  attach: string | null;
  /** Where the session writes its transcript, so a finished session is still readable. */
  transcript: string | null;
  /** What it is working on, in one line. */
  subject: string;
  startedAt: string; updatedAt: string; endedAt: string | null;
  state: SessionState; outcome: string | null;
}

const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
export const sessionHandleSchema = z.object({
  id: line(120), kind: z.enum(sessionKinds),
  epoch: z.number().int().positive().optional(),
  runtime: line(80), host: line(200),
  workspace: line(120).optional(), tab: line(120).optional(), pane: line(120).optional(),
  attach: z.string().trim().min(1).max(500).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  transcript: z.string().trim().min(1).max(1000).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  subject: z.string().trim().min(1).max(300),
  state: z.enum(sessionStates).default('running'),
  outcome: z.string().trim().min(1).max(500).optional(),
}).strict();
export type SessionHandleInput = z.infer<typeof sessionHandleSchema>;

export const sessionHandleLimit = 40;

/**
 * The command or link that attaches to this session: the one its launcher recorded while it runs,
 * and otherwise — for a session that has finished, or one whose runtime offers nothing to attach
 * to — its transcript. A handle with neither says so rather than offering something that cannot work.
 */
export function attachCommand(handle: Pick<SessionHandle, 'state' | 'attach' | 'transcript' | 'host'>): string {
  if (handle.state === 'running' && handle.attach) return handle.attach;
  if (handle.transcript) return `${handle.host}:${handle.transcript}`;
  return 'no attach command and no transcript were recorded for this session';
}

/** Record or update one handle on the item, newest last, bounded. */
export function recordSession(work: Work, input: SessionHandleInput, principal: string, now: Date): SessionHandle {
  work.sessions ??= [];
  const at = now.toISOString();
  const existing = work.sessions.find(handle => handle.id === input.id);
  const handle: SessionHandle = {
    id: input.id, kind: input.kind, principal: existing?.principal ?? principal,
    epoch: input.epoch ?? existing?.epoch ?? null,
    runtime: input.runtime, host: input.host,
    workspace: input.workspace ?? existing?.workspace ?? null, tab: input.tab ?? existing?.tab ?? null, pane: input.pane ?? existing?.pane ?? null,
    attach: input.attach ?? existing?.attach ?? null,
    transcript: input.transcript ?? existing?.transcript ?? null,
    subject: input.subject,
    startedAt: existing?.startedAt ?? at, updatedAt: at,
    endedAt: input.state === 'finished' ? existing?.endedAt ?? at : null,
    // A running session may carry an outcome too — "waiting on input" is a fact about a session
    // that has not ended — so the note is kept rather than dropped for want of an end.
    state: input.state, outcome: input.outcome ?? existing?.outcome ?? null,
  };
  work.sessions = [...work.sessions.filter(entry => entry.id !== input.id), handle].slice(-sessionHandleLimit);
  return handle;
}

/** One line per session for a reader: what it is, what it works on, and how to watch or read it. */
export function sessionSummary(work: Work, now: Date) {
  return (work.sessions ?? []).map(handle => ({
    ...handle, key: work.key, attach: attachCommand(handle),
    runningMs: handle.state === 'running' ? Math.max(0, now.getTime() - Date.parse(handle.startedAt)) : Math.max(0, Date.parse(handle.endedAt ?? handle.updatedAt) - Date.parse(handle.startedAt)),
  }));
}

/** Every running session across the graph, longest-running first. */
export function runningSessions(all: Work[], now: Date) {
  return all.flatMap(work => sessionSummary(work, now).filter(handle => handle.state === 'running'))
    .sort((a, b) => b.runningMs - a.runningMs);
}
