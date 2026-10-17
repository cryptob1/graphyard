import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import {
  assessPromotion, assessUatDeploy, candidateTagPrefix, gitIn, readLedger, recordUatCancelled, uatValidationWindowMs, writeRecord,
  type Ledger, type ReleaseCandidate, type UatRecord,
} from '../src/release-candidate.js';

// GY-1965: a uat job cancelled before its suites recorded a verdict records `cancelled`, which
// concludes the validation (the next candidate deploys at once) and never promotes.

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const now = new Date(1_800_000_000_000);
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const sha = (digit: string) => digit.repeat(40);
const candidate = (id: string, digit: string, cutMinutesAgo: number): ReleaseCandidate => ({ id, sha: sha(digit), cutAt: minutesAgo(cutMinutesAgo), trigger: 'schedule', since: null, items: [] });
const ledger = (candidates: ReleaseCandidate[], uat: UatRecord[] = []): Ledger => ({ candidates, uat, production: [], soak: [], deployments: [], deployed: [] });
const cancelled = (entry: ReleaseCandidate): UatRecord => ({ id: entry.id, sha: entry.sha, result: 'cancelled', deployedSha: null, at: now.toISOString(), suites: [], followUp: null });

test('unit:release-uat-cancelled-verdict-frees-uat — a cancelled verdict concludes the served candidate, so the next deploys at once; it never promotes; the workflow records it in an always() step', async () => {
  const served = candidate('20261017T203853Z', 'a', 50), next = candidate('20261017T213444Z', 'b', 5);
  assert.equal(assessUatDeploy(next, ledger([next, served]), served.sha, now).deploy, false, 'without a verdict the served candidate is a validation in progress');
  const freed = assessUatDeploy(next, ledger([next, served], [cancelled(served)]), served.sha, now);
  assert.deepEqual(freed, { deploy: true, expected: served.sha }, 'a cancelled verdict concludes it: the next candidate deploys, leased on the observed tip');

  const promotion = assessPromotion(served, cancelled(served), null);
  assert.equal(promotion.promotable, false, 'a cancelled verdict never promotes');
  assert.match(promotion.refusals.join('\n'), /was cancelled before it recorded a verdict/);

  // The always() step on a real ledger: records cancelled when no verdict exists, keeps one that does.
  const root = await temporaryDirectory('release-uat-cancelled');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  run(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run(work, 'config', key, value);
  run(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  run(work, 'push', '-q', 'origin', 'HEAD:main');
  const git = gitIn(work), head = run(work, 'rev-parse', 'HEAD');
  const cut = { ...served, sha: head };
  writeRecord(git, `${candidateTagPrefix}${cut.id}`, head, cut, true);
  const first = recordUatCancelled(git, cut.id, { base: 'main', now, push: true });
  assert.equal(first.recorded, true);
  assert.equal(run(origin, 'tag', '--list', `rc-uat/${cut.id}`), `rc-uat/${cut.id}`, 'the cancelled verdict is published as rc-uat/ID');
  assert.deepEqual(readLedger(git).uat.map(record => [record.id, record.result, record.deployedSha]), [[cut.id, 'cancelled', null]]);
  const again = recordUatCancelled(git, cut.id, { base: 'main', now, push: true });
  assert.equal(again.recorded, false, 'a candidate that already has a verdict keeps it');

  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const uatJob = workflow.slice(workflow.indexOf('\n  uat:\n'), workflow.indexOf('\n  imports:\n'));
  const step = /- name: Record a cancelled verdict[^\n]*\n(?: {8}#[^\n]*\n)*\s+if: \$\{\{ always\(\) \}\}\n\s+run: node bin\/graphyard\.mjs release uat-cancelled "\$\{\{ needs\.candidate\.outputs\.id \}\}"/.exec(uatJob);
  assert.ok(step, 'the uat job records a cancelled verdict in an always() step');
  assert.ok(uatJob.indexOf(step[0]) > uatJob.indexOf('release validate'), 'after the step that records the suites\' verdict');
});

test('unit:release-uat-in-progress-still-refused — a validation still running (no verdict, within the window) is refused; past the window or with any verdict it is not; only a passing verdict on the served SHA promotes', () => {
  const served = candidate('20261017T203853Z', 'a', 50), next = candidate('20261017T213444Z', 'b', 5);
  const refused = assessUatDeploy(next, ledger([next, served]), served.sha, now);
  assert.equal(refused.deploy, false);
  assert.match(refused.deploy ? '' : refused.refusal, /whose validation has no verdict yet/);
  const abandoned = candidate(served.id, 'a', uatValidationWindowMs / 60_000 + 1);
  assert.equal(assessUatDeploy(next, ledger([next, abandoned]), served.sha, now).deploy, true, 'past the window an abandoned validation no longer holds UAT');

  const failed: UatRecord = { ...cancelled(served), result: 'failed', deployedSha: served.sha, suites: [{ name: 'api', passed: false, detail: 'boom' }] };
  const passed: UatRecord = { ...cancelled(served), result: 'passed', deployedSha: served.sha, suites: [{ name: 'api', passed: true, detail: 'ok' }] };
  assert.equal(assessPromotion(served, failed, null).promotable, false);
  assert.equal(assessPromotion(served, { ...passed, deployedSha: sha('c') }, null).promotable, false, 'a pass on another served SHA does not promote');
  assert.equal(assessPromotion(served, passed, null).promotable, true, 'only a passing verdict on the served SHA promotes');
});
