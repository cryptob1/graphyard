import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptanceEffects } from '../src/daemon/acceptance.js';
import { masterConfigSchema } from '../src/master.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { planeWideRefusal } from '../src/model/blocker-class.js';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1751: a proxy's non-JSON 502-504 on the approver's verdict keeps its status, so it is the plane's outage (retried, no decision fault) and not a parse error.
test('unit:acceptance-verdict-502-status — a non-JSON 502 answer to the approver verdict is a plane-wide refusal; the server\'s own refusal is not', async () => {
  const root = await temporaryDirectory('gy1751-verdict-'), outside = await temporaryDirectory('gy1751-cred-');
  execFileSync('git', ['init', '-q', root]);
  const credentialFile = join(outside, 'approver.token');
  await writeFile(credentialFile, 't'.repeat(40) + '\n', { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'https://plane.invalid', credentialFile: join(outside, 'coordinator.token'), cliPath: '/bin/graphyard', repository: 'o/r', baseBranch: 'main', githubAppId: 1,
    hostId: 'm', masterAgentName: 'graphyard-master-project', workers: [], approver: { id: 'approver', credentialFile }, operatorAgent: { id: 'op', credentialFile } });
  const answer = (body: string, status: number) => acceptanceEffects(config, root, { run: (async () => '') as never, asCoordinator: async () => ({}), asOperatorAgent: async () => ({}),
    fetcher: (async () => new Response(body, { status })) as typeof fetch });
  const goal = { key: 'GY-G1', id: 'g', revision: 1 } as never, judgement = { goal: 'GY-G1', verdict: 'approve', reason: 'ok' } as never;
  const proxy = await answer('<html>Application failed to respond</html>', 502).judge(goal, judgement).catch(error => error);
  assert.ok(proxy instanceof RefusedResponse, String(proxy?.stack ?? proxy));
  assert.equal(proxy.status, 502);
  assert.equal(planeWideRefusal(proxy), true);
  const own = await answer(JSON.stringify({ error: 'Work item not found' }), 502).judge(goal, judgement).catch(error => error);
  assert.equal(planeWideRefusal(own), false);
});
