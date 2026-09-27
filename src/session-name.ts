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
  const full = unshortenedName(parts);
  if (full.length <= sessionNameLimit) return assertSessionName(full);
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, sessionNameDigestLength);
  return assertSessionName(`${shortenedHead(full)}-${digest}`);
}
/** The parts joined and slugified, before the limit is applied. */
function unshortenedName(parts: readonly string[]) {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const joined = parts.map(slug).filter(Boolean).join('-');
  return /^[a-z]/.test(joined) ? joined : `gy-${joined}`;
}
/** What a name the limit shortens keeps of the whole, ahead of its digest. */
const shortenedHead = (full: string) => full.slice(0, sessionNameLimit - sessionNameDigestLength - 1).replace(/-+$/, '');
/**
 * Whether `name` is one `distinctSessionName([prefix], subject, id)` builds for some hexadecimal id
 * — a decision's UUID. The tail is checked, not just the head: a configured session that merely
 * starts with the head, `graphyard-approver-gy-5-worker`, is not one (its tail is not an id
 * fragment). A subject too long to leave room for a fragment builds the digested fallback, which
 * starts with as much of the prefix and subject as the limit keeps; that shortened head is all a
 * name without its id can be recognised by, so two subjects that agree on it both claim the name.
 */
function isDistinctSessionName(prefix: string, subject: string, name: string) {
  const head = sessionName(prefix, subject);
  const room = Math.min(sessionNameLimit - head.length - 1, sessionNameDistinguisherLimit);
  if (room >= sessionNameDistinguisher) {
    const tail = name.startsWith(`${head}-`) ? name.slice(head.length + 1) : '';
    return tail.length >= sessionNameDistinguisher && tail.length <= room && /^[0-9a-f]+$/.test(tail);
  }
  const shortened = shortenedHead(unshortenedName([prefix, subject]));
  return name.length === shortened.length + 1 + sessionNameDigestLength && name.startsWith(`${shortened}-`) && /^[0-9a-f]+$/.test(name.slice(shortened.length + 1));
}

// ---- Approver session names ------------------------------------------------------------------
/*
 * One session name per decision, not per item. An item takes several decisions in its life — rework
 * after a verdict, rework after a base conflict, a merge approval — and an approver stops when it
 * has judged, leaving its tab listed. Named per item, that finished tab refused the launch of the
 * next decision's approver until somebody closed it by hand.
 *
 * Per decision and inside the runtime's limit, both (GY-101): the fixed prefix and an eight-
 * character decision fragment left four characters for the key, so every key from GY-10 up built a
 * 33-character name no runtime would take and no approver could be launched at all. The key is
 * kept whole now and the decision id takes what the limit leaves.
 *
 * Two decisions whose fragments match are one session: the second launch is refused as already
 * visible, or adopted as the first decision's approver. So the full role word is kept only while it
 * leaves at least `approverDistinguisher` characters of the decision id (one collision in ~16
 * million per pair, against one in 65,536 at the four the generic floor accepts); past that the
 * role word gives way to `gy-approver`, which affords the full eight for any key up to GY-12345678.
 */
export const approverDistinguisher = 6;
const approverPrefix = (key: string) => sessionNameLimit - sessionName('graphyard-approver', key).length - 1 >= approverDistinguisher ? 'graphyard-approver' : 'gy-approver';
export const approverSessionName = (work: { key: string }, decision: string) => distinctSessionName([approverPrefix(work.key)], work.key, decision);
/**
 * Whether `name` is an approver session `approverSessionName` builds for `key` and some decision:
 * how a session nothing recorded — launched by hand, or its watch retired — is known by its name,
 * judged by the same rule the launcher names it with (GY-441).
 */
export const isApproverSessionName = (key: string, name: string) => isDistinctSessionName(approverPrefix(key), key, name);
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
