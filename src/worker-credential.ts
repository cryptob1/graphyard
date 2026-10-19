// Concern: how a worker's credential failure blocks an attempt. Workers hold no push credential: the control plane is the only merge writer.
import type { Work } from './model.js';

/**
 * Whether a worker's blocker is a GitHub credential failure — a push or `gh` call refused for want
 * of a valid login — rather than anything about the item. Such an attempt is ended by the loop and
 * relaunched instead of holding its lease on the blocker (GY-999).
 * The messages git and `gh` print themselves count alone; a generic authentication refusal (an
 * HTTP 401, "Requires authentication", "Bad credentials", and ssh's "Permission denied (publickey)")
 * counts only when the blocker also names GitHub, git or `gh`, so a product's own 401 in an
 * integration test, or an ssh refusal from a deployment host (GY-1066), is an item blocker that
 * waits for its clearance like any other.
 */
const credentialFailures = [
  /could not read (Username|Password) for '?https:\/\/github\.com/i,
  /The token in \S+ is invalid/i,
  /Authentication failed for '?https:\/\/github\.com/i,
  /Invalid username or (password|token)/i,
  /You are not logged into any GitHub hosts/i,
  /To get started with GitHub CLI, please run:? +gh auth login/i,
  /Permission to \S+ denied to \S+/i,
];
const genericAuthenticationFailures = [/HTTP 401\b/i, /\bBad credentials\b/i, /Requires authentication/i, /Permission denied \(publickey\)/i];
const githubContext = /github\.com|api\.github|\bgh (?:pr|api|auth|repo|run|release)\b|\bgit (?:push|fetch|pull|clone|ls-remote)\b/i;
export const credentialFailure = (text: string | null | undefined) => !!text && (credentialFailures.some(pattern => pattern.test(text))
  || (genericAuthenticationFailures.some(pattern => pattern.test(text)) && githubContext.test(text)));

/** The loop's record of ending an attempt blocked on a credential failure (GY-999), once per epoch. */
export const credentialBlockedKey = (item: Pick<Work, 'id'>, epoch: number) => `resume:credential:${item.id}:${epoch}`;
/**
 * The marker a credential-blocked attempt's end carries in its capacity record. The retry ladder
 * (GY-885) reads it back: such an end counts as a failed attempt, so a failure a fresh mint does
 * not cure — an App permission the push needs and lacks, say — is relaunched after a backoff and
 * held at the cap for an approver's decision instead of ending and relaunching for ever.
 */
export const credentialBlockedMarker = 'credential-blocked attempt';
/** Why the attempt is ended: the blocker it reported, and that the next attempt gets a freshly minted credential. */
export function credentialBlockedReason(item: Pick<Work, 'key'>, epoch: number, blocker: string) {
  return `${credentialBlockedMarker} on epoch ${epoch}: a GitHub credential failure ("${blocker.length > 300 ? `${blocker.slice(0, 299)}…` : blocker}") lives in its session's credential rather than in the item, so the attempt ends with its committed work kept and ${item.key} is launched again`;
}
