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

const line = (max: number) => z.string().trim().min(1).max(max);
/**
 * `graphyard_diagnose`: the diagnostician's structured diagnosis of one recurring-fault item or
 * persisting invariant violation (GY-439). The cause, the evidence it rests on (the log lines it
 * read and the commands it ran), the fault class the cause belongs to, and exactly one answer:
 * `covering`, an existing open item that already covers the cause, or `fix`, the root-cause item
 * to file with testable criteria and planned files. The loop re-validates `fix` with the checks
 * `master create` applies before filing anything.
 */
export const diagnosisPayloadSchema = z.object({
  subject: line(400),
  cause: line(4000),
  evidence: z.object({ logLines: z.array(line(1000)).max(50).default([]), commands: z.array(line(1000)).max(50).default([]) }).strict()
    .refine(evidence => evidence.logLines.length + evidence.commands.length > 0, 'A diagnosis names the log lines or commands its cause rests on'),
  faultClass: z.enum(faultClasses),
  covering: z.string().trim().regex(/^GY-\d+$/, 'covering names an existing work item as GY-N').nullable().default(null),
  fix: z.object({
    title: line(200), description: line(20000),
    type: z.enum(['feature', 'bug', 'chore']).default('bug'),
    priority: z.number().int().min(0).max(4),
    criteria: z.array(z.object({ id: z.string().trim().regex(/^[A-Z]+-\d+$/), text: line(4000), proofs: z.array(line(200)).min(1).max(10) }).strict()).min(1).max(20),
    plannedFiles: z.array(line(500)).min(1).max(100),
  }).strict().nullable().default(null),
}).strict().refine(payload => !!payload.covering !== !!payload.fix, 'A diagnosis names exactly one answer: the covering item, or the fix item to file');
export type DiagnosisPayload = z.infer<typeof diagnosisPayloadSchema>;

export const graphyardTools = { decide: 'graphyard_decide', evidence: 'graphyard_submit_evidence', diagnose: 'graphyard_diagnose' } as const;

/**
 * `run.diagnostician` in .graphyard/master.json (GY-439): the diagnostician runs headless on Pi
 * with `model`, and a run that ends without a valid diagnosis runs once more on the stronger
 * `fallbackModel`. The registry's diagnostician role, when an operator defines one, chooses the
 * first run's account and model instead. `invariantBoundMinutes` is how long an invariant violation
 * stands before it is diagnosed; `journalCommand` and `serverLogCommand` read the excerpts the
 * diagnostician is given (an absent server-log command gives it none).
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
/** The diagnostician settings in force: `run.diagnostician` over its defaults, Pi's command from `run.pi` when it names none. */
export function diagnosticianSettings(run: { diagnostician?: unknown; pi?: { command?: string } } | undefined): DiagnosticianSettings {
  const parsed = diagnosticianSettingsSchema.parse(run?.diagnostician ?? {});
  return { ...parsed, command: parsed.command ?? run?.pi?.command ?? 'pi' };
}

/**
 * What the loop keeps of one diagnosis (GY-439): the runs it took (primary, then the fallback),
 * the diagnosis, and how it was answered — the fix item filed and released, or the covering item —
 * with the two-party decision in flight. `answeredBy` is the item that answers the subject.
 */
export const diagnosisStates = ['running', 'diagnosed', 'releasing', 'closing', 'answered', 'refused', 'failed'] as const;
export const diagnosisRecordSchema = z.object({
  subject: z.string().max(400), kind: z.enum(['recurring', 'invariant']), faultClass: z.enum(faultClasses),
  /** The recurring-fault item's key; null for an invariant violation. */
  work: z.string().max(50).nullable(),
  state: z.enum(diagnosisStates),
  startedAt: z.string().max(40), updatedAt: z.string().max(40),
  runs: z.array(z.object({ runtime: z.string().max(40), model: z.string().max(200), startedAt: z.string().max(40), endedAt: z.string().max(40).nullable(),
    result: z.string().max(40), detail: z.string().max(500) }).strict()).max(4).default([]),
  diagnosis: diagnosisPayloadSchema.nullable().default(null),
  fix: z.string().max(50).nullable().default(null),
  decision: z.object({ id: z.string().max(100), action: z.enum(['release', 'close']), work: z.string().max(50), approver: z.string().max(200).nullable().default(null) }).strict().nullable().default(null),
  answeredBy: z.string().max(50).nullable().default(null),
  detail: z.string().max(1000).default(''),
}).strict();
export type DiagnosisRecord = z.infer<typeof diagnosisRecordSchema>;
export const diagnosisSettled = (record: Pick<DiagnosisRecord, 'state'>) => record.state === 'answered' || record.state === 'refused' || record.state === 'failed';
export const retainedDiagnoses = 200;

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
