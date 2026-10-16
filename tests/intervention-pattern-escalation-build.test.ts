import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerView, classifyBlocker, environmentalBlockerClasses, itemBlockerClass, needsSomeone } from '../src/model/blocker-class.js';
import { assertDispatchable as candidateAssertDispatchable } from '../src/master.js';
import { githubDegraded, githubStatusMs, probeBlocker, sharedGithubStatus } from '../src/daemon/blocker-probes.js';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join } from 'node:path';
import { blockerStep, launchableProbe } from '../src/daemon/cycle-blockers.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { uncoveredBlockerPaths } from '../src/model/blocker-class.js';
import { branchRewriteGuidance, inspectProfileAccounts, masterConfigSchema, selectAccount, workerPrompt, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { loopUnitName } from '../src/supervisor.js';
import { docsHeadroom, docsTrimItem, docsTrimLatitude, docsWordBudgetOf } from '../src/model/documentation.js';
import { workerPushPermissions } from '../src/worker-credential.js';
import { foldInterventions, readInterventionLedger, type InterventionLedgerRow } from '../src/interventions.js';
import type { Principal, Work } from '../src/model.js';
import { createHmac, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { Store, save } from '../src/store.js';
import { recordBlockerProbe } from '../src/server/blocker-probe.js';
import { loopHeldBlocker } from '../src/model/loop-owned.js';
import { dispatchable } from '../src/coordination.js';
import { decisionPrecondition } from '../src/model/approval.js';
import { throughputOwnerItem } from '../src/throughput.js';
import { postDeployChecks } from '../src/master-verification.js';
import { server } from '../src/server.js';
import { importAt } from './helpers/base-tree.js';
import { recordLegacyMerger } from './helpers/legacy-merger.js';
// Time-bomb allowance (GY-1694): the 2026-10-07..09 instants are fixture clocks handed to foldInterventions, probeBlocker and sharedGithubStatus; Date.now() only clocks lease-less probes and anchors codex holds relative to itself.
// GY-1726's 2026-10-11..13 and 2026-10-18 instants are fixture clocks handed to postDeployChecks and their expected windows; its defer cases read the database clock; the report case projects its reading from Date.now() + 10 days, 4 days past the database-clocked criterion bound.

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
  // A bare root source file is a path when the blocker spells none with its directory.
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: index.ts for commit 8106499e9f').paths, ['index.ts']);
  assert.equal(classifyBlocker('SCOPE NEEDED: index.ts for commit 8106499e9f').class, 'planned-file-scope');
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: server.js and build.sh for commit 8106499e9f').paths, ['server.js', 'build.sh']);
});

test('manual:intervention-pattern-escalation-build — GY-1567 review: a usage limit counts only as the runtime\'s, a status page only when it reports an incident, and a requested root file is kept beside full paths', async () => {
  // A usage limit an outside-scope test quotes is no runtime account's; one beside its session or runtime is.
  for (const text of ['Outside scope: tests/billing.test.ts failed with "API usage limit was reached" from the stub', 'The fixture asserts that the usage limit was reached and the client retries'])
    assert.notEqual(classifyBlocker(text).class, 'runtime-exhaustion', text);
  for (const text of ['Claude hit its usage limit before the push', 'The usage limit was reached on the worker account', 'Codex session reached its usage limit mid-verify'])
    assert.equal(classifyBlocker(text).class, 'runtime-exhaustion', text);

  // A status page or GitHub denying or dating an incident is no outage; the Graphyard server's own 500 stays control-plane-error.
  for (const text of ['complete failed with HTTP 500; githubstatus.com reports no active incident', 'complete failed with HTTP 500; githubstatus.com showed an incident earlier today, now resolved', 'complete failed with HTTP 500; GitHub reports no incident'])
    assert.equal(classifyBlocker(text).class, 'control-plane-error', text);
  for (const text of ['gh pr create failed: GitHub returned HTTP 500', 'git push hangs; githubstatus.com is investigating degraded Git Operations'])
    assert.equal(classifyBlocker(text).class, 'github-outage', text);

  // An API-originated outage is probed on the API too: a push path that answers while pulls return 500 does not clear it.
  const classification = classifyBlocker('gh pr create failed: GitHub returned HTTP 500');
  const ran: string[] = [];
  const result = await probeBlocker(item('GY-1567', 'gh pr create failed: GitHub returned HTTP 500'), classification, { run: (command, args) => { ran.push(args.join(' ')); return ''; }, launch: null, cwd: '/srv', clock: Date.now(), githubStatus: async () => [] });
  assert.equal(result?.passed, true);
  assert.match(ran[0], /git push --dry-run[^]*&& gh api --silent 'repos\/\{owner\}\/\{repo\}\/pulls\?per_page=1'/);
  assert.match(result!.probe, /pull-request API read/);

  // Root source files a scope request names are kept beside full paths; a basename of one, or prose outside the request, is not.
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: src/a.ts and index.ts for commit 8106499e9f').paths, ['src/a.ts', 'index.ts']);
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: src/foo.ts and server.js for commit 8106499e9f').paths, ['src/foo.ts', 'server.js']);
  // A short root file is one too; one letter either side of a dot (`e.g`) is prose.
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: main.c for commit 8106499e9f').paths, ['main.c']);
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: a.ts for commit 8106499e9f').paths, ['a.ts']);
  assert.equal(classifyBlocker('SCOPE NEEDED: e.g a wider scope for commit 8106499e9f').class, 'genuine');
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: src/sync.ts (sync.ts reads aheadBy) for commit 8106499e9f').paths, ['src/sync.ts']);
  assert.deepEqual(classifyBlocker('SCOPE NEEDED: src/github.ts for commit 8106499e9f. The compares come from sync.ts and upgrade.ts too.').paths, ['src/github.ts']);
  assert.deepEqual(uncoveredBlockerPaths({ plannedFiles: ['src/a.ts'] }, classifyBlocker('SCOPE NEEDED: src/a.ts and index.ts for commit 8106499e9f')), ['index.ts'], 'the blocker stands until the root file is widened too');
});

test('manual:intervention-pattern-escalation-build — GY-1567 review: a spent runtime account clears only once dispatch would choose an account for a profile', async () => {
  // The probe reads the cycle's `credentials`, which the loop takes from inspectProfileAccounts, the
  // account health dispatch launches by. Each case below is checked against selectAccount itself.
  const directory = await temporaryDirectory('gy-1567-accounts');
  const credentialFile = join(directory, 'master.token'), now = Date.now(), hour = 3_600_000;
  const home = async (name: string, login: boolean, percent?: number) => {
    const path = join(directory, name); await mkdir(path, { recursive: true });
    if (login) await writeFile(join(path, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: `${name}-token`, refresh_token: 'r', id_token: 'i', account_id: 'a' } }), { mode: 0o600 });
    if (percent !== undefined) {
      const day = join(path, 'sessions/2026/10/09'); await mkdir(day, { recursive: true });
      const event = { timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: percent, window_minutes: 10080, resets_at: Math.floor((now + hour) / 1000) }, secondary: null, rate_limit_reached_type: null } } };
      await writeFile(join(day, 'rollout-2026-10-09T05-00-00-session.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: {} })}\n${JSON.stringify(event)}\n`);
    }
    return { name, kind: 'codex' as const, home: path };
  };
  const environments = [await home('codex-spent', true, 100), await home('codex-out', false), await home('codex-held', true, 10), await home('codex-ok', true, 10)];
  const hold = { at: new Date(now - hour).toISOString(), until: new Date(now + 2 * hour).toISOString(), resetsAt: null, reason: 'usage limit reached', role: 'worker', profile: 'one', work: 'GY-1519' };
  await writeFile(join(directory, 'master.environments.json'), JSON.stringify({ version: 1, environments: {}, skipped: [], selected: {}, exhausted: { 'codex-held': hold } }));
  const config = { environments, credentialFile, run: {} } as unknown as MasterConfig, probe = { now: () => now, cacheMs: 0 };
  const profile = (accounts: string[]) => ({ name: 'one', principal: 'worker-one', agentName: 'soak-worker-one', mode: 'launch', kind: 'codex', credentialFile: '/outside/one.token', agentArgs: [], approvals: 'auto', environment: {}, accounts }) as unknown as WorkerProfile;
  const judge = async (accounts: string[]) => {
    const worker = profile(accounts);
    const credentials = await inspectProfileAccounts(config, 'worker', [worker], { one: { available: true, reason: null as string | null } }, probe);
    const cycle = { config: { workers: [worker] }, credentials, agents: [], state: { profiles: {} }, clock: now, snapshot: { work: [] } } as unknown as Cycle;
    const dispatched = await selectAccount(config, 'worker', worker, probe).then(selected => selected.account?.name ?? 'own login', () => null);
    return { probe: launchableProbe(cycle, true), dispatched };
  };
  // An unconfigured account, a provider quota at its ceiling, a logged-out home and an observed hold each keep it standing.
  for (const [accounts, reason] of [[['codex-missing'], /codex-missing is not a configured agent environment/], [['codex-spent'], /codex-spent/], [['codex-out'], /codex-out/], [['codex-held'], /codex-held exhausted its quota mid-session/],
    [['codex-missing', 'codex-spent', 'codex-out', 'codex-held'], /No healthy agent account/]] as const) {
    const { probe: result, dispatched } = await judge([...accounts]);
    assert.equal(dispatched, null, `dispatch chooses no account among ${accounts.join(', ')}`);
    assert.equal(result.passed, false, `the blocker stands on ${accounts.join(', ')}`);
    assert.match(result.detail, reason);
  }
  // One account dispatch would choose clears it, naming that account.
  const { probe: cleared, dispatched } = await judge(['codex-spent', 'codex-held', 'codex-ok']);
  assert.equal(dispatched, 'codex-ok');
  assert.equal(cleared.passed, true);
  assert.equal(cleared.detail, 'profile one is launchable on codex-ok');
  assert.equal(cleared.probe, 'a worker profile can take a launch on an eligible account');
});

