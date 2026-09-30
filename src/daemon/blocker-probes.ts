// Concern: the probe of each environmental blocker class (GY-1008) — what it runs, and where: inside the confinement a worker gets.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Work } from '../model.js';
import type { MasterConfig } from '../master.js';
import type { ChildRun } from '../child-runner.js';
import type { BlockerClass, BlockerClassification } from '../model/blocker-class.js';
export type { BlockerClassification };
import { runtimeSandboxes } from '../worker-sandbox.js';

/** What the loop writes on the item for one probe (POST work/ID/blocker-probe). */
export interface BlockerProbeRecord { blocker: string; class: BlockerClass; probe: string; result: 'pass' | 'fail'; detail: string; nextAt: string | null }
/** The launch a worker gets: its runtime kind, the arguments that carry its sandbox, and its environment. */
export interface WorkerLaunch { kind?: string | null; args: string[]; environment?: Record<string, string> }
/** What one probe found: what it ran, whether the cause no longer stands, and what it saw. */
export interface BlockerProbeResult { probe: string; passed: boolean; detail: string; /** outside-scope-test-failure: the base tip the probe read. */ baseTip?: string }

/**
 * The command that runs `script` inside the confinement the worker's own launch describes: the
 * runtime's sandbox where its arguments select one (the same wrapper `verifyWorkerSandbox` probes
 * a launch through), and otherwise the script as the worker's shell would run it. A probe run any
 * other way would pass on the loop's own credentials and paths while the next attempt still fails.
 */
export function confinedCommand(launch: WorkerLaunch | null, cwd: string, script: string[]): { command: string; args: string[] } {
  const sandbox = launch?.kind ? runtimeSandboxes[launch.kind] : undefined;
  return sandbox && sandbox.mode(launch!.args) !== null ? sandbox.probe(launch!.args, cwd, script) : { command: script[0], args: script.slice(1) };
}

/** The credential probe: what the next attempt's first `gh` and `git push` meet. */
export const credentialScript = ['/bin/sh', '-c', 'gh auth status >/dev/null 2>&1 || { gh auth status 2>&1 | tail -n 3; exit 1; }; GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code origin HEAD >/dev/null'];
/** The write probe: the path, or the nearest directory above it that exists, can be written. */
export const writableScript = (path: string) => ['/bin/sh', '-c', 'p="$1"; while [ ! -e "$p" ]; do p=$(dirname "$p"); done; if [ -d "$p" ]; then f="$p/.graphyard-blocker-probe-$$"; : > "$f" && rm -f "$f"; else : >> "$p"; fi', 'sh', path];

export interface BlockerProbeDeps {
  run: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string> | string;
  /** Why the control plane cannot take a command now (its health verdict), or null when healthy. */
  planeHealth?: () => Promise<string | null>;
  /** The base branch's current tip. */
  baseTip?: () => Promise<string>;
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
    const where = command === script[0] ? 'the worker shell' : `the ${deps.launch?.kind} sandbox`;
    try { await deps.run(command, args, { cwd: deps.cwd, env }); return { probe: `${probe} inside ${where}`, passed: true, detail: `passed in ${deps.cwd}` }; }
    catch (error) { return { probe: `${probe} inside ${where}`, passed: false, detail: bound(firstLine(error)) }; }
  };
  switch (classification.class) {
    case 'github-credential': return confined('gh auth status and git ls-remote origin', credentialScript);
    case 'sandbox-path': {
      const path = classification.path ? (isAbsolute(classification.path) ? classification.path : resolve(deps.cwd, classification.path)) : deps.cwd;
      return confined(`write ${path}`, writableScript(path));
    }
    case 'control-plane-error': {
      if (!deps.planeHealth) return null;
      const refusal = await deps.planeHealth().catch(error => `the health read failed: ${firstLine(error)}`);
      return { probe: 'the Graphyard server health check', passed: !refusal, detail: refusal ? bound(refusal) : 'the server reports healthy' };
    }
    case 'worktree-mismatch': {
      const live = !!item.lease && Date.parse(item.lease.expiresAt) > deps.clock;
      return { probe: 'the blocked attempt has ended', passed: !live, detail: live ? `attempt ${item.lease!.epoch} still holds the lease` : `no attempt holds ${item.key}; the next one is given its own worktree` };
    }
    case 'outside-scope-test-failure': {
      if (!deps.baseTip) return null;
      try { const tip = (await deps.baseTip()).trim(); return { probe: 'the base branch has moved since the failure', passed: false, detail: `the base tip is ${tip.slice(0, 12)}`, baseTip: tip }; }
      catch (error) { return { probe: 'the base branch has moved since the failure', passed: false, detail: bound(`the base tip could not be read: ${firstLine(error)}`) }; }
    }
    default: return null;
  }
}

/**
 * The probe as the loop wires it: the worker profile the next attempt would get (the blocked
 * attempt's own, else the first launch profile), run in the attempt's worktree when it is on this
 * host and in this checkout otherwise, with the base tip read from `origin`.
 */
export function loopBlockerProbe(config: MasterConfig, root: string, run: ChildRun, planeHealth: () => Promise<string | null>) {
  return (work: Work, classification: BlockerClassification) => {
    const holder = work.lease?.owner ?? work.lastAssignment?.owner;
    const launched = config.workers.filter(worker => worker.mode === 'launch');
    const profile = launched.find(worker => worker.principal === holder) ?? launched[0];
    const workspace = work.workspaces.find(entry => entry.epoch === work.epoch && entry.host === config.hostId);
    return probeBlocker(work, classification, { run: (command, args, options) => run(command, args, { ...options, timeoutMs: 30_000 }), planeHealth,
      baseTip: async () => String(await run('git', ['-C', root, 'ls-remote', 'origin', `refs/heads/${config.baseBranch}`])).split(/\s/)[0] ?? '',
      launch: profile ? { kind: profile.kind, args: profile.agentArgs ?? [], environment: profile.environment } : null,
      cwd: workspace && existsSync(workspace.path) ? workspace.path : root, clock: Date.now() });
  };
}
