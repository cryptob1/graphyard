import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, implementerIdentities, type Principal, type Work } from '../model.js';
import type { ControlPlaneReviewLaunch, ControlPlaneVerdict } from '../model/post-merge-review.js';
import { reviewEvents, verdictStateOf } from '../review-post.js';
import { blockingFindings } from '../review-cap.js';
import { save } from '../store.js';
import { lockedWork } from '../store/locked-read.js';
import type { Services } from './routes.js';

/**
 * GY-1525. Review verdicts through the API, for control-plane mode, where no pull request exists
 * for a GitHub review to land on.
 *
 * `POST /api/work/:id/review-launch` — the loop's coordinator identity registers the reviewer
 * session it is about to start: the reviewer principal, the head and base tip the session judges,
 * and the sha256 of the one-time verdict token the launcher wrote into the session's binding
 * (review-post.ts). The hash is kept on the item as `work.reviewLaunch`; the token itself is seen
 * only by the session. The token is also what authenticates the session's one call: the launch
 * registers it as a bearer credential for the reviewer principal, with the `reader` role, until the
 * verdict lands, the launch is refused, or it expires — so `review post` needs no Graphyard
 * credential of its own, exactly as the GitHub-mode session needs none.
 *
 * `POST /api/work/:id/review-verdict` — the session's verdict. The route verifies the token's hash,
 * binds the verdict's sha to the registered head, refuses a reviewer who implemented the item or
 * who requested the launch (recorded as `review.independence-refused`, in its own committed
 * transaction, as evidence refusals are), appends the verdict to `observation.reviews` with
 * `source: 'control-plane'` so `exactApproval` and the review gate read it unchanged, re-evaluates
 * the item, and refuses a second verdict for the same launch. A post-merge launch's verdict marks the
 * delivered item `reviewed`; the item is never reopened, and the loop files its findings (auto-dispatch.ts).
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const instant = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');
export const reviewLaunchBodySchema = z.object({ reviewer: identifier, head: sha, baseTip: sha, tokenHash: hex64, expiresAt: instant, postMerge: z.boolean().default(false) }).strict();
export const reviewVerdictBodySchema = z.object({ event: z.enum(reviewEvents), body: z.string().trim().min(1).max(65_536), sha, token: hex64 }).strict();
/** The events each route appends with its own payload; the document save beside each is `<event>.recorded`. */
export const reviewLaunchEvent = 'review.launch', reviewVerdictEvent = 'review.verdict', independenceRefusedEvent = 'review.independence-refused';
/** How long a registered launch's token stays valid at most, whatever expiry the launcher asks. */
export const launchTokenBoundMs = 4 * 3_600_000;

export const tokenHashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
/** The refusal when the verdict's token is not the registered launch's. */
export const tokenRefusal = 'The verdict token is not the one this launch registered; post only from the session Graphyard launched';
/** The refusal when the verdict names a commit other than the registered head. */
export const headRefusal = (sha: string, head: string) => `The verdict names ${sha.slice(0, 12)}, not the registered head ${head.slice(0, 12)} this session was launched to review; post nothing for a different commit`;
/** The refusal when a launch already holds its verdict. */
export const secondVerdictRefusal = (key: string, head: string) => `${key}'s launch for ${head.slice(0, 12)} already holds its verdict; one launch yields one verdict`;
/** The refusal recorded when the reviewer is not independent of the item. */
export const independenceRefusal = (reviewer: string, how: 'implemented' | 'requested', key: string) =>
  how === 'implemented' ? `Reviewer ${reviewer} implemented ${key}; an identity cannot independently review its own work` : `Reviewer ${reviewer} requested this review launch of ${key}; the requester of a review is never its reviewer`;

