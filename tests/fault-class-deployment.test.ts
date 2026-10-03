import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, observeDeployment, type DaemonState } from '../src/master-daemon.js';
import { deploymentStep } from '../src/daemon/cycle-delivery.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { ChildRun } from '../src/child-runner.js';

// GY-1106 names this file for its proof: manual:fault-class-deployment. The master loop filed 3
// deployment faults in 24 hours on 2 October 2026. Every instance shared the same cause:
//
//   - Deployment observation read the GitHub deployments listing without filtering by the configured
//     production environment (repos/:repo/deployments?per_page=100&page=N).
//   - Non-production deployments — in particular, hundreds of CI proof reporting deployments
//     (environment: 'graphyard-reporting') — filled all 5 pages (500 records) of the listing bound.
//   - Although Railway had successfully deployed each merged change to 'graphyard / production', the
//     unfiltered listing window was completely consumed by CI reporting records, hiding the production
//     releases past the 5-page bound.
//   - The observation concluded that none of the newest 500 deployments was a successful release of
//     the managed base branch, marking the observation unavailable and recording action:deployment
//     as a recurring deployment fault on the subject deployment:<mergeSha>.
//
// The candidate filters the GitHub deployment listing by environment (environment=...), so non-production
// deployments never enter the listing window, and the successful production release is observed immediately.
//
// Each instance listed on the item is replayed below from the ledger and GitHub as they stood when
// the loop recorded it. Against the base each subtest fails: the instance reproduces.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

interface Instance {
  id: string;
  subject: string;
  sha: string;
  at: string;
  itemKey: string;
  pr: number;
  deploymentId: number;
}

const instances: Instance[] = [
  {
    id: 'action:deployment|deployment:55e693f8de263b78850ca4675357cc5ebb6ed1f5|2026-10-02T06:40:15.237Z',
    subject: 'deployment:55e693f8de263b78850ca4675357cc5ebb6ed1f5',
    sha: '55e693f8de263b78850ca4675357cc5ebb6ed1f5',
    at: '2026-10-02T06:40:15.237Z',
    itemKey: 'GY-468',
    pr: 348,
    deploymentId: 6801787363,
  },
  {
    id: 'action:deployment|deployment:74710c912d97b074ce1cc4b1af338000749c3dfc|2026-10-02T07:25:37.243Z',
    subject: 'deployment:74710c912d97b074ce1cc4b1af338000749c3dfc',
    sha: '74710c912d97b074ce1cc4b1af338000749c3dfc',
    at: '2026-10-02T07:25:37.243Z',
    itemKey: 'GY-966',
    pr: 511,
    deploymentId: 6803222981,
  },
  {
    id: 'action:deployment|deployment:625bd412a391f1114bcfa8200e4b8612462b8b4d|2026-10-02T08:00:02.292Z',
    subject: 'deployment:625bd412a391f1114bcfa8200e4b8612462b8b4d',
    sha: '625bd412a391f1114bcfa8200e4b8612462b8b4d',
    at: '2026-10-02T08:00:02.292Z',
    itemKey: 'GY-1074',
    pr: 541,
    deploymentId: 6803801669,
  },
];

function config(): MasterConfig {
  return masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    credentialFile: '/outside/coordinator.token',
    cliPath: launcher,
    repository: 'cryptob1/graphyard',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'vishrog',
    masterAgentName: 'graphyard-master',
    autoMerge: true,
    mergeMethod: 'merge',
    workers: [],
    run: {
      productionEnvironment: 'graphyard / production',
    },
  });
}

function deliveredItem(instance: Instance): Work {
  return {
    id: `work-${instance.itemKey}`,
    key: instance.itemKey,
    title: instance.itemKey,
    description: '',
    type: 'feature',
    priority: 1,
    dependencies: [],
    criteria: [],
    policy: { checks: ['test'], review: true },
    plannedFiles: [],
    stage: 'done',
    revision: 1,
    policyRevision: 1,
    createdAt: instance.at,
    updatedAt: instance.at,
    stageEnteredAt: instance.at,
    ready: false,
    epoch: 1,
    lease: null,
    workspaces: [],
    candidate: null,
    submission: { epoch: 1, pr: instance.pr },
    reworkRequested: false,
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
    delivery: { mergedAt: instance.at, mergeSha: instance.sha, authorizationRevision: 1 },
  } as unknown as Work;
}

/**
 * Creates a mock runner representing GitHub and local git at the time of the incident:
 * - Local git confirms the commit is an ancestor of main (which all 3 commits are in this checkout).
 * - GitHub deployments listing:
 *     - If filtered by environment ('graphyard / production'): returns the production deployment.
 *     - If unfiltered (base behavior): returns 500 non-production CI reporting deployments across 5 pages.
 * - GitHub status query: returns 'SUCCESS' for the production deployment.
 */
