import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyInstall, buildPlan, materializeInstall, prepareInstall } from '../src/install/index.js';
import { readToken } from '../src/install/secrets.js';
import { harness, REPOSITORY } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3270: a Herdr command a repository setup step runs that fails is reported with Herdr's own
 * error — the command, its exit code and the last lines of its stderr — in install --apply's failed
 * step line, not as a bare refusal. A plugin linked but disabled names itself.
 */
test('e2e:herdr-setup-error-detail — a stub herdr that exits 1 printing "plugin graphyard is disabled" puts that text and the exit code in install --apply\'s failed Herdr step line', { timeout: 120_000 }, async () => {
  // The stub herdr the setup step finds on PATH: every invocation fails the same way.
  const bin = await temporaryDirectory('herdr-stub');
  await writeFile(join(bin, 'herdr'), `#!/bin/sh\necho 'plugin graphyard is disabled' >&2\nexit 1\n`, { mode: 0o755 });
  const wasPath = process.env.PATH;
  process.env.PATH = `${bin}:${wasPath}`;

  // The control plane the apply's summary reads is the harness's fetch; repository and master
  // setup reach their server with a real fetch, so one loopback HTTP server answers /api/status
  // for exactly the credentials the apply materialized.
  const fixture = await harness({ provider: 'compose' });
  const credentials: Record<string, { id: string; role: string }> = {};
  const plane: Server = createServer((request, response) => {
    const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    const actor = credentials[bearer];
    const answer = actor ? { actor: { id: actor.id, role: actor.role }, repository: REPOSITORY, ...(actor.role === 'coordinator' ? { baseBranch: 'main' } : {}) } : null;
    response.statusCode = actor ? 200 : 401;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(answer ?? { error: 'A valid Graphyard bearer token is required' }));
  });
  await new Promise<void>(accept => plane.listen(0, '127.0.0.1', accept));
  const port = (plane.address() as { port: number }).port;
  try {
    // install --apply's own profile registration runs the Herdr setup step; no stubbed step.
    const deps = { ...fixture.deps };
    delete deps.registerProfiles;
    const session = await prepareInstall(fixture.root, { repository: REPOSITORY, provider: 'compose', port }, deps, 'apply');
    await materializeInstall(session);
    for (const role of ['worker', 'coordinator'] as const) {
      const id = session.principals.find(principal => principal.role === role)!.id;
      credentials[await readToken(session.directory, id)] = { id, role };
    }

    const summary = await applyInstall(session, await buildPlan(session));
    const line = summary.profiles.repository.detail;
    assert.equal(summary.profiles.repository.connected, false, 'the repository step failed');
    assert.match(line, /herdr plugin --help exited 1\b/, `the step line names the Herdr command and its exit code: ${line}`);
    assert.ok(line.includes('plugin graphyard is disabled'), `the step line carries Herdr's own error: ${line}`);
  } finally {
    process.env.PATH = wasPath;
    await new Promise<void>(accept => plane.close(() => accept()));
    await fixture.cleanup();
  }
});
