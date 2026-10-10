import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { clearDoctorRuns, doctorBounds, doctorRunsSettled, type DoctorEffects } from '../src/daemon/doctor.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import type { Runner } from '../src/runner/types.js';
import * as pi from '../integrations/pi/index.js';

/**
 * GY-1653. The doctor's unblocks through its command allowlist over two simulated days of the real
 * loop: a cycle every two minutes, the doctor every ten. Items go blocked on a schedule with the
 * stuck-gate reasons the 2026-10-10 run was refused on — prose holding "most recent", "last
 * attempt", semicolons, parentheses, a dollar sign and apostrophes — and the same item goes blocked
 * again later with the same reason. Each doctor run is a scripted Pi session that reads the shipped
 * prompt's evidence, writes `node CLI master unblock GY-N '<reason>'` exactly as a model would (the
 * reason naively single-quoted), and passes it through the shipped extension's real tool_call hook
 * under the environment the loop gives the session, then runs whatever the hook leaves through bash
 * against a stand-in CLI that logs its arguments and clears the blocker. Both the prompt and the
 * guard repeat per run and per item, so after every cycle and at the end: every system invariant
 * holds, nothing is isolated or failed, no command is refused, every blocked episode reaches the CLI
 * exactly once with its reason whole, nothing is unblocked twice or left blocked past its bound, and
 * every doctor run reports.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-10T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const step = 2 * minute, days = 2;

/** The stuck-gate reasons, as the master would write them; several break the shell when single-quoted as written. */
const reasons = [
  'GY-1652 was blocked 25 min; requirements revised at 14:40 (policy revision 2)',
  'the item\'s last fail predates the fix; most recent attempt is green',
  'the most recent attempt passed; last attempt\'s CI is green',
  'most recent attempt passed (policy revision 2); unblock costs $0',
  'the item\'s requirements were revised and the most recent attempt\'s CI is green',
  'stale blocker: merge dispatch evidence claim already settled; git push not needed',
];
const keys = ['GY-201', 'GY-202', 'GY-203', 'GY-204', 'GY-205', 'GY-206'];

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 120 } });
}
function item(key: string, at: number): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}

