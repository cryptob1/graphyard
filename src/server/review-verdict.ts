import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, implementerIdentities, type Principal, type Work } from '../model.js';
import type { ControlPlaneReviewLaunch, ControlPlaneVerdict } from '../model/post-merge-review.js';
import { reviewEvents, verdictStateOf } from '../review-post.js';
import { blockingFindings } from '../review-cap.js';
import { productVerdicts, type ProductReview } from '../model/product-review.js';
import { needsSpecCheck, specVerdicts, type SpecCheck, type SpecCheckLaunch } from '../model/spec-check.js';
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
 * transaction, as evidence refusals are), appends `{ reviewer, sha, state, body, submittedAt,
 * source: 'control-plane' }` to `observation.reviews` so `exactApproval` and the review gate read it
 * unchanged, re-evaluates the item, and refuses a second verdict for the same launch. A post-merge
 * launch's verdict marks the delivered item `reviewed`; the item is never reopened, and the loop
 * files its findings (auto-dispatch.ts). The in-process bearer registry changes only once the
 * transaction has committed: a save that fails leaves the token usable for the session's retry.
 */
const sha = z.string().regex(/^[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
// A reviewer identity: a principal name, or a GitHub App bot login — the launcher registers the
// configured reviewer App as `${slug}[bot]` (reviewer.ts), so the bracketed suffix is part of the
// launcher/API contract (GY-2008). Nothing else about the shape loosens: a malformed identity is
// still a 400, never a weakened check.
const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*(?:\[bot\])?$/);
const instant = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');
export const reviewLaunchBodySchema = z.object({ reviewer: identifier, head: sha, baseTip: sha, tokenHash: hex64, expiresAt: instant, postMerge: z.boolean().default(false), product: z.boolean().default(false) }).strict();
/**
 * A screenshot a product reviewer captured (GY-2989), uploaded with the verdict: the name its body's
 * `Screenshot:` line gives it and the image itself, kept by the control plane and served on the item
 * (`GET /api/work/:id/product-review/screenshots/:name`), so the panel shows what the reviewer saw.
 */
export const productScreenshotBytesMax = 2 * 1024 * 1024, productScreenshotsMax = 5;
const screenshotUpload = z.object({ name: z.string().trim().min(1).max(1000), mediaType: z.enum(['image/png', 'image/jpeg']), bytes: z.string().min(4).max(Math.ceil(productScreenshotBytesMax / 3) * 4) }).strict();
type ScreenshotUpload = z.infer<typeof screenshotUpload>;
/** The body limit of a route that may carry screenshots: every one at its largest, base64, with room for the rest. */
export const productScreenshotBodyLimit = productScreenshotsMax * Math.ceil(productScreenshotBytesMax / 3) * 4 + 200_000;
export const reviewVerdictBodySchema = z.object({ event: z.enum(reviewEvents), body: z.string().trim().min(1).max(65_536), sha, token: hex64, screenshots: z.array(screenshotUpload).max(productScreenshotsMax).optional() }).strict();
/** The hand-recorded product review (GY-2989): the operator or the loop's coordinator records one itself, without a launched session. */
export const productReviewBodySchema = z.object({
  reviewer: identifier, sha, baseSha: sha,
  verdict: z.enum(productVerdicts),
  findings: z.string().trim().min(1).max(65_536),
  /** Each an http(s) link to an image hosted elsewhere, or an image uploaded with the verdict. */
  screenshots: z.array(z.union([z.url({ protocol: /^https?$/ }).max(2000), screenshotUpload])).max(productScreenshotsMax).default([]),
}).strict();
/** GY-2078: the loop's withdrawal of one control-plane review verdict — which review, and the request the re-review is asked by. */
export const reviewWithdrawBodySchema = z.object({ reviewId: z.number().int().safe().positive(), reason: z.string().trim().min(1).max(8000) }).strict();
/** The events each route appends with its own payload; the document save beside each is `<event>.recorded`. */
export const reviewLaunchEvent = 'review.launch', reviewVerdictEvent = 'review.verdict', independenceRefusedEvent = 'review.independence-refused';
/** The event a product review's verdict is appended with (GY-2989). */
export const productReviewVerdictEvent = 'product-review.verdict';
/** The screenshots a product verdict names, one `Screenshot:` line each (product-review.ts shows them on the item). */
export const productScreenshots = (body: string) => body.split('\n').map(line => line.trim()).filter(line => /^Screenshot:/i.test(line)).map(line => line.replace(/^Screenshot:\s*/i, '').trim()).filter(Boolean);
const linked = (name: string) => /^https?:\/\//i.test(name);
/**
 * Keep a product verdict's uploaded screenshots in place of the item's earlier ones, and answer the
 * names the review records: each upload, and each `Screenshot:` line or listed link that is an
 * http(s) URL. A line naming a local file not uploaded is dropped — nobody could open it.
 */
async function keepProductScreenshots(db: pg.PoolClient, workId: string, uploads: ScreenshotUpload[], named: string[]): Promise<string[]> {
  await db.query('DELETE FROM product_review_screenshots WHERE work_id=$1', [workId]);
  for (const upload of uploads) {
    const bytes = Buffer.from(upload.bytes, 'base64');
    demand(bytes.length > 0 && bytes.length <= productScreenshotBytesMax && bytes.toString('base64') === upload.bytes, `Screenshot ${upload.name} must be canonical base64 of at most ${productScreenshotBytesMax} bytes`, 400);
    await db.query('INSERT INTO product_review_screenshots(work_id,name,media_type,bytes) VALUES($1,$2,$3,$4) ON CONFLICT (work_id,name) DO UPDATE SET media_type=EXCLUDED.media_type, bytes=EXCLUDED.bytes', [workId, upload.name, upload.mediaType, bytes]);
  }
  return [...new Set([...uploads.map(upload => upload.name), ...named.filter(linked)])];
}
/** One stored screenshot of an item's product review, for its panel; 404 when none is kept by that name. */
export async function readProductScreenshot(services: Services, id: string, name: string): Promise<{ mediaType: string; bytes: Buffer }> {
  const row = (await services.engine.store.pool.query('SELECT s.media_type, s.bytes FROM product_review_screenshots s JOIN work_items w ON w.id=s.work_id WHERE (w.id::text=$1 OR w.document->>\'key\'=$1) AND s.name=$2', [id, name])).rows[0];
  demand(row, 'No such product review screenshot', 404);
  return { mediaType: row.media_type, bytes: row.bytes };
}
/** The event a control-plane review's withdrawal is appended with (GY-2078). */
export const reviewWithdrawnEvent = 'review.withdrawn';
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

/** The registry changes a committed transaction applies: the hashes it withdraws and the launch it registers. */
interface RegistryChange { withdraw: string[]; register?: { reviewer: string; tokenHash: string; expiresAt: number } }
function applyRegistryChange(services: Services, change: RegistryChange | undefined, now: number) {
  pruneExpired(services, now);
  if (!change) return;
  for (const tokenHash of change.withdraw) withdrawToken(services, tokenHash);
  if (change.register) registerToken(services, change.register.reviewer, change.register.tokenHash, change.register.expiresAt);
}

export async function recordReviewLaunch(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', 'Only the loop\'s coordinator identity registers a reviewer launch', 403);
  const data = reviewLaunchBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  let change: RegistryChange | undefined;
  const result = await services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async () => {
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    if (data.postMerge) {
      demand(!data.product, 'A product review is of a candidate head, never of a delivered merge commit', 409);
      demand(work!.stage === 'done' && work!.delivery?.mergeSha.toLowerCase() === data.head, `${work!.key} was not delivered as ${data.head.slice(0, 12)}; a post-merge review is launched on the delivered merge commit`, 409);
      demand(work!.postMergeReview === 'owed', `${work!.key} owes no post-merge review${work!.postMergeReview === 'reviewed' ? ': its verdict is recorded' : ''}`, 409);
    } else {
      demand(work!.observation?.source === 'control-plane', `${work!.key} was observed by GitHub, not the control plane; its review posts through gh`, 409);
      demand(work!.candidate?.sha.toLowerCase() === data.head, `${work!.key}'s candidate is ${work!.candidate ? work!.candidate.sha.slice(0, 12) : 'none'}, not ${data.head.slice(0, 12)}; a review is launched on the submitted head`, 409);
      // The launch binds the base the session judges (GY-2948): the candidate's merge base with the
      // base branch, as the observation records it — a file the base gained after it is never part
      // of the reviewed delta, so the tip itself is not what a review is registered against.
      const diffBase = work!.observation!.mergeBase ?? work!.observation!.candidate.baseSha;
      demand(diffBase.toLowerCase() === data.baseTip, `${work!.key}'s candidate is judged against base ${diffBase.slice(0, 12)}, not ${data.baseTip.slice(0, 12)}`, 409);
    }
    // One launch stands per item: a relaunch replaces the earlier registration and withdraws its token.
    const withdraw = work!.reviewLaunch ? [work!.reviewLaunch.tokenHash] : [];
    const expiresAt = new Date(Math.min(Date.parse(data.expiresAt), now.getTime() + launchTokenBoundMs)).toISOString();
    const launch: ControlPlaneReviewLaunch = { id: randomUUID(), reviewer: data.reviewer, requester: actor.id, head: data.head, baseTip: data.baseTip, tokenHash: data.tokenHash, at: now.toISOString(), expiresAt, postMerge: data.postMerge, ...(data.product ? { product: true } : {}), verdict: null };
    work!.reviewLaunch = launch;
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, reviewLaunchEvent, JSON.stringify({ key: work!.key, ...launch })]);
    await save(db, work!, actor.id, `${reviewLaunchEvent}.recorded`, now, { launch: launch.id, reviewer: launch.reviewer, head: launch.head, postMerge: launch.postMerge });
    change = { withdraw, register: { reviewer: data.reviewer, tokenHash: data.tokenHash, expiresAt: Date.parse(expiresAt) } };
    return { registered: true, key: work!.key, launch: launch.id, reviewer: launch.reviewer, head: launch.head, baseTip: launch.baseTip, expiresAt, postMerge: launch.postMerge };
  }));
  applyRegistryChange(services, change, Date.now());
  return result;
}

