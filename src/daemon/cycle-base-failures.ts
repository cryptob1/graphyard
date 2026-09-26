// Concern: base failures (GY-528) — the loop's step. A required check that fails on the base
// branch head as well is not the candidate's to fix, so no rework is requested and no approver is
// launched for it; the fault is raised once against the base, and the candidates it held are
// rerun and refreshed onto the base once it passes again. The pure half is model/base-failure.ts.
import type { Work } from '../model.js';
import { type BaseCheck, type BaseFailure, baseFailureItem, baseFailureKey, failedRequiredChecks, judgeFailedCheck, runOf, short } from '../model/base-failure.js';
import { agentOwner, type AttentionItem } from '../master/attention.js';
import { detailChanged } from './decisions.js';
import { readyToRetry } from './sessions.js';
import { message } from './state.js';
import { record } from './effects.js';
import type { Cycle } from './cycle.js';

/** How many failed attempts a rerun or refresh of one blocked candidate gets before the loop stops asking. */
export const baseFailureRemedyAttempts = 3;
/** How long a cleared base failure waits for its candidates to be observed on the repaired base before it is retired regardless. */
export const baseFailureRetireMs = 24 * 3_600_000;

/**
 * Step 3a. Judge every failed required check of an open candidate against the base head's latest
 * completed run of the same check, read from GitHub outside any coordination transaction. Returns,
 * per item id, the checks the decisions step sets aside: a base failure, and a failure whose base
 * run has not completed yet (the comparison waits for it rather than asking for a round it may
 * not need). A failure only the candidate has, or one whose tests cannot be read, is left to
 * `failedCheckRework` exactly as before.
 */
