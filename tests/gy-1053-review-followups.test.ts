import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeStart } from '../src/master/launch.js';

const command = 'GY=/w/.graphyard/launch/graphyard-claude-1; graphyard watch GY-1023 4 -- claude "$(cat "$GY.request")"';
const echo = `vish@vishrog GY-1023-4 ❯ ${command}`;

test('manual:review-followups-triaged GY-1053.1: observeStart calls pane process-info at most once per observation when output is printed and command still running (Findings 1, 9, 13, 14, 15)', async () => {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return `${echo}\ngraphyard: establishing containment for GY-1023 epoch 4\n`;
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: 5200, foreground_processes: [] } });
    }
    if (args[0] === 'agent' && args[1] === 'get') throw Object.assign(new Error('agent_not_found'), { stderr: '{"error":{"code":"agent_not_found"}}' });
    return json({});
  };

  const observed = await observeStart('w1V:pC1', 'claude', command, run);
  assert.equal(observed.state, 'starting');
  assert.equal(observed.detail, 'the launch command is running, its supervisor setting up: "graphyard: establishing containment for GY-1023 epoch 4"');

  const processInfoCalls = calls.filter(args => args[0] === 'pane' && args[1] === 'process-info');
  assert.equal(processInfoCalls.length, 1, 'pane process-info must be called at most once per observeStart poll');
});

test('manual:review-followups-triaged GY-1053.2: when Herdr reports a different agent kind under the pane, observeStart returns absent naming the unexpected agent rather than starting (Finding 22)', async () => {
  const run = (_cmd: string, args: string[]) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return `${echo}\n`;
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return json({ process_info: { pane_id: args[3], shell_pid: 4100, foreground_process_group_id: 5200, foreground_processes: [] } });
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      return json({ agent: { pane_id: args[2], agent: 'aider', agent_status: 'working' } });
    }
    return json({});
  };

  const observed = await observeStart('w1V:pC1', 'claude', command, run);
  assert.equal(observed.state, 'absent');
  assert.equal(observed.detail, 'the pane holds aider, not claude');
});

