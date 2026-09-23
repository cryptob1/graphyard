// The stateless executor (GY-87). Claims one typed action from the control plane, runs it,
// reports the result, and repeats. It keeps nothing between claims and is configured with no peer
// list, so any number of these run on any number of hosts against the same queue; none of them is
// a master, and killing one costs the claim it held and nothing else.
//
//   node scripts/graphyard-executor.mjs [--once] [--interval SECONDS] [--kinds a,b] [--name NAME] [--unit UNIT]
//
// It reads this host's .graphyard/master.json for the launch profiles the dispatching actions
// need and authenticates with the coordinator credential named there — the same credential
// `master run` uses, and nothing broader. `--kinds` narrows what this executor claims; the
// default is every kind it has a handler for. Two kinds can never be among them: `escalate` and
// `request-rework` are judgments made in the step itself, and the process refuses to start with a
// handler for either, which is what keeps a language model out of the loop rather than inside it.
//
// The modules are loaded once, here, and the checkout they came from keeps moving (GY-126). The
// process records the release it loaded beside the coordinator credential, re-reads the checkout's
// commit before every claim, and stands down — finishing what it runs, claiming nothing more,
// saying why and how to restart it — the moment the two differ. `--unit` names the systemd user
// unit it runs under when that cannot be read from the process itself (only a graphyard-executor
// service is accepted); `graphyard master executors restart` restarts every registered executor
// through that unit, and no claim starts while its fence stands.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { once: false, intervalSeconds: 5, kinds: null, name: null, unit: null };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--once') options.once = true;
    else if (argument === '--interval') options.intervalSeconds = Number(value());
    else if (argument === '--kinds') options.kinds = value().split(',').map(kind => kind.trim()).filter(Boolean);
    else if (argument === '--name') options.name = value();
    else if (argument === '--unit') options.unit = value();
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 1 || options.intervalSeconds > 900) throw new Error('--interval takes whole seconds between 1 and 900');
  return options;
}

