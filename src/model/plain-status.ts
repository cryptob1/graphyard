import { observationWindowHold, type Gate, type Work } from '../model.js';
import type { PipelineTimeline } from '../pipeline-speed.js';
import { assignment } from './assignment.js';
import { ciCheckRefusalPattern, mergeWriterPushPattern, mergeWriterTrialPattern } from './gates.js';
import { formatAge, statusDuration, type StatusDuration } from './duration.js';
import { humanRequestBlocker } from './human-request.js';
import { deliveryOutcome } from './format.js';
import { isFilingRefusal } from './user-facing.js';

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
export interface PlainStatus { sentence: string; tone: Tone; phase: Phase; who: string | null; blocking: string | null
  /**
   * GY-1845: the item's outcome once it has merged — the production state from `deliveryOutcome`,
   * one of 'Merged, awaiting deployment', 'Deployed, awaiting verification', 'Production verified'
   * or 'Deployed with a failure', with the serving release when known. Never the word Done, and
   * never Merged alone, so every surface that shows it keeps merged code from reading as shipped.
   * Null before the item merges, and for work closed without delivery.
   */
  outcome: string | null }

/**
 * One gate reason in plain words. `stuck` marks reasons that will not clear on their own:
 * somebody has to decide or fix something. A reason nobody anticipated falls back to a
 * sentence about its gate, never to the raw internal text.
 */