// GY-1726: four more escalations at the build stage between 2026-10-05 and 2026-10-12. Three
// (GY-1724, GY-1721, GY-1689) were post-deploy follow-ups dispatched before the reading they owe
// could exist, so the worker's only move was `blocked`, an escalation. GY-1700 asked for the test
// file a requirements decision's AC-0 was about to name; the loop refused the ask before the
// decision was approved, the approval was held until the attempt ended, and the refusal held the
// item until an operator cleared it by hand.
//
// Each instance is replayed below against the code it ran on and against the candidate, in one
// run: tests/helpers/base-tree.ts extracts a commit's src/ and imports it beside this checkout's.
// GY-1689 and GY-1700 reproduce on the change's base, 47220a5adbdc (the pull request's merge base).
// GY-1724 and GY-1721 were filed by releases older than that base: GY-1727 (6037889d68) and GY-1698
// (20a58c6a42) had since given their follow-ups the instant they wait for, so each reproduces on the
// commit before its fix, and the base and the candidate both file it held.
const base = '47220a5adbdc7486f362eda80d4f8eafee0face4';
// GY-1760's linked instances (GY-1750, GY-1696, GY-1674) are replayed against the bases this pull request is judged on:
// e642d302bd1d, the base its first review named, and f398a2a0b34d, the main tip an earlier head synced onto. Both predate
// the guard, so each shows the instance reproducing before the change and not after. GY-1689 and GY-1723 stay on their own `base`
// above: the candidate-side behaviour they contrast (the defer command, the ignored-redelivery reason) landed between the commits, so either newer base would not reproduce them.
const replayBases = ['e642d302bd1d367b9f56df53417bcf2143f6e285', 'f398a2a0b34dfb76b48205178601413067989731'];
// GY-1768's loop-held clear landed after GY-1760's guard, so its instances are also replayed against 4a22286618, the merge base of the current head: it carries the guard, not the clear.
const clearReplayBases = [...replayBases, '4a22286618406b0ac0394fa4c2481d90720e7963'];
const day = 86_400_000;
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'graphyard', role: 'coordinator', sessionKind: 'ai' };
let database: EmbeddedPostgres | undefined, port = 0;
const stores: { close(): Promise<void> }[] = [], servers: { close(): void; closeAllConnections(): void }[] = [];
after(async () => { for (const http of servers) { http.closeAllConnections(); http.close(); } for (const store of stores) await store.close(); if (database) await database.stop(); });
/** A fresh database on the file's one embedded Postgres, its schema made by the `Store` of the tree under test. */
async function databaseFor(name: string, Store: typeof import('../src/store.js').Store) {
  if (!database) {
    port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1726;
    database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('escalation-build'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
    await database.initialise(); await database.start();
  }
  await database.createDatabase(name);
  const store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/${name}`); await store.init(); await recordLegacyMerger(store); stores.push(store);
  return store;
}
/** The control-plane modules of one tree: the base's, extracted, or this checkout's own. */
async function plane(tree: string | null) {
  const load = async <T>(path: string, own: T): Promise<T> => tree ? importAt<T>(tree, path) : own;
  return {
    Engine: (await load('src/engine.ts', { Engine })).Engine, Store: (await load('src/store.ts', { Store })).Store,
    interventions: await load('src/interventions.ts', { foldInterventions, readInterventionLedger }), dispatchable: (await load('src/coordination.ts', { dispatchable })).dispatchable,
    server: (await load('src/server.ts', { server })).server, postDeployChecks: (await load('src/master-verification.ts', { postDeployChecks })).postDeployChecks,
    assertDispatchable: (await load('src/master/dispatch.ts', { assertDispatchable: candidateAssertDispatchable })).assertDispatchable,
  };
}
type Plane = Awaited<ReturnType<typeof plane>>;

/** GY-1689 as filed: a follow-up owing GY-1685 AC-1's rate reading on the serving release, with no window. */
const followUpCriterion = { id: 'AC-1', text: 'From this head against the serving release f1984c118352: the intervention report shows the escalation rate at the build stage below 3 per 7 days after the change ships', proofs: ['manual:intervention-pattern-escalation-build-on-serving-release'] };
/** GY-1689's worker found the reading could not exist for days: it defers where the tree has the command, else blocks as it did. */
async function replay1689(tree: string | null, name: string) {
  const { Engine, Store, interventions, dispatchable } = await plane(tree);
  const store = await databaseFor(name, Store);
  const engine = new Engine(store, [15368], 120, 'owner/escalation-build'); engine.submissionObserver = null;
  let work = await engine.execute(operator, 'create', null, { title: 'GY-1689 follow-up', type: 'chore', criteria: [followUpCriterion] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  const now = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime(), notBefore = new Date(now + 5 * day).toISOString();
  let refusal: string | null = null;
  try { work = await engine.execute(implementer, 'defer', work.id, { epoch: work.epoch, notBefore, reason: 'the 7-day window after the ship has not elapsed' }, randomUUID()); }
  catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
    work = await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason: 'The observation AC-1 requires cannot exist before 2026-10-17T14:31:37Z' }, randomUUID());
  }
  const folded = interventions.foldInterventions((await interventions.readInterventionLedger(store.pool, { workId: work.id })).rows, [work], new Date(now).toISOString()).interventions;
  return { refusal, work, notBefore, now, escalations: folded.filter((entry: { kind: string }) => entry.kind === 'escalation').length, dispatchable: (at: number) => dispatchable(work, at) as boolean };
}

test('manual:intervention-pattern-escalation-build — GY-1689 against the base and the candidate: the base can only block an unready reading, an escalation; the candidate defers it, holding dispatch until the instant, and escalates nothing', { timeout: 300_000 }, async () => {
  const onBase = await replay1689(base, 'gy1689_base');
  assert.equal(onBase.refusal, 'Unknown command', 'the base has no defer command');
  assert.ok(onBase.work.blocker, 'so the worker blocks');
  assert.equal(onBase.escalations, 1, 'and the blocker is an escalation: the instance reproduces');

  const onCandidate = await replay1689(null, 'gy1689_candidate'), deferred = onCandidate.work;
  assert.equal(onCandidate.refusal, null);
  assert.deepEqual([deferred.blocker, deferred.lease], [null, null], 'the attempt ends with no blocker');
  assert.deepEqual([deferred.observationWindow?.notBefore, deferred.observationWindow?.basis], [onCandidate.notBefore, 'worker-reading']);
  assert.equal(onCandidate.escalations, 0, 'nothing escalates: the instance does not recur');
  assert.equal(onCandidate.dispatchable(onCandidate.now), false, 'held until the reading can exist');
  assert.equal(onCandidate.dispatchable(onCandidate.now + 6 * day), true, 'the loop dispatches it once the instant passes');
});

/** A candidate engine for the defer bounds. */
async function candidateEngine() {
  const { Engine, Store } = await plane(null);
  const store = await databaseFor(`defer_${randomUUID().slice(0, 8)}`, Store);
  const engine = new Engine(store, [15368], 120, 'owner/escalation-build'); engine.submissionObserver = null;
  const now = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  const claimed = async (criteria: unknown[]) => {
    let work = await engine.execute(operator, 'create', null, { title: `Follow-up ${randomUUID().slice(0, 8)}`, type: 'chore', criteria }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    return engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  };
  return { engine, store, now, claimed };
}

test('manual:intervention-pattern-escalation-build — a later defer never shortens the window; defer is refused for work owing no post-deploy observation, for a past instant and past its 30-day bound', async () => {
  const { engine, store, now, claimed } = await candidateEngine();
  const work = await claimed([followUpCriterion]), notBefore = new Date(await now() + 5 * day).toISOString();
  await engine.execute(implementer, 'defer', work.id, { epoch: work.epoch, notBefore, reason: 'the window has not elapsed' }, randomUUID());
  // GY-1735: the deferred window holds the claim itself, not only the loop's dispatch.
  await assert.rejects(engine.execute(implementer, 'claim', work.id, {}, randomUUID()), /waits for its observation window/);
  // A window recorded while an attempt holds the item (a filing's, say) is never shortened by that attempt's defer.
  const again = await claimed([followUpCriterion]);
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{observationWindow}', $2::jsonb) WHERE id=$1`, [again.id, JSON.stringify({ notBefore, basis: 'criterion-window', detail: 'filed' })]);
  const shorter = await engine.execute(implementer, 'defer', again.id, { epoch: again.epoch, notBefore: new Date(await now() + day).toISOString(), reason: 'an earlier guess' }, randomUUID());
  assert.equal(shorter.observationWindow?.notBefore, notBefore);
  const ordinary = await claimed([{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }]);
  await assert.rejects(engine.execute(implementer, 'defer', ordinary.id, { epoch: ordinary.epoch, notBefore: new Date(await now() + day).toISOString(), reason: 'not a follow-up' }, randomUUID()), /owes no post-deploy observation/);
  const fresh = await claimed([followUpCriterion]);
  await assert.rejects(engine.execute(implementer, 'defer', fresh.id, { epoch: fresh.epoch, notBefore: new Date(await now() - day).toISOString(), reason: 'past' }, randomUUID()), /already passed/);
  await assert.rejects(engine.execute(implementer, 'defer', fresh.id, { epoch: fresh.epoch, notBefore: new Date(await now() + 31 * day).toISOString(), reason: 'far' }, randomUUID()), /more than 30 days/);
});

