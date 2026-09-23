import type { AttentionItem, HerdrAgent, MasterConfig } from './master.js';
import type { Work } from './model.js';
import type { ReviewRecord } from './reviewer.js';
import type { ProducerRecord } from './producer.js';
import { attributionFor, describeReading, loadedRevision, readDisk, readPlaneResources, readReclaimReports, readResources, resourceAttention, type ResourceReading } from './master-resources.js';

/**
 * The resource picture `master status` reports (GY-132): every registered resource as used of
 * bound with its headroom, one attention item per resource below its warning line, and the last
 * reclaim the loop recorded. It reads what the report already holds — the ledgers, Herdr, the
 * work snapshot, the loop's liveness — and adds the plane's own report from `/healthz`, the
 * worktree volume and the revision the running loop loaded.
 */
export async function resourceStatus(root: string, master: MasterConfig, observed: {
  reviews: ReviewRecord[] | null; producers: ProducerRecord[] | null; agents: HerdrAgent[] | null; work: Work[];
  loop: { lagMs: number | null; stalledAfterMs: number; detail: string; lock: { pid: number; host: string } | null } | null;
}, deps: { fetcher?: typeof fetch; run?: (command: string, args: string[]) => string; now?: number } = {}) {
  const now = deps.now ?? Date.now();
  const lock = observed.loop?.lock;
  const revision = lock && lock.host === master.hostId ? loadedRevision(root, lock.pid, deps.run, now) : null;
  const readings = readResources({ now, reviews: observed.reviews, producers: observed.producers, agents: observed.agents, work: observed.work,
    profiles: { workers: master.workers, reviewers: master.reviewers, producers: master.producers },
    plane: await readPlaneResources(master.url, deps.fetcher), loop: observed.loop, revision, disk: await readDisk(root, master) });
  const attention = resourceAttention(readings);
  return { readings, attention, report: resourceReport(readings, (await readReclaimReports(root)).at(-1) ?? null) };
}

/** The `resources` block of `master status`: one row per reading, with a one-line summary. */
export function resourceReport(readings: ResourceReading[], lastReclaim: unknown) {
  const pressed = readings.filter(reading => reading.state === 'low' || reading.state === 'exhausted');
  return {
    summary: `${readings.length} resource reading(s): ${pressed.length ? pressed.map(reading => `${reading.id} ${reading.state}`).join(', ') : 'all within their warning lines'}${readings.some(reading => reading.state === 'unknown') ? `; unread: ${readings.filter(reading => reading.state === 'unknown').map(reading => reading.id).join(', ')}` : ''}`,
    readings: readings.map(({ id, title, unit, used, bound, headroom, warnBelow, state, detail, owner, reclaim, reclaimable, waiting }) => ({ id, title, unit, used, bound, headroom, warnBelow, state, detail, owner, reclaim, reclaimable, ...(waiting === undefined ? {} : { waiting }) })),
    lastReclaim,
  };
}

/**
 * Names the resource in place of the symptom. An attention item whose text is the downstream
 * effect of a resource at its bound — a reviewer "busy in Herdr" on a name a finished pane holds,
 * a launch refused by a full ledger, a stalled action repeating either — is rewritten to name the
 * resource, its bound and its usage, and keeps its subject; its next step becomes the resource's remedy.
 */
export function attributeAttention(items: AttentionItem[], readings: ResourceReading[]): AttentionItem[] {
  return items.map(item => {
    if (item.subject.startsWith('resource:')) return item;
    const reading = attributionFor(item.text, readings);
    if (!reading) return item;
    return { ...item, text: `${item.subject} is held by a registered resource at its bound: ${describeReading(reading)}. ${reading.remedy}`, next: reading.remedy };
  });
}
