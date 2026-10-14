// Concern: the acceptance role's day under GitHub's last-pusher rule (GY-1795) — approved pull requests landed through the real land route function, its independent approval and GitHub's refusals, over a protected simulated base.
import type { AcceptanceEffects } from '../../src/daemon/acceptance.js';
import { CHECK_NAME } from '../../src/model.js';
import { draftFiles, type Goal, type Landing } from '../../src/model/goal.js';
import { landAcceptance, recordLanding } from '../../src/server/routes/goals.js';
import { FakeGitHub, type FakeApp } from './fake-github.js';
import { principals, store } from './soak-plane.js';
import { clock } from './soak-world.js';

export interface ProtectedLandingOptions {
  /** How many of each pull request's landings the independent approver App's token mint refuses (502) before it answers. */
  approverRefusals: number;
  /** How long after a head's first landing GitHub Actions reports the required `test` check on it, so the merge is refused on the pending check until then. */
  checkPendingMs: number;
  /** How many merges GitHub answers with a transient 502 once the independent approval stands on the head, so the same head is landed again with the approval standing. */
  mergeOutages: number;
}

/**
 * GY-1795: the same three goals as acceptanceWorld, landed as GOAL-1 was on 2026-10-12. The base
 * branch requires the control plane's `Graphyard / merge` check, Actions' `test` check and one
 * approval from someone other than the last pusher; the control-plane App pushed every acceptance
 * branch and publishes the approver identity's verdict as its own App-bound review, so nothing it
 * posts satisfies the rule, which refused #1153 with "New changes require approval from someone
 * other than the last pusher". Each landing runs the real `landAcceptance` over the fake GitHub's
 * landing adapter (tests/helpers/fake-github.ts), exactly as POST /api/goals/:key/land does, and
 * records what it returns as that route records it. The independent approver App's token mint
 * refuses the first `approverRefusals` landings of each pull request, Actions reports the required
 * `test` check only `checkPendingMs` after a head's first landing, and once the approval stands
 * GitHub answers the next `mergeOutages` merges with a transient 502, so the same head is landed
 * again across polls with the approval already standing on it.
 */
