import { createHash, randomBytes } from 'node:crypto';

/**
 * GitHub for the zero-touch onboarding scenario (GY-1481), in process: the App manifest flow and its
 * conversion, installations, branch protection, branches and commits, pull requests, reviews, check
 * runs and merges. It decides nothing for Graphyard; it answers what Graphyard and its stubbed agent
 * runtimes ask and enforces what real GitHub enforces: a merge needs every required check passing
 * on the exact head from the App the protection binds it to, and the approving reviews it asks for
 * from someone other than the author.
 *
 * Every write names who made it. An App, the Actions runner or a command acting with a stored
 * credential is a machine; `person:` is a human acting by hand. Creating an App is the one step
 * GitHub itself makes a person confirm (Confirm access on the account that owns it): that request
 * is recorded in `approvals` and, with `autoApprove`, approved at once, as the operator would. Any
 * other write by a person is recorded in `humanSteps`, which the scenario requires to stay empty.
 */
export type Actor = `app:${string}` | `cli:${string}` | `person:${string}` | 'actions';
export interface FakeApp {
  id: number; slug: string; name: string; owner: string; pem: string; webhookSecret: string; clientId: string; clientSecret: string;
  botLogin: string; botId: number; installationId: number | null; events: string[]; permissions: Record<string, string>;
}
export interface FakeCommit { sha: string; parents: string[]; files: Map<string, string>; message: string; author: Actor }
export interface FakePull {
  number: number; nodeId: string; title: string; body: string; head: { ref: string; sha: string }; base: string; author: Actor;
  state: 'open' | 'closed'; merged: boolean; mergeSha: string | null; mergedBy: Actor | null; mergedAt: string | null;
}
export interface FakeReview { id: number; pr: number; sha: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; by: Actor; body: string }
export interface FakeCheckRun { id: number; name: string; head_sha: string; status: 'completed'; conclusion: 'success' | 'failure'; external_id: string; output: { title: string; summary: string }; app: { id: number } }
export interface Protection { checks: { context: string; app_id: number | null }[]; requiredApprovals: number }
export interface Approval { kind: 'app-approval'; app: string; by: string; approved: boolean }
export interface HumanStep { action: string; by: Actor; detail: string }

const sha1 = (...parts: unknown[]) => createHash('sha1').update(parts.map(String).join('\0')).digest('hex');

export class FakeGitHub {
  readonly owner: string; readonly name: string;
  readonly repositoryId = 7_001; readonly ownerId = 7_000;
  readonly defaultBranch = 'main';
  /** The App id GitHub Actions posts check runs as. */
  readonly actionsAppId = 15368;
  readonly apps: FakeApp[] = [];
  readonly approvals: Approval[] = [];
  readonly humanSteps: HumanStep[] = [];
  readonly branches = new Map<string, string>();
  readonly commits = new Map<string, FakeCommit>();
  readonly pulls = new Map<number, FakePull>();
  readonly reviews: FakeReview[] = [];
  readonly checkRuns: FakeCheckRun[] = [];
  protection: Protection | null = null;
  /** What GitHub Actions runs on every pushed head: the checks the repository's own workflow names. */
  workflowChecks: string[] = ['test', 'typecheck'];
  private manifests = new Map<string, { manifest: any; owner: string }>();
  private serial = 0;
  /** GitHub asks the account owner to confirm access once, then trusts the session for a while (sudo mode). */
  private confirmed = false;

  constructor(repository: string, readonly options: { autoApprove?: boolean; operator?: string } = {}) {
    [this.owner, this.name] = repository.split('/');
    const root = this.write(null, new Map([['README.md', `# ${this.name}\n`], ['package.json', '{"name":"shop","scripts":{"test":"node --test"}}\n'], ['.github/workflows/ci.yml', 'name: ci\non: [pull_request]\njobs:\n  test: { runs-on: ubuntu-latest, steps: [{ run: npm test }] }\n  typecheck: { runs-on: ubuntu-latest, steps: [{ run: npx tsc }] }\n']]), 'Initial commit', 'cli:seed');
    this.branches.set(this.defaultBranch, root);
  }

