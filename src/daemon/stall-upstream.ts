// Concern: GY-1855 AC-2 — upstream filing of a stall the master session has not cleared within its bound: exactly one item per signature into master.json `upstream` (or self), and the master status listing.
import { z } from 'zod';
import { externalCredential, readCredentialFile } from '../master/config.js';
import { serverOrigin } from '../repository-setup.js';
import { agentToken, type MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { RefusedResponse } from '../model/refusal.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { message, type DaemonAction, type DaemonState, type StepStall } from './state.js';
import type { DaemonEffects } from './effects.js';
import { record } from './preserve.js';
import { readyToRetry } from './sessions.js';
import { retainedStepStalls, stallCycleBound, stallNeedsMaster, stallSubjectKey, stallUpstreamCycles } from './step-stalls.js';
import { type AttentionItem, agentOwner } from '../master/attention.js';

/** Whether a standing stall files its one upstream item (GY-1855 AC-2): it still needs the master session and stood past `stallUpstreamCycles`. */
export const stallFilesUpstream = (stall: StepStall): boolean => stallNeedsMaster(stall) && stall.count >= stallUpstreamCycles;
/** Cursor action key for one stall's upstream filing (GY-1855): derived from its subject so a done row is the local dedup. */
export const stallUpstreamActionKey = (signature: string) => `stall-upstream:${stallSubjectKey(signature).slice('stall:'.length)}`;
/** Idempotency key for the filed item: the signature alone, so a retry or re-ask returns the one item already filed. */
export const stallUpstreamIdempotencyKey = (signature: string) => `loop-step-stall:${stallSubjectKey(signature).slice('stall:'.length)}`;

/** Item body as the create command parses it; validated before ask so a body the plane would refuse is recorded, never sent. */
export const stallUpstreamItemSchema = z.object({
  title: z.string().min(1).max(200), type: z.literal('bug'), priority: z.literal(1),
  description: z.string().min(1).max(20_000),
  criteria: z.array(z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1).max(2000), proofs: z.array(z.string().min(1).max(100)).min(1).max(20) }).strict()).min(1).max(50),
  reason: z.string().min(1).max(2000),
}).strict();
export type StallUpstreamItemInput = z.infer<typeof stallUpstreamItemSchema>;

/** Bounded evidence text: the item body names the stall's own record, never more than this per field. */
const bounded = (text: string, max = 1000) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The stall's item with its evidence (GY-1855 AC-2): step, signature, count, first/stalled/last times,
 * last error and the remedy record, read off the run at the first ask. The caller stores the body and
 * resends it unchanged under the signature's key, so a retry never files a second item.
 */
export function stallUpstreamItem(stall: StepStall): StallUpstreamItemInput {
  const { signature, step } = stall;
  const remedy = !stall.remedy ? 'none: no remedy binds to this signature, so the master session was woken for it'
    : `the ${stall.remedy.kind} remedy, applied once at ${stall.remedy.at}: ${stall.remedy.outcome}${stall.remedy.outcome === 'started' ? ' (never reported)' : stall.remedy.verified ? ', verified' : ', unverified'}: ${bounded(stall.remedy.detail, 1000)}`;
  return {
    title: `Loop-step stall: the ${step} call fails with one signature past its clearing bound`.slice(0, 200), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself (GY-1855): a loop step or dispatcher call failed with one normalised signature on ${stallCycleBound} consecutive cycles — one stall — and the stall stood past ${stallUpstreamCycles}, so the master session woken for it had not cleared it within its bound. Exactly one item is filed per signature: this signature never files a second one.`,
      `Evidence, as the filing install's loop recorded it at the first ask (subject ${stallSubjectKey(signature)} in its daemon.stepStalls):`,
      [`- Step: ${step}`, `- Signature: ${bounded(signature, 800)}`, `- Consecutive failing cycles: ${stall.count}`, `- First failure: ${stall.firstAt}`, `- Recorded as a stall: ${stall.stalledAt}`, `- Last failure: ${stall.lastAt}`,
        `- Last error: ${bounded(stall.lastError)}`, `- Remedy: ${remedy}`].join('\n'),
      `While a stall stands its failing call is attempted at most once per five minutes.`,
    ].join('\n\n'),
    criteria: [{ id: 'AC-1', text: `The ${step} call no longer fails with this signature on a release serving the filing install, or the stall is cleared within its bound before one is filed, covered by a test that pins the bound`, proofs: ['unit:loop-step-stall-cleared'] }],
    reason: `The loop-step stall with this signature stood past ${stallUpstreamCycles} consecutive failing cycles and no open item names it`,
  };
}

export type StallUpstreamFiler = (input: StallUpstreamItemInput, key: string) => Promise<Work>;

