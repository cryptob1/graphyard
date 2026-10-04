import { demand, operatorScopeIncludes } from '../model.js';
import { doctorRunRecordSchema } from '../daemon/state.js';
import { parseJson, type Route } from './routes.js';

/** The ledger kinds the pipeline doctor's runs are recorded under (GY-711): one per run, one per item a run found. */
export const doctorRunEvent = 'doctor-run', doctorFindingEvent = 'doctor-finding';
/** Whether a subject a doctor run names is a work item (`GY-74`), not a status-level one (`installation`). */
const itemKey = (subject: string) => /^GY-\d+$/.test(subject);

export const doctorRoute: Route = {
  // The pipeline doctor's run summaries (GY-711). The loop posts one per doctor run, as the
  // master's operator-agent identity, and the route aggregates each item's findings and actions
  // into one event on that item, so a run is one summary in the ledger with an event per item it
  // found or acted on. The last runs are served on /api/status for `master status` and the
  // dashboard's Doctor panel. An operator identity needs the master's filing capability — any
  // operator-agent token may not append doctor history — and every item the run names must be
  // inside the poster's scope, so a narrow agent poisons no audit history beyond its authority.
  method: 'POST', path: '/api/doctor',
  async handle(context) {
    const { actor, services: { engine } } = context;
    demand(['coordinator', 'admin'].includes(actor.role)
      || (actor.role === 'operator-agent' && !!actor.capabilities?.includes('intent:create')),
      'Coordinator permission or the intent:create capability is required', 403);
    const run = doctorRunRecordSchema.parse(await parseJson(context, 262_144));
    // One event per item: an action on an item with no finding reaches its history too, and
    // several findings for one item are one event, never a duplicate.
    const perItem = new Map<string, { subject: string; findings: unknown[]; actions: unknown[] }>();
    for (const finding of run.findings) if (itemKey(finding.subject)) {
      const entry = perItem.get(finding.subject) ?? { subject: finding.subject, findings: [], actions: [] };
      entry.findings.push(finding);
      perItem.set(finding.subject, entry);
    }
    for (const action of run.actions) if (itemKey(action.subject)) {
      const entry = perItem.get(action.subject) ?? { subject: action.subject, findings: [], actions: [] };
      entry.actions.push(action);
      perItem.set(action.subject, entry);
    }
    // The summary and its per-item events land in one transaction: a run is recorded whole or
    // not at all, and the loop posts a refused run again.
    await engine.store.transaction(async db => {
      // An operator identity appends history only for the items inside its scope, judged before
      // anything is written, so a refused run leaves the ledger exactly as it was.
      if (actor.role === 'operator-agent' && perItem.size) {
        const referenced = (await db.query(`SELECT id, document->>'key' AS key FROM work_items WHERE document->>'key' = ANY($1)`, [[...perItem.keys()]])).rows as { id: string; key: string }[];
        const outside = referenced.filter(item => !operatorScopeIncludes(actor, item)).map(item => item.key);
        demand(!outside.length, `Work item is outside this operator-agent scope: ${outside.join(', ')}`, 403);
      }
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, doctorRunEvent, JSON.stringify(run)]);
      if (!perItem.size) return;
      const items = (await db.query(`SELECT id, document->>'key' AS key FROM work_items WHERE document->>'key' = ANY($1)`, [[...perItem.keys()]])).rows as { id: string; key: string }[];
      for (const entry of perItem.values()) {
        const item = items.find(candidate => candidate.key === entry.subject);
        if (item) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [item.id, actor.id, doctorFindingEvent, JSON.stringify(entry)]);
      }
    });
    return { recorded: true, runs: 1 };
  },
};