type Judged = { refusal: { reason: string; status: number } } | { result: unknown };

export async function recordReviewVerdict(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = reviewVerdictBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  const engine = services.engine;
  let change: RegistryChange | undefined;
  const judged: Judged = await engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async (): Promise<Judged> => {
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
      change = { withdraw: [launch!.tokenHash] };
      return { refusal: { reason, status: 403 } };
    }
    const state = verdictStateOf(data.event), submittedAt = now.toISOString();
    // A product launch's verdict is the item's product review (GY-2989): approved, changes requested
    // or rejected, recorded on `work.productReview` — never as a code review on the observation.
    const product = !!launch!.product;
    demand(product || !data.screenshots?.length, 'Only a product review uploads screenshots', 409);
    if (product) demand(data.event !== 'COMMENT', 'A product review is approved, changes requested or rejected; it posts no COMMENT', 409);
    else demand(data.event !== 'REJECT', 'REJECT is a product review verdict; a code review posts APPROVE, REQUEST_CHANGES or COMMENT', 409);
    const productVerdict: ProductReview['verdict'] | null = product ? data.event === 'APPROVE' ? 'approved' : data.event === 'REQUEST_CHANGES' ? 'changes-requested' : 'rejected' : null;
    // Every verdict carries the base its session judged (GY-2948 AC-2): the launch's baseTip, the
    // head's merge base with the base branch, so the verdict itself — in the ledger event, the
    // observation.reviews entry and the launch's verdict record — says which commits were in scope,
    // even after a relaunch replaces the launch record.
    const baseSha = launch!.baseTip;
    const inserted = await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4) RETURNING seq', [work!.id, actor.id, product ? productReviewVerdictEvent : reviewVerdictEvent, JSON.stringify({ key: work!.key, launch: launch!.id, reviewer: launch!.reviewer, sha: data.sha, state, event: data.event, body: data.body, submittedAt, postMerge: launch!.postMerge, product, source: 'control-plane', baseSha })]);
    const reviewId = Number(inserted.rows[0]?.seq);
    const verdict: ControlPlaneVerdict = { reviewer: launch!.reviewer, sha: data.sha, state, body: data.body, submittedAt, source: 'control-plane', reviewId, baseSha };
    // The verdict stands where GitHub's review would: `exactApproval` finds an APPROVED of the exact
    // candidate head by someone other than its author, and the review gate reads a change request.
    // Every verdict carries its body; a change request also carries its BLOCKING findings, as a
    // GitHub change request's observation does (github.ts).
    const observation = work!.observation;
    if (!product && observation) {
      if (work!.formalReviewResetRequired && !work!.formalReviewBaseline && work!.candidate) {
        work!.formalReviewBaseline = {
          pr: work!.candidate.pr,
          policyRevision: work!.policyRevision,
          reviewIds: (observation.reviews ?? []).map(r => r.id).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
        };
      }
      observation.reviews = [...(observation.reviews ?? []), { reviewer: launch!.reviewer, sha: data.sha, state, id: reviewId, submittedAt, body: data.body, baseSha, ...(state === 'CHANGES_REQUESTED' ? { blocking: blockingFindings(data.body) } : {}), source: 'control-plane' } as (typeof observation.reviews)[number]];
      observation.reviewIds = [...(observation.reviewIds ?? []), reviewId];
    }
    work!.reviewLaunch = { ...launch!, verdict };
    if (product) work!.productReview = { sha: launch!.head, baseSha, verdict: productVerdict!, reviewer: launch!.reviewer, findings: data.body, screenshots: await keepProductScreenshots(db, work!.id, data.screenshots ?? [], productScreenshots(data.body)), at: submittedAt };
    if (launch!.postMerge) work!.postMergeReview = 'reviewed';
    change = { withdraw: [launch!.tokenHash] };
    if (work!.stage !== 'done') {
      engine.evaluate(work!, all, now);
      await (engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    }
    await save(db, work!, actor.id, `${product ? productReviewVerdictEvent : reviewVerdictEvent}.recorded`, now, { launch: launch!.id, reviewer: launch!.reviewer, sha: data.sha, state, reviewId, postMerge: launch!.postMerge, product });
    return { result: { recorded: true, key: work!.key, launch: launch!.id, reviewId, state: product ? productVerdict : state, sha: data.sha, reviewer: launch!.reviewer, stage: work!.stage, postMerge: launch!.postMerge, product } };
  }));
  // The token is spent only once the verdict or the refusal is committed (a failed save leaves the session its retry).
  applyRegistryChange(services, change, Date.now());
  if ('refusal' in judged) demand(false, judged.refusal.reason, judged.refusal.status);
  return (judged as { result: unknown }).result;
}

