import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { daemonEffects, emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { noteFault, retainedFaultInstances, type FaultClass } from '../src/model/fault-classes.js';
import { checkInvariants, emptyInvariantRecord } from '../src/model/invariants.js';
import { RefusedResponse } from '../src/model/refusal.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1706 (manual:fault-class-scope). The real fileFaultClass effect now derives plannedFiles from
 * the base tree on every recurring fault-class filing. Over a simulated day of five-minute loop
 * cycles: multiple classes file once each with their proof test and companions; a plane-wide 502
 * retries on the backoff under the same idempotency key; a moved base head is what the next filing
 * plans against; while an item stands nothing is filed again; every system invariant holds.
 */

const start = Date.parse('2030-01-10T00:00:00Z');
const interval = 5 * 60_000;
const cycles = 24 * 60 / 5;
const hour = 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const companions = ['tests/helpers/timing-baseline.json', 'tests/no-wall-clock-time-bombs.test.ts'] as const;
const proof = (faultClass: FaultClass) => `tests/fault-class-${faultClass}.test.ts`;

function config(): MasterConfig {
  return masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', workers: [],
    operatorAgent: { id: 'graphyard-master-operator', credentialFile: '/outside/operator.token' },
  });
}

function item(fields: Record<string, unknown>): Work {
  return {
    description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item'] }],
    policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: [], revision: 1, policyRevision: 1,
    createdAt: iso(start - hour), updatedAt: iso(start - hour), stageEnteredAt: iso(start - hour),
    ready: false, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    violations: [], gates: [], ...fields,
  } as unknown as Work;
}

