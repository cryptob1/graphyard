import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, operatorScopeIncludes, type Principal, type Work } from './model.js';
import { broadScope } from './coordination.js';
import { isDelivered } from './model/closure.js';
import { pathScopeContains } from './model/scope.js';
import { settleDelivered } from './model/actions.js';
import { decompositionPayloadSchema, decompositionSettingsSchema, type DecompositionPayload, type DecompositionSettings } from './runner/payloads.js';
import { save } from './store.js';
import { lockedWork, workIdByRef } from './store/locked-read.js';
import type { Services } from './server/routes.js';

// ---------------------------------------------------------------------------
// Splitting broad items before dispatch (GY-1126).
//
// A broad item (many criteria, root-level planned directories such as src/ tests/ docs/) builds
// into a large pull request that collides with others in the merge queue and is ejected, costing
// a CI and a review round each time. Before an item is first dispatched the loop judges it against
// size bounds (`run.decomposition`: criteria count, planned-file breadth, an estimated change
// size). An item over them gets one Pi session on the research account (src/decomposition-step.ts)
// that proposes child items through the typed `graphyard_decompose` tool. The control plane, not
// the session, makes the split in one transaction (`recordDecomposition`): it copies each named
// criterion's text and proofs from the parent, refuses a split that drops a criterion, gives one
// to two children or names a scope that does not shrink inside the parent's, and creates the
// children as ordinary `GY-N` items that inherit the parent's release, dependencies, exclusive
// resources, policy and documentation obligation. The parent is then never dispatched: it is
// delivered, with a ledger event, in the transaction that delivers its last child
// (`deliverSplitParent`). An item within the bounds, opted out with `"split": false`, already
// dispatched, or whose run fails or keeps it whole, is dispatched unchanged.
// ---------------------------------------------------------------------------

/** The Graphyard Pi tool whose call is the decomposition session's answer (integrations/pi). */
export const decompositionTool = 'graphyard_decompose';
/** The role the Pi extension registers the decomposition tool for. */
export const decompositionRole = 'decomposition';
/** How long past its timeout a run recorded as running still holds dispatch, for its end to be recorded. */
export const decompositionHoldGraceMs = 60_000;

/** The decomposition run the loop recorded on the item, and what it decided. */
export interface DecompositionRecord {
  state: 'running' | 'split' | 'kept' | 'failed';
  startedAt: string; endedAt: string | null;
  runtime: string; model: string; timeoutMs: number;
  /** Why the item was judged over the size bounds. */
  bounds: string[];
  reason: string | null;
  children: string[];
  failure: { reason: string; detail: string } | null;
  recordedBy: string;
}

/** The settings in force: `run.decomposition` over its defaults. */
export const decompositionSettings = (run: { decomposition?: unknown } | Record<string, unknown> | undefined): DecompositionSettings => {
  if (!run) return decompositionSettingsSchema.parse({});
  if ('decomposition' in run || 'research' in run || 'pi' in run) {
    return decompositionSettingsSchema.parse((run as { decomposition?: unknown }).decomposition ?? {});
  }
  return decompositionSettingsSchema.parse(run);
};

/** A rough size of the change an item asks for, in lines: per criterion, per root-level directory, per narrower path. */
export function estimatedLines(work: Pick<Work, 'criteria' | 'plannedFiles'>) {
  const planned = work.plannedFiles ?? [];
  return work.criteria.length * 150 + planned.reduce((sum, path) => sum + (broadScope(path) ? 400 : path.endsWith('/') ? 200 : 60), 0);
}

/** Every size bound the item exceeds, named; empty when it is within all of them. */
export function sizeBoundsExceeded(work: Pick<Work, 'criteria' | 'plannedFiles'>, settings: DecompositionSettings): string[] {
  const planned = work.plannedFiles ?? [], broad = planned.filter(broadScope), lines = estimatedLines(work);
  return [
    ...(work.criteria.length > settings.maxCriteria ? [`${work.criteria.length} criteria, over ${settings.maxCriteria}`] : []),
    ...(broad.length > settings.maxBroadScopes ? [`${broad.length} root-level planned directories (${broad.join(', ')}), over ${settings.maxBroadScopes}`] : []),
    ...(planned.length > settings.maxPlannedFiles ? [`${planned.length} planned paths, over ${settings.maxPlannedFiles}`] : []),
    ...(lines > settings.maxEstimatedLines ? [`an estimated ${lines} changed lines, over ${settings.maxEstimatedLines}`] : []),
  ];
}