/** The TypeScript modules this process is a thin entry point for; tsx is a runtime dependency already. */
export async function load() {
  const { tsImport } = await import('tsx/esm/api');
  const here = import.meta.url;
  const [master, daemon, dispatch, executor, reviewer, producer, actions, view, fleet] = await Promise.all([
    tsImport('../src/master.ts', here), tsImport('../src/master-daemon.ts', here), tsImport('../src/auto-dispatch.ts', here),
    tsImport('../src/executor.ts', here), tsImport('../src/reviewer.ts', here), tsImport('../src/producer.ts', here),
    tsImport('../src/model/next-action.ts', here), tsImport('../src/server/work-view.ts', here), tsImport('../src/executor-fleet.ts', here),
  ]);
  return { master, daemon, dispatch, executor, reviewer, producer, actions, view, fleet };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const modules = await load();
  const { master: m, daemon: d, dispatch: a, executor: x, reviewer: r, producer: pr, actions: k, view: v, fleet: f } = modules;
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const config = await m.loadMasterConfig(root);
  const token = await m.readCredentialFile(config.credentialFile);

  const request = async (path, init = {}, headers = {}) => {
    const response = await fetch(`${config.url}/api/${path}`, { ...init, headers: { ...headers, ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : JSON.stringify(body));
    return body;
  };
  const mutate = (path, data, requestId = randomUUID()) =>
    request(path, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId } });

  const status = await request('status');
  m.assertMasterBinding(config, status);
  // An executor's entire authority is a coordinator credential: it launches sessions, asks the
  // control plane to re-read, and brokers the guarded merge. Anything broader could satisfy a gate
  // the queue exists to wait on, and a credential that may also produce evidence could prove its
  // own work.
  if (status.actor?.role !== 'coordinator') throw new Error('An executor requires a coordinator credential; operator, producer and worker credentials are refused');
  if (status.actor?.proofs?.length) throw new Error('An executor refuses a credential that is also allowed to produce evidence');

  const live = m.liveMasterConfig(root, config), current = () => live.current;
  // Minted once per process, exactly as the daemon mints its own (src/executor.ts).
  const mergeExecutor = x.executorMergeExecutor(status.actor.id);
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
  const snapshot = () => request('work-snapshot', {}, { [v.coordinationViewHeader]: 'coordination' });
  const handlers = x.controlPlaneHandlers(current, {
    snapshot, mutate,
    agents: () => { const runtime = m.observeHerdrAgents(run); return runtime.available ? runtime.agents : null; },
    workerCredentials: profiles => m.inspectWorkerCredentials(root, profiles),
    producerCredentials: profiles => m.inspectProducerCredentials(root, profiles),
    dispatchWorker: (work, profile, agents, snap) => m.dispatchWork(root, work, profile, agents, run, snap.work, undefined, undefined, undefined, snap.now),
    launchReview: (work, review, agents, observedAt) => r.launchReview(root, work, current().run.reviewerProfile, agents, observedAt, { run, requestId: review.id }),
    launchProducer: (work, producerRequest, profile, agents, observedAt) => pr.launchProducer(root, work, producerRequest, profile, agents, observedAt, { run }),
    // Every merge this process brokers is owned by this executor instance (GY-92), never by the
    // coordinator principal alone: a `master run` loop, an interactive `master merge` and every
    // other executor sharing this credential each hold their own. A foreign in-flight execution
    // is then refused rather than resumed, so two brokers never drive one merge — see
    // docs/master-agent.md, "Running executors beside the daemon".
    merge: work => m.mergeExecutor(current(), snapshot, mutate, mergeExecutor, randomUUID(), run)(work),
    observeDeployment: delivered => d.observeDeployment(current(), delivered, run),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
  });
  // The rule, not the prose: a kind whose judgment happens in the step itself may never have a
  // handler here, so no way of configuring this process puts one inside the loop.
  const judgment = x.judgmentInExecutorLoop(handlers);
  if (judgment) throw new Error(`This executor would decide inside the loop: ${judgment}`);
  for (const kind of options.kinds ?? []) {
    if (!k.executorRunnableKinds.includes(kind)) throw new Error(`No executor runs ${kind}; it runs ${k.executorRunnableKinds.join(', ')}`);
  }

  const effects = {
    claim: body => mutate('actions/claim', body),
    // The settlement names the executor the claim was recorded under, never this credential's own
    // principal: several executors may run behind one coordinator credential.
    settle: (action, result, reason) => mutate(`actions/${action.id}/settle`, { result, reason, ...(action.claim?.executor ? { executor: action.claim.executor } : {}) }),
    // A handler is not bounded by the claim lease — a dispatch waits on a runtime, a guarded merge
    // chains provider calls — so while one runs this says the claim is still held. Without it a
    // slow handler loses its row mid-flight and another executor runs the action beside it.
    renew: action => mutate(`actions/${action.id}/renew`, { ...(action.claim?.executor ? { executor: action.claim.executor } : {}) }),
    handlers: options.kinds ? Object.fromEntries(options.kinds.filter(kind => handlers[kind]).map(kind => [kind, handlers[kind]])) : handlers,
  };
  const identity = { id: options.name ?? `${status.actor.id}@${config.hostId}:${process.pid}`, host: config.hostId };
  // The release these modules were loaded from, recorded on this host before the first claim and
  // refreshed on every claim; the commit is re-read from the checkout in front of each claim.
  const release = f.readRelease(root);
  const registrar = f.executorRegistrar(config, { name: identity.id, host: identity.host, pid: process.pid, principal: status.actor.id, kinds: a.executorKinds(effects.handlers),
    intervalSeconds: options.intervalSeconds, root, release, supervisor: f.detectSupervisorUnit({ named: options.unit }) });
  await registrar.started();
  let fenceSeen = null;
  const guarded = x.releaseGuardedEffects(effects, {
    loaded: release, current: () => f.readCommit(root),
    claimed: action => registrar.claimed(action), settled: () => registrar.settled(),
    // A fleet restart raises a fence beside the records; no claim starts while it stands.
    claiming: () => registrar.claiming(), abandoned: () => registrar.abandoned(),
    fenced: async () => {
      const fence = await f.readRestartFence(config);
      if (fence && fence.id !== fenceSeen) console.error(`[graphyard-executor] ${identity.id} claims nothing while the restart by pid ${fence.pid} since ${fence.at} stands`);
      fenceSeen = fence?.id ?? null;
      return fence;
    },
    standDown: detail => { console.error(`[graphyard-executor] ${identity.id} stands down: ${detail.reason}; restart it with ${registrar.registration.supervisor?.restart ?? f.executorRestartCommand}`); return registrar.standDown(detail); },
    resumed: () => { console.error(`[graphyard-executor] ${identity.id} claims again: its checkout is back on ${release.commit.slice(0, 12)}`); return registrar.resumed(); },
  });
  console.error(`[graphyard-executor] ${identity.id} runs ${release.commit ? release.commit.slice(0, 12) : 'an unknown commit'}${release.dirty ? ' (dirty)' : ''} from ${root}${registrar.registration.supervisor ? ` under ${registrar.registration.supervisor.unit}` : ' with no supervisor unit'}; registered at ${registrar.file}`);
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try {
    const result = await a.runExecutor(identity, guarded, { intervalMs: options.intervalSeconds * 1000, once: options.once, signal: stopping.signal, log: line => console.error(line) });
    const report = { executor: identity.id, host: identity.host, repository: config.repository, kinds: a.executorKinds(effects.handlers), intervalSeconds: options.intervalSeconds,
      release, supervisor: registrar.registration.supervisor, standingDown: guarded.standingDown(), registration: registrar.file,
      steps: result.steps.length, ran: result.steps.filter(step => step.action).length, failed: result.steps.filter(step => step.result === 'failed').length, last: result.steps.at(-1) ?? null };
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
    // The last write: a restart's wait tells the process that came back from the one that left by it.
    await registrar.stopped().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