test('manual:intervention-pattern-escalation-build — GY-1689: a follow-up worker is told to defer an unready reading, not to block it', () => {
  const config = { root: '/repo', cliPath: '/repo/bin/graphyard.mjs', repository: 'owner/repo' } as unknown as MasterConfig;
  const profile = { name: 'claude-1', principal: 'graphyard-claude-1' } as unknown as WorkerProfile;
  const prompt = (criteria: Work['criteria']) => workerPrompt(config, { key: 'GY-1689', title: 'Post-deploy verification', criteria } as Work, profile, 2);
  assert.match(prompt([followUpCriterion]), /defer GY-1689 2 NOT-BEFORE REASON/);
  assert.doesNotMatch(prompt([{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }]), / defer GY-1689/);
});

/** A delivered item as master verify-deployment reads it. */
const deliveredItem = (key: string, criterion: Work['criteria'][number], mergedAt: string): Work => ({
  id: randomUUID(), key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [criterion], policy: { checks: ['test'], review: true }, plannedFiles: [],
  stage: 'done', revision: 1, policyRevision: 1, createdAt: mergedAt, updatedAt: mergedAt, stageEnteredAt: mergedAt, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
  submission: { epoch: 1, pr: 1 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
  delivery: { mergeSha: 'a'.repeat(40), mergedAt, evidenceAsOf: mergedAt, authorizationRevision: 1 } as never,
} as Work);
/** The window verify-deployment files a follow-up with, by the tree's own postDeployChecks: the release served from `servedAt`. */
const filedWindow = async (tree: string | null, item: Work, servedAt?: Date) =>
  ((await plane(tree)).postDeployChecks(item, 'b'.repeat(40), new Date('2026-10-12T07:35:00Z'), {}, servedAt) as { followUp?: { input: Work } | null }[])[0]?.followUp?.input.observationWindow?.notBefore ?? null;

test('manual:intervention-pattern-escalation-build — GY-1724 and GY-1721 against the code that filed them, the base and the candidate: filed with no window before GY-1727 and GY-1698, held on the instant the reading can first exist since', { timeout: 300_000 }, async () => {
  // GY-1724: GY-1700 AC-2, a 24-hour live window; its release first observed serving at 07:33:40Z.
  const webhooks = deliveredItem('GY-1700', { id: 'AC-2', text: 'A 24-hour window of live GitHub activity shows zero failed webhook deliveries', proofs: ['manual:post-deploy/webhook-deliveries-clean-24h'] }, '2026-10-11T15:04:40Z');
  const served = new Date('2026-10-12T07:33:40Z');
  // 395c76846f8d is 6037889d68's parent (GY-1727's change); 4c8f45576554 below is 20a58c6a42's (GY-1698's).
  assert.equal(await filedWindow('395c76846f8def6bdba317185f46ad1b6f513b69', webhooks, served), null, 'before GY-1727 the follow-up is filed unheld and dispatched at once: GY-1724 reproduces');
  for (const tree of [base, null]) assert.equal(await filedWindow(tree, webhooks, served), '2026-10-13T07:33:40.000Z', `${tree ?? 'the candidate'} files it held: it does not recur`);
  // GY-1721: GY-1684 AC-1, a rate per 7 days; merged at 07:43:35Z.
  const rate = deliveredItem('GY-1684', { id: 'AC-1', text: 'the intervention report shows the scope-widening rate at the build stage below 3 per 7 days after the change ships', proofs: ['manual:post-deploy/intervention-pattern-scope-widening-build'] }, '2026-10-11T07:43:35Z');
  assert.equal(await filedWindow('4c8f455765549576b0879d92473223cf28ba38f1', rate), null, 'before GY-1698 the follow-up is filed unheld: GY-1721 reproduces');
  for (const tree of [base, null]) assert.equal(await filedWindow(tree, rate), '2026-10-18T07:43:35.000Z', `${tree ?? 'the candidate'} files it held: it does not recur`);
});

/**
 * GY-1700 as recorded (scope#2507595, autoscope#2507600, decision.held#2507617, unblock#2507778): the
 * master requests a requirements decision adding AC-0, whose unit proof lives in a new test file; the
 * worker asks for that file; the loop refuses the ask on the criteria the item carries; the approver
 * approves the decision, which is held because the attempt is live. Returns the item after the hold.
 */
async function replay1700(tree: string | null, name: string) {
  const { Engine, Store, server: serve } = await plane(tree);
  const store = await databaseFor(name, Store);
  const repository = 'owner/escalation-build';
  const engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  const master = { id: 'gy1700-master', token: `gy1700-master-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'policy:requirements', 'decision:rework', 'intent:unblock'] };
  const approver = { id: 'graphyard-approver-graphyard', token: `gy1700-approver-${'a'.repeat(32)}`, capabilities: ['decision:approve', 'policy:requirements', 'decision:rework', 'intent:ready', 'intent:unblock'] };
  const admin = { ...operator, token: `gy1700-operator-${'o'.repeat(32)}` };
  const http = serve(engine, [admin]); servers.push(http);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const call = async (token: string, path: string, body: unknown, status = 200) => {
    const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const answer = await response.json() as any;
    assert.equal(response.status, status, JSON.stringify(answer));
    return answer;
  };
  for (const agent of [master, approver])
    await call(admin.token, 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'GY-1700 replay' });
  const plannedFiles = ['src/server/routes/github.ts', 'src/server/main.ts', 'docs/protocol/github-webhook.md'];
  const live = [{ id: 'AC-1', text: 'Every failed delivery is redelivered and answered 2xx', proofs: ['manual:webhook-failed-deliveries-replay-clean'] },
    { id: 'AC-2', text: 'A 24-hour window of live GitHub activity shows zero failed webhook deliveries', proofs: ['manual:webhook-deliveries-clean-24h'] },
    { id: 'AC-3', text: 'The github-budget attention row clears', proofs: ['manual:github-budget-attention-row-clears'] }];
  let work = await engine.execute(operator, 'create', null, { title: 'GY-1700 webhook deliveries failing with HTTP 500', plannedFiles, criteria: live }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  const revision = { expectedPolicyRevision: work.policyRevision, dependencies: [], plannedFiles, exclusiveResources: [],
    criteria: [{ id: 'AC-0', text: 'A verified webhook delivery soft-accepts with HTTP 202', proofs: ['unit:webhook-soft-accept-no-5xx'] }, ...live] };
  const requested = await call(master.token, `work/${work.key}/decide`, { action: 'requirements', input: revision, reason: 'AC-1..3 are live observations; AC-0 is the buildable criterion' });
  await engine.execute(implementer, 'scope', work.id, { epoch: work.epoch, paths: ['tests/webhook-soft-accept.test.ts'], reason: `Pending requirements decision ${requested.id} adds AC-0 unit:webhook-soft-accept-no-5xx naming this file` }, randomUUID());
  const refused = await engine.execute(coordinator, 'autoscope', work.id, { epoch: work.epoch }, randomUUID());
  const approved = await call(approver.token, `work/${work.key}/approve`, { decision: requested.id, reason: 'The buildable criterion is the item’s own' });
  const after = (await store.list()).find((item: Work) => item.id === work.id)! as Work;
  /** The worker submits, ending the attempt: the held decision applies; returns the item and how the decision settled. */
  const submit = async () => {
    await engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'gy1700-host', path: `/srv/gy1700/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
    const submitted = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: 1700 }, randomUUID()) as Work;
    const settle = async (id: string) => (await store.pool.query("SELECT kind FROM events WHERE work_id=$1 AND kind IN ('decision.applied','decision.stale','decision.failed') AND payload->>'id'=$2", [work.id, id])).rows.map(row => row.kind as string);
    return { submitted, settled: await settle(requested.id) };
  };
  /** A second requirements decision asked while this one is held, answered with the given status. */
  const another = (status: number) => call(master.token, `work/${work.key}/decide`, { action: 'requirements', reason: 'AC-3 names the row it clears',
    input: { ...revision, expectedPolicyRevision: after.policyRevision, criteria: [...live.slice(0, 2), { ...live[2], text: 'The github-budget attention row on the board clears' }] } }, status);
  return { refused, held: approved.state as string, after, submit, another };
}

