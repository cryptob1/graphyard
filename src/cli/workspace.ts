import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import type { Work } from '../model.js';
import { containmentFailureNote, setupLine, supervise, systemdContainment } from '../supervisor.js';
import { attributeConflicts, hasConflictMarkers, localScopeFindings, managedServerUrl, parseGeneratedManifest, regenerateManagedBlocks, type GeneratedManifest } from '../sync.js';
import { managedInstructions } from '../repository-setup.js';
import { managedMasterInstructions } from '../master.js';
import { assertRepository, discover } from '../onboarding.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, revalidateContainment, settleContainment } from '../quarantine.js';
import { environmentBlocker, environmentFailure } from '../worker-sandbox.js';
import { runChild } from '../child-runner.js';
import { releaseUnderFailure, reserveReleasingHold, submittedBranchRefusal, workspaceFailure } from '../master/worktrees.js';
import { superviseSessionCredential, type MintedPushCredential } from '../worker-credential.js';
import type { CliContext } from './context.js';
import { installUnderLease } from './install-under-lease.js';
import { gitOrThrow, reclaimBranchHolders, type ReclaimedHolder } from '../worktree-holders.js';
import { restoreAndReport } from './sync-restore.js';
import { pushViaControlPlane } from './sync-push.js';
import { defineCommands, workMutation } from './registry.js';
import { keepBlockedWork } from './lease.js';

export { installUnderLease };

/**
 * The generated files a repository declares for sync: `scripts/check-docs.mjs --manifest` names
 * the paths its `--write` renders in full. A repository without the script declares none.
 */
