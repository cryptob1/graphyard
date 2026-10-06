import { releaseVerdict, type E2eReport } from './e2e/runner.js';
import type { ReleaseContract } from './e2e/case.js';
import { candidateId, readRecords, writeRecord, type E2eCaseRecord, type E2eRecord, type FlakyAcceptance, type Git, type HoldOutcome, type ReleaseCandidate, type UatRecord } from './release-candidate.js';

/**
 * Release holds (GY-1378): one hold per customer risk. The release contract (`e2e/contract.json`)
 * binds each required customer outcome to the cases that prove it; a candidate whose UAT run fails
 * or flakes a bound required case files one hold per failed outcome — not one per suite or case —
 * with the failed cases, their failing steps and the outcome's criteria attached. A later failure
 * of an outcome whose hold is still open attaches to that hold instead of filing again. Folding one
 * outcome's hold into another's needs an applied `fold` decision with an independent approver. A
 * hold clears only when every case attached to it passes on a newer candidate UAT served at its
 * exact SHA. Failures no case explains (deployment, endpoints, runner outages) are process
 * incidents: they file the candidate's ordinary follow-up item, never a hold.
 *
 * Holds live in the release ledger beside the candidates, as annotated tags that never move:
 * `rc-hold/OUTCOME/CANDIDATE` records what one validation did to the outcome's hold (open, attach
 * or clear), and `rc-hold/OUTCOME/fold-ID` a fold; the holds are the fold of those records.
 */
export const holdTagPrefix = 'rc-hold/';
/** The request id that makes filing an outcome's hold item idempotent across retried validations. */
export const holdRequestId = (outcome: string, candidate: string) => `release-hold:${outcome}:${candidate}`;

export interface HoldCase { case: string; verdict: 'failed' | 'flaky'; candidate: string; sha: string; runId: string; attempts: number; failingStep: E2eCaseRecord['failingStep'] }
export interface HoldRecord {
  kind: 'open' | 'attach' | 'clear' | 'fold';
  /** The outcome this record is about; `hold` is the outcome whose hold it lands in (another one's once folded). */
  outcome: string; hold: string; candidate: string | null; sha: string | null; at: string;
  title?: string; criteria?: string[]; cases?: HoldCase[]; item?: string | null;
  into?: string; decision?: { id: string; requestedBy: string; approvedBy: string };
}
export interface Hold {
  outcome: string; title: string; outcomes: string[]; state: 'open' | 'cleared' | 'folded'; item: string | null;
  opened: { candidate: string; sha: string }; cleared: { candidate: string; sha: string } | null; foldedInto: string | null;
  cases: HoldCase[]; criteria: string[]; records: HoldRecord[];
}

export const holdTag = (record: HoldRecord) => `${holdTagPrefix}${record.outcome}/${record.kind === 'fold' ? `fold-${candidateId(new Date(record.at))}` : record.candidate}`;
const unique = (values: string[]) => [...new Set(values)];

/** Pure: every hold the ledger's records describe, oldest first. */
export function foldHolds(records: readonly HoldRecord[]): Hold[] {
  const order = { open: 0, attach: 1, fold: 2, clear: 3 };
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at) || order[a.kind] - order[b.kind] || a.outcome.localeCompare(b.outcome));
  const holds: Hold[] = []; const active = new Map<string, Hold>();
  for (const record of sorted) {
    if (record.kind === 'open') {
      if (active.has(record.outcome)) continue;
      const hold: Hold = { outcome: record.outcome, title: record.title ?? record.outcome, outcomes: [record.outcome], state: 'open', item: record.item ?? null,
        opened: { candidate: record.candidate!, sha: record.sha! }, cleared: null, foldedInto: null, cases: [...record.cases ?? []], criteria: [...record.criteria ?? []], records: [record] };
      holds.push(hold); active.set(record.outcome, hold);
      continue;
    }
    const hold = active.get(record.outcome);
    if (!hold) continue;
    if (record.kind === 'attach') { hold.cases.push(...record.cases ?? []); hold.criteria = unique([...hold.criteria, ...record.criteria ?? []]); hold.records.push(record); }
    if (record.kind === 'clear') {
      Object.assign(hold, { state: 'cleared', cleared: { candidate: record.candidate!, sha: record.sha! } }); hold.records.push(record);
      for (const outcome of hold.outcomes) active.delete(outcome);
    }
    if (record.kind === 'fold') {
      const into = active.get(record.into!);
      if (!into || into === hold) continue;
      into.outcomes.push(...hold.outcomes); into.cases.push(...hold.cases); into.criteria = unique([...into.criteria, ...hold.criteria]); into.records.push(record);
      Object.assign(hold, { state: 'folded', foldedInto: into.outcome }); hold.records.push(record);
      for (const outcome of hold.outcomes) active.set(outcome, into);
    }
  }
  return holds;
}

