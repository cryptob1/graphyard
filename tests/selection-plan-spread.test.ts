import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyRegistryMutation, chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { deriveAccountPlan } from '../src/provider-usage.js';

// GY-2943: the role's order handed pi-a to five launches in a row, four more sessions ran
// concurrently on pi-a's Z.AI plan, and the plan's rate limit took every launch down at once.
// Selection now spreads concurrent launches across provider plans before any plan takes a second
// live session, so one plan's limit costs one session, not the fleet.

const HOST = 'machine-a';
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (at: number) => new Date(at).toISOString();

/** Six pi accounts over three Z.AI plans: pi-a/pi-b draw zai-a, pi-c/pi-d zai-b, pi-e/pi-f zai-c. */
const planOf = (name: string) => `zai-${name.slice(-1) <= 'b' ? 'a' : name.slice(-1) <= 'd' ? 'b' : 'c'}`;
function registry(): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'pi')!], models: [{ name: 'glm', id: 'zai/glm-5.3-flash' }],
    accounts: ['pi-a', 'pi-b', 'pi-c', 'pi-d', 'pi-e', 'pi-f'].map(name => ({ name, runtime: 'pi', model: 'glm', plan: planOf(name), credential: { host: HOST, home: null } })),
    roles: [{ name: 'worker', accounts: ['pi-a', 'pi-b', 'pi-c', 'pi-d', 'pi-e', 'pi-f'], concurrency: 6 }], reason: 'fixture',
  }, { actor: 'operator', at: iso(clock - 60_000) }).registry;
}

test('unit:selection-spreads-across-plans — six worker launches over three plans put no second live worker on a plan before every plan holds one', () => {
  const fleet = registry(), plans = new Set<string>();
  for (let launch = 1; launch <= 6; launch++) {
    const choice = chooseSession(fleet, { role: 'worker', host: HOST }, clock + launch);
    assert.ok(choice.account, `launch ${launch} was refused: ${choice.reason}`);
    const plan = deriveAccountPlan(choice.account, fleet.accounts).planId;
    if (launch <= 3) assert.ok(!plans.has(plan), `launch ${launch} lands on plan ${plan}, which already holds a live worker before every plan holds one`);
    plans.add(plan);
    assert.equal(plans.size, Math.min(launch, 3), `after ${launch} launches ${plans.size} plans hold workers`);
    const session: FleetSession = { id: randomUUID(), role: 'worker', account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: HOST, work: `GY-${900 + launch}`, principal: 'worker-a', selectedAt: iso(clock + launch), selectedBy: 'coordinator', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
    fleet.sessions.push(session);
  }
  assert.equal(plans.size, 3, 'three plans hold the fleet at launch 3; launches 4-6 reuse them');
  // When a whole plan's workers end, the next launch returns to it before doubling a plan still live.
  for (const session of fleet.sessions.filter(entry => entry.account === 'pi-a' || entry.account === 'pi-b')) session.endedAt = iso(clock + 7);
  const again = chooseSession(fleet, { role: 'worker', host: HOST }, clock + 8);
  assert.equal(again.account?.name, 'pi-a', "the freed plan is served before a plan still holding live workers is doubled");
  assert.equal(deriveAccountPlan(again.account!, fleet.accounts).planId, 'zai-a');
});
