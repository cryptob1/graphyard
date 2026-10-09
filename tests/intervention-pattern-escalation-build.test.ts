import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerView, classifyBlocker, environmentalBlockerClasses, needsSomeone } from '../src/model/blocker-class.js';
import { githubDegraded, githubStatusMs, probeBlocker, sharedGithubStatus } from '../src/daemon/blocker-probes.js';
import { readFileSync } from 'node:fs';
import { uncoveredBlockerPaths } from '../src/model/blocker-class.js';
import { branchRewriteGuidance, workerPrompt } from '../src/master.js';
import { loopUnitName } from '../src/supervisor.js';
import { docsHeadroom, docsTrimItem, docsTrimLatitude, docsWordBudgetOf } from '../src/model/documentation.js';
import { workerPushPermissions } from '../src/worker-credential.js';
import { foldInterventions, type InterventionLedgerRow } from '../src/interventions.js';
import type { Work } from '../src/model.js';

// GY-1406 names this file for its proof: manual:intervention-pattern-escalation-build. Four
// escalation interventions were needed at the build stage between 2026-09-30 and 2026-10-07, each a
// worker's `blocked` report a coordinator cleared by hand. Each, judged from the blocker it recorded:
//
//   - GY-1399 (blocked#2336178, blocked#2337564): `systemctl --user show-environment` failed with
//     "Failed to connect to user scope bus" inside the worker's sandbox, which masks the user bus.
//     The worker read that as the host's state and asked an operator to bring the user manager up;
//     the master cleared it by running the same probe on the host, where it answered. The blocker
//     was `genuine`, so nothing re-checked it. It is now the environmental class `host-supervisor`:
//     the loop, which runs on the host, probes the user manager and its own unit every cycle and
//     clears the blocker once both answer. A cleared blocker is no intervention.
//   - GY-1292 (blocked#2335919): the docs-trim item's criterion demanded both its word target and
//     full retention, so the worker asked for the operator's answer to be applied to AC-1. Removed by
//     GY-1366 (7bffc6d36b, after GY-1292 was filed): the item the loop files carries that latitude.
//   - GY-417 (blocked#1115774): a base sync carrying a workflow change was refused for want of
//     `workflows` permission. Removed by GY-1100: every worker push credential asks for workflows: write.

const blocked = {
  'GY-1399-2337564': 'Host operator act needed; code complete at PR #861 head 1fc16433bcc7 (only change this epoch: the reviewer\'s wording nit in src/daemon/upgrade.ts; graphyard verify GY-1399 passes both proofs, typecheck clean). The reviewer\'s only BLOCKING grounds are AC-1/AC-2 host outcomes. Blocked command: systemctl --user show-environment -> \'Failed to connect to user scope bus via local transport: Connection refused\' (worker bwrap masks /run/user/1000/bus and unshares PIDs, checkout is read-only, so no worker can see or stop the loop). Needed from an unsandboxed host session on vishrog (master or operator): (1) loginctl enable-linger vish (or start user@1000.service) so the user manager answers; (2) stop the stray hand-started \'node bin/graphyard.mjs master run\' still loading a4ce5261cf7f; (3) systemctl --user enable --now graphyard-master (examples/master/graphyard-master.service) so the loop runs at the checkout HEAD; then master status shows the loaded revision = HEAD and the loop-liveness attention clears. After that, resubmit PR #861 unchanged for review. Resubmitting before the host step only repeats CHANGES_REQUESTED (epochs 2-3).',
  'GY-1399-2336178': 'Host operator action needed; the code is complete. PR #861 at 6da753ac4a53: graphyard-reviewer[bot] found no remaining code defect (both earlier BLOCKING findings fixed, threads resolved). AC-1 and AC-2 are host outcomes a diff cannot deliver. Blocked command: systemctl --user show-environment fails with \'Failed to connect to user scope bus via local transport: Connection refused\'. It fails from this worker sandbox and from the running loop itself (the board\'s \'master loop is not supervised on this host\' setup attention). The loop on vishrog still loads a4ce5261cf7f, which predates this PR\'s unsupervised re-exec, so it cannot reload itself (master status: more than one delivery behind e8a3de4e9a20). The worker\'s PID namespace hides that process, so no agent identity here can stop it. Operator on vishrog: (1) bring up the user manager so the probe answers: loginctl enable-linger vish (as root if needed), or start user@1000. (2) Stop the hand-started \'node bin/graphyard.mjs master run\' on a4ce5261. (3) systemctl --user enable --now graphyard-master (the unit is already in ~/.config/systemd/user). (4) Confirm master status shows the loop at the checkout HEAD. AC-2 is then observable on the next verified delivery, and this PR\'s re-exec covers any later loss of the user manager.',
  'GY-1292-2335919': 'AC-1\'s 11,400-word limit cannot be met without dropping documented facts, and the human already chose to revise the limit. The decision on record for GY-1292 (goals-and-priorities) says: \'Accept the trimmed set: revise AC-1\'s 11,400 limit or raise the 12,000 budget\' [approved by production-operator-admin]. AC-1 still reads \'at most 11400 words\'. PR #859 head 7a1c1b2fab trims README.md+docs/ from 17,760 to 13,183 words and keeps every documented behaviour, command, configuration and API: the reviewer\'s base-vs-head identifier diff (backticked tokens, [A-Z_]{4,} names, --flags) now leaves 0 of the 257 previously dropped identifiers missing. It also keeps every sentence the docs-text tests pin exactly and the How Graphyard works/glossary structure the browser suite checks; those 7 browser tests pass. A worker cannot revise criteria. Needed: the master applies the human\'s decision with \'graphyard master requirements GY-1292 FILE\', setting AC-1\'s limit to the fact-preserving total (e.g. at most 13,200 words, with every documented behaviour, command, configuration and API kept); a further trim belongs in a follow-up item. Then the item can be resubmitted on this head.',
  'GY-417-1115774': 'Base sync cannot be pushed: \'git push origin graphyard/gy-417-1\' was rejected with \'refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission\'. The PR conflicts with main 44118686 (docs/master-agent-sessions.md); the resolved merge b982e2af4f (local branch graphyard/gy-417-1, worktree GY-417-57; tsc clean, full soak 14/14, runtime-screens and docs-budget pass) necessarily carries main\'s ci.yml change (GRAPHYARD_TIMING_SLACK). Needs a push with workflows permission (grant the worker App \'workflows: write\' or push b982e2af4f with a credential that has it).',
} as const;