/**
 * GY-2078. The loop's withdrawal of a control-plane review verdict — a capped change request an
 * independent approver refused as non-blocking — recorded in the control plane's own review record,
 * where the verdict stands: the review is marked DISMISSED and its id joins `dismissedReviewIds`,
 * exactly as GitHub marks a dismissal, so `standingVerdict`, `exactApproval` and the review gate
 * read the withdrawal unchanged and the item is re-evaluated in the same transaction. No GitHub
 * request is made: a control-plane head has no pull request to dismiss a review on. The
 * coordinator identity alone withdraws; a retried key replays, and a review already withdrawn
 * answers withdrawn again, so a lost answer never turns its retry into a second refusal.
 */
export async function withdrawReviewVerdict(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', "Only the loop's coordinator identity withdraws a control-plane review", 403);
  const data = reviewWithdrawBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  return services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async () => {
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    const observation = work!.observation;
    demand(observation?.source === 'control-plane', `${work!.key} was observed by GitHub, not the control plane; its reviews are dismissed on GitHub, not here`, 409);
    const review = (observation!.reviews ?? []).find(entry => entry.id === data.reviewId);
    demand(review, `${work!.key} holds no review ${data.reviewId}`, 404);
    if (review!.state !== 'DISMISSED') {
      demand(review!.source === 'control-plane', `${work!.key}'s review ${data.reviewId} stands on GitHub; it is dismissed there, not withdrawn here`, 409);
      demand(review!.state === 'CHANGES_REQUESTED', `${work!.key}'s review ${data.reviewId} is ${review!.state}; only a change request is withdrawn`, 409);
      review!.state = 'DISMISSED';
      observation!.dismissedReviewIds = [...(observation!.dismissedReviewIds ?? []), data.reviewId];
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, reviewWithdrawnEvent, JSON.stringify({ key: work!.key, reviewId: data.reviewId, sha: review!.sha, reviewer: review!.reviewer, reason: data.reason })]);
      if (work!.stage !== 'done') {
        services.engine.evaluate(work!, all, now);
        await (services.engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
      }
      await save(db, work!, actor.id, `${reviewWithdrawnEvent}.recorded`, now, { reviewId: data.reviewId, sha: review!.sha, reviewer: review!.reviewer });
    }
    return { withdrawn: true, key: work!.key, reviewId: data.reviewId, sha: review!.sha, state: review!.state };
  }));
}