export function plainReason(reason: string, gate: string, now = Date.now(), work?: Work): { text: string; stuck: boolean; known: boolean } {
  const rules: [RegExp, (m: RegExpMatchArray) => string, boolean?][] = [
    [/^Not released from backlog$/, () => 'Not released for work yet'],
    [/^Dependency (\S+) is unfinished$/, m => `Waiting for ${m[1]} to ship first`],
    [/^Split into child items: (\S+) is not delivered$/, m => `Split into smaller items; waiting for ${m[1]} to ship first`],
    // GY-2981: the filing rules the ready gate applies to an item an upgrade predates.
    [/^(?:a feature|a bug) item a user can see owes an end-to-end proof/, () => 'The change owes an end-to-end proof that it works; the master agent adds it to the requirements', true],
    [/ has no way to serve a head/, () => 'Its end-to-end proof needs a served head, and the repository does not say how to serve one yet', true],
    [/^Worker has not submitted implementation for this attempt$/, () => 'The work has not been handed in yet'],
    [/^Pull request has not been independently observed$/, () => 'Graphyard has not seen the pull request on GitHub yet'],
    [/^No workspace registered$/, () => 'The builder has not said where the code lives yet'],
    [/^Verified clean Codex review/, () => 'Waiting for the Codex reviewer to approve the latest code'],
    [/^Every configured reviewer profile is exhausted/, () => 'No reviewer is available — more reviewers are needed', true],
    [/^Verified approval from reviewer profile (\S+) is required/, m => `Waiting for reviewer ${m[1]} to approve the latest code`],
    [/^A new independent approval after the requirement-review baseline/, () => 'Waiting for a fresh approval, because the requirements changed'],
    [/^Independent approval of the current commit is required$/, () => 'Waiting for someone else to approve the latest code'],
    [/^Outstanding change requests must be resolved/, () => 'A reviewer asked for changes'],
    [/^Product review of the current commit is required$/, () => 'Waiting for the product review of this feature'],
    [/^Product review requested changes/, () => 'The product review asked for changes'],
    [/^human:\S+ waits for a person's pass/, () => 'Waiting for your real-world check on Needs you'],
    [/^human:\S+ failed a person's check/, () => 'A person\'s real-world check failed'],
    [/^Product review rejected/, () => 'The product review rejected this feature; it will not merge', true],
    [ciCheckRefusalPattern, m => `Automated check “${m[1]}” has not passed yet${m[2] ? `; rerun: ${m[2]}` : ''}`],
    [/^(AC-\d+): (\S+) needs trusted passing evidence[^;]*(; previously accepted evidence was revoked)?/, m => `${m[1]} is not proven yet (${m[2]})${m[3] ? ' — an earlier proof was withdrawn' : ''}`],
    [/^Bootstrap obligation inherited from (\S+) (\S+): (\S+) needs/, m => `Owes the proof ${m[3]} that ${m[1]} put off`],
    [/^Trusted (\S+) evidence from (\S+) is no longer independent/, m => `The ${m[1]} proof no longer counts: ${m[2]} later worked on this item`, true],
    [/^The merge writer has not observed the current candidate$/, () => 'Graphyard is re-reading the latest code'],
    [mergeWriterTrialPattern, () => 'Waiting for Graphyard to build and test the merge'],
    [mergeWriterPushPattern, () => 'Waiting for Graphyard to merge it'],
    [/^Required Graphyard check and merge-queue branch protection/, () => 'GitHub merge protection is not confirmed yet', true],
    [/^Pull request is not mergeable against the current base$/, () => 'The pull request conflicts with the main branch', true],
    [/^Slice lead (\S+) ruled \S+ under rule \S+; delivery is blocked until the authorized recovery: (.*)$/s, m => `Held by team lead ${m[1]}: ${m[2]}`, true],
  ];
  for (const [pattern, text, stuck] of rules) { const m = reason.match(pattern); if (m) return { text: text(m), stuck: !!stuck, known: true }; }
  // Every other ready reason has its rule above, so what is left is a recorded blocker, written for the next agent: it
  // reads as its one-sentence summary, and the item page's technical details show it as written.
  // Given the item, the summary reads its window the way the row's own sentence does.
  if (gate === 'ready') return { text: blockerSummary(reason, now, work).sentence, stuck: true, known: true };
  const fallback: Record<string, string> = { build: 'The work is not finished yet', review: 'Waiting for review', test: 'Waiting for automated checks', acceptance: 'Waiting for proof that it works', merge: 'Waiting to merge' };
  return { text: fallback[gate] ?? 'Waiting', stuck: false, known: false };
}

/**
 * A recorded blocker as one plain sentence of at most 25 words (GY-1739): the kind of block and who
 * clears it. The recorded text is written for the next agent — commands, file paths, SHAs — so it
 * never reaches a Work page row; the item page shows it once, under Technical details. A blocker
 * naming a future not-before instant waits for that instant: nothing is broken, yet the block stays
 * recorded until the master agent lifts it (`master unblock`), so the sentence names that clearer.
 */
export type BlockerKind = 'waiting-until' | 'human' | 'item' | 'fault';
const instant = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;
const notBeforeWords = /not[- ]before|until|window|first exist|can(?:not|'t)? (?:yet )?exist|earliest|too early|wait/i;
const itemWait = /\b(?:[Ww]ait(?:s|ing)?\s+(?:on|for)|[Dd]epends\s+on|[Bb]locked\s+(?:on|by)|[Uu]ntil|[Aa]fter)\s+(?:\w+\s+){0,2}?((?!AC-)[A-Z][A-Z0-9]*-\d+)\b/;
/**
 * The not-before instants a reason names: only an instant its own clause introduces with a wait word
 * (`not before X`, `window opens … X`), never every timestamp in the text — a recorded retry or
 * observation time is not the deadline. A reason naming several reads as its latest.
 */
export function notBeforeInstants(text: string): number[] {
  let from = 0;
  return [...text.matchAll(instant)].flatMap(m => {
    // The words since the previous instant and the last clause break, at most 48 characters back.
    const clause = text.slice(Math.max(from, m.index! - 48), m.index).split(/[;,!?]|\.\s/).pop()!;
    from = m.index! + m[0].length;
    return notBeforeWords.test(clause) ? [Date.parse(m[0])] : [];
  });
}
/**
 * A date and time with its zone, so the words identify the instant wherever they are read: the
 * browser writes it in the reader's own zone; a server answer (`GET /api/board`) passes `UTC`.
 */
export const localInstant = (at: number, timeZone?: string) => new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) });
export function blockerSummary(text: string, now: number, work?: Pick<Work, 'key' | 'blocker' | 'humanRequest' | 'observationWindow'>, timeZone?: string): { sentence: string; kind: BlockerKind; until?: string } {
  const human = !!work?.humanRequest && !work.humanRequest.answer;
  const named = (pattern: RegExp) => text.match(pattern)?.[1];
  // A declined answer is the human's last word: what happens next is the master's unblock.
  if (!human && /^A human declined /.test(text)) return { sentence: 'A human declined the request; the master agent decides the next step and clears the block.', kind: 'human' };
  if (human || text.startsWith(humanRequestBlocker)) { const on = named(/\b((?!AC-)[A-Z][A-Z0-9]*-\d+)\b/); return { sentence: `Waiting on a human answer${on && on !== work?.key ? ` to ${on}` : ''}; only you can clear it.`, kind: 'human' }; }
  const window = work ? observationWindowHold(work as Work, new Date(now)) : null;
  const future = [...notBeforeInstants(text), ...(window ? [Date.parse(window.notBefore)] : [])].filter(at => at > now);
  if (future.length) { const until = Math.max(...future); return { sentence: `Waiting until ${localInstant(until, timeZone)}; nothing is broken, and the master agent lifts the hold once that time passes.`, kind: 'waiting-until', until: new Date(until).toISOString() }; }
  const other = named(itemWait);
  if (other && other !== work?.key) return { sentence: `Waiting on ${other}; the master agent clears it once that item is done.`, kind: 'item' };
  // Anything else is summarised, never echoed: even a short reason is the agent's words, kept for the item page.
  return { sentence: 'A fault blocks it; the master agent clears it.', kind: 'fault' };
}