  get repository() { return `${this.owner}/${this.name}`; }
  private next() { return ++this.serial; }
  private person(by: Actor, action: string, detail: string) { if (by.startsWith('person:')) this.humanSteps.push({ action, by, detail }); }
  private write(parent: string | null, files: Map<string, string>, message: string, author: Actor) {
    const sha = sha1('commit', parent, message, [...files].sort().join('\n'), this.next());
    this.commits.set(sha, { sha, parents: parent ? [parent] : [], files, message, author });
    return sha;
  }

  // ---- The App manifest flow ----------------------------------------------------------------------

  /**
   * The person signed in to GitHub posts a manifest from the setup page (`POST /settings/apps/new`):
   * GitHub asks them to confirm access once, which `autoApprove` grants, then answers the redirect's
   * one-time code. Unconfirmed, nothing is created and the code is null.
   */
  submitManifest(manifest: { name: string; url: string; hook_attributes?: { url: string; active?: boolean }; redirect_url?: string; default_events?: string[]; default_permissions?: Record<string, string> }, by: string) {
    let approval: Approval | null = null;
    if (!this.confirmed) {
      approval = { kind: 'app-approval', app: manifest.name, by, approved: this.options.autoApprove !== false };
      this.approvals.push(approval);
      if (!approval.approved) return { code: null, approval };
      this.confirmed = true;
    }
    if (manifest.name.length > 34) throw new Error('Name cannot be longer than 34 characters');
    if (manifest.default_events?.length && !manifest.hook_attributes?.url) throw new Error('Hook url cannot be blank');
    const code = randomBytes(10).toString('hex');
    this.manifests.set(code, { manifest, owner: this.owner });
    return { code, approval };
  }
  /** `POST /app-manifests/:code/conversions`: the App's id and one-time credentials, once per code. */
  convert(code: string) {
    const pending = this.manifests.get(code);
    if (!pending) throw new Error(`Not Found: manifest code ${code}`);
    this.manifests.delete(code);
    const id = 900 + this.apps.length + 1;
    const slug = pending.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const app: FakeApp = { id, slug, name: pending.manifest.name, owner: pending.owner, pem: `-----BEGIN RSA PRIVATE KEY-----\n${randomBytes(24).toString('base64')}\n-----END RSA PRIVATE KEY-----\n`,
      webhookSecret: randomBytes(16).toString('hex'), clientId: `Iv1.${randomBytes(8).toString('hex')}`, clientSecret: randomBytes(20).toString('hex'),
      botLogin: `${slug}[bot]`, botId: 50_000 + id, installationId: null, events: pending.manifest.default_events ?? [], permissions: pending.manifest.default_permissions ?? {} };
    this.apps.push(app);
    return { id: app.id, slug: app.slug, name: app.name, pem: app.pem, webhook_secret: app.webhookSecret, client_id: app.clientId, client_secret: app.clientSecret, owner: { login: app.owner } };
  }
  /** Installing an App on this repository (`/apps/:slug/installations/new`, repository preselected): within the confirmed session, no further confirmation. */
  install(slug: string, repositoryIds: number[], by: string) {
    const app = this.app(slug);
    if (!repositoryIds.includes(this.repositoryId)) throw new Error(`${slug} was not installed on ${this.repository}`);
    if (!this.confirmed) { this.approvals.push({ kind: 'app-approval', app: app.name, by, approved: this.options.autoApprove !== false }); if (this.options.autoApprove === false) return null; this.confirmed = true; }
    app.installationId ??= 8_000 + app.id;
    return app.installationId;
  }
  app(slugOrId: string | number) {
    const app = this.apps.find(entry => entry.slug === slugOrId || entry.id === slugOrId);
    if (!app) throw new Error(`Not Found: App ${slugOrId}`);
    return app;
  }
  /** `GET /repos/:owner/:repo/installation` as App SLUG reads it. */
  installationFor(slug: string) {
    const app = this.app(slug);
    return app.installationId ? { id: app.installationId, app_id: app.id, account: { login: this.owner, id: this.ownerId } } : null;
  }

  // ---- Branch protection --------------------------------------------------------------------------