/**
 * The candidate's e2e release run as its UAT record keeps it, or null when the report is not the
 * candidate's own: another run, or a UAT that served another SHA, is never attributed to it.
 */
export function e2eRecord(report: E2eReport | null, candidate: ReleaseCandidate): E2eRecord | null {
  if (!report || report.sha !== candidate.sha || report.runId !== `rc-${candidate.id}`) return null;
  return { runId: report.runId, sha: report.sha, blocking: releaseVerdict(report).blocking.map(outcome => outcome.id),
    cases: report.cases.map(outcome => ({ case: outcome.id, verdict: outcome.verdict, required: outcome.required, ...(outcome.stoppedBy ? { stoppedBy: outcome.stoppedBy } : {}), attempts: outcome.attempts, failingStep: outcome.failingStep })) };
}

/**
 * Pure: what one validation does to the holds. Each contract outcome with a blocking case opens a
 * hold, or attaches to the open hold that already covers it; each open hold this validation did
 * not touch clears when every case attached to it passed in this run, the run is bound to the
 * candidate's exact SHA as UAT served it, and the candidate is newer than every attachment.
 */
export function assessHolds(contract: ReleaseContract, candidate: ReleaseCandidate, record: Pick<UatRecord, 'deployedSha'> & { e2e?: E2eRecord | null }, holds: readonly Hold[], at: string): HoldRecord[] {
  const e2e = record.e2e;
  if (!e2e || e2e.sha !== candidate.sha || record.deployedSha !== candidate.sha) return [];
  const open = holds.filter(hold => hold.state === 'open');
  const records: HoldRecord[] = [];
  for (const outcome of contract.outcomes) {
    const failing = e2e.cases.filter(entry => outcome.cases.includes(entry.case) && e2e.blocking.includes(entry.case));
    if (!failing.length) continue;
    const cases = failing.map(entry => ({ case: entry.case, verdict: entry.verdict as HoldCase['verdict'], candidate: candidate.id, sha: candidate.sha, runId: e2e.runId, attempts: entry.attempts, failingStep: entry.failingStep }));
    const existing = open.find(hold => hold.outcomes.includes(outcome.id));
    records.push({ kind: existing ? 'attach' : 'open', outcome: outcome.id, hold: existing?.outcome ?? outcome.id, candidate: candidate.id, sha: candidate.sha, at,
      title: outcome.title, criteria: outcome.criteria, cases, item: existing?.item ?? null });
  }
  for (const hold of open) {
    if (records.some(entry => entry.hold === hold.outcome)) continue;
    const passed = unique(hold.cases.map(entry => entry.case)).every(id => e2e.cases.find(entry => entry.case === id)?.verdict === 'passed');
    if (passed && hold.cases.every(entry => entry.candidate < candidate.id))
      records.push({ kind: 'clear', outcome: hold.outcome, hold: hold.outcome, candidate: candidate.id, sha: candidate.sha, at, item: hold.item });
  }
  return records;
}

const step = (entry: HoldCase) => entry.failingStep ? ` at step ${entry.failingStep.index + 1} (${entry.failingStep.name}): ${entry.failingStep.reason}` : '';
/** The work item an opened hold files: the customer risk, its failed cases and steps, and how it clears. */
export function holdItem(record: HoldRecord, candidate: ReleaseCandidate) {
  const cases = record.cases ?? [];
  const flaky = cases.filter(entry => entry.verdict === 'flaky');
  return {
    title: `Release hold: outcome ${record.outcome} failed UAT on candidate ${candidate.id} at ${candidate.sha.slice(0, 12)}`,
    description: `Customer outcome ${record.outcome} (${record.title ?? record.outcome}) failed UAT on release candidate ${candidate.id} at ${candidate.sha}. `
      + `Failed cases: ${cases.map(entry => `${entry.case} ${entry.verdict}${step(entry)}`).join('; ')}. `
      + (record.criteria?.length ? `Unmet criteria: ${record.criteria.join('; ')}. ` : '')
      + 'This hold collects every later failure of this outcome; it clears only when every attached case passes on a newer candidate UAT serves at its exact SHA. '
      + (flaky.length ? `A flaky case blocks promotion until an evidence decision on this item accepts it for its run and exact SHA (${flaky.map(entry => `{"case":"${entry.case}","runId":"${entry.runId}","sha":"${entry.sha}"}`).join(', ')}). ` : '')
      + 'Folding another outcome\'s hold into this one is a fold decision with an independent approver.',
    type: 'bug', priority: 1,
    criteria: [{ id: 'AC-1', text: `Every E2E case attached to the release hold of outcome ${record.outcome} passes on a newer UAT candidate served at its exact SHA`, proofs: ['manual:release-hold-cleared'] }],
    policy: { checks: ['test', 'typecheck'], review: true },
  };
}

