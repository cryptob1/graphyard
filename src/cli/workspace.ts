import { mkdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { supervise, systemdContainment } from '../supervisor.js';
import { assertRepository, discover } from '../onboarding.js';
import { acknowledgeContainment, containmentCredentials, establishContainment, revalidateContainment, settleContainment } from '../quarantine.js';
import { superviseSessionCredential, type MintedPushCredential } from '../worker-credential.js';
import { installUnderLease } from './install-under-lease.js';
import { defineCommands, workMutation } from './registry.js';
import { syncCommand } from './workspace-sync.js';

export { installUnderLease };

/** Local worktrees and the supervised worker launch. */
export const workspaceCommands = defineCommands([
  syncCommand,
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
      // A checkout whose lockfile the reachable install does not match gets its own install now,
      // so the session never starts on the wrong dependency versions. The lease is kept alive
      // while npm runs; the session's supervisor takes over heartbeats once it starts. A refused
      // heartbeat means this epoch is no longer held: npm is stopped there and the command fails
      // rather than reporting a worktree ready for work nobody may do.
      const dependencies = await installUnderLease(path, () => mutate('heartbeat', { epoch }), `${work.key} epoch ${epoch}`);
      return print({ path, branch, epoch, dependencies });
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
            ),
          } : undefined,
        }));
    },
  },
]);