export async function baseFailureStep(cycle: Cycle): Promise<Map<string, Set<string>>> {
  const { config, state, effects, snapshot, now, performed, isolate } = cycle;
  const setAside = new Map<string, Set<string>>();
  if (!effects.failedTests || !effects.baseCheck) return setAside;
  const stamp = new Date(cycle.clock).toISOString();
  const note = (key: string, item: Work | null, kind: 'refresh' | 'fault', outcome: 'done' | 'failed', detail: string) =>
    record(state, key, { kind, work: item?.key ?? null, principal: null, state: outcome, detail, attempts: outcome === 'failed' ? (state.actions[key]?.attempts ?? 0) + 1 : 1, cycle: state.cycle }, now(), effects.persist).then(entry => { performed.push(entry); });
  const failing = cycle.open.map(item => ({ item, failed: failedRequiredChecks(item) })).filter(entry => entry.failed.length);
  const standing = Object.values(state.baseFailures);
  const checks = [...new Set([...failing.flatMap(entry => entry.failed.map(failed => failed.name)), ...standing.filter(failure => !failure.cleared).map(failure => failure.check)])].sort();
  if (!checks.length && !standing.length) return setAside;
  const bases = new Map<string, BaseCheck | null>();
  for (const check of checks) bases.set(check, await effects.baseCheck(check).catch(() => null));

  // 1. Judge each failed check. A base failure records the candidate it blocks under every test
  //    it shares with the base head; one record per test and base head, however many candidates.
  for (const { item, failed } of failing) await isolate('refresh', item, item.key, async () => {
    for (const { name, check } of failed) {
      const hold = () => { if (!setAside.has(item.id)) setAside.set(item.id, new Set()); setAside.get(item.id)!.add(name); };
      // A run already judged a base failure, or already rerun, is that failure still: it reads failed
      // until the rerun or the refreshed head is observed, even once the base passes again, and is
      // never mistaken then for a failure of the candidate's own.
      if (check.id !== undefined && (state.actions[`base-failure:rerun:${check.id}`]?.state === 'done'
        || standing.some(failure => failure.check === name && failure.blocks.some(block => block.id === item.id && block.jobId === check.id)))) { hold(); continue; }
      const base = bases.get(name);
      const tests = check.id !== undefined ? await effects.failedTests!(check.id).catch(() => null) : null;
      const judged = judgeFailedCheck(tests, base);
      if (judged.kind === 'own') continue;
      hold();
      if (judged.kind === 'pending') {
        const waitKey = `wait:base-failure:${item.id}`, detail = `${item.key}: required check ${name} failed on ${short(item.candidate!.sha)}; rework waits for the base head ${short(base!.baseSha)} to complete its own ${name} run, which decides whether the failure is the candidate's`;
        if (detailChanged(state.actions[waitKey], detail)) await note(waitKey, item, 'refresh', 'done', detail);
        continue;
      }
      for (const test of judged.tests) {
        const key = baseFailureKey(test, base!.baseSha);
        const failure = state.baseFailures[key] ??= { test, check: name, baseSha: base!.baseSha, jobId: base!.jobId, url: base!.url, raisedAt: stamp, blocks: [], item: null, cleared: null };
        const block = { key: item.key, id: item.id, sha: item.candidate!.sha, jobId: check.id ?? null, url: null };
        failure.blocks = [...failure.blocks.filter(entry => entry.id !== item.id), block].slice(-200);
      }
    }
  });

  // 2. One P0 item per failing test: a test seen again on a newer base head names the item already
  //    filed for it; otherwise it is filed under a key naming the test and base head, so a retry
  //    after a lost reply returns the item already filed.
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
      await note(actionKey, null, 'fault', 'done', `Filed ${filed.key} (P0): base branch ${config.baseBranch} fails the ${failure.check} test "${failure.test}" at ${short(failure.baseSha)} (CI run ${runOf(failure)}), blocking ${failure.blocks.map(block => block.key).join(', ')}; no rework is requested for it`);
    } catch (error) {
      await note(actionKey, null, 'fault', 'failed', `Could not file the P0 item for the ${failure.check} test "${failure.test}" failing on ${config.baseBranch} at ${short(failure.baseSha)}: ${message(error)}`);
    }
  });

  // 3. The base head's run of the check passed: every standing failure of that check clears.
  for (const [key, failure] of Object.entries(state.baseFailures)) {
    const base = bases.get(failure.check);
    if (failure.cleared || base?.state !== 'passed') continue;
    failure.cleared = { at: stamp, baseSha: base.baseSha, jobId: base.jobId };
    await note(`base-failure:cleared:${key}`, null, 'refresh', 'done', `Base branch ${config.baseBranch} passes ${failure.check} again at ${short(base.baseSha)}: "${failure.test}" no longer holds ${failure.blocks.map(block => block.key).join(', ') || 'any candidate'}; their failed jobs are rerun and each is refreshed onto the repaired base`);
  }

  // 4. Each candidate a cleared failure held gets its failed job rerun and, since a rerun reuses the
  //    merge commit the failure was built on, a Graphyard-authored merge of the repaired base into
  //    its branch: once per candidate head, however many failing tests held it.
  for (const [key, failure] of Object.entries(state.baseFailures)) await isolate('refresh', null, `base-failure:${key}`, async () => {
    if (!failure.cleared) return;
    let settled = true;
    for (const block of failure.blocks) {
      const item = snapshot.work.find(entry => entry.id === block.id);
      const current = !!item && item.stage !== 'done' && item.candidate?.sha === block.sha;
      if (current && block.jobId !== null && effects.rerunJob) {
        const rerunKey = `base-failure:rerun:${block.jobId}`, previous = state.actions[rerunKey];
        if (previous?.state !== 'done' && (previous?.attempts ?? 0) < baseFailureRemedyAttempts) {
          settled = false;
          if (readyToRetry(previous, state.cycle)) {
            try { await effects.rerunJob(block.jobId); await note(rerunKey, item!, 'refresh', 'done', `Reran ${item!.key}'s failed ${failure.check} job ${block.jobId} on ${short(block.sha)}: ${config.baseBranch} passes it again at ${short(failure.cleared.baseSha)}`); }
            catch (error) { await note(rerunKey, item!, 'refresh', 'failed', `Could not rerun ${item!.key}'s failed ${failure.check} job ${block.jobId}: ${message(error)}`); }
          }
        }
      }
      const refreshKey = `base-failure:refresh:${block.id}:${block.sha}`, previous = state.actions[refreshKey];
      if (!current || !effects.refreshCandidate || previous?.state === 'done' || (previous?.attempts ?? 0) >= baseFailureRemedyAttempts) continue;
      const observation = item!.observation;
      // The refresh is decided from an observation of the head taken since the base passed: an older
      // one names the broken tip as the base, which the candidate may already contain.
      const observedSince = !!observation && observation.candidate.sha === block.sha && (Date.parse(observation.at) >= Date.parse(failure.cleared.at) || observation.baseTip === failure.cleared.baseSha);
      if (!observedSince) { settled = false; continue; }
      if (item!.queue || observation!.baseTipContained !== false || !observation!.baseTip) continue;
      settled = false;
      if (!readyToRetry(previous, state.cycle)) continue;
      const reason = `Base branch ${config.baseBranch} failed the ${failure.check} test "${failure.test}" at ${short(failure.baseSha)} and on ${item!.key} head ${short(block.sha)}, and passes it again at ${short(failure.cleared.baseSha)}; a rerun reuses the merge commit the failure was built on, so the repaired base is merged into the branch`.slice(0, 2000);
      try { await effects.refreshCandidate(item!, reason, `base-failure-refresh:${block.id}:${block.sha}`); await note(refreshKey, item!, 'refresh', 'done', `Requested a Graphyard base refresh of ${item!.key} head ${short(block.sha)} onto ${config.baseBranch} ${short(observation!.baseTip)}: ${reason}`); }
      catch (error) { await note(refreshKey, item!, 'refresh', 'failed', `Could not request a base refresh of ${item!.key} head ${short(block.sha)}: ${message(error)}`); }
    }
    if (settled || cycle.clock - Date.parse(failure.cleared.at) >= baseFailureRetireMs) delete state.baseFailures[key];
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
    ...agentOwner('master', failure.item ? `Drive ${failure.item} to delivery; once ${baseBranch} passes ${failure.check} again the loop reruns and refreshes the blocked candidates`
      : `Repair the test on ${baseBranch}; the loop files its P0 item once the operator-agent identity is provisioned`),
  }));
}
