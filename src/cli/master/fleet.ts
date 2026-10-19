// Concern: `graphyard master` fleet subcommands — start, worker, producer, config, registry, reviewer, review, protection, withdraw, tip-cleanup, browser, harness.
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agentOwner, listHerdrAgents, masterHarness, masterSettingsFromArgs, producerCommand, registeredReview, saveMasterSettings, saveWorkerProfile, startMaster, workerProfileSchema } from '../../master.js';
import { readReviewLedger, reviewCommand as launchReview } from '../../reviewer.js';
import { readDispatchCursor } from '../../auto-dispatch.js';
import { protectionRun, type ProtectionRun } from '../../protection.js';
import { demand } from '../../model/refusal.js';
import { dequeuePullRequestEntry, pullRequestMergeState, withdrawEnqueuedPullRequests, type GraphqlTransport, type WithdrawClient, type WithdrawEntry } from '../../github.js';
import { cleanupTipRefs } from '../../tip-cleanup.js';
import { harnessDrift, writeHarnessPermissions } from '../../harness.js';
import { browserFlows, listConfirmAccessFixtures, runBrowserFlow, type BrowserFlow } from '../../master-browser.js';
import { reviewerCommand } from '../master-reviewer.js';
import { registryCommand } from '../master-registry.js';
import { assertHandReview } from '../hand-actions.js';
import { unhandled, type MasterSession } from './session.js';
import { readSecretFromStdin } from '../context.js';
import type { AttentionItem, MasterConfig } from '../../master.js';

/** The write errors of a vantage that may read the checkout but not write it: a read-only bind (GY-888's confinement) or a directory it does not own. */
const readOnlyCodes = ['EROFS', 'EACCES', 'EPERM'];
const readOnlyCode = (error: unknown) => { const code = (error as NodeJS.ErrnoException | null)?.code; return code && readOnlyCodes.includes(code) ? code : null; };

/** Whether this process may write the harness settings' directory (the nearest one that exists): the temporary file the write makes lands there. */
export async function harnessWritable(root: string, file: string) {
  let directory = dirname(resolve(root, file));
  for (;;) {
    try { await access(directory, constants.W_OK); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directory === resolve(root)) throw error; }
    directory = dirname(directory);
  }
}

/**
 * The master's installed Claude harness judged against the current `masterHarness` plan (GY-1217):
 * an attention item naming the stale and missing rules, repaired by `master harness claude --apply`,
 * or null when it matches or nothing is installed. A settings file it cannot read is reported too.
 *
 * The recorded remedy is applied, not only printed (GY-1308): drift was printed at every master
 * status pass for hours while the merge and push denies stayed missing from the settings every
 * session in the checkout loads. With `repair` (the default, as `master status` reads it) the same
 * idempotent write `master harness claude --apply` makes runs first — operator-added entries are
 * kept — and the item is returned only when drift survives it; the repair itself is logged to stderr.
 *
 * A vantage that reads the checkout read-only (GY-1652: the doctor's confined session, bound
 * read-only by GY-888) attempts no write: the drift row names that vantage and the loop's own
 * remedy, which applies the contract from its unconfined process each cycle, instead of reporting a
 * doomed "applying it automatically failed: EROFS" as a standing self-heal failure.
 */
export async function masterHarnessDrift(root: string, master: MasterConfig, options: { repair?: boolean; log?: (line: string) => void; writable?: (root: string, file: string) => Promise<void> } = {}): Promise<(AttentionItem & { drift: Awaited<ReturnType<typeof harnessDrift>> }) | null> {
  const repair = 'graphyard master harness claude --apply';
  const plan = masterHarness(root, master, 'claude');
  try {
    let drift = await harnessDrift(root, plan);
    if (drift && (options.repair ?? true)) {
      try {
        await (options.writable ?? harnessWritable)(root, drift.file);
        await writeHarnessPermissions(root, plan, true);
        (options.log ?? (line => console.error(line)))(`Repaired harness drift in ${drift.file} with ${repair}: ${drift.text.replace(/^Harness drift in \S+: /, '').replace(/ Run graphyard .*$/, '')}`);
      } catch (error) {
        const code = readOnlyCode(error);
        if (code) return { subject: 'harness', text: `${drift.text.replace(/ Run graphyard .*$/, '')} This vantage reads the checkout read-only (${code}), so master status applies nothing here; the loop's own harness remedy applies the contract from its unconfined process on its next cycle.`, drift, ...agentOwner('master', repair) };
        return { subject: 'harness', text: `${drift.text} Applying it automatically failed: ${error instanceof Error ? error.message : 'unknown reason'}`, drift, ...agentOwner('master', repair) };
      }
      drift = await harnessDrift(root, plan);
    }
    return drift ? { subject: 'harness', text: drift.text, drift, ...agentOwner('master', repair) } : null;
  } catch (error) {
    return { subject: 'harness', text: `The master's harness settings cannot be compared with the current plan: ${error instanceof Error ? error.message : 'unknown reason'}`, drift: null, ...agentOwner('master', repair) };
  }
}

