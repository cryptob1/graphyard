import { readFile } from 'node:fs/promises';
import { wholeDocument } from '../model/work-summary.js';
import { inheritedObligations } from '../model.js';
import { diagnose, fileConflicts, obligationLedger, proofAuthorization, proofPreview, resourceConflicts } from '../coordination.js';
import { handoff } from '../repository-setup.js';
import { eventHistoryLimits, parseEventHistoryFlags } from '../events-history.js';
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
      const snapshot = await api('work-snapshot'), listed = snapshot.work.find((w: any) => w.id === id || w.key === id);
      if (!listed) throw new Error(`Unknown work item ${id}`);
      // A settled delivery is a summary in the snapshot (GY-422); its diagnosis reads the whole document.
      const item = await wholeDocument(listed, api);
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
    help: [
      '  events                       Read the latest rows of the whole ledger',
      '  events GY-N [--kind K[,K]] [--since ISO] [--until ISO] [--order asc|desc]',
      '        [--limit N] [--cursor SEQ] [--payload full|details|none] [--routine] [--all]',
      '                               Read an item\'s immutable history. Routine rows (github.observed,',
      '                               heartbeat) are summarised as counts with their first and',
      '                               last instants instead of filling the page; --routine returns',
      '                               them, and --all follows the cursor to the end of the range,',
      '                               so an item of any age can be read in full',
    ],
    unscoped: async ({ api, print }) => print(await api('events')),
    async run({ api, print, args }, work) {
      const { params, all } = parseEventHistoryFlags(args);
      params.set('work', work.id);
      params.set('view', 'history');
      // The command reads history, not document snapshots: every event payload embeds the whole
      // work document, which is unreadable at page scale and is what `--payload full` is for.
      if (!params.has('payload')) params.set('payload', 'details');
      const page = await api(`events?${params}`);
      if (!all) return print(page);
      // The whole range, one bounded page at a time, as one reconstruction.
      const events = [...page.events];
      let last = page, pages = 1;
      // The routine summary covers the whole filtered range and came with the first page; the
      // pages after it ask for the cursor alone rather than the same aggregate again.
      params.set('view', 'page');
      while (last.page.nextCursor && pages < eventHistoryLimits.pages) {
        params.set('cursor', last.page.nextCursor);
        last = await api(`events?${params}`);
        events.push(...last.events);
        pages++;
      }
      return print({ ...last, events, routine: page.routine,
        page: { ...last.page, returned: events.length, pages, pageLimit: eventHistoryLimits.pages,
          firstSeq: page.page.firstSeq, firstAt: page.page.firstAt,
          complete: !last.page.hasMore, hasMore: last.page.hasMore } });
    },
  },
]);
