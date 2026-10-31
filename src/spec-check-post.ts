// `graphyard spec-check post` (GY-2992): the spec-check session's one way to post its report. The
// command needs no Graphyard credential: the launch binds a one-time token (spec-check-binding.json
// in the session's GH_CONFIG_DIR, written by the launcher), and the report goes to
// `POST /api/work/:id/spec-check` at GRAPHYARD_URL as that token; the server records it on the item
// (server/review-verdict.ts) and the dispatch hold reads it from there.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** The file, in the session's GH_CONFIG_DIR, that binds a spec-check session to its launch. */
export const specCheckBindingFile = 'spec-check-binding.json';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const specCheckBindingSchema = z.object({
  repository: z.string().min(1).max(200),
  key: z.string().min(1).max(100),
  workId: z.string().uuid(),
  policyRevision: z.number().int().nonnegative(),
  reviewer: z.string().min(1).max(120),
  url: z.string().url(),
  token: hex64,
}).strict();
export type SpecCheckBinding = z.infer<typeof specCheckBindingSchema>;

/** Written once, private, before the session's runtime starts; a launch that cannot write it starts nothing. */
export async function writeSpecCheckBinding(directory: string, binding: SpecCheckBinding) {
  const file = join(directory, specCheckBindingFile);
  await writeFile(file, `${JSON.stringify(specCheckBindingSchema.parse(binding))}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
  return file;
}

export async function readSpecCheckBinding(directory: string): Promise<SpecCheckBinding> {
  let text: string;
  try { text = await readFile(join(directory, specCheckBindingFile), 'utf8'); }
  catch { throw new SpecCheckPostRefusal(`GH_CONFIG_DIR (${directory}) holds no ${specCheckBindingFile}: spec-check post runs only in a spec-check session Graphyard launched`); }
  try { return specCheckBindingSchema.parse(JSON.parse(text)); }
  catch { throw new SpecCheckPostRefusal(`${specCheckBindingFile} in GH_CONFIG_DIR is not a valid spec-check binding`); }
}

export class SpecCheckPostRefusal extends Error {}

export const specVerdictFlags = ['ready', 'gaps'] as const;

/** A correct invocation for this session, printed after every refusal. */
export function specCheckPostExample(cliPath: string, verdict: string) {
  return `node ${cliPath} spec-check post --verdict ${verdict === 'gaps' ? 'gaps' : 'ready'} --paraphrase "WHAT WILL BE BUILT, AND HOW EACH CRITERION IS PROVEN"${verdict === 'gaps' ? ' --gap "ONE GAP" --gap "ANOTHER"' : ''}`;
}

export interface SpecCheckPostDependencies { fetch?: typeof fetch }

/** Check, then post exactly one report. `environment` is the session's own. */
export async function postSpecCheck(input: { verdict?: string; paraphrase?: string; gaps: string[]; cliPath: string; environment: NodeJS.ProcessEnv }, dependencies: SpecCheckPostDependencies = {}) {
  const verdict = specVerdictFlags.find(entry => entry === input.verdict?.toLowerCase());
  const refuse = (reason: string): never => { throw new SpecCheckPostRefusal(`Spec check not posted: ${reason}.\nPost it like this:\n${specCheckPostExample(input.cliPath, verdict ?? 'ready')}`); };
  const directory = input.environment.GH_CONFIG_DIR;
  if (!directory) refuse('GH_CONFIG_DIR is unset; spec-check post runs only in a spec-check session Graphyard launched');
  const binding = await readSpecCheckBinding(directory!).catch(error => refuse((error as Error).message));
  if (input.environment.GRAPHYARD_SPEC_CHECK !== binding.key) refuse(`GRAPHYARD_SPEC_CHECK is ${input.environment.GRAPHYARD_SPEC_CHECK ? `"${input.environment.GRAPHYARD_SPEC_CHECK}"` : 'unset'}, not this launch's ${binding.key}`);
  if (!verdict) refuse(`--verdict must be one of ${specVerdictFlags.join(', ')}`);
  const paraphrase = input.paraphrase?.trim();
  if (!paraphrase) refuse('--paraphrase is required: your own words for what the item proposes and how each criterion is proven');
  const gaps = input.gaps.map(gap => gap.trim()).filter(Boolean);
  if (verdict === 'gaps' && !gaps.length) refuse('a gaps verdict names at least one --gap');
  if (verdict === 'ready' && gaps.length) refuse('a ready verdict takes no --gap');
  const base = input.environment.GRAPHYARD_URL;
  if (!base) refuse('GRAPHYARD_URL is unset; a spec-check session is launched with the control plane\'s address');
  const post = dependencies.fetch ?? fetch;
  const response = await post(`${base}/api/work/${encodeURIComponent(binding.workId)}/spec-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${binding.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `spec-check:${binding.token}` },
    body: JSON.stringify({ token: binding.token, verdict, paraphrase, gaps }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => refuse(`the control plane at ${base} could not be reached (${error instanceof Error ? error.message : String(error)})`));
  const body = await (response as Response).json().catch(() => ({})) as { error?: string; recheck?: boolean; policyRevision?: number };
  if (!(response as Response).ok) refuse(body.error ?? `the control plane answered ${(response as Response).status}`);
  return `Spec check recorded on ${binding.key} under policy revision ${body.policyRevision ?? binding.policyRevision}: ${verdict}${body.recheck ? ' (the re-check after master requirements; the item dispatches with this report attached)' : verdict === 'gaps' ? ' — the item is held at ready until master requirements revises it' : ' — the item dispatches'}.`;
}
