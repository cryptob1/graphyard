import { spawnSync } from 'node:child_process';
import { readBinding } from './config.mjs';
const binding = await readBinding();
const result = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['plugin', 'pane', 'open', '--plugin', 'graphyard', '--entrypoint', 'ledger', '--placement', 'tab', '--focus', ...(binding.workspace ? ['--workspace', binding.workspace] : [])], { stdio: 'inherit' });
process.exit(result.status ?? 1);
