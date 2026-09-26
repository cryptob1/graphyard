// The stateless executor (GY-87). Claims one typed action from the control plane, runs it,
// reports the result, and repeats. It keeps nothing between claims and is configured with no peer
// list, so any number of these run on any number of hosts against the same queue; none of them is
// a master, and killing one costs the claim it held and nothing else.
//
//   node scripts/graphyard-executor.mjs [--once] [--interval SECONDS] [--kinds a,b] [--name NAME] [--unit UNIT]
//   node scripts/graphyard-executor.mjs --slot N                 # one supervised slot (GY-105)
//   node scripts/graphyard-executor.mjs --install [--count N] [--kinds a,b] [--interval SECONDS]
//
// It reads this host's .graphyard/master.json for the launch profiles the dispatching actions
// need and authenticates with the coordinator credential named there — the same credential
// `master run` uses, and nothing broader. `--kinds` narrows what this executor claims; the
// default is every kind it has a handler for. Two kinds can never be among them: `escalate` and
// `request-rework` are judgments made in the step itself, and the process refuses to start with a
// handler for either, which is what keeps a language model out of the loop rather than inside it.
//
// Under supervision (GY-105) the host declares how many executors it runs and of which kinds in
// .graphyard/executors.json, and the shipped systemd template examples/master/graphyard-executor@.service
// starts one instance per slot with `--slot N`: the slot takes its kinds and poll interval from the
// declaration, claims under a stable name, and answers systemd's watchdog on every poll — whether
// or not it claims — every settlement and every claim renewal (GY-646). `--install` writes that declaration and enables the units (src/repository-setup.ts
// installExecutorSupervision); `graphyard init` does the same on a coordinator host. Exactly one
// component merges (GY-245): where the master loop is installed or running, `--install` declares
// every kind but `merge`, and a slot that still serves merge refuses merge rows while the loop lives.
//
// The modules are loaded once, here, and the checkout they came from keeps moving (GY-126). The
// process records the release it loaded beside the coordinator credential, re-reads the checkout's
// commit before every claim, and stands down — finishing what it runs, claiming nothing more,
// saying why and how to restart it — the moment the two differ; under a supervisor that restarts it
// the stand-down is a clean exit (status 0), so the unit brings it back on the new code. `--unit` names the systemd user
// unit it runs under when that cannot be read from the process itself (only a graphyard-executor
// service is accepted); `graphyard master executors restart` restarts every registered executor
// through that unit, and no claim starts while its fence stands.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { once: false, intervalSeconds: null, kinds: null, name: null, slot: null, install: false, count: null, unit: null };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--once') options.once = true;
    else if (argument === '--interval') options.intervalSeconds = Number(value());
    else if (argument === '--kinds') options.kinds = value().split(',').map(kind => kind.trim()).filter(Boolean);
    else if (argument === '--name') options.name = value();
    else if (argument === '--slot') options.slot = Number(value());
    else if (argument === '--install') options.install = true;
    else if (argument === '--count') options.count = Number(value());
    else if (argument === '--unit') options.unit = value();
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (options.intervalSeconds !== null && (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 1 || options.intervalSeconds > 900)) throw new Error('--interval takes whole seconds between 1 and 900');
  if (options.slot !== null && (!Number.isInteger(options.slot) || options.slot < 1)) throw new Error('--slot takes a whole number from 1');
  if (options.count !== null && (!Number.isInteger(options.count) || options.count < 0)) throw new Error('--count takes a whole number from 0');
  if (options.count !== null && !options.install) throw new Error('--count only goes with --install');
  if (options.slot !== null && (options.install || options.name)) throw new Error('--slot names a supervised slot; it takes no --install or --name');
  return options;
}

/**
 * systemd's keep-alive channel, spoken only when the supervisor set NOTIFY_SOCKET (see the master
 * loop's `notify` effect for why it goes through `systemd-notify`). A notification that fails is
 * logged, never fatal: the executor is still doing its work, and the watchdog decides on the window.
 */
