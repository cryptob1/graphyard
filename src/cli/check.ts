import { execFileSync } from 'node:child_process';
import { resolveWork, type CliContext } from './context.js';
import type { CliCommand } from './registry.js';
import type { WorkerCheckResult } from '../merge-writer/worker-check.js';

/** GY-3283: the host runs the declared check on this exact committed HEAD; the worker never needs Docker. */
export async function requestWorkerCheck(context: Pick<CliContext, 'api' | 'repositoryRoot'>, work: any, check: string): Promise<WorkerCheckResult> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: context.repositoryRoot(), encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit the working tree first: the check runs on exact HEAD');
  return context.api(`work/${work.id}/worker-verification`, { mode: 'check', check, head: git('rev-parse', 'HEAD'), epoch: work.lease?.epoch });
}

/** The item of an assigned `graphyard/<key>-<epoch>` branch. */
const branchItem = (root: string) => {
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const key = /^graphyard\/([a-z]+-\d+)-\d+$/i.exec(branch)?.[1];
  if (!key) throw new Error(`Name the item: graphyard check NAME GY-N (branch ${branch || '(detached)'} names none)`);
  return key.toUpperCase();
};

export const checkCommand: CliCommand = {
  name: 'check',
  help: [
    '  check NAME [GY-N]             Run the declared pre-merge check NAME on committed HEAD on the',
    '                                host, with its Compose services, as the merge trial runs it;',
    '                                prints its output and exits 1 when it fails. GY-N defaults to',
    '                                the item of the assigned graphyard/<key>-<epoch> branch',
  ],
  run: async context => {
    if (!context.id) throw new Error('Usage: graphyard check NAME [GY-N]');
    const work = await resolveWork(context.api, context.args[0] ?? branchItem(context.repositoryRoot()));
    const result = await requestWorkerCheck(context, work, context.id);
    console.log(result.output.trimEnd());
    console.log(`check ${result.check} ${result.passed ? 'passed' : 'failed'} on ${result.head.slice(0, 12)}`);
    if (!result.passed) process.exitCode = 1;
  },
};