/**
 * GY-2989: the operator's or the loop's coordinator hand-recorded product review — the same record
 * a launched product reviewer's verdict writes, without a launch, for a review given outside a
 * session. The reviewer must be independent of the item, and a head the item already holds as its
 * candidate is the only head a review may name against it; a fresh item records the named head, the
 * one its preview was walked on. One product review stands per item: the newest verdict replaces the
 * standing one.
 */
export async function recordProductReviewByHand(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'admin' || actor.role === 'coordinator', 'Only an admin or the loop\'s coordinator records a product review by hand', 403);
  const data = productReviewBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  return services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async () => {
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    demand(!implementerIdentities(work!).includes(data.reviewer), independenceRefusal(data.reviewer, 'implemented', work!.key), 403);
    if (work!.candidate) demand(work!.candidate.sha.toLowerCase() === data.sha, `${work!.key}'s candidate is ${work!.candidate.sha.slice(0, 12)}, not ${data.sha.slice(0, 12)}; a product review names the head it judged`, 409);
    const submittedAt = now.toISOString();
    const uploads = data.screenshots.filter((entry): entry is ScreenshotUpload => typeof entry !== 'string');
    const named = [...data.screenshots.filter((entry): entry is string => typeof entry === 'string'), ...productScreenshots(data.findings)];
    const productReview: ProductReview = { sha: data.sha, baseSha: data.baseSha, verdict: data.verdict, reviewer: data.reviewer, findings: data.findings, screenshots: await keepProductScreenshots(db, work!.id, uploads, named), at: submittedAt };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, productReviewVerdictEvent, JSON.stringify({ key: work!.key, reviewer: data.reviewer, sha: data.sha, baseSha: data.baseSha, verdict: data.verdict, by: actor.id })]);
    work!.productReview = productReview;
    if (work!.stage !== 'done') {
      services.engine.evaluate(work!, all, now);
      await (services.engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    }
    await save(db, work!, actor.id, `${productReviewVerdictEvent}.recorded`, now, { reviewer: data.reviewer, sha: data.sha, verdict: data.verdict });
    return { recorded: true, key: work!.key, verdict: data.verdict, sha: data.sha, reviewer: data.reviewer, stage: work!.stage };
  }));
}

