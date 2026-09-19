import { readFile } from 'node:fs/promises';
import { inheritedObligations } from '../model.js';
import { diagnose, fileConflicts, obligationLedger, proofAuthorization, proofPreview, resourceConflicts } from '../coordination.js';
import { handoff } from '../repository-setup.js';
import { defineCommands } from './registry.js';

/** Reading work: control-plane status, the ledger, diagnosis, creation and history. */
export const workCommands = defineCommands([
  {
    name: 'status',
    scope: 'work',
    help: ['  status [GY-N]                Control-plane or work status'],
    unscoped: async ({ api, print }) => print(await api('status')),
    run: async ({ print }, work) => print(work),
  },
  {
    name: 'diagnose',
    help: ['  diagnose GY-N                Explain blockers, overlap and required proof'],
    async run({ id, api, print }) {
      const snapshot = await api('work-snapshot'); const item = snapshot.work.find((w: any) => w.id === id || w.key === id);
      if (!item) throw new Error(`Unknown work item ${id}`);
      // A required proof nobody is authorized to produce can never be satisfied; report it
      // alongside the other blockers rather than leaving it to be discovered at acceptance.
      let authorities: any[] = [];
      try { authorities = (await api('proof-grants')).authorities ?? []; } catch { /* reported as unknown authority below */ }
      const authorization = proofAuthorization(item, authorities, snapshot.work);
      return print({ key: item.key, observedAt: snapshot.now, diagnostics: diagnose(item, snapshot.work, Date.parse(snapshot.now), snapshot.jobs), overlaps: fileConflicts(item, snapshot.work), proofs: proofPreview(item, snapshot.work), obligations: inheritedObligations(item, snapshot.work),
        proofAuthority: authorization, proofGaps: authorization.filter(entry => !entry.producers.length).map(entry => entry.proof) });
    },
  },
  {
    name: 'obligations',
    help: ['  obligations                  List every deferred bootstrap proof still owed and who inherits it'],
    run: async ({ api, print }) => print(obligationLedger((await api('work-snapshot')).work)),
  },
  {
    name: 'list',
    help: ['  list | next                  List all work / claimable work'],
    run: async ({ api, print }) => print((await api('work-snapshot')).work),
  },
  {
    name: 'next',
    help: [],
    async run({ api, print }) {
      const snapshot = await api('work-snapshot'); const items = snapshot.work;
      return print(items.filter((w: any) => w.stage !== 'done' && w.ready && !w.blocker && !w.containmentQuarantine && (!w.submission || w.reworkRequested) && (!w.lease || Date.parse(w.lease.expiresAt) <= Date.parse(snapshot.now)) && !resourceConflicts(w, items, Date.parse(snapshot.now)).length && w.dependencies.every((d: string) => items.some((x: any) => x.id === d && x.stage === 'done'))).sort((a: any, b: any) => a.priority - b.priority));
    },
  },
  {
    name: 'create',
    help: ['  create path/to/work.json      Create work with acceptance criteria (operator)'],
    run: async ({ id, api, print }) => print(await api('work', JSON.parse(await readFile(id!, 'utf8')))),
  },
  {
    name: 'handoff',
    help: ['  handoff GY-N                 Show assigned workspace and supervisor command'],
    async run(context) {
      const { id, api, print } = context;
      const [snapshot, status] = await Promise.all([api('work-snapshot'), api('status')]);
      const work = snapshot.work.find((w: any) => w.id === id || w.key === id);
      if (!work) throw new Error(`Unknown work item ${id}`);
      return print(handoff(work, { ...status, now: snapshot.now }, context.individualHostId(), await context.activeCliPath()));
    },
  },
  {
    name: 'events',
    scope: 'work',
    help: ['  events [GY-N]                Read immutable history'],
    unscoped: async ({ api, print }) => print(await api('events')),
    run: async ({ api, print }, work) => print(await api(`events?work=${work.id}`)),
  },
]);
