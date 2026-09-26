import { z } from 'zod';
import { faultClasses } from '../model/fault-classes.js';

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

/**
 * `graphyard_doctor_report`: the pipeline doctor's structured report of one run (GY-711). What was
 * stuck under which check bound, what the doctor did about each through its sanctioned commands,
 * what it filed for a finding no item covers, and which commands its allowlist guard refused (a
 * refused command is recorded, never run). The loop re-validates this payload and records one
 * event per item and one run summary from it.
 */
const line = (max: number) => z.string().trim().min(1).max(max);
export const doctorFindingsSchema = z.object({
  /** The work item key the finding is on, or a status-level subject such as `installation`. */
  subject: line(200),
  /** The check whose fault bound the finding passed: blocked, worker, ci, review-request, launch, proofs, mergeable, decision, containment, refusal, overdue. */
  check: z.enum(['blocked', 'worker', 'ci', 'review-request', 'launch', 'proofs', 'mergeable', 'decision', 'containment', 'refusal', 'overdue']),
  detail: line(2000),
  /** Whether the doctor could not act on it: a human-only decision, or a fault class with no item. */
  unactionable: z.boolean().default(false),
}).strict();
export type DoctorFinding = z.infer<typeof doctorFindingsSchema>;
export const doctorActionSchema = z.object({
  subject: line(200),
  /** The sanctioned command the doctor ran, as it ran it. */
  command: line(500),
  outcome: z.enum(['applied', 'refused']),
  detail: line(1000),
}).strict();
export type DoctorAction = z.infer<typeof doctorActionSchema>;
export const doctorFileSchema = z.object({
  /** The fault class the finding belongs to, deduplicated against the open items naming it. */
  faultClass: z.enum(faultClasses),
  title: line(200), description: line(20000),
  /** A fault the doctor files is urgent: 0 (P0) or 1 (P1). */
  priority: z.number().int().min(0).max(1),
  criteria: z.array(z.object({ id: z.string().trim().regex(/^[A-Z]+-\d+$/), text: line(4000), proofs: z.array(line(200)).min(1).max(10) }).strict()).min(1).max(20),
  plannedFiles: z.array(line(500)).min(1).max(100),
}).strict();
export type DoctorFile = z.infer<typeof doctorFileSchema>;
export const doctorReportPayloadSchema = z.object({
  findings: z.array(doctorFindingsSchema).max(200).default([]),
  actions: z.array(doctorActionSchema).max(200).default([]),
  filed: z.array(doctorFileSchema).max(20).default([]),
}).strict();
export type DoctorReportPayload = z.infer<typeof doctorReportPayloadSchema>;

export const graphyardTools = { decide: 'graphyard_decide', evidence: 'graphyard_submit_evidence', doctor: 'graphyard_doctor_report' } as const;

/**
 * `run.doctor` in .graphyard/master.json (GY-711): the pipeline doctor runs every
 * `intervalMinutes` (10 by default), headless on Pi with `model`, and a run that ends without a
 * valid report runs once more on the stronger `fallbackModel`. The registry's doctor role, when an
 * operator defines one, chooses the primary run's account and model instead. `timeoutMinutes`
 * bounds one run. An installation turns the doctor off with `enabled: false`.
 */
export const doctorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().trim().min(1).max(500).optional(),
  intervalMinutes: z.number().int().min(5).max(1440).default(10),
  model: z.string().trim().min(1).max(200).default('zai/glm-5.3-flash'),
  fallbackModel: z.string().trim().min(1).max(200).default('zai/glm-5.3'),
  timeoutMinutes: z.number().int().min(1).max(60).default(20),
}).strict();
export type DoctorSettings = z.infer<typeof doctorSettingsSchema> & { command: string };
/** The doctor settings in force: `run.doctor` over its defaults, Pi's command from `run.pi` when it names none. */
export function doctorSettings(run: { doctor?: unknown; pi?: { command?: string } } | undefined): DoctorSettings {
  const parsed = doctorSettingsSchema.parse(run?.doctor ?? {});
  return { ...parsed, command: parsed.command ?? run?.pi?.command ?? 'pi' };
}

/**
 * What the loop keeps of one doctor run (GY-711): when it ran, what it found, did and filed, and
 * how it ended. Kept bounded on the cursor, posted to the control plane for the dashboard, and
 * summarised by `master status`.
 */
export const doctorStates = ['running', 'reported', 'failed'] as const;
export const doctorRunRecordSchema = z.object({
  at: z.string().max(40), state: z.enum(doctorStates),
  runs: z.array(z.object({ runtime: z.string().max(40), model: z.string().max(200), result: z.string().max(40), detail: z.string().max(500) }).strict()).max(4).default([]),
  findings: z.array(doctorFindingsSchema).max(200).default([]),
  actions: z.array(doctorActionSchema).max(200).default([]),
  filed: z.array(z.object({ faultClass: z.enum(faultClasses), title: z.string().max(200), work: z.string().max(50).nullable().default(null), deduplicated: z.boolean().default(false) }).strict()).max(20).default([]),
  detail: z.string().max(1000).default(''),
}).strict();
export type DoctorRunRecord = z.infer<typeof doctorRunRecordSchema>;
export const retainedDoctorRuns = 50;

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