test('manual:intervention-pattern-escalation-build — GY-1700 against the base and the candidate: the refused ask stands on the base until someone clears it; on the candidate the held decision grounds it at once', { timeout: 300_000 }, async () => {
  const onBase = await replay1700(base, 'gy1700_base');
  assert.equal(onBase.refused.scopeRequest?.decision?.state, 'refused', 'the loop refuses the ask on the criteria the item carries');
  assert.equal(onBase.held, 'held', 'the decision is approved and held for the live attempt');
  assert.match(onBase.after.blocker ?? '', /^Scope request refused/, 'the refusal still blocks the item, which only an operator clears: the instance reproduces');
  assert.ok(!onBase.after.plannedFiles.includes('tests/webhook-soft-accept.test.ts'));

  const onCandidate = await replay1700(null, 'gy1700_candidate');
  assert.equal(onCandidate.refused.scopeRequest?.decision?.state, 'refused', 'refused alike before the approval');
  assert.equal(onCandidate.held, 'held');
  assert.equal(onCandidate.after.blocker, null, 'the hold grounds the ask, so nobody has to clear it: it does not recur');
  assert.ok(onCandidate.after.plannedFiles.includes('tests/webhook-soft-accept.test.ts'));
  assert.equal(onCandidate.after.scopeDecision?.state, 'approved');
  assert.ok(onCandidate.after.lease, 'the attempt keeps its lease');
  // Through the attempt's end (Codex review of f8eb2edf68f2): the widening the hold grounded leaves the decision current,
  // so the submission applies it, and the approved file stays planned rather than being reset to the decision's own list.
  const { submitted, settled } = await onCandidate.submit();
  assert.deepEqual(settled, ['decision.applied'], 'the held decision applies, not stale');
  assert.ok(submitted.criteria.some(criterion => criterion.id === 'AC-0'), 'its criterion is the item’s');
  assert.ok(submitted.plannedFiles.includes('tests/webhook-soft-accept.test.ts'), 'the approved path survives the attempt ending');
  assert.equal(submitted.blocker, null);
  assert.ok(!submitted.heldGroundings, 'the grounding is spent once the decision settles');
});

test('manual:intervention-pattern-escalation-build — GY-1700 on the candidate: the widening is grounded by the one held decision whose criterion names the path, and no second decision can be held beside it to stale it', { timeout: 300_000 }, async () => {
  // Codex review of f28c91076299: a widening attributed to an unrelated held decision could let that one apply first
  // and stale the decision that authorized it. The engine records only decisions whose own criteria ground the ask,
  // and the control plane holds one requirements decision per item, so the grounding names exactly that decision.
  const replay = await replay1700(null, 'gy1700_one_held');
  assert.deepEqual(replay.after.heldGroundings?.map(entry => entry.paths), [['tests/webhook-soft-accept.test.ts']], 'one decision grounded the path it names');
  const refusal = await replay.another(409);
  assert.match(refusal.error, /is held/, 'a second requirements decision is refused while the grounding one is held');
  const { settled } = await replay.submit();
  assert.deepEqual(settled, ['decision.applied']);
});

// GY-1735: three more escalations at the build stage between 2026-10-05 and 2026-10-12, each a worker's
// `blocked` report. GY-1722 and GY-1725 are post-deploy follow-ups filed by the coordinator at 98070f3538,
// a filer older than GY-1698 and GY-1727, so they carry no observation window. The loop at ccc0a31494
// also predates the window hold and the defer prompt (GY-1726), so it dispatched each before its reading
// could exist (07:35Z, then again at 15:58Z once each blocker was cleared), and each worker could only
// block. The control plane is the one component a release keeps current, so it now derives the window
// the filing owed from the delivered item the follow-up names, at create, ready and unblock, and refuses
// the claim inside it. GY-1723 found GY-1700 AC-1 unobservable: a redelivered webhook that woke no job
// answered a bare `accepted` with no logged reason. GY-1731 (85e22811b7, whose parent is `base`) removed
// that by naming and logging the reason.
//
// The windows are taken relative to the database clock, as the engine reads it, so they hold whenever the suite runs.
const base1735 = 'f793ad5ca171c395d5d2b68a223cf24529f43a37';
const release1735 = 'ba607f8a809ed20fea15387e1934425cacbfef9f';
const instances1735: Record<'GY-1722' | 'GY-1725', { parent: string; criterion: Work['criteria'][number]; mergedAgo: number; servedAgo: number | null; window: number; blocker: string }> = {
  // GY-1692 AC-1: a rate per 7 days, counted from the merge.
  'GY-1722': { parent: 'GY-1692', criterion: { id: 'AC-1', text: 'The cause of the recurring human-only decision interventions at the build stage is found and removed: the intervention report shows the human-only-decision rate at the build stage below 3 per 7 days after the change ships, and the linked instances could not recur', proofs: ['manual:post-deploy/intervention-pattern-human-only-decision-build'] },
    mergedAgo: day, servedAgo: null, window: 7 * day,
    blocker: 'AC-1 cannot be observed yet: it asks for the build-stage human-only-decision rate below 3 per 7 days after GY-1692 ships, and that window has not run.' },
  // GY-1700 AC-3: 24 hours of live activity on the serving release, from its first observation.
  'GY-1725': { parent: 'GY-1700', criterion: { id: 'AC-3', text: 'The github-budget attention row in graphyard master status clears when a delivery arrives and does not re-fire during 24h of live repository activity while at least one pull request is open.', proofs: ['manual:post-deploy/github-budget-attention-row-clears'] },
    mergedAgo: 17 * 3_600_000, servedAgo: 8 * 3_600_000, window: 24 * 3_600_000,
    blocker: 'The 24-hour observation window AC-1 requires cannot exist yet: release ba607f8a809e (carrying GY-1700\'s merge a14965e4ad9a) was recorded deployed and this item was dispatched minutes later.' },
};
/** The follow-up as 98070f3538's filer filed it: its marker naming the parent, criterion, proof and release, and no window. */
function staleFiling(parent: Work, criterion: Work['criteria'][number]) {
  const proof = criterion.proofs[0]!, name = proof.slice('manual:post-deploy/'.length);
  return { title: `Post-deploy verification of ${parent.key} ${criterion.id} (${name}) on release ${release1735.slice(0, 12)}`, type: 'chore', priority: 1, dependencies: [parent.id],
    description: `Post-deploy follow-up: post-deploy:${parent.id}:${criterion.id}:${proof}:${release1735}\n\n${parent.key} was delivered with ${criterion.id} declared a post-deploy verification (${proof}).\n\n${parent.key} ${criterion.id}: ${criterion.text}`,
    criteria: [{ id: 'AC-1', text: `From this head against the serving release ${release1735.slice(0, 12)}: ${criterion.text}`, proofs: [`manual:${name}-on-serving-release`] }] };
}
/** One instance on one tree: the delivered parent as recorded, its follow-up filed as the stale filer filed it, released, and dispatched at once as the stale loop dispatched it. */
async function replayFollowUp(tree: string | null, name: string, key: keyof typeof instances1735, configure?: (engine: Engine) => void) {
  const instance = instances1735[key], { Engine, Store, interventions, dispatchable } = await plane(tree);
  const store = await databaseFor(name, Store);
  const engine = new Engine(store, [15368], 120, 'owner/escalation-build'); engine.submissionObserver = null; configure?.(engine);
  const now = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime(), iso = (ms: number) => new Date(ms).toISOString();
  const parent = deliveredItem(instance.parent, instance.criterion, iso(now - instance.mergedAgo));
  if (instance.servedAgo !== null) (parent.delivery as any).deployment = { sha: release1735, at: iso(now - instance.servedAgo), observedAt: iso(now - instance.servedAgo), covers: 'descendant', source: 'endpoint', mergeSha: parent.delivery!.mergeSha, observer: 'graphyard-master' };
  await store.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2)', [parent.id, JSON.stringify(parent)]);
  let work = await engine.execute(operator, 'create', null, staleFiling(parent, instance.criterion), randomUUID()) as Work;
  const filed = work.observationWindow ?? null;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  let refusal: string | null = null;
  try {
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
    // Claimed before its reading can exist, the worker the stale loop prompted could only block.
    work = await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason: instance.blocker }, randomUUID());
  } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
  work = (await store.list()).find((item: Work) => item.id === work.id)! as Work;
  const folded = interventions.foldInterventions((await interventions.readInterventionLedger(store.pool, { workId: work.id })).rows, [work], iso(now)).interventions;
  return { store, engine, refusal, filed, work, notBefore: now - (instance.servedAgo ?? instance.mergedAgo) + instance.window, now,
    escalations: folded.filter((entry: { kind: string }) => entry.kind === 'escalation').length, dispatchable: (at: number) => dispatchable(work, at) as boolean };
}

