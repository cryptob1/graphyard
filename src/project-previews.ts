// Concern: an item's openable preview (GY-1902) — which declared static application an item's cases need, and the durable preview record the loop keeps on the item.
import { z } from 'zod';
import type { ProjectDelivery } from './project-applications.js';
import type { Work } from './model/work.js';

// ---------------------------------------------------------------------------
// A change whose criteria cite an E2E case bound to a declared static application gets its own
// local preview: the loop (merge-writer/preview.ts `itemPreviewStep`) checks out the change, builds
// and serves the application, runs those cases against it and records the outcome here, on the
// item; a running record carries the built site's files, which the server keeps and serves at
// `/preview/KEY/` (server/static.ts), so the link never depends on reaching the loop's host. The record is
// the control plane's own observation, written by the coordinator identity only: it is never
// evidence and satisfies no proof. Pure and browser-safe: Work details reads it.
// ---------------------------------------------------------------------------

export const itemPreviewStates = ['starting', 'running', 'failed', 'cleaned'] as const;
export type ItemPreviewState = (typeof itemPreviewStates)[number];
/** Why a preview ended: a newer head replaced it, the item was closed or delivered, a case failed, the loop that served it restarted, or the server did not confirm its record. */
export const previewEndReasons = ['superseded', 'cancelled', 'delivered', 'failed', 'restarted', 'unconfirmed'] as const;
export type PreviewEndReason = (typeof previewEndReasons)[number];
/** How many ended previews an item keeps beside its current one, newest last. */
export const previewHistoryLimit = 5;

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'a lower-case 40-character commit');
const instant = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), 'an ISO 8601 instant');
/** One declared case's result on the preview, as the item shows it. */
export const previewCaseResultSchema = z.object({ case: z.string().min(1).max(200), result: z.enum(['pass', 'fail', 'unrun']), reason: z.string().max(500).optional() }).strict();
export type PreviewCaseResult = z.infer<typeof previewCaseResultSchema>;

/** The preview link of an item. */
export const previewPath = (key: string) => `/preview/${key}`;
/** Where the link serves the site: a directory URL, so the site's relative assets and links resolve under it. */
export const previewSiteUrl = (key: string) => `${previewPath(key)}/`;

export const itemPreviewSchema = z.object({
  /** The preview's own id: a new head, or a restarted loop, starts a new preview under a new id. */
  id: z.string().uuid(),
  path: z.string().regex(/^\/preview\/[A-Za-z0-9._-]{1,100}$/),
  state: z.enum(itemPreviewStates),
  runner: z.literal('local'),
  application: z.string().min(1).max(40),
  /** The commit previewed: the item's submitted head, or the base tip while it has none (`source`). */
  sha, source: z.enum(['head', 'base']),
  /** Where the loop serves it on its own loopback to run the cases, while it runs; the link serves the published copy, never this. */
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/).nullable(),
  cases: z.array(previewCaseResultSchema).max(100),
  detail: z.string().max(1000),
  startedAt: instant, readyAt: instant.nullable(), cleanedAt: instant.nullable(),
  endReason: z.enum(previewEndReasons).nullable(),
}).strict().superRefine((preview, context) => {
  const problem = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  // Only a preview whose every declared case passed is recorded running: a failed case never yields a passing record.
  if (preview.state === 'running' && (!preview.cases.length || preview.cases.some(entry => entry.result !== 'pass'))) problem('a running preview has every declared case passed');
  if ((preview.state === 'running') !== (preview.origin !== null)) problem('a preview names its origin exactly while it runs');
  const ended = preview.state === 'failed' || preview.state === 'cleaned';
  if (ended !== (preview.cleanedAt !== null && preview.endReason !== null)) problem('an ended preview, and only one, names when it was cleaned and why');
});
export type ItemPreview = z.infer<typeof itemPreviewSchema>;

