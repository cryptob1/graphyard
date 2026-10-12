import { createHmac, timingSafeEqual } from 'node:crypto';
import { Refusal, demand } from '../../model.js';
import { defineRoutes, requestFailure } from '../routes.js';
import { observationEvents } from '../../github.js';
import { wakeFromWebhook } from '../../store/store.js';
import { baseChangeFiles, baseMoveWakes, type BaseMoveItem } from '../../observation-priority.js';

/**
 * GitHub webhook: HMAC-verified, deduplicated in Postgres, wakes the durable jobs. Observation
 * events (pull_request, pull_request_review, check_run, check_suite, push) also stamp the woken
 * jobs' webhook wake, so any replica claims them ahead of polled jobs, and base-branch pushes and
 * protection events end the receiving adapter's shared reads (GY-806). A base-branch push wakes only
 * the open items it can affect (GY-1231, `baseMoveWakes`); the rest keep their cadence.
 *
 * A verified delivery never answers 5xx (GY-1700): while startup validation has not completed, or
 * when the wake transaction fails, the route soft-accepts with 202 and a logged ignore reason so
 * GitHub's delivery log stays clean; safety-net polling covers the gap. Auth and repository
 * refusals stay 4xx/503 as before. A delivery that wakes no job also answers 202 with a named
 * `ignored` reason, logged with its delivery ID and event (GY-1731): our own check run, a duplicate
 * delivery ID, a payload naming no subject, or subjects naming no open job; one that wakes a job carries none.
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
      // Optional-chain the whole managed-repo path: an unset App block must refuse with 403, not throw
      // TypeError into the server's 500 handler (GY-1700).
      const managed = github?.config.repository?.toLowerCase();
      demand(managed && payload?.repository?.full_name?.toLowerCase() === managed, 'Repository is not managed', 403);
      const delivery = String(req.headers['x-github-delivery'] ?? ''); demand(delivery && delivery.length < 200, 'Missing delivery ID', 400);
      const event = String(req.headers['x-github-event'] ?? '');
      // Our own check publications must not create an endless webhook/publish loop; like any unwoken delivery, say why.
      if (payload.check_run?.app?.id === github?.config.appId) {
        console.error(`webhook delivery ${delivery} (${event || 'unknown'}) accepted without wake: own check`);
        return context.send(202, { accepted: true, ignored: 'own check' });
      }
      // Startup / shutdown: accept without waking so a deploy burst never 500s (GY-1700, GY-1127).
      // No receipt is written, so a later redelivery after ready can still wake; polling covers the gap.
      if ((context.services as { readiness?: boolean }).readiness === false) {
        console.error(`webhook delivery ${delivery} (${event || 'unknown'}) accepted without wake: startup validation has not completed; polling covers the gap`);
        return context.send(202, { accepted: true, ignored: 'startup validation' });
      }
      let delivered: { woken: string[]; ignored?: string } | null;
      try {
        delivered = await engine.store.transaction(async db => {
          const result = await db.query('INSERT INTO webhook_receipts(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [delivery]);
          if (!result.rowCount) return null;
          // Wake only the items the event is about; a move of the base branch or a queue ref touches them all.
          let subjects = webhookSubjects(payload, github?.config.base ?? 'main');
          if (!named(subjects)) return { woken: [], ignored: 'no subject' };
          if (subjects.all && payload?.ref === `refs/heads/${github?.config.base ?? 'main'}`) {
            // Only what the selection reads, of the open items the work index names: never every document whole.
            const open = (await db.query(`SELECT w.id::text AS id, i.stage, w.document->'submission' AS submission,
              jsonb_build_object('files', w.document->'observation'->'files', 'mergeableState', w.document->'observation'->'mergeableState',
                'conflicting', w.document->'observation'->'conflicting', 'mergeabilityUnknown', w.document->'observation'->'mergeabilityUnknown') AS observation,
              jsonb_typeof(w.document->'observation') = 'object' AS observed
              FROM work_items w JOIN work_index i ON i.id = w.id WHERE i.stage <> 'done' AND w.document->'submission'->'pr' IS NOT NULL`)).rows
              .map(row => ({ id: row.id, stage: row.stage, submission: row.submission, observation: row.observed ? { ...row.observation, files: row.observation.files ?? [] } : null }) as BaseMoveItem);
            subjects = baseMoveSubjects(subjects, open, baseChangeFiles(payload));
          }
          // An observation event also stamps the job's webhook wake (GY-806), which every replica's claim puts first.
          // A base push that can affect no open item names no open job, like a delivery whose items are all done.
          const woken = named(subjects) ? await wakeFromWebhook(db, subjects, (observationEvents as readonly string[]).includes(event)) : [];
          return woken.length ? { woken } : { woken, ignored: 'no open job' };
        });
      } catch (error) {
        if (error instanceof Refusal) throw error;
        // Soft-accept: a 5xx here is what GitHub recorded during the GY-1700 deploy burst.
        console.error(requestFailure(req.method, req.url, error));
        console.error(`webhook delivery ${delivery} (${event || 'unknown'}) accepted without wake: wake failed; polling covers the gap`);
        return context.send(202, { accepted: true, ignored: 'wake failed' });
      }
      // Only after the wake committed, and once per delivery: the receiving adapter's shared reads end here.
      if (delivered) github?.noteWebhook?.(event, payload);
      // Every delivery that wakes nothing says why (GY-1731), so an operator tells a deliberately ignored delivery from a lost one.
      const ignored = delivered ? delivered.ignored : 'duplicate delivery';
      if (!ignored) return context.send(202, { accepted: true });
      console.error(`webhook delivery ${delivery} (${event || 'unknown'}) accepted without wake: ${ignored}`);
      return context.send(202, { accepted: true, ignored });
    },
  },
]);

/** Whether a delivery's subjects name anything a job could be woken for. */
function named(subjects: ReturnType<typeof webhookSubjects>): boolean {
  return subjects.all || subjects.prs.length > 0 || subjects.shas.length > 0 || subjects.branches.length > 0;
}

/**
 * What a push to the base branch wakes (GY-1231): with the pushed files known, not every job but the
 * pull requests of the open items `baseMoveWakes` selects, alongside whatever else the push named;
 * with them unknown, every job as before.
 */
export function baseMoveSubjects(subjects: ReturnType<typeof webhookSubjects>, open: readonly BaseMoveItem[], baseFiles: string[] | null): ReturnType<typeof webhookSubjects> {
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
