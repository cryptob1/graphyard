import { parseArgs } from 'node:util';
import type { MasterConfig } from '../master.js';
import { executorFleetReport, executorRestartTimeoutMs, readExecutorRegistrations, restartExecutors, type ExecutorRestartResult } from '../executor-fleet.js';

export const executorsHelp = [
  '  master executors              Every executor registered on this host with the release it loaded',
  '                                beside the coordinator\'s own, and which of them stand down',
  '  master executors restart [--timeout SECONDS]',
  '                                Stop and start every executor registered on this host through its',
  '                                supervisor and wait for each to register again on the current',
  '                                release; refused while any executor holds a claimed action',
];

export interface ExecutorsCommandApi {
  /** `GET /api/actions`, whose live claims decide whether a restart may go ahead. */
  actions: () => Promise<any>;
  /** The release the coordinator runs: the CLI checkout's commit. */
  coordinatorCommit: string | null;
  run?: (command: string, args: string[]) => string;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `graphyard master executors [restart]` (GY-126): the fleet on this host, and the one command that
 * brings every executor onto the release the coordinator runs. Both read the host-local records
 * the executors keep beside the coordinator credential; the restart goes through each executor's
 * supervisor unit and never signals a process itself.
 */
export async function executorsCommand(master: Pick<MasterConfig, 'credentialFile' | 'hostId'>, args: string[], api: ExecutorsCommandApi): Promise<unknown> {
  const [action, ...rest] = args;
  if (!action) {
    const report = executorFleetReport(await readExecutorRegistrations(master), { commit: api.coordinatorCommit }, { hostId: master.hostId, alive: api.alive });
    return { host: master.hostId, ...report, lines: report.executors.map(row => row.line) };
  }
  if (action === 'restart') {
    const { values } = parseArgs({ args: rest, options: { timeout: { type: 'string' } }, allowPositionals: false });
    const timeoutSeconds = values.timeout ? Number(values.timeout) : executorRestartTimeoutMs / 1000;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 900) throw new Error('Use master executors restart --timeout with whole seconds between 5 and 900');
    const result: ExecutorRestartResult = await restartExecutors(master, { actions: api.actions, coordinatorCommit: api.coordinatorCommit, run: api.run, alive: api.alive, sleep: api.sleep, timeoutMs: timeoutSeconds * 1000 });
    if (result.result !== 'restarted') process.exitCode = 1;
    return { host: master.hostId, ...result };
  }
  throw new Error('Use master executors, or master executors restart [--timeout SECONDS]');
}
