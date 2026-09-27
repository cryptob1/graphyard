import { z } from 'zod';

/**
 * Where a headless role run runs (GY-713), set per role in .graphyard/master.json as
 * `run.approver.surface`, `run.producer.surface` and `run.research.surface`: `headless` (the
 * default) is a child of the loop, `herdr` the same run inside a Herdr pane an operator can watch.
 * Either way the run writes its per-run log and the dashboard's live view reads it.
 */
export const roleSurfaces = ['headless', 'herdr'] as const;
export type RoleSurface = typeof roleSurfaces[number];
export const roleSurfaceSchema = z.object({ surface: z.enum(roleSurfaces).default('headless') }).strict();
export function roleSurface(run: { approver?: { surface?: RoleSurface }; producer?: { surface?: RoleSurface }; research?: unknown } | undefined, role: 'approver' | 'producer' | 'research'): RoleSurface {
  const configured = (run?.[role] as { surface?: unknown } | undefined)?.surface;
  return configured === 'herdr' ? 'herdr' : 'headless';
}
