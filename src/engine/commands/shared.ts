import { operatorCapability, operatorScopeIncludes, inheritedObligations, demand, deferBoundMs, servingReleaseProof } from '../../model.js';
import type { Criterion, Principal, Work } from '../../model.js';
import { filedFollowUpWindow, followUpRequest } from '../../model/observation-window.js';
import type { Queryable } from '../../store/locked-read.js';
import type { Engine } from '../../engine.js';
import { operatorCommands, type Command } from './schemas.js';

export function authorizeOperatorCommand(actor: Principal, command: Command, data: any, work: Work | undefined, repository: string) {
  demand(operatorCommands.has(command), 'This operation is not available to operator agents', 403);
  demand(!!repository && actor.scope?.repositories.includes(repository), 'Repository is outside this operator-agent scope', 403);
  if (work) demand(operatorScopeIncludes(actor, work), 'Work item is outside this operator-agent scope', 403);
  // Dashboard priority edits derive their reason from the locked item; replays keep that recorded reason.
  demand(data.reason || command === 'priority' && data.source === 'dashboard', 'Operator-agent mutations require a reason', 400);
  if (command === 'create') demand(actor.scope?.workItems.includes('*'), 'Creating work requires wildcard work scope', 403);
}

/**
 * The observation window `defer` (a worker) and `window` (the master or the loop, GY-1740) record: only
 * on a post-deploy follow-up, for a future instant within `deferBoundMs`; a later recorded window is never shortened.
 */
export function observationHold(work: Work, notBefore: string, now: Date, basis: NonNullable<Work['observationWindow']>['basis'], detail: string) {
  demand(work.criteria.some(criterion => criterion.proofs.some(servingReleaseProof)), `${work.key} owes no post-deploy observation (no manual:…-on-serving-release proof); only a follow-up whose reading cannot exist yet is deferred — record a blocker instead`, 409);
  const at = Date.parse(notBefore);
  demand(at > now.getTime(), `notBefore ${notBefore} has already passed; the reading can be taken now`, 422);
  demand(at - now.getTime() <= deferBoundMs, `notBefore ${notBefore} is more than ${deferBoundMs / 86_400_000} days away; a reading that far off is a requirements question — record a blocker instead`, 422);
  if (!work.observationWindow || Date.parse(work.observationWindow.notBefore) < at)
    work.observationWindow = { notBefore: new Date(at).toISOString(), basis, detail: detail.slice(0, 2000) };
}

/**
 * GY-1735: a post-deploy follow-up filed without its observation window takes the one its filing owed
 * it; one already recorded stands. The delivered item is read as its document: a settled stand-in
 * need not carry its criteria or deployment.
 */
export async function adoptFollowUpWindow(db: Queryable, work: Work) {
  const request = work.observationWindow ? null : followUpRequest(work);
  const delivered: Work | undefined = request ? (await db.query('SELECT document FROM work_items WHERE id=$1', [request.work])).rows[0]?.document : undefined;
  const window = delivered ? filedFollowUpWindow(work, [delivered]) : undefined;
  if (window) work.observationWindow = window;
}

/**
 * Bootstrap deferral is an operator act. It requires the explicit policy:bootstrap capability,
 * a reason and a contract scope. The audit fields are
 * stamped from the authenticated actor and the server clock, never taken from the request, and
 * an unchanged declaration keeps its original attribution across later revisions.
 */
export function declareBootstrap(engine: Engine, actor: Principal, data: any, previous: Criterion[], policyRevision: number, now: Date, work?: Work): Criterion[] {
  return data.criteria.map((ac: any): Criterion => {
    if (!ac.bootstrap) return { id: ac.id, text: ac.text, proofs: ac.proofs };
    const prior = previous.find(existing => existing.id === ac.id)?.bootstrap;
    const unchanged = !!prior && prior.reason === ac.bootstrap.reason && JSON.stringify(prior.contractPaths) === JSON.stringify(ac.bootstrap.contractPaths);
    if (!unchanged) operatorCapability(actor, 'policy:bootstrap', work, engine.repository);
    // An E2E proof pins a scenario revision, environment and hash on its own work item. An
    // inherited obligation carries no pin, so deferring one would let the heir satisfy it
    // against an unbound scenario version. Sequence those through the scenario registry.
    demand(!ac.proofs.some((proof: string) => proof.startsWith('e2e:')),
      `Criterion ${ac.id} cannot use bootstrap mode: an E2E proof pins a scenario version that an inherited obligation cannot carry forward`);
    return { id: ac.id, text: ac.text, proofs: ac.proofs, bootstrap: unchanged ? prior! : { ...ac.bootstrap, declaredBy: actor.id, declaredAt: now.toISOString(), policyRevision } };
  });
}

/** A deferral can never be renewed by the very change that inherited the obligation. */
export function refuseRenewedDeferral(work: Work, all: Work[]) {
  for (const obligation of inheritedObligations(work, all)) {
    const renewed = work.criteria.find(ac => ac.bootstrap && ac.proofs.includes(obligation.proof));
    demand(!renewed, `${renewed?.id}: ${obligation.proof} is already a bootstrap obligation inherited from ${obligation.key} ${obligation.criterionId} and cannot be deferred again`);
  }
}

/** An owner is a configured human principal or a teammate the operator invited (GY-3215, team_members). */
export async function assertHumanOwner(engine: Engine, db: Queryable, owner: string | null | undefined) {
  if (owner == null || engine.principals.some(person => person.id === owner && person.sessionKind === 'human')) return;
  demand((await db.query('SELECT 1 FROM team_members WHERE name=$1', [owner])).rows.length, 'Owner must name a person principal (sessionKind: human) or an invited teammate');
}
