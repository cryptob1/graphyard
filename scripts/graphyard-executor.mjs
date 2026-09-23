// The stateless executor (GY-87). Claims one typed action from the control plane, runs it,
// reports the result, and repeats. It keeps nothing between claims and is configured with no peer
// list, so any number of these run on any number of hosts against the same queue; none of them is
// a master, and killing one costs the claim it held and nothing else.
//
//   node scripts/graphyard-executor.mjs [--once] [--interval SECONDS] [--kinds a,b] [--name NAME]
//
// It reads this host's .graphyard/master.json for the launch profiles the dispatching actions
// need and authenticates with the coordinator credential named there — the same credential
// `master run` uses, and nothing broader. `--kinds` narrows what this executor claims; the
// default is every kind it has a handler for. Two kinds can never be among them: `escalate` and
// `request-rework` are judgments made in the step itself, and the process refuses to start with a
// handler for either, which is what keeps a language model out of the loop rather than inside it.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { once: false, intervalSeconds: 5, kinds: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--once') options.once = true;
    else if (argument === '--interval') options.intervalSeconds = Number(value());
    else if (argument === '--kinds') options.kinds = value().split(',').map(kind => kind.trim()).filter(Boolean);
    else if (argument === '--name') options.name = value();
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 1 || options.intervalSeconds > 900) throw new Error('--interval takes whole seconds between 1 and 900');
  return options;
}

/** The TypeScript modules this process is a thin entry point for; tsx is a runtime dependency already. */
export async function load() {
  const { tsImport } = await import('tsx/esm/api');
  const here = import.meta.url;
  const [master, daemon, dispatch, executor, reviewer, producer, actions, view] = await Promise.all([
    tsImport('../src/master.ts', here), tsImport('../src/master-daemon.ts', here), tsImport('../src/auto-dispatch.ts', here),
    tsImport('../src/executor.ts', here), tsImport('../src/reviewer.ts', here), tsImport('../src/producer.ts', here),
    tsImport('../src/model/next-action.ts', here), tsImport('../src/server/work-view.ts', here),
  ]);
  return { master, daemon, dispatch, executor, reviewer, producer, actions, view };
}

/**
 * The effects the handlers run actions with, built in one place so they can be held against stub
 * modules in a test rather than only against a live control plane.
 *
 * Every call here reaches the runtime through the asynchronous runner and every module call is
 * awaited (GY-125). The Herdr inventory read is the one to watch: `observeHerdrAgents` is async,
 * so reading `.available` off the promise rather than off its value is silently falsy — this
 * executor would claim every dispatch row and then report no agents at all, failing each one.
 */
export function controlPlaneEffects(modules, context) {
  const { master: m, daemon: d, reviewer: r, producer: pr } = modules;
  const { root, current, run, snapshot, mutate, mergeExecutor } = context;
  return {
    snapshot, mutate,
    agents: async () => { const runtime = await m.observeHerdrAgents(run); return runtime.available ? runtime.agents : null; },
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
    observeDeployment: delivered => d.observeDeployment(current(), delivered, run, fetch, () => Date.now(), { root }),
    recordSession: (work, handle) => mutate(`work/${work.id}/session`, handle),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const modules = await load();
  const { master: m, daemon: d, dispatch: a, executor: x, reviewer: r, producer: pr, actions: k, view: v } = modules;
  // Bounded, captured and awaited, exactly as the daemon runs its own children: a launch that
  // holds for its whole thirty-second timeout must not stop this process renewing the claim it
  // is holding while the launch runs.
  const run = m.childRunner({ timeoutMs: 90_000 });
  const root = (await run('git', ['rev-parse', '--show-toplevel'])).trim();
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
  const snapshot = () => request('work-snapshot', {}, { [v.coordinationViewHeader]: 'coordination' });
  const handlers = x.controlPlaneHandlers(current, controlPlaneEffects(modules, { root, current, run, snapshot, mutate, mergeExecutor }));
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
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try {
    const result = await a.runExecutor(identity, effects, { intervalMs: options.intervalSeconds * 1000, once: options.once, signal: stopping.signal, log: line => console.error(line) });
    const report = { executor: identity.id, host: identity.host, repository: config.repository, kinds: a.executorKinds(effects.handlers), intervalSeconds: options.intervalSeconds,
      steps: result.steps.length, ran: result.steps.filter(step => step.action).length, failed: result.steps.filter(step => step.result === 'failed').length, last: result.steps.at(-1) ?? null };
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally { for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