const host = (failing: string | null) => {
  const ran: string[] = [];
  return { ran, run: (command: string, args: string[], options: { cwd: string }) => {
    ran.push(`${options.cwd}: ${command} ${args.join(' ')}`);
    if (failing && args.includes(failing)) throw Object.assign(new Error('exit 1'), { stderr: failing === 'show-environment' ? 'Failed to connect to user scope bus via local transport: Connection refused' : 'inactive' });
    return '';
  } };
};
const item = (key: string, blocker: string) => ({ id: `work-${key}`, key, blocker, humanRequest: null, blockerProbe: null, lease: null, workspaces: [] }) as unknown as Work;

for (const instance of ['GY-1399-2336178', 'GY-1399-2337564'] as const) {
  test(`manual:intervention-pattern-escalation-build — ${instance}: a user-bus failure inside the sandbox is host-supervisor, which the loop probes on the host and clears`, async () => {
    const classification = classifyBlocker(blocked[instance]);
    assert.equal(classification.class, 'host-supervisor');
    assert.ok(environmentalBlockerClasses.includes('host-supervisor'));
    assert.equal(needsSomeone(classification.class), false);
    assert.equal(blockerView(item('GY-1399', blocked[instance]))!.needsSomeone, false, 'the board does not ask anyone for it');

    // The probe runs on the loop's host, never inside a worker confinement, even when a launch is given.
    const answering = host(null);
    const pass = await probeBlocker(item('GY-1399', blocked[instance]), classification, { run: answering.run, launch: { kind: 'claude', args: [], confinement: ['bwrap', '--ro-bind', '/', '/'] }, cwd: '/srv/coordinator', clock: Date.now() });
    assert.equal(pass?.passed, true);
    assert.deepEqual(answering.ran, ['/srv/coordinator: systemctl --user show-environment', `/srv/coordinator: systemctl --user is-active --quiet ${loopUnitName}`]);
    assert.match(pass!.detail, /the worker sandbox masks the user bus, not the host/);

    // The host's own fault still stands: an unreachable manager or a loop not under its unit fails the probe.
    for (const failing of ['show-environment', loopUnitName]) {
      const result = await probeBlocker(item('GY-1399', blocked[instance]), classification, { run: host(failing).run, launch: null, cwd: '/srv/coordinator', clock: Date.now() });
      assert.equal(result?.passed, false, failing);
    }
  });
}

