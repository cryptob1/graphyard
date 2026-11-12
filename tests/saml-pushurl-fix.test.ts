import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall } from '../src/install/index.js';
import { localTransport, type Transport } from '../src/install/transport.js';
import { harness } from './install-harness.js';

// GY-3269 AC-2: a SAML organization refuses the checkout's SSH fetch. The install preflight names
// the pushurl-only fix (an https fetch URL with the SSH push URL kept) and --push-auth gh, and
// --apply sets both URLs on the checkout. The remote's refusal is the transport's ssh answer —
// the probe the preflight runs is `ssh git@github.com git-upload-pack`, the fetch direction's own.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout whose origin fetches OWNER/PROJECT over SSH. */
async function sshCheckout(directory: string) {
  const root = join(directory, 'checkout');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/project.git'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }));
  return root;
}

/** git runs for real (the set-url reaches the checkout); ssh and the provider CLIs are the recorded fakes. */
function mixedTransport(fake: Transport): Transport {
  const real = localTransport();
  return {
    description: 'git on this machine, providers recorded',
    async exec(program, args, options) { return program === 'git' ? real.exec(program, args, options) : fake.exec(program, args, options); },
    async putFile(path, content, mode, owner) { return fake.putFile(path, content, mode, owner); },
  };
}

const REFUSAL = "ERROR: The 'owner' organization has enabled SAML SSO; this SSH key is not authorized for it. Visit https://github.com/settings/ssh to authorize.";

test('e2e:saml-pushurl-fix — preflight names the pushurl-only fix and --push-auth gh, and --apply sets the https fetch URL with the SSH pushurl', { timeout: 120_000 }, async () => {
  const directory = await temporaryDirectory('saml-pushurl-fix');
  const root = await sshCheckout(directory);
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310', root, extraResponses: [
    { match: 'ssh -o BatchMode=yes git@github.com git-upload-pack', result: { stdout: '', stderr: REFUSAL, code: 1 } },
  ] });
  fixture.deps.transport = mixedTransport(fixture.transport);
  try {
    const { request } = installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--apply']);
    const session = await prepareInstall(root, request, fixture.deps, 'apply');
    const plan = await buildPlan(session);
    const check = plan.preflight.find(item => item.name === 'Repository');
    assert.equal(check?.ok, true, `the SAML refusal passes preflight naming its fix: ${check?.detail}`);
    const words = `${check?.detail} ${check?.fix}`;
    assert.match(words, /git remote set-url origin https:\/\/github\.com\/owner\/project\.git/);
    assert.match(words, /git remote set-url --push origin git@github\.com:owner\/project\.git/);
    assert.match(words, /--push-auth gh/);
    assert.match(words, /SAML SSO/);

    await applyInstall(session, plan);
    assert.equal(git(root, 'remote', 'get-url', 'origin'), 'https://github.com/owner/project.git', 'the fetch URL is https');
    assert.equal(git(root, 'remote', 'get-url', '--push', 'origin'), 'git@github.com:owner/project.git', 'the push URL stays SSH');

    // The fix is stable: with the fetch over https, preflight no longer probes SSH and names nothing.
    const again = await buildPlan(await prepareInstall(root, request, fixture.deps, 'apply'));
    const recheck = again.preflight.find(item => item.name === 'Repository');
    assert.equal(recheck?.ok, true);
    assert.doesNotMatch(recheck?.detail ?? '', /SAML/);
  } finally { await fixture.cleanup(); }
});

test('integration:saml-pushurl-fix — under --push-auth gh there is no Repository check to fail, and no non-SAML refusal changes origin', { timeout: 120_000 }, async () => {
  const directory = await temporaryDirectory('saml-pushurl-fix-other');
  const root = await sshCheckout(directory);
  const fixture = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310', root, extraResponses: [
    { match: 'ssh -o BatchMode=yes git@github.com git-upload-pack', result: { stdout: '', stderr: 'git@github.com: Permission denied (publickey).', code: 255 } },
  ] });
  fixture.deps.transport = mixedTransport(fixture.transport);
  try {
    const plain = await buildPlan(await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--plan']).request, fixture.deps, 'plan'));
    const check = plain.preflight.find(item => item.name === 'Repository');
    assert.equal(check?.ok, true);
    assert.doesNotMatch(`${check?.detail} ${check?.fix}`, /SAML|set-url/, 'a non-SAML refusal names no fix');
    assert.equal(git(root, 'remote', 'get-url', 'origin'), 'git@github.com:owner/project.git', 'nothing was rewritten');

    const gh = await buildPlan(await prepareInstall(root, installRequestFromArgs(['--provider', 'compose', '--repo', 'owner/project', '--push-auth', 'gh', '--plan']).request, fixture.deps, 'plan'));
    assert.equal(gh.preflight.find(item => item.name === 'Repository'), undefined, 'the gh login pushes the https URL, so origin has no credential to check');
  } finally { await fixture.cleanup(); }
});