export function protectedAcceptance(github: AcceptanceEffects, named: (key: string) => string, dayStart: number, options: ProtectedLandingOptions) {
  const at = () => clock.now() - dayStart;
  const fake = new FakeGitHub('owner/project', { autoApprove: true });
  const app = registerApp(fake, 'Graphyard'), approver = registerApp(fake, 'Graphyard Approver');
  fake.workflowChecks = [];
  fake.protect({ checks: [{ context: CHECK_NAME, app_id: app.id }, { context: 'test', app_id: fake.actionsAppId }], requiredApprovals: 1, lastPushApproval: true }, 'person:operator');
  const landing = {
    fake, app, approver,
    opens: [] as { goal: string; pr: number; head: string; at: number }[],
    /** Every landing: the pull request, its head, what the route function answered and why. */
    lands: [] as { goal: string; pr: number; head: string; state: Landing['state']; detail: string; at: number }[],
    /** Every approval the independent approver App was asked for, and whether its mint was refused. */
    approvals: [] as { pr: number; head: string; refused: boolean; at: number }[],
    /** Every merge the route asked GitHub for, head-bound, and GitHub's refusal when it refused; `outage` marks the transient 502s. */
    merges: [] as { pr: number; head: string; refusal: string | null; outage: boolean; at: number }[],
    /** Every verdict the control-plane App published on GitHub as its own review: the judge's approval, as GOAL-1's was. */
    verdicts: [] as { pr: number; head: string; at: number }[],
    /** When Actions reported the required check on each head. */
    checks: new Map<string, number>(),
  };
  const firstLanding = new Map<string, number>();
  // The landing adapter the control plane holds: the control-plane App, with the independent approver App beside it.
  const adapter = fake.landing(app, approver);
  const approveAcceptance = adapter.approveAcceptance, graphql = adapter.graphql;
  adapter.approveAcceptance = async (pr, head, body) => {
    const refused = landing.approvals.filter(entry => entry.pr === pr).length < options.approverRefusals;
    landing.approvals.push({ pr, head, refused, at: at() });
    if (refused) throw new Error(`the acceptance approver App ${approver.id} could not mint an installation token (502)`);
    return approveAcceptance(pr, head, body);
  };
  adapter.graphql = async (query, variables) => {
    const pr = Number(variables.id.slice(3)), approved = fake.reviews.some(review => review.pr === pr && review.sha === variables.head && review.state === 'APPROVED' && review.by === `app:${approver.slug}`);
    if (approved && landing.merges.filter(entry => entry.pr === pr && entry.outage).length < options.mergeOutages) {
      landing.merges.push({ pr, head: variables.head, refusal: 'GitHub GraphQL query failed: 502 Bad Gateway', outage: true, at: at() });
      throw new Error('GitHub GraphQL query failed: 502 Bad Gateway');
    }
    try { const answer = await graphql(query, variables); landing.merges.push({ pr, head: variables.head, refusal: null, outage: false, at: at() }); return answer; }
    catch (error) { landing.merges.push({ pr, head: variables.head, refusal: error instanceof Error ? error.message : String(error), outage: false, at: at() }); throw error; }
  };
  const effects: AcceptanceEffects = {
    ...github,
    open: async (goal, draft) => {
      const branch = `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`;
      const files = Object.fromEntries(draftFiles(draft, null).map(file => [file.path, file.content]));
      // The acceptance session pushes with the control-plane App's credential and opens the pull request as its own login.
      const head = fake.push(branch, files, `${goal.key}: acceptance draft ${goal.revision}`, `app:${app.slug}`);
      const pull = fake.openPull({ head: branch, title: `${goal.key}: acceptance`, body: goal.statement }, 'cli:graphyard-acceptance');
      landing.opens.push({ goal: named(goal.key), pr: pull.number, head, at: at() });
      return { pr: pull.number, branch, head };
    },
    judge: async (goal, judgement) => {
      const judged = await github.judge(goal, judgement);
      // The control plane publishes the approver identity's verdict as its own App-bound review on the head it judged — the approval GitHub then discounts as the last pusher's.
      if (judgement.verdict === 'approve' && goal.acceptance?.pr != null) { fake.review(goal.acceptance.pr, { sha: goal.acceptance.head, state: 'APPROVED', body: judgement.reason }, `app:${app.slug}`); landing.verdicts.push({ pr: goal.acceptance.pr, head: goal.acceptance.head, at: at() }); }
      return judged;
    },
    pullRequest: async pr => { const pull = fake.pull(pr); return { state: pull.merged ? 'merged' as const : pull.state, mergeSha: pull.mergeSha, head: pull.head.sha }; },
    close: async pr => { const pull = fake.pull(pr); if (pull.state === 'open') pull.state = 'closed'; },
    // POST /api/goals/:key/land as the route answers it: the real landing over the fake GitHub, recorded as the route records it.
    land: async (goal: Goal) => {
      const pr = goal.acceptance!.pr!, head = goal.approval!.head;
      firstLanding.set(head, firstLanding.get(head) ?? clock.now());
      if (!landing.checks.has(head) && clock.now() - firstLanding.get(head)! >= options.checkPendingMs) { fake.check(head, 'test', 'success', fake.actionsAppId); landing.checks.set(head, at()); }
      const landed = await landAcceptance(adapter, goal);
      landing.lands.push({ goal: named(goal.key), pr, head, state: landed.state, detail: landed.detail, at: at() });
      if (landed.state === 'waiting') return { goal, landing: landed };
      if (landed.state === 'moved' || landed.state === 'conflicting') await adapter.request(`/pulls/${pr}`, 'PATCH', { state: 'closed' });
      return { goal: await recordLanding(store, goal, landed, principals.operatorAgent), landing: landed };
    },
  };
  return { effects, landing };
}

/** An App registered on the fake GitHub through its manifest flow and installed on the repository. */
function registerApp(fake: FakeGitHub, name: string): FakeApp {
  const { code } = fake.submitManifest({ name, url: 'https://graphyard.example' }, 'person:operator');
  const converted = fake.convert(code!);
  fake.install(converted.slug, [fake.repositoryId], 'person:operator');
  return fake.app(converted.slug);
}