export function supervisorNotifier(env = process.env, run, log = line => console.error(line)) {
  if (!env.NOTIFY_SOCKET) return null;
  // Through the process's asynchronous runner (GY-125), never a synchronous child: a notification
  // is fire-and-forget, and one that fails is logged rather than awaited.
  return state => { Promise.resolve().then(() => run('systemd-notify', state === 'ready' ? ['--ready'] : ['WATCHDOG=1'], { timeoutMs: 10_000 })).catch(error => log(`[graphyard-executor] supervisor notification failed: ${error.message}`)); };
}

/** The TypeScript modules this process is a thin entry point for; tsx is a runtime dependency already. */
export async function load() {
  const { tsImport } = await import('tsx/esm/api');
  const here = import.meta.url;
  const [master, daemon, dispatch, executor, reviewer, producer, actions, view, setup, fleet] = await Promise.all([
    tsImport('../src/master.ts', here), tsImport('../src/master-daemon.ts', here), tsImport('../src/auto-dispatch.ts', here),
    tsImport('../src/executor.ts', here), tsImport('../src/reviewer.ts', here), tsImport('../src/producer.ts', here),
    tsImport('../src/model/next-action.ts', here), tsImport('../src/server/work-view.ts', here), tsImport('../src/repository-setup.ts', here), tsImport('../src/executor-fleet.ts', here),
  ]);
  return { master, daemon, dispatch, executor, reviewer, producer, actions, view, setup, fleet };
}

