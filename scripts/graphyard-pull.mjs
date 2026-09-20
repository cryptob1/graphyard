// The worker side of the pull model (GY-87). A free session asks the control plane for its next
// assignment instead of waiting to be dispatched into. It registers nothing and is invisible to
// the control plane until it claims, which is what removes central runtime-health tracking:
// nothing has to know this session exists, or is alive, for work to reach it.
//
//   GRAPHYARD_URL=… GRAPHYARD_TOKEN=… node scripts/graphyard-pull.mjs [--watch] [--host HOST] [--work GY-N]
//
// Without `--watch` it asks once and exits non-zero when there is nothing to take. With it, it
// keeps asking at the published poll interval until there is, so the wait for an assignment is one
// interval plus the claim itself. It prints the claimed item as JSON: the epoch, the lease and the
// workspace the session then registers.
//
// The pull carries one idempotency key, and a retry with the same key replays the claim the first
// call made rather than taking a second item — a pull that timed out after its claim committed
// must not leave this session holding a lease nobody told it about.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArguments(argv) {
  const options = { watch: false, host: null, work: null };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const value = () => { const next = argv[++i]; if (next === undefined) throw new Error(`${argument} needs a value`); return next; };
    if (argument === '--watch') options.watch = true;
    else if (argument === '--host') options.host = value();
    else if (argument === '--work') options.work = value();
    else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

async function readToken(env) {
  if (env.GRAPHYARD_TOKEN_FILE) return (await readFile(resolve(env.GRAPHYARD_TOKEN_FILE), 'utf8')).trim();
  if (env.GRAPHYARD_TOKEN) return env.GRAPHYARD_TOKEN;
  throw new Error('Set GRAPHYARD_TOKEN or GRAPHYARD_TOKEN_FILE to this session\'s worker credential');
}

/** The pull loop is TypeScript (src/auto-dispatch.ts); tsx is a runtime dependency already. */
export async function loadLoop() {
  const { tsImport } = await import('tsx/esm/api');
  return tsImport('../src/auto-dispatch.ts', import.meta.url);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const token = await readToken(env);
  const body = { host: options.host ?? env.GRAPHYARD_HOST_ID ?? hostname(), ...(options.work ? { work: options.work } : {}) };
  const { runWorkerPull, workerPullIntervalMs } = await loadLoop();

  const pull = async () => {
    const response = await fetch(new URL('/api/assignments/claim', base), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : JSON.stringify(result));
    return result;
  };

  const stopping = new AbortController();
  const stop = () => stopping.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  try {
    const result = await runWorkerPull(pull, { intervalMs: workerPullIntervalMs, once: !options.watch, signal: stopping.signal, log: line => console.error(line) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.assigned) process.exitCode = 1;
    return result;
  } finally { for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
