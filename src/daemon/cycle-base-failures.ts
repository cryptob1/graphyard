// Concern: base failures (GY-528) — the loop's step. A test that fails on the base tip as well is
// not the candidate's to fix, so no rework is requested and no approver is launched for it; the
// fault is raised once against the base. The pure half is model/base-failure.ts. GY-1834: the merge
// writer holds a trial whose failing files fail on the base tip too, and the step files its fix
// item here at once, under one P0 filing; a failing test that is one of the candidate's criterion
// proofs is never set aside, so it always holds the item as its own failure.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import { type BaseFailure, baseFailureItem, runOf, short } from '../model/base-failure.js';
import { agentOwner, type AttentionItem } from '../master/attention.js';
import { parseBaseFailureReason } from '../merge-writer/executor.js';
import { readyToRetry } from './sessions.js';
import { message } from './state.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';

/** GY-1834: the check a merge trial's base failure is recorded under; its base is the trial's, not a GitHub check. */
export const trialCheck = 'trial';
// Keyed by the failing set, not the tip: a head held again on a newer tip with the same tests names the item already filed.
const trialKey = (item: Pick<Work, 'id'>, tests: readonly string[]) => `trial:${item.id}:${createHash('sha256').update(tests.join('\n')).digest('hex').slice(0, 16)}`;

/**
 * GY-1834: the base failures the merge writer proved, raised from the items' records so one fix
 * item is filed for each at once. A head the writer refused `base failure` is held on that base
 * tip. Each is one record naming all its tests, and clears when its item no longer shows it (a new
 * trial, a new head, or main passing again); a record an older loop kept from a GitHub check or a
 * main-guard revert clears the same way. Mutates `state`.
 */
function recordedBaseFailures(state: Cycle['state'], work: readonly Work[], stamp: string) {
  const live = new Set<string>();
  for (const item of work) {
    const ledger = item.mergeLedger, held = ledger?.state === 'refused' && ledger.head && item.candidate?.sha.toLowerCase() === ledger.head && item.stage !== 'done' ? parseBaseFailureReason(ledger.refusal?.reason ?? '') : null;
    if (held) {
      // The failing cases name the failure; the files only when the base run named none.
      const key = trialKey(item, held.tests.length ? held.tests : held.files);
      live.add(key);
      state.baseFailures[key] ??= { test: (held.tests.length ? held.tests : held.files).join(', ').slice(0, 500), check: trialCheck, baseSha: held.tip, jobId: null, url: null, raisedAt: stamp,
        blocks: [{ key: item.key, id: item.id, sha: ledger!.head!, jobId: null, url: null }], item: null, cleared: null };
    }
  }
  // A recorded failure its item no longer shows is over: the writer judges afresh.
  for (const key of Object.keys(state.baseFailures)) if (!live.has(key)) delete state.baseFailures[key];
}

/**
 * Step 3a. Raise the base failures the merge writer's trials proved and file one P0 item per
 * failing test: a test seen again on a newer base head names the item already filed for it;
 * otherwise it is filed under a key naming the test and base head, so a retry after a lost reply
 * returns the item already filed. Returns, per item id, the checks the decisions step sets aside:
 * none, since the writer itself holds a head its base fails (GY-1834).
 */
export async function baseFailureStep(cycle: Cycle): Promise<Map<string, Set<string>>> {
  const { config, state, effects, snapshot, now, performed, isolate } = cycle;
  const setAside = new Map<string, Set<string>>();
  recordedBaseFailures(state, snapshot.work, new Date(cycle.clock).toISOString());
  if (!Object.keys(state.baseFailures).length) return setAside;
  const note = (key: string, outcome: 'done' | 'failed', detail: string) =>
    record(state, key, { kind: 'fault', work: null, principal: null, state: outcome, detail, attempts: outcome === 'failed' ? (state.actions[key]?.attempts ?? 0) + 1 : 1, cycle: state.cycle }, now(), effects.persist).then(entry => { performed.push(entry); });
  for (const [key, failure] of Object.entries(state.baseFailures)) await isolate('fault', null, `base-failure:${key}`, async () => {
    if (failure.cleared || failure.item) return;
    const sibling = Object.values(state.baseFailures).find(other => other !== failure && other.test === failure.test && !other.cleared && other.item);
    if (sibling) { failure.item = sibling.item; return; }
    if (!effects.fileBaseFailure || !failure.blocks.length) return;
    const actionKey = `base-failure:file:${key}`, previous = state.actions[actionKey];
    if (previous?.state === 'failed' && !readyToRetry(previous, state.cycle)) return;
    try {
      const filed = await effects.fileBaseFailure(baseFailureItem(failure, config.baseBranch), `base-failure:${key}`);
      failure.item = filed.key;
      await note(actionKey, 'done', `Filed ${filed.key} (P0): base branch ${config.baseBranch} fails the ${failure.check} test "${failure.test}" at ${short(failure.baseSha)} (CI run ${runOf(failure)}), blocking ${failure.blocks.map(block => block.key).join(', ')}; no rework is requested for it`);
    } catch (error) {
      await note(actionKey, 'failed', `Could not file the P0 item for the ${failure.check} test "${failure.test}" failing on ${config.baseBranch} at ${short(failure.baseSha)}: ${message(error)}`);
    }
  });
  await effects.persist(state);
  return setAside;
}

/**
 * One attention line per failing test standing on the base: the test, the base commit, the CI run,
 * the item filed for it and the candidates it blocks. A failure the base has passed since raises
 * nothing. One test seen on several base heads is one line, on its latest head.
 */
export function baseFailureAttention(failures: readonly BaseFailure[], baseBranch: string): AttentionItem[] {
  const latest = new Map<string, BaseFailure>();
  for (const failure of failures) {
    if (failure.cleared) continue;
    const seen = latest.get(failure.test);
    const newest = !seen || Date.parse(failure.raisedAt) >= Date.parse(seen.raisedAt) ? failure : seen;
    const blocks = [...(seen?.blocks ?? []), ...failure.blocks].filter((block, index, all) => all.findIndex(other => other.id === block.id) === index);
    latest.set(failure.test, { ...newest, blocks, item: newest.item ?? seen?.item ?? failure.item });
  }
  return [...latest.values()].map(failure => ({
    subject: failure.item ?? baseBranch, kind: 'base-failure' as const,
    text: `Base branch ${baseBranch} fails the ${failure.check} test "${failure.test}" at ${short(failure.baseSha)} (CI run ${runOf(failure)}), blocking ${failure.blocks.map(block => block.key).join(', ') || 'no candidate'}; no rework is requested for it${failure.item ? ` and ${failure.item} (P0) repairs it` : ''}`.slice(0, 1000),
    ...agentOwner('master', failure.item ? `Drive ${failure.item} to delivery; once ${baseBranch} passes again the merge writer trials the blocked candidates afresh`
      : `Repair the test on ${baseBranch}; the loop files its P0 item once the operator-agent identity is provisioned`),
  }));
}
