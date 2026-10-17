// Concern: GY-1855 AC-2 — upstream filing of a stall the master session has not cleared within its bound: exactly one item per signature into master.json `upstream` (or self), and the master status listing.
import { z } from 'zod';
import { externalCredential, readCredentialFile } from '../master/config.js';
import { serverOrigin } from '../repository-setup.js';
import { agentToken, type MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { RefusedResponse } from '../model/refusal.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { message, type DaemonAction, type DaemonState } from './state.js';
import type { DaemonEffects } from './effects.js';
import { record } from './preserve.js';
import { readyToRetry } from './sessions.js';
import { stallFilesUpstream, stallSubjectKey, stallUpstreamCycles } from './step-stalls.js';
import { type AttentionItem, agentOwner } from '../master/attention.js';

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

/** Pure function of the signature: same key and body forever so a retry never files a second item. Live evidence stays on the filing install. */
export function stallUpstreamItem(signature: string): StallUpstreamItemInput {
  const step = signature.includes(': ') ? signature.slice(0, signature.indexOf(': ')) : 'loop';
  return {
    title: `Loop-step stall: the ${step} call fails with one signature past its clearing bound`.slice(0, 200), type: 'bug' as const, priority: 1,
    description: [
      `The master loop filed this item itself (GY-1855): a loop step or dispatcher call failed with one normalised signature on three consecutive cycles — one stall — and the stall stood past ${stallUpstreamCycles}, so the master session woken for it had not cleared it within its bound. Exactly one item is filed per signature: this signature never files a second one.`,
      `Signature: ${signature}`,
      `Step: ${step}. While a stall stands its failing call is attempted at most once per five minutes, and a remedy the signature binds to is applied once and verified; a stall no remedy binds to is only woken for. The live evidence — the standing count, the failing attempts so far and the last error text, and the one remedy record — is on the filing install: run graphyard master status there and read daemon.stepStalls, subject ${stallSubjectKey(signature)}.`,
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

/** Production filer: `upstream` absent files into this install as the operator-agent (slow-loop precedent); present files into the named install with its credential file. */
export function stallUpstreamFiler(config: MasterConfig, root: string): StallUpstreamFiler {
  const upstream = config.upstream;
  if (!upstream) return async (input, key) => {
    if (!config.operatorAgent) throw new Error('No master operator-agent identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply so the loop can file the stalls it cannot clear');
    return postStallWork(config.url, await agentToken(root, config, 'operatorAgent'), input, key);
  };
  return async (input, key) => {
    await externalCredential(root, upstream.credentialFile, 'Upstream filing');
    return postStallWork(serverOrigin(upstream.url), await readCredentialFile(upstream.credentialFile), input, key);
  };
}

/**
 * Filing step beside the remedies (GY-1855 AC-2): every standing stall past `stallFilesUpstream` files exactly one
 * upstream item per signature — local action-row dedup plus control-plane idempotency. Unanswered plane asks retry on backoff.
 */
export async function fileStalledStepsUpstream(state: DaemonState, filer: StallUpstreamFiler | null, now: () => number, persist: DaemonEffects['persist']): Promise<DaemonAction | null> {
  let last: DaemonAction | null = null;
  if (!filer) return last;
  const due = Object.values(state.stepStalls).filter(run => run.stalledAt && stallFilesUpstream(run)).sort((a, b) => Date.parse(a.stalledAt!) - Date.parse(b.stalledAt!));
  for (const stall of due) {
    const key = stallUpstreamActionKey(stall.signature), previous = state.actions[key];
    if (previous?.state === 'done' || (previous && !readyToRetry(previous, state.cycle))) continue;
    const short = stall.signature.slice(0, 160);
    const attempts = (previous?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'fault', work: null, principal: null, state: 'started', detail: `Filing the one upstream item for the loop-step stall on the ${stall.step} call, standing since ${stall.stalledAt} past ${stallUpstreamCycles} consecutive failing cycles: ${short}`, attempts, cycle: state.cycle }, now(), persist);
    const parsed = stallUpstreamItemSchema.safeParse(stallUpstreamItem(stall.signature));
    if (!parsed.success) {
      last = await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the upstream item for the loop-step stall on the ${stall.step} call: the body does not parse as the create command reads it: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`, attempts, cycle: state.cycle }, now(), persist);
      continue;
    }
    try {
      const filed = await filer(parsed.data, stallUpstreamIdempotencyKey(stall.signature));
      last = await record(state, key, { kind: 'fault', work: filed.key, principal: null, state: 'done', detail: `Filed ${filed.key} for the loop-step stall on the ${stall.step} call (${stallUpstreamIdempotencyKey(stall.signature)}); the same signature never files a second item, and a later ask returns this one`, attempts, cycle: state.cycle }, now(), persist);
    } catch (error) {
      const unanswered = planeWideRefusal(error);
      last = await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file the upstream item for the loop-step stall on the ${stall.step} call${unanswered ? ' (the control plane did not answer, so it is asked again on a later cycle)' : ''}: ${message(error)}`, attempts, cycle: state.cycle }, now(), persist, unanswered ? null : undefined);
    }
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
    const filed = state.actions[stallUpstreamActionKey(run.signature)];
    const upstream = stallFilesUpstream(run)
      ? (filed?.state === 'done' && filed.work ? ` Its upstream item is ${filed.work}.` : ` It stood past its ${stallUpstreamCycles}-cycle bound${filed?.state === 'failed' ? ` and its upstream filing is on its backoff (${filed.attempts} attempt(s))` : ', so its one upstream item is being filed'}.`)
      : '';
    return {
      subject,
      text: `Loop-step stall: the ${run.step} call failed ${run.count} cycle(s) with one signature, standing since ${run.stalledAt}: ${run.signature}; ${remedy}.${upstream} The stalled call is attempted at most once per five minutes while this stands.`,
      ...agentOwner('master', `node ${cliPath} master status (daemon.stepStalls, subject ${subject}) names the failing attempts; judge the cause and clear it, or judge the upstream item it filed`),
    };
  });
}