/** Whether the item has never been handed to a worker: no attempt, lease, submission or implementer. */
export const neverDispatched = (work: Work) => work.epoch === 0 && !work.lease && !work.submission && !work.candidate && !(work.implementers?.length);

/**
 * Why the item is split before dispatch, or null when it is dispatched unchanged: it must be open,
 * never dispatched, not opted out, not itself a child or already decided, have at least two
 * criteria to share out, and exceed a size bound (or opt in with `"split": true`).
 */
export function decompositionWanted(work: Work, settings: DecompositionSettings): string[] | null {
  if (!settings.enabled || work.split === false || work.stage === 'done' || work.repair || work.parent || work.children?.length || work.decomposition) return null;
  if (!neverDispatched(work) || work.criteria.length < 2) return null;
  const exceeded = sizeBoundsExceeded(work, settings);
  return exceeded.length ? exceeded : work.split === true ? ['opted in with "split": true'] : null;
}

/** Whether dispatch waits for the item's decomposition: only while its run is recorded as running, within its time limit and the grace to record its end. */
export function decompositionHold(work: Work, clock: number) {
  const record = work.decomposition;
  return !!record && record.state === 'running' && clock < Date.parse(record.startedAt) + record.timeoutMs + decompositionHoldGraceMs;
}

// ---- The split itself: validated against the parent, never weakening it ---------------------

/**
 * The parent's criteria are covered exactly: every one is given to exactly one child, and a child
 * names only the parent's criteria. Text and proofs are the parent's own, copied, so none can be
 * weakened.
 */
export function validateSplitCriteria(parent: Pick<Work, 'key' | 'criteria'>, children: DecompositionPayload['children']) {
  const ids = new Set(parent.criteria.map(criterion => criterion.id)), given = new Map<string, number>();
  children.forEach((child, index) => {
    for (const id of child.criteria) {
      demand(ids.has(id), `Child ${index + 1} names ${id}, which is not a criterion of ${parent.key}`, 422);
      demand(!given.has(id), `${id} of ${parent.key} is given to child ${given.get(id)! + 1} and child ${index + 1}; each criterion goes to exactly one child`, 422);
      given.set(id, index);
    }
  });
  const dropped = parent.criteria.filter(criterion => !given.has(criterion.id)).map(criterion => criterion.id);
  demand(!dropped.length, `The split drops ${dropped.join(', ')} of ${parent.key}; the children's criteria must cover the parent's exactly`, 422);
}

/**
 * Each child's planned files lie inside the parent's and are strictly narrower: no child plans the
 * parent's whole scope, so a child's change is smaller than the parent's would have been.
 */
export function validateChildScopes(parent: Pick<Work, 'key' | 'plannedFiles'>, children: DecompositionPayload['children']) {
  const planned = parent.plannedFiles ?? [];
  children.forEach((child, index) => {
    if (!planned.length) return;
    const outside = child.plannedFiles.filter(path => !planned.some(scope => pathScopeContains(scope, path)));
    demand(!outside.length, `Child ${index + 1} plans ${outside.join(', ')}, outside ${parent.key}'s planned files`, 422);
    const whole = planned.every(scope => child.plannedFiles.some(path => pathScopeContains(path, scope)));
    demand(!whole, `Child ${index + 1} plans all of ${parent.key}'s scope (${planned.join(', ')}); each child plans a strictly narrower part`, 422);
  });
}

/** Ordering between children names only earlier siblings, so it can form no cycle. */
export function validateChildOrder(children: DecompositionPayload['children']) {
  children.forEach((child, index) => demand(child.after.every(position => position < index), `Child ${index + 1} must land after an earlier child only (after: ${child.after.join(', ')})`, 422));
}

/**
 * The child items of a split, before the store numbers them: ordinary open items carrying the
 * parent's release, policy, dependencies, exclusive resources and documentation obligation, and
 * exactly the criteria (text and proofs copied) the payload gives each.
 */
