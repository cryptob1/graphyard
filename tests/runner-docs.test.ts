import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { attemptGrantSchema, runnerPlanSchema } from '../src/runner-executor.js';
import { collectorInputSchema } from '../src/runner-collector.js';

/**
 * The setup guide's configuration samples are what an operator actually copies, so a
 * sample the CLI would reject during input validation is a broken documented path rather
 * than a typo. These parse the published JSON with the exact schemas the commands use.
 */
const guide = await readFile(new URL('../docs/runner-setup.md', import.meta.url), 'utf8');
const exec = promisify(execFile);
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]) as any);
const sample = (key: string) => {
  const found = blocks.filter(block => block && typeof block === 'object' && !Array.isArray(block) && key in block);
  assert.equal(found.length, 1, `exactly one documented sample should carry ${key}`);
  return found[0];
};

test('the documented runner configuration parses as the runner plan the CLI reads', () => {
  const plan = runnerPlanSchema.parse(sample('supervisor'));
  // The collection root, not one attempt's directory: the attestor provisions a fresh
  // boundary per attempt beneath it, which is what lets a second attempt run at all.
  assert.equal(plan.outputPath, '/srv/graphyard/attempts');
  assert.equal(plan.runAsUser, '10001:20001');
  assert.notEqual(plan.runAsUser.split(':')[0], plan.runAsUser.split(':')[1], 'the documented container account and boundary group use distinct numeric identities');
  // Nothing that decides what is approved may be configured locally.
  for (const authority of ['grant', 'targetUrl', 'bundleDigest', 'executionNetwork', 'attestationPublicKey', 'executionHost']) {
    assert.throws(() => runnerPlanSchema.parse({ ...sample('supervisor'), [authority]: 'x' }), new RegExp('unrecognized|Unrecognized', 'i'), authority);
  }
  const { runAsUser: _runAsUser, ...missingContainerIdentity } = sample('supervisor');
  assert.throws(() => runnerPlanSchema.parse(missingContainerIdentity), /runAsUser/,
    'the CLI must not guess the container UID or boundary GID from the attestor process');
});

test('the documented collector configuration carries the whole dispatch authority', () => {
  const collector = sample('requiredArtifacts');
  // `runner collect` parses `grant` with the strict attempt-grant schema. A sample missing
  // `executionHost` or `attestationPublicKey` documents a command that always exits during
  // input validation: the first names the daemon settlement is observed on, the second the
  // key the host attestation is verified against.
  const grant = attemptGrantSchema.parse(collector.grant);
  // Local socket only: preflight measures the mounted bytes on the attestor's own
  // filesystem, which says nothing about what a remote daemon would resolve those same
  // mount pathnames to.
  assert.match(grant.executionHost, /^unix:\/\/\//);
  assert.match(grant.attestationPublicKey, /BEGIN PUBLIC KEY/);
  // The collector reads the attempt's own boundary, which the execution record names.
  assert.equal(collector.outputPath, `/srv/graphyard/attempts/${grant.attemptId}`);

  // Every key the sample sets is one the collector accepts, and every input it must be
  // given is one the sample sets.
  const shape = collectorInputSchema.shape as Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
  const documented = new Set(Object.keys(collector));
  assert.deepEqual([...documented].filter(key => !(key in shape)), []);
  assert.deepEqual(Object.keys(shape).filter(key => !documented.has(key) && !shape[key].safeParse(undefined).success), []);
});


/**
 * Changing UID, GID and file ownership are real kernel permission checks, so the boundary
 * can only be exercised by a process actually allowed to make them. A hosted runner denies
 * every capability inside an unprivileged user namespace — the namespace is created, but
 * chown, setpriv and mounting a private tmpfs all return EPERM — while granting genuine
 * privilege through passwordless sudo. A developer machine is usually the other way round.
 * Run the identical script under whichever the environment actually offers: the four
 * identities, the modes and every assertion below are the same either way.
 */
const elevated = async (command: string[]): Promise<[string, string[]]> => {
  if (process.getuid?.() === 0) return [command[0], command.slice(1)];
  try {
    await exec('sudo', ['-n', 'true']);
    return ['sudo', ['-n', '--', ...command]];
  } catch {
    // Namespace root over this account's subordinate ranges. Spell the ranges out instead
    // of combining --map-auto with --map-user: util-linux versions disagree about whether
    // that combination retains the automatic range, and a root-only map makes the
    // permission test fail before it ever exercises the boundary.
    const username = userInfo().username;
    const subordinate = async (path: string) => {
      const entry = (await readFile(path, 'utf8')).split('\n').map(line => line.split(':'))
        .find(([owner]) => owner === username);
      assert.ok(entry, `${path} must assign subordinate IDs to ${username} to exercise the boundary`);
      const start = Number(entry[1]), count = Number(entry[2]);
      assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(count) && count > 20_001,
        `${path} must provide enough subordinate IDs for the documented identities`);
      return `${start}:${count}`;
    };
    const [uids, gids] = await Promise.all([subordinate('/etc/subuid'), subordinate('/etc/subgid')]);
    return ['unshare', [
      '--map-user=0', '--map-group=0',
      `--map-users=1:${uids}`, `--map-groups=1:${gids}`,
      '--', ...command,
    ]];
  }
};

test('the documented setgid boundary is writable only by the container and readable by both trusted readers', async () => {
  assert.match(guide, /usermod -aG graphyard-boundary graphyard-attestor/);
  assert.match(guide, /usermod -aG graphyard-boundary graphyard-collector/);
  // Four distinct UIDs in the documented primary/supplementary-group layout: the attestor
  // provisions, the container writes through the setgid group, the attestor and collector
  // read, and the runner has no access at all.
  const script = String.raw`set -eu
attestor=10002
container=10001
collector=10003
runner=10004
boundary=20001
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
chown "$attestor:$boundary" "$root"
chmod 2750 "$root"
setpriv --reuid="$attestor" --regid=30001 --groups="$boundary" mkdir "$root/attempts"
setpriv --reuid="$attestor" --regid=30001 --groups="$boundary" chmod 2770 "$root/attempts"
setfacl -m "g:$boundary:rwx" -m m::rwx "$root/attempts"
setfacl -d -m "g:$boundary:rx" -m m::rwx "$root/attempts"
setpriv --reuid="$container" --regid="$boundary" --clear-groups sh -c 'umask 077; printf approved > "$1/report.json"' sh "$root/attempts"
test "$(stat -c %g "$root/attempts/report.json")" = "$boundary"
setpriv --reuid="$attestor" --regid=30001 --groups="$boundary" test -r "$root/attempts/report.json"
setpriv --reuid="$collector" --regid=30002 --groups="$boundary" test -r "$root/attempts/report.json"
if setpriv --reuid="$runner" --regid=30003 --clear-groups test -r "$root/attempts/report.json"; then
  echo 'runner unexpectedly reached the attempt boundary' >&2
  exit 1
fi`;
  await exec(...(await elevated(['bash', '-c', script])));
});