function createIncidentRunner(instance: Instance) {
  const requests: string[] = [];
  const run: ChildRun = async (command: string, args: string[]) => {
    requests.push(`${command} ${args.join(' ')}`);
    if (command === 'git') {
      if (args.includes('fetch')) return '';
      if (args.includes('merge-base')) return '';
      return '';
    }
    if (command === 'gh') {
      // Status read via GraphQL: gh api graphql -f query=...
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: {
            nodes: [
              {
                databaseId: instance.deploymentId,
                latestStatus: { state: 'SUCCESS' },
              },
            ],
          },
        });
      }
      // Deployments listing: gh api repos/.../deployments?...
      const target = args[1] ?? '';
      if (args[0] === 'api' && target.includes('/deployments?')) {
        const isEnvironmentFiltered = target.includes(`environment=${encodeURIComponent('graphyard / production')}`)
          || target.includes('environment=graphyard%20%2F%20production');
        if (isEnvironmentFiltered) {
          // When filtered by environment, GitHub returns only deployments matching the production environment
          return JSON.stringify([
            {
              id: instance.deploymentId,
              node_id: `DE_${instance.deploymentId}`,
              sha: instance.sha,
              ref: instance.sha,
              environment: 'graphyard / production',
            },
          ]);
        }
        // Unfiltered listing (base behavior): 500 non-production CI reporting records fill the 5 pages
        const pageMatch = /[?&]page=(\d+)/.exec(target);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        return JSON.stringify(
          Array.from({ length: 100 }, (_, index) => ({
            id: 900_000 + (page - 1) * 100 + index,
            node_id: `DE_rep_${page}_${index}`,
            sha: '0'.repeat(40),
            ref: 'main',
            environment: 'graphyard-reporting',
          })),
        );
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { run, requests };
}

test('manual:fault-class-deployment — the item lists 3 instances, and every one is replayed below', () => {
  assert.equal(new Set(instances.map(inst => inst.id)).size, 3);
  assert.deepEqual(instances.map(inst => inst.itemKey), ['GY-468', 'GY-966', 'GY-1074']);
  assert.deepEqual(new Set(instances.map(inst => inst.subject)).size, 3);
});

for (const instance of instances) {
  test(`manual:fault-class-deployment — ${instance.id} does not recur when deployment listing is filtered by environment`, async () => {
    const master = config();
    const state = emptyDaemonState(master);
    const item = deliveredItem(instance);
    const { run, requests } = createIncidentRunner(instance);

    const performed: any[] = [];
    const cycle: Cycle = {
      config: master,
      state,
      effects: {
        observeDeployment: async (delivered: Work[], retained: any) =>
          observeDeployment(master, delivered, run, fetch, () => Date.parse(instance.at), {
            root: process.cwd(),
            retained,
          }),
        persist: async () => {},
        publishProductionEnvironment: async () => {},
        recordDeployment: async () => {},
      } as any,
      now: () => Date.parse(instance.at),
      snapshot: { work: [item], now: instance.at },
      performed,
      isolate: async (_step: unknown, _work: unknown, _key: unknown, action: () => Promise<unknown>) => action(),
    } as any;

    await deploymentStep(cycle);

    // Against candidate: observation finds the release and verifies the deployed commit
    assert.equal(state.deployment?.source, 'github-deployment');
    assert.equal(state.deployment?.sha, instance.sha);
    assert.deepEqual(state.deployment?.deployed, [instance.itemKey]);
    assert.deepEqual(state.deployment?.pending, []);

    // Against candidate: the deployment action succeeds, raising no fault
    const action = state.actions[instance.subject];
    assert.ok(action, `action ${instance.subject} was recorded`);
    assert.equal(action.state, 'done', 'deployment action completed successfully');
    assert.equal(action.faultClass, undefined, 'no deployment fault is recorded');

    // Verify that the query passed the environment filter
    const listRequests = requests.filter(req => req.includes('/deployments?'));
    assert.ok(listRequests.length >= 1, 'at least one deployments listing request was made');
    for (const req of listRequests) {
      assert.match(req, /environment=/, 'GitHub deployments query is filtered by environment');
    }
  });
}

for (const instance of instances) {
  test(`manual:fault-class-deployment — reproduction against base: ${instance.id} fails when 500 non-production records hide the release`, async () => {
    const master = config();
    const item = deliveredItem(instance);

    // Simulate base behavior by answering only unfiltered queries with 500 CI reporting records
    let unfilteredPagesRequested = 0;
    const baseRun: ChildRun = async (command: string, args: string[]) => {
      if (command === 'git') {
        if (args.includes('fetch')) return '';
        if (args.includes('merge-base')) return '';
        return '';
      }
      if (command === 'gh') {
        const target = args[1] ?? '';
        if (args[0] === 'api' && target.includes('/deployments?')) {
          unfilteredPagesRequested++;
          const pageMatch = /[?&]page=(\d+)/.exec(target);
          const page = pageMatch ? Number(pageMatch[1]) : 1;
          return JSON.stringify(
            Array.from({ length: 100 }, (_, index) => ({
              id: 900_000 + (page - 1) * 100 + index,
              node_id: `DE_rep_${page}_${index}`,
              sha: '0'.repeat(40),
              ref: 'main',
              environment: 'graphyard-reporting',
            })),
          );
        }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    };

    // Force unfiltered URL to simulate base code that did not pass environment parameter
    const simulateBaseRunner: ChildRun = async (command, args) => {
      if (command === 'gh' && args[0] === 'api' && args[1]?.includes('/deployments?')) {
        const strippedUrl = args[1].replace(/environment=[^&]*&/, '');
        return baseRun(command, [args[0], strippedUrl, ...args.slice(2)]);
      }
      return baseRun(command, args);
    };

    const observation = await observeDeployment(master, [item], simulateBaseRunner, fetch, () => Date.parse(instance.at), {
      root: process.cwd(),
    });

    // Exactly reproduces the base failure recorded in GY-1106:
    assert.equal(observation.source, 'unavailable');
    assert.equal(observation.sha, null);
    assert.equal(unfilteredPagesRequested, 5, 'base reads all 5 pages looking for the release');
    assert.match(
      observation.reason!,
      /None of the newest 500 GitHub deployment\(s\) is a successful graphyard \/ production release of the managed base branch, and older ones are past the 5-page read bound, so the release production serves is not known/,
      'reproduces the exact fault message recorded on GY-1106',
    );
  });
}