export function childItems(parent: Work, payload: DecompositionPayload, now: Date): Work[] {
  validateSplitCriteria(parent, payload.children);
  validateChildScopes(parent, payload.children);
  validateChildOrder(payload.children);
  const at = now.toISOString(), ids = payload.children.map(() => randomUUID());
  return payload.children.map((child, index) => {
    const criteria = parent.criteria.filter(criterion => child.criteria.includes(criterion.id)).map(criterion => structuredClone(criterion));
    const proofs = new Set(criteria.flatMap(criterion => criterion.proofs));
    return {
      id: ids[index], key: '', title: child.title,
      description: `${child.description ? `${child.description}\n\n` : ''}Split from ${parent.key} (${parent.title}) before dispatch; ${parent.key} is delivered when all of its children are.`,
      type: parent.type, priority: parent.priority, policy: structuredClone(parent.policy), criteria,
      dependencies: [...parent.dependencies, ...child.after.map(position => ids[position])],
      plannedFiles: [...child.plannedFiles],
      ...(parent.exclusiveResources ? { exclusiveResources: [...parent.exclusiveResources] } : {}),
      ...(parent.producerProofs ? { producerProofs: parent.producerProofs.filter(proof => proofs.has(proof)) } : {}),
      ...(parent.slice ? { slice: parent.slice } : {}),
      ...(parent.systemDriven !== undefined ? { systemDriven: parent.systemDriven } : {}),
      ...(parent.research !== undefined ? { research: parent.research } : {}),
      ...(parent.documentation ? { documentation: structuredClone(parent.documentation) } : {}),
      proofGaps: (parent.proofGaps ?? []).filter(proof => proofs.has(proof)),
      parent: parent.key,
      stage: 'backlog', ready: parent.ready, revision: 0, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
      epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
      scenarioRequirements: parent.scenarioRequirements.filter(requirement => proofs.has(requirement.proof)).map(requirement => ({ ...requirement })),
      evidence: [], observation: null, blocker: null, gates: [], violations: [],
    } as Work;
  });
}

// ---- What the loop records on the item -------------------------------------------------------

const line = (max: number) => z.string().trim().min(1).max(max);
export const decompositionEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), runtime: line(40), model: line(200), timeoutMs: z.number().int().positive().max(3_600_000), bounds: z.array(line(300)).min(1).max(10) }).strict(),
  z.object({ event: z.literal('decided'), payload: decompositionPayloadSchema }).strict(),
  z.object({ event: z.literal('failed'), reason: line(40), detail: line(1000) }).strict(),
]);
export type DecompositionEvent = z.input<typeof decompositionEventSchema>;

/**
 * Apply one decomposition event to the parent: the server's transition, which the loop's tests
 * replay. A run starts once per item, only before its first dispatch; only a running run records
 * its end. A decision with children returns them for the caller to store; the parent then names them.
 */
export function applyDecompositionEvent(work: Work, input: DecompositionEvent, actor: string, now: Date): Work[] {
  const event = decompositionEventSchema.parse(input), at = now.toISOString();
  if (event.event === 'started') {
    demand(!work.decomposition, `${work.key} was already put to decomposition (${work.decomposition?.state}); one run per item`);
    demand(neverDispatched(work) && !work.parent && work.split !== false, `${work.key} is a child, opted out, or already dispatched; only an item before its first dispatch is split`);
    work.decomposition = { state: 'running', startedAt: at, endedAt: null, runtime: event.runtime, model: event.model, timeoutMs: event.timeoutMs, bounds: event.bounds,
      reason: null, children: [], failure: null, recordedBy: actor };
    return [];
  }
  const record = work.decomposition;
  demand(record?.state === 'running', `${work.key} has no decomposition run to record the end of`);
  if (event.event === 'failed') {
    work.decomposition = { ...record!, state: 'failed', endedAt: at, failure: { reason: event.reason, detail: event.detail } };
    return [];
  }
  if (!event.payload.children.length) {
    work.decomposition = { ...record!, state: 'kept', endedAt: at, reason: event.payload.reason };
    return [];
  }
  // A worker may have claimed it since the run started: a split then would race the attempt.
  demand(neverDispatched(work), `${work.key} was dispatched while it was being split; it is built whole`);
  demand(work.split !== false, `${work.key} was opted out of splitting while it was being split; it is built whole`);
  const children = childItems(work, event.payload, now);
  work.decomposition = { ...record!, state: 'split', endedAt: at, reason: event.payload.reason };
  return children;
}

