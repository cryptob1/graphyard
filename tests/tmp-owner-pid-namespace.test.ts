import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processPidNamespace, processStartTicks, reclaimTmpDirectories, tempOwnerGone, tempOwnerJudgeable, tempOwnerMarker, tmpReclaimMinAgeMs, writeTempOwner, type TempOwner } from '../src/tmp-reclaim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1896: worker sessions run each suite in a bubblewrap sandbox with a PID namespace of its own
// (bwrap --unshare-pid --proc /proc) beside the same host /tmp, and an owner marker's pid —
// `process.pid` as the writer saw it — names nothing in another sandbox's table: a sweep in one
// sandbox or the loop read a live run's pid as absent and removed its embedded-Postgres data dir
// under it (479 initdb core dumps in three hours). A marker now records the namespace its pid was
// taken in, a reader answers a pid lookup only from that namespace, and a marker it cannot judge —
// another namespace's, or one recorded before namespaces were — keeps its directory as an ownerless
// one is kept, by age (`tmpReclaimMinAgeMs`) and live holders, so a live run's directory outlives
// every cross-namespace pass and a dead one still goes.

/** A marker file naming a chosen owner, as a pre-change writer or a foreign sandbox would leave it. */
const mark = (directory: string, owner: { pid: number; startedAt: number | null; pidNamespace: string | null }) =>
  writeFile(tempOwnerMarker(directory), `${JSON.stringify({ ...owner, at: new Date().toISOString() })}\n`);

/** A fabricated /proc whose `self/ns/pid` names `namespace`, holding no process unless placed there. */
const fakeProc = async (label: string, namespace: string | null) => {
  const proc = await temporaryDirectory(label);
  if (namespace !== null) {
    mkdirSync(join(proc, 'self', 'ns'), { recursive: true });
    symlinkSync(namespace, join(proc, 'self', 'ns', 'pid'));
  }
  return proc;
};

/** A copy of this process's stat with its start moved `ticks` ticks, as a mismatched owner's would read. */
const statWithStart = (ticks: number) => {
  const real = readFileSync(`/proc/${process.pid}/stat`, 'utf8'), cut = real.lastIndexOf(')') + 2;
  const fields = real.slice(cut).split(' ');
  fields[19] = String(ticks);
  return real.slice(0, cut) + fields.join(' ');
};
const myStart = () => processStartTicks(process.pid) as number;
/** An owner marker as `tempOwnerGone` reads it: a pid, the start its writer saw, the namespace both were taken in. */
const owner = (pid: number, startedAt: number | null, pidNamespace: string | null): TempOwner => ({ pid, startedAt, pidNamespace, at: new Date().toISOString() });

test('unit:tmp-owner-judged-in-own-pid-namespace — a marker records its writer\u2019s PID namespace, and a pid absent from another namespace\u2019s table never reports its owner gone', async () => {
  // The writer records the namespace its pid was taken in, and the marker carries it.
  const owned = await temporaryDirectory('ns-owner');
  const writer = await writeTempOwner(owned);
  assert.equal(writer.pidNamespace, processPidNamespace(), 'the marker records this process\u2019s own PID namespace');
  assert.equal((await readFile(tempOwnerMarker(owned), 'utf8')).includes('"pidNamespace":'), true, 'the namespace reaches the marker file');

  // A reader whose PID namespace differs from the marker's: the pid it names is absent from its
  // table, and that absence proves nothing \u2014 the writer may be running where the reader cannot see.
  const markerNamespace = writer.pidNamespace ?? 'pid:[4026531836]';
  const foreign = markerNamespace === 'pid:[4026531836]' ? 'pid:[4026539999]' : 'pid:[4026531836]';
  const elsewhere = await fakeProc('ns-foreign-proc', foreign);
  const stranger = owner(4_194_000, myStart(), markerNamespace);
  assert.equal(tempOwnerJudgeable(stranger, elsewhere), false, 'a marker from another namespace is not judged from this table');
  assert.equal(tempOwnerGone(stranger, elsewhere), false, 'its pid\u2019s absence does not report the owner gone');
  await mkdir(join(elsewhere, '4194000'), { recursive: true });
  await writeFile(join(elsewhere, '4194000', 'stat'), statWithStart(myStart()));
  assert.equal(tempOwnerGone(stranger, elsewhere), false, 'nor does a pid of the same number the reader happens to hold');

  // A pre-change marker, which recorded no namespace, is never judged from a reader that has one:
  // any sandbox on the host could have written it.
  const unrecorded = owner(4_194_000, myStart(), null);
  assert.equal(tempOwnerGone(unrecorded, elsewhere), false, 'a namespace-less marker is not judged by a namespaced reader');
  // A reader that cannot read any namespace judges only such markers, by the rules it always had.
  const bare = await fakeProc('ns-bare-proc', null);
  assert.equal(tempOwnerGone(unrecorded, bare), true, 'pid absent: what a namespace-less reader has always concluded');

  // With the same namespace the existing pid and start-tick rules are unchanged.
  const same = await fakeProc('ns-same-proc', markerNamespace);
  assert.equal(tempOwnerJudgeable(stranger, same), true, 'the marker\u2019s own namespace judges');
  assert.equal(tempOwnerGone(owner(4_194_001, myStart(), markerNamespace), same), true, 'a pid absent from its own namespace\u2019s table is gone');
  await mkdir(join(same, '4194002'), { recursive: true });
  await writeFile(join(same, '4194002', 'stat'), statWithStart(myStart() + 7));
  assert.equal(tempOwnerGone(owner(4_194_002, myStart(), markerNamespace), same), true, 'a start the writer never recorded is a recycled pid: gone');
  await mkdir(join(same, '4194003'), { recursive: true });
  await writeFile(join(same, '4194003', 'stat'), statWithStart(myStart()));
  assert.equal(tempOwnerGone(owner(4_194_003, myStart(), markerNamespace), same), false, 'the recorded start matching keeps its directory');
  assert.equal(tempOwnerGone(owner(4_194_003, null, markerNamespace), same), false, 'a start that could not be recorded is still not judged gone');

  // And the pass judges the directory as an ownerless one is: kept while younger than
  // `tmpReclaimMinAgeMs`, so a live run\u2019s marker outlives the passes that race it.
  const root = await temporaryDirectory('ns-young-root');
  const young = join(root, 'graphyard-young-foreign');
  await mkdir(young);
  await mark(young, { pid: 4_194_000, startedAt: 1, pidNamespace: foreign });
  const pass = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root });
  assert.deepEqual(pass.removed, [], 'a foreign-namespace marker\u2019s young directory is kept');
  assert.equal(existsSync(young), true, 'the directory stands for the live run it may belong to');
  assert.equal(existsSync(tempOwnerMarker(young)), true, 'its marker with it');
});