for (const key of ['GY-1722', 'GY-1725'] as const) {
  test(`manual:intervention-pattern-escalation-build — ${key} against the base and the candidate: the base lets the stale loop claim an unwindowed follow-up whose reading cannot exist, so its worker escalates; the candidate derives the window the filing owed, refuses the claim inside it and escalates nothing`, { timeout: 300_000 }, async () => {
    const onBase = await replayFollowUp(base1735, `${key.replace('-', '').toLowerCase()}_base`, key);
    assert.equal(onBase.filed, null, 'the base keeps the filing window-less');
    assert.equal(onBase.refusal, null, 'the base accepts the claim inside the window');
    assert.equal(onBase.work.blocker, instances1735[key].blocker, 'so the worker blocks');
    assert.equal(onBase.escalations, 1, 'and the blocker is an escalation: the instance reproduces');

    const onCandidate = await replayFollowUp(null, `${key.replace('-', '').toLowerCase()}_candidate`, key), held = onCandidate.work;
    assert.deepEqual([onCandidate.filed?.notBefore, onCandidate.filed?.basis], [new Date(onCandidate.notBefore).toISOString(), 'criterion-window'], 'create derives the window from the delivered parent');
    assert.match(onCandidate.refusal ?? '', new RegExp(`waits for its observation window: the reading it owes can first exist at ${new Date(onCandidate.notBefore).toISOString()}`));
    assert.deepEqual([held.blocker, held.lease, held.epoch], [null, null, 0], 'no attempt started and nothing was recorded against it');
    assert.equal(onCandidate.escalations, 0, 'nothing escalates: the instance does not recur');
    assert.equal(onCandidate.dispatchable(onCandidate.now), false, 'the loop holds it until the reading can exist');
    assert.equal(onCandidate.dispatchable(onCandidate.notBefore + 60_000), false, 'and past the instant it is owed to the loop\'s reading, never dispatched to a code worker (GY-1762)');
  });
}

test('manual:intervention-pattern-escalation-build — GY-1722 and GY-1725 as they stand: a follow-up already blocked without its window takes it when its blocker is cleared, so the next claim waits instead of starting an attempt that can only block again', { timeout: 300_000 }, async () => {
  const { store, engine, work: filed, notBefore } = await replayFollowUp(null, 'gy1722_standing', 'GY-1722');
  // As 98070f3538 left it after the first attempt: no window, and the worker's blocker.
  await store.pool.query(`UPDATE work_items SET document = (document - 'observationWindow') || jsonb_build_object('blocker', $2::text) WHERE id=$1`, [filed.id, instances1735['GY-1722'].blocker]);
  const unblocked = await engine.execute(operator, 'unblock', filed.id, { reason: 'the blocker names only the window' }, randomUUID()) as Work;
  assert.equal(unblocked.blocker, null);
  assert.equal(unblocked.observationWindow?.notBefore, new Date(notBefore).toISOString(), 'the unblock attaches the window the filing owed');
  await assert.rejects(engine.execute(implementer, 'claim', filed.id, {}, randomUUID()), /waits for its observation window/);
  // A window already recorded stands: a worker's later reading is never replaced by the derived one.
  const later = new Date(notBefore + 2 * day).toISOString();
  await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{observationWindow}', $2::jsonb) WHERE id=$1`, [filed.id, JSON.stringify({ notBefore: later, basis: 'worker-reading', detail: 'later' })]);
  await assert.rejects(engine.execute(implementer, 'claim', filed.id, {}, randomUUID()), new RegExp(`can first exist at ${later}`));
  // Any other item is untouched: an ordinary chore is claimed at once.
  let ordinary = await engine.execute(operator, 'create', null, { title: 'Ordinary chore', type: 'chore', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID()) as Work;
  ordinary = await engine.execute(operator, 'ready', ordinary.id, {}, randomUUID());
  assert.equal(ordinary.observationWindow, undefined);
  assert.equal((await engine.execute(implementer, 'claim', ordinary.id, {}, randomUUID()) as Work).epoch, 1);
});

test('manual:intervention-pattern-escalation-build — GY-1725 as it stands, already ready without its window: the refused claim still records the derived window, so the loop holds the item instead of dispatching refused claims through the whole window', { timeout: 300_000 }, async () => {
  const { store, engine, work: filed, notBefore, now } = await replayFollowUp(null, 'gy1725_ready', 'GY-1725');
  const { dispatchable } = await plane(null);
  // As 98070f3538 left it: ready, unblocked and window-less, so no ready or unblock command will derive the window.
  await store.pool.query(`UPDATE work_items SET document = document - 'observationWindow' WHERE id=$1`, [filed.id]);
  const stripped = (await store.list()).find((item: Work) => item.id === filed.id)! as Work;
  assert.deepEqual([stripped.ready, stripped.blocker, stripped.observationWindow], [true, null, undefined]);
  assert.equal(dispatchable(stripped, now), false, 'the stale document is a loop-owned observation (GY-1762), so no worker is dispatched even without its window');
  // A claim the control plane rejects before judging it writes nothing: neither a caller without claim
  // authority nor a key already answered for another command may record the window or its history.
  const history = async () => (await store.pool.query('SELECT count(*)::int AS n FROM events WHERE work_id=$1', [filed.id])).rows[0].n as number;
  const events = await history();
  await assert.rejects(engine.execute({ id: 'reader', role: 'reader', sessionKind: 'ai' }, 'claim', filed.id, {}, randomUUID()), /Worker permission required/);
  const reused = randomUUID();
  await store.pool.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [implementer.id, reused, 'another-command', JSON.stringify(stripped)]);
  await assert.rejects(engine.execute(implementer, 'claim', filed.id, {}, reused), /Idempotency key reused with different input/);
  const untouched = (await store.list()).find((item: Work) => item.id === filed.id)! as Work;
  assert.deepEqual([untouched.observationWindow, await history()], [undefined, events], 'a rejected claim leaves the item and its history unchanged');
  await assert.rejects(engine.execute(implementer, 'claim', filed.id, {}, randomUUID()), /waits for its observation window/);
  const held = (await store.list()).find((item: Work) => item.id === filed.id)! as Work;
  assert.equal(held.observationWindow?.notBefore, new Date(notBefore).toISOString(), 'the refused claim persisted the window it derived');
  assert.deepEqual([held.lease, held.epoch], [null, 0], 'and started no attempt');
  assert.equal(dispatchable(held, now), false, 'so the loop holds it inside the window');
  assert.equal(dispatchable(held, notBefore + 60_000), false, 'and past the instant the loop\'s reading is owed, never a code worker (GY-1762)');
});

