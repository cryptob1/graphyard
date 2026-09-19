import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { supervise } from '../supervisor.js';
import { localScopeFindings } from '../sync.js';
import { assertRepository, discover } from '../onboarding.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, revalidateContainment, settleContainment } from '../quarantine.js';
import { defineCommands, workMutation } from './registry.js';

/** Local worktrees and the supervised worker launch. */
export const workspaceCommands = defineCommands([
  {
    name: 'sync',
    scope: 'work',
    help: [
      '  sync GY-N                     Merge origin/BASE (never rebase) and list every file outside',
      '                                plannedFiles that no longer matches it; run before every push',
    ],
    async run({ api, print }, work) {
      // The canonical way to take the base branch: a merge keeps the worker's history and makes every
      // resolution visible, and the same classifier the control plane applies at complete runs here,
      // against the fetched tip, before anything is pushed.
      const baseBranch = String((await api('status')).baseBranch ?? 'main');
      const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
      const branch = git('symbolic-ref', '--short', 'HEAD');
      if (!work.workspaces.some((w: any) => w.branch === branch)) throw new Error(`Run sync from a workspace branch registered for ${work.key}; ${branch} is not one`);
      git('fetch', '--quiet', 'origin');
      const baseTip = git('rev-parse', `refs/remotes/origin/${baseBranch}`);
      const merge = spawnSync('git', ['merge', '--no-edit', `refs/remotes/origin/${baseBranch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (merge.status !== 0) {
        const conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        print({ key: work.key, base: `origin/${baseBranch}`, baseTip, merged: false, conflicts, detail: `${merge.stdout}${merge.stderr}`.trim(), plannedFiles: work.plannedFiles,
          next: `Resolve each conflict, then commit the merge and rerun sync ${work.key} before pushing. Files outside plannedFiles must match origin/${baseBranch} byte-for-byte: git checkout ${baseTip.slice(0, 12)} -- PATH restores one.` });
        process.exitCode = 1; return;
      }
      const raw = git('diff', '--raw', '-M', '-z', '--no-abbrev', baseTip, 'HEAD'), numstat = git('diff', '--numstat', '-M', '-z', baseTip, 'HEAD');
      const findings = localScopeFindings(work.plannedFiles ?? [], raw, numstat);
      const refused = findings.filter(finding => finding.refused);
      print({ key: work.key, base: `origin/${baseBranch}`, baseTip, head: git('rev-parse', 'HEAD'), merged: true, plannedFiles: work.plannedFiles, ok: !refused.length,
        files: findings, refused: refused.map(finding => `${finding.path}: ${finding.detail}`),
        next: refused.length ? `Restore each listed file to origin/${baseBranch} (git checkout ${baseTip.slice(0, 12)} -- PATH; for a rename, restore the original path), commit, and rerun sync ${work.key}. Do not push until it reports ok. Only an operator can widen plannedFiles, through an audited requirements revision.`
          : `Every file outside plannedFiles matches origin/${baseBranch}. Push, then complete ${work.key} EPOCH PR.` });
      if (refused.length) process.exitCode = 1;
    },
  },
  {
    name: 'worktree',
    scope: 'work',
    help: ['  worktree GY-N EPOCH [BASE]    Reserve and create a local isolated worktree'],
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
        execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteBranch}`], { stdio: ['ignore', 'ignore', 'inherit'] });
        const remoteSha = execFileSync('git', ['rev-parse', '--verify', remoteBranch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
        if (!work.candidate?.sha || remoteSha !== work.candidate.sha) throw new Error('Submitted PR branch changed; wait for Graphyard to observe its current head before creating the rework workspace');
        startPoint = remoteBranch;
      }
      const hostId = context.individualHostId();
      await mutate('workspace', { epoch, host: hostId, path, branch });
      await mkdir(resolve(root, '.graphyard/worktrees'), { recursive: true });
      const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
      try {
        if (work.submission && exists) {
          const records = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).split('\0\0');
          for (const record of records) {
            const fields = record.split('\0'); const priorPath = fields.find(field => field.startsWith('worktree '))?.slice(9);
            if (priorPath && fields.includes(`branch refs/heads/${branch}`)) execFileSync('git', ['-C', priorPath, 'checkout', '--detach', '--quiet'], { stdio: ['ignore', 'ignore', 'inherit'] });
          }
        }
        execFileSync('git', exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, startPoint], { stdio: ['ignore', 'ignore', 'inherit'] });
        if (work.submission) execFileSync('git', ['-C', path, 'reset', '--hard', startPoint], { stdio: ['ignore', 'ignore', 'inherit'] });
      }
      catch { throw new Error('Git worktree creation failed. Reservation remains for safety; inspect the event and repair locally. Do not reuse the branch for another task.'); }
      return print({ path, branch, epoch });
    },
  },
  {
    name: 'watch',
    scope: 'work',
    help: ['  watch GY-N EPOCH -- COMMAND   Run a worker, heartbeat, stop on lease loss'],
    async run(context, work) {
      const { args, api, base } = context;
      const epoch = Number(args[0]); const separator = args.indexOf('--');
      if (separator < 0 || !args[separator + 1]) throw new Error('Usage: watch GY-N EPOCH -- command args');
      const workspace = work.workspaces.find((w: any) => w.epoch === epoch);
      const hostId = context.individualHostId();
      if (!workspace || workspace.host !== hostId || await realpath(process.cwd()) !== await realpath(workspace.path)) throw new Error('Run watch from the assigned workspace on its registered host');
      const workerStatus = await api('status');
      if (workerStatus.actor?.role !== 'worker') throw new Error('watch requires a worker credential; never pass operator or producer credentials to implementation processes');
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
      process.exitCode = await supervise(args[separator + 1], args.slice(separator + 2), epoch,
        () => api(`work/${work.id}/heartbeat`, { epoch }, randomUUID()), {
          detached: !foreground,
          quarantine: foreground ? {
            establish: () => establishContainment(
              requestId => api(`work/${work.id}/quarantine`, { epoch, settlementHash: containment!.settlementHash }, requestId),
              { epoch, settlementHash: containment!.settlementHash, exclusiveResources, requestId: containment!.requestId },
            ),
            revalidate: async () => revalidateContainment(await api('work-snapshot'), {
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
            ),
          } : undefined,
        });
    },
  },
]);