  /** `PUT /repos/:owner/:repo/branches/main/protection`, by an App installed here or a command with the operator's credential. */
  protect(protection: Protection, by: Actor) {
    this.person(by, 'protect', 'branch protection set by hand');
    this.protection = { checks: protection.checks.map(check => ({ ...check })), requiredApprovals: protection.requiredApprovals };
  }

  // ---- Branches, commits and Actions ------------------------------------------------------------------

  /** Push FILES onto BRANCH (created from the base branch's tip when new) as one commit; Actions runs the workflow's checks on it. */
  push(branch: string, files: Record<string, string>, message: string, by: Actor) {
    this.person(by, 'push', `${branch}: pushed by hand`);
    const parent = this.branches.get(branch) ?? this.branches.get(this.defaultBranch)!;
    const tree = new Map(this.commits.get(parent)!.files);
    for (const [path, content] of Object.entries(files)) tree.set(path, content);
    const sha = this.write(parent, tree, message, by);
    this.branches.set(branch, sha);
    for (const pull of this.pulls.values()) if (pull.state === 'open' && pull.head.ref === branch) pull.head.sha = sha;
    this.runActions(sha);
    return sha;
  }
  /** GitHub Actions: each check the repository's workflow names, passing, as the Actions App. */
  runActions(head: string) {
    for (const name of this.workflowChecks) if (!this.checkRuns.some(run => run.head_sha === head && run.name === name && run.app.id === this.actionsAppId))
      this.checkRuns.push({ id: this.next(), name, head_sha: head, status: 'completed', conclusion: 'success', external_id: '', output: { title: name, summary: 'passed' }, app: { id: this.actionsAppId } });
  }
  /** A check run published by App APPID on HEAD; the latest of a name replaces the earlier one. */
  check(head: string, name: string, conclusion: 'success' | 'failure', appId: number, extra: Partial<Pick<FakeCheckRun, 'external_id' | 'output'>> = {}) {
    const existing = this.checkRuns.find(run => run.head_sha === head && run.name === name && run.app.id === appId);
    if (existing) { Object.assign(existing, { conclusion, ...extra }); return existing; }
    const run: FakeCheckRun = { id: this.next(), name, head_sha: head, status: 'completed', conclusion, external_id: extra.external_id ?? '', output: extra.output ?? { title: name, summary: '' }, app: { id: appId } };
    this.checkRuns.push(run);
    return run;
  }
  files(ref: string) { return this.commits.get(this.branches.get(ref) ?? ref)?.files ?? new Map<string, string>(); }

  // ---- Pull requests, reviews and merges --------------------------------------------------------------

