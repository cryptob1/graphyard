// Resolve one review thread the master has already audited. This wrapper exists so the master's
// harness allowlist can permit thread resolution without permitting arbitrary GitHub API calls:
// it sends only resolveReviewThread, so it can never merge, change protection, or read a secret.
import { execFileSync } from 'node:child_process';

const [thread, ...rest] = process.argv.slice(2);
if (!thread || rest.length || !/^[A-Za-z0-9_=-]{8,200}$/.test(thread)) {
  console.error('Usage: node scripts/resolve-thread.mjs REVIEW_THREAD_NODE_ID\nFind the id with: gh api graphql -f query=\'{repository(owner:"OWNER",name:"NAME"){pullRequest(number:N){reviewThreads(first:50){nodes{id isResolved path}}}}}\'');
  process.exit(2);
}
const query = 'mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}';
try {
  const result = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `thread=${thread}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const resolved = result?.data?.resolveReviewThread?.thread;
  if (!resolved?.isResolved) throw new Error('GitHub did not report the thread as resolved');
  console.log(JSON.stringify({ thread: resolved.id, resolved: true }, null, 2));
} catch (error) {
  console.error(`Could not resolve review thread ${thread}: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
  process.exit(1);
}
