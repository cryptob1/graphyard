import { createHmac, timingSafeEqual } from 'node:crypto';
import { demand } from '../../model.js';
import { defineRoutes } from '../routes.js';
import { observationEvents } from '../../github.js';
import { wakeFromWebhook } from '../../store/store.js';
import { baseChangeFiles, baseMoveWakes } from '../../observation-priority.js';
import type { Work } from '../../model.js';

/**
 * GitHub webhook: HMAC-verified, deduplicated in Postgres, wakes the durable jobs. Observation
 * events (pull_request, pull_request_review, check_run, check_suite, push) also stamp the woken
 * jobs' webhook wake, so any replica claims them ahead of polled jobs, and base-branch pushes and
 * protection events end the receiving adapter's shared reads (GY-806). A base-branch push wakes only
 * the open items it can affect (GY-1231, `baseMoveWakes`); the rest keep their cadence.
 */
export const githubRoutes = defineRoutes('github', [
  {
    method: 'POST', path: '/api/github/webhook',
    async handle(context) {
      const { req, services: { engine, github } } = context;
      const raw = await context.body(); const secret = process.env.GITHUB_WEBHOOK_SECRET;
      demand(secret, 'Webhook not configured', 503);
      const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
      const actual = Buffer.from(String(req.headers['x-hub-signature-256'] ?? ''));
      demand(expected.length === actual.length && timingSafeEqual(expected, actual), 'Invalid webhook signature', 401);
      const payload = JSON.parse(raw.toString());
      demand(payload.repository?.full_name?.toLowerCase() === github?.config.repository.toLowerCase(), 'Repository is not managed', 403);
      // Our own check publications must not create an endless webhook/publish loop.
      if (payload.check_run?.app?.id === github?.config.appId) return context.send(202, { accepted: true, ignored: 'own check' });
      const delivery = String(req.headers['x-github-delivery'] ?? ''); demand(delivery && delivery.length < 200, 'Missing delivery ID', 400);
      const event = String(req.headers['x-github-event'] ?? '');
      const delivered = await engine.store.transaction(async db => {
        const result = await db.query('INSERT INTO webhook_receipts(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [delivery]);
        if (!result.rowCount) return null;
        // Wake only the items the event is about; a move of the base branch or a queue ref touches them all.
        let subjects = webhookSubjects(payload, github?.config.base ?? 'main');
        if (subjects.all && payload?.ref === `refs/heads/${github?.config.base ?? 'main'}`) {
          const open = (await db.query("SELECT document FROM work_items WHERE document->>'stage' <> 'done'")).rows.map(row => row.document as Work);
          subjects = baseMoveSubjects(subjects, open, baseChangeFiles(payload));
        }
        if (!subjects.all && !subjects.prs.length && !subjects.shas.length && !subjects.branches.length) return [];
        // An observation event also stamps the job's webhook wake (GY-806), which every replica's claim puts first.
        return wakeFromWebhook(db, subjects, (observationEvents as readonly string[]).includes(event));
      });
      // Only after the wake committed, and once per delivery: the receiving adapter's shared reads end here.
      if (delivered) github?.noteWebhook?.(event, payload);
      return context.send(202, { accepted: true });
    },
  },
]);

/**
 * What a push to the base branch wakes (GY-1231): with the pushed files known, not every job but the
 * pull requests of the open items `baseMoveWakes` selects, alongside whatever else the push named;
 * with them unknown, every job as before.
 */
export function baseMoveSubjects(subjects: ReturnType<typeof webhookSubjects>, open: Work[], baseFiles: string[] | null): ReturnType<typeof webhookSubjects> {
  if (!baseFiles) return subjects;
  const woken = new Set(baseMoveWakes(open, baseFiles));
  const prs = open.filter(work => woken.has(work.id)).map(work => work.submission!.pr);
  return { ...subjects, all: false, prs: [...new Set([...subjects.prs, ...prs])] };
}

/**
 * The pull requests, commits and branches a webhook names, or `all` when it moved the base branch
 * or a merge-queue ref. A push to any other branch names that branch and its new head, so a
 * worker's push to its pull-request branch reaches the item before its candidate names the SHA.
 */
export function webhookSubjects(payload: any, base: string): { all: boolean; prs: number[]; shas: string[]; branches: string[] } {
  const ref = typeof payload?.ref === 'string' ? payload.ref : '';
  const all = !!payload?.after && (ref === `refs/heads/${base}` || ref.startsWith('refs/graphyard/'));
  const prs = new Set<number>(); const shas = new Set<string>();
  const pr = (n: unknown) => { if (Number.isSafeInteger(n) && (n as number) > 0) prs.add(n as number); };
  const sha = (s: unknown) => { if (typeof s === 'string' && /^[a-f0-9]{40}$/.test(s)) shas.add(s); };
  pr(payload?.pull_request?.number); sha(payload?.pull_request?.head?.sha);
  if (payload?.issue?.pull_request) pr(payload.issue.number);
  for (const run of [payload?.check_run, payload?.check_suite, payload?.workflow_run, payload?.workflow_job]) {
    if (!run) continue;
    sha(run.head_sha);
    for (const linked of Array.isArray(run.pull_requests) ? run.pull_requests : []) pr(linked?.number);
  }
  if (payload?.state && payload?.sha) sha(payload.sha);
  const branches = !all && ref.startsWith('refs/heads/') && payload?.after ? [ref.slice('refs/heads/'.length)] : [];
  if (branches.length) sha(payload.after);
  return { all, prs: [...prs], shas: [...shas], branches };
}