/** An exit status the supervisor reads: a slot the declaration does not have stays down instead of flapping. */
class SlotUndeclared extends Error { constructor(message, exitCode) { super(message); this.exitCode = exitCode; } }

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
  const { master: m, daemon: d, dispatch: a, executor: x, reviewer: r, producer: pr, actions: k, view: v, setup: s, fleet: f } = modules;
  // Bounded, captured and awaited, exactly as the daemon runs its own children: a launch that
  // holds for its whole thirty-second timeout must not stop this process renewing the claim it
  // is holding while the launch runs.
  const run = m.childRunner({ timeoutMs: 90_000 });
  const root = (await run('git', ['rev-parse', '--show-toplevel'])).trim();
  if (options.install) {
    // Only a coordinator host can run an executor at all: without master.json every unit this
    // enables would fail on start and be restarted every ten seconds.
    await m.loadMasterConfig(root);
    const installed = await s.installExecutorSupervision(root, { ...(options.count !== null ? { count: options.count } : {}), ...(options.kinds ? { kinds: options.kinds } : {}), ...(options.intervalSeconds !== null ? { intervalSeconds: options.intervalSeconds } : {}) });
    console.log(JSON.stringify(installed, null, 2));
    return installed;
  }
  // A supervised slot is configured by the host's declaration, not by its command line, so every
  // slot on a host serves the same kinds and a change to the declaration reaches all of them.
  if (options.slot !== null) {
    const declaration = await s.readExecutorDeclaration(root);
    if (!declaration) throw new SlotUndeclared(`This host declares no executors (${s.executorDeclarationFile} is missing); node scripts/graphyard-executor.mjs --install --count N declares them`, s.executorSlotUndeclaredExit);
    if (options.slot > declaration.count) throw new SlotUndeclared(`Slot ${options.slot} is above this host's declared count of ${declaration.count}; raise it with node scripts/graphyard-executor.mjs --install --count ${options.slot}, or disable ${s.executorUnit(options.slot)}`, s.executorSlotUndeclaredExit);
    options.kinds ??= declaration.kinds;
    options.intervalSeconds ??= declaration.intervalSeconds;
  }
  options.intervalSeconds ??= 5;
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

  const notify = supervisorNotifier(env, run);
  const alive = () => notify?.('alive');
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
  // A supervised slot claims under a stable name, so a restart is the same executor coming back
  // rather than a new one appearing beside a ghost; the pid says which incarnation is speaking.
  const identity = { id: options.name ?? (options.slot !== null ? `${status.actor.id}@${config.hostId}/${options.slot}` : `${status.actor.id}@${config.hostId}:${process.pid}`), host: config.hostId };
  // The release these modules were loaded from, recorded on this host before the first claim and
  // refreshed on every claim; the commit is re-read from the checkout in front of each claim.
  const release = f.readRelease(root);
  const registrar = f.executorRegistrar(config, { name: identity.id, host: identity.host, pid: process.pid, principal: status.actor.id, kinds: a.executorKinds(effects.handlers),
    intervalSeconds: options.intervalSeconds, root, release, supervisor: f.detectSupervisorUnit({ named: options.unit }) });
  await registrar.started();
  let fenceSeen = null;
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  // Under a supervisor that restarts it (systemd's NOTIFY_SOCKET, or a graphyard-executor unit),
  // a stand-down is an exit (GY-646): the process has nothing more to claim on this release, and
  // the unit's Restart=always brings it back on the checkout's current code within RestartSec.
  // Idling instead left the watchdog to abort it with SIGABRT and a core dump. An executor run by
  // hand keeps standing down, since nothing would start it again.
  const supervised = !!notify || !!registrar.registration.supervisor;
  // Exactly one component merges (GY-245): while a live master loop on this installation runs the
  // guarded merge, this executor leaves merge rows to it rather than claiming one, since the claim
  // itself writes the item and defeats the loop's revision check.
  const single = x.loopMergeGuardedEffects(effects, () => x.detectLoopMerger(root, { config: current() }), line => console.error(line));
  const guarded = x.releaseGuardedEffects(single, {
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
    standDown: async detail => {
      console.error(`[graphyard-executor] ${identity.id} stands down: ${detail.reason}; ${supervised ? `it exits so ${registrar.registration.supervisor?.unit ?? 'its supervisor'} restarts it on the current code` : `restart it with ${registrar.registration.supervisor?.restart ?? f.executorRestartCommand}`}`);
      try { return await registrar.standDown(detail); } finally { if (supervised) stop(); }
    },
    resumed: () => { console.error(`[graphyard-executor] ${identity.id} claims again: its checkout is back on ${release.commit.slice(0, 12)}`); return registrar.resumed(); },
  });
  console.error(`[graphyard-executor] ${identity.id} runs ${release.commit ? release.commit.slice(0, 12) : 'an unknown commit'}${release.dirty ? ' (dirty)' : ''} from ${root}${registrar.registration.supervisor ? ` under ${registrar.registration.supervisor.unit}` : ' with no supervisor unit'}; registered at ${registrar.file}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  notify?.('ready');
  console.error(`[graphyard-executor] ${identity.id} (pid ${process.pid}) serving ${a.executorKinds(effects.handlers).join(', ')} every ${options.intervalSeconds}s${options.slot !== null ? ` as slot ${options.slot}` : ''}${notify ? ' under systemd supervision' : ''}`);
  try {
    // Under systemd every step is a keep-alive — every claim (made, fenced, refused or standing
    // down), settlement and claim renewal (x.watchdogEffects): a process whose event loop wedged
    // stops sending them and is restarted, while a slow handler that still renews is left alone.
    const result = await a.runExecutor(identity, x.watchdogEffects(guarded, alive), { intervalMs: options.intervalSeconds * 1000, once: options.once, signal: stopping.signal, log: line => console.error(line) });
    const report = { executor: identity.id, host: identity.host, pid: process.pid, slot: options.slot, repository: config.repository, kinds: a.executorKinds(effects.handlers), intervalSeconds: options.intervalSeconds,
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

// The entry check follows symlinks: a checkout may reach the shipped scripts through a link, and
// Node resolves the module URL to the real path.
const entry = (() => { try { return process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null; } catch { return null; } })();
if (entry === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = error.exitCode ?? 1; });
