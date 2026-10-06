import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, writeDaemonState } from '../src/master-daemon.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { mainGuardReadiness } from '../src/main-guard.js';
import { loopUnitName, loopUnitText } from '../src/supervisor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1335: the production control plane ran the main guard without its revert approver App, so main's
// last-push-approval rule refused every revert merge on 2026-10-05 and main stayed red five times
// before anything named the cause. One case per proof: unit:master-status.setup-attention-revert-approver.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');

function config(credentialFile: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
}
/** A host whose loop supervisor is installed, enabled and running, so the setup section raises nothing of its own. */
const healthyHost = (home: string) => ({
  platform: 'linux' as NodeJS.Platform, temporaryDirectories: [] as string[], home,
  run: (command: string, args: string[]) => command === 'loginctl' ? (args[0] === 'show-user' && args[1] && !args[1].startsWith('--') ? 'yes\n' : '\n')
    : args[1] === 'is-enabled' ? 'enabled\n' : args[1] === 'is-active' ? 'active\n' : '\n',
});

test('unit:master-status.setup-attention-revert-approver — master status\'s setup attention names the missing revert approver, its variables and main\'s last-push-approval rule whenever GitHub delivery with required checks is armed, and clears once it is configured', async () => {
  const root = await temporaryDirectory('revert-approver');
  const directory = await temporaryDirectory('revert-approver-credentials');
  const home = await temporaryDirectory('revert-approver-home');
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const credential = join(directory, 'coordinator.token');
    await writeFile(credential, coordinatorToken, { mode: 0o600 });
    const master = config(credential);
    await writeDaemonState(master, emptyDaemonState(master));
    await mkdir(join(home, '.config/systemd/user'), { recursive: true });
    await writeFile(join(home, '.config/systemd/user', loopUnitName), loopUnitText({ root, cliPath: launcher, repository: 'owner/project', intervalSeconds: 20 }));
    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date().toISOString() } : { decisions: [] };
    // The coordinator status is the control plane's /api/status, which reports the guard (mainGuardStatus in github.ts).
    const report = (revertApprover: number | null, github = true, required = ['test', 'typecheck']) => masterStatusReport(root, master, masterApi,
      { actor: { id: 'coordinator-1' }, mainGuard: mainGuardReadiness({ github, required, revertApprover }) }, { commit: null }, { supervisorHost: healthyHost(home) });

    // Armed, no approver: one setup attention item, addressed to the master with the repair named.
    const missing = await report(null);
    const item = missing.attentionItems.find(entry => /revert approver is missing/.test(entry.text));
    assert.ok(item, `the missing revert approver is a setup attention item: ${JSON.stringify(missing.setup.attention)}`);
    assert.equal(item!.subject, 'setup'); assert.equal(item!.human, false); assert.equal(item!.role, 'master');
    for (const variable of ['GRAPHYARD_REVERT_APPROVER_APP_ID', 'GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID', 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY']) {
      assert.ok(item!.text.includes(variable), `the item names ${variable}`);
      assert.ok(item!.next.includes(variable), `its next step sets ${variable}`);
    }
    assert.match(item!.text, /last-push-approval rule \(require_last_push_approval\) refuses every revert merge/);
    assert.match(item!.text, /required checks \(test, typecheck\) would stay red until an unrelated merge re-runs CI/);
    assert.ok(missing.setup.attention.includes(item!.text), 'and it is in the setup section the master reads');
    assert.deepEqual(missing.setup.mainGuard, { armed: true, required: ['test', 'typecheck'], revertApprover: null, attention: item!.text });
    assert.equal(item!.faultClass, 'configuration', 'it is counted as a configuration fault');
    assert.equal(missing.attentionItems.filter(entry => /revert approver/.test(entry.text)).length, 1, 'raised once per report');

    // Configured, or the guard not armed (no GitHub delivery, no required check): nothing is raised.
    for (const [label, approver, github, required] of [['configured', 5678, true, ['test']], ['no GitHub delivery', null, false, ['test']], ['no required check', null, true, []]] as const) {
      const quiet = await report(approver, github, [...required]);
      assert.equal(quiet.attentionItems.some(entry => /revert approver/.test(entry.text)), false, `${label}: no revert approver attention`);
      assert.deepEqual(quiet.setup.attention, [], `${label}: the setup section is clear`);
    }
  } finally { await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});
