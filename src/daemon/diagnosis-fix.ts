// Concern: what a diagnosis session is given and leaves behind — the evidence it reads and the prompt it is launched with (GY-1835's merger-aware read list included), and the record key, no-run cause kind, lost-run grace and fix item the loop files from its outcome.
import { createHash } from 'node:crypto';
import { createSchema, type Work } from '../model.js';
import { isClosed } from '../model/closure.js';
import { namedPaths } from '../model/scope.js';
import { scopeExists } from '../model/planned-files.js';
import { guardBroadScope } from '../master/autonomy.js';
import { baseTree } from '../cli/planned-files-intent.js';
import { derivePlannedFiles, plannedFilesRefusal, type PlannedFilesDerivation } from '../model/planned-files.js';
import { graphyardTools, type DiagnosisPayload, type DiagnosisRecord } from '../runner/payloads.js';
import { faultClassMeaning } from '../model/fault-classes.js';
import type { FaultKind } from '../model/fault-classes.js';
import type { MergerMode } from '../merger-mode.js';
import type { DiagnosisContext, DiagnosisSubject, DiagnosticianEffects, FixInput } from './diagnosis.js';

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

export const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** The last lines of an excerpt that fit `budget` characters, each clipped. */
export function excerpt(lines: readonly string[], budget: number, lineLimit = 400) {
  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    const clipped = clip(line, lineLimit);
    if (used + clipped.length + 1 > budget) break;
    kept.unshift(clipped); used += clipped.length + 1;
  }
  return kept;
}

/** The pull requests the subject names: `#N` or `PR N` in its instances, and the candidates of the items its instances are on. */
export function namedPullRequests(subject: DiagnosisSubject, work: readonly Work[], limit = 5) {
  const numbers = new Set<number>();
  for (const instance of subject.instances) {
    for (const match of `${instance.subject} ${instance.text}`.matchAll(/(?:#|\bPR\s*#?|pull request\s*#?)(\d{1,7})\b/gi)) numbers.add(Number(match[1]));
    const item = work.find(entry => entry.key === instance.subject);
    const pr = item?.candidate?.pr ?? item?.submission?.pr;
    if (pr) numbers.add(pr);
  }
  return [...numbers].slice(0, limit);
}

/** Everything the diagnostician is given, bounded so the prompt stays one argument. */
export function diagnosisInput(subject: DiagnosisSubject, context: DiagnosisContext, work: readonly Work[]) {
  const open = work.filter(item => item.stage !== 'done' && !isClosed(item) && item.key !== subject.work?.key);
  return {
    subject: subject.id, kind: subject.kind, faultClass: subject.faultClass, meaning: faultClassMeaning[subject.faultClass],
    item: subject.work ? { key: subject.work.key, title: subject.work.title, description: clip(subject.work.description ?? '', 6000) } : null,
    instances: subject.instances.slice(-40).map(entry => ({ at: entry.at, lastSeenAt: entry.lastSeenAt, kind: entry.kind, subject: entry.subject, text: clip(entry.text, 300) })),
    journal: excerpt(context.journal, 24_000),
    serverLog: excerpt(context.serverLog, 16_000),
    pullRequests: context.pullRequests.slice(0, 5).map(entry => ({ number: entry.number, state: clip(JSON.stringify(entry.state ?? null), 2000) })),
    openItems: excerpt(open.map(item => `${item.key} [${item.stage}${item.ready ? ', ready' : ''}] ${item.title}`), 8_000, 200),
  };
}
export type DiagnosisInput = ReturnType<typeof diagnosisInput>;

export function diagnosisPrompt(config: { repository: string; cliPath: string; merger?: MergerMode }, input: DiagnosisInput) {
  const cli = `node ${config.cliPath}`;
  const what = input.kind === 'recurring'
    ? `the recurring-fault item ${input.item!.key} ("${input.item!.title}"), which the master loop filed because the ${input.faultClass} fault class (${input.meaning}) recurred`
    : `the invariant violation ${input.subject}, which has stood past its bound`;
  // GY-1835: under a control-plane merger the item's head, merge and verdicts are the control
  // plane's own records, so the read list names `graphyard status GY-N` and `master status` and no
  // `gh pr view`; with GitHub the recorded merger it names the pull-request read as before.
  const reads = config.merger === 'control-plane' ? `${cli} status GY-N, ${cli} master status` : `${cli} status GY-N, ${cli} master status, gh pr view N`;
  return `You are the Graphyard diagnostician for ${config.repository}. Diagnose ${what}. Find the one root cause its instances share, as a senior engineer on this codebase would: read the evidence below, the repository in this checkout, and the control plane (${reads}). `
    + 'This session is read-only: never edit, commit, push, claim, release, close, merge or decide anything, and never ask anyone anything. '
    + `Then call the ${graphyardTools.diagnose} tool exactly once with subject "${input.subject}", the cause, the evidence it rests on (log lines quoted exactly, and the commands you ran with what they showed), the fault class the cause belongs to, and exactly one answer: `
    + 'covering, the key of an existing open item (listed below) that already covers this cause, when one does; otherwise fix, the root-cause item to file — a title, a description stating the cause and evidence, the priority to release it at (0 highest to 4), testable criteria each with its proofs (each a bare id such as unit:tmp-reclaim-retry — unit:, integration:, e2e: or manual: then letters, digits and ._/- only, no spaces or prose), and the narrow plannedFiles the fix changes. Stop after the call.\n\n'
    + `The evidence, as JSON:\n${clip(JSON.stringify(input), diagnosisEvidenceMax)}`;
}
/** The evidence's bound in the prompt: the prompt is one process argument, which Linux caps at 128 KiB. */
export const diagnosisEvidenceMax = 100_000;