async function seedTree(root: string, files: readonly string[]) {
  for (const path of files) {
    await mkdir(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    await writeFile(join(root, path), path.endsWith('.json') ? '{}\n' : `test(${JSON.stringify(path)}, () => {});\n`);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', `tree ${files.length}`], { cwd: root });
}

test('unit:soak-invariants-hold — over a simulated day the real fileFaultClass derives plannedFiles on each filing: multiple classes, 502 backoff, a moved base, bounded re-filing, and every invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-fault-filing');
  const secrets = await temporaryDirectory('soak-fault-filing-secrets');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  for (const [key, value] of [['user.email', 'soak-fault@example.invalid'], ['user.name', 'Soak Fault'], ['commit.gpgsign', 'false']] as const)
    execFileSync('git', ['config', key, value], { cwd: root });
  await seedTree(root, [
    proof('scope'), proof('decision'), proof('review-convergence'), ...companions,
  ]);
  const token = join(secrets, 'operator.token');
  await writeFile(token, 'operator-token-'.padEnd(48, 'x'), { mode: 0o600 });

  const work: Work[] = [];
  const posts: { at: number; class: string; key: string; plannedFiles: string[]; outcome: '502' | 'created' }[] = [];
  const created = new Map<string, Work>();
  let next = 200;
  let scopeFailures = 0;
  let now = start;

  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const faultClass = body.origin?.faultClass?.class as string;
    const key = new Headers(init.headers).get('Idempotency-Key')!;
    // The first scope filing meets a plane-wide 502; the retry under the same key succeeds.
    if (faultClass === 'scope' && scopeFailures < 1) {
      scopeFailures++;
      posts.push({ at: now, class: faultClass, key, plannedFiles: body.plannedFiles ?? [], outcome: '502' });
      throw new RefusedResponse('Graphyard refused work (502): Application failed to respond', 502, null);
    }
    posts.push({ at: now, class: faultClass, key, plannedFiles: [...(body.plannedFiles ?? [])].sort(), outcome: 'created' });
    if (created.has(key)) return new Response(JSON.stringify(created.get(key)!), { status: 200 });
    const filed = item({
      id: `work-GY-${next}`, key: `GY-${next}`, title: body.title, description: body.description,
      stage: 'backlog', origin: body.origin, plannedFiles: body.plannedFiles ?? [], criteria: body.criteria,
      createdAt: iso(now), updatedAt: iso(now), stageEnteredAt: iso(now),
      // Released at once so the untriaged-backlog invariant stays held over the day.
      ready: true, triage: { judgement: { outcome: 'release', priority: 1, reason: 'soak' }, state: 'applied', by: 'master', at: iso(now) },
    });
    next++;
    created.set(key, filed);
    work.push(filed);
    return new Response(JSON.stringify(filed), { status: 201 });
  }) as typeof fetch;

  const deps = {
    snapshot: async () => ({ work: work.map(entry => structuredClone(entry)), now: iso(now) }),
    mutate: async () => { throw new Error('not used'); },
    executor: { principal: 'coordinator', instance: 'soak-fault-filing' },
    fetcher,
  };
  const wired = daemonEffects(root, { ...config(), operatorAgent: { id: 'graphyard-master-operator', credentialFile: token } } as MasterConfig, deps);
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: deps.snapshot, closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'soak', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    faultClassPolicy: { threshold: 3, windowHours: 24 },
    fileFaultClass: wired.fileFaultClass,
  } as unknown as DaemonEffects;

  const state = emptyDaemonState(config());
  const record = emptyInvariantRecord();
  let baseMoved = false;

  for (let n = 0; n < cycles; n++) {
    now = start + n * interval;
    state.cycle = n;
    // Three classes hit the threshold early; a fourth after the base moves.
    if (n === 2) for (const subject of ['GY-1', 'GY-2', 'GY-3'])
      noteFault(state.faults, { kind: 'scope-request', faultClass: 'scope', subject, text: 'needs files' }, iso(now));
    if (n === 40) for (const subject of ['GY-11', 'GY-12', 'GY-13'])
      noteFault(state.faults, { kind: 'decision-unanswered', faultClass: 'decision', subject, text: 'decision waited' }, iso(now));
    if (n === 80) for (const subject of ['GY-21', 'GY-22', 'GY-23'])
      noteFault(state.faults, { kind: 'review-conflict', faultClass: 'review-convergence', subject, text: 'reviews conflict' }, iso(now));
    // Mid-day: the base gains the resources proof test; the next class plans against that tip.
    if (n === 144 && !baseMoved) {
      await seedTree(root, [proof('resources')]);
      baseMoved = true;
    }
    if (n === 150) for (const subject of ['GY-31', 'GY-32', 'GY-33'])
      noteFault(state.faults, { kind: 'resource-bound', faultClass: 'resources', subject, text: 'tmp inodes' }, iso(now));
    // Later instances of an open class must link, never file again.
    if (n === 200) noteFault(state.faults, { kind: 'scope-request', faultClass: 'scope', subject: 'GY-99', text: 'another ask' }, iso(now));

    await runCycle(config(), state, effects, () => now);
    const violated = checkInvariants(record, { work, now }).filter(check => !check.holds);
    assert.deepEqual(violated.map(check => `${check.invariant}: ${check.reading}`), [], `cycle ${n}: every system invariant holds`);
    assert.ok(state.faults.instances.length <= retainedFaultInstances, `cycle ${n}: the fault record stays within its bound`);
  }

  const of = (faultClass: string) => posts.filter(entry => entry.class === faultClass);
  const createdOf = (faultClass: string) => of(faultClass).filter(entry => entry.outcome === 'created');

  // Scope: one 502, then one create under the same idempotency key, with derived plannedFiles.
  assert.deepEqual(of('scope').map(entry => entry.outcome), ['502', 'created'], `scope filing retries after 502: ${JSON.stringify(of('scope'))}`);
  assert.equal(of('scope')[0]!.key, of('scope')[1]!.key, 'the retry uses the same idempotency key');
  assert.deepEqual(createdOf('scope')[0]!.plannedFiles, [proof('scope'), ...companions].sort());

  // Decision and review-convergence each file once with their proof test and companions.
  assert.equal(createdOf('decision').length, 1, 'decision files once');
  assert.deepEqual(createdOf('decision')[0]!.plannedFiles, [proof('decision'), ...companions].sort());
  assert.equal(createdOf('review-convergence').length, 1, 'review-convergence files once');
  assert.deepEqual(createdOf('review-convergence')[0]!.plannedFiles, [proof('review-convergence'), ...companions].sort());

  // After the base moved, resources plans the proof file that tip holds.
  assert.equal(createdOf('resources').length, 1, 'resources files once after the base moved');
  assert.deepEqual(createdOf('resources')[0]!.plannedFiles, [proof('resources'), ...companions].sort());
  assert.ok(baseMoved, 'the base tip moved before the resources class filed');

  // Bounded: four classes, four creates; the late scope instance linked, no second scope create.
  assert.equal(posts.filter(entry => entry.outcome === 'created').length, 4, `one create per class: ${posts.map(entry => `${entry.class}:${entry.outcome}`).join(', ')}`);
  const scopeItem = work.find(entry => entry.origin?.faultClass?.class === 'scope')!;
  assert.ok(state.faults.instances.some(entry => entry.subject === 'GY-99' && entry.linkedTo === scopeItem.key), 'the late scope instance links to the open item');
  assert.ok(work.every(entry => (entry.plannedFiles?.length ?? 0) > 0), 'no fault-class filing lands with empty plannedFiles');
});
