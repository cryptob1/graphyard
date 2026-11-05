import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { isHerdrCommand, herdrSubcommand } from '../src/master/herdr.js';
import { emptyRegistry, fleetView, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { Work } from '../src/model/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3095 AC-1: on 2026-11-04/05 nothing could launch for about 2.5 hours — the master role's one
 * slot was held and the reviewer's only account was spent — yet master status read as normal.
 * Master status now names each stopped role under attention: the role, the refusal, how long it
 * has lasted and the next command.
 */

const HOST = 'machine-a', clock = Date.parse('2026-11-05T02:30:00Z');
const iso = (at: number) => new Date(at).toISOString();
const minutes = (count: number) => count * 60_000;

async function config(): Promise<MasterConfig> {
  const directory = await temporaryDirectory('stopped-role');
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: `${directory}/coordinator.token`, cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master', workers: [] });
}

const session = (id: string, role: string, account: string, work: string | null, at: number): FleetSession => ({ id, role, account, runtime: 'codex', model: 'gpt', host: HOST, work, principal: 'p',
  selectedAt: iso(at), selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null }) as FleetSession;
const account = (name: string, quota = { ...unobservedQuota }) => ({ name, runtime: 'codex', model: 'gpt', enabled: true, credential: { host: HOST, home: null }, quota });

/** The incident's registry: master held by an orphan for 2.5 h, reviewer on one spent account, a worker role busy with work. */
function registry(refusedFor: { master: number; reviewer: number }): AgentRegistry {
  const spent = { ...unobservedQuota, state: 'exhausted', resetsAt: '2026-11-05T21:00:00Z', observedAt: iso(clock - minutes(5)), source: 'probe' };
  const masterRefusal = 'role master is at its concurrency limit (1 of 1 live: codex-master)';
  const reviewerRefusal = 'no eligible account for reviewer: codex-review quota is exhausted until 2026-11-05T21:00:00Z';
  return { ...emptyRegistry(), revision: 51_000, runtimes: proposedRuntimes.filter(runtime => runtime.name === 'codex'), models: [{ name: 'gpt', id: null }],
    accounts: [account('codex-master'), account('codex-review', spent), account('codex-a'), account('codex-b')],
    roles: [{ name: 'master', accounts: ['codex-master'], concurrency: 1, policy: {} }, { name: 'reviewer', accounts: ['codex-review'], concurrency: 2, policy: {} },
      { name: 'worker', accounts: ['codex-a', 'codex-b'], concurrency: 2, policy: {} }],
    sessions: [session('orphan', 'master', 'codex-master', null, clock - minutes(600)), session('w1', 'worker', 'codex-a', 'GY-1', clock - minutes(20)), session('w2', 'worker', 'codex-b', 'GY-2', clock - minutes(10))],
    refusals: [
      { at: iso(clock - refusedFor.master), role: 'master', host: HOST, work: null, by: 'coordinator', reason: masterRefusal, skipped: [] },
      { at: iso(clock - refusedFor.reviewer), role: 'reviewer', host: HOST, work: 'GY-1', by: 'coordinator', reason: reviewerRefusal, skipped: [] },
      { at: iso(clock - minutes(30)), role: 'worker', host: HOST, work: 'GY-3', by: 'coordinator', reason: 'role worker is at its concurrency limit (2 of 2 live: codex-a on GY-1, codex-b on GY-2)', skipped: [] },
    ] } as unknown as AgentRegistry;
}

/** master status over a control plane answering the work snapshot and the registry as this host sees it. */
async function report(master: MasterConfig, document: AgentRegistry, work: Work[] = []) {
  const api = async (path: string) => {
    if (path === 'work-snapshot') return { work, now: iso(clock) };
    if (path === `agent-registry?host=${HOST}`) return fleetView(document, clock, HOST);
    throw new Error(`unexpected read ${path}`);
  };
  return masterStatusReport('.', master, api, async (command, args) => {
    if (!isHerdrCommand(command)) return 'a'.repeat(40);
    return herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '';
  });
}

test('e2e:status-names-stopped-role — a role with no usable account, or refused for a full cycle, is named under attention with its refusal, how long and the next command', async () => {
  const master = await config();
  const status = await report(master, registry({ master: minutes(150), reviewer: minutes(150) }));
  const byRole = Object.fromEntries(status.attention.map(entry => [entry.role, entry]));
  assert.deepEqual(Object.keys(byRole).sort(), ['master', 'reviewer'], 'a worker role at its limit with every slot carrying work is busy, not stopped');

  const held = byRole.master;
  assert.equal(held.refusal, 'role master is at its concurrency limit (1 of 1 live: codex-master)');
  assert.equal(held.lasted, '2h 30m');
  assert.equal(held.since, iso(clock - minutes(150)));
  assert.match(held.next, /graphyard master registry session end SESSION_ID --reason REASON/);
  assert.match(held.text, /^Stopped: role master cannot launch — role master is at its concurrency limit .* \(refused for 2h 30m, since 2026-11-05T00:00:00\.000Z\)\. Next: /);

  const spent = byRole.reviewer;
  assert.match(spent.refusal, /^no eligible account for reviewer: codex-review quota is exhausted/);
  assert.equal(spent.lasted, '2h 30m');
  assert.match(spent.next, /graphyard master registry role set reviewer ACCOUNT\[,ACCOUNT…\] --reason REASON, or wait for the first quota reset at 2026-11-05T21:00:00Z/);

  // Within one cycle a held slot is a launch in flight, not a stop; a role with no usable account is stopped at once, even before any refusal is recorded.
  const fresh = await report(master, registry({ master: 10_000, reviewer: 10_000 }));
  assert.deepEqual(fresh.attention.map(entry => entry.role), ['reviewer']);
  const unrecorded = registry({ master: minutes(150), reviewer: minutes(150) });
  unrecorded.refusals = [];
  const named = await report(master, unrecorded);
  assert.deepEqual(named.attention.map(entry => [entry.role, entry.lasted]), [['reviewer', null]]);

  // Nothing stopped: attention is empty.
  const healthy = registry({ master: minutes(150), reviewer: minutes(150) });
  healthy.sessions = healthy.sessions.filter(entry => entry.id !== 'orphan');
  healthy.accounts = healthy.accounts.map(entry => ({ ...entry, quota: { ...unobservedQuota } }));
  assert.deepEqual((await report(master, healthy)).attention, []);
});
