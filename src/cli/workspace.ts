import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { supervise } from '../supervisor.js';
import { assertRepository, discover } from '../onboarding.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, revalidateContainment, settleContainment } from '../quarantine.js';
import { defineCommands, workMutation } from './registry.js';

/** Local worktrees and the supervised worker launch. */
export const workspaceCommands = defineCommands([
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
