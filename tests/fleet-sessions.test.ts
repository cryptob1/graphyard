import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetRequestTimeoutMs, fleetRoleHealth, selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { masterConfigSchema, sessionName, type HerdrAgent, type MasterConfig } from '../src/master.js';
import { applyRegistryMutation, chooseSession, emptyRegistry, liveSessions, proposedRuntimes, supersededByRequest, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-190: on 2026-09-24 a rework approver could not launch because the approver role was "at its
 * concurrency limit (7 of 7 live)" while none of those seven approvers was running: each had judged
 * its decision and exited, and nothing ended the registry session it had been launched on. A
 * registry session now ends with the session it records, and the role counts only sessions that run.
 */

const HOST = 'machine-a';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000;
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function config(): Promise<MasterConfig> {
  const directory = await temporaryDirectory('fleet-sessions'); directories.push(directory);
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'coordinator.token'), cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [] });
}

/**
 * The control plane's registry, in memory: selection supersedes, counts and chooses exactly as the
 * server does (the same pure functions), and `end` records the end with its reason.
 */
function memoryRegistry(concurrency: number) {
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: null }],
    accounts: [{ name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: HOST, home: null } }],
    roles: [{ name: 'approver', accounts: ['claude-b'], concurrency }], reason: 'fixture',
  }, { actor: 'operator', at: iso(-60 * minute) }).registry;
  let time = clock;
  const record = (work: string, selectedAt: string): FleetSession => {
    const session: FleetSession = { id: randomUUID(), role: 'approver', account: 'claude-b', runtime: 'claude', model: 'opus', host: HOST, work, principal: 'approver-agent',
      selectedAt, selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null };
    registry.sessions.push(session);
    return session;
  };
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      const at = new Date(time).toISOString();
      for (const superseded of supersededByRequest(registry, request)) Object.assign(superseded, { endedAt: at, endReason: 'superseded' });
      const choice = chooseSession(registry, request, time);
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const session = record(request.work!, at);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, revision: registry.revision };
    },
    end: async (id, reason) => { const session = registry.sessions.find(entry => entry.id === id); if (session && !session.endedAt) Object.assign(session, { endedAt: new Date(time).toISOString(), endReason: reason }); },
  };
  return { client, record, at: (now: number) => { time = now; }, live: () => liveSessions(registry).filter(session => session.role === 'approver'), all: () => registry.sessions };
}

test('unit:concurrency-counts-live-only — with 7 recorded approver sessions and none running, the role is available and a launch selects an account', async () => {
  const cfg = await config(), fleet = memoryRegistry(7);
  const works = ['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6', 'GY-7'];
  for (const key of works) fleet.record(key, iso(-10 * minute));
  fleet.at(clock);
  const probe = { registry: fleet.client, now: () => clock };
  const none = { agents: [] as HerdrAgent[], available: true };

  // What the registry records alone reads the role as full; what runs says otherwise.
  assert.match((await fleetRoleHealth(cfg, 'approver', probe))!.reason!, /at its concurrency limit \(7 of 7 live\)/);
  const health = await fleetRoleHealth(cfg, 'approver', { ...probe, runtime: none });
  assert.equal(health?.available, true, 'no session runs, so the role is available');
  assert.equal(health?.reason, null);
  // Sessions that do run still count, and an unreadable Herdr proves nothing gone.
  const running = { agents: works.map(key => ({ name: `${sessionName('graphyard-approver', key)}-eeeeeeee` }) as HerdrAgent), available: true };
  assert.equal((await fleetRoleHealth(cfg, 'approver', { ...probe, runtime: running }))?.available, false, 'seven running approvers fill the role');
  assert.equal((await fleetRoleHealth(cfg, 'approver', { ...probe, runtime: { agents: [], available: false } }))?.available, false, 'an unreadable inventory does not free a slot');

  const selected = await selectFleetSession(cfg, 'approver', { name: 'graphyard-approver-gy-9-abcdef12', principal: 'approver-agent' }, { ...probe, work: 'GY-9', runtime: none });
  assert.equal(selected?.account.name, 'claude-b', 'a launch selects an account');
  assert.deepEqual(fleet.live().map(session => session.work), ['GY-9'], 'the seven sessions that no longer run were ended before the choice');
  assert.ok(fleet.all().filter(session => works.includes(session.work!)).every(session => /is gone from Herdr/.test(session.endReason ?? '')), 'each with the reason it ended');
});

