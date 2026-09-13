import { spawnSync } from 'node:child_process';
const result = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['plugin', 'pane', 'open', '--plugin', 'graphyard', '--entrypoint', 'ledger', '--placement', 'tab', '--focus'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
