// `graphyard review post` (GY-1492): the reviewer session's one way to post its verdict. The
// procedure the reviewer prompt used to carry as prose — a head guard, waiting out GitHub's lazy
// mergeability recompute, the closing thread lines — is checked here against the launch's own
// binding before exactly one review is posted with the session's own GH_CONFIG_DIR credential.
// The command needs no Graphyard credential and the reviewer token is not widened.
// In control-plane mode (GY-1525) there is no pull request: the launch binds a one-time verdict
// token, and the same command sends the verdict to `POST /api/work/:id/review-verdict` as that
// token, never running `gh`; the server records it on the item's observation (server/review-verdict.ts).
import { randomUUID } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ChildRun } from './child-runner.js';
import { canonicalThreadIds, listedThreadLimit, parseFollowUpThreads, parseOverriddenThreads, parseResolvedThreads, threadAliasLimit, unaccountedThreads } from './review-threads.js';

/** The file, in the session's GH_CONFIG_DIR, that binds a reviewer session to its launch. */
export const reviewBindingFile = 'review-binding.json';
export const reviewEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
export type ReviewEvent = typeof reviewEvents[number];
/** How often, and for how long, review post waits for GitHub to recompute an UNKNOWN mergeable. */
export const mergeablePollMs = 5_000, mergeablePollBoundMs = 120_000;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** The verdict token a control-plane launch binds: 32 random bytes, hex; only its sha256 is kept anywhere but the binding. */
export const verdictTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const reviewBindingModes = ['github', 'control-plane'] as const;
export const reviewBindingSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  key: z.string().min(1).max(100), pr: z.number().int().positive(), sha, baseSha: sha, policyRevision: z.number().int().nonnegative(),
  criteriaOnly: z.boolean(),
  threadsListed: z.array(z.string().min(1).max(200)).max(listedThreadLimit).optional(),
  threadAliases: z.record(z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(threadAliasLimit * 2)).optional(),
  threadReadFailure: z.string().min(1).max(500).optional(),
  /** Absent on a github-mode binding (unchanged since GY-1492); `control-plane` posts to the API with the token (GY-1525). */
  mode: z.enum(reviewBindingModes).optional(),
  /** Control-plane mode: the head and base tip the session judges (the item's candidate, or a delivered merge commit and its first parent) and the one-time verdict token. */
  head: sha.optional(), baseTip: sha.optional(), verdictToken: verdictTokenSchema.optional(),
}).strict().refine(binding => !(binding.threadReadFailure && binding.threadsListed), 'A binding records either the listed threads or the failed read, never both')
  .refine(binding => binding.mode !== 'control-plane' || (!!binding.head && !!binding.baseTip && !!binding.verdictToken), 'A control-plane binding carries head, baseTip and verdictToken')
  .refine(binding => binding.mode === 'control-plane' || (binding.head === undefined && binding.baseTip === undefined && binding.verdictToken === undefined), 'Only a control-plane binding carries head, baseTip or verdictToken');
export type ReviewPostBinding = z.infer<typeof reviewBindingSchema>;

/** Written once, private, before the session's runtime starts; a launch that cannot write it starts nothing. */
export async function writeReviewBinding(directory: string, binding: ReviewPostBinding) {
  const file = join(directory, reviewBindingFile);
  await writeFile(file, `${JSON.stringify(reviewBindingSchema.parse(binding))}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
  return file;
}

export async function readReviewBinding(directory: string): Promise<ReviewPostBinding> {
  let text: string;
  try { text = await readFile(join(directory, reviewBindingFile), 'utf8'); }
  catch { throw new ReviewPostRefusal(`GH_CONFIG_DIR (${directory}) holds no ${reviewBindingFile}: review post runs only in a reviewer session Graphyard launched`); }
  try { return reviewBindingSchema.parse(JSON.parse(text)); }
  catch { throw new ReviewPostRefusal(`${reviewBindingFile} in GH_CONFIG_DIR is not a valid review binding`); }
}

export class ReviewPostRefusal extends Error {}

const lineLabels = ['Resolved threads', 'Follow-up threads', 'Overridden threads'] as const;
const hasLine = (body: string, label: string) => body.split(/\r?\n/).some(entry => entry.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`));

