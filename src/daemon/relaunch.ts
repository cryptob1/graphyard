// Concern: the quota failover's registered relaunch of a reviewer or producer session on another account.
import type { Work } from '../model.js';
import type { DispatchRequest } from '../model/dispatch.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { registeredLaunch } from '../model/session-state.js';
import { launchedSessionHandle } from '../auto-dispatch.js';
import { withLaunchedRuntime } from '../master/launch.js';
import { independentProducerProfiles } from '../producer.js';
import type { HerdrAgent, MasterConfig } from '../master.js';
import { message } from './state.js';
import type { LaunchedSession } from './effects.js';

/**
 * The quota failover's relaunch of a reviewer or producer session, registered like every other
 * launch (GY-172 AC-2). The session that ran out was ended on its ledger, but its record still
 * names its pane and its launch; it is closed with that reason, and the next session for the same
 * request is registered through `registeredLaunch` before its runtime starts and coordinated once
 * it has, so the relaunched session is observed and closed by the session report like the one it
 * replaces rather than running unrecorded while the report loses the old pane.
 */
export async function relaunchSession(config: MasterConfig, session: LaunchedSession, work: Work, agents: HerdrAgent[], launch: {
  review: (profile: MasterConfig['reviewers'][number], request: DispatchRequest, agents: HerdrAgent[]) => Promise<unknown>;
  producer: (profile: MasterConfig['producers'][number], request: DispatchRequest, agents: HerdrAgent[]) => Promise<unknown>;
  record?: (handle: SessionHandleInput) => Promise<unknown>;
}): Promise<{ profile: string }> {
  const request = session.role === 'reviewer' ? work.autoDispatch?.review : work.autoDispatch?.producers.find(entry => entry.id === session.requestId);
  if (!request || request.id !== session.requestId || request.state !== 'requested') throw new Error(`${work.key} no longer requests this ${session.role} session`);
  const kind = session.role === 'reviewer' ? 'review' as const : 'proof' as const;
  const subject = kind === 'review' ? `${work.key}: review ${request.sha.slice(0, 12)} (PR #${request.pr})` : `${work.key}: ${request.group} proofs on ${request.sha.slice(0, 12)} (${(request.proofs ?? []).join(', ')})`;
  const previous = work.sessions?.find(handle => handle.id === request.id && handle.state === 'running');
  if (previous && launch.record) {
    await launch.record({ id: previous.id, kind: previous.kind, runtime: previous.runtime, host: previous.host, subject: previous.subject, state: 'finished',
      outcome: `ended on its provider's quota notice (${session.agentName} on profile ${session.profile}); its request is launched again on another account` }).catch(() => {});
  }
  // The profile that just ran out goes last: its other accounts are still its own failover.
  const order = <P extends { name: string; agentName: string }>(profiles: P[]) => [...profiles.filter(profile => profile.name !== session.profile), ...profiles.filter(profile => profile.name === session.profile)].filter(profile => !agents.some(agent => agent.name === profile.agentName));
  const skipped: string[] = [];
  // As in the dispatcher: only skips that were all spent quota make this a wait for capacity.
  let capacity = true;
  const attach = (pane: string) => `herdr pane attach ${pane}${config.herdrWorkspace ? ` --workspace ${config.herdrWorkspace}` : ''}`;
  for (const profile of session.role === 'reviewer' ? order(config.reviewers) : order(independentProducerProfiles(work, config.producers))) {
    try {
      const principal = session.role === 'producer' ? (profile as MasterConfig['producers'][number]).principal : undefined;
      const handle = launchedSessionHandle(kind, request, subject, config.hostId, undefined, profile.kind, config.herdrWorkspace, principal);
      await registeredLaunch(launch.record, handle,
        withLaunchedRuntime(handle, () => session.role === 'reviewer' ? launch.review(profile as MasterConfig['reviewers'][number], request, agents) : launch.producer(profile as MasterConfig['producers'][number], request, agents)), undefined, attach);
      return { profile: profile.name };
    } catch (error) { if (!(error as { accountsExhausted?: boolean })?.accountsExhausted) throw error; skipped.push(message(error)); capacity &&= !!(error as { capacityExhausted?: boolean }).capacityExhausted; }
  }
  if (!skipped.length) throw new Error(`no ${session.role} profile is free to take the request`);
  throw Object.assign(new Error(skipped.join('; ')), { accountsExhausted: true, capacityExhausted: capacity });
}
