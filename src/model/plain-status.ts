import { deliveryState, type Gate, type Work } from '../model.js';
import type { PipelineTimeline } from '../pipeline-speed.js';
import { assignment } from './assignment.js';
import { formatAge, statusDuration, type StatusDuration } from './duration.js';

/**
 * Plain-English status for people who have never read the Graphyard docs. Every sentence is
 * derived from the first refusing gate (the same order the control plane evaluates), so the
 * dashboard never says anything the gates do not. Internal vocabulary stays out of this copy;
 * `jargon` lists the words a test keeps out of every generated sentence.
 */
export const jargon = ['epoch', 'lease', 'candidate', 'policy revision', 'producer', 'attestation', 'trusted evidence'] as const;

/** Where an item is, in the order work moves. Delivered work is `shipped`. */
export const phases = ['not-started', 'needs-worker', 'building', 'review', 'checks', 'proof', 'merging', 'shipped'] as const;
export type Phase = typeof phases[number];
export const phaseLabel: Record<Phase, string> = {
  'not-started': 'Not started', 'needs-worker': 'Needs a worker', building: 'Being built', review: 'In review',
  checks: 'Automated checks', proof: 'Proving it works', merging: 'Merging', shipped: 'Shipped',
};
export type Tone = 'stuck' | 'waiting' | 'working' | 'shipped';
export interface PlainStatus { sentence: string; tone: Tone; phase: Phase; who: string | null; blocking: string | null }

const trigger: Record<string, string> = {
  'lease-loss': 'the builder lost contact', 'evidence-policy-conflict': 'a proof breaks the rules',
  'security-concern': 'a security concern', 'requirement-weakening': 'a request to weaken the requirements',
};
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/**
 * One gate reason in plain words. `stuck` marks reasons that will not clear on their own:
 * somebody has to decide or fix something. A reason nobody anticipated falls back to a
 * sentence about its gate, never to the raw internal text.
 */
export function plainReason(reason: string, gate: string): { text: string; stuck: boolean; known: boolean } {
  const rules: [RegExp, (m: RegExpMatchArray) => string, boolean?][] = [
    [/^Not released from backlog$/, () => 'Not released for work yet'],
    [/^Dependency (\S+) is unfinished$/, m => `Waiting for ${m[1]} to ship first`],
    [/^Worker has not submitted implementation for this attempt$/, () => 'The work has not been handed in yet'],
    [/^Pull request has not been independently observed$/, () => 'Graphyard has not seen the pull request on GitHub yet'],
    [/^No workspace registered$/, () => 'The builder has not said where the code lives yet'],
    [/^Candidate diff has not been compared/, () => 'Graphyard is checking which files the pull request changes'],
    [/^Candidate changes (\d+) files? outside/, m => `The pull request changes ${m[1]} file${m[1] === '1' ? '' : 's'} it was not planned to touch`, true],
    [/^Out-of-scope regression: ([^:\s]+)/, m => `${m[1]} was changed but is outside the plan`, true],
    [/^Verified clean Codex review/, () => 'Waiting for the Codex reviewer to approve the latest code'],
    [/^Every configured reviewer profile is exhausted/, () => 'No reviewer is available — more reviewers are needed', true],
    [/^Verified approval from reviewer profile (\S+) is required/, m => `Waiting for reviewer ${m[1]} to approve the latest code`],
    [/^A new independent GitHub approval after the requirement-review baseline/, () => 'Waiting for a fresh approval on GitHub, because the requirements changed'],
    [/^Independent approval of the current commit is required$/, () => 'Waiting for someone else to approve the latest code'],
    [/^Outstanding change requests must be resolved/, () => 'A reviewer asked for changes'],
    [/^Required CI check (.+) has not passed on the current candidate$/, m => `Automated check “${m[1]}” has not passed yet`],
    [/^(AC-\d+): (\S+) needs trusted passing evidence[^;]*(; previously accepted evidence was revoked)?/, m => `${m[1]} is not proven yet (${m[2]})${m[3] ? ' — an earlier proof was withdrawn' : ''}`],
    [/^Bootstrap obligation inherited from (\S+) (\S+): (\S+) needs/, m => `Owes the proof ${m[3]} that ${m[1]} put off`],
    [/^Trusted (\S+) evidence from (\S+) is no longer independent/, m => `The ${m[1]} proof no longer counts: ${m[2]} later worked on this item`, true],
    [/^GitHub observation missing or older than two minutes$/, () => 'Graphyard is re-checking GitHub'],
    [/^Required Graphyard check and merge-queue branch protection/, () => 'GitHub merge protection is not confirmed yet', true],
    [/^Pull request is not mergeable against the current base$/, () => 'The pull request conflicts with the main branch', true],
    [/^Unresolved (\S+) escalation requires operator resolution: (.*)$/s, m => `Needs a decision about ${trigger[m[1]] ?? 'a problem'}: ${m[2]}`, true],
    [/^Slice lead (\S+) ruled \S+ under rule \S+; delivery is blocked until the authorized recovery: (.*)$/s, m => `Held by team lead ${m[1]}: ${m[2]}`, true],
    [/^Merge queue position (\d+) of (\d+): (\S+) is ahead$/, m => `${ordinal(Number(m[1]))} in line to merge, after ${m[3]}`],
    [/^Speculative tip on predicted base/, () => 'Being re-tested together with the changes merging ahead of it'],
    [/^Waiting for (\S+) to publish its speculative tip$/, m => `Waiting for ${m[1]} to be re-tested first`],
  ];
  for (const [pattern, text, stuck] of rules) { const m = reason.match(pattern); if (m) return { text: text(m), stuck: !!stuck, known: true }; }
  // The ready gate's only free-text reason is a recorded blocker: a person wrote it, so it is shown as written.
  if (gate === 'ready') return { text: reason, stuck: true, known: true };
  const fallback: Record<string, string> = { build: 'The work is not finished yet', review: 'Waiting for review', test: 'Waiting for automated checks', acceptance: 'Waiting for proof that it works', merge: 'Waiting to merge' };
  return { text: fallback[gate] ?? 'Waiting', stuck: false, known: false };
}