async function postStallWork(origin: string, token: string, input: StallUpstreamItemInput, key: string): Promise<Work> {
  const response = await fetch(`${origin}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
  const text = await response.text(); // GY-1751: a proxy's empty or HTML 502-504 keeps its status
  let result: any; try { result = JSON.parse(text); } catch { result = response.ok ? undefined : { text: text.slice(0, 200) }; }
  if (!response.ok) throw new RefusedResponse(`Graphyard refused work (${response.status}): ${result?.error ?? result?.text ?? text.slice(0, 200)}`, response.status, result);
  return result as Work;
}

/**
 * Production filer: `upstream` absent files into this install as the operator-agent (slow-loop precedent); present files into the named install with its credential file.
 * Both read the loop's current configuration at each ask, so a reload that names an upstream or provisions the operator-agent applies to the next filing; the checkout `root` is read only when a filing is made.
 */
export function stallUpstreamFiler(current: () => MasterConfig, root: () => string): StallUpstreamFiler {
  return async (input, key) => {
    const config = current(), upstream = config.upstream;
    if (!upstream) {
      if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can file the stalls it cannot clear');
      return postStallWork(config.url, await agentToken(root(), config, 'operatorAgent'), input, key);
    }
    await externalCredential(root(), upstream.credentialFile, 'Upstream filing');
    return postStallWork(serverOrigin(upstream.url), await readCredentialFile(upstream.credentialFile), input, key);
  };
}

/**
 * At most this many filings wait on the cursor for the plane — as many as the stall cursor holds runs —
 * and this many filed keys are remembered. A waiting filing is never evicted: it leaves only when the
 * plane files it, so a stall that falls due while the ledger is full waits on its own run to be admitted.
 */
export const retainedStallFilings = retainedStepStalls, retainedStallFiled = 200;
/** One filing pass's bound (GY-1855): at most this many asks, none started past this budget, each ask timed out at 30 s. */
export const stallUpstreamAsksPerPass = 4, stallUpstreamPassBudgetMs = 30_000;

/**
 * Whether a filing is asked again now: a failed ask on the daemon's backoff (`readyToRetry`), and an
 * ask a restart cut off (`started` from an earlier cycle: the loop exited before the POST was answered
 * or before its answer was recorded) at once, since the idempotency key makes the re-ask safe.
 */
export function stallUpstreamAskReady(previous: DaemonAction | undefined, cycle: number): boolean {
  if (previous?.state === 'started') return previous.cycle < cycle;
  return readyToRetry(previous, cycle);
}

const oldest = <T extends { at: string }>(entries: [string, T][], bound: number) =>
  entries.length > bound ? entries.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, entries.length - bound) : [];

async function askStallUpstream(state: DaemonState, filer: StallUpstreamFiler, now: () => number, persist: DaemonEffects['persist'], subject: string, again: boolean): Promise<{ action: DaemonAction; unanswered: boolean }> {
  const pending = state.stallUpstream.pending[subject]!, key = stallUpstreamActionKey(pending.signature), previous = state.actions[key];
  const attempts = (previous?.attempts ?? 0) + 1, short = pending.signature.slice(0, 160), idempotency = stallUpstreamIdempotencyKey(pending.signature);
  await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: again
    ? `Asking again for the one upstream item of the loop-step stall on the ${pending.step} call, with the body first composed at ${pending.at}: ${short}`
    : `Filing the one upstream item for the loop-step stall on the ${pending.step} call past ${stallUpstreamCycles} consecutive failing cycles: ${short}`, attempts, cycle: state.cycle }, now(), persist);
  let body: unknown = null;
  try { body = JSON.parse(pending.body); } catch { /* refused below as a body that does not parse */ }
  const parsed = stallUpstreamItemSchema.safeParse(body);
  if (!parsed.success) {
    delete state.stallUpstream.pending[subject];
    return { unanswered: false, action: await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the upstream item for the loop-step stall on the ${pending.step} call: the body does not parse as the create command reads it: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`, attempts, cycle: state.cycle }, now(), persist) };
  }
  try {
    const filed = await filer(parsed.data, idempotency);
    delete state.stallUpstream.pending[subject];
    state.stallUpstream.filed[subject] = { key: filed.key, at: new Date(now()).toISOString() };
    for (const [dropped] of oldest(Object.entries(state.stallUpstream.filed), retainedStallFiled)) delete state.stallUpstream.filed[dropped];
    return { unanswered: false, action: await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the loop-step stall on the ${pending.step} call (${idempotency}); the same signature never files a second item, and a later ask returns this one`, attempts, cycle: state.cycle }, now(), persist) };
  } catch (error) {
    // The body stays pending whatever the refusal: a later ask resends it unchanged under the same key, on backoff.
    const unanswered = planeWideRefusal(error);
    return { unanswered, action: await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the upstream item for the loop-step stall on the ${pending.step} call; it is asked again on a later cycle${unanswered ? ' (the control plane did not answer)' : ''}: ${message(error)}`, attempts, cycle: state.cycle }, now(), persist, unanswered ? null : undefined) };
  }
}

/**
 * Admission (GY-1855 AC-2): every standing stall past `stallFilesUpstream` that no filing, filed key or
 * done row answers yet is composed into the ledger — oldest stall first, while it has room — before any
 * ask is made, and persisted at once, so a slow, refused or unanswered plane never keeps a due signature
 * off the cursor and a stall that clears meanwhile is still filed.
 */