/** The bearer registrations this process holds for launched reviewer sessions, by token hash, so a verdict or an expiry can withdraw exactly one. */
const registrations = new WeakMap<Services, Map<string, { expiresAt: number }>>();
const registry = (services: Services) => { let map = registrations.get(services); if (!map) { map = new Map(); registrations.set(services, map); } return map; };
function withdrawToken(services: Services, tokenHash: string) {
  registry(services).delete(tokenHash);
  const hash = Buffer.from(tokenHash, 'hex');
  for (let index = services.principals.length - 1; index >= 0; index--) if (services.principals[index]!.hash.equals(hash)) services.principals.splice(index, 1);
}
function registerToken(services: Services, reviewer: string, tokenHash: string, expiresAt: number) {
  withdrawToken(services, tokenHash);
  registry(services).set(tokenHash, { expiresAt });
  services.principals.push({ actor: { id: reviewer, role: 'reader' }, hash: Buffer.from(tokenHash, 'hex') });
}
/** Withdraw every registration past its expiry; called on each launch and verdict, so a token outlives its session by at most the next call. */
function pruneExpired(services: Services, now: number) {
  for (const [tokenHash, entry] of registry(services)) if (entry.expiresAt <= now) withdrawToken(services, tokenHash);
}
/** Whether this process still registers `tokenHash` as a bearer (tests read it; nothing else does). */
export const tokenRegistered = (services: Services, tokenHash: string) => registry(services).has(tokenHash);

async function replayOrRun<T>(db: pg.PoolClient, actor: Principal, key: string, fingerprint: string, run: () => Promise<T>): Promise<T> {
  const replay = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
  if (replay) { demand(replay.fingerprint === fingerprint, 'Idempotency key reused with different input'); return replay.result; }
  const result = await run();
  await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
  return result;
}

export async function recordReviewLaunch(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity registers a reviewer launch', 403);
  const data = reviewLaunchBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  return services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async () => {
    pruneExpired(services, now.getTime());
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    if (data.postMerge) {
      demand(work!.stage === 'done' && work!.delivery?.mergeSha.toLowerCase() === data.head, `${work!.key} was not delivered as ${data.head.slice(0, 12)}; a post-merge review is launched on the delivered merge commit`, 409);
      demand(work!.postMergeReview === 'owed', `${work!.key} owes no post-merge review${work!.postMergeReview === 'reviewed' ? ': its verdict is recorded' : ''}`, 409);
    } else {
      demand(work!.observation?.source === 'control-plane', `${work!.key} was observed by GitHub, not the control plane; its review posts through gh`, 409);
      demand(work!.candidate?.sha.toLowerCase() === data.head, `${work!.key}'s candidate is ${work!.candidate ? work!.candidate.sha.slice(0, 12) : 'none'}, not ${data.head.slice(0, 12)}; a review is launched on the submitted head`, 409);
      demand(work!.observation!.candidate.baseSha.toLowerCase() === data.baseTip, `${work!.key}'s candidate is observed on base ${work!.observation!.candidate.baseSha.slice(0, 12)}, not ${data.baseTip.slice(0, 12)}`, 409);
    }
    // One launch stands per item: a relaunch replaces the earlier registration and withdraws its token.
    if (work!.reviewLaunch) withdrawToken(services, work!.reviewLaunch.tokenHash);
    const expiresAt = new Date(Math.min(Date.parse(data.expiresAt), now.getTime() + launchTokenBoundMs)).toISOString();
    const launch: ControlPlaneReviewLaunch = { id: randomUUID(), reviewer: data.reviewer, requester: actor.id, head: data.head, baseTip: data.baseTip, tokenHash: data.tokenHash, at: now.toISOString(), expiresAt, postMerge: data.postMerge, verdict: null };
    work!.reviewLaunch = launch;
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, reviewLaunchEvent, JSON.stringify({ key: work!.key, ...launch })]);
    await save(db, work!, actor.id, `${reviewLaunchEvent}.recorded`, now, { launch: launch.id, reviewer: launch.reviewer, head: launch.head, postMerge: launch.postMerge });
    registerToken(services, data.reviewer, data.tokenHash, Date.parse(expiresAt));
    return { registered: true, key: work!.key, launch: launch.id, reviewer: launch.reviewer, head: launch.head, baseTip: launch.baseTip, expiresAt, postMerge: launch.postMerge };
  }));
}

type Judged = { refusal: { reason: string; status: number } } | { result: unknown };

