import type { Work } from './work.js';
import { currentEvidence, type Evidence } from './evidence.js';
import { deploySmokeProof } from './proof.js';

/**
 * The test-case repository's run history (GY-162). A test case is a versioned scenario (see
 * src/scenarios.ts); a run is one trusted `e2e:<scenario-id>` evidence record, projected into the
 * append-only `scenario_runs` table as it is accepted. Nothing here decides trust: a run exists
 * only because the evidence command or the validation collector already accepted the record as
 * trusted, so a worker's own assertion never becomes a run.
 */
export type CaseResult = 'pass' | 'fail' | 'skipped';
/** The trusted run a result came from, in its own lane's identity. */
export interface RunIdentity {
  /** `ci`: a GitHub Actions job read back by the control plane; `github-actions`: a producer's
   * attested workflow run; `validation`: a validation request attempt; `producer`: a bound
   * producer session, identified by the evidence record it wrote. */
  kind: 'ci' | 'github-actions' | 'validation' | 'producer';
  id: string; attempt: number | null; url: string | null;
}
export interface ScenarioRun {
  seq: number; scenarioId: string; proof: string; result: CaseResult;
  scenarioRevision: number | null; environment: string | null; executed: number; skipped: number;
  sha: string; baseSha: string; policyRevision: number; workId: string; workKey: string; pr: number | null;
  run: RunIdentity; evidenceId: string; producer: string; at: string;
  /** Set at read time when the evidence behind the run was later revoked. */
  withdrawn?: boolean;
}

/** The scenario an `e2e:` proof names; post-deployment smoke is a delivery check, not a case. */
export const scenarioOf = (proof: string) => proof.startsWith('e2e:') && proof !== deploySmokeProof ? proof.slice(4) : null;

/** Skips never pass: a run that executed nothing or skipped anything reads as skipped. */
export const caseResult = (evidence: Pick<Evidence, 'result' | 'executed' | 'skipped'>): CaseResult =>
  evidence.result === 'fail' ? 'fail' : evidence.executed === 0 || evidence.skipped > 0 ? 'skipped' : 'pass';

export function runIdentity(evidence: Evidence): RunIdentity {
  if (evidence.ciRun) return { kind: 'ci', id: evidence.ciRun.runId, attempt: evidence.ciRun.runAttempt, url: `https://github.com/${evidence.ciRun.repository}/actions/runs/${evidence.ciRun.runId}/job/${evidence.ciRun.jobId}` };
  if (evidence.provenance) return { kind: 'github-actions', id: evidence.provenance.runId, attempt: evidence.provenance.runAttempt, url: evidence.provenance.artifact.url };
  if (evidence.validation) return { kind: 'validation', id: evidence.validation.requestId, attempt: null, url: null };
  return { kind: 'producer', id: evidence.id, attempt: null, url: evidence.url ?? null };
}

/** The run a trusted record projects, or null when it is not a test-case run. */
export function scenarioRun(work: Pick<Work, 'id' | 'key' | 'candidate'>, evidence: Evidence): Omit<ScenarioRun, 'seq'> | null {
  const scenarioId = scenarioOf(evidence.proof);
  if (!scenarioId || !evidence.trusted || evidence.revocation) return null;
  return { scenarioId, proof: evidence.proof, result: caseResult(evidence), scenarioRevision: evidence.scenarioRevision ?? null, environment: evidence.environment ?? null,
    executed: evidence.executed, skipped: evidence.skipped, sha: evidence.sha, baseSha: evidence.baseSha, policyRevision: evidence.policyRevision,
    workId: work.id, workKey: work.key, pr: work.candidate?.sha === evidence.sha ? work.candidate.pr : null,
    run: runIdentity(evidence), evidenceId: evidence.id, producer: evidence.producer, at: evidence.at };
}
/** One run is recorded once: a retried publish of the same lane run on the same commit is the same row. */
export const runKey = (run: Omit<ScenarioRun, 'seq'>) => [run.proof, run.sha, run.baseSha, run.run.kind, run.run.id, run.run.attempt ?? 0].join(':');

