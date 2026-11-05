import type { RuntimeSession } from './model/sessions.js';
import type { ChildRun } from './child-runner.js';
import { listHerdrAgents } from './master/herdr.js';
import { liveRuns } from './runner/registry.js';

/** Runtime observations, never capacity or ownership. A failed source is an observation gap. */
export interface SessionInventory {
  sessions: { name: string | null; runtime: string | null; state: string | null; pane: string | null; workspace: string | null; cwd?: string; foregroundCwd?: string; tokens?: Record<string, string> }[];
  available: boolean;
}
export async function herdrInventory(run?: ChildRun): Promise<SessionInventory> {
  try {
    return { available: true, sessions: (await listHerdrAgents(run)).map(agent => ({ name: agent.name ?? null, runtime: agent.agent ?? null,
      state: agent.agent_status ?? null, pane: agent.pane_id ?? null, workspace: agent.workspace_id ?? null,
      cwd: agent.cwd, foregroundCwd: agent.foreground_cwd, tokens: agent.tokens })) };
  } catch { return { available: false, sessions: [] }; }
}
export function headlessInventory(): SessionInventory {
  return { available: true, sessions: liveRuns().map(entry => ({ name: entry.name, runtime: entry.agent ?? 'pi', state: 'working', pane: null, workspace: null })) };
}
export async function sessionInventory(run?: ChildRun): Promise<SessionInventory> {
  const herdr = await herdrInventory(run), headless = headlessInventory();
  return { available: herdr.available, sessions: [...herdr.sessions, ...headless.sessions] };
}
/** Boundary for existing pane supervision and launch APIs; headless runs never enter Herdr's inventory. */
export function sessionAgents(inventory: SessionInventory): RuntimeSession[] {
  return inventory.sessions.map(session => ({ name: session.name ?? undefined, agent: session.runtime, agent_status: session.state ?? undefined,
    pane_id: session.pane ?? undefined, workspace_id: session.workspace ?? undefined,
    cwd: session.cwd, foreground_cwd: session.foregroundCwd, tokens: session.tokens }));
}
