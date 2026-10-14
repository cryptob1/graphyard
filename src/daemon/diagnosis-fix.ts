// Concern: what a diagnosis outcome leaves behind — the record key, the no-run cause kind and the lost-run grace — and the fix item the loop files from it.
import { createHash } from 'node:crypto';
import { createSchema } from '../model.js';
import { namedPaths } from '../model/scope.js';
import { scopeExists } from '../model/planned-files.js';
import { guardBroadScope } from '../master/autonomy.js';
import { baseTree } from '../cli/planned-files-intent.js';
import { derivePlannedFiles, plannedFilesRefusal, type PlannedFilesDerivation } from '../model/planned-files.js';
import { type DiagnosisPayload, type DiagnosisRecord } from '../runner/payloads.js';
import type { FaultKind } from '../model/fault-classes.js';
import { clip, type DiagnosticianEffects, type FixInput } from './diagnosis.js';

export const iso = (at: number) => new Date(at).toISOString();
/**
 * GY-1530: the cause of a diagnosis no run answered, by how its runs ended. Every run that started
 * stopped at its bound (the runner's "no terminal event within Ns; the run was stopped", GY-1516's
 * two 1200s runs on GY-1430) is a session that ran past its bound: session-liveness's
 * `overlong-session`. Any other mix names no single cause and keeps the step's own kind.
 */
export function noDiagnosisKind(runs: readonly { runtime: string; result: string }[]): FaultKind | undefined {
  const started = runs.filter(run => run.runtime !== 'none');
  return started.length && started.every(run => run.result === 'timeout') ? 'overlong-session' : undefined;
}
export const diagnosisKey = (subject: string) => `diagnosis:${createHash('sha256').update(subject).digest('hex').slice(0, 24)}`;
/** How long past its bound a run recorded as running, with no run in this process, is waited for before it is recorded as lost. */
export const diagnosisLostGraceMs = 5 * 60_000;

/**
 * The base tree a fix filing resolves against (GY-1707): the diagnostician's `tree` effect when
 * supplied, else a real `baseTree` read of `cwd` — the same read `master create` uses. An
 * unreadable checkout throws; there is no synthetic tree from the diagnosis's own paths.
 */
export async function filingTree(diagnostician: DiagnosticianEffects, baseBranch: string) {
  if (diagnostician.tree) return diagnostician.tree(baseBranch);
  return baseTree(diagnostician.cwd, baseBranch);
}

/** A test path's directory, stem and suffix, or null. */
const testStemParts = (path: string) => {
  const match = /^((?:[^/]+\/)*)([^/]+?)(\.(?:test|spec)\.[cm]?[jt]sx?)$/.exec(path);
  return match ? { directory: match[1], stem: match[2], suffix: match[3] } : null;
};
/**
 * The base-tree test whose stem is a hyphenated prefix of a proof-named companion (GY-1700's
 * `tests/webhook-soft-accept.test.ts` beside `unit:webhook-soft-accept-no-5xx`), or null when the
 * named path already resolves or no shorter vehicle exists on the base.
 */
function existingProofVehicle(named: string, tree: ReadonlySet<string>): string | null {
  if (tree.has(named)) return null;
  const parts = testStemParts(named);
  if (!parts) return null;
  let best: string | null = null;
  for (const file of tree) {
    const candidate = testStemParts(file);
    if (!candidate || candidate.directory !== parts.directory || candidate.suffix !== parts.suffix) continue;
    if (parts.stem.startsWith(`${candidate.stem}-`) && (!best || file < best)) best = file;
  }
  return best;
}