/**
 * The merge-queue reads and take-backs of one repository over the operator's `gh` credential — the
 * path `master protection` writes through — as the transport `master withdraw` acts over (GY-1871).
 * `gh api graphql` prints GraphQL's `{ data, errors }` envelope, so the envelope is unwrapped here
 * and GitHub's `errors` refuse: `pullRequestMergeState` expects the response `data`, and a refusal
 * must not read as an empty report.
 */
export function ghMergeQueueTransport(repository: string, base: string, run: ProtectionRun = protectionRun): WithdrawClient {
  const graphql: GraphqlTransport = async (query, variables) => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${String(value)}`);
    const response = JSON.parse(run('gh', args));
    const errors: { message?: unknown }[] = Array.isArray(response?.errors) ? response.errors : [];
    demand(errors.length === 0, `GitHub refused the GraphQL read: ${errors.map(error => error?.message).filter(Boolean).join('; ') || 'unreported error'}`, 502);
    return response?.data;
  };
  return {
    mergeQueueState: pr => pullRequestMergeState(graphql, repository, base, pr),
    dequeuePullRequest: state => dequeuePullRequestEntry(graphql, state),
  };
}
/**
 * Every pull request the control plane's work items may still hold on GitHub, deduplicated across
 * candidate and submission and ordered by number: what `master withdraw` reads and takes back
 * (GY-1871). A delivered item's pull request merged, so it is never read — the snapshot keeps every
 * settled delivery's PR numbers, and re-probing the whole ledger would spend the operator's GitHub
 * budget on PRs that can never be queued again. A closed item (`done` with a `closure`) is read
 * unless GitHub reported its pull request merged or the closure already closed it: closing clears
 * the control plane's merge authorization and nothing else, so a PR queued or armed when its item
 * was closed stays held on GitHub until the loop reconciles it, and this command runs with the loop
 * stopped. For every PR read GitHub decides the state, so a merged or closed pull request reads as
 * `none` and is left untouched.
 */
export function withdrawEntries(work: readonly WithdrawWork[]): WithdrawEntry[] {
  const entries = new Map<number, string | null>();
  for (const item of work) { if (!mayHoldPullRequest(item)) continue; for (const pr of [item.candidate?.pr, item.submission?.pr]) if (typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0 && !entries.has(pr)) entries.set(pr, item.key ?? null); }
  return [...entries].map(([pr, key]) => ({ key, pr })).sort((a, b) => a.pr - b.pr);
}
type WithdrawWork = { key?: string; stage?: string; candidate?: { pr?: number } | null; submission?: { pr?: number } | null; closure?: { pullRequest?: { outcome?: string } | null } | null; observation?: { merged?: boolean } | null };
/** Open, or closed without GitHub having merged or the closure having closed its pull request. */
const mayHoldPullRequest = (item: WithdrawWork) => item.stage !== 'done' || !!item.closure && !item.observation?.merged && !/^(closed|already-closed)$/.test(item.closure.pullRequest?.outcome ?? '');
/** Launch profiles, the master session, reviewer launches, and GitHub administration through the operator. */
export async function fleetCommand(session: MasterSession): Promise<unknown> {
  const { id, args, print, root, master, masterApi, masterMutation, coordinator, cli } = session;
  const reviewCommand: typeof launchReview = (...a) => registeredReview(master, a[1], a[2], masterMutation, () => launchReview(...a));
  if (id === 'start') {
    const kind = workerProfileSchema.shape.kind.safeParse(args[0]); if (!kind.success) throw new Error('Use master start with a supported agent kind such as codex or claude');
    const separator = args.indexOf('--'); const agentArgs = separator < 0 ? [] : args.slice(separator + 1);
    if (separator > 1 || separator < 0 && args.length > 1) throw new Error('Put agent-specific arguments after --');
    return print(await startMaster(root, kind.data, agentArgs, await listHerdrAgents()));
  }
  if (id === 'worker' && args[0] === 'add' && args[1]) return print(await saveWorkerProfile(root, JSON.parse(await readFile(args[1], 'utf8')), credential => masterApi('status', credential)));
  if (id === 'producer') return print(await producerCommand(root, args, credential => masterApi('status', credential)));
  if (id === 'config') return print(await saveMasterSettings(root, masterSettingsFromArgs(args)));
  if (id === 'registry') return print(await registryCommand(master, args, { read: path => masterApi(path), write: (path, data) => masterMutation(path, data) }));
  if (id === 'reviewer') return reviewerCommand(root, master, args, print);
  // The fleet on this host against the CLI checkout's commit: the release a restart would load.
  // A system-driven item's reviewer is the loop's to launch, save the recovery it sends the master to (GY-175),
  // judged on the same snapshot the launch reads its review request from.
  if (id === 'review') {
    const snapshot = await masterApi('work-snapshot'), work = snapshot.work.find((item: any) => item.id === args[0] || item.key === args[0]);
    if (work) assertHandReview(work, (await readReviewLedger(root)).reviews, (await readDispatchCursor(root, master)).failures, Date.parse(snapshot.now));
    return print(await reviewCommand(root, args, snapshot, await listHerdrAgents()));
  }
  // The one-time cleanup of the speculative-tip refs the removed merge queue left behind (GY-1236).
  if (id === 'tip-cleanup') {
    const { values } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: false });
    return print(cleanupTipRefs(master, { apply: !!values.apply }));
  }
  if (id === 'browser') {
    const { values, positionals } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } }, allowPositionals: true });
    // The Confirm-access captures earlier flows recorded, for fixtures (GY-1482); nothing is opened.
    if (positionals[0] === 'fixtures' && positionals.length === 1 && !values['dry-run']) return print(await listConfirmAccessFixtures(root));
    const flow = positionals[0] as BrowserFlow | undefined;
    if (!flow || !browserFlows.includes(flow)) throw new Error(`Use master browser ${browserFlows.join('|')} [--dry-run], or master browser fixtures`);
    // Installation state comes from the control plane's App credential, not the operator's gh token (GY-964).
    const result = await runBrowserFlow(root, master, flow, { coordinator: coordinator.actor.id, dryRun: !!values['dry-run'], installation: () => masterApi('github/installation') });
    if (result.outcome === 'refused') process.exitCode = 1;
    return print(result);
  }
  // GY-1871: the operator's take-back of Graphyard's merge intent on the managed repository before a
  // control transfer: every pull request a work item enqueued or armed is dequeued or disarmed, each
  // reported with its number, head sha, prior mode and result. The identity is the control plane's
  // answer about an admin credential read from stdin (`master main-watch acknowledge`'s path), never
  // the master's own; the GitHub calls ride the operator's `gh` credential, as `master protection`
  // writes. Without --apply the plan prints and nothing is written; a rerun writes nothing.
  if (id === 'withdraw') {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, apply: { type: 'boolean' }, json: { type: 'boolean' }, 'admin-token-stdin': { type: 'boolean' } }, allowPositionals: false });
    if (!values['admin-token-stdin']) throw new Error('Withdrawing the merge intent is operator-only: pipe an admin credential to graphyard master withdraw [--repo OWNER/NAME] [--apply] [--json] --admin-token-stdin (without --apply the plan prints and nothing is written)');
    // The pull request numbers come from this control plane's work, so the only repository they
    // can be taken back from is the one it manages: --repo confirms it and never redirects the
    // writes to another repository whose same-numbered pull requests Graphyard never enqueued.
    const repository = values.repo?.trim() || master.repository;
    if (repository.toLowerCase() !== master.repository.toLowerCase()) throw new Error(`master withdraw takes back the merge intent of the managed repository ${master.repository} only; --repo ${repository} names another repository, whose pull requests this control plane never enqueued`);
    const actor = (await masterApi('status', await readSecretFromStdin(10_000))).actor;
    const entries = withdrawEntries((await masterApi('work-snapshot')).work);
    const report = await withdrawEnqueuedPullRequests(ghMergeQueueTransport(repository, master.baseBranch), entries, actor, !!values.apply);
    // An incomplete take-back must not read as done to the operator or a script: `master protection`
    // sets a failing exit on refusal the same way.
    if (report.failed > 0) process.exitCode = 1;
    return print({ repository, ...report });
  }
  if (id === 'harness') {
    const { values, positionals } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: true });
    const kind = workerProfileSchema.shape.kind.safeParse(positionals[0] ?? 'claude');
    if (!kind.success) throw new Error('Use master harness with a supported agent kind such as claude or codex');
    return print(await writeHarnessPermissions(root, masterHarness(root, master, kind.data!), !!values.apply));
  }
  return unhandled;
}