/** Name the stored children on the parent: the split relation `master status` shows. */
export function linkChildren(parent: Work, children: readonly Work[]) {
  parent.children = children.map(child => child.key);
  parent.decomposition = { ...parent.decomposition!, children: [...parent.children] };
}

// ---- The parent's delivery -------------------------------------------------------------------

/**
 * The parent `child` completes, delivered: when the last of a split parent's children is
 * delivered the parent is too, its delivery naming every child's merge and its own merge fields
 * the last of them. Null when `child` has no parent or a sibling is not delivered yet.
 */
export function splitParentDelivery(child: Work, all: readonly Work[], now: Date): Work | null {
  const parent = child.parent ? all.find(entry => entry.key === child.parent) : null;
  if (!parent?.children?.length || parent.stage === 'done') return null;
  const children = parent.children.map(key => all.find(entry => entry.key === key));
  if (!children.every(entry => entry && isDelivered(entry) && entry.delivery)) return null;
  const childCriteria = new Map<string, { text: string; proofs: readonly string[] }>();
  for (const c of children as Work[]) {
    for (const cr of c.criteria) childCriteria.set(cr.id, { text: cr.text, proofs: cr.proofs });
  }
  const covered = parent.criteria.every(pc => {
    const cc = childCriteria.get(pc.id);
    return cc && cc.text === pc.text && JSON.stringify(cc.proofs) === JSON.stringify(pc.proofs);
  });
  if (!covered) return null;
  const merges = (children as Work[]).map(entry => ({ key: entry.key, mergeSha: entry.delivery!.mergeSha, mergedAt: entry.delivery!.mergedAt }))
    .sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt));
  const last = merges[merges.length - 1];
  parent.stage = 'done'; parent.stageEnteredAt = now.toISOString();
  parent.delivery = { mergedAt: last.mergedAt, mergeSha: last.mergeSha, authorizationRevision: parent.revision, children: merges };
  return parent;
}

/**
 * Why a requirements revision of a split child is refused, or null: the parent is delivered only
 * when its children carry each of its criteria unchanged, so a child may add criteria but may not
 * rewrite or retire one it inherited from the parent; that would leave the parent undelivered.
 */
export function splitChildRevisionRefusal(child: Work, parent: Work, revised: readonly { id: string; text: string; proofs: readonly string[] }[]): string | null {
  const same = (left: { text: string; proofs: readonly string[] }, right: { text: string; proofs: readonly string[] }) =>
    left.text === right.text && JSON.stringify(left.proofs) === JSON.stringify(right.proofs);
  const inherited = child.criteria.filter(cr => parent.criteria.some(pc => pc.id === cr.id && same(pc, cr)));
  const changed = inherited.filter(cr => !revised.some(next => next.id === cr.id && same(next, cr)));
  return changed.length
    ? `${child.key} carries ${changed.map(cr => cr.id).join(', ')} of its split parent ${parent.key}, which is delivered only when its children keep them unchanged; add criteria instead of rewriting or retiring inherited ones`
    : null;
}

/**
 * Deliver the split parent of a child delivered in this transaction, with its own ledger event
 * (`decomposition.parent-delivered`). The delivery paths call it beside the child's own save.
 */
