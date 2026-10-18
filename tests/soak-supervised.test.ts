import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonEffects } from '../src/master-daemon.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { loopPresenceHeader, loopSupervisionHeader } from '../src/model/executor-presence.js';
import { setupChecklist } from '../src/model/setup-checklist.js';
import { masterConfigSchema, withRoleDefaults } from '../src/master/profiles.js';
import { hour, minute, staleSha } from './helpers/soak-world.js';
import { api, principals, soakConfig, soakControlPlanes, token, url } from './helpers/soak-plane.js';
import { simulateDay, supervisedAbsentEffects } from './helpers/soak-simulation.js';

/**
 * GY-1501. A supervised install under the real loop for simulated hours: master.json records
 * `supervised`, so the loop runs with no reviewer App, operator-agent or approver identity, and the
 * operator's own GitHub login reviews. One concern of the release-candidate soak (GY-404), in its own
 * file (GY-1363): the world is tests/helpers/soak-world.ts, the control planes
 * tests/helpers/soak-plane.ts, the day tests/helpers/soak-simulation.ts, and the system invariants
 * are asserted after every cycle.
 */
soakControlPlanes('soak-supervised', 413);

const operator = 'soak-operator';
const supervisedConfig = () => withRoleDefaults(masterConfigSchema.parse({ ...soakConfig, supervision: 'supervised', operatorLogin: operator }));

test('unit:supervised-review-gate-human — under the real loop a supervised install merges only heads the operator approved exactly, through GitHub auto-merge: an unapproved head and a stale-approved head never merge, no reviewer, approver or escalation session launches, and the waiting cycles accumulate no actions or sessions', { timeout: 300_000 }, async () => {
  // The day leaves absent exactly what the loop's real effects leave absent for this config.
  const real = daemonEffects('/nonexistent/gy-1501-soak', supervisedConfig(), { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}) }) as unknown as Record<string, unknown>;
  for (const key of supervisedAbsentEffects) assert.equal(real[key], undefined, `daemonEffects leaves ${key} absent on a supervised install`);
  const autonomous = daemonEffects('/nonexistent/gy-1501-soak', withRoleDefaults(soakConfig), { snapshot: async () => ({ work: [], now: new Date().toISOString() }), mutate: async () => ({}) });
  assert.ok(autonomous.decide && autonomous.approver, 'the same config in autonomous mode keeps its decision and approver effects');

  const withheld = 3, stale = { item: 2, untilMs: 2 * hour };
  const day = await simulateDay({ hours: 5, supervised: { operator, withheld: [withheld], stale },
    plan: { items: 4, leftovers: 0, slowRecompute: 0, unstable: 0, attested: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0,
      outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  const { items, final, github, violations, failures, lost, dayStart, supervisedDay } = day;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  const key = (n: number) => items[n - 1].key, item = (n: number) => final.find(entry => entry.key === key(n))!;

  // Review stays required: every item keeps policy review true under the GitHub provider.
  for (const entry of final.filter(entry => items.some(own => own.key === entry.key))) assert.equal(entry.policy.review, true, `${entry.key} keeps review required`);
  // What the operator approved exactly is delivered, and only through GitHub auto-merge.
  assert.deepEqual([1, 2, 4].map(n => `${key(n)} ${item(n).stage} ${!!item(n).delivery}`), [1, 2, 4].map(n => `${key(n)} done true`), 'every approved item is delivered');
  assert.ok(github.merges.length >= 3);
  for (const merge of github.merges) {
    const pr = github.prs.get(merge.pr)!, head = pr.head;
    // The control plane asks GitHub to merge the head (head-bound: at once when mergeable, else auto-merge); nobody merges outside it.
    assert.ok(merge.mode !== 'outside' && pr.mergeRequestedAt !== null && pr.mergeRequestedAt <= merge.at, `${merge.key} merged through GitHub on the control plane's request: ${merge.mode}`);
    const approval = pr.reviews.find(review => review.reviewer === operator && review.state === 'APPROVED' && review.sha === head);
    assert.ok(approval && Date.parse(approval.submittedAt) <= merge.at, `${merge.key} merged only after the operator approved its exact head ${head.slice(0, 12)}: ${JSON.stringify(pr.reviews)}`);
  }
  // The never-approved item waits in review with nothing merged.
  assert.equal(item(withheld).stage, 'review', `${key(withheld)} waits for the operator's approval`);
  assert.ok(!item(withheld).delivery && !github.merges.some(merge => merge.key === key(withheld)), `${key(withheld)} never merges`);
  assert.deepEqual(item(withheld).gates.find(gate => gate.name === 'review')!.reasons, ['Independent approval of the current commit is required']);
  // The stale-approved head stands for two hours with an approval of an earlier head and does not merge until the exact approval.
  const stalePr = [...github.prs.values()].find(pr => pr.key === key(stale.item))!;
  assert.ok(stalePr.reviews.some(review => review.sha === staleSha(stalePr.pushed.keys().next().value!)), 'the operator approved an earlier head first');
  const staleMerge = github.merges.find(merge => merge.key === key(stale.item))!;
  assert.ok(staleMerge.at >= dayStart + stale.untilMs, `${key(stale.item)} merged only once the exact head was approved (+${Math.round((staleMerge.at - dayStart) / minute)} min)`);

  // The loop launches no reviewer, approver or escalation session.
  assert.deepEqual([...supervisedDay!.agentNames].filter(name => /review|approver|escalation/i.test(name)), [], `no such session: ${[...supervisedDay!.agentNames].join(', ')}`);
  // The waiting cycles, after the last delivery, keep the cursor and the panes level: no retries or sessions accumulate.
  const lastMerge = Math.max(...github.merges.map(merge => merge.at)) - dayStart;
  const waiting = supervisedDay!.cycles.filter(cycle => cycle.elapsed > lastMerge + 15 * minute);
  assert.ok(waiting.length >= 30, `the withheld item waited through many cycles: ${waiting.length}`);
  const rows = waiting[0].withheld;
  assert.ok(rows.some(row => row.startsWith('review:')), `the loop holds the withheld item's review row: ${rows.join('; ')}`);
  for (const cycle of waiting) assert.deepEqual(cycle.withheld, rows, `+${Math.round(cycle.elapsed / minute)} min: the withheld item's rows and their attempts stay level`);
  assert.ok(rows.every(row => / 1$/.test(row)), `no row for the withheld item is retried: ${rows.join('; ')}`);
  assert.ok(Math.max(...waiting.map(cycle => cycle.agents)) <= waiting[0].agents, `no sessions accumulate while the item waits: ${waiting.map(cycle => cycle.agents).join(',')}`);

  // The dashboard's Setup checklist reads the live loop's supervision from /api/status (the loop names it on its coordination read).
  const read = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${token(principals.coordinator)}`, [coordinationViewHeader]: 'coordination', [loopPresenceHeader]: '60', [loopSupervisionHeader]: 'supervised' } });
  assert.equal(read.status, 200);
  const status = await api(principals.operator, 'GET', 'status');
  assert.equal(status.setup.supervision, 'supervised', 'the status carries the live loop\'s supervision');
  const ids = setupChecklist(status).map(entry => entry.id);
  assert.ok(!ids.includes('reviewer-app') && !ids.includes('account:reviewer'), `the Setup checklist asks for no reviewer App or reviewing account: ${ids.join(', ')}`);
});