test('manual:intervention-pattern-escalation-build — GY-1722 when the intervention report projects its reading later than the merge-based bound: the derived window is the report\'s, so the follow-up is held until the reading can exist, not released at merge plus 7 days', { timeout: 300_000 }, async () => {
  // The report projects the build-stage human-only-decision streak to begin 10 days from now; the criterion's own bound is the merge plus 7 days, 6 days from now.
  const asked: unknown[] = [];
  let projected = '';
  const { store, engine, work: filed, filed: window, refusal, notBefore, now } = await replayFollowUp(null, 'gy1722_report', 'GY-1722', engine => {
    engine.followUpPatterns = async pattern => { asked.push(pattern); return { since: null, projected }; };
    projected = new Date(Date.now() + 10 * day).toISOString();
  });
  const { dispatchable } = await plane(null);
  assert.deepEqual(asked[0], { kind: 'human-only-decision', stage: 'build' }, 'the report is read for the proof\'s pattern');
  assert.ok(Date.parse(projected) > notBefore, 'the report bound is the later one');
  assert.deepEqual([window?.notBefore, window?.basis], [projected, 'intervention-report'], 'create persists the report\'s bound, not the criterion\'s');
  assert.match(refusal ?? '', new RegExp(`can first exist at ${projected}`));
  assert.equal(dispatchable(filed, notBefore + 60_000), false, 'past the criterion bound the follow-up is still held');
  assert.equal(dispatchable(filed, Date.parse(projected) + 60_000), false, 'and past the report bound the reading is the loop\'s, never a code worker (GY-1762)');
  // A follow-up already ready without its window: the refused claim records the report's bound too.
  await store.pool.query(`UPDATE work_items SET document = document - 'observationWindow' WHERE id=$1`, [filed.id]);
  await assert.rejects(engine.execute(implementer, 'claim', filed.id, {}, randomUUID()), new RegExp(`can first exist at ${projected}`));
  const held = (await store.list()).find((item: Work) => item.id === filed.id)! as Work;
  assert.deepEqual([held.observationWindow?.notBefore, held.lease, dispatchable(held, notBefore + 60_000), dispatchable(held, now)], [projected, null, false, false]);
});

/** GY-1723's redelivery as recorded: a check_run naming only a delivered item's pull request, whose job is gone. */
async function replay1723(tree: string | null, name: string) {
  const { Engine, Store, server: serve } = await plane(tree);
  const store = await databaseFor(name, Store);
  const engine = new Engine(store, [15368], 120, 'owner/project'); engine.submissionObserver = null;
  const secret = 'gy1723-webhook-secret';
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  const http = serve(engine, [{ ...operator, token: 'o'.repeat(32) }], { config: { repository: 'owner/project', appId: 1234, installationId: 1, base: 'main' } } as never); servers.push(http);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const raw = JSON.stringify({ repository: { full_name: 'owner/project' }, check_run: { head_sha: 'e'.repeat(40), pull_requests: [{ number: 1146 }], app: { id: -1 } } });
  const delivery = randomUUID(), logged: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    const response = await fetch(`http://127.0.0.1:${(http.address() as { port: number }).port}/api/github/webhook`, { method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': delivery, 'X-GitHub-Event': 'check_run', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
    return { status: response.status, body: await response.json() as { accepted: boolean; ignored?: string }, logged: logged.filter(line => line.includes(delivery)) };
  } finally { console.error = original; }
}

test('manual:intervention-pattern-escalation-build — GY-1723 against the base and the candidate: the base answers a redelivery that wakes no job with a bare accepted and logs nothing, so AC-1 could not be observed; the candidate names and logs why it was ignored', { timeout: 300_000 }, async () => {
  const onBase = await replay1723(base, 'gy1723_base');
  assert.equal(onBase.status, 202);
  assert.deepEqual(onBase.body, { accepted: true }, 'no ignored reason is returned');
  assert.deepEqual(onBase.logged, [], 'and none is logged: the instance reproduces');

  const onCandidate = await replay1723(null, 'gy1723_candidate');
  assert.equal(onCandidate.status, 202);
  assert.deepEqual(onCandidate.body, { accepted: true, ignored: 'no open job' });
  assert.equal(onCandidate.logged.length, 1, 'the reason is logged with the delivery ID');
  assert.match(onCandidate.logged[0]!, /\(check_run\) accepted without wake: no open job$/);
});

// GY-1760 names this file for its proof too: three build-stage escalations in the week to 2026-10-13 were a worker blocking on an item nobody could build. Each is replayed against
// the pull request's specified base and the candidate through the path that produced it: release, dispatch, a worker's attempt, a blocked report, an escalation.
//   - GY-1750 (blocked#2541650): the throughput owner, filed in the backlog "never released to a worker", was released by hand; a worker was dispatched and blocked
//     with "Nothing to implement". The control plane now refuses to release it, by the ready command and by a release decision alike.
//   - GY-1696 (blocked#2541694) and GY-1674 (blocked#2541601): a chore whose single criterion observes the master checkout on the serving release
//     (manual:checkout-restore-…-on-serving-release), with no planned files: GY-1696's worker made its observation and could not submit (no diff, no pull request), and
//     GY-1674's could not observe at all (`.graphyard/master.json does not exist`; the worker token holds no master role). The base hands both to a worker; the candidate
//     refuses the release and the dispatch itself, so the master-only step is taken by the master-role session that owns it, never by a dispatched worker.
async function replay1750(tree: string | null, name: string) {
  const { Engine, Store, interventions } = await plane(tree);
  const store = await databaseFor(name, Store);
  const engine = new Engine(store, [15368], 120, 'owner/escalation-build'); engine.submissionObserver = null;
  const { reason: _reason, ...owner } = throughputOwnerItem('21d470571dca'.padEnd(40, '0'), 3);
  let work = await engine.execute(operator, 'create', null, { ...owner, reason: _reason, policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [] }, randomUUID());
  let refusal: string | null = null;
  try { work = await engine.execute(operator, 'ready', work.id, {}, randomUUID()); } catch (error) { refusal = error instanceof Error ? error.message : String(error); }
  let claimed = false;
  if (!refusal) {
    work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID()); claimed = true;
    work = await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason: 'Nothing to implement: this is a loop-owned verification item.' }, randomUUID());
  }
  const now = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  const folded = interventions.foldInterventions((await interventions.readInterventionLedger(store.pool, { workId: work.id })).rows, [work], new Date(now).toISOString()).interventions;
  return { refusal, work, ready: work.ready, claimed, escalations: folded.filter((entry: { kind: string }) => entry.kind === 'escalation').length };
}

for (const replayBase of replayBases) {
  test(`manual:intervention-pattern-escalation-build — GY-1750 against the base ${replayBase.slice(0, 7)} and the candidate: the base releases the throughput owner, a worker claims it and blocks, an escalation; the candidate refuses the release by command and by decision`, async () => {
    const onBase = await replay1750(replayBase, `gy1750_base_${replayBase.slice(0, 7)}`);
  assert.equal(onBase.refusal, null, 'the base releases it');
  assert.ok(onBase.claimed, 'and a worker claims an item it cannot build');
  assert.equal(onBase.escalations, 1, 'the instance reproduces: its blocked report is an open escalation');

  const onCandidate = await replay1750(null, `gy1750_candidate_${replayBase.slice(0, 7)}`);
  assert.match(onCandidate.refusal ?? '', /loop-owned/);
  assert.equal(onCandidate.ready, false, 'it stays in the backlog');
  assert.equal(onCandidate.escalations, 0, 'no worker is ever dispatched, so none blocks');

  const owner = onCandidate.work;
  assert.match(decisionPrecondition('release', { expectedRevision: owner.revision }, owner) ?? '', /loop-owned/, 'a release decision is refused at its precondition too');
  assert.equal(decisionPrecondition('release', { expectedRevision: 1 }, { ...owner, revision: 1, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] } as Work), null, 'an item with a code criterion releases as before');
  });
}