test('manual:intervention-pattern-escalation-build — a blocker the loop clears on its probe is no escalation intervention', () => {
  const at = '2026-10-07T03:18:28.854Z', cleared = '2026-10-07T03:19:30.000Z';
  const rows: InterventionLedgerRow[] = [
    { seq: 1, workId: 'work-GY-1399', actor: 'graphyard-claude-1', kind: 'blocked', at, details: { reason: blocked['GY-1399-2336178'] }, work: { key: 'GY-1399', stage: 'build', blocker: blocked['GY-1399-2336178'] } },
    // blocker.cleared (the probe's pass) is not a row the fold reads: the loop did the job.
  ];
  const work = [{ ...item('GY-1399', ''), blocker: null, stage: 'build', title: 'GY-1399', updatedAt: cleared, scopeRequest: null, escalations: [], containmentQuarantine: null } as unknown as Work];
  const { interventions } = foldInterventions(rows, work, '2026-10-07T04:00:00.000Z');
  assert.deepEqual(interventions.filter(entry => entry.kind === 'escalation'), []);
});

test('manual:intervention-pattern-escalation-build — GY-1292: the docs-trim item carries the latitude it asked to have applied', () => {
  assert.equal(classifyBlocker(blocked['GY-1292-2335919']).class, 'genuine', 'a criterion revision is a coordinator\'s act; its cause is removed at the source');
  const budget = docsWordBudgetOf({ paths: ['docs/', 'README.md'], wordBudget: { total: 12_000, perPage: 1_200 } })!;
  const criterion = docsTrimItem(docsHeadroom({ 'docs/master-agent.md': 959, 'README.md': 10_753 }, budget), 'origin/main').criteria[0].text;
  assert.ok(criterion.endsWith(docsTrimLatitude));
  assert.doesNotMatch(criterion, /every behaviour, command, configuration and API documented before the change is still documented/);
});

test('manual:intervention-pattern-escalation-build — GY-417: worker push credentials carry workflows: write', () => {
  assert.match(blocked['GY-417-1115774'], /without workflows permission/);
  assert.equal(workerPushPermissions.workflows, 'write');
});

// GY-1567 names this file for the same proof. Nine more escalation interventions at the build stage
// between 2026-10-02 and 2026-10-09, each a worker's `blocked` report the master cleared by hand
// (tests/fixtures/gy-1567-escalations.json holds each blocker as the ledger row recorded it):
//
//   - GY-1519 (blocked#2410502): the runtime refused `git push` and `gh pr create` at its permission
//     prompt; a fresh launch pushed normally. Now `runtime-denial`: cleared once the attempt ends.
//   - GY-1519 (blocked#2398155): the worker's account reached its usage limit; another profile
//     resumed the kept work. Now `runtime-exhaustion`: cleared once a worker profile can take a launch.
//   - GY-1477 (blocked#2385228): the worker asked for a force-push and was told to fix forward. The
//     worker request now says that itself, and a refused force-push is no runtime fault.
//   - GY-1461 (blocked#2372384): GitHub rejected a push with its own Internal Server Error during its
//     incident; the loop read it as the Graphyard server's and handed it on. Now `github-outage`:
//     cleared once githubstatus.com reports delivery operational and the push path answers.
//   - GY-1292 (blocked#2345717, #2356429, #2359935): the same docs-trim item's limit chasing main,
//     removed at the source by GY-1366 as above: the trim item the loop files carries the latitude.
//   - GY-1272 (blocked#2259050): the scope blocker's prose (`GET /compare/:range`, `req/min`, `e.g`,
//     bare `sync.ts`) was read as files no widening could cover, so it never cleared after the
//     approver widened plannedFiles. Only repository paths count now.
//   - GY-1459 (blocked#2372121): a fixture only the operator's signed-in browser can record. It is
//     the one genuine instance left, so the build stage stays under 3 per 7 days.
const escalations = JSON.parse(readFileSync(new URL('./fixtures/gy-1567-escalations.json', import.meta.url), 'utf8')) as Record<string, string>;
const statusOf = (statuses: Record<string, string>) => (async () => new Response(JSON.stringify({ components: Object.entries(statuses).map(([name, status]) => ({ name, status })) }))) as unknown as typeof fetch;

