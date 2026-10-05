import { existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { access, constants, mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Work } from './model.js';
import { runChild, type ChildRun } from './child-runner.js';
import type { CoordinatorConfinement, MasterConfig } from './master/profiles.js';
import { loadMasterConfig } from './master/config.js';
import { accountLaunch } from './master/environments.js';
import { closeFailedLaunch, launchStartMs, prepareConfinedGitPaths, sessionConfinement, startAgentSession } from './master/launch.js';
import { checkoutGitDirectory } from './master/checkout-git.js';
import { sessionGitAdminDirectory } from './master/profiles.js';
import { createdHerdrTab, type HerdrAgent, herdrJson, observeHerdrAgents } from './master/herdr.js';
import { autonomousSession, destructivePromptGuidance, herdrAttach } from './master/dispatch.js';
import { selectApproverAccount, type ApproverSelection, type SessionRegistrar } from './master/autonomy.js';
import { registeredLaunch } from './model/session-state.js';
import { sessionName } from './session-name.js';
import { failureText } from './master/worktrees.js';

// GY-566: the docs-sync session the loop launches for a docs-only conflict; the routing and carry
// rules it serves are in model/docs-sync.ts.

/**
 * The paths git itself reports conflicting when `head` is merged with `base`, from an in-memory
 * `git merge-tree` over this checkout's object store after fetching both; null when either commit
 * cannot be had or the probe fails, and [] for a clean merge. Every git call goes through `run`,
 * the loop's asynchronous child runner, so a slow fetch never blocks the loop's event loop.
 */
export async function localConflictPaths(root: string, branch: string, head: string, base: string, run: ChildRun): Promise<string[] | null> {
  const git = async (...args: string[]) => run('git', ['-C', root, ...args], { timeoutMs: 60_000 });
  try { await git('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch { /* a head fetched earlier still serves */ }
  try { await git('fetch', '--quiet', '--no-tags', 'origin', base); } catch { /* likewise */ }
  try { await git('cat-file', '-e', `${head}^{commit}`); await git('cat-file', '-e', `${base}^{commit}`); } catch { return null; }
  try { await git('merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base); return []; }
  catch (error: any) {
    if (error?.status !== 1 || typeof error.stdout !== 'string') return null;
    return [...new Set<string>(error.stdout.split('\0').slice(1).filter(Boolean))].sort();
  }
}

// ---- The docs-sync session -----------------------------------------------------------------

/** What one docs-sync session is launched for: the reviewed head, the base tip it conflicts with, and the conflicted pages. */
export interface DocsSyncPlan { key: string; pr: number; branch: string; baseBranch: string; head: string; base: string; paths: string[] }
/** How long a docs-sync session may run before the loop gives the conflict to a worker instead. */
export const docsSyncMaxMs = 30 * 60_000;
/** Within the runtimes' 32-character limit: `gy-docs-sync-gy-566-1a2b3c4`. */
export const docsSyncSessionName = (plan: Pick<DocsSyncPlan, 'key' | 'head'>) => sessionName('gy-docs-sync', plan.key, plan.head.slice(0, 7));
export const docsSyncCheckout = (root: string, plan: Pick<DocsSyncPlan, 'key' | 'head'>) => resolve(root, '.graphyard', 'docs-sync', `${plan.key}-${plan.head.slice(0, 7)}`);

/** The docs-sync session's whole instruction: narrow by design, it resolves prose and nothing else. */
export function docsSyncPrompt(config: Pick<MasterConfig, 'repository' | 'cliPath'>, plan: DocsSyncPlan, root: string) {
  const worktree = docsSyncCheckout(root, plan);
  return `You are a Graphyard docs-sync session for ${config.repository}. Work item ${plan.key} (pull request #${plan.pr}, branch ${plan.branch}) was reviewed at head ${plan.head}, and it conflicts with base branch tip ${plan.base} only in documentation: ${plan.paths.join(', ')}. Resolve exactly that, nothing else. `
    + `You start in ${worktree}, a detached worktree of the reviewed head the launcher created for you, with both commits already fetched; it is the only checkout you can write. If ${worktree}/node_modules is missing, run npm ci there. `
    + `In it run git merge --no-ff ${plan.base}. Resolve each conflicted paragraph so both sides' meaning survives — keep what the base added and what this item added, merging sentences rather than choosing a side — and stay within the documentation word budget. Touch only the conflicted paragraphs of the conflicted docs pages: never edit a file outside docs/, never change a line that did not conflict, and never rewrite, reword or drop anything else. If a conflicted path is not a docs page, or the conflict cannot be resolved while keeping both meanings, abort the merge (git merge --abort) and stop: the control plane then returns the item to a worker. `
    + `Then rerun the docs obligation check and the word-budget test: npm test -- tests/docs-budget.test.ts tests/docs-obligation.test.ts. If either fails, shorten or fix only the paragraphs you resolved until both pass. Commit the merge with the message "Graphyard docs-sync of ${plan.key} onto ${plan.base.slice(0, 12)}" and push it: git push origin HEAD:refs/heads/${plan.branch} — a plain push, never forced; a refused push means the branch moved, and you stop. `
    + `Do not run graphyard complete, claim work, review, approve, submit evidence or merge: the control plane observes the pushed head, keeps the approval when the diff outside docs/ is unchanged, and runs the proofs again. Leave the worktree in place — the launcher reclaims it once this session is gone. When done, print one line naming the pushed head, and stop. `
    + destructivePromptGuidance
    + autonomousSession('resolve the docs conflict and push, or abort and stop', 'abort the merge and stop');
}

// ---- The docs-sync checkout (GY-1205) -------------------------------------------------------
// Every session runs with the coordinator checkout bind-mounted read-only (GY-888), so a session
// cannot create its own worktree under it: the launcher, which is not confined, creates the
// detached worktree first and starts the session in it, and the confinement re-exposes exactly
// that directory (and the shared Git paths) writable.

const covers = (outer: string, path: string) => { const from = relative(outer, path); return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)); };

/** Remove every docs-sync checkout no visible docs-sync session owns, so a finished or failed one does not hold disk. */
export async function reclaimDocsSyncCheckouts(root: string, visible: readonly string[], run: ChildRun = runChild): Promise<string[]> {
  const parent = resolve(root, '.graphyard', 'docs-sync');
  let entries: string[];
  try { entries = await readdir(parent); } catch { return []; }
  const removed: string[] = [];
  for (const entry of entries) {
    const at = entry.lastIndexOf('-');
    if (at <= 0 || visible.includes(docsSyncSessionName({ key: entry.slice(0, at), head: entry.slice(at + 1) }))) continue;
    const path = resolve(parent, entry);
    try { await run('git', ['-C', root, 'worktree', 'remove', '--force', path], { timeoutMs: 60_000 }); } catch { /* not a registered worktree any more */ }
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  }
  if (removed.length) { try { await run('git', ['-C', root, 'worktree', 'prune'], { timeoutMs: 60_000 }); } catch { /* the next add prunes too */ } }
  return removed;
}

/** Create the detached worktree of the reviewed head the session starts in, with the base tip fetched beside it and node_modules linked when the lockfiles match. */
export async function prepareDocsSyncCheckout(root: string, plan: DocsSyncPlan, run: ChildRun = runChild): Promise<string> {
  const checkout = docsSyncCheckout(root, plan);
  try { await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', plan.branch, plan.baseBranch], { timeoutMs: 60_000 }); } catch { /* commits fetched earlier still serve */ }
  try { await run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', plan.base], { timeoutMs: 60_000 }); } catch { /* likewise */ }
  await run('git', ['-C', root, 'worktree', 'add', '--detach', checkout, plan.head], { timeoutMs: 60_000 });
  const lock = (directory: string) => { try { return readFileSync(resolve(directory, 'package-lock.json'), 'utf8'); } catch { return null; } };
  const own = lock(root);
  if (own !== null && own === lock(checkout) && existsSync(resolve(root, 'node_modules')) && !existsSync(resolve(checkout, 'node_modules')))
    symlinkSync(resolve(root, 'node_modules'), resolve(checkout, 'node_modules'), 'dir');
  return checkout;
}

/** Remove one docs-sync checkout and its worktree registration now, as a refused launch leaves it. */
async function removeDocsSyncCheckout(root: string, checkout: string, run: ChildRun) {
  try { await run('git', ['-C', root, 'worktree', 'remove', '--force', checkout], { timeoutMs: 60_000 }); } catch { /* never registered */ }
  await rm(checkout, { recursive: true, force: true });
  try { await run('git', ['-C', root, 'worktree', 'prune'], { timeoutMs: 60_000 }); } catch { /* the next add prunes too */ }
}

/**
 * What a docs-sync launch grants writable to the runtime's own sandbox (a codex `--add-dir`): the
 * checkout and exactly the shared Git paths the read-only mount re-exposes (readOnlyMountWrapper) —
 * the object store, the checkout's own worktree admin and the remote-tracking refs it pushes
 * through — never the whole common Git directory, whose HEAD, index and local refs are the
 * coordinator's (GY-1273).
 */
export function docsSyncWritablePaths(root: string, checkout: string): string[] {
  prepareConfinedGitPaths(root);
  const gitDir = checkoutGitDirectory(root), admin = sessionGitAdminDirectory(checkout, root);
  const directory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
  return [checkout, join(gitDir, 'objects'), ...(admin ? [admin] : []), join(gitDir, 'refs', 'remotes'), join(gitDir, 'logs', 'refs', 'remotes')].filter(directory);
}

/**
 * Why a docs-sync session would be unable to write its checkout, or null: the directory is not
 * writable on the host, or the confinement the session carries leaves it read-only — the last
 * bind covering it must be a writable `--bind`, after the read-only bind of the coordinator.
 * The launch is refused on it before the session starts, so the loop routes the conflict to a
 * rework in the same cycle instead of after docsSyncMaxMs.
 */
export async function docsSyncCheckoutRefusal(checkout: string, confinement: CoordinatorConfinement | null): Promise<string | null> {
  const head = `The docs-sync checkout ${checkout} is not writable`;
  try { await access(checkout, constants.W_OK); } catch (error: any) { return `${head} (${error?.code ?? 'unknown error'}), so no docs-sync session is started in it`; }
  if (confinement?.mechanism !== 'read-only-mount') return null;
  const words = confinement.wrapper;
  let last: string | null = null;
  for (let index = 0; index + 1 < words.length && words[index] !== '--'; index++)
    if (['--bind', '--ro-bind', '--dev-bind'].includes(words[index]) && words[index + 1] === words[index + 2] && covers(words[index + 1], checkout)) { last = words[index]; index += 2; }
  return last === '--bind' || last === '--dev-bind' ? null : `${head} under the session's confinement: no writable bind re-exposes it after the read-only bind of the coordinator checkout, so no docs-sync session is started in it`;
}

/**
 * Launch the docs-sync session for one plan on a reviewer-class account: the accounts the reviewer
 * profiles name, chosen as an approver's are (`selectApproverAccount`). The instruction is the
 * session's own first request, like every session Graphyard launches.
 */
export interface DocsSyncLaunchSeams {
  config?: () => Promise<MasterConfig>;
  select?: (config: MasterConfig, key: string, principal: string, probe: { runtime: { agents: HerdrAgent[]; available: boolean } }) => Promise<ApproverSelection>;
  confinement?: typeof sessionConfinement;
}
export async function launchDocsSync(root: string, work: Work, plan: DocsSyncPlan, herdr: { agents: HerdrAgent[]; available: boolean }, run?: ChildRun, register?: SessionRegistrar, seams: DocsSyncLaunchSeams = {}) {
  const config = await (seams.config ?? (() => loadMasterConfig(root)))();
  const name = docsSyncSessionName(plan);
  if (!herdr.available) throw new Error(`Herdr's session inventory could not be read, so no docs-sync session for ${work.key} is launched into it; the launch is made again once Herdr answers`);
  if (herdr.agents.some(agent => agent.name === name)) throw new Error(`Docs-sync session ${name} is already visible in Herdr; let it finish first`);
  const chosen = await (seams.select ?? selectApproverAccount)(config, work.key, config.approver?.id ?? 'graphyard-docs-sync', { runtime: herdr });
  const kind = chosen.account?.kind ?? config.reviewers[0]?.kind ?? config.workers[0]?.kind;
  const release = (why: string) => chosen.fleet?.release(why).catch(() => false);
  if (!kind) { await release(`docs-sync launch for ${work.key} found no runtime`); throw new Error('No runtime is configured for a docs-sync session: name reviewer profiles or approver accounts'); }
  let checkout: string | undefined, launch: ReturnType<typeof accountLaunch>;
  try {
    await reclaimDocsSyncCheckouts(root, herdr.agents.map(agent => agent.name ?? ''), run);
    await mkdir(resolve(root, '.graphyard', 'docs-sync'), { recursive: true });
    checkout = await prepareDocsSyncCheckout(root, plan, run);
    launch = accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, chosen.account ?? null, { writable: docsSyncWritablePaths(root, checkout) });
    const refusal = await docsSyncCheckoutRefusal(checkout, await (seams.confinement ?? sessionConfinement)(kind, launch.args, { directory: checkout }));
    if (refusal) throw new Error(refusal);
  } catch (error) {
    // No session will ever own the checkout, so it is reclaimed now rather than at the next launch.
    if (checkout) await removeDocsSyncCheckout(root, checkout, run ?? runChild).catch(() => undefined);
    await release(`docs-sync launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
    throw error;
  }
  let pane: string | undefined, tab: string | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', checkout, '--label', `Docs sync · ${work.key}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tab = created.tab;
    await registeredLaunch(register, { id: `docs-sync:${plan.head}:${plan.base}`, kind: 'coordination', role: 'docs-sync', runtime: kind, host: config.hostId, head: plan.head,
      agentName: name, pane: created.pane, attach: herdrAttach(created.pane, config.herdrWorkspace), ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      subject: `${work.key}: docs-sync onto ${plan.base.slice(0, 12)}`, state: 'running' },
    () => startAgentSession(name, kind, created.pane, launch.args, docsSyncPrompt(config, plan, root), run, { directory: checkout, retry: `docs-sync of ${work.key}`, contract: launch.contract, environment: launch.environment, timeoutMs: launchStartMs(config) }), () => undefined);
  } catch (error) {
    if (pane || tab) await closeFailedLaunch(pane, tab, run).catch(() => undefined);
    await release(`docs-sync launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
    throw error;
  }
  return { agentName: name, pane: pane ?? null, account: chosen.account?.name ?? null, runtime: kind, session: chosen.fleet?.account.fleet.session ?? null };
}


/** The loop's docs-sync effects (GY-566); a loop without them sends every confirmed conflict to rework as before. */
export interface DocsSyncEffects {
  /** Launches the docs-sync session for a conflict confined to docs pages (`launchDocsSync`); it replaces a rework decision the loop could otherwise request. */
  docsSync: (work: Work, plan: DocsSyncPlan) => Promise<{ agentName: string; pane: string | null; account: string | null; runtime: string; session: string | null }>;
  /** The paths git reports conflicting when `head` merges with `base`, from this checkout (`localConflictPaths`); null when it cannot tell. */
  conflictPaths: (work: Work, head: string, base: string) => Promise<string[] | null>;
}

export const docsSyncEffects = (root: string, run: ChildRun, register: (work: Work) => SessionRegistrar): DocsSyncEffects => ({
  docsSync: async (work, plan) => launchDocsSync(root, work, plan, await observeHerdrAgents(run), run, register(work)),
  conflictPaths: async (work, head, base) => work.candidate ? localConflictPaths(root, work.candidate.branch, head, base, run) : null,
});
