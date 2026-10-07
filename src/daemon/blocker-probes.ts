// Concern: the probe of each environmental blocker class (GY-1008) — what it runs, and where: inside the confinement a worker gets.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import type { ChildRun } from '../child-runner.js';
import type { BlockerClass, BlockerClassification } from '../model/blocker-class.js';
export type { BlockerClassification };
import { grantWorkerPaths, runtimeSandboxes, workerPaths, writablePaths } from '../worker-sandbox.js';
import type { WorkerProfile } from '../master/profiles.js';
import { accountLaunch, checkAgentEnvironment, readEnvironmentLog, selectionKey, sharedGitDirectory, type LaunchAccount } from '../master/environments.js';
import { readFleet, type FleetLaunchAccount, type FleetProbe } from '../fleet.js';
import { rolePolicy } from '../model/registry.js';
import { sessionConfinement } from '../master/launch.js';
import { loopUnitName } from '../supervisor.js';

/** What the loop writes on the item for one probe (POST work/ID/blocker-probe). */
export interface BlockerProbeRecord { blocker: string; class: BlockerClass; probe: string; result: 'pass' | 'fail'; detail: string; nextAt: string | null }
/** The launch a worker gets: its runtime kind, the arguments that carry its sandbox, its environment, and the coordinator confinement words placed before its runtime (GY-888). */
export interface WorkerLaunch { kind?: string | null; args: string[]; environment?: Record<string, string>; confinement?: readonly string[] }
/** What one probe found: what it ran, whether the cause no longer stands, and what it saw. */
export interface BlockerProbeResult { probe: string; passed: boolean; detail: string; /** outside-scope-test-failure: the base tip the probe read. */ baseTip?: string;
  /** outside-scope-test-failure: the base commit the blocked attempt's branch was built on, the one its suite failed on, when its worktree is here. */ failedOn?: string }

/**
 * The command that runs `script` inside the confinement the worker's own launch describes: the
 * runtime's sandbox where its arguments select one (the same wrapper `verifyWorkerSandbox` probes
 * a launch through), and otherwise the script as the worker's shell would run it — in both cases
 * behind the coordinator confinement words the launch carries (the GY-888 read-only mount every
 * non-sandboxed runtime starts inside). A probe run any other way would pass on the loop's own
 * credentials and paths while the next attempt still fails.
 */
export function confinedCommand(launch: WorkerLaunch | null, cwd: string, script: string[]): { command: string; args: string[] } {
  const sandbox = launch?.kind ? runtimeSandboxes[launch.kind] : undefined;
  const inner = sandbox && sandbox.mode(launch!.args) !== null ? sandbox.probe(launch!.args, cwd, script) : { command: script[0], args: script.slice(1) };
  const wrapper = launch?.confinement ?? [];
  return wrapper.length ? { command: wrapper[0], args: [...wrapper.slice(1), inner.command, ...inner.args] } : inner;
}
/** Where `confinedCommand` runs a probe, in words. */
export function confinementName(launch: WorkerLaunch | null): string {
  const sandbox = launch?.kind ? runtimeSandboxes[launch.kind] : undefined;
  if (sandbox && sandbox.mode(launch!.args) !== null) return `the ${launch!.kind} sandbox`;
  return launch?.confinement?.length ? `the ${launch.kind} worker's read-only coordinator mount` : 'the worker shell';
}

/**
 * The credential probe: what the next attempt's first `gh` and `git push` meet. The push is a dry
 * run of a branch name no attempt uses, so it asks the remote for write access (a read-only token
 * is refused there) and changes nothing.
 */
export const credentialScript = ['/bin/sh', '-c', 'gh auth status >/dev/null 2>&1 || { gh auth status 2>&1 | tail -n 3; exit 1; }; GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code origin HEAD >/dev/null && GIT_TERMINAL_PROMPT=0 git push --dry-run --no-verify --quiet origin HEAD:refs/heads/graphyard/blocker-probe'];
/** The write probe: the path, or the nearest directory above it that exists, can be written. */
export const writableScript = (path: string) => ['/bin/sh', '-c', 'p="$1"; while [ ! -e "$p" ]; do p=$(dirname "$p"); done; if [ -d "$p" ]; then f="$p/.graphyard-blocker-probe-$$"; : > "$f" && rm -f "$f"; else : >> "$p"; fi', 'sh', path];

