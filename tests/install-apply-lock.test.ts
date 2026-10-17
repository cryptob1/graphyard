import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { installDirectory } from '../src/install/secrets.js';
import { fakeTransport, type Transport } from '../src/install/transport.js';
import { githubResponses, harness, REPOSITORY } from './install-harness.js';

const PROTECTION_READ = `gh api repos/${REPOSITORY}/branches/main/protection`;

test('unit:install-apply-exclusive-lock — a second install --apply on one installation directory refuses on the first one\'s lock, naming its pid, and writes nothing while it is held; a lock left by a process that is gone is reclaimed', async () => {
  // Loaded when the test runs, so a checkout without the lock fails here as a test case.
  const { applyLockFile } = await import('../src/install/index.js') as any;
  assert.equal(typeof applyLockFile, 'function', 'src/install/index.ts exports no apply lock');
  const fixture = await harness({ provider: 'railway' });
  try {
    // The recording transport, held at the first apply's protection read until released.
    let gated = false, entered!: () => void, release!: () => void;
    const reached = new Promise<void>(accept => { entered = accept; });
    const held = new Promise<void>(accept => { release = accept; });
    const recording = fixture.transport;
    const transport: Transport = { ...recording, async exec(program, args, options) {
      if (gated && [program, ...args].join(' ') === PROTECTION_READ) { gated = false; entered(); await held; }
      return recording.exec(program, args, options);
    } };
    const deps = { ...fixture.deps, transport };
    const directory = installDirectory('owner-project', fixture.configHome);
    const lock = applyLockFile(directory);

    const first = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, deps);
    const second = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, deps);
    const [firstPlan, secondPlan] = [await buildPlan(first), await buildPlan(second)];

    gated = true;
    const running = applyInstall(first, firstPlan);
    await reached;
    assert.ok(existsSync(lock), 'the first apply holds no lock while it writes');
    const holder = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(holder.pid, process.pid);
    const commandsBefore = recording.commands.length, requestsBefore = fixture.requests.length;
    const filesBefore = JSON.stringify(await snapshot(directory));

    await assert.rejects(applyInstall(second, secondPlan), (error: Error) => error.message.includes(`pid ${process.pid}`) && error.message.includes(lock) && /wrote nothing/.test(error.message));
    assert.equal(recording.commands.length, commandsBefore, 'the second apply ran a command while the first held the lock');
    assert.equal(fixture.requests.length, requestsBefore, 'the second apply sent a request while the first held the lock');
    assert.equal(JSON.stringify(await snapshot(directory)), filesBefore, 'the second apply wrote under the installation directory');

    release();
    await running;
    assert.ok(!existsSync(lock), 'the first apply left its lock behind');

    // A lock whose process is gone is reclaimed, and released again after the apply.
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    await writeFile(lock, `${JSON.stringify({ pid: gone, host: hostname(), startedAt: new Date(0).toISOString() })}\n`, { mode: 0o600 });
    const third = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    await applyInstall(third, await buildPlan(third));
    assert.ok(!existsSync(lock), 'the reclaimed lock was not released');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('apply.lock')), [], 'reclaiming left a file behind');

    // A live holder on this machine refuses, and its lock is left as it was.
    const live = `${JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: new Date(0).toISOString() })}\n`;
    await writeFile(lock, live, { mode: 0o600 });
    const fourth = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'railway' }, fixture.deps);
    await assert.rejects(applyInstall(fourth, await buildPlan(fourth)), (error: Error) => error.message.includes(`pid ${process.ppid}`));
    assert.equal(await readFile(lock, 'utf8'), live);
  } finally { await fixture.cleanup(); }
});

test('unit:protection-record-no-replace — a protection record that appears between the existence check and the publish is kept byte-for-byte and read back, never replaced', async () => {
  const { recordProtectionOnce, protectionRecordFile } = await import('../src/install/github.js') as any;
  const fixture = await harness({ provider: 'railway' });
  try {
    const directory = installDirectory('owner-project', fixture.configHome);
    const file = protectionRecordFile(directory);
    const { prepareInstallDirectory } = await import('../src/install/secrets.js');
    await prepareInstallDirectory(directory, fixture.root);
    // The faster apply's record: the branch's true protection before Graphyard wrote any.
    const baseline = { format: 'graphyard-protection-record-v1', repository: REPOSITORY, branch: 'main', recordedAt: new Date(0).toISOString(),
      protection: { url: `https://api.github.com/repos/${REPOSITORY}/branches/main/protection`, enforce_admins: { enabled: false } }, allowAutoMerge: false, mergeQueueRuleset: null };
    const text = `${JSON.stringify(baseline, null, 2)}\n`;
    // GitHub as the slower apply reads it, after the faster one's protection write: the record
    // appears during that read, after recordProtectionOnce found none.
    const recording = fakeTransport({ responses: githubResponses({ installed: false, protection: { enforce_admins: { enabled: true } }, deliveries: [], hookConfig: null }) });
    let wrote = false;
    const gh = async (args: string[], options: { allowFailure?: boolean } = {}) => {
      if (!wrote && ['gh', ...args].join(' ') === PROTECTION_READ) { wrote = true; await writeFile(file, text, { mode: 0o600, flag: 'wx' }); }
      return recording.exec('gh', args, { allowFailure: options.allowFailure });
    };
    const answered = await recordProtectionOnce(gh, { directory, repository: REPOSITORY, branch: 'main', now: 1_000, assertClean: (value: string) => value });
    assert.ok(wrote, 'the record was not created between the check and the publish');
    assert.equal(await readFile(file, 'utf8'), text, 'the standing record was replaced');
    assert.deepEqual(answered, baseline, 'the standing record was not read back');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('protection-record.json.')), [], 'the unpublished record was left behind');
  } finally { await fixture.cleanup(); }
});

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    entries[path] = await readFile(path, 'utf8');
  }
  return entries;
}
