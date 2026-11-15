import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { save } from '../src/store.js';
import { runCycle, stepTimeoutMs } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

test('e2e:close-step-bounded — one hung and one failed close do not strand ten finished sessions', { timeout: 150_000 }, async () => {
  const store = await withDatabase('close-step-bounded');
  await store.init();
  try {
    const engine = new Engine(store, 120, 'owner/project');
    const operator = { id: 'operator', role: 'admin', sessionKind: 'human' } as const;
    const coordinator = { id: 'loop', role: 'coordinator', sessionKind: 'ai' } as const;
    const item = await engine.execute(operator, 'create', null, { title: 'Ended sessions', type: 'chore', criteria: [{ id: 'AC-1', text: 'Close sessions', proofs: ['e2e:close-step-bounded'] }] }, randomUUID());
    // Seed an ended attempt's handles; subsequent session writes use the real engine and history.
    item.sessions = Array.from({ length: 12 }, (_, index) => ({ id: `worker-${index}:1`, kind: 'implementation' as const, principal: `worker-${index}`, runtime: 'codex' as const, host: 'close-host', pane: `pane-${index}`, subject: 'Ended attempt', state: 'running' as const, startedAt: item.createdAt, updatedAt: item.createdAt }));
    await store.transaction((db, now) => save(db, item, operator.id, 'fixture', now));
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/unused/token', cliPath: '/unused/cli', repository: 'owner/project', baseBranch: 'main', hostId: 'close-host', masterAgentName: 'master', workers: [] });
    const state = emptyDaemonState(config), calls: string[] = [], lines: string[] = [];
    let cycle = 1;
    const started = performance.now();
    const trace = (line: string) => console.log(`close trace +${Math.round(performance.now() - started)}ms cycle=${cycle} ${line}`);
    const effects: DaemonEffects = {
      snapshot: async () => ({ work: await store.list(), now: new Date().toISOString() }),
      agents: () => [], credentials: async () => ({}), dispatch: async () => {}, persist: async () => {},
      closeSession: async pane => {
        calls.push(pane); trace(`${pane} start`);
        if (pane === 'pane-0' && cycle === 1) return new Promise<void>(() => {});
        if (pane === 'pane-1' && cycle === 1) throw new Error('injected close failure');
        await new Promise(resolve => setTimeout(resolve, 20));
        trace(`${pane} end`);
      },
      recordSession: async (work, handle) => { await engine.execute(coordinator, 'session', work.id, handle, randomUUID()); },
    };
    const first = await runCycle(config, state, effects, Date.now, undefined, line => { lines.push(line); trace(line); });
    const elapsed = performance.now() - started;
    const finished = (await store.list())[0].sessions!.filter(session => session.state === 'finished');
    trace(`cycle end; elapsed=${Math.round(elapsed)}ms finished=${finished.length} calls=${calls.length}`);
    assert.equal(finished.length, 10, 'the ten healthy closes finish in the first cycle');
    assert.ok(elapsed < stepTimeoutMs(config), 'the close step settles before its outer timeout');
    assert.ok(!lines.some(line => line.includes('the close step failed')));
    const hung = first.actions.filter(action => action.kind === 'close' && action.detail.includes('worker-0:1'));
    assert.equal(hung.length, 1, 'the hung session is reported once by name');
    assert.equal(hung[0].state, 'failed');
    assert.match(hung[0].detail, /timeout|timed out/);
    assert.equal(first.actions.filter(action => action.kind === 'close' && action.state === 'failed').length, 2);
    cycle++;
    await runCycle(config, state, effects, Date.now, undefined, line => lines.push(line));
    assert.equal((await store.list())[0].sessions!.filter(session => session.state === 'finished').length, 12);
    for (let index = 0; index < 12; index++) assert.equal(calls.filter(pane => pane === `pane-${index}`).length, index < 2 ? 2 : 1);
    const history = await store.events(item.id);
    assert.equal(history.filter(event => event.kind === 'session').length, 12, 'finished handles are durably recorded exactly once');
  } finally { await store.close(); }
});