test('unit:registry-request-outlasts-lock-queue — a registry request waits 30 s, so a selection queued behind the coordination lock is not abandoned while the server completes it', () => {
  // 2026-10-01: 45 of 46 selects were abandoned at a 10 s bound; each still completed server-side and left a phantom live session.
  assert.ok(fleetRequestTimeoutMs >= 30_000, 'the registry request bound covers the coordination lock queue');
  // Every registry client takes that bound: heldAwareProbe built its own with a literal 10 s, which kept
  // every dispatch failing while any account was held spent.
  // A literal is refused however it is passed (GY-1042): as a fallback (`?? 10_000`), as the third
  // argument itself (`httpFleetClient(cfg, fetch, 10_000)`), or as a request's `timeoutMs: 10_000`.
  const sources = execFileSync('grep', ['-rlE', 'httpFleetClient\\(|fleetRequest\\(', fileURLToPath(new URL('../src', import.meta.url))], { encoding: 'utf8' }).trim().split('\n');
  const literal = /^\s*(?:[^,]*\?\?\s*)?\d[\d_]*(?:\s*\*\s*\d[\d_]*)*\s*$/;
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const call of fleetCalls(text, 'httpFleetClient')) assert.doesNotMatch(call[2] ?? '', literal, `${file} passes a literal timeout to httpFleetClient: ${call.join(', ')}`);
    for (const call of fleetCalls(text, 'fleetRequest')) assert.doesNotMatch(call.slice(2).join(', '), /\btimeoutMs\s*:\s*(?:[^,}]*\?\?\s*)?\d/, `${file} passes a literal timeoutMs to fleetRequest: ${call.join(', ')}`);
  }
  // The guard itself refuses each form.
  assert.match(fleetCalls('httpFleetClient(cfg, fetch, 10_000);', 'httpFleetClient')[0][2], literal);
  assert.match(fleetCalls('httpFleetClient(cfg, fetch, probe.timeoutMs ?? 10_000);', 'httpFleetClient')[0][2], literal);
  assert.doesNotMatch(fleetCalls('httpFleetClient(cfg, fetch, probe.timeoutMs ?? fleetRequestTimeoutMs);', 'httpFleetClient')[0][2], literal);
  assert.match(fleetCalls("fleetRequest(cfg, 'x', { fetch, timeoutMs: 10_000 });", 'fleetRequest')[0].slice(2).join(', '), /\btimeoutMs\s*:\s*(?:[^,}]*\?\?\s*)?\d/);
});

/** Each call of `name` in `text`, as its top-level arguments' source text (nested brackets and strings kept whole); a declaration is skipped. */
function fleetCalls(text: string, name: string): string[][] {
  const calls: string[][] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    if (/function\s+$/.test(text.slice(Math.max(0, match.index! - 20), match.index))) continue;
    const args: string[] = [];
    let depth = 0, quote: string | null = null, current = '';
    for (let index = match.index! + match[0].length; index < text.length; index++) {
      const char = text[index];
      if (quote) { current += char; if (char === '\\') current += text[++index]; else if (char === quote) quote = null; continue; }
      if (char === '\'' || char === '"' || char === '`') { quote = char; current += char; continue; }
      if ('([{'.includes(char)) depth++;
      if (')]}'.includes(char)) { if (depth === 0) { args.push(current.trim()); break; } depth--; }
      if (char === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
      current += char;
    }
    calls.push(args);
  }
  return calls;
}
