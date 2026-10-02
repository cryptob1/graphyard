// Concern: the base-failure effects (GY-528) — a CI job's failing tests, the base head's latest run
// of a required check and a job's rerun, all through the master's own gh outside any coordination
// transaction, and the P0 filing and candidate refresh made as the operator-agent.
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model.js';
import { type BaseCheck, type baseFailureItem, parseFailedTests } from '../model/base-failure.js';

/** The effects the base-failure step uses; each is absent where the loop cannot perform it. */
export interface BaseFailureEffects {
  /**
   * GY-528. The failing test names in one CI job's log, read outside any coordination transaction
   * (a check run's id is its job's). A completed job's log does not change, so each is read once.
   */
  failedTests?: (jobId: number) => Promise<string[]>;
  /** GY-528. The latest completed run of one required check on the base branch head, read the same way. */
  baseCheck?: (check: string) => Promise<BaseCheck>;
  /** GY-528. Reruns one failed CI job of a candidate a base failure blocked, once the base passes again. */
  rerunJob?: (jobId: number) => Promise<void>;
  /** GY-528. Files the P0 item a base failure raises, as the operator-agent identity, under a key naming the test and base head. */
  fileBaseFailure?: (input: ReturnType<typeof baseFailureItem>, key: string) => Promise<Work>;
  /** GY-528. Asks the control plane to merge the repaired base into a blocked candidate's branch (the `refresh` command). */
  refreshCandidate?: (work: Work, reason: string, key: string) => Promise<Work>;
}

type OperatorAgentCall = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<unknown>;

/** The base-failure effects over the master's gh and, while one is provisioned, its operator-agent identity. */
export function baseFailureEffects(run: ChildRun, current: () => MasterConfig, asOperatorAgent: OperatorAgentCall): BaseFailureEffects {
  // A completed job's log never changes: each is read once, bounded, and a failed read is tried again.
  const logs = new Map<number, Promise<string[]>>();
  const failedTests = (jobId: number): Promise<string[]> => {
    const kept = logs.get(jobId);
    if (kept) return kept;
    if (logs.size >= 200) logs.delete(logs.keys().next().value!);
    // CI logs carry terminal colour codes, and gh refuses to print a response holding them unless
    // told to; `parseFailedTests` strips them itself.
    const entry = Promise.resolve(run('gh', ['api', '--allow-escape-sequences', `repos/${current().repository}/actions/jobs/${jobId}/logs`], { maxBuffer: 128 * 1024 * 1024 })).then(log => parseFailedTests(String(log)));
    logs.set(jobId, entry);
    entry.catch(() => { if (logs.get(jobId) === entry) logs.delete(jobId); });
    return entry;
  };
  // A check's latest completed run on the base head is cached per check to bound GitHub reads across cycles.
  const baseChecks = new Map<string, { at: number; baseSha: string; result: BaseCheck }>();
  const baseCheck = async (check: string): Promise<BaseCheck> => {
    const config = current();
    const cached = baseChecks.get(check);
    if (cached && Date.now() - cached.at < 30_000) return cached.result;
    // Every page, one JSON array per line: past a hundred runs of the check the latest completed one
    // is still seen, so a repaired base is never read as failing. Runs are of the newest run's commit.
    const pages = String(await run('gh', ['api', '--paginate', `repos/${config.repository}/commits/${encodeURIComponent(config.baseBranch)}/check-runs?check_name=${encodeURIComponent(check)}&per_page=100`, '--jq', '[.check_runs[] | {id, head_sha, status, conclusion, html_url}] | @json']));
    const listed: any[] = pages.split('\n').filter(line => line.trim()).flatMap(line => JSON.parse(line));
    const newest = listed.reduce<any>((latest, entry) => !latest || entry.id > latest.id ? entry : latest, null);
    const runs = newest ? listed.filter(entry => entry.head_sha === newest.head_sha) : [];
    const baseSha = String(newest?.head_sha ?? JSON.parse(String(await run('gh', ['api', `repos/${config.repository}/commits/${encodeURIComponent(config.baseBranch)}`, '--jq', '{sha: .sha}']))).sha);
    const completed = runs.filter(entry => entry.status === 'completed').sort((a, b) => b.id - a.id)[0];
    if (!completed) return { check, baseSha, state: runs.length ? 'pending' : 'none', jobId: null, url: null, tests: null };
    const state = completed.conclusion === 'success' ? 'passed' : ['failure', 'timed_out'].includes(completed.conclusion) ? 'failed' : 'none';
    const result: BaseCheck = { check, baseSha, state, jobId: completed.id, url: completed.html_url ?? null, tests: state === 'failed' ? await failedTests(completed.id).catch(() => null) : null };
    baseChecks.set(check, { at: Date.now(), baseSha, result });
    return result;
  };
  const rerunJob = async (jobId: number) => { await run('gh', ['api', '--method', 'POST', `repos/${current().repository}/actions/jobs/${jobId}/rerun`]); };
  return {
    failedTests, baseCheck, rerunJob,
    get fileBaseFailure() { return current().operatorAgent ? (input: ReturnType<typeof baseFailureItem>, key: string) => asOperatorAgent('POST', 'work', input, key) as Promise<Work> : undefined; },
    get refreshCandidate() { return current().operatorAgent ? (work: Work, reason: string, key: string) => asOperatorAgent('POST', `work/${work.id}/refresh`, { reason, base: work.observation?.baseTip }, key) as Promise<Work> : undefined; },
  };
}
