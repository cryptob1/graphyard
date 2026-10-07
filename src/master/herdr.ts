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

export type HerdrAgent = { name?: string; pane_id?: string; workspace_id?: string; agent?: string | null; agent_status?: string; cwd?: string; foreground_cwd?: string; tokens?: Record<string, string> };

/**
 * The Herdr scope of this process (GY-1441): the one workspace its installation owns, set from the
 * master configuration whenever it is loaded. Several installations may share one Herdr server on a
 * host, and every sweep — idle-pane close, reclaim, liveness, tab cleanup — reads the inventories
 * below, so a pane another install's workspace holds is never listed, closed or pasted into here,
 * however its name or worktree path matches. A pane that names no workspace (a headless run, an
 * older Herdr) is never attributed elsewhere, and no configured workspace leaves the host unscoped.
 */
let processScope: string | null = null;
export function scopeHerdr(workspace: string | null | undefined) { processScope = workspace?.trim() || null; }
export const herdrScope = () => processScope;
/** The workspace a Herdr entry positively names: its workspace_id, else the `W:` prefix of its pane or tab id. */
export function herdrWorkspaceOf(entry: { workspace_id?: string; pane_id?: string; tab_id?: string } | string): string | null {
  if (typeof entry === 'string') return /^([^:\s]+):[^:\s]+$/.exec(entry)?.[1] ?? null;
  if (typeof entry.workspace_id === 'string' && entry.workspace_id) return entry.workspace_id;
  return herdrWorkspaceOf(entry.pane_id ?? entry.tab_id ?? '');
}
/** Whether ENTRY is this install's to act on: within SCOPE, or attributed to no workspace at all. */
export function inHerdrScope(entry: Parameters<typeof herdrWorkspaceOf>[0], scope: string | null = processScope) {
  if (!scope) return true;
  const workspace = herdrWorkspaceOf(entry);
  return workspace === null || workspace === scope;
}
/** Refuses, by name, a pane or tab another install's workspace holds. */
export function assertHerdrScope(target: string, scope: string | null = processScope) {
  if (!inHerdrScope(target, scope)) throw new Error(`Herdr ${target} belongs to workspace ${herdrWorkspaceOf(target)}, not this installation's workspace ${scope}; Graphyard never closes, pastes into or reclaims another install's pane`);
}
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
export async function listHerdrAgents(run?: ChildRun, scope: string | null = processScope): Promise<HerdrAgent[]> {
  return withRunnerAgents(((await herdrJson(['agent', 'list'], run)).agents ?? []).filter((agent: HerdrAgent) => inHerdrScope(agent, scope)));
}
export async function observeHerdrAgents(run?: ChildRun, scope: string | null = processScope) {
  try { return { agents: await listHerdrAgents(run, scope), available: true, reason: null }; }
  catch { return { agents: [] as HerdrAgent[], available: false, reason: 'Herdr session health is unavailable; Graphyard work state remains authoritative' }; }
}

/** One pane the host's runtime holds, as `herdr pane list` reports it (GY-842): with or without an agent in it. */
export interface HerdrPane { pane_id?: string; tab_id?: string; workspace_id?: string; title?: string }
/** Every pane in this install's scope (GY-842): the pane inventory the agent list does not stand in, since a pane a bare shell holds and a pane no session ever named are both real. */
export async function listHerdrPanes(run?: ChildRun, scope: string | null = processScope): Promise<HerdrPane[]> {
  const result = await herdrJson(['pane', 'list'], run);
  return Array.isArray(result?.panes) ? result.panes.filter((pane: HerdrPane) => inHerdrScope(pane, scope)) : [];
}

export async function closeHerdrPane(pane: string, run?: ChildRun, timeoutMs = 5_000, scope: string | null = processScope) {
  assertHerdrScope(pane, scope);
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
  assertHerdrScope(tab);
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
