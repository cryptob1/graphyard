import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { herdrCall, type HerdrInstance } from './master/herdr.js';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { atomicPrivateWrite } from './private-file.js';
import { installIdFor } from './install/types.js';
import { installDirectory } from './install/secrets.js';

/** Up/upgrade switches launches immediately. The loop revisits only the remaining drain record. */
export async function migrateHerdr(root: string, run: ChildRun = defaultChildRun, home = homedir()) {
  const file = join(root, '.graphyard/master.json');
  let config: any;
  try { config = JSON.parse(await readFile(file, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const instance: HerdrInstance | undefined = config.herdrInstance;
  if (!instance) return;
  const json = async (args: string[], target: HerdrInstance | null) => {
    const parsed = JSON.parse(await herdrCall(run, args, undefined, target));
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result ?? parsed;
  };
  const installId = installIdFor(config.repository), label = `graphyard-${installId}`;
  const listed = await json(['workspace', 'list'], null);
  const found = listed.workspaces?.find((entry: any) => entry.label === label)?.workspace_id;
  const created = found ? null : await json(['workspace', 'create', '--cwd', root, '--label', label, '--no-focus'], null);
  const workspace = found ?? created?.workspace?.workspace_id ?? created?.workspace_id;
  if (!workspace) throw new Error('Main Herdr returned no installation workspace');
  if (workspace !== config.herdrWorkspace) {
    config.herdrWorkspace = workspace;
    await atomicPrivateWrite(file, config);
  }
  // An unavailable inventory is not evidence that the private server is empty.
  const privatePanes = await json(['pane', 'list'], instance).catch(() => null);
  if (!Array.isArray(privatePanes?.panes) || privatePanes.panes.length) return;
  const unit = `graphyard-herdr-${installId}.service`;
  await run('systemctl', ['--user', 'disable', '--now', unit]);
  await rm(join(home, '.config/systemd/user', unit), { force: true });
  await rm(join(home, '.config/herdr/sessions', instance.session), { force: true });
  await rm(instance.configHome, { recursive: true, force: true });
  await run('systemctl', ['--user', 'daemon-reload']);
  // GY-3232: the install and up records forget the private server too, so nothing passes it again.
  for (const record of [join(installDirectory(installId), 'install.json'), join(root, '.graphyard/up.json')]) {
    let recorded: any;
    try { recorded = JSON.parse(await readFile(record, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    if (!('herdrInstance' in recorded)) continue;
    delete recorded.herdrInstance;
    await atomicPrivateWrite(record, recorded);
  }
  delete config.herdrInstance;
  await atomicPrivateWrite(file, config);
}