/**
 * The step a stalled action is, in the words of somebody who has never read the docs. Every action
 * kind has one, so a kind nobody thought about still reads as a step rather than as its own name.
 */
const stepWords: Record<string, string> = {
  dispatch: 'handing it to a builder', 'request-review': 'asking for a review',
  'request-rework': 'sending it back for changes', 'approve-scope': 'deciding which files it may touch',
  resync: 're-reading it from GitHub', reclaim: 'freeing it from its last builder', merge: 'merging it',
  'verify-deployment': 'checking the deployment that carries it', escalate: 'getting somebody to decide it',
};

/**
 * The item's stalled step, when one of its actions keeps failing for the same reason.
 *
 * An action that fails is retried, and a retried action is invisible: the item sits at its gate
 * looking like it is waiting for somebody, while something tries the same impossible step over and
 * over. The control plane classifies that on the row itself (`actionStall`), and this is the card's
 * reading of it — the step, how many times it has failed for one unchanged reason, and how long it
 * has been trying. The reason itself stays out: it is written for an operator reading
 * `master status`, in vocabulary this page keeps out of its copy.
 */
export function stalledStep(work: Work, now: number): string | null {
  const stalled = (work.actionQueue?.actions ?? []).flatMap(row => row.stall ? [{ row, stall: row.stall }] : []);
  if (!stalled.length) return null;
  const worst = stalled.sort((a, b) => Date.parse(a.stall.since) - Date.parse(b.stall.since))[0];
  const step = stepWords[worst.row.kind] ?? 'the next step';
  return `${step} has failed ${worst.stall.failures} times for the same reason, since ${formatAge(worst.stall.since, now)} ago`;
}

/** The builder's name, never a machine identifier when a display name exists. */
function builder(work: Work, now: number) {
  const a = assignment(work, now);
  const identity = work.lastAssignment?.owner === a.owner && work.lastAssignment?.epoch === a.epoch ? work.lastAssignment : undefined;
  const name = identity?.displayName ?? a.owner;
  return { active: a.active, name: name ?? null };
}

/** Where the item is: nobody working on it is never "being built", whatever the stored stage says. */
export function phaseOf(work: Work, now: number): Phase {
  if (work.stage === 'done') return 'shipped';
  if (!work.ready || work.stage === 'backlog') return 'not-started';
  const handedIn = !!work.submission && !work.reworkRequested;
  if (!handedIn) return builder(work, now).active ? 'building' : 'needs-worker';
  const first = work.gates.find(g => !g.passed)?.name;
  return first === 'test' ? 'checks' : first === 'acceptance' ? 'proof' : first === 'merge' || !first ? 'merging' : 'review';
}