/** The most files, and bytes in all, a preview's published site carries. */
export const previewSiteFileLimit = 1000, previewSiteByteLimit = 20 * 1024 * 1024;
/** A site file's path under the site's root: relative, `/`-separated, with no empty, `.` or `..` segment. */
export const previewSitePathSchema = z.string().min(1).max(500)
  .refine(path => !/[\0-\x1f\\]/.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'), 'a relative path inside the site');
/** One file of the built site a running preview publishes: its path, media type and base64 content. */
export const previewSiteFileSchema = z.object({ path: previewSitePathSchema, mediaType: z.string().min(1).max(100), content: z.string().max(Math.ceil(previewSiteByteLimit / 3) * 4) }).strict();
export type PreviewSiteFile = z.infer<typeof previewSiteFileSchema>;
/**
 * The loop's record of a preview: `POST /api/work/:id/merge-record` with this body. A `running`
 * record, and only one, publishes the built site (`site`), which the server serves at the link.
 */
export const previewRecordBodySchema = z.object({ kind: z.literal('preview'), preview: itemPreviewSchema, site: z.array(previewSiteFileSchema).max(previewSiteFileLimit).optional() }).strict()
  .superRefine((body, context) => {
    const problem = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if ((body.preview.state === 'running') !== (body.site !== undefined)) problem('a running preview, and only one, publishes its built site');
    if (body.site && new Set(body.site.map(file => file.path)).size !== body.site.length) problem('each site file is published once');
    if (body.site && body.site.reduce((total, file) => total + Math.floor(file.content.length * 3 / 4), 0) > previewSiteByteLimit) problem(`a published site carries at most ${previewSiteByteLimit} bytes`);
  });

declare module './model/work.js' { interface Work { preview?: ItemPreview | null; previewHistory?: ItemPreview[] } }

export const previewEnded = (preview: Pick<ItemPreview, 'state'>) => preview.state === 'failed' || preview.state === 'cleaned';

/**
 * Applies the loop's record of `preview` to `work`, or answers why it is refused. A record of the
 * item's current preview replaces it, until it has ended: an ended preview stays as it ended. A new
 * preview starts only once the current one has ended, which then moves to `previewHistory`.
 */
export function applyPreviewRecord(work: Work, preview: ItemPreview): string | null {
  if (preview.path !== previewPath(work.key)) return `${work.key}'s preview is served at ${previewPath(work.key)}, not ${preview.path}`;
  const current = work.preview ?? null;
  if (current && current.id === preview.id) {
    if (previewEnded(current) && JSON.stringify(current) !== JSON.stringify(preview)) return `${work.key}'s preview ${preview.id} already ended ${current.state}; a new head or restart starts a new preview`;
    work.preview = preview;
    return null;
  }
  if (preview.state !== 'starting') return `${work.key}'s current preview is ${current?.id ?? 'none'}, not ${preview.id}; only a starting preview replaces it`;
  if (current && !previewEnded(current)) return `${work.key}'s preview ${current.id} is still ${current.state}; it is cleaned before a new one starts`;
  if (current) work.previewHistory = [...(work.previewHistory ?? []), current].slice(-previewHistoryLimit);
  work.preview = preview;
  return null;
}

/**
 * The static application an item's declared cases need, and those cases; null when it needs none or
 * previews are off. An item previews one application, the first declared that its cases cite; the
 * cases it cites of any other static application are `omitted`, and the preview's detail names them.
 */
export function previewDemand(work: Pick<Work, 'criteria'>, delivery: ProjectDelivery | null): { application: Extract<ProjectDelivery['applications'][number], { kind: 'static' }>; cases: string[]; omitted: string[] } | null {
  if (!delivery || delivery.previews !== 'local') return null;
  const cited = [...new Set(work.criteria.flatMap(criterion => criterion.proofs).flatMap(proof => proof.startsWith('e2e:') ? [proof.slice(4)] : []))];
  const statics = delivery.applications.flatMap(application => application.kind === 'static' ? [application] : []);
  const application = statics.find(entry => cited.some(id => delivery.cases[id] === entry.id));
  if (!application) return null;
  return { application, cases: cited.filter(id => delivery.cases[id] === application.id), omitted: cited.filter(id => delivery.cases[id] !== application.id && statics.some(entry => entry.id === delivery.cases[id])) };
}

/** Why an item no longer wants its preview, or null while it does. */
export function previewEndReason(work: Pick<Work, 'stage' | 'closure'>, wanted: boolean): PreviewEndReason | null {
  if (work.stage === 'done') return work.closure ? 'cancelled' : 'delivered';
  return wanted ? null : 'cancelled';
}
