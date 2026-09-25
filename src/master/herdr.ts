// Concern: the Herdr runtime adapter — workspace health, agent inventory, panes and tabs.
import { setTimeout as sleep } from 'node:timers/promises';
import { type ChildRun, defaultChildTimeoutMs, type BoundChildRun, childRunner, defaultChildRun } from '../child-runner.js';
import type { MasterConfig } from './profiles.js';
import { withRunnerAgents } from '../runner/registry.js';

/**
 * The configured Herdr workspace, checked against Herdr's own inventory: a workspace closed since
 * `master init` makes every launch refuse, so status names it before a launch does.
 */
export async function herdrWorkspaceHealth(config: Pick<MasterConfig, 'herdrWorkspace'>, run?: ChildRun) {
  if (!config.herdrWorkspace) return { workspace: null, exists: null as boolean | null, reason: null as string | null };
  let workspaces: any[];
  try { const listed = await herdrJson(['workspace', 'list'], run); workspaces = Array.isArray(listed?.workspaces) ? listed.workspaces : []; }
  catch { return { workspace: config.herdrWorkspace, exists: null, reason: 'Herdr could not list workspaces, so the configured workspace is unverified' }; }
  const exists = workspaces.some(entry => entry?.workspace_id === config.herdrWorkspace);
  return { workspace: config.herdrWorkspace, exists, reason: exists ? null : `Herdr workspace ${config.herdrWorkspace} configured in .graphyard/master.json no longer exists (Herdr lists ${workspaces.map(entry => entry?.workspace_id).filter(Boolean).join(', ') || 'none'}); every launch into it will refuse. Set herdrWorkspace to a live workspace, or rerun master init --herdr-workspace ID` };
}

export type HerdrAgent = { name?: string; pane_id?: string; agent?: string | null; agent_status?: string; cwd?: string; foreground_cwd?: string; tokens?: Record<string, string> };
/**
/**
 * Every Herdr call the coordinator makes. `run` is the asynchronous runner (child-runner.ts) —
 * or a test's stub — and is always awaited: a session start that takes its whole thirty-second
 * bound, or the start bound's 120-second ceiling (awaitRuntimeStart), delays only the launch
 * that asked for it, never the cycle's reads beside it (GY-125).
 *
 * Every call is also bounded (GY-114): a runtime that accepts a call and never answers must fail
 * that step rather than hold it, so the cycle records the failure, moves past it, and the process
 * still answers the SIGTERM its supervisor sends. The bound is the same 90s the runner applies to
 * every child, and it sits above every inner wait Herdr is asked for (a 30s `agent start`, three
 * 20s prompt deliveries), so it can only fire on a runtime that has stopped answering.
 */
export const agentRuntimeTimeoutMs = defaultChildTimeoutMs;
export const agentRuntimeRun = (timeoutMs: number = agentRuntimeTimeoutMs): BoundChildRun => childRunner({ timeoutMs });
export async function herdrJson(args: string[], run: ChildRun = defaultChildRun) {
  const parsed = JSON.parse(await run('herdr', args));
  if (parsed.error) throw Object.assign(new Error(`Herdr refused the operation: ${parsed.error.message ?? parsed.error}`), { herdrCode: typeof parsed.error.code === 'string' ? parsed.error.code : undefined });
  return parsed.result ?? parsed;
}
export async function herdrRun(args: string[], run: ChildRun = defaultChildRun) { await run('herdr', args); }
// The headless runs this process started (GY-169) are listed beside Herdr's sessions, so every
// supervision that reads the inventory sees a live run under its session name and an ended one as gone.
export async function listHerdrAgents(run?: ChildRun): Promise<HerdrAgent[]> { return withRunnerAgents((await herdrJson(['agent', 'list'], run)).agents ?? []); }
export async function observeHerdrAgents(run?: ChildRun) {
  try { return { agents: await listHerdrAgents(run), available: true, reason: null }; }
  catch { return { agents: [] as HerdrAgent[], available: false, reason: 'Herdr session health is unavailable; Graphyard work state remains authoritative' }; }
}

export async function closeHerdrPane(pane: string, run?: ChildRun, timeoutMs = 5_000) {
  await herdrJson(['pane', 'close', pane], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await herdrJson(['pane', 'list'], run);
    if (!Array.isArray(result.panes)) throw new Error('Herdr did not return a pane inventory after close');
    if (!result.panes.some((candidate: any) => candidate.pane_id === pane)) return;
    await sleep(100);
  }
  throw new Error(`Herdr still reports pane ${pane} after close`);
}

export function createdHerdrTab(result: any) {
  const pane = result?.root_pane?.pane_id ?? result?.pane_id ?? result?.pane?.id ?? result?.tab?.pane_id;
  const tab = result?.tab?.tab_id ?? result?.tab_id ?? result?.root_pane?.tab_id;
  if (typeof pane !== 'string' || !pane.trim()) throw Object.assign(new Error('Herdr did not return a valid new pane'), { herdrTab: typeof tab === 'string' && tab.trim() ? tab : undefined });
  return { pane, tab: typeof tab === 'string' && tab.trim() ? tab : undefined };
}

export async function stopCreatedHerdrTab(pane: string | undefined, tab: string | undefined, run?: ChildRun, timeoutMs = 5_000) {
  if (pane) return closeHerdrPane(pane, run);
  if (!tab) throw new Error('Herdr did not identify the created tab, so cleanup cannot be confirmed');
  await herdrJson(['tab', 'close', tab], run);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await herdrJson(['tab', 'list'], run);
    if (!Array.isArray(result.tabs)) throw new Error('Herdr did not return a tab inventory after close');
    if (!result.tabs.some((candidate: any) => candidate.tab_id === tab)) return;
    await sleep(100);
  }
  throw new Error(`Herdr still reports tab ${tab} after close`);
}
