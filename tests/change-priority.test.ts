import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityServer, nextPriorityDispatch } from './helpers/priority-server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { intentCommand } from '../src/cli/master/intent.js';
import type { MasterSession } from '../src/cli/master/session.js';

const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const fields = { type: 'chore', priority: 3, criteria: [{ id: 'AC-1', text: 'Priority works', proofs: ['e2e:change-priority'] }] };

test('change-priority: authenticated roles, validation, audit, CLI and next dispatch', async () => {
  const f = await priorityServer();
  try {
    const first = await f.ok('work', { ...fields, title: 'Earlier' });
    const later = await f.ok('work', { ...fields, title: 'Later' });
    for (const item of [first, later]) await f.ok(`work/${item.id}/ready`, { reason: 'Ready' });
    const path = `work/${later.id}/priority`;
    const before = await f.store.workDocument(later.id);
    const changed = await f.ok(path, { priority: 0, source: 'dashboard' });
    assert.equal(changed.priority, 0);
    const strip = ({ priority, revision, updatedAt, ...rest }: any) => rest;
    assert.deepEqual(strip(changed), strip(before), 'no gates, lease, requirements or other item fields change');
    const events = await f.ok(`events?work=${later.id}`);
    assert.deepEqual(events.find((event: any) => event.kind === 'priority').payload.details, { priority: 0, source: 'dashboard', oldPriority: 3, newPriority: 0, reason: 'Priority changed from P3 to P0 from the dashboard' });
    assert.equal(events.find((event: any) => event.kind === 'priority').actor, 'operator');

    assert.deepEqual(await nextPriorityDispatch(f), [later.key]);
    assert.equal((await f.store.workDocument(later.id))!.lease, null, 'priority did not force a claim');

    const maintainer = await f.teammate('maintainer'), viewer = await f.teammate('viewer');
    for (const token of [f.tokens.worker, viewer]) {
      assert.equal((await f.call(path, { priority: 2, reason: 'Denied' }, token)).status, 403);
    }
    for (const [token, actor] of [[maintainer, 'maintainer'], [f.tokens.master, 'master']]) {
      await f.ok(path, { priority: 2, reason: 'Caller reason' }, token);
      const event = (await f.ok(`events?work=${later.id}`)).find((row: any) => row.kind === 'priority');
      assert.equal(event.actor, actor); assert.equal(event.payload.details.reason, 'Caller reason');
    }
    for (const input of [{ priority: 4, reason: 'Invalid' }, { priority: -1, reason: 'Invalid' }, { priority: 1.5, reason: 'Invalid' }, { priority: 1 }, { priority: 1, reason: '  ' }]) {
      assert.notEqual((await f.call(path, input)).status, 200);
    }
    const legacy = await f.ok('work', { ...fields, title: 'Existing P4', priority: 4 });
    assert.equal((await f.store.workDocument(legacy.id))!.priority, 4);
    const directory = await temporaryDirectory('priority-cli');
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: f.url, GRAPHYARD_TOKEN: f.tokens.operator }; delete env.GRAPHYARD_TOKEN_FILE;
    const output = await promisify(execFile)(process.execPath, [cli, 'priority', later.key, '1', 'CLI caller reason'], { cwd: directory, env });
    assert.equal(JSON.parse(output.stdout).priority, 1);
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'priority', later.key, '0'], { cwd: directory, env }));
    // The actual master subcommand posts the caller's reason using its provisioned identity.
    const masterCredential = join(directory, 'master.token'); await writeFile(masterCredential, f.tokens.master, { mode: 0o600 });
    let printed: any;
    await intentCommand({ id: 'priority', args: [later.key, '0', 'Master caller reason'], root: process.cwd(),
      master: { operatorAgent: { id: 'master', credentialFile: masterCredential } },
      masterMutation: (route: string, body: unknown, _key: string, token: string) => f.ok(route, body, token), print: (value: unknown) => { printed = value; },
    } as unknown as MasterSession);
    assert.equal(printed.priority, 0);
    // Reprioritizing an assigned item never preempts it or changes the lease epoch.
    const claimed = await f.ok(`work/${later.id}/claim`, {}, f.tokens.worker);
    const leased = await f.ok(path, { priority: 1, reason: 'Keep current worker' });
    assert.deepEqual(strip(leased), strip(claimed));
    const replayKey = 'repeat-priority';
    const input = { priority: 0, source: 'dashboard' };
    const once = await f.call(path, input, f.tokens.master, replayKey);
    assert.equal(once.status, 200);
    assert.deepEqual(await f.call(path, input, f.tokens.master, replayKey), once);

  } finally { await f.close(); }
});
