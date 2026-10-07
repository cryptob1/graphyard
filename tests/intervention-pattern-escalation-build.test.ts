import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerView, classifyBlocker, environmentalBlockerClasses, needsSomeone } from '../src/model/blocker-class.js';
import { probeBlocker } from '../src/daemon/blocker-probes.js';
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
