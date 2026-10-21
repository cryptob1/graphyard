import { spawnSync } from 'node:child_process';
import { defaultChildRun } from '../child-runner.js';
import { postReview, ReviewPostRefusal, reviewPostExample } from '../review-post.js';
import { reviewStandard } from '../reviewer.js';
import { readVerificationMaps } from '../verification-maps.js';
import { cliPath, resolveWork, type CliContext } from './context.js';
import { defineCommands } from './registry.js';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** How `review self` reads the worktree's git: output captured, failures named with the command. */
const selfGit = (...args: string[]) => {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`);
  return result.stdout.trim();
};

/**
 * `review self` (GY-1987): the worker judges its own diff by the standard the independent reviewer
 * will apply, before it submits. It reads the item through the worker's connection, as `status`
 * does (criteria, plannedFiles, documentation obligation, base branch), takes head as this
 * worktree's HEAD and base as the merge-base with origin/BASE, and prints reviewStandard for that
 * diff. It runs no model, posts nothing and records nothing: both reads are GETs, and the command
 * always exits 0.
 */
async function reviewSelf({ api, args }: CliContext) {
  const work = await resolveWork(api, args[0]);
  const status = await api('status');
  const baseBranch = String(status.baseBranch ?? 'main');
  const head = selfGit('rev-parse', 'HEAD');
  const base = selfGit('merge-base', 'HEAD', `refs/remotes/origin/${baseBranch}`);
  const maps = await readVerificationMaps(process.cwd(), baseBranch, defaultChildRun).catch(() => []);
  const standard = reviewStandard({ key: work.key, head, base }, work.criteria, work.documentation ? { obligation: work.documentation, files: null } : undefined, { maps, plannedFiles: work.plannedFiles ?? [] });
  console.log('Judge your own diff exactly as the independent reviewer will; fix every finding you would mark BLOCKING before you run complete.');
  console.log(standard);
}

/**
 * `review post` (GY-1492): the reviewer session posts its verdict through Graphyard, which checks
 * the launch's review binding and the bound head first. It never reads the repository connection
 * file: a reviewer holds no Graphyard credential. The binding carries a one-time verdict token
 * (GY-1525), and the verdict goes to `POST /api/work/:id/review-verdict` at GRAPHYARD_URL as that token.
 * `review self` (GY-1987) is the worker's own read: it uses the worker's connection, never a
 * binding, and never writes.
 */
export const reviewCommands = defineCommands([{
  name: 'review',
  readsConnection: id => id === 'self',
  help: [
    '  review self GY-N              Worker only: print the standard the independent reviewer will',
    '                                judge this worktree\'s HEAD by (its diff against the merge-base',
    '                                with the item\'s base branch), so the worker fixes every',
    '                                BLOCKING finding before complete',
    '  review post --event APPROVE|REQUEST_CHANGES|COMMENT [--body TEXT]',
    '                                Reviewer session only: post its one verdict on the bound head',
    '                                (body from stdin without --body) after checking the head; the',
    '                                verdict goes to the control plane',
  ],
  async run(context) {
    const { id, args, print } = context;
    if (id === 'self') return reviewSelf(context);
    if (id !== 'post') throw new Error(`Use review self GY-N, or review post --event APPROVE|REQUEST_CHANGES|COMMENT [--body TEXT], like this:\n${reviewPostExample(cliPath, 'APPROVE')}`);
    const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    const body = args.includes('--body') ? flag('--body') ?? '' : await readStdin();
    try { print(await postReview({ event: flag('--event'), body, cliPath, environment: process.env }, { run: defaultChildRun, fetch })); }
    catch (error) { if (error instanceof ReviewPostRefusal) { console.error(error.message); process.exitCode = 1; return; } throw error; }
  },
}]);