/** GY-1696 and GY-1674 as filed: a chore whose single criterion observes the master checkout on the serving release, no planned files, nothing to build, and the blocked report its worker recorded. */
const masterObservations = {
  'GY-1696': {
    criteria: [{ id: 'AC-1', text: 'From this head against the serving release 9f1dd9476b77 that carries GY-1680\'s merge 2b1810f5c00b: the doctor-issued master checkout-restore against a clean drifted checkout clears escalation:dirty-checkout, observed in master status', proofs: ['manual:checkout-restore-clears-drift-pin-on-serving-release'] }],
    blocked: 'Observation made but cannot be submitted. Blocked command: graphyard complete GY-1696 1 --head, error: \'A head is submitted only while the control plane is the merge writer; this install\'s merger is github, so push the branch and complete GY-1696 1 with its pull request number\'. The item has no plannedFiles and this branch has no diff, so there is no pull request to submit. A master-role session should record manual:checkout-restore-clears-drift-pin-on-serving-release from this reading.' },
  'GY-1674': {
    criteria: [{ id: 'AC-1', text: 'From this head against the serving release 215bf18e6492: a doctor-issued master checkout-restore completes end to end: escalation:dirty-checkout clears and daemon.upgrade.alignedRelease advances past ccc0a314, observed in master status', proofs: ['manual:checkout-restore-clears-dirty-checkout-on-serving-release'] }],
    blocked: 'AC-1 needs a doctor-issued master checkout-restore and a reading of master status. Blocked command: graphyard master status in this worktree, error: \'.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin\'. The worker token holds no master role, so the checkout-restore cannot be issued or observed from here. Needs a master-role session to observe and record manual:checkout-restore-clears-dirty-checkout-on-serving-release.' },
};

/** One master-observation item on one tree: created as filed, released if the tree allows it, and — where the dispatch gate still offers it — claimed and blocked as its worker was. */
async function replayMasterObservation(tree: string | null, name: string, key: keyof typeof masterObservations) {
  const instance = masterObservations[key];
  const { Engine, Store, interventions, dispatchable, assertDispatchable } = await plane(tree);
  const store = await databaseFor(name, Store);
  const engine = new Engine(store, [15368], 120, 'owner/escalation-build'); engine.submissionObserver = null;
  let work = await engine.execute(operator, 'create', null, { title: `Post-deploy verification of ${key}'s checkout-restore observation`, type: 'chore', plannedFiles: [], criteria: instance.criteria.map(criterion => ({ ...criterion })) }, randomUUID()) as Work;
  const now = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
  let readyRefusal: string | null = null, dispatchRefusal: string | null = null, released: Work | null = null, claimed = false;
  try { work = await engine.execute(operator, 'ready', work.id, {}, randomUUID()) as Work; released = work; }
  catch (error) { readyRefusal = error instanceof Error ? error.message : String(error); }
  if (released) {
    try { assertDispatchable(released, [released], new Date(now).toISOString()); } catch (error) { dispatchRefusal = error instanceof Error ? error.message : String(error); }
    if (!dispatchRefusal) {
      work = await engine.execute(implementer, 'claim', released.id, {}, randomUUID()) as Work; claimed = true;
      work = await engine.execute(implementer, 'blocked', work.id, { epoch: work.epoch, reason: instance.blocked }, randomUUID()) as Work;
    }
  }
  const folded = interventions.foldInterventions((await interventions.readInterventionLedger(store.pool, { workId: work.id })).rows, [work], new Date(now).toISOString()).interventions;
  return { readyRefusal, dispatchRefusal, released, work, ready: work.ready, claimed, at: now,
    escalations: folded.filter((entry: { kind: string }) => entry.kind === 'escalation').length,
    dispatchable: (candidate: Work, at: number) => dispatchable(candidate, at) as boolean };
}

for (const key of ['GY-1696', 'GY-1674'] as const) for (const replayBase of replayBases) {
  test(`manual:intervention-pattern-escalation-build — ${key} against the base ${replayBase.slice(0, 7)} and the candidate: the base releases the master-checkout observation and dispatches it, so its worker blocks, an escalation; the candidate refuses the release and the dispatch, so the step stays with the master-role session`, async () => {
    const onBase = await replayMasterObservation(replayBase, `${key.replace('-', '').toLowerCase()}_obs_base_${replayBase.slice(0, 7)}`, key);
    assert.equal(onBase.readyRefusal, null, 'the base releases it');
    assert.equal(onBase.dispatchRefusal, null, 'and its dispatch gate offers it: a worker is handed the master-only step');
    assert.ok(onBase.claimed, 'the worker claims an item it cannot observe or submit');
    assert.equal(onBase.escalations, 1, 'so its blocked report is an open escalation: the instance reproduces');

    const onCandidate = await replayMasterObservation(null, `${key.replace('-', '').toLowerCase()}_obs_candidate_${replayBase.slice(0, 7)}`, key);
    assert.match(onCandidate.readyRefusal ?? '', /loop-owned/, 'the candidate refuses the release by command');
    assert.equal(onCandidate.ready, false, 'it never leaves the backlog');
    assert.equal(onCandidate.escalations, 0, 'no worker is ever dispatched, so none blocks: the instance cannot recur');
    assert.match(decisionPrecondition('release', { expectedRevision: onCandidate.work.revision }, onCandidate.work) ?? '', /loop-owned/, 'a release decision is refused at its precondition too');

    // GY-1696 stands released on the live board, so the refusal cannot only guard the release: an item
    // released before this change is withheld from every worker still — the loop's dispatchable filter
    // and a hand dispatch alike, judged on the base's released document by the candidate's gates.
    const { dispatchable, assertDispatchable } = await plane(null);
    const released = onBase.released!;
    assert.equal(dispatchable(released, onBase.at), false, 'the dispatchable filter withholds the released legacy item from the board');
    assert.throws(() => assertDispatchable(released, [released], new Date(onBase.at).toISOString()), /loop-owned/, 'and a hand dispatch is refused with the same words');
  });
}