/** Lower-cases a leading common word so a reason reads mid-sentence; names stay capitalized. */
const lowerFirst = (text: string) => /^(Graphyard|GitHub|Codex|AC-|GY-)/.test(text) ? text : text[0].toLowerCase() + text.slice(1);
const pr = (work: Work) => work.candidate ? `PR #${work.candidate.pr}` : work.submission ? `PR #${work.submission.pr}` : null;

/** One sentence: what is happening, what happens next, and who is on it. */
export function plainStatus(work: Work, now: number): PlainStatus {
  const phase = phaseOf(work, now);
  const who = builder(work, now);
  const link = pr(work);
  const make = (sentence: string, tone: Tone, blocking: string | null = null, person: string | null = null): PlainStatus => ({ sentence, tone, phase, who: person, blocking });
  // Closed without delivery (src/model/closure.ts): terminal, never "shipped".
  if (work.closure) return make(`Closed as ${work.closure.kind}${work.closure.ref ? ` (${work.closure.ref})` : ''}: ${work.closure.reason}`, 'shipped');
  if (phase === 'shipped') {
    const state = deliveryState(work);
    const merged = link ? `Shipped in ${link}` : 'Shipped';
    if (state === 'delivered-with-failure') return make(`${merged} — the check after deploying failed`, 'stuck', 'The check after deploying failed');
    if (state === 'awaiting-deployment') return make(`${merged} — waiting to be deployed`, 'waiting', 'Waiting to be deployed');
    if (state === 'awaiting-smoke') return make(`${merged} — deployed, waiting for the check after deploying`, 'waiting', 'Waiting for the check after deploying');
    return make(merged, 'shipped');
  }
  if (work.violations.length) return make(`Stuck: ${work.violations[0]}`, 'stuck', work.violations[0]);
  const gate = work.gates.find(g => !g.passed);
  const reasons = (g: Gate | undefined) => (g?.reasons ?? []).map(r => ({ raw: r, ...plainReason(r, g!.name) }));
  const ready = work.gates.find(g => g.name === 'ready');
  const blocker = work.blocker ?? null;
  if (blocker) return make(`Stuck: ${blocker}`, 'stuck', blocker, who.active ? who.name : null);
  // A step that keeps failing for the same reason is a stall, not a retry, and it outranks the
  // gate it was going to clear: the gate's own sentence would say the item is waiting for a
  // review or a builder, when in truth something is asking for one every minute and being
  // refused. Nothing here moves until somebody clears what the reason names.
  const stalled = stalledStep(work, now);
  if (stalled) return make(`Stuck: ${stalled}`, 'stuck', stalled, who.active ? who.name : null);
  if (phase === 'not-started') {
    const dependency = reasons(ready).find(r => r.raw.startsWith('Dependency '));
    return dependency && work.ready ? make(dependency.text, 'waiting', dependency.text) : make('Not started — waiting to be released for work', 'waiting', 'Not released for work yet');
  }
  if (phase === 'needs-worker') {
    const dependency = reasons(ready).find(r => r.raw.startsWith('Dependency '));
    if (dependency) return make(dependency.text, 'waiting', dependency.text);
    if (work.reworkRequested) return make('Sent back for changes — waiting for someone to pick it up', 'waiting', 'Nobody is working on it');
    return make(who.name ? `Waiting for someone to pick this up — ${who.name} stopped working on it` : 'Waiting for someone to pick this up', 'waiting', 'Nobody is working on it');
  }
  if (phase === 'building') return make(`${who.name} is building it — ${link ? `${link} is open` : 'no pull request yet'}`, 'working', null, who.name);
  const first = reasons(gate);
  const stuck = first.find(r => r.stuck);
  if (stuck) return make(`Stuck: ${lowerFirst(stuck.text)}`, 'stuck', stuck.text);
  const next = first[0]?.text ?? null;
  const on = link ? ` ${link}` : '';
  switch (gate?.name) {
    case 'build': return make(`Handed in — ${next ? lowerFirst(next) : 'being checked'}`, 'waiting', next);
    case 'review': return make(first.some(r => r.raw.startsWith('Outstanding change requests')) ? `A reviewer asked for changes on${on || ' it'}` : `Waiting for review of${on || ' the work'}`, 'waiting', next);
    case 'test': return make(`Waiting for automated checks on${on || ' the work'}`, 'waiting', next);
    case 'acceptance': {
      const total = work.criteria.filter(c => !c.bootstrap).flatMap(c => c.proofs).length;
      const open = first.filter(r => /^AC-\d+:/.test(r.raw)).length;
      // Criteria are listed once in the item view, so the blocking line names the proof, not the criterion.
      const proof = first[0]?.raw.match(/^AC-\d+: (\S+) needs/)?.[1];
      return make(total ? `Waiting for proof that it works — ${total - open} of ${total} proofs passed` : 'Waiting for proof that it works', 'waiting', proof ? `The proof ${proof} has not passed yet` : next);
    }
    case 'merge': return make(first.some(r => r.raw.startsWith('Merge queue position')) ? `Queued to merge — ${next!.replace(/ to merge,/, ',')}` : `Ready to merge${on} — ${next ? lowerFirst(next) : 'waiting its turn'}`, 'waiting', next);
    default: return make(`Ready to merge${on}`, 'waiting', null);
  }
}

