import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Work } from './model.js';
import type { ChildRun } from './child-runner.js';
import type { MasterConfig } from './master/profiles.js';
import { loadMasterConfig } from './master/config.js';
import { accountLaunch } from './master/environments.js';
import { closeFailedLaunch, launchStartMs, startAgentSession } from './master/launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson } from './master/herdr.js';
import { autonomousSession, destructivePromptGuidance, herdrAttach } from './master/dispatch.js';
import { selectApproverAccount, type SessionRegistrar } from './master/autonomy.js';
import { registeredLaunch } from './model/session-state.js';
import { sessionName } from './session-name.js';
import { failureText } from './master/worktrees.js';

// GY-566: the docs-sync session the loop launches for a docs-only conflict; the routing and carry
// rules it serves are in model/docs-sync.ts.

type Run = (command: string, args: string[]) => string;
const gitRun: Run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
/**
 * The paths git itself reports conflicting when `head` is merged with `base`, from an in-memory
 * `git merge-tree` over this checkout's object store after fetching both; null when either commit
 * cannot be had or the probe fails, and [] for a clean merge.
 */
export function localConflictPaths(root: string, branch: string, head: string, base: string, run: Run = gitRun): string[] | null {
  try { run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]); } catch { /* a head fetched earlier still serves */ }
  try { run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', 'origin', base]); } catch { /* likewise */ }
  try { run('git', ['-C', root, 'cat-file', '-e', `${head}^{commit}`]); run('git', ['-C', root, 'cat-file', '-e', `${base}^{commit}`]); } catch { return null; }
  try { run('git', ['-C', root, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base]); return []; }
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
    + `Create a detached worktree of the reviewed head: git -C ${root} fetch origin ${plan.branch} ${plan.baseBranch} && git -C ${root} worktree add --detach ${worktree} ${plan.head}; if ${root}/package-lock.json and ${worktree}/package-lock.json are identical, link ${root}/node_modules into ${worktree}, otherwise run npm ci there. `
    + `In it run git merge --no-ff ${plan.base}. Resolve each conflicted paragraph so both sides' meaning survives — keep what the base added and what this item added, merging sentences rather than choosing a side — and stay within the documentation word budget. Touch only the conflicted paragraphs of the conflicted docs pages: never edit a file outside docs/, never change a line that did not conflict, and never rewrite, reword or drop anything else. If a conflicted path is not a docs page, or the conflict cannot be resolved while keeping both meanings, abort the merge (git merge --abort) and stop: the control plane then returns the item to a worker. `
    + `Then rerun the docs obligation check and the word-budget test: npm test -- tests/docs-budget.test.ts tests/docs-obligation.test.ts. If either fails, shorten or fix only the paragraphs you resolved until both pass. Commit the merge with the message "Graphyard docs-sync of ${plan.key} onto ${plan.base.slice(0, 12)}" and push it: git push origin HEAD:refs/heads/${plan.branch} — a plain push, never forced; a refused push means the branch moved, and you stop. `
    + `Do not run graphyard complete, claim work, review, approve, submit evidence or merge: the control plane observes the pushed head, keeps the approval when the diff outside docs/ is unchanged, and runs the proofs again. When done, remove the worktree with git -C ${root} worktree remove --force ${worktree}, print one line naming the pushed head, and stop. `
    + destructivePromptGuidance
    + autonomousSession('resolve the docs conflict and push, or abort and stop', 'abort the merge and stop');
}

/**
 * Launch the docs-sync session for one plan on a reviewer-class account: the accounts the reviewer
 * profiles name, chosen as an approver's are (`selectApproverAccount`). The instruction is the
 * session's own first request, like every session Graphyard launches.
 */
export async function launchDocsSync(root: string, work: Work, plan: DocsSyncPlan, herdr: { agents: HerdrAgent[]; available: boolean }, run?: ChildRun, register?: SessionRegistrar) {
  const config = await loadMasterConfig(root);
  const name = docsSyncSessionName(plan);
  if (!herdr.available) throw new Error(`Herdr's session inventory could not be read, so no docs-sync session for ${work.key} is launched into it; the launch is made again once Herdr answers`);
  if (herdr.agents.some(agent => agent.name === name)) throw new Error(`Docs-sync session ${name} is already visible in Herdr; let it finish first`);
  const chosen = await selectApproverAccount(config, work.key, config.approver?.id ?? 'graphyard-docs-sync', { runtime: herdr });
  const kind = chosen.account?.kind ?? config.reviewers[0]?.kind ?? config.workers[0]?.kind;
  const release = (why: string) => chosen.fleet?.release(why).catch(() => false);
  if (!kind) { await release(`docs-sync launch for ${work.key} found no runtime`); throw new Error('No runtime is configured for a docs-sync session: name reviewer profiles or approver accounts'); }
  const checkout = docsSyncCheckout(root, plan);
  await mkdir(resolve(checkout, '..'), { recursive: true });
  const launch = accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, chosen.account ?? null, { writable: [resolve(checkout, '..')] });
  let pane: string | undefined, tab: string | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Docs sync · ${work.key}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tab = created.tab;
    await registeredLaunch(register, { id: `docs-sync:${plan.head}:${plan.base}`, kind: 'coordination', role: 'docs-sync', runtime: kind, host: config.hostId, head: plan.head,
      agentName: name, pane: created.pane, attach: herdrAttach(created.pane, config.herdrWorkspace), ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      subject: `${work.key}: docs-sync onto ${plan.base.slice(0, 12)}`, state: 'running' },
    () => startAgentSession(name, kind, created.pane, launch.args, docsSyncPrompt(config, plan, root), run, { directory: root, retry: `docs-sync of ${work.key}`, contract: launch.contract, environment: launch.environment, timeoutMs: launchStartMs(config) }), () => undefined);
  } catch (error) {
    if (pane || tab) await closeFailedLaunch(pane, tab, run).catch(() => undefined);
    await release(`docs-sync launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
    throw error;
  }
  return { agentName: name, pane: pane ?? null, account: chosen.account?.name ?? null, runtime: kind, session: chosen.fleet?.account.fleet.session ?? null };
}

