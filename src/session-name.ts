import { createHash } from 'node:crypto';
import { z } from 'zod';

// ---- Session names a runtime will accept ----------------------------------------------------
/*
 * Herdr names a session with at most 32 characters, starting with a lowercase letter and using
 * only lowercase letters, digits, '-' and '_'. Every name Graphyard generates — worker, reviewer,
 * producer, approver, master, escalation handler — is a name it will hand to that runtime, so it
 * is built inside those bounds and checked where it is constructed rather than discovered at the
 * launch, after a pane has been allocated (GY-101). `sessionName` composes one: the parts, joined
 * and slugified, while they fit, and otherwise as much of them as the limit leaves plus a digest
 * of the whole identity, so a name that has to be shortened still names one thing only.
 */
export const sessionNameLimit = 32, sessionNameDigestLength = 8;
export const sessionNameRule = `a session name must start with a lowercase letter, use only lowercase letters, digits, '-' or '_', and be 1-${sessionNameLimit} characters`;
/** Why a runtime would refuse this name, or null when it will accept it. */
export function sessionNameRefusal(name: string): string | null {
  if (!name.length) return 'it is empty';
  if (name.length > sessionNameLimit) return `it is ${name.length} characters, past the ${sessionNameLimit}-character limit`;
  if (!/^[a-z]/.test(name)) return `it starts with ${JSON.stringify(name[0])} rather than a lowercase letter`;
  const refused = [...new Set([...name].filter(character => !/[a-z0-9_-]/.test(character)))];
  return refused.length ? `it contains ${refused.map(character => JSON.stringify(character)).join(', ')}` : null;
}
/** A launch refused for its name, reported as that: the limit, the name attempted, and how to retry. */
export class SessionNameRefusedError extends Error {
  constructor(readonly sessionName: string, readonly reason: string, readonly retry: string | null) {
    super(`No session can be launched as ${JSON.stringify(sessionName)}: ${reason}. ${sessionNameRule[0].toUpperCase()}${sessionNameRule.slice(1)}${retry ? `. Retry with ${retry} once the name is within it` : ''}`);
    this.name = 'SessionNameRefusedError';
  }
}
export function assertSessionName(name: string, retry?: string | null) {
  const refusal = sessionNameRefusal(name);
  if (refusal) throw new SessionNameRefusedError(name, refusal, retry ?? null);
  return name;
}
/**
 * A name for one session of one role on one item, inside the same bounds. What a human reads first
 * — the role, then the work key — is kept whole, and the rest of the limit goes to what tells this
 * session from the next of that role on that item: the decision id, the escalation trigger. The
 * role word is what gives way when the limit is tight, in the order the caller writes it, because
 * a name whose key has been cut short says less than an abbreviated role does; only when even the
 * shortest role word leaves too little to tell two sessions apart does the whole identity go
 * through `sessionName`, which shortens the key and carries a digest of everything.
 */
export const sessionNameDistinguisher = 4, sessionNameDistinguisherLimit = 8;
export function distinctSessionName(prefixes: readonly [string, ...string[]], subject: string, distinguisher: string) {
  for (const prefix of prefixes) {
    const head = sessionName(prefix, subject);
    const room = Math.min(sessionNameLimit - head.length - 1, sessionNameDistinguisherLimit);
    const tail = distinguisher.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, Math.max(0, room));
    if (tail.length >= sessionNameDistinguisher) return assertSessionName(`${head}-${tail}`);
  }
  return sessionName(prefixes.at(-1)!, subject, distinguisher);
}
/** The name one launch will use, refused with the command that retries that launch once it is fixed. */
export function nameForLaunch(retry: string, build: () => string) {
  try { return assertSessionName(build(), retry); }
  catch (error) { throw error instanceof SessionNameRefusedError ? new SessionNameRefusedError(error.sessionName, error.reason, retry) : error; }
}
/**
 * One launchable name for one identity. Distinct identities never share a name: the parts are kept
 * whole while they fit, and a name the limit forces to be shortened carries a digest of the full
 * identity instead of its tail, so two decisions on one item are two sessions however long the
 * work key and decision id are.
 */
export function sessionName(...parts: readonly string[]) {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const joined = parts.map(slug).filter(Boolean).join('-');
  const full = /^[a-z]/.test(joined) ? joined : `gy-${joined}`;
  if (full.length <= sessionNameLimit) return assertSessionName(full);
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, sessionNameDigestLength);
  return assertSessionName(`${full.slice(0, sessionNameLimit - sessionNameDigestLength - 1).replace(/-+$/, '')}-${digest}`);
}
/** The Herdr name of a configured profile's session, refused here rather than at its launch. */
export const sessionNameField = z.string().trim().min(1).max(100).superRefine((name, context) => {
  const refusal = sessionNameRefusal(name);
  if (refusal) context.addIssue({ code: 'custom', message: `Herdr cannot launch a session named ${JSON.stringify(name)}: ${refusal}. ${sessionNameRule[0].toUpperCase()}${sessionNameRule.slice(1)}` });
});
/**
 * A name for one of several sessions that differ only by a short, fixed tail — the runtime and the
 * ordinal of a worker profile, say. Here the tail is what a human picks one session out by and the
 * subject is the context they share, so the tail is kept whole and the subject gives way to it:
 * `claude-1` and `codex-2` stay readable however long the repository they are named for is. A
 * subject the limit shortens carries a digest of the whole identity, so two repositories whose
 * names begin alike are still two names; one that leaves no room at all goes through `sessionName`.
 */
export function suffixedSessionName(subject: string, ...suffix: readonly [string, ...string[]]) {
  const tail = sessionName(...suffix), head = sessionName(subject);
  if (head.length + tail.length + 1 <= sessionNameLimit) return assertSessionName(`${head}-${tail}`);
  const digest = createHash('sha256').update([subject, ...suffix].join('\u0000')).digest('hex').slice(0, sessionNameDigestLength);
  const shortened = head.slice(0, Math.max(0, sessionNameLimit - tail.length - sessionNameDigestLength - 2)).replace(/-+$/, '');
  return /^[a-z]/.test(shortened) ? assertSessionName(`${shortened}-${digest}-${tail}`) : sessionName(subject, ...suffix);
}