/**
 * Why the body's closing thread lines refuse this verdict, or none. Any event is refused for naming
 * an ID that is no listed thread (a comment ID of a listed thread maps to it); an approval of a
 * launch that listed threads must also carry all three lines and account for every listed thread;
 * a launch whose thread read failed accepts no ID on the Resolved threads line.
 */
export function threadLineRefusals(event: ReviewEvent, body: string, binding: Pick<ReviewPostBinding, 'threadsListed' | 'threadAliases' | 'threadReadFailure'>): string[] {
  const refusals: string[] = [];
  const resolved = parseResolvedThreads(body), followUp = parseFollowUpThreads(body), overridden = parseOverriddenThreads(body);
  if (binding.threadReadFailure) {
    if (resolved.length) refusals.push(`this launch could not read the review threads (${binding.threadReadFailure}), so no thread can be claimed resolved; remove ${resolved.join(' ')} from the Resolved threads line`);
    return refusals;
  }
  const listed = binding.threadsListed ?? [];
  const shown = new Set(listed);
  const unlisted = [...new Set([...resolved, ...followUp, ...overridden])].filter(id => !shown.has(canonicalThreadIds([id], listed, binding.threadAliases)[0]!));
  if (unlisted.length) refusals.push(`the thread lines name ${unlisted.join(' ')}, which ${unlisted.length === 1 ? 'is' : 'are'} not a thread this launch listed${listed.length ? ` (listed: ${listed.join(' ')})` : ' (it listed none)'}`);
  if (event === 'APPROVE' && listed.length) {
    const missing = lineLabels.filter(label => !hasLine(body, label));
    if (missing.length) refusals.push(`an approval of a head with listed threads ends with all three thread lines; the body lacks ${missing.map(label => `"${label}:"`).join(', ')}`);
    const unaccounted = unaccountedThreads(body, listed, true, binding.threadAliases);
    if (unaccounted.length) refusals.push(`the approval leaves ${unaccounted.join(' ')} on none of the three thread lines; name each listed thread on exactly one`);
  }
  return refusals;
}

/** A correct invocation for this session, printed after every refusal. */
export function reviewPostExample(cliPath: string, event: ReviewEvent, binding?: Pick<ReviewPostBinding, 'threadsListed'> | null) {
  const listed = binding?.threadsListed ?? [];
  return [`node ${cliPath} review post --event ${event} <<'EOF'`,
    'YOUR JUDGEMENT OF EACH ACCEPTANCE CRITERION, AND EACH FINDING WITH ITS CLASSIFICATION',
    ...(listed.length ? [`Name each listed thread (${listed.join(' ')}) on exactly the one line your judgement puts it on.`] : []),
    'Resolved threads: none', `Follow-up threads: ${listed.length ? listed.join(' ') : 'none'}`, 'Overridden threads: none', 'EOF'].join('\n');
}

export interface ReviewPostDependencies {
  run: ChildRun;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How a control-plane verdict reaches the API; global fetch by default. Never called in github mode. */
  fetch?: typeof fetch;
}

/** The GitHub review state a verdict event records as (the form `exactApproval` and the review gate read). */
export const verdictStateOf = (event: ReviewEvent) => event === 'APPROVE' ? 'APPROVED' : event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED';

/**
 * Check, then post exactly one review. `environment` is the session's own: GH_CONFIG_DIR names the
 * binding and the credential, GRAPHYARD_REVIEW the KEY@SHA the launch was for. Every refusal is a
 * `ReviewPostRefusal` whose message ends with a correct invocation for this session.
 */
