import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyDaemonState, daemonStatePath } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { encodeLoopSessions, loopSessions } from '../src/model/loop-presence.js';
import type { SessionScope } from '../src/session-share.js';
import { SessionUsage } from '../web/pages/workers.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// e2e:session-usage-shown — GY-3438: the loop reads every live agent session's scope from its
// cgroup each cycle. Master status and the Workers page list each session with its CPU and memory
// use beside its fair share. The overload alarm names a session only when the machine is saturated
// and that session has used far more than its share for five minutes: one journal line as it
// begins, an attention line in master status and an alert on the Workers page while it lasts. One
// session using an otherwise idle machine raises nothing.

const minute = 60_000, gib = 2 ** 30;
const start = Date.parse('2026-11-17T06:00:00Z');
const iso = (at: number) => new Date(at).toISOString();

async function fixture() {
  const directory = await temporaryDirectory('session-usage-shown');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  let now = start, pressure = 2;
  // Four sessions on a 24-core host, a 6-core share each: the greedy one runs 14 cores, the others one each.
  const rates: Record<string, number> = { 'graphyard-run-greedy.scope': 14, 'graphyard-watch-1-a.scope': 1, 'graphyard-watch-2-b.scope': 1, 'graphyard-watch-3-c.scope': 1 };
  const usec: Record<string, number> = Object.fromEntries(Object.keys(rates).map(unit => [unit, 0]));
  const scopes = (): SessionScope[] => Object.keys(rates).map(unit => ({ unit, usec: usec[unit]!, memory: (unit.includes('greedy') ? 3 : 1) * gib, memoryShare: 16 * gib }));
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(now) }), agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'working' }],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    masterSession: { wake: async () => {}, launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'account', session: 'registered-master' }) },
    cpuPressure: async () => ({ pressure: `some avg10=${pressure}.00 avg60=${pressure}.00 avg300=${pressure}.00 total=1\n`, stat: null }),
    sessionScopes: scopes, sessionName: unit => unit === 'graphyard-run-greedy.scope' ? 'reviewer-GY-7' : undefined, cores: () => 24,
  };
  const state = emptyDaemonState(config), logged: string[] = [];
  return { state, logged,
    saturate: (avg60: number) => { pressure = avg60; },
    only: (unit: string) => { for (const other of Object.keys(rates)) if (other !== unit) delete rates[other]; },
    advance: (minutes: number) => { now += minutes * minute; for (const unit of Object.keys(rates)) usec[unit]! += minutes * minute * 1000 * rates[unit]!; },
    cycle: () => runCycle(config, state, effects, () => now, undefined, line => logged.push(line)),
    now: () => now,
    status: async () => {
      await writeFile(daemonStatePath(config), JSON.stringify(state));
      const root = await temporaryDirectory('session-usage-shown-status');
      execFileSync('git', ['init', '-q', root]);
      return masterStatusReport(root, config, async () => ({ work: [], now: iso(now) }), async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [{ name: 'master', pane_id: 'pM', agent_status: 'working' }] }) : 'Coordinating work.') : `${'b'.repeat(40)}\n`);
    },
  };
}
const page = (yard: Awaited<ReturnType<typeof fixture>>) => renderToStaticMarkup(createElement(SessionUsage, { sessions: loopSessions(encodeLoopSessions(yard.state.sessions))!, now: yard.now() }));
const alarms = (yard: Awaited<ReturnType<typeof fixture>>) => yard.logged.filter(line => /overload/.test(line));

test('e2e:session-usage-shown — master status and the Workers page list each live session with its CPU and memory use and its share', async () => {
  const yard = await fixture();
  await yard.cycle();
  yard.advance(1);
  await yard.cycle();
  const report = await yard.status() as any;
  assert.deepEqual(report.sessionUsage.map((entry: any) => [entry.session, entry.use]), [
    ['reviewer-GY-7', 'CPU 14.0 cores, share 6 · memory 3.0 GiB, share 16.0 GiB'],
    ['graphyard-watch-1-a.scope', 'CPU 1.0 cores, share 6 · memory 1.0 GiB, share 16.0 GiB'],
    ['graphyard-watch-2-b.scope', 'CPU 1.0 cores, share 6 · memory 1.0 GiB, share 16.0 GiB'],
    ['graphyard-watch-3-c.scope', 'CPU 1.0 cores, share 6 · memory 1.0 GiB, share 16.0 GiB'],
  ]);
  // The loop's coordination read carries them to the control plane, which serves them to the Workers page.
  const html = page(yard);
  assert.match(html, /Session usage/);
  assert.match(html, /reviewer-GY-7.*14\.0 cores.*share 6.*3\.0 GiB.*share 16\.0 GiB/s);
  assert.match(html, /graphyard-watch-1-a\.scope.*1\.0 cores.*share 6.*1\.0 GiB.*share 16\.0 GiB/s);
});

test('e2e:session-usage-shown — the overload alarm stays quiet while the machine is not saturated, even for a session far over its share or alone on an idle machine', async () => {
  const yard = await fixture();
  await yard.cycle();
  for (let cycles = 0; cycles < 10; cycles++) { yard.advance(1); await yard.cycle(); }
  assert.deepEqual(alarms(yard), [], 'ten minutes far over its share of an unsaturated machine: no alarm');
  yard.only('graphyard-run-greedy.scope');
  for (let cycles = 0; cycles < 10; cycles++) { yard.advance(1); await yard.cycle(); }
  assert.equal(yard.state.sessions[0]!.cpuShare, 24, 'a lone session\'s share is the whole machine');
  assert.deepEqual(alarms(yard), []);
  const report = await yard.status() as any;
  assert.ok(!report.attention.some((line: any) => /Overload/.test(line.text)));
  assert.doesNotMatch(page(yard), /Overload/);
});

test('e2e:session-usage-shown — on a saturated machine, a session using far more than its share for 5 minutes raises the overload alarm naming it', async () => {
  const yard = await fixture();
  yard.saturate(70);
  await yard.cycle();
  for (let cycles = 0; cycles < 5; cycles++) { yard.advance(1); await yard.cycle(); }
  assert.deepEqual(alarms(yard), [], 'four minutes over its share: no alarm yet');
  yard.advance(1); await yard.cycle();
  assert.equal(alarms(yard).length, 1);
  assert.match(alarms(yard)[0]!, /overload: Session reviewer-GY-7 has used far more than its share of a saturated machine for 5 min \(CPU 14\.0 cores, share 6/);
  yard.advance(1); await yard.cycle();
  assert.equal(alarms(yard).length, 1, 'the journal line is logged once, as the alarm begins');
  const report = await yard.status() as any;
  const attention = report.attention.filter((line: any) => /Overload/.test(line.text));
  assert.equal(attention.length, 1, 'only the session far over its share raises the alarm');
  assert.equal(attention[0].subject, 'reviewer-GY-7');
  assert.match(attention[0].text, /Overload: Session reviewer-GY-7 has used far more than its share of a saturated machine for 6 min/);
  const html = page(yard);
  assert.match(html, /role="alert" data-overload="reviewer-GY-7">Overload: Session reviewer-GY-7 has used far more than its share/);
  assert.doesNotMatch(html, /data-overload="graphyard-watch/);
  // The pressure falls: the alarm clears.
  yard.saturate(10); yard.advance(1); await yard.cycle();
  assert.ok(!(await yard.status() as any).attention.some((line: any) => /Overload/.test(line.text)));
});