async function admitDueStalls(state: DaemonState, now: () => number, persist: DaemonEffects['persist']): Promise<void> {
  const ledger = state.stallUpstream;
  let admitted = false;
  const due = Object.values(state.stepStalls).filter(run => run.stalledAt && stallFilesUpstream(run)).sort((a, b) => Date.parse(a.stalledAt!) - Date.parse(b.stalledAt!));
  for (const stall of due) {
    const subject = stallSubjectKey(stall.signature), previous = state.actions[stallUpstreamActionKey(stall.signature)];
    if (ledger.filed[subject] || ledger.pending[subject] || previous?.state === 'done' || !stallUpstreamAskReady(previous, state.cycle)) continue;
    // A full ledger admits nothing: the stall still stands, so it is admitted once a waiting filing settles.
    if (Object.keys(ledger.pending).length >= retainedStallFilings) break;
    ledger.pending[subject] = { signature: stall.signature, step: stall.step, at: new Date(now()).toISOString(), body: JSON.stringify(stallUpstreamItem(stall)) };
    admitted = true;
  }
  if (admitted) await persist(state);
}

/**
 * Filing step beside the remedies (GY-1855 AC-2): every standing stall past `stallFilesUpstream` files
 * exactly one upstream item per signature. Its body is composed once and kept on the cursor until the
 * plane files it, so a failed, unanswered or interrupted ask — even one whose stall has since cleared —
 * is asked again with the same body and key; a filed key, or the done row, files nothing more. A pass
 * starts at most `stallUpstreamAsksPerPass` asks and none once `stallUpstreamPassBudgetMs` has passed —
 * least recently asked first — so a slow plane holds the loop for one budget plus one request timeout;
 * every filing it did not reach waits on the cursor for a later cycle.
 */
export async function fileStalledStepsUpstream(state: DaemonState, filer: StallUpstreamFiler | null, now: () => number, persist: DaemonEffects['persist']): Promise<DaemonAction | null> {
  let last: DaemonAction | null = null;
  if (!filer) return last;
  await admitDueStalls(state, now, persist);
  const started = now(), asked = new Set<string>();
  for (let asks = 0; asks < stallUpstreamAsksPerPass && now() - started < stallUpstreamPassBudgetMs; asks++) {
    const ready = Object.entries(state.stallUpstream.pending)
      .map(([subject, pending]) => ({ subject, pending, previous: state.actions[stallUpstreamActionKey(pending.signature)] }))
      .filter(entry => !asked.has(entry.subject) && stallUpstreamAskReady(entry.previous, state.cycle))
      .sort((a, b) => (a.previous?.cycle ?? -1) - (b.previous?.cycle ?? -1) || Date.parse(a.pending.at) - Date.parse(b.pending.at));
    const next = ready[0];
    if (!next) break;
    asked.add(next.subject);
    const answer = await askStallUpstream(state, filer, now, persist, next.subject, !!next.previous);
    last = answer.action;
    // A plane that did not answer ends this cycle's asks: every other one is asked on a later cycle, on its own backoff.
    if (answer.unanswered) break;
    // A filed item frees its place: a stall the full ledger declined is admitted now.
    if (answer.action.state === 'done') await admitDueStalls(state, now, persist);
  }
  return last;
}

/** `master status` listing (GY-1855 AC-2): one attention line per standing stall with signature, count, remedy and owner. */
export function stallStatusAttention(state: DaemonState | null, cliPath: string): AttentionItem[] {
  if (!state) return [];
  return Object.values(state.stepStalls).filter(run => run.stalledAt).map(run => {
    const subject = stallSubjectKey(run.signature);
    const remedy = !run.remedy ? 'no remedy binds to it'
      : run.remedy.outcome === 'started' ? `its ${run.remedy.kind} remedy was started at ${run.remedy.at} and never reported`
        : `its ${run.remedy.kind} remedy was applied once at ${run.remedy.at} and ${run.remedy.outcome}${run.remedy.verified ? ', verified' : ', unverified'}`;
    const filed = state.actions[stallUpstreamActionKey(run.signature)], item = state.stallUpstream.filed[subject]?.key ?? (filed?.state === 'done' ? filed.work : null);
    const upstream = stallFilesUpstream(run)
      ? (item ? ` Its upstream item is ${item}.` : ` It stood past its ${stallUpstreamCycles}-cycle bound${filed?.state === 'failed' ? ` and its upstream filing is on its backoff (${filed.attempts} attempt(s))` : ', so its one upstream item is being filed'}.`)
      : '';
    return {
      subject,
      text: `Loop-step stall: the ${run.step} call failed ${run.count} cycle(s) with one signature, standing since ${run.stalledAt}: ${run.signature}; ${remedy}.${upstream} The stalled call is attempted at most once per five minutes while this stands.`,
      ...agentOwner('master', `node ${cliPath} master status (daemon.stepStalls, subject ${subject}) names the failing attempts; judge the cause and clear it, or judge the upstream item it filed`),
    };
  });
}
