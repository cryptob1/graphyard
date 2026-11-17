// GY-3333: one install's held selection, in a process of its own. The host-level record its
// selection registers is an flock this process holds, so killing it is exactly the kernel-drop the
// shared account records promise: the session disappears with its holder, and no other install on
// the host counts it again.
import { appendFile } from 'node:fs/promises';
import { loadMasterConfig } from '../../src/master/config.js';
import { selectAccount } from '../../src/master/environments.js';

const input = JSON.parse(process.argv[2]!) as { root: string; ready: string };
try {
  const config = await loadMasterConfig(input.root);
  const selected = await selectAccount(config, 'worker', { name: 'launch' });
  const account = selected.account && 'fleet' in selected.account ? selected.account : null;
  if (!account) throw new Error('the selection named no registry account');
  await appendFile(input.ready, JSON.stringify({ account: account.name, session: account.fleet.session, install: config.repository }) + '\n');
  // The registry session and the host-level record stay held until this process is killed.
  // A pending promise alone would let Node exit; the interval keeps the process — and its lock — alive.
  setInterval(() => {}, 60_000);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
