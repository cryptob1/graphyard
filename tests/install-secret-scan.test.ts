import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { applyInstall, buildPlan, materializeInstall, prepareInstall } from '../src/install/index.js';
import { fakeTransport, type Transport } from '../src/install/transport.js';
import type { Provider } from '../src/install/types.js';
import { allText, githubResponses, harness, providerResponses } from './install-harness.js';

const inputsFor = (provider: Provider) => ({ repository: 'owner/project', provider,
  ...(provider === 'railway' || provider === 'compose' ? {} : { sshHost: '203.0.113.10', sshUser: 'root', domain: 'graphyard.example.test' }),
  ...(provider === 'hetzner' ? { sshKey: 'graphyard-key' } : {}) });

/** Tracked files plus anything Git would add: exactly what a commit could carry. */
function committableFiles(root: string) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

test('no generated credential reaches stdout, a log line, plan output, a process argument, or the repository', async () => {
  for (const provider of ['railway', 'hetzner', 'docker-host', 'compose'] as Provider[]) {
    const fixture = await harness({ provider });
    const printed: string[] = [];
    try {
      const session = await prepareInstall(fixture.root, inputsFor(provider), { ...fixture.deps, log: line => printed.push(line) });
      const plan = await buildPlan(session);
      const summary = await applyInstall(session, plan);
      const secrets = [...session.tokens.values(), session.context.databasePassword];
      assert.ok(secrets.length >= 5);

      const surfaces: [string, string][] = [
        ['the plan', JSON.stringify(plan)],
        ['the summary', JSON.stringify(summary)],
        ['installer output', printed.join('\n')],
        ['process arguments', fixture.allCommandLines().join('\n')],
      ];
      for (const [where, text] of surfaces) {
        for (const secret of secrets) assert.ok(!text.includes(secret), `${provider}: a credential appeared in ${where}`);
      }

      // Nothing Git could commit contains a credential, and .graphyard stays ignored.
      for (const relative of committableFiles(fixture.root)) {
        const content = await readFile(join(fixture.root, relative), 'utf8').catch(() => '');
        for (const secret of secrets) assert.ok(!content.includes(secret), `${provider}: ${relative} contains a credential`);
      }
      assert.ok(!committableFiles(fixture.root).some(relative => relative.startsWith('.graphyard/')));

      // The credentials that exist live only in the installation directory, mode 0600.
      const tokenDirectory = join(session.directory, 'tokens');
      for (const name of await readdir(tokenDirectory)) assert.equal((await stat(resolve(tokenDirectory, name))).mode & 0o777, 0o600);
      assert.ok(!session.directory.startsWith(resolve(fixture.root)));
    } finally { await fixture.cleanup(); }
  }
});

test('a secret is redacted even when a provider echoes it back in its logs', async () => {
  const fixture = await harness({ provider: 'compose' });
  const leak = { value: 'nothing-yet' };
  try {
    const transport = fakeTransport({ responses: [
      { match: 'logs --tail', result: () => `2026-09-18 server started\nGRAPHYARD_PRINCIPALS=${leak.value}\n` },
      ...providerResponses('compose', { installed: false, workdir: `${fixture.configHome}/owner-project/compose`, service: 'graphyard-owner-project' }),
      ...githubResponses(fixture.state),
    ] });
    const session = await materializeInstall(await prepareInstall(fixture.root, inputsFor('compose'), { ...fixture.deps, transport: transport as Transport }));
    leak.value = session.tokens.values().next().value!;
    const logs = await session.adapter.logs(session.context);
    assert.ok(!logs.includes(leak.value), 'provider logs must be scrubbed before they are shown');
    assert.match(logs, /GRAPHYARD_PRINCIPALS=\[redacted\]/);
    assert.match(logs, /server started/);
  } finally { await fixture.cleanup(); }
});

test('the installer refuses to emit a document that would disclose a credential', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await materializeInstall(await prepareInstall(fixture.root, inputsFor('compose'), fixture.deps));
    const token = session.tokens.values().next().value!;
    assert.throws(() => session.vault.assertClean(`{"note":"${token}"}`, 'the installation summary'), /Refusing to emit the installation summary/);
    assert.ok(session.vault.exposes(token));
    assert.ok(session.vault.exposes(session.context.databasePassword));
  } finally { await fixture.cleanup(); }
});

test('a worker never receives an admin, coordinator, or producer credential', async () => {
  const fixture = await harness({ provider: 'compose' });
  try {
    const session = await prepareInstall(fixture.root, { ...inputsFor('compose'), workers: 2, producerProofs: ['integration:install-apply-adapters'] }, fixture.deps);
    const summary = await applyInstall(session, await buildPlan(session));
    const registered = summary.profiles.workers;
    assert.equal(registered.length, 2);
    const privileged = session.principals.filter(principal => ['admin', 'coordinator', 'producer'].includes(principal.role)).map(principal => principal.id);
    for (const worker of registered) {
      assert.ok(!privileged.includes(worker.principal), 'a worker profile was bound to a privileged principal');
      assert.ok(session.principals.find(principal => principal.id === worker.principal)!.role === 'worker');
    }
    // The producer exists only for the proof it was granted, and holds its own credential.
    const producer = session.principals.find(principal => principal.role === 'producer')!;
    assert.deepEqual(producer.proofs, ['integration:install-apply-adapters']);
    const producerToken = session.tokens.get(producer.id)!;
    for (const principal of session.principals) if (principal.id !== producer.id) assert.notEqual(session.tokens.get(principal.id), producerToken);
    // It reaches the server inside GRAPHYARD_PRINCIPALS and nowhere else a person can read.
    assert.ok(!fixture.allCommandLines().join('\n').includes(producerToken));
    assert.ok(!JSON.stringify(summary).includes(producerToken));
    assert.ok(allText(fixture).includes(producerToken), 'the producer credential must still reach the server configuration');
  } finally { await fixture.cleanup(); }
});