/** The phases an item is in once it has been handed in: the card names review, not building. */
const handedInPhases: Phase[] = ['review', 'checks', 'proof', 'merging'];

/**
 * The instant the item entered the status its card names, from the control plane's own record.
 *
 * `stageEnteredAt` is the spine: the engine rewrites it when, and only when, the evaluated stage
 * changes, so an observation, a heartbeat or a failed retry of the same action leaves it alone
 * and a stalled item cannot appear fresh. Three moves the stage does not see get their own
 * instant, because the card's sentence does see them. Handing the work in, which the build gate
 * keeps in the build stage until GitHub is observed. A claim, which after a send-back leaves the
 * stage at build (the old submission still stands) while the card turns from waiting for a
 * builder to being built. And an attempt ending — a claim running out, work sent back — which
 * reads as nobody working on it before, or without, the next evaluation writing a new stage.
 * The latest instant wins, and one in the future — a clock that disagrees — is ignored rather
 * than trusted.
 */
export function statusSince(work: Work, now: number): string {
  const phase = phaseOf(work, now);
  const pipeline = (work as Work & { pipeline?: PipelineTimeline }).pipeline;
  const attempts = pipeline?.attempts ?? [];
  const moves: (string | undefined | null)[] = [work.stageEnteredAt];
  if (handedInPhases.includes(phase)) moves.push(pipeline?.resubmittedAt ?? pipeline?.submittedAt);
  if (phase === 'building' && work.lease) {
    // The claim that opened the attempt being built, never an earlier attempt's.
    moves.push(attempts.find(attempt => attempt.epoch === work.lease!.epoch)?.claimedAt);
    if (work.lastAssignment?.epoch === work.lease.epoch) moves.push(work.lastAssignment.claimedAt);
  }
  if (phase === 'needs-worker') {
    if (work.lease && Date.parse(work.lease.expiresAt) <= now) moves.push(work.lease.expiresAt);
    // The last attempt's end: submitted, sent back, released or lapsed, the builder left then.
    moves.push(attempts.at(-1)?.endedAt);
    // Work sent back after it was handed in cannot have been waiting since before the hand-in.
    if (work.reworkRequested) moves.push(pipeline?.resubmittedAt ?? pipeline?.submittedAt);
  }
  const instants = moves.map(at => at ? Date.parse(at) : Number.NaN).filter(at => Number.isFinite(at) && at <= now);
  return instants.length ? new Date(Math.max(...instants)).toISOString() : work.stageEnteredAt;
}

/**
 * How long this item has held the status its card names, and whether that is past the one
 * configured threshold. Every view — the list, the board, the item view — draws from this call,
 * so the number and the verdict cannot differ between two places that show the same item.
 */
export function statusHeld(work: Work, now: number): StatusDuration {
  return statusDuration(statusSince(work, now), now, phaseOf(work, now) === 'shipped');
}

/** Stuck items first, then the oldest in its phase; the order people should look at them. */
export function byAttention(items: Work[], now: number) {
  const rank = (w: Work) => plainStatus(w, now).tone === 'stuck' ? 0 : 1;
  return [...items].sort((a, b) => rank(a) - rank(b) || a.stageEnteredAt.localeCompare(b.stageEnteredAt));
}