/**
 * The holds step of `release validate`: keep the candidate's e2e verdicts on its record, file one
 * item per opened hold, and record every hold entry once the UAT record is written. The e2e suite's
 * failure is answered by the holds only when every blocking case landed in one; otherwise the
 * candidate's follow-up still names it, as it names every failure no case explains.
 */
export const releaseHolds = (git: Git, options: { contract: ReleaseContract | null; report: () => Promise<E2eReport | null>; push: boolean; now?: () => Date;
  file?: (item: ReturnType<typeof holdItem>, requestId: string) => Promise<string> }) => async (candidate: ReleaseCandidate, record: UatRecord): Promise<HoldOutcome> => {
  const e2e = e2eRecord(await options.report(), candidate);
  const planned = options.contract ? assessHolds(options.contract, candidate, { deployedSha: record.deployedSha, e2e }, foldHolds(readRecords<HoldRecord>(git, holdTagPrefix)), (options.now ?? (() => new Date()))().toISOString()) : [];
  let filingError: string | null = null;
  for (const entry of planned.filter(entry => entry.kind === 'open' && options.file)) {
    try { entry.item = await options.file!(holdItem(entry, candidate), holdRequestId(entry.outcome, candidate.id)); }
    catch (error) { filingError = error instanceof Error ? error.message : String(error); }
  }
  const held = new Set(planned.filter(entry => entry.kind !== 'clear').flatMap(entry => (entry.cases ?? []).map(held => held.case)));
  return { e2e, holds: planned.map(entry => ({ kind: entry.kind as 'open' | 'attach' | 'clear', outcome: entry.outcome, hold: entry.hold, item: entry.item ?? null })),
    covered: e2e?.blocking.length && e2e.blocking.every(id => held.has(id)) ? ['e2e'] : [], filingError,
    write: () => { for (const entry of planned) writeRecord(git, holdTag(entry), candidate.sha, entry, options.push); } };
};

/** A decision as `GET /api/work/ID/decisions` lists it. */
export interface ListedDecision { id: string; action: string; state: string; input: any; requestedBy: string; approvedBy: string | null }

/** The flaky results applied evidence decisions accept: requested by one agent and approved by another. */
export const acceptancesFrom = (decisions: readonly ListedDecision[]): FlakyAcceptance[] => decisions
  .filter(decision => decision.action === 'evidence' && decision.state === 'applied' && decision.approvedBy && decision.approvedBy !== decision.requestedBy)
  .map(decision => ({ case: decision.input.case, runId: decision.input.runId, sha: decision.input.sha, decision: decision.id }));

/** The hold items a candidate's failures landed in: where its evidence decisions are recorded. */
export const holdItemsFor = (holds: readonly Hold[], candidate: string) => unique(holds.filter(hold => hold.item && hold.cases.some(entry => entry.candidate === candidate)).map(hold => hold.item!));

/**
 * Pure: the fold record an applied `fold` decision authorizes. Folding is never automatic: it needs
 * the decision applied, approved by an identity other than its requester, and both outcomes'
 * holds open and distinct. Given the outcome being folded, the decision must name that outcome.
 */
export function foldRecord(holds: readonly Hold[], decision: ListedDecision, now: Date, outcome?: string): HoldRecord {
  if (decision.action !== 'fold') throw new Error(`Decision ${decision.id} is a ${decision.action} decision, not a fold`);
  if (outcome !== undefined && decision.input.outcome !== outcome) throw new Error(`Decision ${decision.id} folds outcome ${decision.input.outcome}, not ${outcome}`);
  if (decision.state !== 'applied' || !decision.approvedBy) throw new Error(`Decision ${decision.id} is ${decision.state}; folding two outcomes' holds needs an applied fold decision with an independent approver`);
  if (decision.approvedBy === decision.requestedBy) throw new Error(`Decision ${decision.id} was approved by its own requester ${decision.requestedBy}; a fold needs an independent approver`);
  const covering = (outcome: string) => holds.find(hold => hold.state === 'open' && hold.outcomes.includes(outcome));
  const from = covering(decision.input.outcome), into = covering(decision.input.into);
  if (!from || !into) throw new Error(`Outcome ${!from ? decision.input.outcome : decision.input.into} has no open release hold to fold`);
  if (from === into) throw new Error(`Outcomes ${decision.input.outcome} and ${decision.input.into} already share one hold`);
  return { kind: 'fold', outcome: from.outcome, hold: from.outcome, into: into.outcome, candidate: null, sha: from.opened.sha, at: now.toISOString(),
    decision: { id: decision.id, requestedBy: decision.requestedBy, approvedBy: decision.approvedBy } };
}
