// Concern: the Herdr runtime adapter — the instance every herdr call targets, workspace health, agent inventory, panes and tabs.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ChildRun, type ChildRunOptions, defaultChildTimeoutMs, type BoundChildRun, childRunner, defaultChildRun } from '../child-runner.js';
import type { MasterConfig } from './profiles.js';
import { withRunnerAgents } from '../runner/registry.js';
import { herdrConnectCommands } from '../herdr-connect.js';

/**
 * A Herdr instance of an install's own (GY-1511). Herdr keeps its graphyard plugin binding under
 * XDG_CONFIG_HOME, which every session on a host shares, so a second install on a host cannot bind
 * the default instance's plugin without taking it from the first. Its own config home isolates the
 * binding, and its own named session isolates the server (and its socket); the host's default
 * instance is never touched.
 */
export interface HerdrInstance { configHome: string; session: string }
/** The environment that names the instance to a process the install starts (a pane's supervisor inherits it from the instance's server). */
export const herdrInstanceEnv = { configHome: 'GRAPHYARD_HERDR_CONFIG_HOME', session: 'GRAPHYARD_HERDR_SESSION' } as const;
/** The instance an install whose default Herdr serves another install creates: ~/.config/graphyard/INSTALL/herdr, session graphyard-INSTALL. */
export function installHerdrInstance(installId: string, home: string = homedir()): HerdrInstance {
  const id = installId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
  return { configHome: join(home, '.config', 'graphyard', id, 'herdr'), session: `graphyard-${id}`.slice(0, 64) };
}
function environmentInstance(env: NodeJS.ProcessEnv = process.env): HerdrInstance | null {
  const configHome = env[herdrInstanceEnv.configHome]?.trim(), session = env[herdrInstanceEnv.session]?.trim();
  return configHome && session ? { configHome, session } : null;
}
let processInstance: HerdrInstance | null = environmentInstance();
/** Sets the instance this process's herdr calls target: the one master.json records, else the one its environment names, else the host's default. */
export function targetHerdr(instance: HerdrInstance | null | undefined) { processInstance = instance ?? environmentInstance(); }
export const herdrTarget = () => processInstance;
/** The herdr binary: on PATH, else where Herdr's own installer puts it (~/.local/bin), which a user unit's PATH may lack. */
export function herdrBinary(env: NodeJS.ProcessEnv = process.env, home: string = homedir()) {
  if ((env.PATH ?? '').split(delimiter).some(directory => directory && existsSync(join(directory, 'herdr')))) return 'herdr';
  const installed = join(home, '.local', 'bin', 'herdr');
  return existsSync(installed) ? installed : 'herdr';
}
export const isHerdrCommand = (command: string) => command === 'herdr' || command.endsWith('/herdr');
/** A herdr call's own arguments, without the `--session NAME` herdrInvocation puts before them. */
export const herdrSubcommand = (args: string[]) => args[0] === '--session' ? args.slice(2) : args;
/**
 * The one way Graphyard spells a herdr command (GY-1511): for an install with its own instance, its
 * XDG_CONFIG_HOME and `--session` (which outranks a pane's HERDR_SOCKET_PATH); for the default
 * instance, the arguments unchanged. Every herdr spawn in src/ goes through here or herdrCall.
 */
export function herdrInvocation(args: string[], instance: HerdrInstance | null = processInstance, command: string = herdrBinary()): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (!instance) return { command, args };
  const { HERDR_SOCKET_PATH: _socket, ...env } = process.env;
  return { command, args: ['--session', instance.session, ...args], env: { ...env, XDG_CONFIG_HOME: instance.configHome, [herdrInstanceEnv.configHome]: instance.configHome, [herdrInstanceEnv.session]: instance.session } };
}
/** Runs herdr ARGS through RUN (a ChildRun, or a synchronous stub) against INSTANCE. */
export function herdrCall<R>(run: (command: string, args: string[], options?: ChildRunOptions) => R, args: string[], options?: ChildRunOptions, instance: HerdrInstance | null = processInstance): R {
  const call = herdrInvocation(args, instance);
  if (!call.env) return options ? run(call.command, call.args, options) : run(call.command, call.args);
  return run(call.command, call.args, { ...options, env: { ...call.env, ...options?.env, XDG_CONFIG_HOME: instance!.configHome } });
}
/**
 * The same call for a runner that takes no environment (an install transport, another host's
 * account): `env` sets the instance's variables. BINARY names herdr where that runner finds it.
 */
export function herdrViaEnv(args: string[], instance: HerdrInstance | null = processInstance, binary: string = herdrBinary()): { command: string; args: string[] } {
  const call = herdrInvocation(args, instance, binary);
  if (!instance) return { command: call.command, args: call.args };
  return { command: 'env', args: ['-u', 'HERDR_SOCKET_PATH', `XDG_CONFIG_HOME=${instance.configHome}`, `${herdrInstanceEnv.configHome}=${instance.configHome}`, `${herdrInstanceEnv.session}=${instance.session}`, call.command, ...call.args] };
}
/** The one command an operator runs on this host to watch the install's agents (GY-1511). */
export const herdrAttachCommand = (instance: HerdrInstance | null = processInstance) => herdrConnectCommands({ configHome: instance?.configHome ?? null, session: instance?.session ?? null, host: null }).local;
/** Whether this process last reached its Herdr server: true after an inventory read answered, false after one failed, null before any. */
let serverSeen: boolean | null = null;
export const herdrServerSeen = () => serverSeen;

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
  const parsed = JSON.parse(await herdrCall(run, args));
  if (parsed.error) throw Object.assign(new Error(`Herdr refused the operation: ${parsed.error.message ?? parsed.error}`), { herdrCode: typeof parsed.error.code === 'string' ? parsed.error.code : undefined });
  return parsed.result ?? parsed;
}
export async function herdrRun(args: string[], run: ChildRun = defaultChildRun) { await herdrCall(run, args); }
// The headless runs this process started (GY-169) are listed beside Herdr's sessions, so every
// supervision that reads the inventory sees a live run under its session name and an ended one as gone.
export async function listHerdrAgents(run?: ChildRun, scope: string | null = processScope): Promise<HerdrAgent[]> {
  let listed: any;
  try { listed = await herdrJson(['agent', 'list'], run); serverSeen = true; } catch (error) { serverSeen = false; throw error; }
  return withRunnerAgents((listed.agents ?? []).filter((agent: HerdrAgent) => inHerdrScope(agent, scope)));
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