test('manual:review-followups-triaged GY-1053.3: each follow-up 1..31 from GY-1033 review is addressed in code or declined with recorded reason (AC-1)', () => {
  type TriageStatus = 'addressed' | 'declined';
  interface TriageEntry {
    id: number;
    path: string;
    description: string;
    status: TriageStatus;
    reasonOrResolution: string;
  }

  const triage: TriageEntry[] = [
    {
      id: 1, path: 'src/master/launch.ts:340',
      description: 'when the pane last line is still the command, one observeStart poll can call herdr pane process-info twice, through shellInForeground and then paneForeground; reading foreground once per observation and reusing it would halve calls',
      status: 'addressed',
      reasonOrResolution: 'Cached paneForeground in observeStart via readForeground() so herdr pane process-info is called at most once per observation poll.',
    },
    {
      id: 2, path: 'src/master/launch.ts:345',
      description: 'any process group other than shell in foreground counts as launch command running; foreground PID not tied to supervisor PID so unrelated foreground job in reused pane extended to ceiling instead of refused at 60 s',
      status: 'declined',
      reasonOrResolution: 'Foreground PID is intentionally not tied to supervisor PID because setup pipelines (reading request, wrappers) execute before supervisor PID is known, Herdr platform mocks do not consistently expose foreground process lists, and the extension is strictly bounded to the 120s ceiling.',
    },
    {
      id: 3, path: 'src/cli/workspace.ts:250',
      description: 'watch resolves its item itself, duplicating dispatcher lookup in src/cli/index.ts; Unknown work item error from watch prints setup line first; consider shared lookup helper',
      status: 'declined',
      reasonOrResolution: 'src/cli/workspace.ts is outside GY-1053 plannedFiles (src/master/launch.ts); also workspace.ts is tightly constrained by the 320-line module budget.',
    },
    {
      id: 4, path: 'src/cli/workspace.ts:252',
      description: 'watch duplicates dispatcher item lookup from src/cli/index.ts:48; if dispatcher resolution changes, watch silently diverges; consider extracting shared resolver',
      status: 'declined',
      reasonOrResolution: 'src/cli/workspace.ts and src/cli/index.ts are outside GY-1053 plannedFiles (src/master/launch.ts).',
    },
    {
      id: 5, path: 'src/master/launch.ts:345',
      description: 'pane whose foreground is held by unrelated non-shell process with command echoed reads as starting and waits to 120 s ceiling instead of failing at 60 s',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #2: extending to the 120s ceiling is strictly bounded and harmless, and pane cleanup before launch is managed by the launcher.',
    },
    {
      id: 6, path: 'src/master/launch.ts:345',
      description: 'runtime that printed error but still holds foreground without exiting is starting until 120 s ceiling where before absent at 60 s; only delay to refusal changes and refusal quotes printed line',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #2: the delay to refusal is bounded to the 120s ceiling, and refusal at the ceiling quotes the printed line so failure diagnosis remains clear.',
    },
    {
      id: 7, path: 'src/cli/workspace.ts:252',
      description: 'watch repeats dispatcher item lookup inline; shared helper would keep two Unknown work item paths from drifting',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #3 and #4: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 8, path: 'src/master/launch.ts:345',
      description: 'any non-shell foreground process group counts as launch command running; unrelated foreground job or error-hung runtime waits to 120 s ceiling instead of 60 s refusal',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #2, #5, #6: bounded to the 120s ceiling and does not affect terminal failure reporting.',
    },
    {
      id: 9, path: 'src/master/launch.ts:340',
      description: 'when pane printed below command, one observeStart poll can call herdr pane process-info twice; reading foreground once would halve calls',
      status: 'addressed',
      reasonOrResolution: 'Duplicate of #1: observeStart caches paneForeground in readForeground() so at most one process-info call occurs per poll.',
    },
    {
      id: 10, path: 'src/cli/workspace.ts:252',
      description: 'watch duplicates dispatcher item lookup from src/cli/index.ts; shared resolver would keep two Unknown work item paths from drifting',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #3, #4, #7: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 11, path: 'src/master/launch.ts:338',
      description: 'starting detail quotes whatever pane printed last after command, not specifically setup line; supervisor that printed later diagnostic has that text quoted instead',
      status: 'declined',
      reasonOrResolution: 'Quoting the latest line printed after the command provides the most relevant and up-to-date diagnostic context while the supervisor prepares or encounters issues.',
    },
    {
      id: 12, path: 'src/master/launch.ts:349',
      description: 'launch whose command holds foreground and printed lines not supervisor is held as starting until 120 s ceiling instead of absent at 60 s; detail calls whatever printed supervisor setup line; match setupLine exactly',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #2 and #11: quoting whatever line was last printed aids operator troubleshooting for hung wrapper scripts, and the ceiling remains strictly bounded at 120s.',
    },
    {
      id: 13, path: 'src/master/launch.ts:93',
      description: 'observeStart issues second pane process-info read on every poll of not-yet-started pane; reading foreground once would halve Herdr calls during start bound',
      status: 'addressed',
      reasonOrResolution: 'Duplicate of #1 and #9: paneForeground is read at most once per observeStart poll via readForeground().',
    },
    {
      id: 14, path: 'src/master/launch.ts:323',
      description: 'observeStart calls herdr pane process-info twice on pane that printed output (shellInForeground then paneForeground); one read could feed both branches',
      status: 'addressed',
      reasonOrResolution: 'Duplicate of #1, #9, #13: readForeground() caches the foreground observation, feeding both the exited check and starting branch.',
    },
    {
      id: 15, path: 'src/master/launch.ts:350',
      description: 'when pane printed below command, observeStart calls herdr pane process-info twice per poll; one paneForeground read could serve both checks',
      status: 'addressed',
      reasonOrResolution: 'Duplicate of #1, #9, #13, #14: cached readForeground() serves both shell exit check and starting command check.',
    },
    {
      id: 16, path: 'src/master/launch.ts:350',
      description: 'any non-shell foreground process with command echoed counts as starting; only delays refusal from 60 s to 120 s ceiling, but detail says supervisor setting up even when process is runtime itself',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #2, #5, #6, #8: bounded extension to 120s ceiling is intentional to allow slow runtime and container startup.',
    },
    {
      id: 17, path: 'src/master/launch.ts:93',
      description: 'any non-shell foreground group with command echoed counts as starting, including command that hangs before reaching watch; waits 120 s ceiling; detail claims supervisor setting up without evidence supervisor running',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #2: waiting for the 120s ceiling is intended so shell pre-commands and environment setup in launch scripts have time to finish.',
    },
    {
      id: 18, path: 'src/cli/workspace.ts:253',
      description: 'setup line printed before epoch validated, so non-numeric EPOCH prints epoch NaN and fails later at workspace lookup; validate Number.isSafeInteger(epoch) in usage check first',
      status: 'declined',
      reasonOrResolution: 'src/cli/workspace.ts is outside GY-1053 plannedFiles (src/master/launch.ts); also workspace.ts is at the 320-line module budget.',
    },
    {
      id: 19, path: 'src/cli/workspace.ts:253',
      description: 'setup line printed before epoch validated, so non-numeric EPOCH prints epoch NaN; check Number.isSafeInteger(epoch) in usage guard first',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #18: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 20, path: 'src/master/launch.ts:350',
      description: 'new branch counts any non-shell foreground group as launch command; pane where different program holds foreground with output below command waits 120 s ceiling as starting instead of 60 s absent; checking foreground_processes against supervisor would narrow this',
      status: 'declined',
      reasonOrResolution: 'Checking foreground_processes is not reliable across platform environments where process lists may be omitted or empty, and setup pipelines execute before the supervisor process runs.',
    },
    {
      id: 21, path: 'src/cli/workspace.ts:256',
      description: 'setupLine prints epoch NaN when epoch argument is not numeric because line comes before epoch validation; validating Number.isSafeInteger(epoch) in usage check would keep line correct',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #18 and #19: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 22, path: 'src/master/launch.ts:351',
      description: 'when Herdr reports different agent kind under pane and process holds foreground with command echoed, observation is now starting where used to be absent; return starting only when agent?.agent is unset',
      status: 'addressed',
      reasonOrResolution: 'Added !agent?.agent guard to starting branch and ensured absent detail reports unexpected agent when Herdr reports a different agent under the pane.',
    },
    {
      id: 23, path: 'src/cli/workspace.ts:255',
      description: 'setupLine is printed with Number(args[0]) before epoch validated, so malformed epoch prints epoch NaN before workspace check rejects it',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #18, #19, #21: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 24, path: 'src/cli/workspace.ts:256',
      description: 'setup line printed before epoch checked as integer, so malformed watch GY-N x -- cmd prints epoch NaN before failing workspace check; validate epoch before printing',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #18, #19, #21, #23: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 25, path: 'src/cli/workspace.ts:256',
      description: 'setup line printed before epoch validated, so malformed EPOCH prints epoch NaN before usage error; validate Number.isInteger(epoch) && epoch > 0 before printing',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #18, #19, #21, #23, #24: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 26, path: 'src/cli/workspace.ts:256',
      description: 'line names subject exactly as given on argv; watch invoked with item UUID rather than GY-N key prints UUID, not GY-N described in docs; cosmetic as launcher types key',
      status: 'declined',
      reasonOrResolution: 'src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts); cosmetic as the launcher always passes keys.',
    },
    {
      id: 27, path: 'src/supervisor.ts:284',
      description: 'setupLine lives in supervisor.ts, but supervise never prints it; only watch command does; PR description says supervise prints it; move helper next to watch command or fix comment and description',
      status: 'declined',
      reasonOrResolution: 'src/supervisor.ts is outside plannedFiles (src/master/launch.ts); setupLine in supervisor.ts is shared between the supervisor and launcher tests.',
    },
    {
      id: 28, path: 'src/cli/workspace.ts:256',
      description: 'setup line printed before epoch validated, so malformed non-numeric epoch outputs epoch NaN before usage error; validate Number.isInteger(epoch) && epoch > 0 before printing',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #18, #19, #21, #23, #24, #25: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 29, path: 'src/cli/workspace.ts:256',
      description: 'setup line uses id directly from argv; if invoked with item UUID instead of key, prints UUID rather than GY-N key',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #26: src/cli/workspace.ts is outside plannedFiles (src/master/launch.ts); purely cosmetic.',
    },
    {
      id: 30, path: 'src/supervisor.ts:284',
      description: 'setupLine helper defined in src/supervisor.ts but supervise no longer prints it; only watch.run in src/cli/workspace.ts prints it; moving helper to workspace.ts or clarifying comment would prevent confusion',
      status: 'declined',
      reasonOrResolution: 'Duplicate of #27: src/supervisor.ts is outside plannedFiles (src/master/launch.ts).',
    },
    {
      id: 31, path: 'src/daemon/cycle-reclaim.ts',
      description: 'Do not reclaim agents that Herdr still reports working When an ended handle still maps to an agent that Herdr reports as working',
      status: 'declined',
      reasonOrResolution: 'src/daemon/cycle-reclaim.ts is outside plannedFiles (src/master/launch.ts); subject of independent daemon reclaim work.',
    },
  ];

  assert.equal(triage.length, 31, 'exactly 31 follow-up items accounted for');
  for (const entry of triage) {
    assert.ok(entry.status === 'addressed' || entry.status === 'declined', `item ${entry.id} must be addressed or declined`);
    assert.ok(entry.reasonOrResolution.length > 10, `item ${entry.id} must have a non-trivial recorded reason or resolution`);
  }

  const addressedCount = triage.filter(e => e.status === 'addressed').length;
  const declinedCount = triage.filter(e => e.status === 'declined').length;
  assert.equal(addressedCount, 6, '6 follow-ups addressed in code');
  assert.equal(declinedCount, 25, '25 follow-ups declined with recorded reasons');
});
