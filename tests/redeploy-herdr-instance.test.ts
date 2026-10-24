import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradePlan } from '../src/cli/upgrade.js';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall, redeployArguments } from '../src/install/index.js';
import { installDirectory, readInstallRecord, type InstallRecord } from '../src/install/secrets.js';
import { harness } from './install-harness.js';

// GY-2941: an installation running its own Herdr instance redeploys with --herdr-instance, or preflight refuses the self-deploy and its rollback.
type Entry = InstallRecord['principals'][number];
const principal = (id: string, role: Entry['role']): Entry => ({ id: `acme-app-${id}`, role, fingerprint: 'f'.repeat(12) });
const record = { installId: 'acme-app', repository: 'acme/app', provider: 'compose', selfContained: false, baseBranch: 'main', service: 'graphyard', domain: null, deployment: null,
  reviewPolicy: 'github', noGithubApp: false, herdrInstance: false, principals: [principal('operator', 'admin'), principal('master', 'coordinator'), principal('worker-1', 'worker')] } as unknown as InstallRecord;
const redeployStep = (install: InstallRecord) => upgradePlan({ cliRoot: '/opt/graphyard', repoRoot: '/work/app', current: { version: 'unreleased a', revision: 'a'.repeat(40), released: false },
  target: { version: 'unreleased b', revision: 'b'.repeat(40), schema: null }, databaseSchema: null, install, url: 'http://127.0.0.1:4310', backupFile: '/tmp/b.json', cliChanges: [], image: 'graphyard-local:bbbbbbbbbbbb' })
  .steps.find(step => step.id === 'redeploy')!.command;

test('unit:redeploy-carries-herdr-instance — the restart step\'s redeploy passes --herdr-instance only for an installation with its own Herdr instance', () => {
  const own = redeployStep({ ...record, herdrInstance: true });
  assert.equal(own.match(/--herdr-instance/g)?.length, 2, 'both the --plan preview and the --apply carry it');
  assert.equal(installRequestFromArgs(redeployArguments({ ...record, herdrInstance: true }, 'img')).request.herdr, 'instance');
  assert.doesNotMatch(redeployStep(record), /--herdr-instance/, 'an installation on the host\'s default Herdr instance redeploys without it');
  const workerless = redeployArguments({ ...record, herdrInstance: true, principals: record.principals.slice(0, 2) }, 'img');
  assert.deepEqual(installRequestFromArgs(workerless).request, { ...installRequestFromArgs(workerless).request, workers: 0, herdr: 'instance' }, 'a --workers 0 own-instance install redeploys as one, not observation-only');
  assert.ok(!workerless.includes('--observe-only'));
});

test('unit:own-herdr-instance-recorded — an install applied with --herdr-instance records it, so a later redeploy from the record carries it', async () => {
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    const apply = async (args: string[]) => {
      const session = await prepareInstall(fixture.root, installRequestFromArgs(args).request, fixture.deps, 'apply');
      await applyInstall(session, await buildPlan(session));
      return (await readInstallRecord(installDirectory('owner-project', fixture.configHome)))!;
    };
    const created = await apply(['--provider', 'compose', '--repo', 'owner/project', '--herdr-instance', '--apply']);
    assert.equal(created.herdrInstance, true);
    assert.ok(redeployArguments(created, 'img').includes('--herdr-instance'));
    assert.equal((await apply(redeployArguments(created, 'img'))).herdrInstance, true, 'the redeploy keeps the choice');
    assert.equal((await apply(['--provider', 'compose', '--repo', 'owner/project', '--apply'])).herdrInstance, true, 'a rerun naming no Herdr choice keeps it');
    assert.equal((await apply(['--provider', 'compose', '--repo', 'owner/project', '--no-herdr', '--apply'])).herdrInstance, true, '--no-herdr leaves the own instance, so keeps it');
  } finally { await fixture.cleanup(); }
});
