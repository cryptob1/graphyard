// Bind the App-owned gate without replacing the existing CI/review requirements.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const apply = process.argv.includes('--apply');
const repository = 'cryptob1/graphyard', checkName = 'Graphyard / merge';
try {
  let app;
  try { app = JSON.parse(await readFile(new URL('../.graphyard/github-app.json', import.meta.url), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!app?.appId) { console.log('Blocked: register and install the dedicated App before binding merge protection.'); process.exitCode = 1; }
  else {
    const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const current = JSON.parse(gh(['api', `repos/${repository}/branches/main/protection`]));
    const checks = [...(current.required_status_checks?.checks ?? [])].filter(c => c.context !== checkName);
    checks.push({ context: checkName, app_id: app.appId });
    console.log(JSON.stringify({ repository, branch: 'main', requiredChecks: checks, retainReviewRequirements: current.required_pull_request_reviews, apply }, null, 2));
    if (apply) {
      // Updating only the status-check subresource preserves reviewer/bypass settings.
      gh(['api', '--method', 'PATCH', `repos/${repository}/branches/main/protection/required_status_checks`, '--input', '-'], JSON.stringify({ strict: true, checks }));
      console.log('App-bound check required. Existing review and administrator protection retained.');
    }
  }
} catch { console.error('Could not inspect/update protection; no credentials were printed.'); process.exitCode = 1; }
