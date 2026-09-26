import { z } from 'zod';

/**
 * What the Graphyard Pi tools submit, as Graphyard re-validates it (GY-169). The extension under
 * integrations/pi rejects a malformed call before it becomes a submission; these schemas are the
 * control plane's own check of what the runner hands back, so a submission is never trusted for
 * having passed the agent's side. They are the tool schemas, not the gates: the loop applies a
 * payload through the same routes a terminal session uses, and the server judges it there.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/i);

/** `graphyard_decide`: the approver's verdict on one requested decision. */
export const decidePayloadSchema = z.object({
  decision: z.string().trim().min(1).max(100),
  approve: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type DecidePayload = z.infer<typeof decidePayloadSchema>;

/** `graphyard_submit_evidence`: one proof's result on the exact head, with its exercise run (GY-135). */
export const evidencePayloadSchema = z.object({
  proof: z.string().trim().min(1).max(200),
  sha, baseSha: sha,
  policyRevision: z.number().int().positive(),
  result: z.enum(['pass', 'fail']),
  executed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  exercise: z.object({
    criterion: z.string().trim().min(1).max(80).optional(),
    behaviour: z.string().trim().min(1).max(300),
    result: z.enum(['pass', 'fail']),
    executed: z.number().int().min(0),
  }).strict(),
  environment: z.string().trim().min(1).max(100).optional(),
  scopeFiles: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
}).strict();
export type EvidencePayload = z.infer<typeof evidencePayloadSchema>;

export const graphyardTools = { decide: 'graphyard_decide', evidence: 'graphyard_submit_evidence' } as const;

/**
 * The runtime of each narrow role, set in .graphyard/master.json under `run.runtimes`: `herdr`
 * (today's terminal session, and what an absent setting means) or `pi` (the headless runner).
 * `run.pi` names the environment wrapper and model the Pi runs use.
 */
export const narrowRoleRuntimes = ['herdr', 'pi'] as const;
export type NarrowRoleRuntime = typeof narrowRoleRuntimes[number];
export const narrowRoleRuntimeSchema = z.object({
  approver: z.enum(narrowRoleRuntimes).optional(),
  producer: z.enum(narrowRoleRuntimes).optional(),
}).strict();
export const piRuntimeSchema = z.object({
  /** The environment wrapper (`pi-a`, `pi-b`) or Pi binary on PATH. */
  command: z.string().trim().min(1).max(500).default('pi'),
  model: z.string().trim().min(1).max(200).default('zai/glm-5.3-flash'),
  /** The bound on one approver run; a producer run is bounded by `producerTimeoutMinutes`. */
  approverTimeoutMinutes: z.number().int().min(1).max(120).default(10),
}).strict();
export type PiRuntime = z.infer<typeof piRuntimeSchema>;

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

/** The runtime a narrow role launches on; the producer runs on Pi only for the unit group. */
export function narrowRoleRuntime(run: { runtimes?: z.infer<typeof narrowRoleRuntimeSchema> } | undefined, role: 'approver' | 'producer', group?: string): NarrowRoleRuntime {
  const selected = run?.runtimes?.[role] ?? 'herdr';
  return role === 'producer' && selected === 'pi' && group !== 'unit' ? 'herdr' : selected;
}