export interface BlockerProbeDeps {
  run: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string> | string;
  /** Why the control plane cannot take a command now (its health verdict), or null when healthy. */
  planeHealth?: () => Promise<string | null>;
  /** The base branch's current tip. */
  baseTip?: () => Promise<string>;
  /** The base commit the blocked attempt's branch was built on, when its worktree is on this host. */
  failedBase?: () => Promise<string | null>;
  /** The launch of the worker profile the next attempt would get. */
  launch: WorkerLaunch | null;
  /** Where the next attempt runs: the blocked attempt's worktree on this host, else this checkout. */
  cwd: string;
  clock: number;
}

const firstLine = (error: unknown) => {
  const failure = error as { stderr?: unknown; stdout?: unknown; message?: string } | null;
  return `${failure?.stderr ?? ''}`.trim() || `${failure?.stdout ?? ''}`.trim() || failure?.message || String(error);
};
const bound = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 400);

/** Runs the probe of one environmental class for `item`; a class with no probe answers null. */
export async function probeBlocker(item: Work, classification: BlockerClassification, deps: BlockerProbeDeps): Promise<BlockerProbeResult | null> {
  const env = { ...process.env, ...(deps.launch?.environment ?? {}), GIT_TERMINAL_PROMPT: '0' };
  const confined = async (probe: string, script: string[]) => {
    const { command, args } = confinedCommand(deps.launch, deps.cwd, script);
    const where = confinementName(deps.launch);
    try { await deps.run(command, args, { cwd: deps.cwd, env }); return { probe: `${probe} inside ${where}`, passed: true, detail: `passed in ${deps.cwd}` }; }
    catch (error) { return { probe: `${probe} inside ${where}`, passed: false, detail: bound(firstLine(error)) }; }
  };
  switch (classification.class) {
    case 'github-credential': return confined('gh auth status and git ls-remote origin', credentialScript);
    case 'sandbox-path': {
      const path = await refusedPathIn(classification.path, deps);
      return confined(`write ${path}`, writableScript(path));
    }
    case 'control-plane-error': {
      if (!deps.planeHealth) return null;
      const refusal = await deps.planeHealth().catch(error => `the health read failed: ${firstLine(error)}`);
      return { probe: 'the Graphyard server health check', passed: !refusal, detail: refusal ? bound(refusal) : 'the server reports healthy' };
    }
    case 'host-supervisor': {
      // GY-1406: the host's state, read from the host. The worker's sandbox masks the user bus, so
      // its failure says nothing about the host; the loop runs there, outside any worker confinement.
      const probe = `systemctl --user show-environment and is-active ${loopUnitName} on the loop's host`;
      try {
        await deps.run('systemctl', ['--user', 'show-environment'], { cwd: deps.cwd, env });
        await deps.run('systemctl', ['--user', 'is-active', '--quiet', loopUnitName], { cwd: deps.cwd, env });
        return { probe, passed: true, detail: `the user manager answers and ${loopUnitName} is active; the worker sandbox masks the user bus, not the host` };
      } catch (error) { return { probe, passed: false, detail: bound(firstLine(error)) }; }
    }
    case 'worktree-mismatch': {
      const live = !!item.lease && Date.parse(item.lease.expiresAt) > deps.clock;
      return { probe: 'the blocked attempt has ended', passed: !live, detail: live ? `attempt ${item.lease!.epoch} still holds the lease` : `no attempt holds ${item.key}; the next one is given its own worktree` };
    }
    case 'outside-scope-test-failure': {
      if (!deps.baseTip) return null;
      try {
        const tip = (await deps.baseTip()).trim();
        // The base the failure was met on is the attempt's own, read from its branch, so a base that
        // moved before the loop's first probe still counts as moved (GY-1055).
        const failedOn = (await deps.failedBase?.().catch(() => null))?.trim() || null;
        return { probe: 'the base branch has moved since the failure', passed: false, detail: `the base tip is ${tip.slice(0, 12)}`, baseTip: tip, ...(failedOn && /^[0-9a-f]{40}$/.test(failedOn) ? { failedOn } : {}) };
      }
      catch (error) { return { probe: 'the base branch has moved since the failure', passed: false, detail: bound(`the base tip could not be read: ${firstLine(error)}`) }; }
    }
    default: return null;
  }
}

/**
 * Where a refused path is: an absolute path as named, and a `.git/...` path the way Git itself
 * resolves it in the worktree (`git rev-parse --git-path`). In a linked worktree `.git` is a file
 * and refs, their logs and objects live in the shared Git directory, so `<worktree>/.git/logs/...`
 * would probe the pointer file and pass while the shared directory stays read-only. Any other
 * relative path is the worktree's own.
 */