// GY-2992: the spec check a released feature owes before dispatch. The loop's coordinator registers
// the one launch standing for the item (`work.specCheckLaunch`), and the launched fresh-context
// reviewer posts its one report — the paraphrase, the gaps, the verdict — as that launch's token,
// exactly as a control-plane reviewer posts its verdict. The report lands on `work.specCheck`, bound
// to the policy revision it judged; whether it is the re-check that ran after master requirements
// answered an earlier gaps verdict is judged here from the standing check, never taken from the poster.
export const specCheckLaunchEvent = 'spec-check.launch', specCheckVerdictEvent = 'spec-check.verdict';

export const specCheckLaunchBodySchema = z.object({ reviewer: identifier, tokenHash: hex64, expiresAt: instant }).strict();

export const specCheckBodySchema = z.object({
  verdict: z.enum(specVerdicts),
  paraphrase: z.string().trim().min(1).max(8000),
  gaps: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
  /** A launched session posts as its one-time token; a hand recording (admin or coordinator) names the reviewer instead. */
  token: hex64.optional(), reviewer: identifier.optional(),
}).strict()
  .refine(data => data.verdict === 'gaps' ? data.gaps.length > 0 : data.gaps.length === 0, 'a gaps verdict names at least one gap; a ready verdict names none');