export async function deliverSplitParent(db: pg.PoolClient, child: Work, all: Work[], now: Date) {
  if (!child.parent) return null;
  // The caller's board holds stand-ins for items it does not act on (GY-1027): the parent and the
  // child's siblings are read whole here, bounded by the split's own size, and the parent replaces
  // its stand-in in the board so the save writes the document.
  const parentRow = (await db.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')} FOR UPDATE`, [child.parent])).rows[0];
  if (!parentRow) return null;
  const parentDocument = parentRow.document as Work;
  const siblings = (parentDocument.children ?? []).filter(key => key !== child.key);
  const siblingDocuments: Work[] = siblings.length
    ? (await db.query('SELECT document FROM work_items WHERE id IN (SELECT id FROM work_index WHERE key = ANY($1::text[])) ORDER BY number', [siblings])).rows.map(row => row.document)
    : [];
  const parent = splitParentDelivery(child, [parentDocument, child, ...siblingDocuments], now);
  if (!parent) return null;
  const index = all.findIndex(entry => entry.id === parent.id);
  if (index >= 0) all[index] = parent;
  await db.query('DELETE FROM jobs WHERE work_id=$1', [parent.id]);
  settleDelivered(parent, all, now);
  await save(db, parent, 'graphyard', 'decomposition.parent-delivered', now, { children: parent.delivery!.children, lastChild: child.key });
  return parent;
}

// ---- The control plane's route -----------------------------------------------------------------

type Db = pg.PoolClient;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Evaluating = { evaluate(work: Work, all: Work[], now: Date): void; recordDispatch(db: Db, work: Work, now: Date): Promise<void> };

/**
 * `POST /api/work/ID/decomposition`: the loop records a run starting, its decision, or its
 * failure, as the coordinator. A decision with children creates them as numbered items and links
 * them to the parent in the same transaction; nothing a caller sends sets the relation directly.
 */
export async function recordDecomposition(services: Services, actor: Principal, id: string, body: unknown, key: string) {
  const event = decompositionEventSchema.parse(body);
  demand(actor.role === 'coordinator' || actor.role === 'admin', 'Coordinator permission required', 403);
  demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
  const engine = services.engine as unknown as Evaluating;
  return services.engine.store.transaction(async (db, now) => {
    const fingerprint = digest({ id, decomposition: event });
    const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
    if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as Work; }
    // The item itself, its dependencies and the open items overlapping it, whole; the rest as stand-ins (GY-1027).
    const all: Work[] = await lockedWork(db, [id]);
    const work = all.find(item => item.id === id || item.key === id);
    demand(work, 'Work item not found', 404);
    demand(operatorScopeIncludes(actor, work!), 'Work item is outside this operator-agent scope', 403);
    demand(work!.stage !== 'done', 'Delivered work is immutable');
    const children = applyDecompositionEvent(work!, event, actor.id, now);
    for (const child of children) {
      const inserted = await db.query('INSERT INTO work_items(id,document) VALUES($1,$2) RETURNING number', [child.id, JSON.stringify(child)]);
      child.key = `GY-${inserted.rows[0].number}`;
      all.push(child);
    }
    if (children.length) linkChildren(work!, children);
    for (const child of children) {
      engine.evaluate(child, all, now);
      await save(db, child, actor.id, 'decomposition.child-created', now, { parent: work!.key, criteria: child.criteria.map(criterion => criterion.id), plannedFiles: child.plannedFiles });
    }
    engine.evaluate(work!, all, now);
    await engine.recordDispatch(db, work!, now);
    const record = work!.decomposition!;
    await save(db, work!, actor.id, `decomposition.${record.state === 'running' ? 'started' : record.state}`, now,
      { state: record.state, bounds: record.bounds, reason: record.reason, children: record.children, failure: record.failure });
    await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(work)]);
    return work!;
  });
}

// ---- What `master status` shows ----------------------------------------------------------------

/** An item's split relation as `master status` shows it on its row: its parent, or its children and the run that split it. Null for an item never put to decomposition. */
export function splitRelation(work: Work) {
  if (!work.parent && !work.children?.length && !work.decomposition) return null;
  return { parent: work.parent ?? null, children: work.children ?? [], decomposition: work.decomposition ? { state: work.decomposition.state, bounds: work.decomposition.bounds, reason: work.decomposition.reason ?? work.decomposition.failure?.detail ?? null } : null };
}
/** Every split parent with each child's stage: the parent is delivered when every child is. */
export function splitReport(all: readonly Work[]) {
  return all.filter(work => work.children?.length).map(parent => ({ key: parent.key, title: parent.title, delivered: isDelivered(parent),
    children: parent.children!.map(key => { const child = all.find(entry => entry.key === key); return { key, stage: child?.stage ?? null, delivered: !!child && isDelivered(child) }; }) }));
}
