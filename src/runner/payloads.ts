import { z } from 'zod';

/**
 * What the Graphyard Pi tools submit, as Graphyard re-validates it (GY-169). The extension under
 * integrations/pi rejects a malformed call before it becomes a submission; these schemas are the
 * control plane's own check of what the runner hands back, so a submission is never trusted for
 * having passed the agent's side. They are the tool schemas, not the gates: the loop applies a
 * payload through the same routes a terminal session uses, and the server judges it there.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/i);


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

const line = (max: number) => z.string().trim().min(1).max(max);
/**
 * What `graphyard_decompose` submits (GY-1126, src/decomposition.ts): the child items a broad item
 * is split into, or none to keep it whole. A child names the parent's criteria by ID only — the
 * control plane copies their text and proofs, so a split can drop or reword nothing — with the
 * earlier children (by position) it must land after. A payload written before GY-1992 may still
 * name each child's planned files; they are ignored.
 */
export const decomposedChildSchema = z.object({
  title: line(200), description: line(6000).optional(),
  criteria: z.array(z.string().trim().regex(/^[A-Z]+-\d+$/)).min(1).max(20),
  plannedFiles: z.unknown().transform(() => undefined).optional(),
  after: z.array(z.number().int().min(0).max(9)).max(9).default([]),
}).strict();
export const decompositionPayloadSchema = z.object({ reason: line(2000), children: z.array(decomposedChildSchema).max(10) }).strict()
  .refine(payload => payload.children.length !== 1, 'A split names at least two children; an empty list keeps the item whole');
export type DecompositionPayload = z.infer<typeof decompositionPayloadSchema>;

/**
 * `run.decomposition` in .graphyard/master.json (GY-1126): the size bounds an item is judged
 * against before its first dispatch, and the bound on one decomposition run. The run uses the
 * research account and model (`run.research`); a loop without one splits nothing.
 */
export const decompositionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxCriteria: z.number().int().min(1).max(50).default(4),
  // Retired with plannedFiles (GY-1992): an installation that still sets either loads, and they bound nothing.
  maxBroadScopes: z.unknown().transform(() => undefined).optional(), maxPlannedFiles: z.unknown().transform(() => undefined).optional(),
  maxEstimatedLines: z.number().int().min(100).max(100_000).default(600),
  timeoutMinutes: z.number().int().min(1).max(60).default(10),
  concurrency: z.number().int().min(1).max(16).default(4),
}).strict();
export type DecompositionSettings = z.infer<typeof decompositionSettingsSchema>;
/** The estimated-lines bound in force. */
export const estimatedLinesBound = (settings: DecompositionSettings) => settings.maxEstimatedLines;

export const graphyardTools = { evidence: 'graphyard_submit_evidence', decompose: 'graphyard_decompose' } as const;

/**
 * `run.diagnostician` in .graphyard/master.json (GY-439): the headless model settings the
 * acceptance (GY-1417) and planner (GY-1418) runs share — `model`, with a run that ends without a
 * valid answer retried once on the stronger `fallbackModel`. The registry's diagnostician role,
 * when an operator defines one, chooses the first run's account and model instead.
 * `journalCommand` and `serverLogCommand` name the excerpts a session may read.
 */
export const diagnosticianSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().trim().min(1).max(500).optional(),
  model: z.string().trim().min(1).max(200).default('zai/glm-5.3-flash'),
  fallbackModel: z.string().trim().min(1).max(200).default('zai/glm-5.3'),
  timeoutMinutes: z.number().int().min(1).max(120).default(20),
  invariantBoundMinutes: z.number().int().min(1).max(10_080).default(30),
  journalCommand: z.array(z.string().min(1).max(500)).min(1).max(20).default(['journalctl', '--user', '-u', 'graphyard-master.service', '-n', '200', '--no-pager', '-o', 'short-iso']),
  serverLogCommand: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
}).strict();
export type DiagnosticianSettings = z.infer<typeof diagnosticianSettingsSchema> & { command: string };
/** The shared settings in force: `run.diagnostician` over its defaults, Pi's command from `run.pi` when it names none. */
export function diagnosticianSettings(run: { diagnostician?: unknown; pi?: { command?: string } } | undefined): DiagnosticianSettings {
  const parsed = diagnosticianSettingsSchema.parse(run?.diagnostician ?? {});
  return { ...parsed, command: parsed.command ?? run?.pi?.command ?? 'pi' };
}

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

/** The runtime a narrow role launches on; the producer runs on Pi only for the unit group. */
export function narrowRoleRuntime(run: { runtimes?: z.infer<typeof narrowRoleRuntimeSchema> } | undefined, role: 'approver' | 'producer', group?: string): NarrowRoleRuntime {
  const selected = run?.runtimes?.[role] ?? 'herdr';
  return role === 'producer' && selected === 'pi' && group !== 'unit' ? 'herdr' : selected;
}