export async function postReview(input: { event: string | undefined; body: string; cliPath: string; environment: NodeJS.ProcessEnv }, dependencies: ReviewPostDependencies) {
  const event = reviewEvents.find(entry => entry === input.event?.toUpperCase());
  let binding: ReviewPostBinding | null = null;
  const refuse = (reason: string): never => { throw new ReviewPostRefusal(`Review not posted: ${reason}.\nPost it like this:\n${reviewPostExample(input.cliPath, event ?? 'APPROVE', binding)}`); };
  const directory = input.environment.GH_CONFIG_DIR;
  if (!directory) refuse('GH_CONFIG_DIR is unset; review post runs only in a reviewer session Graphyard launched');
  try { binding = await readReviewBinding(directory!); } catch (error) { refuse((error as Error).message); }
  if (!event) refuse(`--event must be one of ${reviewEvents.join(', ')}`);
  const bound = binding!;
  if (input.environment.GRAPHYARD_REVIEW !== `${bound.key}@${bound.sha}`) refuse(`GRAPHYARD_REVIEW is ${input.environment.GRAPHYARD_REVIEW ? `"${input.environment.GRAPHYARD_REVIEW}"` : 'unset'}, not this launch's ${bound.key}@${bound.sha}`);
  const body = input.body.trim();
  if (!body) refuse('the review body is empty');
  const lines = threadLineRefusals(event!, body, bound);
  if (lines.length) refuse(lines.join('; '));
  // Control-plane mode (GY-1525): the verdict goes to the API as the launch's one-time token, bound
  // to the registered head; nothing here runs gh, and the server judges the rest.
  if (bound.mode === 'control-plane') {
    const base = input.environment.GRAPHYARD_URL;
    if (!base) refuse('GRAPHYARD_URL is unset; a control-plane reviewer session is launched with the control plane\'s address');
    const post = dependencies.fetch ?? fetch;
    let response: Response;
    try {
      response = await post(`${base!.replace(/\/$/, '')}/api/work/${encodeURIComponent(bound.key)}/review-verdict`, { method: 'POST', headers: { Authorization: `Bearer ${bound.verdictToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ event, body, sha: bound.head, token: bound.verdictToken }), signal: AbortSignal.timeout(120_000) });
    } catch (error) { return refuse(`the control plane at ${base} could not be reached (${(error instanceof Error ? error.message : String(error)).split('\n')[0]}); retry the same command`); }
    const answer = await response.json().catch(() => ({})) as { error?: string; reviewId?: number };
    if (response.status === 401) refuse(`this launch's verdict token is spent or expired (${answer?.error ?? 'not accepted'}): a verdict was already posted for it, or the launch expired and the loop launches the review again; post nothing further and stop`);
    if (!response.ok) refuse(`the control plane refused the verdict (${response.status}): ${answer?.error ?? 'no reason given'}`);
    return { reviewId: answer.reviewId ?? null, event: event!, key: bound.key, pr: bound.pr, sha: bound.head!, recorded: 'control-plane' as const };
  }
  const sleep = dependencies.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const now = dependencies.now ?? Date.now;
  const env = { ...input.environment };
  const started = now();
  for (;;) {
    let state: { mergeable?: unknown; mergeStateStatus?: unknown; headRefOid?: unknown };
    try { state = JSON.parse(String(await dependencies.run('gh', ['pr', 'view', String(bound.pr), '--repo', bound.repository, '--json', 'mergeable,mergeStateStatus,headRefOid'], { env }))); }
    catch (error) { refuse(`gh pr view ${bound.pr} could not be read (${(error instanceof Error ? error.message : String(error)).split('\n')[0]}); retry the same command`); }
    if (state!.headRefOid !== bound.sha) refuse(`pull request #${bound.pr} head is ${String(state!.headRefOid)}, not ${bound.sha} this session was launched to review; post nothing for a different commit, and stop`);
    if (state!.mergeable !== 'UNKNOWN') break;
    if (now() - started + mergeablePollMs > mergeablePollBoundMs) refuse(`GitHub still reports mergeable UNKNOWN for pull request #${bound.pr} after ${mergeablePollBoundMs / 1000} seconds, and a verdict posted before it recomputes is dismissed; wait a minute and run the same command again`);
    await sleep(mergeablePollMs);
  }
  const output = await dependencies.run('gh', ['api', '--method', 'POST', `repos/${bound.repository}/pulls/${bound.pr}/reviews`, '-f', `commit_id=${bound.sha}`, '-f', `event=${event}`, '-f', `body=${body}`], { env });
  const review = JSON.parse(String(output));
  if (typeof review?.id !== 'number') throw new Error(`GitHub answered the review post without a review id: ${String(output).slice(0, 200)}`);
  return { reviewId: review.id as number, event: event!, key: bound.key, pr: bound.pr, sha: bound.sha };
}
