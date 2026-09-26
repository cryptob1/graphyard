import { roleSurface } from './role-surface.js';
import { herdrSurface } from './herdr-surface.js';
import { agentRuntimeRun } from '../master/herdr.js';
import { runLogFile } from '../session-tail.js';
import type { ChildRun } from '../child-runner.js';
import type { RunSurface } from './roles.js';

/**
 * Where one approver or producer run writes its log and which surface it runs on (GY-713): the
 * per-run log under the loop's checkout, and a Herdr pane when `run.<role>.surface` is `herdr`.
 */
export function headlessSurface(root: string, config: { run?: { approver?: { surface?: 'headless' | 'herdr' }; producer?: { surface?: 'headless' | 'herdr' } }; herdrWorkspace?: string },
  role: 'approver' | 'producer', name: string, run: ChildRun = agentRuntimeRun()): RunSurface {
  return {
    log: () => runLogFile(root, name),
    ...(roleSurface(config.run, role) === 'herdr' ? { surface: herdrSurface({ run, workspace: config.herdrWorkspace ?? null, label: `${role === 'approver' ? 'Approver' : 'Producer'} · ${name}` }) } : {}),
  };
}
