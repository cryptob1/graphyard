// Concern: the plane's exact-candidate ports (GY-1904, GY-1905) — the `/api/candidates` routes as the loop's client reaches them, and the pure verdict and gate helpers beside them.
import { createHash } from 'node:crypto';
import type { AsyncGit, ReleaseCandidate, UatRecord } from '../release-candidate.js';
import type { ExactCandidate } from '../model/release.js';
import type { GatedValidation, PromotionRequest } from '../server/routes/candidates.js';

/**
 * GY-1904: the plane's `/api/candidates` routes as the loop reaches them. `cut` asks for the next
 * scheduled cut and answers the plane's refusal (409: nothing due yet) as `{ refused }`; `list` reads
 * the newest candidates with their validations; `validated` appends one candidate's UAT verdict.
 */
export interface ExactCandidatePorts {
  cut(input: { trigger: 'schedule'; waitMinutes: number; since?: string; sinceSha?: string }): Promise<ExactCandidate | { refused: string }>;
  list(): Promise<ExactCandidate[]>;
  validated(id: string, validation: Omit<GatedValidation, 'at' | 'by'>): Promise<unknown>;
  /** GY-1905: selects the candidate for the environment, or answers the plane's refusal (409) as `{ refused }`. */
  promote(id: string, ask: PromotionRequest): Promise<ExactCandidate | { refused: string }>;
}
/**
 * The ports over the plane's client: `mutate` posts as the coordinator under a request id (the
 * Idempotency-Key), `read` gets. A cut's key names the newest candidate it follows and the minute, so
 * a retried cycle replays its cut; a verdict's names the candidate and its `rc/ID`.
 */
export const exactCandidatePorts = (mutate: (path: string, data: unknown, requestId?: string) => Promise<any>, read: (path: string) => Promise<any>): ExactCandidatePorts => {
  /** The plane's answer to a refused write (409), as the master's client throws it: a confirmed refusal carrying the body. */
  const refused = (error: unknown) => {
    const refusal = error as Error & { confirmedRefusal?: boolean; status?: number };
    if (!refusal.confirmedRefusal && !(refusal.status && refusal.status < 500)) throw error;
    try { return { refused: String(JSON.parse(refusal.message).error ?? refusal.message) }; } catch { return { refused: refusal.message }; }
  };
  return {
    list: async () => (await read('candidates')).candidates as ExactCandidate[],
    cut: async input => {
      const after = ((await read('candidates')).candidates as ExactCandidate[])[0]?.id ?? 'none';
      try { return await mutate('candidates', input, `candidate-cut:${after}:${new Date().toISOString().slice(0, 16)}`) as ExactCandidate; } catch (error) { return refused(error); }
    },
    validated: (id, validation) => mutate(`candidates/${encodeURIComponent(id)}/validation`, validation, `candidate-validation:${id}:${validation.release}`),
    promote: async (id, ask) => {
      try { return await mutate(`candidates/${encodeURIComponent(id)}/promotion`, ask, `candidate-promotion:${id}:${ask.environment}:${ask.release}:${ask.artifact}`) as ExactCandidate; } catch (error) { return refused(error); }
    },
  };
};
/** A case verdict as a candidate records it: `pass`/`fail` like the validation's own result (GY-1905); any other verdict as the run gave it. */
const caseResult = (verdict: string) => verdict === 'passed' ? 'pass' : verdict === 'failed' ? 'fail' : verdict;
/**
 * Pure: the verdict an exact candidate records from the UAT record its `rc/ID` was judged by, with
 * the artifact it ran against and when the run was recorded (GY-1905). A required case that failed
 * while its outcome was pending (GY-1802) is recorded `pending`: the run did not block on it, but it
 * did not pass, so the promotion gate refuses it.
 */
export const exactValidation = (record: Pick<ReleaseCandidate, 'id' | 'sha' | 'exact'> & { exact: NonNullable<ReleaseCandidate['exact']> }, uat: Pick<UatRecord, 'result' | 'suites' | 'e2e'> & Partial<Pick<UatRecord, 'at'>>, artifact?: string): Omit<GatedValidation, 'at' | 'by'> => ({
  release: record.id, sha: record.sha, identity: record.exact.identity, result: uat.result === 'passed' ? 'pass' : 'fail',
  cases: (uat.e2e?.cases ?? []).map(entry => ({ id: entry.case, result: entry.pending && entry.verdict !== 'passed' ? 'pending' : caseResult(entry.verdict) })),
  failed: [...new Set([...uat.suites.filter(suite => !suite.passed).map(suite => suite.name), ...(uat.e2e?.blocking ?? [])])],
  required: (uat.e2e?.cases ?? []).filter(entry => entry.required).map(entry => entry.case),
  ...(artifact ? { artifact } : {}),
  ...(uat.at ? { ranAt: uat.at } : {}),
});
/**
 * GY-1905: what a candidate deploys as. Its build's artifact digests only when the digest adapter is
 * selected (`byDigests`), as deployToUatAsync and promoteAsync then deploy them; else both deploy the
 * commit, so the artifact is its source tree even when a build was recorded.
 */
export async function candidateArtifact(git: AsyncGit, record: Pick<ReleaseCandidate, 'sha' | 'build'>, byDigests = false): Promise<string> {
  const artifacts = byDigests ? record.build?.artifacts ?? [] : [];
  if (artifacts.length) return `sha256:${createHash('sha256').update(artifacts.map(entry => `${entry.service} ${entry.digest}`).sort().join('\n')).digest('hex')}`;
  return `tree:${(await git(['rev-parse', `${record.sha}^{tree}`])).trim().toLowerCase()}`;
}
/** GY-1905: the ids of the required cases under `e2e/cases/` in the commit `sha`; a file that does not parse fails closed, naming it. */
export async function requiredCaseIds(git: AsyncGit, sha: string): Promise<string[]> {
  let names: string[];
  try { names = (await git(['ls-tree', '--name-only', `${sha}:e2e/cases`])).split('\n').map(line => line.trim()).filter(name => name.endsWith('.json')); } catch { return []; }
  const ids: string[] = [];
  for (const name of names.sort()) {
    let definition: { id?: unknown; required?: unknown };
    try { definition = JSON.parse(await git(['show', `${sha}:e2e/cases/${name}`])); } catch { ids.push(`unreadable:${name}`); continue; }
    if (definition.required === true) ids.push(typeof definition.id === 'string' ? definition.id : `unreadable:${name}`);
  }
  return ids;
}
/**
 * GY-1905: the exact-candidate gate the promoter asks last, before any deployer runs. A record with
 * no exact candidate behind it is refused once the plane cuts them; else the plane selects the
 * candidate for production only when its recorded validation passed every required case the
 * candidate's own commit declares, on exactly this source, identity and artifact (`promotionRefusals`).
 */
export async function exactPromotionGate(ports: ExactCandidatePorts, git: AsyncGit, record: ReleaseCandidate, byDigests = false): Promise<string[]> {
  if (!record.exact) return [`${record.id} is not an exact candidate the plane cut, so no combined validation binds it`];
  const answer = await ports.promote(record.exact.id, { environment: 'production', release: record.id, sha: record.sha, identity: record.exact.identity,
    artifact: await candidateArtifact(git, record, byDigests), required: await requiredCaseIds(git, record.sha) });
  return 'refused' in answer ? [answer.refused] : [];
}