test('unit:tmp-reclaim-keeps-foreign-namespace-live-dirs — a pass removes an old unheld foreign-namespace leftover and a same-namespace corpse, and keeps the young foreign-namespace directory', async () => {
  const root = await temporaryDirectory('ns-reclaim-root');
  const reader = processPidNamespace(), foreign = reader === 'pid:[4026531836]' ? 'pid:[4026539999]' : 'pid:[4026531836]';
  const backdate = async (path: string, hours: number) => { const past = new Date(Date.now() - hours * 3_600_000); await utimes(path, past, past); };

  // A foreign-namespace marker younger than the bound: a live run in another sandbox may own it.
  const young = join(root, 'graphyard-young-foreign');
  await mkdir(young);
  await mark(young, { pid: 4_194_000, startedAt: 1, pidNamespace: foreign });
  // A foreign-namespace marker past the bound, no live holder: its run had hours to finish and did not.
  const old = join(root, 'graphyard-old-foreign');
  await mkdir(old); await writeFile(join(old, 'data.bin'), Buffer.alloc(4096, 1));
  await mark(old, { pid: 4_194_000, startedAt: 1, pidNamespace: foreign });
  await backdate(join(old, 'data.bin'), tmpReclaimMinAgeMs / 3_600_000 + 1); await backdate(old, tmpReclaimMinAgeMs / 3_600_000 + 1);
  // A marker from this reader's own namespace whose pid is gone: a corpse, as the runner sweep has
  // always taken it, whatever its age.
  const exited = spawn('true', { stdio: 'ignore' });
  await once(exited, 'close');
  const corpse = join(root, 'graphyard-same-namespace-corpse');
  await mkdir(corpse);
  await mark(corpse, { pid: exited.pid ?? 0, startedAt: null, pidNamespace: reader });

  const pass = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: root });
  assert.deepEqual(pass.removed.map(entry => entry.path), [corpse, old], 'the corpse goes first, then the old unheld leftover; the young foreign-namespace directory stays');
  assert.deepEqual(pass.errors, []);
  assert.equal(existsSync(young), true, 'the young foreign-namespace directory is kept');
  assert.equal(existsSync(corpse), false, 'the same-namespace corpse goes whatever its age');
  assert.equal(existsSync(old), false, 'the old unheld foreign-namespace directory goes');
  assert.equal(existsSync(tempOwnerMarker(young)), true, 'the kept directory\u2019s marker stands');
  assert.equal(existsSync(tempOwnerMarker(old)), false, 'the removed leftover\u2019s marker goes with it');

  // The bound the fallback judges by is the module's, not the name's: a three-hour foreign-marked
  // directory stays, where an unmarked one of the same age is already due at the name's two.
  const contrast = await temporaryDirectory('ns-bound-root');
  const foreignThreeHours = join(contrast, 'graphyard-foreign-three-hours'), unmarkedThreeHours = join(contrast, 'graphyard-unmarked-three-hours');
  await mkdir(foreignThreeHours); await mark(foreignThreeHours, { pid: 4_194_000, startedAt: 1, pidNamespace: foreign });
  await mkdir(unmarkedThreeHours);
  await backdate(foreignThreeHours, 3); await backdate(unmarkedThreeHours, 3);
  const second = await reclaimTmpDirectories({ now: Date.now(), tmpRoot: contrast });
  assert.deepEqual(second.removed.map(entry => entry.path), [unmarkedThreeHours], 'an unmarked three-hour directory is due at its name\u2019s bound; the foreign-marked one is not');
  assert.equal(existsSync(foreignThreeHours), true, 'the foreign-namespace directory is kept until the module\u2019s own bound');
});