test('manual:intervention-pattern-escalation-build — GY-1567: every instance but GY-1459 is a class the loop clears without anyone', () => {
  const expected: Record<string, string> = {
    'GY-1519-2410502': 'runtime-denial', 'GY-1519-2398155': 'runtime-exhaustion', 'GY-1461-2372384': 'github-outage', 'GY-1272-2259050': 'planned-file-scope',
    'GY-1477-2385228': 'genuine', 'GY-1459-2372121': 'genuine',
  };
  for (const [instance, blockerClass] of Object.entries(expected)) {
    assert.equal(classifyBlocker(escalations[instance]).class, blockerClass, instance);
    if (blockerClass !== 'genuine') {
      assert.ok(environmentalBlockerClasses.includes(blockerClass as never) || blockerClass === 'planned-file-scope', instance);
      assert.equal(blockerView(item(instance.slice(0, 7), escalations[instance]))!.needsSomeone, false, `${instance}: the board asks nobody`);
    }
  }
  // The GY-1292 three were the docs-trim item filed before GY-1366; the trim item now carries the latitude they asked for.
  for (const instance of ['GY-1292-2345717', 'GY-1292-2356429', 'GY-1292-2359935']) assert.match(escalations[instance], /AC-1's [\d,]+-word limit/, instance);
});

test('manual:intervention-pattern-escalation-build — GY-1519: a refused delivery push clears once the attempt has ended, a refused rewrite or other command does not', async () => {
  const text = escalations['GY-1519-2410502'];
  const classification = classifyBlocker(text);
  const live = { ...item('GY-1519', text), lease: { epoch: 8, owner: 'graphyard-claude-2', expiresAt: '2026-10-08T11:00:00.000Z' } } as unknown as Work;
  const during = await probeBlocker(live, classification, { run: () => '', launch: null, cwd: '/srv', clock: Date.parse('2026-10-08T10:30:00.000Z') });
  assert.equal(during?.passed, false);
  const after = await probeBlocker(item('GY-1519', text), classification, { run: () => '', launch: null, cwd: '/srv', clock: Date.parse('2026-10-08T10:30:00.000Z') });
  assert.equal(after?.passed, true);
  assert.match(after!.detail, /a fresh session/);
  // The force-push GY-1477 asked for and GY-1459's browser capture are refusals a fresh session meets again.
  assert.notEqual(classifyBlocker(escalations['GY-1477-2385228']).class, 'runtime-denial');
  assert.notEqual(classifyBlocker(escalations['GY-1459-2372121']).class, 'runtime-denial');
  assert.equal(classifyBlocker("Permission to use Bash with command git push --force origin HEAD has been denied.").class, 'genuine');
});

test('manual:intervention-pattern-escalation-build — GY-1477: the worker request says a pushed branch is fixed forward, never force-pushed', () => {
  const request = workerPrompt({ cliPath: '/srv/bin/graphyard.mjs' }, { key: 'GY-1477', title: 'scope' }, { principal: 'graphyard-claude-1' }, 1);
  assert.ok(request.includes(branchRewriteGuidance));
  assert.match(branchRewriteGuidance, /Never force-push[^.]*: [^.]*fix a pushed commit forward with a new commit and push normally/);
});

test("manual:intervention-pattern-escalation-build — GY-1461: GitHub's own server error is github-outage, probed on GitHub and the push path, not the Graphyard server", async () => {
  const text = escalations['GY-1461-2372384'];
  const classification = classifyBlocker(text);
  assert.equal(classification.class, 'github-outage');
  const ran: string[] = [];
  const run = (command: string, args: string[]) => { ran.push(`${command} ${args.join(' ')}`); return ''; };
  const incident = await probeBlocker(item('GY-1461', text), classification, { run, launch: null, cwd: '/srv', clock: Date.now(), githubStatus: async () => ['Git Operations (partial_outage)'] });
  assert.equal(incident?.passed, false);
  assert.match(incident!.detail, /Git Operations \(partial_outage\)/);
  assert.deepEqual(ran, [], 'nothing pushes while GitHub reports its incident');
  const resolved = await probeBlocker(item('GY-1461', text), classification, { run, launch: null, cwd: '/srv', clock: Date.now(), githubStatus: async () => [] });
  assert.equal(resolved?.passed, true);
  assert.match(ran[0], /git push --dry-run/);
  // The status page read: only the delivery components count, and an unreadable page is null, not a pass.
  assert.deepEqual(await githubDegraded(statusOf({ 'Git Operations': 'operational', 'API Requests': 'degraded_performance', 'Pull Requests': 'operational', Codespaces: 'major_outage' })), ['API Requests (degraded_performance)']);
  assert.deepEqual(await githubDegraded(statusOf({ 'Git Operations': 'operational', 'API Requests': 'operational', 'Pull Requests': 'operational' })), []);
  assert.equal(await githubDegraded((async () => { throw new Error('offline'); }) as unknown as typeof fetch), null);
  // The Graphyard server's own 500 stays control-plane-error.
  assert.equal(classifyBlocker('graphyard complete failed: HTTP 500 Internal Server Error from the server').class, 'control-plane-error');
  // Naming the status page is no incident: only the page reporting one is (review of GY-1567).
  assert.equal(classifyBlocker('complete failed with HTTP 500; githubstatus reports all operational').class, 'control-plane-error');
  assert.equal(classifyBlocker('git push hangs; githubstatus.com shows no incident').class, 'genuine');
  assert.equal(classifyBlocker('git push hangs; githubstatus.com reports an incident on Git Operations').class, 'github-outage');
});

test('manual:intervention-pattern-escalation-build — GY-1272: only repository paths count, so the widened plannedFiles clear the scope blocker', () => {
  const text = escalations['GY-1272-2259050'];
  const classification = classifyBlocker(text);
  assert.deepEqual(classification.paths, ['src/github.ts', 'tests/github-rate-budget.test.ts']);
  // Requirements decision 728d01a2 widened plannedFiles to these before the master cleared the blocker.
  const widened = ['src/daemon/faults.ts', 'src/master-status.ts', 'src/master/attention.ts', 'tests/resource-fault-recurrence.test.ts', 'tests/fault-classes.test.ts', 'docs/master-agent-reference.md', 'src/github.ts', 'tests/github-rate-budget.test.ts'];
  assert.deepEqual(uncoveredBlockerPaths({ plannedFiles: widened }, classification), []);
  // Directory scopes, root files and dotfiles still count.
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: docs/, tests/*, package.json and .gitignore for commit 1a2b3c4d').paths, ['docs/', 'tests/*', 'package.json', '.gitignore']);
});

test('manual:intervention-pattern-escalation-build — GY-1567 review: however many items stand on a GitHub incident, the status page is read at most once per minute', async () => {
  let reads = 0;
  const status = sharedGithubStatus(async () => { reads++; return ['Git Operations (major_outage)']; });
  const at = Date.parse('2026-10-09T05:00:00.000Z');
  const answers = await Promise.all(Array.from({ length: 40 }, () => status(at)));
  assert.equal(reads, 1, 'forty blocked items in one cycle share one read');
  assert.deepEqual(answers[39], ['Git Operations (major_outage)']);
  await status(at + githubStatusMs - 1);
  assert.equal(reads, 1, 'the next cycle inside the minute reuses it');
  await status(at + githubStatusMs);
  assert.equal(reads, 2, 'a minute later the page is read again');
  // A read that throws is an unreadable page, never a pass, and is not retried within the minute.
  const failing = sharedGithubStatus(async () => { reads++; throw new Error('offline'); });
  assert.equal(await failing(at), null);
  assert.equal(await failing(at + 1), null);
  assert.equal(reads, 3);
});

test('manual:intervention-pattern-escalation-build — GY-1567 review: a host quota is no runtime exhaustion, and a bare source file still counts when no full path stands beside it', () => {
  // tests/exhaustion-notice.test.ts already reads this prose as no provider's: neither is it the worker's runtime account.
  for (const text of ['The suite failed: tmp disk quota is exhausted (a known local issue)', 'write failed: Disk quota exceeded', 'cp: EDQUOT while copying fixtures; quota is exhausted'])
    assert.notEqual(classifyBlocker(text).class, 'runtime-exhaustion', text);
  for (const text of ["Worker session's usage limit was reached", 'The runtime account ran out of credits mid-verify', "The provider's quota was exhausted before the push"])
    assert.equal(classifyBlocker(text).class, 'runtime-exhaustion', text);
  // A bare root source file is a path when the blocker spells none with its directory; beside full paths it is shorthand.
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: index.ts for commit 8106499e9f').paths, ['index.ts']);
  assert.equal(classifyBlocker('SCOPE NEEDED: index.ts for commit 8106499e9f').class, 'planned-file-scope');
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: server.js and build.sh for commit 8106499e9f').paths, ['server.js', 'build.sh']);
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: src/github.ts (as sync.ts does, e.g. aheadBy) for commit 8106499e9f').paths, ['src/github.ts']);
});