async function refusedPathIn(path: string | null, deps: Pick<BlockerProbeDeps, 'run' | 'cwd'>) {
  if (!path) return deps.cwd;
  if (isAbsolute(path)) return path;
  const inGit = /^\.git(?:\/(.*))?$/.exec(path.replace(/^\.\//, ''));
  if (!inGit) return resolve(deps.cwd, path);
  try {
    const resolved = String(await deps.run('git', ['rev-parse', '--path-format=absolute', ...(inGit[1] ? ['--git-path', inGit[1]] : ['--git-dir'])], { cwd: deps.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).trim();
    return resolved ? resolve(deps.cwd, resolved) : resolve(deps.cwd, path);
  } catch { return resolve(deps.cwd, path); }
}

/**
 * The account the blocked attempt ran on, so its probe meets the same runtime, arguments and
 * environment. The registry's session for the item on this host when the registry decides the
 * worker role (else the role's first enabled account here); otherwise the account the environment
 * log recorded choosing for this item, else the profile's first configured account. Nothing is
 * selected or reserved: a probe never takes a session or a slot.
 */
export async function blockedAttemptAccount(config: MasterConfig, work: Work, profile: WorkerProfile, probe: FleetProbe = {}): Promise<LaunchAccount | null> {
  const fleet = await readFleet(config, 'worker', probe);
  if (fleet.managed) {
    const { registry } = fleet, role = registry.roles.find(entry => entry.name === 'worker');
    const session = registry.sessions.filter(entry => entry.role === 'worker' && entry.work === work.key && entry.host === config.hostId).sort((a, b) => Date.parse(b.selectedAt) - Date.parse(a.selectedAt))[0];
    const account = registry.accounts.find(entry => session ? entry.name === session.account : !!role?.accounts.includes(entry.name) && entry.enabled && entry.credential.host === config.hostId);
    const runtime = registry.runtimes.find(entry => entry.name === (session?.runtime ?? account?.runtime));
    const model = registry.models.find(entry => entry.name === (session?.model ?? rolePolicy(role).model ?? account?.model));
    if (!account || !runtime) throw new Error(`the agent registry names no worker account on host ${config.hostId} to probe ${work.key}'s blocker under`);
    return { name: account.name, kind: runtime.launch.kind, home: account.credential.home, key: account.credential.key ?? null,
      fleet: { runtime: runtime.name, contract: runtime.launch, model: model?.name ?? account.model, modelId: model?.id ?? null, session: session?.id ?? 'blocker-probe', reason: `blocker probe for ${work.key}`, role: 'worker', policy: rolePolicy(role), revision: registry.revision } } satisfies FleetLaunchAccount;
  }
  const log = await readEnvironmentLog(config);
  const chosen = log.selected[selectionKey('worker', profile.name)];
  const environments = config.environments ?? [];
  const configured = (name: string) => environments.find(entry => entry.name === name);
  if (chosen?.work === work.key && chosen.environment && configured(chosen.environment)) return configured(chosen.environment)!;
  // The log keeps one selection per profile, so a later launch for another item replaced this one's.
  // The retry's account is then the one dispatch's `selectAccount` would choose now: the first
  // configured account no session saw spent whose login and quota check healthy (GY-1055). Read
  // only: nothing is recorded or reserved. When none is healthy no retry launches; the first stands.
  const now = probe.now?.() ?? Date.now();
  const held = Object.fromEntries(Object.entries(log.exhausted ?? {}).filter(([, entry]) => Date.parse(entry.until) > now));
  const candidates = (profile.accounts ?? []).map(configured).filter((entry): entry is NonNullable<typeof entry> => !!entry);
  for (const environment of candidates) {
    if (held[environment.name]) continue;
    if ((await checkAgentEnvironment(environment, { ...probe, ceilingPercent: probe.ceilingPercent ?? config.run.quotaCeilingPercent }).catch(() => null))?.healthy) return environment;
  }
  return candidates[0] ?? null;
}

/**
 * The launch profile the blocked attempt ran under. Several profiles may share a principal, so the
 * principal alone does not name it: the attempt's own session handle records its agent name, and
 * the environment log the profile whose latest worker launch was for this item. Only when neither
 * says is it the first launch profile of the principal, else the first launch profile.
 */
export async function blockedAttemptProfile(config: MasterConfig, work: Work): Promise<WorkerProfile | undefined> {
  const holder = work.lease?.owner ?? work.lastAssignment?.owner;
  const epoch = work.lease?.epoch ?? work.lastAssignment?.epoch ?? work.epoch;
  const launched = config.workers.filter(worker => worker.mode === 'launch');
  const owned = launched.filter(worker => worker.principal === holder);
  const sessions = (work.sessions ?? []).filter(session => session.kind === 'implementation' && session.principal === holder && session.agentName);
  const session = sessions.find(entry => entry.id === `${holder}:${epoch}`) ?? sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  const named = session ? owned.find(worker => worker.agentName === session.agentName) : undefined;
  if (named) return named;
  if (owned.length > 1) {
    const selected = (await readEnvironmentLog(config).catch(() => null))?.selected ?? {};
    const latest = owned.filter(worker => selected[selectionKey('worker', worker.name)]?.work === work.key)
      .sort((a, b) => Date.parse(selected[selectionKey('worker', b.name)].at) - Date.parse(selected[selectionKey('worker', a.name)].at))[0];
    if (latest) return latest;
  }
  return owned[0] ?? launched[0];
}

/**
 * The launch a worker on `profile` gets for `work`, built as dispatch builds it: its account's
 * `accountLaunch`, then every path the worker writes in `cwd` — the worktree, its own Git admin
 * directory and the shared one — granted to the runtime's sandbox (`grantWorkerPaths`), then the
 * coordinator confinement `startAgentSession` wraps every worker in (`sessionConfinement`, GY-888).
 * `coordinatorRoot` defaults to the launcher's own checkout, as a worker launch's does; a launch
 * that could carry no confinement throws its refusal, so the probe fails rather than running bare.
 */
export async function blockedAttemptLaunch(config: MasterConfig, root: string, work: Work, profile: WorkerProfile, cwd: string, probe: FleetProbe = {}, coordinatorRoot?: string | null): Promise<WorkerLaunch> {
  const launch = accountLaunch(profile, await blockedAttemptAccount(config, work, profile, probe));
  const paths = workerPaths(cwd);
  const writable = writablePaths({ ...paths, commonDir: paths.commonDir ?? await sharedGitDirectory(root) });
  const args = grantWorkerPaths(launch.kind, launch.args, writable, cwd);
  const confinement = await sessionConfinement(launch.kind!, args, { directory: cwd }, coordinatorRoot);
  return { kind: launch.kind, args, environment: launch.environment, ...(confinement?.wrapper.length ? { confinement: confinement.wrapper } : {}) };
}

/** The classes whose probe runs inside the worker's confinement, and so needs its launch. */
const confinedClasses: readonly BlockerClass[] = ['github-credential', 'sandbox-path'];

/**
 * The probe as the loop wires it: the worker profile the next attempt would get (the blocked
 * attempt's own, else the first launch profile) and the launch dispatch would give it
 * (`blockedAttemptLaunch`), run in the attempt's worktree when it is on this host and in this
 * checkout otherwise, with the base tip read from `origin`. A launch that cannot be built is a
 * failing probe naming why, never a pass.
 */
export function loopBlockerProbe(config: MasterConfig, root: string, run: ChildRun, planeHealth: () => Promise<string | null>, probe: FleetProbe = {}, coordinatorRoot?: string | null) {
  return async (work: Work, classification: BlockerClassification): Promise<BlockerProbeResult | null> => {
    const profile = await blockedAttemptProfile(config, work);
    const workspace = work.workspaces.find(entry => entry.epoch === work.epoch && entry.host === config.hostId);
    const cwd = workspace && existsSync(workspace.path) ? workspace.path : root;
    let launch: WorkerLaunch | null = null;
    if (profile && confinedClasses.includes(classification.class)) {
      try { launch = await blockedAttemptLaunch(config, root, work, profile, cwd, probe, coordinatorRoot); }
      catch (error) { return { probe: `the worker launch for ${work.key}`, passed: false, detail: bound(`the launch the next attempt would get cannot be built: ${firstLine(error)}`) }; }
    }
    return probeBlocker(work, classification, { run: (command, args, options) => run(command, args, { ...options, timeoutMs: 30_000 }), planeHealth,
      baseTip: async () => String(await run('git', ['-C', root, 'ls-remote', 'origin', `refs/heads/${config.baseBranch}`])).split(/\s/)[0] ?? '',
      failedBase: async () => cwd === root ? null : String(await run('git', ['-C', cwd, 'merge-base', 'HEAD', `refs/remotes/origin/${config.baseBranch}`])).trim() || null,
      launch, cwd, clock: Date.now() });
  };
}
