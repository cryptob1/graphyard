import { defaultChildRun } from '../child-runner.js';
import { postReview, ReviewPostRefusal, reviewPostExample } from '../review-post.js';
import { cliPath } from './context.js';
import { defineCommands } from './registry.js';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `review post` (GY-1492): the reviewer session posts its verdict through Graphyard, which checks
 * the launch's review binding, the pull request head, GitHub's mergeability recompute and the
 * closing thread lines first. It runs under the session's own GH_CONFIG_DIR credential and never
 * reads the repository connection file: a reviewer holds no Graphyard credential. In control-plane
 * mode (GY-1525) the binding carries a one-time verdict token instead, and the verdict goes to
 * `POST /api/work/:id/review-verdict` at GRAPHYARD_URL as that token; gh never runs.
 */
export const reviewCommands = defineCommands([{
  name: 'review',
  readsConnection: () => false,
  help: [
    '  review post --event APPROVE|REQUEST_CHANGES|COMMENT [--body TEXT]',
    '                                Reviewer session only: post its one verdict on the bound head',
    '                                (body from stdin without --body) after checking the head,',
    '                                mergeability and the Resolved/Follow-up/Overridden thread lines;',
    '                                in control-plane mode the verdict goes to the API, never gh',
  ],
  async run(context) {
    const { id, args, print } = context;
    if (id !== 'post') throw new Error(`Use review post --event APPROVE|REQUEST_CHANGES|COMMENT [--body TEXT], like this:\n${reviewPostExample(cliPath, 'APPROVE')}`);
    const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
    const body = args.includes('--body') ? flag('--body') ?? '' : await readStdin();
    try { print(await postReview({ event: flag('--event'), body, cliPath, environment: process.env }, { run: defaultChildRun, fetch })); }
    catch (error) { if (error instanceof ReviewPostRefusal) { console.error(error.message); process.exitCode = 1; return; } throw error; }
  },
}]);
