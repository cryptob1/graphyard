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
// Each pull carries one idempotency key and keeps it across transport retries, so a request that
// timed out after its claim committed replays that claim instead of taking a second item: an
// assignment this session holds is never one it was not told about. Under `--watch` a control
// plane it cannot reach is waited out, not a reason to stop asking.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** How many times one logical pull re-sends under its key before it reports that it got no answer. */
export const transportRetries = 3;

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

/** A request that never got an answer, as opposed to a server that refused: only this is retried. */
const noAnswer = error => error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError;

/**
 * One logical pull: one idempotency key, held across every transport retry.
 *
 * A request that times out may already have committed its claim, so a retry under a fresh key
 * would take a second item and leave this session holding a lease nobody told it about. Under the
 * same key the control plane replays the claim the first attempt made — that is the whole reason
 * the key exists, and it is reachable only if the retry keeps it. A refusal from the server is an
 * answer and is not retried; only a request that got none is.
 */
export async function pullOnce(ask, options = {}) {
  const attempts = options.attempts ?? transportRetries, log = options.log ?? (() => {});
  const key = options.key ?? randomUUID(), backoffMs = options.backoffMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    try { return await ask(key); }
    catch (error) {
      if (!noAnswer(error) || attempt >= attempts) throw error;
      log(`[graphyard-worker] pull attempt ${attempt} did not answer (${error.message}); retrying under the same key`);
      // A refused connection comes back at once, so the retries wait a little rather than
      // spending the whole logical pull in the same instant the control plane was unreachable.
      if (backoffMs) await delay(attempt * backoffMs);
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv);
  const base = env.GRAPHYARD_URL;
  if (!base) throw new Error('Set GRAPHYARD_URL to the control plane origin');
  const token = await readToken(env);
  const body = { host: options.host ?? env.GRAPHYARD_HOST_ID ?? hostname(), ...(options.work ? { work: options.work } : {}) };
  const { runWorkerPull, workerPullIntervalMs } = await loadLoop();

  const ask = async key => {
    const response = await fetch(new URL('/api/assignments/claim', base), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : JSON.stringify(result));
    return result;
  };

  const stopping = new AbortController();
  const stop = () => stopping.abort();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  const log = line => console.error(line);
  // Watching is the idle session's normal state, so a pull that could not reach the control plane
  // at all is reported and waited out rather than ending the session; a single `--once` pull
  // reports the failure to its caller.
  const pull = async () => {
    try { return await pullOnce(ask, { log }); }
    catch (error) { if (!options.watch) throw error; log(`[graphyard-worker] pull failed: ${error.message}`); return { assigned: null, offered: 0, refused: [{ key: '-', reason: error.message }] }; }
  };
  try {
    const result = await runWorkerPull(pull, { intervalMs: workerPullIntervalMs, once: !options.watch, signal: stopping.signal, log });
    console.log(JSON.stringify(result, null, 2));
    if (!result.assigned) process.exitCode = 1;
    return result;
  } finally { for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
