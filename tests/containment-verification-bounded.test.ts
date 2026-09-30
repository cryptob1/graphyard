import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { verifyContainmentDeath } from '../src/master/containment.js';
import { containmentSettlementRefusals, containmentVerificationSchema } from '../src/quarantine.js';

const host = 'coordinator-host';
const bigScope = 'graphyard-watch-4100-big.scope';
const neighbourScope = 'graphyard-watch-4200-own.scope';
const lapsed = new Date(Date.now() - 600_000).toISOString();

function quarantined(key: string, epoch: number, unit: string, pid: number) {
  return {
    id: `${key}-id`, key, epoch, lease: null, sessions: [],
    workspaces: [{ epoch, owner: 'worker', host, path: `/srv/graphyard/worktrees/${key}-${epoch}`, branch: `graphyard/${key.toLowerCase()}-${epoch}` }],
    containmentQuarantine: { owner: 'worker', epoch, at: lapsed, settlementHash: 'a'.repeat(64), leaseExpiresAt: lapsed, launchExpiresAt: lapsed, launchAcknowledgedAt: lapsed, scope: { unit, pid } },
  } as unknown as Work;
}

/** One host probe: the big scope holds 350 processes of another live assignment, the other scope has ended. */
function probe(target: { workspacePath: string; scope?: { unit: string; pid: number } | null }) {
  return {
    method: 'linux-proc-systemd' as const, platform: 'linux', uid: 1000, workspacePath: target.workspacePath, processes: [], held: [], inaccessible: 0, unverifiable: [],
    recordedScope: target.scope ? { ...target.scope, activeState: target.scope.unit === bigScope ? 'active' : 'not-found' } : null,
    scopes: [{ unit: bigScope, activeState: 'active', processes: [], attributed: Array.from({ length: 350 }, (_, index) => 10_000 + index) }],
  };
}

test('unit:verification-survives-large-scope a scope of 350 attributed processes is recorded truncated and live, and another quarantine in the same verification settles', async () => {
  const options = { observedAt: new Date().toISOString(), hostId: host, clockOffset: { min: 0, max: 1 }, probe };
  // Another item, whose own recorded scope has ended, is verified on the same host beside the big scope.
  const other = await verifyContainmentDeath(quarantined('GY-2', 3, neighbourScope, 4200), options);
  assert.ok(other.verification, 'the verification parses despite a 350-process scope');
  assert.equal(containmentVerificationSchema.safeParse(other.verification).success, true);
  const big = other.verification.scopes.find(scope => scope.unit === bigScope)!;
  assert.equal(big.truncated, true);
  assert.equal(big.attributedTotal, 350);
  assert.equal(big.attributed.length, 200);
  assert.equal(big.activeState, 'active', 'the truncated scope is recorded live');
  assert.deepEqual(other.refusals, []);
  assert.equal(other.settleable, true, "another item's quarantine settles");

  // The item whose own scope is the truncated one is judged conservatively: live, never proven stopped.
  const own = await verifyContainmentDeath(quarantined('GY-1', 2, bigScope, 4100), options);
  assert.equal(own.settleable, false);
  assert.ok(own.refusals.some(reason => reason.includes(bigScope) && reason.includes('judges the scope live')), own.refusals.join('\n'));

  // Holding lists record the full count, and a truncated holding scope fences whoever it is.
  const holding = containmentVerificationSchema.parse({
    ...other.verification,
    scopes: [{ unit: bigScope, activeState: 'active', processes: Array.from({ length: 200 }, (_, index) => 20_000 + index), attributed: [], truncated: true, processesTotal: 350 }],
  });
  const refusals = containmentSettlementRefusals(quarantined('GY-2', 3, neighbourScope, 4200), holding, { now: Date.parse(options.observedAt) });
  assert.ok(refusals.some(reason => reason.includes('still holds 350 process(es)')), refusals.join('\n'));
});

test('a host with more containment scopes than the bound records the full count and refuses settlement', async () => {
  const options = { observedAt: new Date().toISOString(), hostId: host, clockOffset: { min: 0, max: 1 }, probe: (target: Parameters<typeof probe>[0]) => ({
    ...probe(target),
    // 60 scopes, the quarantine's own live scope listed last, past the 50-scope bound.
    scopes: Array.from({ length: 60 }, (_, index) => ({ unit: index === 59 ? neighbourScope : `graphyard-watch-${5000 + index}.scope`, activeState: 'active', processes: [], attributed: [] })),
  }) };
  const result = await verifyContainmentDeath(quarantined('GY-2', 3, neighbourScope, 4200), options);
  assert.ok(result.verification, 'the verification parses despite 60 scopes');
  assert.equal(result.verification.scopes.length, 50);
  assert.equal(result.verification.truncated?.scopes, 60);
  assert.equal(result.settleable, false, 'an unrecorded scope can never be proven stopped');
  assert.ok(result.refusals.some(reason => reason.includes('found 60 containment scopes and recorded only 50')), result.refusals.join('\n'));
});