/**
 * GY-1707: plannedFiles for a fix item the loop files from a diagnosis — the same derivation
 * `master create` applies (base-tree resolution, criteria-named tree files, planned companions),
 * plus the paths the diagnosis cause names that resolve in the tree when the subject is a
 * recurring-fault item (the cause is that item's own requirement, not prose). When a proof
 * companion invents a longer stem than a test the base already holds, that existing vehicle is
 * planned instead (GY-1700) — except a path the diagnosis itself planned stays as filed, so a
 * criterion that creates a longer new test is not rewritten to the shorter neighbour. Short-suffix
 * proof companions that `derivePlannedFiles` would refuse as misnamed (e.g. `unit:orphan-supervisor-x`
 * beside `tests/orphan-supervisor.test.ts`) are remapped to that vehicle before the refusal runs.
 * A path the tree does not hold and no criterion describes creating is refused with
 * `plannedFilesRefusal`.
 */
export function deriveDiagnosisFixPlannedFiles(
  input: { plannedFiles?: readonly string[]; criteria: readonly { id: string; text: string; proofs?: readonly string[] }[]; cause?: string; kind?: 'recurring' | 'invariant' },
  tree: ReadonlySet<string>,
  base: string,
): PlannedFilesDerivation {
  const explicit = new Set(input.plannedFiles ?? []);
  const causeNamed = input.kind === 'recurring' && input.cause
    ? namedPaths(input.cause).filter(path => scopeExists(path, tree))
    : [];
  const derived = derivePlannedFiles({ plannedFiles: [...new Set([...explicit, ...causeNamed])], criteria: input.criteria }, tree);
  const vehicleFor = (path: string) => (explicit.has(path) ? null : existingProofVehicle(path, tree));
  // Remap before refusing: a short-suffix proof companion lands in `missing` as misnamed, and must
  // become its existing vehicle rather than permanently failing the diagnosis (Codex PRRT on work.ts).
  const rescued = new Map<string, string>();
  for (const path of [...derived.plannedFiles, ...derived.missing]) {
    const vehicle = vehicleFor(path);
    if (vehicle) rescued.set(path, vehicle);
  }
  const missing = derived.missing.filter(path => !rescued.has(path));
  const misnamed = derived.misnamed.filter(entry => missing.includes(entry.path));
  if (missing.length) throw new Error(plannedFilesRefusal(missing, base, misnamed));
  const plannedFiles = [...new Set([
    ...derived.plannedFiles.map(path => rescued.get(path) ?? path),
    ...[...rescued.values()],
  ])];
  return { ...derived, plannedFiles, missing, misnamed };
}

/** The fix item as `master create` would file it (GY-1707): schema, broad-scope guard, and plannedFiles derived against the base tree — never the diagnostician's list verbatim. */
export function fixItem(entry: Pick<DiagnosisRecord, 'subject' | 'kind' | 'work'>, diagnosis: DiagnosisPayload,
  tree: { ref: string; files: ReadonlySet<string> }): FixInput {
  const fix = diagnosis.fix!;
  const answers = entry.kind === 'recurring' ? `the recurring-fault item ${entry.work}` : `the invariant violation ${entry.subject}`;
  const description = clip([
    fix.description,
    `Filed by the master loop from the diagnostician's diagnosis of ${answers} (GY-439). Cause: ${diagnosis.cause}`,
    `Evidence:\n${[...diagnosis.evidence.logLines.map(line => `- log: ${line}`), ...diagnosis.evidence.commands.map(line => `- ran: ${line}`)].join('\n')}`,
  ].join('\n\n'), 20_000);
  const derived = deriveDiagnosisFixPlannedFiles(
    { plannedFiles: fix.plannedFiles, criteria: fix.criteria, cause: diagnosis.cause, kind: entry.kind }, tree.files, tree.ref);
  const input = createSchema.parse({ title: fix.title, description, type: fix.type, priority: fix.priority, criteria: fix.criteria, plannedFiles: derived.plannedFiles });
  const reason = guardBroadScope(input, `The diagnostician found the root cause of ${answers}: ${clip(diagnosis.cause, 1500)}`, { allow: false, command: 'master create' });
  return { ...input, reason };
}
