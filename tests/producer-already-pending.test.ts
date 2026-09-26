import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { loadMasterConfig, saveProducerProfile, setupMaster } from '../src/master.js';
import { launchProducer, readProducerLedger } from '../src/producer.js';
import { controlPlaneHandlers, type ControlPlaneEffects } from '../src/executor.js';
import type { ExecutorIdentity } from '../src/auto-dispatch.js';
import { startedAtOnce } from './helpers/launch-shell.js';

// GY-415 names this test for its proof: manual:fault-class-unclassified. Three items' dispatch rows
// stalled on one unchanged refusal — "A producer session for KEY unit proofs is already pending on
// SHA" — because the loop's tick had launched the session the executor's row was asking for, and
// the executor failed the row for as long as that session ran. Each instance is replayed here.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const base = '2f76b9b7e4b06cf4bba3675d005ec0ecd645204e';
/** The instances the fault class recorded: item, the head the session was pending on, the unit proofs asked for. */
const instances = [
  { key: 'GY-274', sha: '29c8e2495fa649957d2dff3c1d5a1a9d2e581537', proofs: ['unit:renewal-transient-tolerated'] },
  { key: 'GY-407', sha: 'dff1ea30aeca185fe9e09bdae849cb74775f4bb6', proofs: ['unit:refusal-bound-to-head'] },
  { key: 'GY-406', sha: '067871702799dfb11634ad412a635a6a46fe5894', proofs: ['unit:repair-bypass-ruleset', 'unit:repair-lane-conditions', 'unit:repair-lane-audited'] },
];

function item(instance: typeof instances[number], pr: number): Work {
  const at = new Date().toISOString();
  const candidate = { sha: instance.sha, baseSha: base, pr, branch: `graphyard/${instance.key.toLowerCase()}-1`, author: 'implementer' };
  const observation: Observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at,
    prState: 'open', draft: false, baseTip: base, baseTree: base, baseTipContained: true } as Observation;
  const work = { id: `work-${instance.key}`, key: instance.key, title: instance.key, description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: instance.proofs }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [{ host: 'h', path: `/w/${instance.key}`, branch: candidate.branch, epoch: 1, owner: 'implementer' }],
    candidate, submission: { epoch: 1, pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }], violations: [] } as unknown as Work;
  reconcileAutoDispatch(work, [work], new Date());
  return work;
}
const herdr = (_command: string, args: string[]) => startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });

test('manual:fault-class-unclassified — a proof dispatch row whose head already has a pending producer session is settled on that session, not failed until it ends', async t => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-gy-415-')), credentials = await mkdtemp(join(tmpdir(), 'graphyard-gy-415-credentials-'));
  try {
    execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wE' }, status as typeof fetch);
    const credential = join(credentials, 'producer.token'); await writeFile(credential, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
    await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: credential, concurrency: 4 },
      async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*'] } }));
    const config = await loadMasterConfig(root);
    const items = instances.map((instance, index) => item(instance, 200 + index));
    const effects: ControlPlaneEffects = {
      snapshot: async () => ({ work: items, now: new Date().toISOString() }), mutate: async () => ({}), agents: () => [],
      workerCredentials: async () => ({}), producerCredentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
      dispatchWorker: async () => ({}), launchReview: async () => ({}), merge: async () => ({}),
      observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'none', deployed: [], pending: [] }),
      launchProducer: (work, request, profile, agents, observedAt) => launchProducer(root, work, request, profile, agents, observedAt, { run: herdr }),
    };
    const handlers = controlPlaneHandlers(() => config, effects);
    const executor: ExecutorIdentity = { id: 'graphyard-master@test/1', host: 'test' };
    for (const work of items) await t.test(`manual:fault-class-unclassified — ${work.key}: the executor's unit dispatch row settles on the session the loop launched on ${work.candidate!.sha.slice(0, 7)}`, async () => {
      const request = work.autoDispatch!.producers.find(entry => entry.group === 'unit')!;
      // The loop's tick launches the session first.
      await launchProducer(root, work, request, config.producers[0], [], new Date().toISOString(), { run: herdr });
      // Then an executor claims the dispatch row for the same request.
      const action = { id: `row-${work.key}`, key: work.key, work: work.id, kind: 'dispatch', gate: 'test', state: 'claimed', attempts: 1, history: [],
        inputs: { kind: 'dispatch', target: 'proof', group: 'unit', proofs: request.proofs, requestId: request.id, pr: request.pr, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision } } as unknown as ActionRow;
      const settled = await handlers.dispatch!(action, executor);
      assert.match(String(settled), new RegExp(`${work.key}'s unit proofs on ${work.candidate!.sha.slice(0, 12)} are left to producer session produce-a\\S* already pending on that head`));
      // Claimed again while the session runs, it settles the same way: nothing accumulates into a stall.
      assert.match(String(await handlers.dispatch!(action, executor)), /are left to producer session/);
      assert.equal((await readProducerLedger(root)).producers.filter(record => record.key === work.key).length, 1, 'no second session was launched');
    });
    // A session pending on another head is not this request's answer: the launch is still refused.
    const ledger = await readProducerLedger(root);
    ledger.producers = ledger.producers.map(record => record.key === 'GY-274' ? { ...record, sha: base } : record);
    await writeFile(join(root, '.graphyard/producers.json'), JSON.stringify(ledger), { mode: 0o600 });
    const stale = items[0], request = stale.autoDispatch!.producers.find(entry => entry.group === 'unit')!;
    await assert.rejects(async () => handlers.dispatch!({ id: 'row-stale', key: stale.key, work: stale.id, kind: 'dispatch', state: 'claimed', attempts: 1, history: [],
      inputs: { kind: 'dispatch', target: 'proof', group: 'unit', proofs: request.proofs, requestId: request.id, pr: request.pr, sha: request.sha, baseSha: request.baseSha, policyRevision: request.policyRevision } } as unknown as ActionRow, executor),
    /already pending on 2f76b9b; reconcile it with master status/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); }
});