test('unit:soak-doctor-unblock-prose — over two simulated days every stuck-gate unblock the doctor writes with a prose reason passes its allowlist and reaches the CLI once with the reason whole, and every system invariant holds', { timeout: 300_000 }, async () => {
  clearDoctorRuns();
  const directory = mkdtempSync(join(tmpdir(), 'gy-1653-soak-'));
  const cli = join(directory, 'graphyard.mjs'), log = join(directory, 'calls.jsonl');
  // The stand-in CLI: it logs the arguments the shell gave it, one line per invocation.
  writeFileSync(cli, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  writeFileSync(log, '');
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);

  // The shipped extension's tool_call hook, registered once, as a Pi session loads it.
  const hooks: Record<string, (event: any, ctx: any) => unknown> = {};
  pi.default({ registerTool: () => {}, on: (event, handler) => { hooks[event] = handler as never; return handler; } });

  let now = start;
  const state = emptyDaemonState(config());
  const work = new Map(keys.map(key => [key, item(key, start - hour)]));
  // The schedule: every 40 minutes the next item goes blocked with its reason, round the six items,
  // so over two days each item is blocked again many times with the same reason.
  const episodes: { key: string; reason: string; at: number; clearedAt: number | null }[] = [];
  const blockDue = (at: number) => {
    const slot = Math.floor((at - start) / (40 * minute));
    if (slot < 0 || episodes.length > slot) return;
    const index = slot % keys.length, key = keys[index], current = work.get(key)!;
    if (current.blocker) return;
    episodes.push({ key, reason: reasons[index], at, clearedAt: null });
    Object.assign(current, { blocker: reasons[index], revision: current.revision + 1, updatedAt: iso(at) });
  };

  let doctorRuns = 0;
  const refused: string[] = [], prompts: string[] = [];
  const doctor: DoctorEffects = {
    settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: process.cwd(), env: { GRAPHYARD_DOCTOR_CLI: cli },
    runner: async () => ({ runtime: 'pi', model: 'soak/doctor', release: async () => {}, runner: { name: 'pi', start: (prompt: string, options: { tool: string; cwd: string; env: Record<string, string> }) => {
      const index = doctorRuns++;
      prompts.push(prompt);
      const evidence = JSON.parse(prompt.slice(prompt.indexOf('The evidence, as JSON:\n') + 'The evidence, as JSON:\n'.length)) as { items: string[] };
      const findings: { subject: string; check: 'blocked'; detail: string; unactionable: boolean }[] = [];
      const actions: { subject: string; command: string; outcome: 'applied' | 'refused'; detail: string }[] = [];
      for (const line of evidence.items) {
        const match = /^(GY-\d+) .*?\] blocker: (.+)$/.exec(line);
        if (!match) continue;
        const [, key, reason] = match, episode = episodes.find(entry => entry.key === key && entry.clearedAt === null)!;
        if (now - episode.at <= doctorBounds.blockedMinutes * minute) continue;
        findings.push({ subject: key, check: 'blocked', detail: `blocked past the ${doctorBounds.blockedMinutes} min bound`, unactionable: false });
        // The command as the model writes it, the reason single-quoted whatever it holds.
        const input = { command: `node ${options.env.GRAPHYARD_DOCTOR_CLI} master unblock ${key} '${reason}'` };
        const saved = { ...process.env };
        let verdict: { block?: boolean; reason?: string } | undefined;
        try { Object.assign(process.env, options.env); verdict = hooks.tool_call({ toolName: 'bash', input }, { cwd: options.cwd }) as typeof verdict; }
        finally { for (const name of Object.keys(options.env)) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
        if (verdict?.block) { refused.push(`${key}: ${verdict.reason}`); actions.push({ subject: key, command: input.command, outcome: 'refused', detail: verdict.reason!.slice(0, 1000) }); continue; }
        const before = calls().length;
        execFileSync('bash', ['-c', input.command], { cwd: options.cwd });
        const ran = calls().slice(before);
        // The control plane applies the unblock the CLI submitted.
        if (ran.length === 1 && ran[0][1] === 'unblock') {
          const current = work.get(ran[0][2])!;
          Object.assign(current, { blocker: null, revision: current.revision + 1, updatedAt: iso(now) });
          episode.clearedAt = now;
        }
        actions.push({ subject: key, command: input.command.slice(0, 500), outcome: 'applied', detail: `unblocked ${key}` });
      }
      const payload = { findings, actions, filed: [] };
      return { id: `soak-doctor-${index}`, events: [], onEvent: () => () => {}, cancel: () => {}, result: async () => ({ ok: true as const, tool: options.tool, payload, payloads: [payload] }) };
    } } as unknown as Runner }),
    file: async () => { throw new Error('the doctor files nothing on this day'); },
    recordRun: async () => {},
  };
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [...work.values()].map(entry => structuredClone(entry)), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: 'd'.repeat(40), at: iso(now), reason: null, deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    doctor,
  } as unknown as DaemonEffects;

  try {
    const violations: string[] = [];
    for (let cycle = 0; now < start + days * 24 * hour; cycle++, now += step) {
      blockDue(now);
      await runCycle(config(), state, effects, () => now);
      await doctorRunsSettled();
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);
      assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('isolated:')), [], `cycle ${cycle}: a failure reached an isolation record`);
      // No episode stands blocked past its bound plus one doctor interval and one cycle.
      for (const episode of episodes) if (episode.clearedAt === null)
        assert.ok(now - episode.at <= (doctorBounds.blockedMinutes + 10) * minute + step, `cycle ${cycle}: ${episode.key} blocked since ${iso(episode.at)} was never unblocked`);
    }
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
    assert.deepEqual(refused, [], 'the allowlist refused no unblock all day');
    assert.deepEqual(Object.entries(state.actions).filter(([, action]) => action.state === 'failed').map(([key, action]) => `${key}: ${action.detail}`), [], 'no step failed');

    // One submission per blocked episode, each reason whole, nothing unblocked twice.
    const unblocks = calls();
    assert.ok(episodes.length >= 60, `items went blocked through the two days: ${episodes.length}`);
    const settled = episodes.filter(episode => episode.clearedAt !== null);
    assert.ok(episodes.length - settled.length <= 1, 'every episode but one still inside its bound at the day\'s end was unblocked');
    assert.deepEqual(unblocks, settled.map(episode => ['master', 'unblock', episode.key, episode.reason]), 'each episode reached the CLI exactly once, in order, with its reason as one argument');
    for (const [index, reason] of reasons.entries())
      assert.ok(settled.filter(episode => episode.reason === reason).length >= 8, `${keys[index]} was blocked and unblocked again and again with the same reason`);

    // The doctor ran once per interval, every run reported, and every applied action is what it ran.
    assert.ok(doctorRuns >= 280 && doctorRuns <= 290, `one doctor run per ten minutes over two days: ${doctorRuns}`);
    assert.ok(prompts.every(prompt => prompt.includes('Put a free-text reason last, enclosed in one pair of quotes')), 'every run was told where the reason goes');
    assert.ok(!state.doctor.runs.some(run => run.state !== 'reported'), `every retained doctor run applied its report: ${state.doctor.runs.map(run => run.state).join(', ')}`);
    assert.ok(state.doctor.runs.flatMap(run => run.actions).every(action => action.outcome === 'applied'), 'no retained run recorded a refused command');
  } finally {
    clearDoctorRuns();
    rmSync(directory, { recursive: true, force: true });
  }
});