export async function recordSpecCheckLaunch(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  demand(actor.role === 'coordinator', "Only the loop's coordinator identity registers a spec-check launch", 403);
  const data = specCheckLaunchBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  let change: RegistryChange | undefined;
  const result = await services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async () => {
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    demand(work!.stage !== 'done', `${work!.key} is done; a spec check launches for released work`, 409);
    demand(needsSpecCheck(work!), `${work!.key} owes no spec check: bugs, chores and "No user-facing change" items skip it`, 409);
    const expiresAt = new Date(Math.min(Date.parse(data.expiresAt), now.getTime() + launchTokenBoundMs)).toISOString();
    // One launch stands per item: a relaunch replaces the earlier registration and withdraws its token.
    const withdraw = work!.specCheckLaunch ? [work!.specCheckLaunch.tokenHash] : [];
    const launch: SpecCheckLaunch = { id: randomUUID(), reviewer: data.reviewer, requester: actor.id, tokenHash: data.tokenHash, at: now.toISOString(), expiresAt };
    work!.specCheckLaunch = launch;
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, specCheckLaunchEvent, JSON.stringify({ key: work!.key, ...launch })]);
    await save(db, work!, actor.id, `${specCheckLaunchEvent}.recorded`, now, { launch: launch.id, reviewer: launch.reviewer });
    change = { withdraw, register: { reviewer: data.reviewer, tokenHash: data.tokenHash, expiresAt: Date.parse(expiresAt) } };
    return { registered: true, key: work!.key, launch: launch.id, reviewer: launch.reviewer, expiresAt };
  }));
  applyRegistryChange(services, change, Date.now());
  return result;
}

export async function recordSpecCheck(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const data = specCheckBodySchema.parse(body);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, data })).digest('hex');
  let change: RegistryChange | undefined;
  const result = await services.engine.store.transaction(async (db: pg.PoolClient, now: Date) => replayOrRun(db, actor, key, fingerprint, async () => {
    const all = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id); demand(work, 'Work item not found', 404);
    demand(work!.stage !== 'done', `${work!.key} is done; its spec check is history`, 409);
    let reviewer: string;
    if (data.token) {
      const launch = work!.specCheckLaunch;
      demand(launch, `${work!.key} has no registered spec-check launch; a report is posted only by the session Graphyard launched`, 409);
      const offered = Buffer.from(tokenHashOf(data.token), 'hex'), registered = Buffer.from(launch!.tokenHash, 'hex');
      demand(offered.length === registered.length && timingSafeEqual(offered, registered), tokenRefusal, 403);
      demand(actor.role === 'reader' && actor.id === launch!.reviewer, `This report is posted as ${actor.id}, not as the registered spec checker ${launch!.reviewer}`, 403);
      demand(Date.parse(launch!.expiresAt) > now.getTime(), `${work!.key}'s spec-check launch expired at ${launch!.expiresAt}; the loop launches the check again`, 403);
      reviewer = launch!.reviewer;
      change = { withdraw: [launch!.tokenHash] };
    } else {
      demand(actor.role === 'admin' || actor.role === 'coordinator', 'Only an admin or the loop\'s coordinator records a spec check by hand; a launched session posts as its token', 403);
      demand(data.reviewer, 'A hand-recorded spec check names its reviewer', 400);
      reviewer = data.reviewer!;
      if (work!.specCheckLaunch) change = { withdraw: [work!.specCheckLaunch.tokenHash] };
    }
    // The re-check is a fact of the record: a report that lands while a gaps verdict stands is the
    // one re-check master requirements' revision ran; its own gaps verdict dispatches.
    const recheck = !!work!.specCheck && work!.specCheck.verdict === 'gaps';
    const specCheck: SpecCheck = { policyRevision: work!.policyRevision, verdict: data.verdict, paraphrase: data.paraphrase, gaps: data.gaps, reviewer, at: now.toISOString(), ...(recheck ? { recheck: true } : {}) };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work!.id, actor.id, specCheckVerdictEvent, JSON.stringify({ key: work!.key, reviewer, verdict: data.verdict, gaps: data.gaps.length, recheck, policyRevision: specCheck.policyRevision })]);
    work!.specCheck = specCheck;
    work!.specCheckLaunch = null;
    services.engine.evaluate(work!, all, now);
    await (services.engine as unknown as { recordDispatch(db: pg.PoolClient, work: Work, now: Date): Promise<void> }).recordDispatch(db, work!, now);
    await save(db, work!, actor.id, `${specCheckVerdictEvent}.recorded`, now, { reviewer, verdict: data.verdict, recheck });
    return { recorded: true, key: work!.key, verdict: data.verdict, recheck, reviewer, policyRevision: specCheck.policyRevision, stage: work!.stage };
  }));
  applyRegistryChange(services, change, Date.now());
  return result;
}