const generatedManifestScript = 'scripts/check-docs.mjs';
async function localGeneratedManifest(cwd: string): Promise<GeneratedManifest | null> {
  if (!existsSync(resolve(cwd, generatedManifestScript))) return null;
  const result = spawnSync(process.execPath, [generatedManifestScript, '--manifest'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0 ? parseGeneratedManifest(result.stdout) : null;
}
// The renderer's own exit status is not consulted: with other files still conflicted its link
// check fails, but the generated files are written first, and each is judged by its content.
function regenerateGenerated(cwd: string, manifest: GeneratedManifest) {
  const [command, ...args] = manifest.regenerate;
  spawnSync(command === 'node' ? process.execPath : command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/**
 * Graphyard's own repository renders the AGENTS.md blocks with the templates the merged tree
 * carries, so the result matches what its drift test expects; any other repository, and a tree
 * whose sources will not load, use the templates this CLI ships.
 */
const agentsTemplateSources = ['src/repository-setup.ts', 'src/master.ts'];
async function agentsRenderers(cwd: string) {
  const [setupFile, masterFile] = agentsTemplateSources.map(file => resolve(cwd, file));
  if (existsSync(setupFile) && existsSync(masterFile)) try {
    const [setup, master] = await Promise.all([import(pathToFileURL(setupFile).href), import(pathToFileURL(masterFile).href)]);
    if (typeof setup.managedInstructions === 'function' && typeof master.managedMasterInstructions === 'function') return { managedInstructions: setup.managedInstructions as typeof managedInstructions, managedMasterInstructions: master.managedMasterInstructions as typeof managedMasterInstructions, source: 'worktree' };
  } catch {}
  return { managedInstructions, managedMasterInstructions, source: 'cli' };
}

const quietBranch = () => spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim();

async function syncWork({ api, print, base: serverUrl, args }: CliContext, work: any) {
  // The canonical way to take the base branch: a merge keeps the worker's history and makes every
  // resolution visible, and the same classifier the control plane applies at complete runs here,
  // against the fetched tip, before anything is pushed. Files the repository declares generated
  // are rendered afresh from the merged sources rather than merged by hand; every other conflict
  // is the worker's, reported with the shipped items that landed it.
  const baseBranch = String((await api('status')).baseBranch ?? 'main');
  const cwd = process.cwd();
  // Git's own diagnostics still reach the worker, and a failure carries them, so a refused write names its path.
  const git = (...gitArgs: string[]) => {
    const result = spawnSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) throw Object.assign(new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`), { stderr: result.stderr });
    return result.stdout.trim();
  };
  const quietly = (...gitArgs: string[]) => spawnSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const branch = git('symbolic-ref', '--short', 'HEAD');
  if (!work.workspaces.some((w: any) => w.branch === branch)) throw new Error(`Run sync from a workspace branch registered for ${work.key}; ${branch} is not one`);
  const unmerged = () => quietly('diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
  const generated = await localGeneratedManifest(cwd);
  // A merge the previous sync left for the worker to resolve is continued, not restarted.
  const continuing = quietly('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
  let baseTip: string, mergeBase: string, detail = '';
  if (continuing) { baseTip = git('rev-parse', 'MERGE_HEAD'); mergeBase = git('merge-base', 'HEAD', baseTip); }
  else {
    git('fetch', '--quiet', 'origin');
    baseTip = git('rev-parse', `refs/remotes/origin/${baseBranch}`); mergeBase = git('merge-base', 'HEAD', baseTip);
    const merge = quietly('merge', '--no-commit', '--no-edit', `refs/remotes/origin/${baseBranch}`);
    detail = `${merge.stdout}${merge.stderr}`.trim();
    if (merge.status !== 0 && !unmerged().length) throw new Error(`git merge failed without a conflict to resolve: ${detail}`);
  }
  const regenerated: string[] = [];
  let conflicts = unmerged();
  if (conflicts.length && generated && conflicts.some(path => generated.files.includes(path))) {
    regenerateGenerated(cwd, generated);
    for (const path of conflicts.filter(path => generated.files.includes(path))) {
      if (hasConflictMarkers(await readFile(resolve(cwd, path), 'utf8'))) continue;
      git('add', '--', path); regenerated.push(path);
    }
  }
  if (conflicts.includes('AGENTS.md') && !conflicts.some(path => agentsTemplateSources.includes(path))) {
    const conflicted = await readFile(resolve(cwd, 'AGENTS.md'), 'utf8');
    const url = managedServerUrl(quietly('show', `${baseTip}:AGENTS.md`).stdout) ?? managedServerUrl(conflicted) ?? serverUrl;
    const renderers = await agentsRenderers(cwd);
    const rendered = regenerateManagedBlocks(conflicted, text => { const worker = renderers.managedInstructions(text, url); return worker.includes('<!-- graphyard-master -->') ? renderers.managedMasterInstructions(worker) : worker; });
    if (rendered !== null) { await writeFile(resolve(cwd, 'AGENTS.md'), rendered); git('add', '--', 'AGENTS.md'); regenerated.push(`AGENTS.md (managed blocks rendered from the ${renderers.source} templates)`); }
  }
  conflicts = unmerged();
  if (conflicts.length) {
    const landed = new Set(git('rev-list', `${mergeBase}..${baseTip}`).split('\n').filter(Boolean));
    // Attribution is a courtesy: an unreadable snapshot never hides the conflict list. A busy
    // runner can retire the keep-alive socket while the merge runs, so a failed read retries
    // twice on a fresh connection before the conflicts are reported unattributed (GY-864); an
    // answer, even an empty one, is taken as it is.
    let all: Work[] | null = null;
    for (let attempt = 0; attempt < 3 && all === null; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
      all = await api('work-snapshot?view=coordination').then((snapshot: any) => Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.work) ? snapshot.work : []).catch(() => null);
    }
    const remaining = attributeConflicts(conflicts, all ?? [], sha => landed.has(sha), generated?.files ?? []);
    print({ key: work.key, base: `origin/${baseBranch}`, baseTip, merged: false, conflicts: remaining, regenerated, detail, plannedFiles: work.plannedFiles,
      next: `Resolve each remaining conflict (each names the shipped items that landed it), stage it, and rerun sync ${work.key}: it regenerates the generated files from the resolved sources and commits the merge. Files outside plannedFiles must match origin/${baseBranch} byte-for-byte: git checkout ${baseTip.slice(0, 12)} -- PATH restores one.` });
    process.exitCode = 1; return;
  }
  // The merged sources decide what the generated files say, whether or not they conflicted.
  if (generated) {
    regenerateGenerated(cwd, generated);
    for (const path of generated.files) if (quietly('diff', '--quiet', '--', path).status !== 0 || quietly('ls-files', '--error-unmatch', '--', path).status !== 0) { git('add', '--', path); if (!regenerated.includes(path)) regenerated.push(path); }
  }
  if (quietly('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) git('commit', '--no-edit', '--quiet');
  else if (quietly('diff', '--cached', '--quiet').status !== 0) git('commit', '--quiet', '-m', `Regenerate generated files after sync ${work.key}`);
  const raw = git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), numstat = git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD');
  const read = async (sha: string) => { const blob = quietly('cat-file', 'blob', sha); return blob.status === 0 ? blob.stdout : null; };
  const findings = await localScopeFindings(work.plannedFiles ?? [], raw, numstat, generated?.files ?? [], read);
  const refused = findings.filter(finding => finding.refused);
  // `--restore` takes the remedy itself (GY-859): one plain commit, so a plain push updates the PR.
  if (args.includes('--restore') && refused.length) return restoreAndReport(git, print, { work, baseBranch, baseTip, regenerated, generated: generated?.files ?? [], refused: refused.map(finding => finding.path), read });

  print({ key: work.key, base: `origin/${baseBranch}`, baseTip, head: git('rev-parse', 'HEAD'), merged: true, regenerated, generated: generated?.files ?? [], plannedFiles: work.plannedFiles, ok: !refused.length,
    files: findings, refused: refused.map(finding => `${finding.path}: ${finding.detail}`),
    next: refused.length ? `Run sync ${work.key} --restore: it restores each listed file to origin/${baseBranch} in one new commit naming them (by hand: git checkout ${baseTip.slice(0, 12)} -- PATH for each, restoring a rename's original path, then commit), so a plain push updates the PR; a force push is never needed or allowed. Do not push until it reports ok. Only an operator can widen plannedFiles, through an audited requirements revision.`
      : `Every file outside plannedFiles matches origin/${baseBranch}. Push, then complete ${work.key} EPOCH PR.` });
  if (refused.length) process.exitCode = 1;
}

/** Local worktrees and the supervised worker launch. */
export const workspaceCommands = defineCommands([
  {
    name: 'sync',
    scope: 'work',
    help: [
      '  sync GY-N [--restore]         Merge origin/BASE (never rebase), regenerate generated files',
      '                                (docs indexes, AGENTS.md blocks) instead of hand-merging them,',
      '                                name the shipped items behind each remaining conflict, and',
      '                                list every file outside plannedFiles that no longer matches',
      '                                the base; run before every push',
      '  sync GY-N --restore           The same, then restore every such file to the base in one new',
      '                                commit naming them; push it plainly. A force push is never',
      '                                needed or allowed',
      '  sync GY-N --push-via-control-plane COMMIT  Control plane pushes a refused workflow base sync',
    ],
    async run(context, work) {
      // A write the worker's sandbox refused is recorded as that, naming the sandbox and the path,
      // so the item never presents as a ready-gate refusal or an unexplained lapse (GY-134).
      try { await (context.args.includes('--push-via-control-plane') ? pushViaControlPlane : syncWork)(context, work); } catch (error) {
        const failure = environmentFailure(error); const epoch = work.workspaces.find((w: any) => w.branch === quietBranch())?.epoch ?? work.lease?.epoch;
        if (!failure || epoch === undefined) throw error;
        const reason = environmentBlocker(`sync ${work.key}`, process.env.GRAPHYARD_HERDR_AGENT_KIND, failure);
        const partialWork = keepBlockedWork(work, epoch); await workMutation(context, work)('blocked', { epoch, reason, ...(partialWork ? { partialWork } : {}) });
        throw new Error(`${reason} Recorded as the blocker on ${work.key}.`);
      }
    },
  },
  {
    name: 'restore-branch',
    scope: 'work',
    help: [
      '  restore-branch GY-N EPOCH     Replace the leased attempt\'s own branch with HEAD after an',
      '                                ejected or contaminated tip: a lease push to that one branch,',
      '                                conditional on the tip just fetched; run after reset and sync',
    ],
    async run(context, work) {
      // The worker's one history rewrite (GY-128). Its harness denies every raw force push, the lease
      // form included, because a glob cannot limit one to a single ref; this command can. The server
      // confirms the caller holds this epoch's live lease, and the push names only the branch
      // registered for that epoch, leased on the tip fetched here, so it replaces what it saw.
      const epoch = Number(context.args[0]);
      if (!Number.isInteger(epoch) || epoch < 1) throw new Error('Use restore-branch GY-N EPOCH');
      await workMutation(context, work)('heartbeat', { epoch });
      const branch = work.workspaces.find((w: any) => w.epoch === epoch)?.branch;
      if (!branch) throw new Error(`No workspace branch is registered for ${work.key} epoch ${epoch}`);
      const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
      const quietly = (...gitArgs: string[]) => spawnSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const current = quietly('symbolic-ref', '--short', 'HEAD').stdout.trim();
      if (current !== branch) throw new Error(`Run restore-branch on ${branch}, the branch of ${work.key} epoch ${epoch}; this worktree is on ${current || 'a detached HEAD'}`);
      if (quietly('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0) throw new Error(`A merge is in progress: finish sync ${work.key} before restoring the branch`);
      if (quietly('diff', '--quiet', 'HEAD').status !== 0) throw new Error('The worktree has uncommitted changes: commit them or reset before restoring the branch');
      git('fetch', '--quiet', 'origin');
      const tip = quietly('rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`).stdout.trim();
      const head = git('rev-parse', 'HEAD');
      const push = quietly('push', `--force-with-lease=refs/heads/${branch}:${tip}`, 'origin', `HEAD:refs/heads/${branch}`);
      if (push.status !== 0) throw new Error(`The lease push of ${branch} was refused${/stale info/.test(push.stderr) ? ': the branch moved after the fetch; fetch again and read the new tip before replacing it' : ''}: ${push.stderr.trim()}`);
      context.print({ key: work.key, epoch, branch, replaced: tip || null, head,
        next: `The branch holds ${head.slice(0, 12)}. Submit it with complete ${work.key} ${epoch} PR.` });
    },
  },
  {
    name: 'worktree',
    scope: 'work',
    help: ['  worktree GY-N EPOCH [BASE]    Reserve and create a local isolated worktree; an earlier attempt\'s hold on the branch is preserved and released'],
    async run(context, work) {
      const { args, api, print } = context;
      const mutate = workMutation(context, work);
      const epoch = Number(args[0]); const root = context.repositoryRoot();
      const status = await api('status');
      assertRepository((await discover(root)).repository, status.repository);
      const branch = work.submission ? work.workspaces.find((w: any) => w.epoch === work.submission.epoch)?.branch : `graphyard/${work.key.toLowerCase()}-${epoch}`;
      if (!branch) throw new Error('Submitted workspace branch is missing');
      const path = resolve(root, '.graphyard/worktrees', `${work.key}-${epoch}`);
      let startPoint = args[1] ?? 'HEAD';
      if (work.submission) {
        const remoteBranch = `refs/remotes/origin/${branch}`;
        // GY-860 AC-2: an unfetchable or moved PR branch is a workspace failure, so no attempt is spent.
        const refused = await submittedBranchRefusal(root, branch, remoteBranch, work.candidate?.sha, runChild);
        if (refused) { await releaseUnderFailure(mutate, epoch, refused); throw new Error(`${refused}. The claim was released as a workspace failure, so the attempt costs nothing.`); }
        startPoint = remoteBranch;
      }
      // GY-860: an earlier attempt's hold is recorded with the reservation and released; the branch never moves.
      const now = Date.parse(status.now ?? '') || Date.now();
      const released = await reserveReleasingHold(root, branch, path, runChild, mutate, epoch, context.individualHostId(), work, now);
      await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
      const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
      // GY-1078: a mid-am or mid-bisect session worktree the release leaves is reclaimed; failures carry git's stderr.
      let reclaimed: ReclaimedHolder[] = [];
      try {
        if (exists) reclaimed = reclaimBranchHolders(root, branch, path, work, now, { checkouts: !!work.submission });
        for (const entry of reclaimed) console.error(`Reclaimed ${entry.path}, which held ${branch}${entry.epoch !== null ? ` for ${entry.key} epoch ${entry.epoch}` : ''}: ${entry.action}`);
        if (!released?.reused) gitOrThrow(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startPoint]);
        if (work.submission) gitOrThrow(['-C', path, 'reset', '--hard', startPoint]);
      }
      catch (error) { await workspaceFailure(mutate, epoch, error); } // GY-860: the host failed, not the attempt
      // A checkout whose lockfile the reachable install does not match gets its own install now,
      // so the session never starts on the wrong dependency versions. The lease is kept alive
      // while npm runs; the session's supervisor takes over heartbeats once it starts. A refused
      // heartbeat means this epoch is no longer held: npm is stopped there and the command fails
      // rather than reporting a worktree ready for work nobody may do.
      const dependencies = await installUnderLease(path, () => mutate('heartbeat', { epoch }), `${work.key} epoch ${epoch}`);
      return print({ path, branch, epoch, dependencies, ...(reclaimed.length ? { reclaimed } : {}) });
    },
  },
  {
    name: 'watch',
    help: ['  watch GY-N EPOCH -- COMMAND   Run a worker, heartbeat, stop on lease loss'],
    // Not work-scoped (GY-1033): the setup line comes from argv before any control-plane call, even the item lookup.
    async run(context) {
      const { id, args, api, base } = context; const epoch = Number(args[0]); const separator = args.indexOf('--');
      if (!id || separator < 0 || !args[separator + 1]) throw new Error('Usage: watch GY-N EPOCH -- command args');
      console.error(setupLine(id, epoch));
      const work = (await api('work')).find((w: any) => w.id === id || w.key === id); if (!work) throw new Error(`Unknown work item ${id}`);
      const workspace = work.workspaces.find((w: any) => w.epoch === epoch); const hostId = context.individualHostId();
      if (!workspace || workspace.host !== hostId || await realpath(process.cwd()) !== await realpath(workspace.path)) throw new Error('Run watch from the assigned workspace on its registered host');
      const workerStatus = await api('status'); if (workerStatus.actor?.role !== 'worker') throw new Error('watch requires a worker credential; never pass operator or producer credentials to implementation processes');
      const watchToken = await context.individualToken();
      process.env.GRAPHYARD_URL = base; process.env.GRAPHYARD_TOKEN = watchToken;
      process.env.GRAPHYARD_CLI = await context.activeCliPath(); process.env.GRAPHYARD_HOST_ID = hostId;
      const foreground = !!(process.env.HERDR_ENV === '1' && process.env.GRAPHYARD_HERDR_AGENT_KIND);
      // This random capability remains only in the supervisor process. It is never
      // placed in the child environment, request history, or quarantine document.
      const containment = foreground ? containmentCredentials() : null;
      const exclusiveResources = [...(work.exclusiveResources ?? [])];
      const settlementRequestId = foreground ? randomUUID() : '';
      const launchRequestId = foreground ? randomUUID() : '';
      // The scope is created here rather than inside the supervisor so its exact unit name and
      // this supervisor's pid are recorded on the quarantine: settlement later holds everything
      // that unit still contains and can tell it from a neighbouring assignment's scope.
      const scoped = foreground && process.platform === 'linux' ? systemdContainment(args[separator + 1], args.slice(separator + 2)) : null;
      const unit = scoped?.args.find(arg => arg.startsWith('--unit='))?.slice('--unit='.length);
      const scope = unit ? { unit, pid: process.pid } : undefined;
      // `complete` ends the lease, so the renewal after a submission is refused by design: say
      // so before the supervisor stops the session, so the stop reads as the end of the attempt
      // rather than as a lost assignment.
      const renew = async () => {
        try { return await api(`work/${work.id}/heartbeat`, { epoch }, randomUUID()); }
        catch (error) {
          if (error instanceof Error && error.message.includes('ended when') && error.message.includes('was submitted')) console.error(`${work.key} epoch ${epoch} was submitted; its implementation lease has ended and the worker session is being stopped.`);
          throw error;
        }
      };
      // The session's own push credential (GY-999), when the launcher minted one for this attempt:
      // refreshed after each renewal before GitHub's expiry, and withdrawn when the session ends.
      const mintPush = () => api(`work/${work.id}/push-credential`, { epoch }, randomUUID()) as Promise<MintedPushCredential>;
      process.exitCode = await superviseSessionCredential(process.env.GH_CONFIG_DIR, work.key, epoch, mintPush, refresh =>
        supervise(args[separator + 1], args.slice(separator + 2), epoch, async () => { const renewed = await renew(); await refresh(); return renewed; }, {
          detached: !foreground,
          ...(scoped ? { containment: scoped } : {}),
          quarantine: foreground ? {
            // The quarantine records the exact scope unit and supervisor pid the session is
            // launched in, and launch is refused unless the confirmed record names them.
            establish: () => establishContainment(
              requestId => api(`work/${work.id}/quarantine`, { epoch, settlementHash: containment!.settlementHash, ...(scope ? { scope } : {}) }, requestId),
              { epoch, settlementHash: containment!.settlementHash, exclusiveResources, requestId: containment!.requestId, ...(scope ? { scope } : {}) },
            ),
            revalidate: async () => revalidateContainment(await api('work-snapshot?view=coordination'), {
              workId: work.id, principal: workerStatus.actor.id, epoch, settlementHash: containment!.settlementHash,
              exclusiveResources, workspace,
            }),
            acknowledge: () => acknowledgeContainment(
              requestId => api(`work/${work.id}/launch`, { epoch, settlementHash: containment!.settlementHash }, requestId),
              { principal: workerStatus.actor.id, epoch, settlementHash: containment!.settlementHash, exclusiveResources, requestId: launchRequestId },
            ),
            settle: () => settleContainment(
              (requestId, body) => api(`work/${work.id}/settle`, body, requestId),
              { epoch, settlementToken: containment!.settlementToken, settlementHash: containment!.settlementHash, exclusiveResources, requestId: settlementRequestId },
            ), report: failure => api(`work/${work.id}/request`, containmentFailureNote(epoch, failure), randomUUID()), // a fence it cannot lower goes on the record
          } : undefined,
        }));
    },
  },
]);
