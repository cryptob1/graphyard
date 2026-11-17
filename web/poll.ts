/**
 * The dashboard's poll (GY-3363): `load` runs now, then each run starts `intervalMs` after the
 * previous one started — at once when that one overran the interval. A fixed `setInterval` that
 * skipped ticks while a read was in flight left the dashboard idle for most of another interval
 * after every slow read, so on a loaded host an item filed during one showed only ~10 s later.
 * `now()` runs a load at once unless one is in flight; `stop()` ends the poll.
 */
export function poll(load: () => Promise<void>, intervalMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, stopped = false;
  const run = async () => {
    if (running || stopped) return;
    clearTimeout(timer); running = true;
    const started = Date.now();
    try { await load(); } finally { running = false; }
    if (!stopped) timer = setTimeout(run, Math.max(0, started + intervalMs - Date.now()));
  };
  void run();
  return { now: () => void run(), stop: () => { stopped = true; clearTimeout(timer); } };
}
