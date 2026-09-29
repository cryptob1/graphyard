import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { wholeDocument } from '../model/work-summary.js';
import { inheritedObligations } from '../model.js';
import { diagnose, fileConflicts, obligationLedger, proofAuthorization, proofPreview, resourceConflicts } from '../coordination.js';
import { handoff } from '../repository-setup.js';
import { eventHistoryLimits, parseEventHistoryFlags } from '../events-history.js';
import { defineCommands } from './registry.js';

/**
 * The one proof of an item a follow-up finding is promoted into (GY-896): the finding is addressed
 * in code, or declined with a recorded reason. A `manual:` proof a producer session may hold, so
 * the promoted item is shepherded like the batch it came from; until a producer holds the name it
 * stays a proof gap (unauthorizedProofs), which raises the operator's grant decision. It is not the
 * batch's own `manual:review-followups-triaged`, so a promoted item never counts as its parent's
 * follow-up item.
 */
const promotedFindingProof = 'manual:review-followup-addressed';
const promotedFindingPreamble = 'The promoted finding is addressed in code, or declined with a recorded reason: ';

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
    name: 'promote-followup',
    help: ['  promote-followup GY-N INDEX   Promote finding INDEX of follow-up GY-N to its own work item (operator)'],
    async run({ id, args, api, print }) {
      if (!args[0]) throw new Error('Usage: graphyard work promote-followup GY-N INDEX');
      const index = Number(args[0]);
      if (!Number.isInteger(index) || index < 1) throw new Error('INDEX must be a positive integer');
      const snapshot = await api('work-snapshot');
      const listed = snapshot.work.find((w: any) => w.id === id || w.key === id);
      if (!listed) throw new Error(`Unknown work item ${id}`);
      const { followUpEntries, followUpParent } = await import('../model/machine-backlog.js');
      // A settled batch is served as a summary without its description; its findings live in the
      // origin the summary keeps, and the whole document answers for the rest.
      const followupItem = await wholeDocument(listed, api);
      const parentKey = followUpParent(followupItem);
      if (!parentKey) throw new Error(`${followupItem.key} is not a review follow-up item`);
      const findings = followUpEntries(followupItem);
      if (index > findings.length) throw new Error(`${followupItem.key} holds ${findings.length} finding(s); there is no finding ${index}`);
      const finding = findings[index - 1]!;
      const parentItem = snapshot.work.find((w: any) => w.id === followupItem.dependencies?.[0] || w.key === parentKey);
      if (!parentItem) throw new Error(`The followed-up item ${parentKey} was not found`);
      // One work item per promoted finding, decided before anything is sent: the title names the
      // batch and the finding index, so a rerun finds the item the first run created and changes
      // nothing, and the create itself goes out under a deterministic idempotency key, so the
      // server replays the recorded create for the same request instead of making a second item.
      // The promotion is one transaction — the create — so no partial state can arise; the batch
      // keeps every finding, and its triage decides the rest as before.
      const title = `Promoted follow-up ${followupItem.key} finding ${index}: ${finding.text}`.slice(0, 200);
      const existing = snapshot.work.find((w: any) => w.title === title);
      if (existing) return print({ promoted: { from: followupItem.key, finding: index, parent: parentItem.key }, item: existing, duplicate: true,
        message: `Finding ${index} of ${followupItem.key} was already promoted to ${existing.key}` });
      const newWork = {
        title,
        description: `Promoted from ${followupItem.key}, the follow-up batch of ${parentKey}${finding.ref ? `; raised at ${finding.ref}` : ''}.\n\nFinding${finding.path ? ` (${finding.path})` : ''}: ${finding.text}`.slice(0, 20000),
        type: 'chore' as const,
        priority: 2,
        dependencies: [parentItem.id],
        criteria: [{ id: 'AC-1', text: `${promotedFindingPreamble}${finding.text}`.slice(0, 2000), proofs: [promotedFindingProof] }],
        producerProofs: [promotedFindingProof],
        plannedFiles: finding.path ? [finding.path] : [],
        reason: `Promoted from ${followupItem.key} finding ${index}`,
      };
      const created = await api('work', newWork, `promote-followup:${followupItem.key}:${index}:${createHash('sha256').update(JSON.stringify(newWork)).digest('hex').slice(0, 32)}`);
      return print({ promoted: { from: followupItem.key, finding: index, parent: parentItem.key }, item: created, duplicate: false,
        message: `Finding ${index} of ${followupItem.key} promoted to ${created.key}` });
    },
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