export async function recordReviewVerdict(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = reviewVerdictBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  const engine = services.engine;
  const judged: Judged = await engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async (): Promise<Judged> => {
    pruneExpired(services, now.getTime());
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    const launch = work!.reviewLaunch;
    demand(launch, `${work!.key} has no registered reviewer launch; a control-plane verdict is posted only by the session Graphyard launched`, 409);
    const offered = Buffer.from(tokenHashOf(data.token), 'hex'), registered = Buffer.from(launch!.tokenHash, 'hex');
    demand(offered.length === registered.length && timingSafeEqual(offered, registered), tokenRefusal, 403);
    demand(!launch!.verdict, secondVerdictRefusal(work!.key, launch!.head), 409);
    demand(actor.id === launch!.reviewer, `This verdict is posted as ${actor.id}, not as the registered reviewer ${launch!.reviewer}`, 403);
    demand(!launch!.refused, `${work!.key}'s launch was refused: ${launch!.refused?.reason}`, 403);
    demand(Date.parse(launch!.expiresAt) > now.getTime(), `${work!.key}'s review launch expired at ${launch!.expiresAt}; the loop launches the review again`, 403);
    demand(data.sha === launch!.head, headRefusal(data.sha, launch!.head), 409);
    // Independence is identity: the reviewer is none of the item's implementers and not the launch's requester.
    const how = implementerIdentities(work!).includes(launch!.reviewer) ? 'implemented' : launch!.reviewer === launch!.requester ? 'requested' : null;
    if (how) {
      const reason = independenceRefusal(launch!.reviewer, how, work!.key);
      work!.reviewLaunch = { ...launch!, refused: { at: now.toISOString(), reason } };
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, independenceRefusedEvent, JSON.stringify({ key: work!.key, launch: launch!.id, reviewer: launch!.reviewer, requester: launch!.requester, head: launch!.head, how, reason })]);
      await save(db, work!, actor.id, `${independenceRefusedEvent}.recorded`, now, { launch: launch!.id, reviewer: launch!.reviewer, how, reason });
      withdrawToken(services, launch!.tokenHash);
      return { refusal: { reason, status: 403 } };
    }
    const state = verdictStateOf(data.event), submittedAt = now.toISOString();
    const inserted = await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4) RETURNING seq', [work!.id, actor.id, reviewVerdictEvent, JSON.stringify({ key: work!.key, launch: launch!.id, reviewer: launch!.reviewer, sha: data.sha, state, event: data.event, body: data.body, submittedAt, postMerge: launch!.postMerge, source: 'control-plane' })]);
    const reviewId = Number(inserted.rows[0]?.seq);
    const verdict: ControlPlaneVerdict = { reviewer: launch!.reviewer, sha: data.sha, state, body: data.body, submittedAt, source: 'control-plane', reviewId };
    // The verdict stands where GitHub's review would: `exactApproval` finds an APPROVED of the exact
    // candidate head by someone other than its author, and the review gate reads a change request.
    const observation = work!.observation;
    if (observation) {
      const blocking = state === 'CHANGES_REQUESTED' ? blockingFindings(data.body) : [];
      observation.reviews = [...(observation.reviews ?? []), { reviewer: launch!.reviewer, sha: data.sha, state, id: reviewId, submittedAt, ...(state === 'CHANGES_REQUESTED' ? { body: data.body, blocking } : {}), source: 'control-plane' } as (typeof observation.reviews)[number]];
    }
    work!.reviewLaunch = { ...launch!, verdict };
    if (launch!.postMerge) work!.postMergeReview = 'reviewed';
    withdrawToken(services, launch!.tokenHash);
    if (work!.stage !== 'done') {
      engine.evaluate(work!, all, now);
      await (engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    }
    await save(db, work!, actor.id, `${reviewVerdictEvent}.recorded`, now, { launch: launch!.id, reviewer: launch!.reviewer, sha: data.sha, state, reviewId, postMerge: launch!.postMerge });
    return { result: { recorded: true, key: work!.key, launch: launch!.id, reviewId, state, sha: data.sha, reviewer: launch!.reviewer, stage: work!.stage, postMerge: launch!.postMerge } };
  }));
  if ('refusal' in judged) demand(false, judged.refusal.reason, judged.refusal.status);
  return (judged as { result: unknown }).result;
}
