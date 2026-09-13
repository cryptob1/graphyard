import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Engine } from './engine.js';
import { demand, type Observation, type Work } from './model.js';

export const CHECK_NAME = 'Graphyard / merge';
export interface GitHubConfig { repository: string; base: string; appId: number; installationId: number; privateKey: string }
export class GitHub {
  private token = '';
  private expires = 0;
  constructor(public config: GitHubConfig) {}
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    if (this.expires < Date.now() + 60_000) {
      const now = Math.floor(Date.now() / 1000);
      const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(this.config.appId) })}`;
      const signer = createSign('RSA-SHA256').update(unsigned);
      const jwt = `${unsigned}.${signer.sign(this.config.privateKey, 'base64url')}`;
      const response = await fetch(`https://api.github.com/app/installations/${this.config.installationId}/access_tokens`, {
        method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000),
      });
      demand(response.ok, `GitHub installation authentication failed (${response.status})`, 502);
      const result: any = await response.json();
      this.token = result.token; this.expires = Date.parse(result.expires_at);
    }
    const response = await fetch(`https://api.github.com/repos/${this.config.repository}${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    demand(response.ok, `GitHub ${method} ${path} failed (${response.status})`, 502);
    return response.status === 204 ? null : response.json();
  }
  async pages(path: string, field?: string): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const rows = field ? response[field] : response;
      demand(Array.isArray(rows), 'Unexpected GitHub response', 502);
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error('GitHub pagination exceeded safety limit; refusing incomplete evidence');
  }
  async protection() {
    try {
      const p = await this.request(`/branches/${encodeURIComponent(this.config.base)}/protection`);
      return !!p.required_status_checks?.strict && !!p.enforce_admins?.enabled && !p.allow_force_pushes?.enabled && !p.allow_deletions?.enabled
        && p.required_status_checks.checks?.some((c: any) => c.context === CHECK_NAME && c.app_id === this.config.appId);
    } catch { return false; }
  }
  async observe(work: Work): Promise<Observation> {
    const pr = await this.request(`/pulls/${work.submission!.pr}`);
    demand(pr.base.repo.full_name.toLowerCase() === this.config.repository.toLowerCase() && pr.head.repo?.full_name.toLowerCase() === this.config.repository.toLowerCase(), 'MVP requires same-repository pull requests');
    demand(pr.base.ref === this.config.base, 'Pull request targets an unmanaged branch');
    const [checks, reviews, protectedBranch, files] = await Promise.all([
      this.pages(`/commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs'), this.pages(`/pulls/${pr.number}/reviews`), this.protection(), this.pages(`/pulls/${pr.number}/files`),
    ]);
    const latest = new Map<string, any>();
    for (const r of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
    return {
      candidate: { sha: pr.head.sha, baseSha: pr.merged && work.candidate && work.candidate.sha === pr.head.sha ? work.candidate.baseSha : pr.base.sha, pr: pr.number, branch: pr.head.ref, author: pr.user.login },
      checks: checks.filter(c => c.name !== CHECK_NAME).map(c => ({ name: c.name, result: c.status === 'completed' ? c.conclusion : c.status, appId: c.app.id })),
      reviews: [...latest.values()].map(r => ({ reviewer: r.user.login, sha: r.commit_id, state: r.state })),
      merged: pr.merged, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, mergeable: pr.mergeable === true && !pr.draft && pr.state === 'open',
      protected: protectedBranch, files: files.map(f => f.filename), at: new Date().toISOString(),
    };
  }
  async publish(work: Work, forcedReason?: string) {
    if (!work.candidate) return;
    const pr = await this.request(`/pulls/${work.candidate.pr}`);
    demand(pr.head.sha === work.candidate.sha && pr.base.sha === work.candidate.baseSha, 'PR changed before check publication; retry');
    const reasons = [...work.gates.flatMap(g => g.reasons), ...work.violations, ...(forcedReason ? [forcedReason] : [])];
    const existing = (await this.pages(`/commits/${work.candidate.sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`, 'check_runs')).find(c => c.app.id === this.config.appId);
    const body = { name: CHECK_NAME, head_sha: work.candidate.sha, status: 'completed', conclusion: reasons.length ? 'failure' : 'success', external_id: work.id,
      output: { title: reasons.length ? 'REFUSED' : 'All required gates passed', summary: (reasons.length ? reasons.map(r => `- ${r}`).join('\n') : `Candidate ${work.candidate.sha}; base ${work.candidate.baseSha}; policy ${work.policyRevision}; revision ${work.revision}`).slice(0, 60000) } };
    await this.request(existing ? `/check-runs/${existing.id}` : '/check-runs', existing ? 'PATCH' : 'POST', body);
  }
}
export async function githubFromEnv() {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_REPOSITORY) return null;
  const privateKey = process.env.GITHUB_PRIVATE_KEY ?? await readFile(process.env.GITHUB_PRIVATE_KEY_FILE!, 'utf8');
  return new GitHub({ repository: process.env.GITHUB_REPOSITORY, base: process.env.GITHUB_BASE_BRANCH ?? 'main', appId: Number(process.env.GITHUB_APP_ID), installationId: Number(process.env.GITHUB_INSTALLATION_ID), privateKey });
}
export async function processJob(engine: Engine, github: GitHub) {
  const job = await engine.store.takeJob();
  if (!job) return;
  let work: Work | undefined;
  try {
    work = (await engine.store.list()).find(w => w.id === job.work_id);
    if (work?.submission && work.stage !== 'done') {
      const observation = await github.observe(work);
      work = await engine.observe(work.id, work.revision, observation);
      const ownership = await engine.store.pool.query('SELECT 1 FROM jobs WHERE work_id=$1 AND token=$2 AND locked_until>now()', [job.work_id, job.token]);
      demand(ownership.rowCount, 'Integration job lease expired; retry');
      if (!observation.merged) await github.publish(work);
    }
    await engine.store.finishJob(job.work_id, job.token);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub reconciliation failed';
    if (work?.candidate) try { await github.publish(work, 'Reconciliation failed; fresh verification required'); } catch { /* Durable retry follows. */ }
    await engine.store.finishJob(job.work_id, job.token, message);
  }
}
