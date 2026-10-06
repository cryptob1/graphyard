import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approverSessionName, atomicPrivateWrite, loadMasterConfig, runAutonomyCommand, setupMaster, type MasterConfig } from '../src/master.js';
// A namespace import, so the base exercise (where approverLaunchesFile does not exist) loads the file and fails the cases.
import * as autonomy from '../src/master/autonomy.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1339, 2026-10-06 ~01:16Z: the doctor ran its sanctioned `master approver GY-1335 DECISION`
// from the coordinator checkout bound read-only; the approver runtime started, then the launch
// record .graphyard/approvers/launches.json failed with EROFS and the launch was closed. The record
// now lives under the managed data root keyed by the checkout, fails over to the checkout when the
// data root refuses writes, and a record no location accepts never closes a started runtime.
// One case per proof: integration:doctor-approver-launch, unit:approver-launch-record-writable.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const decision = 'c3835bc8-93fc-47fd-ac09-31c0f8d0e9c2';
const runsAsRoot = process.getuid?.() === 0;

function item(): Work {
  const now = new Date().toISOString();
  return {
    id: 'work-1335', key: 'GY-1335', title: 'Rescope', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Rescoped', proofs: ['unit:rescope'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: 'build', revision: 4, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 0,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

async function boundCheckout(label: string) {
  const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-credentials`);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const approverToken = join(credentials, 'approver.token');
  await writeFile(approverToken, 'approver-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...await loadMasterConfig(root), approver: { id: 'graphyard-approver-project', credentialFile: approverToken } });
  const config: MasterConfig = { ...await loadMasterConfig(root), workers: [] };
  return { root, config, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** Runs `body` with GRAPHYARD_DATA_HOME naming `dataHome`, as the doctor's session inherits it from the loop. */
async function withDataHome<T>(dataHome: string, body: () => Promise<T>): Promise<T> {
  const was = process.env.GRAPHYARD_DATA_HOME;
  process.env.GRAPHYARD_DATA_HOME = dataHome;
  try { return await body(); }
  finally { if (was === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = was; }
}

/** `master approver GY-1335 DECISION claude` as the doctor runs it, against a stubbed Herdr that records every pane it is told to close. */
async function doctorApprover(root: string, config: MasterConfig, closed: string[]) {
  const herdr = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') return JSON.stringify({ result: { root_pane: { pane_id: 'pane-A', tab_id: 'tab-A' } } });
    if (args[0] === 'pane' && args[1] === 'close') closed.push(args[2]!);
    if (args[0] === 'tab' && args[1] === 'close') closed.push(args[2]!);
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  return await runAutonomyCommand(root, config, 'approver', ['GY-1335', decision, 'claude'], {
    coordinator: async () => ({ work: [item()], now: new Date().toISOString() }),
    readSecret: async () => '', agents: () => [], daemonLock: async () => null, runtime: herdr,
    mutate: async () => ({}),
  }) as { agentName: string; pane: string | null; unrecorded?: string };
}

/** Makes the checkout unwritable as the doctor's confinement binds it: its root and .graphyard refuse new files. */
async function readOnlyCheckout(root: string) {
  await mkdir(join(root, '.graphyard', 'approvers'), { recursive: true });
  for (const directory of [join(root, '.graphyard', 'approvers'), join(root, '.graphyard'), root]) await chmod(directory, 0o555);
  return async () => { for (const directory of [root, join(root, '.graphyard'), join(root, '.graphyard', 'approvers')]) await chmod(directory, 0o755); };
}

test('integration:doctor-approver-launch — master approver run from a read-only checkout launches the approver, records it under the data root and returns success', { skip: runsAsRoot ? 'root writes through read-only modes' : false }, async () => {
  const { root, config, cleanup } = await boundCheckout('doctor-approver');
  const dataHome = await temporaryDirectory('doctor-approver-data');
  const restore = await readOnlyCheckout(root);
  try {
    await withDataHome(dataHome, async () => {
      // Before the fix this wrote .graphyard/approvers/launches.json, failed with EACCES/EROFS, and
      // closed the started approver's pane.
      const closed: string[] = [];
      const launched = await doctorApprover(root, config, closed);
      const name = approverSessionName(item(), decision);
      assert.equal(launched.agentName, name);
      assert.equal(launched.pane, 'pane-A', 'the approver is launched');
      assert.equal(launched.unrecorded, undefined, 'its launch is recorded');
      assert.deepEqual(closed, [], 'the started approver is never closed for its bookkeeping');
      assert.equal(existsSync(join(root, '.graphyard', 'approvers', 'launches.json')), false, 'nothing is written into the read-only checkout');
      const file = autonomy.approverLaunchesFile(root, { GRAPHYARD_DATA_HOME: dataHome });
      assert.ok(file.startsWith(dataHome), 'the record lives under the managed data root');
      const record = await autonomy.readApproverLaunch(root, name);
      assert.equal(record?.work, 'GY-1335', 'the loop reads the record the doctor wrote, naming the item it judges');
      assert.equal(record?.decision, decision);
    });

    // With the record's place under the data root refusing writes too, the launch still succeeds
    // and says it is unrecorded: the started runtime judges its decision.
    const records = join(dataHome, 'approver-launches');
    await chmod(records, 0o555);
    try {
      await withDataHome(dataHome, async () => {
        const closed: string[] = [];
        const launched = await doctorApprover(root, config, closed);
        assert.equal(launched.pane, 'pane-A', 'the approver is launched');
        assert.deepEqual(closed, [], 'no location accepting the record never closes the started runtime');
        assert.match(launched.unrecorded ?? '', /approver launch record could not be written to .*approver-launches.* or .*\.graphyard\/approvers\/launches\.json/);
      });
    } finally { await chmod(records, 0o755); }
  } finally { await restore(); await cleanup(); }
});

test('unit:approver-launch-record-writable — the launch record is written under the data root, fails over to the checkout, and is returned unrecorded rather than thrown when both refuse', async () => {
  const root = await temporaryDirectory('launch-record'), dataHome = await temporaryDirectory('launch-record-data');
  const environment = { GRAPHYARD_DATA_HOME: dataHome };
  const launch = (agentName: string) => ({ agentName, account: 'env-a', runtime: 'claude', session: null, launchedAt: new Date().toISOString(), work: 'GY-1335', decision });
  const checkoutFile = join(root, '.graphyard', 'approvers', 'launches.json');
  const refusing = (codes: Record<string, string>) => async (file: string, value: unknown) => {
    const code = Object.entries(codes).find(([fragment]) => file.includes(fragment))?.[1];
    if (code) throw Object.assign(new Error(`${code}: read-only file system, open '${file}.tmp'`), { code });
    await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(value));
  };

  // A writable data root takes the record; the checkout is untouched.
  const written = await autonomy.saveApproverLaunch(root, launch('gy-approver-a'), Date.now(), { environment });
  assert.deepEqual(written, { file: autonomy.approverLaunchesFile(root, environment) });
  assert.equal(existsSync(checkoutFile), false);
  assert.equal(JSON.parse(await readFile(written.file!, 'utf8'))[0].agentName, 'gy-approver-a');

  // A data root that refuses writes fails over to the checkout, keeping the records already made.
  const failedOver = await autonomy.saveApproverLaunch(root, launch('gy-approver-b'), Date.now(), { environment, write: refusing({ 'approver-launches': 'EROFS' }) });
  assert.deepEqual(failedOver, { file: checkoutFile });
  assert.deepEqual(JSON.parse(await readFile(checkoutFile, 'utf8')).map((entry: { agentName: string }) => entry.agentName), ['gy-approver-a', 'gy-approver-b']);
  assert.deepEqual((await autonomy.readApproverLaunches(root, environment)).map(entry => entry.agentName), ['gy-approver-b', 'gy-approver-a'], 'both locations are read; the data root\'s record of a name wins');

  // Both refusing: the launch is returned unrecorded with each location and why, never thrown.
  for (const code of ['EROFS', 'EACCES', 'EPERM']) {
    const unrecorded = await autonomy.saveApproverLaunch(root, launch('gy-approver-c'), Date.now(), { environment, write: refusing({ 'approver-launches': code, '.graphyard': code }) });
    assert.equal(unrecorded.file, null);
    assert.match(unrecorded.unrecorded ?? '', new RegExp(`approver-launches.*\\(${code}: .* or .*launches\\.json \\(${code}: `));
  }

  // Any other failure is not a read-only location, and still fails the save.
  await assert.rejects(autonomy.saveApproverLaunch(root, launch('gy-approver-d'), Date.now(), { environment, write: refusing({ 'approver-launches': 'ENOSPC' }) }), /ENOSPC/);

  // Checkout records past a day are aged out on read, since that file is rewritten only on failover.
  await writeFile(checkoutFile, JSON.stringify([{ ...launch('gy-approver-old'), launchedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }]));
  assert.equal((await autonomy.readApproverLaunches(root, environment)).some(entry => entry.agentName === 'gy-approver-old'), false);
});
