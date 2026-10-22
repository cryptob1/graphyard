import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployedE2e, e2eSuite } from '../src/e2e/runner.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Work } from '../src/model.js';

// GY-2610: GY-2558, GY-2571, GY-2585 and GY-2598 were created by cryptob1-graphyard-e2e on
// 2026-10-19 by post-deploy E2E runs that never reached closeCreatedWork; the operator released
// each and the loop dispatched each three times before the master closed them by hand.

const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs = 0) => new Date(clock + offsetMs).toISOString();
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'master', workers: [] }) as MasterConfig;

/** The install's own control plane, as far as the run and the loop touch it: items created by POST /api/work carry their creator. */
function plane() {
  const work: Work[] = [];
  const create = (title: string, createdBy: string) => {
    const item = { id: `work-${work.length + 1}`, key: `GY-${work.length + 1}`, title, description: '', type: 'feature', priority: 2, dependencies: [], createdBy,
      criteria: [{ id: 'AC-1', text: 'The fixture site\'s home shows this change', proofs: ['e2e:fixture-home'] }], policy: { checks: ['test'], review: true }, 
      stage: 'backlog', revision: 1, policyRevision: 1, createdAt: iso(), updatedAt: iso(), stageEnteredAt: iso(), ready: false, epoch: 0, lease: null, workspaces: [], candidate: null,
      submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [] } as unknown as Work;
    work.push(item);
    return item;
  };
  return { work, create };
}

test('unit:e2e-fixture-items-never-dispatched — a post-deploy E2E run that ends before its cleanup leaves items the next loop cycle closes as obsolete naming the run, never released or dispatched', async () => {
  const { work, create } = plane();
  const ordinary = create('An operator\'s own work', 'human-operator');
  // The run creates its items, then is killed at its command timeout before closeCreatedWork runs.
  const killed: typeof e2eSuite = () => ({ name: 'e2e', run: async () => {
    create('E2E case candidate-gates-promotion run e41a71dd-2 first', 'owner-project-e2e');
    create('E2E case production-exact-verification run e41a71dd-2', 'owner-project-e2e');
    throw new Error('the e2e step was killed at its command timeout');
  } });
  const closes: string[] = [];
  await assert.rejects(deployedE2e(process.cwd(), 'https://graphyard.example', 'e2e-token', killed, { fetcher: (async (url: URL) => { closes.push(String(url)); return new Response('{}'); }) as unknown as typeof fetch }), /killed at its command timeout/);
  assert.deepEqual(closes, [], 'the run never reached its cleanup');
  const fixtures = work.filter(item => item.createdBy === 'owner-project-e2e');
  assert.deepEqual(fixtures.map(item => item.stage), ['backlog', 'backlog'], 'its items are still open');

  const released: string[] = [], dispatched: string[] = [], reasons: Record<string, string> = {};
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work.map(item => ({ ...item })), now: iso() }),
    closeSession: () => {}, requestProof: () => {}, requestSmoke: () => {}, recordDeployment: async () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    dispatch: async item => { dispatched.push(item.key); },
    decide: async (item, action) => { if (action === 'release') released.push(item.key); return { id: 'decision' }; },
    closeWork: async (item, body) => {
      const held = work.find(entry => entry.id === item.id)!;
      Object.assign(held, { stage: 'done', closure: { kind: body.kind, reason: body.reason } });
      reasons[held.key] = body.reason;
      return held;
    },
  };
  const result = await runCycle(config, emptyDaemonState(config), effects, () => clock);

  for (const item of fixtures) {
    assert.equal(item.stage, 'done', `${item.key} is closed by the loop's next cycle`);
    assert.match(reasons[item.key], /^created by E2E run e41a71dd-2 \(case [\w-]+\), which ended before closing its own work/, 'the reason names the run');
    assert.equal(item.ready, false, `${item.key} was never released`);
    assert.ok(result.actions.some(action => action.kind === 'close' && action.state === 'done' && action.detail.startsWith(`Closed ${item.key} as obsolete: an E2E fixture E2E run e41a71dd-2`)));
  }
  assert.deepEqual([released, dispatched], [[], []], 'nothing released or dispatched a fixture');
  assert.equal(ordinary.stage, 'backlog', 'an item another principal created is ordinary work, left open');
  assert.equal(reasons[ordinary.key], undefined);
});