/** The window flakiness is judged over, named on the Tests page so the flag can be held to it. */
export const flakyWindow = 20;
/**
 * A case is flaky when one commit both passed and failed across its runs (a re-run flip), or when
 * its result changed two or more times over its last `flakyWindow` runs. Skipped and withdrawn
 * runs count as neither. `runs` is newest first.
 */
export function flakiness(runs: readonly ScenarioRun[]): { flaky: boolean; reason: string | null } {
  const judged = runs.filter(run => !run.withdrawn && run.result !== 'skipped').slice(0, flakyWindow);
  const bySha = new Map<string, Set<CaseResult>>();
  for (const run of judged) bySha.set(run.sha, (bySha.get(run.sha) ?? new Set()).add(run.result));
  const flipped = [...bySha].find(([, results]) => results.size > 1);
  if (flipped) return { flaky: true, reason: `passed and failed on commit ${flipped[0].slice(0, 8)}` };
  const changes = judged.slice(1).filter((run, index) => run.result !== judged[index].result).length;
  return changes >= 2 ? { flaky: true, reason: `result changed ${changes} times in its last ${judged.length} runs` } : { flaky: false, reason: null };
}

export type HeadResult = CaseResult | 'not-run' | 'no-pr';
export interface LinkedCase {
  id: string; proof: string; criteria: string[]; title: string | null;
  pinned: { revision: number; environment: string } | null;
  /** The result on the pull request's current head, from the evidence the gates themselves select. */
  head: HeadResult;
  evidence: { producer: string; sha: string; at: string; executed: number; skipped: number; run: RunIdentity } | null;
}
export interface TouchedCase { id: string; title: string; testPath: string }
interface CaseDefinition { id: string; title: string; testPath: string }

/**
 * The end-to-end cases a work item's pull request is linked to: every `e2e:` proof its criteria
 * name, with its result on the current head exactly as the acceptance gate selects it (trusted,
 * independent, bound to this candidate and policy, the pinned revision), and — separately, never
 * a gate — the registered cases whose test file the pull request changes.
 */
export function linkedCases(work: Work, definitions: readonly CaseDefinition[] | null, now = new Date()): { linked: LinkedCase[]; touched: TouchedCase[] } {
  // The registry read lists every revision, newest first per case; the newest names the case.
  const latest = new Map<string, CaseDefinition>();
  for (const definition of definitions ?? []) if (!latest.has(definition.id)) latest.set(definition.id, definition);
  const proofs = [...new Set(work.criteria.flatMap(criterion => criterion.proofs))].filter(proof => scenarioOf(proof));
  const linked = proofs.map((proof): LinkedCase => {
    const id = scenarioOf(proof)!;
    const pin = work.scenarioRequirements?.find(requirement => requirement.proof === proof);
    const selected = work.candidate ? currentEvidence(work, proof, now) : undefined;
    return { id, proof, criteria: work.criteria.filter(criterion => criterion.proofs.includes(proof)).map(criterion => criterion.id), title: latest.get(id)?.title ?? null,
      pinned: pin ? { revision: pin.revision, environment: pin.environment } : null,
      head: !work.candidate ? 'no-pr' : selected ? caseResult(selected) : 'not-run',
      evidence: selected ? { producer: selected.producer, sha: selected.sha, at: selected.at, executed: selected.executed, skipped: selected.skipped, run: runIdentity(selected) } : null };
  });
  const files = new Set(work.candidate ? work.observation?.files ?? [] : []);
  const touched = [...latest.values()].filter(definition => files.has(definition.testPath) && !linked.some(entry => entry.id === definition.id))
    .map(definition => ({ id: definition.id, title: definition.title, testPath: definition.testPath }));
  return { linked, touched };
}