/**
 * The step a stalled action is, in the words of somebody who has never read the docs. Every action
 * kind has one, so a kind nobody thought about still reads as a step rather than as its own name.
 */
const stepWords: Record<string, string> = {
  dispatch: 'handing it to a builder', 'request-review': 'asking for a review',
  'request-rework': 'sending it back for changes',
  resync: 're-reading it from GitHub', reclaim: 'freeing it from its last builder', merge: 'merging it',
  attention: 'getting somebody to decide it',
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
  // GY-1845: a done item's headline is its production state (`deliveryOutcome`), so every reader of
  // a plain status sees how far past the merge the item has carried, never a bare Done or Merged.
  const outcome = !work.closure && phase === 'shipped' ? deliveryOutcome(work) : null;
  const make = (sentence: string, tone: Tone, blocking: string | null = null, person: string | null = null): PlainStatus => ({ sentence, tone, phase, who: person, blocking, outcome });
  // Closed without delivery (src/model/closure.ts): terminal, never "shipped".
  if (work.closure) return make(`Closed as ${work.closure.kind}${work.closure.ref ? ` (${work.closure.ref})` : ''}: ${work.closure.reason}`, 'shipped');
  if (phase === 'shipped') {
    return make(link ? `Shipped in ${link}` : 'Shipped', 'shipped');
  }
  if (work.violations.length) return make(`Stuck: ${work.violations[0]}`, 'stuck', work.violations[0]);
  const gate = work.gates.find(g => !g.passed);
  const reasons = (g: Gate | undefined) => (g?.reasons ?? []).map(r => ({ raw: r, ...plainReason(r, g!.name, now, work) }));
  const ready = work.gates.find(g => g.name === 'ready');
  const blocker = work.blocker ?? null;
  if (blocker) { const summary = blockerSummary(blocker, now, work).sentence; return make(`Stuck: ${summary}`, 'stuck', summary, who.active ? who.name : null); }
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
    // GY-2981: a filing refusal holds the item from every worker, so it is stuck on its filing — never waiting for one.
    const filing = reasons(ready).find(r => isFilingRefusal(r.raw));
    if (filing) return make(`Stuck: ${lowerFirst(filing.text)}`, 'stuck', filing.text);
    // GY-1698: a follow-up waiting for its observation window is not waiting for a worker.
    const window = observationWindowHold(work, new Date(now));
    if (window) return make(`Waiting for its observation window — the reading it owes can first exist at ${window.notBefore}`, 'waiting', `Nothing can be observed before ${window.notBefore}`);
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
    case 'merge': return make(`Ready to merge${on} — ${next ? lowerFirst(next) : 'waiting its turn'}`, 'waiting', next);
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
