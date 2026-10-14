// Concern: the acceptance role's day under the control-plane merger (GY-1535) — the drafts committed for the merge writer and landed by its steps over a simulated base, with no pull request.
import assert from 'node:assert/strict';
import type { AcceptanceEffects, AcceptanceWriterPorts } from '../../src/daemon/acceptance.js';
import { draftFiles, type AcceptanceDraft, type Goal, type Landing } from '../../src/model/goal.js';
import { acceptanceMergeRefusal, recordLanding } from '../../src/server/routes/goals.js';
import type { GitRunner } from '../../src/merge-writer/local-observation.js';
import { principals, store } from './soak-plane.js';
import { clock, sha } from './soak-world.js';

/**
 * GY-1535: the same three goals as acceptanceWorld, under the control-plane merger. Each draft is
 * committed for the merge writer (no pull request) and the approved change is landed through the
 * merge writer's steps over a simulated `main`, its first-parent history held here: `signup`'s first
 * commit fails, `audit`'s first approved change conflicts with the base, and `billing`'s first push
 * is refused because another landing moved `main` between the fetch and the push, after which its
 * landing record is lost once. The record is checked by the land route's own check
 * (`acceptanceMergeRefusal`) over that history before `recordLanding` records it.
 */
export function controlPlaneAcceptance(github: AcceptanceEffects, named: (key: string) => string, dayStart: number) {
  const at = () => clock.now() - dayStart;
  // main's first-parent history, newest first: each commit with its second parent (the merged head), if any.
  const history: { sha: string; second: string | null }[] = [{ sha: sha('cp-main', 0), second: null }];
  const writer = {
    commits: [] as { goal: string; head: string; revision: number; ok: boolean; at: number }[],
    fetches: [] as number[], merges: [] as { goal: string; head: string; at: number }[],
    pushes: [] as { goal: string; head: string; result: 'pushed' | 'rejected'; at: number }[],
    records: [] as { goal: string; ok: boolean; at: number }[], github: [] as string[],
  };
  const heads = new Map<string, { goal: string; draft: AcceptanceDraft }>();
  let commitFailed = false, auditConflicted = false, billingRaced = false, recordLost = false, foreign = 0;
  const ports: AcceptanceWriterPorts = {
    baseBranch: 'main', retrials: 2,
    fetch: async () => { writer.fetches.push(at()); return history[0]!.sha; },
    merge: async (head, tip) => {
      const change = heads.get(head)!;
      writer.merges.push({ goal: change.goal, head, at: at() });
      if (change.goal === 'audit' && !auditConflicted) { auditConflicted = true; return { conflict: ['e2e/contract.json'] }; }
      return { mergeSha: sha('cp-merge', head, tip), files: draftFiles(change.draft, null).map(file => file.path) };
    },
    push: async (mergeSha, tip) => {
      const change = [...heads].find(([head]) => sha('cp-merge', head, tip) === mergeSha)!;
      // Another landing moves main between billing's first fetch and its push: the push, leased on the fetched tip, is refused.
      if (change[1].goal === 'billing' && !billingRaced) { billingRaced = true; history.unshift({ sha: sha('cp-main', ++foreign), second: null }); }
      const result = history[0]!.sha === tip ? 'pushed' as const : 'rejected' as const;
      if (result === 'pushed') history.unshift({ sha: mergeSha, second: change[0] });
      writer.pushes.push({ goal: change[1].goal, head: change[0], result, at: at() });
      return result;
    },
    merged: async head => history.find(commit => commit.second === head)?.sha ?? null,
  };
  // The control plane's own read of main, answered from the history above for the land route's check.
  const git: GitRunner = async args => {
    const answer = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'rev-parse') { const second = history.find(commit => `${commit.sha}^2` === args.at(-1))?.second; return second ? answer(`${second}\n`) : { status: 1, stdout: '', stderr: '' }; }
    if (args[0] === 'rev-list') return answer(history.map(commit => commit.sha).join('\n'));
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const effects: AcceptanceEffects = {
    ...github,
    merger: async () => 'control-plane',
    open: async goal => { writer.github.push(`open ${goal.key}`); throw new Error('no pull request is opened under the control-plane merger'); },
    land: async goal => { writer.github.push(`land ${goal.key}`); throw new Error('GitHub lands nothing under the control-plane merger'); },
    close: async pr => { writer.github.push(`close #${pr}`); },
    pullRequest: async pr => { writer.github.push(`read #${pr}`); throw new Error('no pull request is read under the control-plane merger'); },
    commit: async (goal, draft) => {
      const name = named(goal.key), first = !commitFailed && name === 'signup';
      writer.commits.push({ goal: name, head: '', revision: goal.revision, ok: !first, at: at() });
      if (first) { commitFailed = true; throw new Error('git worktree add: fatal: could not lock config file'); }
      const head = sha('cp-acceptance', goal.key, goal.revision, JSON.stringify(draft));
      heads.set(head, { goal: name, draft });
      writer.commits.at(-1)!.head = head;
      return { branch: `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`, head };
    },
    writer: ports,
    // POST /api/goals/:key/land with the merge commit, as the route answers it: the base must hold that merge of the approved head.
    landed: async (goal: Goal, mergeSha: string) => {
      const name = named(goal.key), lose = name === 'billing' && !recordLost;
      writer.records.push({ goal: name, ok: !lose, at: at() });
      if (lose) { recordLost = true; throw new Error('Graphyard refused goals (502): Bad Gateway'); }
      assert.equal(goal.approval!.head, goal.acceptance!.head, 'a change is recorded merged only at its approved head');
      const refusal = await acceptanceMergeRefusal(git, 'main', goal.approval!.head, mergeSha);
      assert.equal(refusal, null, `the land route would refuse ${goal.key}'s merge ${mergeSha}: ${refusal}`);
      const landing: Landing = { state: 'merged', mergeSha, detail: `the merge writer merged ${goal.key}'s acceptance change as ${mergeSha}` };
      return { goal: await recordLanding(store, goal, landing, principals.operatorAgent), landing };
    },
  };
  return { effects, writer, history };
}
