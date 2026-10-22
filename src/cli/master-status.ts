// Concern: `graphyard master status` — one page: the serving commit against main's tip, each open item, the merge writer, live sessions and free worker profiles.
import { type MasterConfig, inspectWorkerCredentials, observeHerdrAgents } from '../master.js';
import type { Work } from '../model/work.js';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { daemonSummary, profileHealth, readDaemonState } from '../master-daemon.js';
import { mergeWriterSummary } from '../daemon/cycle-merge-writer.js';
import { deployRecordPath, readDeployRecord } from '../deploy-watch.js';

const short = (sha: string | null | undefined) => sha ? sha.slice(0, 12) : null;

/** One open item's line: its stage, who holds it, the head it submitted, and what blocks it. */
export function itemLine(item: Work, now: number) {
  const lease = item.lease && Date.parse(item.lease.expiresAt) > now ? item.lease : null;
  return { key: item.key, title: item.title, stage: item.stage, owner: lease?.owner ?? null, head: short(item.candidate?.sha),
    blocker: item.blocker ?? (item.humanRequest && !item.humanRequest.answer ? `waits on a human: ${item.humanRequest.needed}` : null) };
}

/** The `master status` page. `run` reads main's tip from the checkout's remote-tracking ref; the deploy unit fetches it. */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, run: ChildRun = defaultChildRun) {
  const [snapshot, runtime, credentials, state] = await Promise.all([masterApi('work-snapshot') as Promise<{ work: Work[]; now: string }>, observeHerdrAgents(), inspectWorkerCredentials(root, master.workers), readDaemonState(root, master).catch(() => null)]);
  const now = Date.parse(snapshot.now) || Date.now();
  const deploy = readDeployRecord(deployRecordPath(root));
  const main = await Promise.resolve(run('git', ['-C', root, 'rev-parse', `refs/remotes/origin/${master.baseBranch}`])).then(out => String(out).trim(), () => null);
  const serving = deploy?.tip ?? state?.release?.commit ?? null;
  const loop = state ? daemonSummary(state, now, master.run.intervalSeconds * 1000, master.hostId) : null;
  const sessions = snapshot.work.flatMap(item => (item.sessions ?? []).filter(session => session.state === 'running')
    .map(session => ({ work: item.key, id: session.id, kind: session.kind, pane: session.pane, live: runtime.available ? runtime.agents.some(agent => !!session.pane && agent.pane_id === session.pane) : null })));
  const health = state ? profileHealth(master.workers, credentials, runtime.agents, state, now, snapshot.work) : [];
  return {
    serving: { commit: short(serving), main: short(main), atMain: !!serving && serving === main, failedDeploy: deploy?.failed ? { tip: short(deploy.failed), reason: deploy.reason } : null },
    loop: loop ? { state: loop.liveness.state, detail: loop.liveness.detail, cycle: loop.cycle, steps: loop.metrics?.steps ?? null } : { state: 'absent', detail: 'The loop cursor cannot be read' },
    items: snapshot.work.filter(item => item.stage !== 'done').map(item => itemLine(item, now)),
    mergeWriter: (({ queue, inFlight, lastMergeAt, refusals }) => ({ queue, inFlight, lastMergeAt, lastRefusal: refusals.at(-1) ?? null }))(mergeWriterSummary(state?.mergeWriter)),
    sessions,
    freeWorkers: health.filter(entry => entry.healthy).map(entry => entry.profile.name),
  };
}