// GY-1768: eight build-stage escalations in the week to 2026-10-13 (GY-1696 ×3, GY-1674 ×3, GY-1725, GY-1724) were workers' `blocked` reports on items only the loop or a master-role
// session can serve. GY-1760 and GY-1762 stopped new dispatches; the reports already recorded stood open until a master unblocked each by hand (GY-1696's and GY-1674's were each
// unblocked and re-dispatched once). The loop now clears such a report itself (loopHeldBlocker) — and only such a report: its cause must be the worker's inability to take the reading
// the item owes, not any fault an item of that shape happens to carry. Each linked instance is replayed through the paths that produced it: the base blocker step leaves the standing
// report as an open escalation for a master; the candidate's blocker step, recording its pass through the server's own probe route, clears it, so the instance cannot recur.
{
  const heldClock = Date.parse('2026-10-13T11:00:00Z');
  const heldConfig = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/nonexistent/escalation-build.token', cliPath: 'bin/graphyard.mjs',
    repository: 'owner/escalation-build', baseBranch: 'main', githubAppId: 1, hostId: 'escalation-build-host', masterAgentName: 'master', workers: [] });
  const heldCycle = (open: Work[], effects: Record<string, unknown>, state = emptyDaemonState(heldConfig)) => {
    const performed: any[] = [];
    const cycle = { config: heldConfig, state, effects: { persist: async () => {}, ...effects }, now: () => heldClock, clock: heldClock, performed, open, agents: [],
      isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body(), launcher: { busy: () => false } } as unknown as Cycle;
    return { cycle, performed };
  };
  const classOf = (report: string) => itemBlockerClass({ blocker: report, humanRequest: null })!.class;
  const release = 'ba607f8a809ed20fea15387e1934425cacbfef9f';
  const followUp = (proof: string, plannedFiles: string[]) => ({ systemDriven: true, stage: 'ready', lease: null, plannedFiles, description: `Post-deploy follow-up: post-deploy:e03bc94f-82f4-481d-a443-4b4e6abe9eb6:AC-2:manual:post-deploy/webhook-deliveries-clean-24h:${release}`,
    criteria: [{ id: 'AC-1', text: 'observed', proofs: [proof] }] }) as unknown as Work;
  const owned = (proof: string) => ({ systemDriven: true, stage: 'ready', lease: null, plannedFiles: [], description: '', criteria: [{ id: 'AC-1', text: 'observed', proofs: [proof] }] }) as unknown as Work;
  // The four linked reports, as each worker's ledger row recorded its cause: on GY-1696 and GY-1674 the master-side reading a worker cannot take, on GY-1724 and GY-1725 the reading that
  // needs a browser sign-in or an App credential no worker holds.
  const instances: [string, Work, string][] = [
    ['GY-1696', owned('manual:checkout-restore-clears-drift-pin-on-serving-release'), "blocked on epoch 3: AC-1 is a live observation (manual:checkout-restore-clears-drift-pin-on-serving-release) whose proof authority is operator/production-operator-admin/production-acceptance-producer, not a worker (graphyard diagnose GY-1696). The item has no plannedFiles and no diff, so there is no PR to submit. Blocked command: graphyard master status in this worktree, error: '.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'. A master-role session should record that proof from this reading."],
    ['GY-1674', owned('manual:checkout-restore-clears-dirty-checkout-on-serving-release'), "AC-1 needs a doctor-issued master checkout-restore and a reading of master status (escalation:dirty-checkout cleared, daemon.upgrade.alignedRelease past ccc0a314). Blocked command: graphyard master status in this worktree (GY-1674-3), error: '.graphyard/master.json does not exist: run graphyard install --apply, or graphyard master init --token-stdin'. The worker token holds no master role, so the restore cannot be issued or observed from a worker session; this needs a master session to observe and record the proof."],
    ['GY-1724', followUp('manual:webhook-deliveries-clean-24h-on-serving-release', []), "The 24h window has elapsed (07:34Z 10-12..10-13) but no 24h reading is obtainable from this sandbox: the App's advanced delivery log needs a GitHub browser sign-in, and gh api /app returns 401 (no App JWT). No code change is owed; a master/operator with an App-authenticated session must read the log for the window and record manual:webhook-deliveries-clean-24h-on-serving-release."],
    ['GY-1725', followUp('manual:github-budget-attention-row-clears-on-serving-release', ['verification/post-deploy-github-budget-row.md']), "The reviewer's remaining AC-1 demands cannot be produced by a worker: a live raise-then-clear transition would need the App webhook failing for an hour, which must not be induced on the serving release, and GET /app/hook/deliveries needs the App JWT, which a worker does not hold. The note already states both limits; what AC-1 still owes is an operator-supplied delivery-log export for the window."],
  ];

  test('manual:intervention-pattern-escalation-build — each linked report names a worker that cannot take the reading it owes, and is held for the loop on its unleased item', () => {
    for (const [key, shape, report] of instances) {
      assert.equal(needsSomeone(classOf(report)), true, `${key}: the class waits for someone, the open escalation`);
      assert.equal(loopHeldBlocker(shape, report, classOf(report), heldClock), true, `${key}: the loop clears it`);
      assert.equal(loopHeldBlocker({ ...shape, lease: { owner: 'w', epoch: 1, expiresAt: '2026-10-13T12:00:00Z' } } as Work, report, classOf(report), heldClock), false, `${key}: never while an attempt still holds the item`);
    }
  });

  test('manual:intervention-pattern-escalation-build — the loop-held clear reads the report\'s cause, not the item\'s shape: a configuration actually missing, an unrelated failure, a human wait and an item with code keep their blockers', () => {
    const mastered = owned('manual:checkout-restore-clears-drift-pin-on-serving-release');
    for (const [standing, why] of [
      ['.graphyard/master.json does not exist: run graphyard install --apply', 'the master checkout configuration actually missing: the restore it names is owed, so the report is actionable'],
      ['This is not a worker limitation; the production webhook is returning invalid data and the delivery handler must be fixed.', 'a negated mention of a worker is a genuine fault, not the worker\'s inability'],
      ['npm run build failed: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'an unrelated failure of the item itself'],
    ] as const) {
      assert.equal(needsSomeone(classOf(standing)), true, standing);
      assert.equal(loopHeldBlocker(mastered, standing, classOf(standing), heldClock), false, why);
    }
    assert.equal(loopHeldBlocker(mastered, instances[0]![2], 'human-only', heldClock), false, 'a human-only wait is not the loop\'s to clear');
    assert.equal(loopHeldBlocker({ ...mastered, criteria: [...mastered.criteria, { id: 'AC-2', text: 'code', proofs: ['integration:behaves'] }], plannedFiles: ['src/x.ts'] } as Work, instances[0]![2], classOf(instances[0]![2]), heldClock), false, 'an item with a code criterion keeps its blocker for its worker');
  });

  /** The linked item in the candidate's control plane, carrying its blocked report as the ledger row left it when the release guards landed: one `blocked` row, one reason. */
  async function heldItem(name: string, shape: Work, report: string) {
    const store = await databaseFor(name, Store);
    const engine = new Engine(store, [15368], 120, 'owner/escalation-build'); engine.submissionObserver = null;
    const created = await engine.execute(operator, 'create', null, { title: `Post-deploy verification held for the loop (${name})`, type: 'chore', systemDriven: true,
      plannedFiles: [...(shape.plannedFiles ?? [])], criteria: structuredClone(shape.criteria), ...(shape.description ? { description: shape.description } : {}) }, randomUUID()) as Work;
    await store.transaction(async (db, now) => save(db, { ...created, blocker: report }, implementer.id, 'blocked', now, { epoch: created.epoch, reason: report }));
    const held = (await store.list()).find(item => item.id === created.id)!;
    return { engine, store, held };
  }

  for (const [key, shape, report] of instances) for (const replayBase of clearReplayBases) {
    test(`manual:intervention-pattern-escalation-build — ${key} against the base ${replayBase.slice(0, 7)} and the candidate: the base blocker step hands the standing report to a master, an open escalation; the candidate's step clears it through the server's probe route, so the instance cannot recur`, { timeout: 300_000 }, async () => {
      assert.equal(needsSomeone(classOf(report)), true, 'the class is one that waits for someone: the open escalation');

      // The base: its blocker step reads the report as needing someone and hands it over; the item keeps the blocker and no probe runs.
      const base = await importAt<typeof import('../src/daemon/cycle-blockers.js')>(replayBase, 'src/daemon/cycle-blockers.ts');
      const baseState = await importAt<typeof import('../src/daemon/state.js')>(replayBase, 'src/daemon/state.ts');
      const probed: { key: string; result: string }[] = [];
      const onBase = heldCycle([{ ...shape, blocker: report }], { recordBlockerProbe: async (item: Work, probe: { result: string }) => { probed.push({ key: item.key, result: probe.result }); } }, baseState.emptyDaemonState(heldConfig));
      await base.blockerStep(onBase.cycle);
      const handed = onBase.performed.filter(action => action.kind === 'blocker' && /it needs someone/.test(action.detail));
      assert.equal(handed.length, 1, `the standing report is handed over: ${JSON.stringify(onBase.performed)}`);
      assert.deepEqual(probed, [], 'the base records no path past the class');
      assert.equal((onBase.cycle.open[0] as Work).blocker, report, 'the item keeps its blocker: the instance reproduces');

      // The candidate: the same report on the same item in the control plane. The loop's blocker step records its pass through the route, which clears the blocker.
      const { engine, store, held } = await heldItem(`${key.replace('-', '').toLowerCase()}_held_${replayBase.slice(0, 7)}`, shape, report);
      const cleared: string[] = [];
      const onCandidate = heldCycle([held], { recordBlockerProbe: async (item: Work, body: Record<string, unknown>) => {
        const updated = await recordBlockerProbe({ engine } as never, coordinator, item.id, body, randomUUID()) as Work;
        cleared.push(updated.key);
        return updated;
      } });
      await blockerStep(onCandidate.cycle);
      assert.deepEqual(cleared, [held.key], 'the loop recorded its probe on the item');
      const reloaded = (await store.list()).find(item => item.id === held.id)!;
      assert.equal(reloaded.blocker, null, 'the pass cleared the blocker');
      assert.equal(reloaded.blockerProbe?.result, 'pass');
      const events = (await store.pool.query('SELECT kind FROM events WHERE work_id=$1 ORDER BY seq', [held.id])).rows.map(row => row.kind as string);
      assert.ok(events.includes('blocker.cleared'), `the route recorded the clear: ${events.join(', ')}`);
      assert.equal(blockerView(reloaded), null, 'the board asks nobody: the escalation is gone');

      // The instance cannot recur: the fold reads no open escalation on the item, and a further cycle probes and hands over nothing.
      const folded = foldInterventions((await readInterventionLedger(store.pool, { workId: held.id })).rows, [reloaded], new Date(heldClock).toISOString()).interventions;
      assert.deepEqual(folded.filter(entry => entry.kind === 'escalation' && entry.resolvedAt === null).map(entry => entry.blocked), [], 'no open escalation stands: the loop answered the report off the ledger');
      const again = heldCycle([reloaded], { recordBlockerProbe: async () => { throw new Error('no probe runs on an item whose report is gone'); } });
      await blockerStep(again.cycle);
      assert.deepEqual(again.performed, [], 'and a further cycle hands over nothing');
    });
  }
}
