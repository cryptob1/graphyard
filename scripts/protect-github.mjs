// Bind the App-owned gate; native approval migration requires an explicit flag.
import { execFileSync } from 'node:child_process';
import { assertReviewServer } from './review-server.mjs';
import { readFile } from 'node:fs/promises';
const apply = process.argv.includes('--apply');
const agentReviews = process.argv.includes('--agent-reviews');
const repository = 'cryptob1/graphyard', checkName = 'Graphyard / merge';
try {
  let app = process.env.GRAPHYARD_APP_ID ? { appId: Number(process.env.GRAPHYARD_APP_ID) } : null;
  try { if (!app) app = JSON.parse(await readFile(new URL('../.graphyard/github-app.json', import.meta.url), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Number.isSafeInteger(app?.appId) || app.appId <= 0) { console.log('Blocked: register and install the dedicated App before binding merge protection.'); process.exitCode = 1; }
  else {
    const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const current = JSON.parse(gh(['api', `repos/${repository}/branches/main/protection`]));
    const checks = [...(current.required_status_checks?.checks ?? [])].filter(c => c.context !== checkName);
    checks.push({ context: checkName, app_id: app.appId });
    console.log(JSON.stringify({ repository, branch: 'main', requiredChecks: checks, retainReviewRequirements: !agentReviews, reviewRequirements: agentReviews ? { ...current.required_pull_request_reviews, required_approving_review_count: 0, require_last_push_approval: false } : current.required_pull_request_reviews, apply }, null, 2));
    if (apply) {
      if (agentReviews) {
        if (!process.env.GRAPHYARD_URL || !process.env.GRAPHYARD_TOKEN) throw new Error('Server connection required');
        const response = await fetch(`${process.env.GRAPHYARD_URL}/api/status`, { headers: { Authorization: `Bearer ${process.env.GRAPHYARD_TOKEN}` }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Live server verification failed');
        const status = await response.json();
        assertReviewServer(status, repository, app);
        if (!current.enforce_admins?.enabled) throw new Error('Administrator enforcement is required');
      }
      // Updating only the status-check subresource preserves reviewer/bypass settings.
      gh(['api', '--method', 'PATCH', `repos/${repository}/branches/main/protection/required_status_checks`, '--input', '-'], JSON.stringify({ strict: true, checks }));
      if (agentReviews) gh(['api', '--method', 'PATCH', `repos/${repository}/branches/main/protection/required_pull_request_reviews`, '--input', '-'], JSON.stringify({ required_approving_review_count: 0, require_last_push_approval: false }));
      console.log(agentReviews ? 'App-bound gate retained; native approval count is zero. Task review policies still apply.' : 'App-bound check required. Existing review and administrator protection retained.');
    }
  }
} catch { console.error('Could not inspect/update protection; no credentials were printed.'); process.exitCode = 1; }