  openPull(input: { head: string; base?: string; title: string; body: string }, by: Actor) {
    const existing = [...this.pulls.values()].find(pull => pull.state === 'open' && pull.head.ref === input.head);
    if (existing) return existing;
    const sha = this.branches.get(input.head);
    if (!sha) throw new Error(`Validation Failed: head ${input.head} does not exist`);
    const number = this.pulls.size + 1;
    const pull: FakePull = { number, nodeId: `PR_${number}`, title: input.title, body: input.body, head: { ref: input.head, sha }, base: input.base ?? this.defaultBranch, author: by, state: 'open', merged: false, mergeSha: null, mergedBy: null, mergedAt: null };
    this.pulls.set(number, pull);
    return pull;
  }
  pull(number: number) {
    const pull = this.pulls.get(number);
    if (!pull) throw new Error(`Not Found: pull request #${number}`);
    return pull;
  }
  /** A review of PR at SHA. GitHub refuses an author's approval of their own pull request. */
  review(pr: number, review: { sha: string; state: FakeReview['state']; body: string }, by: Actor) {
    const pull = this.pull(pr);
    if (review.state === 'APPROVED' && by === pull.author) throw new Error('Can not approve your own pull request');
    this.person(by, 'review', `#${pr} reviewed by hand`);
    const entry: FakeReview = { id: this.next(), pr, ...review, by };
    this.reviews.push(entry);
    return entry;
  }
  /** Why GitHub refuses to merge PR at HEAD now, or null when it would merge. */
  mergeRefusal(pr: number, head: string) {
    const pull = this.pull(pr);
    if (pull.merged || pull.state !== 'open') return `#${pr} is not open`;
    if (pull.head.sha !== head) return 'Head branch was modified. Review and try the merge again.';
    for (const check of this.protection?.checks ?? []) {
      const run = this.checkRuns.find(entry => entry.head_sha === head && entry.name === check.context && (check.app_id === null || entry.app.id === check.app_id));
      if (run?.conclusion !== 'success') return `Required status check "${check.context}" is expected.`;
    }
    const approvals = new Set(this.reviews.filter(entry => entry.pr === pr && entry.sha === head && entry.state === 'APPROVED' && entry.by !== pull.author).map(entry => entry.by));
    if (approvals.size < (this.protection?.requiredApprovals ?? 0)) return `At least ${this.protection!.requiredApprovals} approving review is required by reviewers with write access.`;
    return null;
  }
  /** Merge PR at HEAD, as BY, under the branch's protection; the base branch moves to a merge commit holding the head's files. */
  merge(pr: number, head: string, by: Actor) {
    const refusal = this.mergeRefusal(pr, head);
    if (refusal) throw new Error(refusal);
    this.person(by, 'merge', `#${pr} merged by hand`);
    const pull = this.pull(pr), base = this.branches.get(pull.base)!;
    const files = new Map(this.commits.get(base)!.files);
    for (const [path, content] of this.commits.get(head)!.files) files.set(path, content);
    const merged = this.write(base, files, `Merge pull request #${pr} from ${pull.head.ref}`, by);
    this.commits.get(merged)!.parents.push(head);
    this.branches.set(pull.base, merged);
    Object.assign(pull, { state: 'closed', merged: true, mergeSha: merged, mergedBy: by, mergedAt: new Date().toISOString() });
    return merged;
  }
  /** The pull request as the REST API shows it. */
  view(pr: number) {
    const pull = this.pull(pr);
    return { number: pull.number, node_id: pull.nodeId, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged, merge_commit_sha: pull.mergeSha, merged_at: pull.mergedAt,
      head: { sha: pull.head.sha, ref: pull.head.ref }, base: { ref: pull.base, sha: this.branches.get(pull.base) }, mergeable: true, mergeable_state: 'clean', user: { login: pull.author } };
  }

  /**
   * The control plane's GitHub adapter as its acceptance land route uses it (LandingGitHub), acting as
   * the control-plane App: reading the pull request, publishing its App-bound check runs and merging
   * head-bound through GraphQL, which GitHub refuses until protection is satisfied.
   */
  landing(app: FakeApp) {
    const as: Actor = `app:${app.slug}`;
    return {
      config: { base: this.defaultBranch, appId: app.id, repository: this.repository },
      request: async (path: string, method = 'GET', body?: any) => {
        const pr = Number(path.match(/^\/(?:pulls|issues)\/(\d+)/)?.[1]);
        if (method === 'GET' && path.startsWith('/pulls/')) return this.view(pr);
        if (method === 'PATCH' && path.startsWith('/pulls/')) { if (body?.state === 'closed') this.pull(pr).state = 'closed'; return this.view(pr); }
        if (path.startsWith('/issues/')) return {};
        if (path === '/check-runs') return this.check(body.head_sha, body.name, body.conclusion, app.id, { external_id: body.external_id, output: body.output });
        if (path.startsWith('/check-runs/')) { const run = this.checkRuns.find(entry => entry.id === Number(path.split('/')[2]))!; Object.assign(run, body); return run; }
        throw new Error(`unexpected GitHub call ${method} ${path}`);
      },
      pages: async (path: string) => {
        const [, head, name] = path.match(/^\/commits\/([0-9a-f]+)\/check-runs\?check_name=([^&]+)/) ?? [];
        return this.checkRuns.filter(run => run.head_sha === head && run.name === decodeURIComponent(name ?? ''));
      },
      upsertLandable: async (body: any) => { this.check(body.head_sha, body.name, body.conclusion, app.id, { external_id: body.external_id, output: body.output }); },
      graphql: async (_query: string, variables: { id: string; head: string }) => { this.merge(Number(variables.id.slice(3)), variables.head, as); return {}; },
    };
  }
}
