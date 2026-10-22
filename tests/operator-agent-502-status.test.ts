import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { planeWideRefusal } from '../src/model/blocker-class.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1751: a proxy's empty or HTML 502-504 on an operator-agent call keeps its status, so it is the plane's outage and not a SyntaxError.
test('unit:operator-agent-502-status — an empty or HTML 502 answer to an operator-agent call is a plane-wide refusal; the server\'s own refusal is not', async () => {
  const root = await temporaryDirectory('gy1751-op-'), outside = await temporaryDirectory('gy1751-opcred-');
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(outside, 'operator.token');
  await writeFile(credentialFile, 't'.repeat(40) + '\n', { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://plane.invalid', credentialFile: join(outside, 'coordinator.token'), cliPath: '/bin/graphyard', repository: 'o/r', baseBranch: 'main', githubAppId: 1,
    hostId: 'm', masterAgentName: 'graphyard-master-project', workers: [], operatorAgent: { id: 'op', credentialFile } });
  const answer = (body: string, status: number) => daemonEffects(root, config, { snapshot: async () => ({ work: [], now: '' }), mutate: async () => ({}), run: (async () => '') as never,
    fetcher: (async () => new Response(body, { status })) as typeof fetch });
  const work = { id: 'w', key: 'GY-1' } as never;
  for (const body of ['', '<html>Bad gateway</html>']) {
    const proxy = await answer(body, 502).rework!(work, 'r').catch((error: unknown) => error) as RefusedResponse;
    assert.ok(proxy instanceof RefusedResponse, String((proxy as any)?.stack ?? proxy));
    assert.equal(proxy.status, 502);
    assert.equal(planeWideRefusal(proxy), true);
  }
  const own = await answer(JSON.stringify({ error: 'Work item not found' }), 502).rework!(work, 'r').catch((error: unknown) => error);
  assert.equal(planeWideRefusal(own), false);
});
