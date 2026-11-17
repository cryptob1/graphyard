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
// use against its caps, and a session that sits at its cap for five minutes raises the overload
// alarm naming it: one journal line as it begins, an attention line in master status and an alert
// on the Workers page while it lasts.

const minute = 60_000, gib = 2 ** 30;
const start = Date.parse('2026-11-17T06:00:00Z');
const iso = (at: number) => new Date(at).toISOString();

async function fixture() {
  const directory = await temporaryDirectory('session-usage-shown');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  let now = start;
  // Two sessions on 2-core shares: the busy one burns its whole quota, the quiet one a tenth of a core.
  const usec = { busy: 0, quiet: 0 };
  const scopes = (): SessionScope[] => [
    { unit: 'graphyard-run-busy.scope', usec: usec.busy, memory: 3 * gib, cpuCap: 2, memoryCap: 5 * gib },
    { unit: 'graphyard-watch-1-quiet.scope', usec: usec.quiet, memory: 1 * gib, cpuCap: 2, memoryCap: 5 * gib },
  ];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(now) }), agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'working' }],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    masterSession: { wake: async () => {}, launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'account', session: 'registered-master' }) },
    sessionScopes: scopes, sessionName: unit => unit === 'graphyard-run-busy.scope' ? 'reviewer-GY-7' : undefined,
  };
  const state = emptyDaemonState(config), logged: string[] = [];
  return { state, logged,
    advance: (minutes: number) => { now += minutes * minute; usec.busy += minutes * minute * 1000 * 2; usec.quiet += minutes * minute * 1000 * 0.1; },
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

test('e2e:session-usage-shown — master status and the Workers page list each live session with its CPU and memory use and its cap', async () => {
  const yard = await fixture();
  await yard.cycle();
  yard.advance(1);
  await yard.cycle();
  const report = await yard.status() as any;
  assert.deepEqual(report.sessionUsage.map((entry: any) => [entry.session, entry.use]), [
    ['reviewer-GY-7', 'CPU 2.0 of 2 cores · memory 3.0 GiB of 5.0 GiB'],
    ['graphyard-watch-1-quiet.scope', 'CPU 0.1 of 2 cores · memory 1.0 GiB of 5.0 GiB'],
  ]);
  assert.ok(!report.attention.some((line: any) => /Overload/.test(line.text)), 'one minute at the cap raises no alarm');
  // The loop's coordination read carries them to the control plane, which serves them to the Workers page.
  const served = loopSessions(encodeLoopSessions(yard.state.sessions))!;
  const page = renderToStaticMarkup(createElement(SessionUsage, { sessions: served, now: yard.now() }));
  assert.match(page, /Session caps/);
  assert.match(page, /reviewer-GY-7.*2\.0 of 2 cores.*3\.0 GiB of 5\.0 GiB/s);
  assert.match(page, /graphyard-watch-1-quiet\.scope.*0\.1 of 2 cores.*1\.0 GiB of 5\.0 GiB/s);
  assert.doesNotMatch(page, /Overload/);
});

test('e2e:session-usage-shown — a session at its cap for 5 minutes raises the overload alarm naming it', async () => {
  const yard = await fixture();
  await yard.cycle();
  for (let cycles = 0; cycles < 5; cycles++) { yard.advance(1); await yard.cycle(); }
  assert.ok(!yard.logged.some(line => /overload/.test(line)), 'four minutes at the cap: no alarm yet');
  yard.advance(1); await yard.cycle();
  const alarms = yard.logged.filter(line => /overload/.test(line));
  assert.equal(alarms.length, 1);
  assert.match(alarms[0]!, /overload: Session reviewer-GY-7 has sat at its CPU cap for 5 min \(CPU 2\.0 of 2 cores/);
  yard.advance(1); await yard.cycle();
  assert.equal(yard.logged.filter(line => /overload/.test(line)).length, 1, 'the journal line is logged once, as the alarm begins');
  const report = await yard.status() as any;
  const attention = report.attention.filter((line: any) => /Overload/.test(line.text));
  assert.equal(attention.length, 1, 'only the session at its cap raises the alarm');
  assert.equal(attention[0].subject, 'reviewer-GY-7');
  assert.match(attention[0].text, /Overload: Session reviewer-GY-7 has sat at its CPU cap for 6 min/);
  const page = renderToStaticMarkup(createElement(SessionUsage, { sessions: loopSessions(encodeLoopSessions(yard.state.sessions))!, now: yard.now() }));
  assert.match(page, /role="alert" data-overload="reviewer-GY-7">Overload: Session reviewer-GY-7 has sat at its CPU cap for 6 min/);
  assert.doesNotMatch(page, /data-overload="graphyard-watch-1-quiet\.scope"/);
});
