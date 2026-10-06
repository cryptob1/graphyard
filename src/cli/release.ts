import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommands } from './registry.js';
import { releaseLeaseCommand } from './lease.js';
import {
  apiSuite, assessProductionServing, awaitServing, commandSuite, cut, deployToUat, endpointSuite, findCandidate, followUpItem, followUpRequestId, gitIn,
  ledgerStatus, promote, readLedger, readRecords, readServed, syncLedger, unacceptedFlaky, validateAndRecord, writeRecord, type CutTrigger, type FlakyAcceptance, type Suite,
} from '../release-candidate.js';
import { acceptancesFrom, foldHolds, foldRecord, holdItemsFor, holdTag, holdTagPrefix, releaseHolds, type HoldRecord } from '../release-holds.js';
import { checkRepositoryContract, contractFile, loadContract } from '../e2e/case.js';

const switches = new Set(['no-push', 'api']);
const subcommands = new Set(['contract', 'cut', 'status', 'uat', 'validate', 'follow-up', 'holds', 'fold', 'promote', 'verify']);
/** Flags after the subcommand: `--name value` pairs, repeatable, and bare `--flag` switches. */
function flags(args: string[]) {
  const values = new Map<string, string[]>(); const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const value = inline ?? (!switches.has(name) && args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : 'true');
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { positional, one: (name: string) => values.get(name)?.at(-1), all: (name: string) => values.get(name) ?? [] };
}

const workKey = (created: any) => String(created?.key ?? created?.work?.key ?? created?.id);
const usage = 'Use release contract | release cut [--trigger schedule|manual] | release status | release uat ID | release validate ID --url URL [--api] [--check PATH]... [--suite NAME=COMMAND]... [--e2e-report FILE] | release follow-up ID | release holds | release fold OUTCOME --decision ID | release promote ID | release verify --url URL';

/** Every applied evidence decision on the hold items the candidate's failures landed in (GY-1378). */
async function acceptancesOf(api: (path: string) => Promise<any>, git: ReturnType<typeof gitIn>, candidate: string): Promise<FlakyAcceptance[]> {
  const items = holdItemsFor(foldHolds(readRecords<HoldRecord>(git, holdTagPrefix)), candidate);
  return (await Promise.all(items.map(async key => acceptancesFrom((await api(`work/${encodeURIComponent(key)}/decisions`)).decisions)))).flat();
}

/** Release candidates: cut from main, validated on UAT, the exact SHA promoted to production. */
export const releaseCommands = defineCommands([
  {
    name: 'release',
    help: [
      ...releaseLeaseCommand.help,
      '  release contract              The pre-cut check: every case e2e/contract.json binds exists,',
      '                                validates, targets uat and is required, and every required case',
      '                                is bound to an outcome; refusals name the outcome and case',
      '  release cut [--trigger schedule|manual] [--base main] [--no-push]',
      "                                Record main's tip as a release candidate (tag rc/ID) with the",
      '                                deliveries it carries; merges to main never pause',
      '  release status                Every candidate with its UAT verdict and production promotion',
      '  release uat ID|latest         Deploy the candidate to UAT: release/uat moves to its exact SHA',
      '  release validate ID --url URL [--api] [--check PATH]... [--suite NAME=COMMAND]... [--wait SECONDS]',
      '                                Run the suites against UAT serving the candidate and record the',
      '                                verdict; --api drives the deployed API with GRAPHYARD_UAT_TOKEN;',
      '                                a failure files one release hold per failed contract outcome',
      '                                (--e2e-report, default GRAPHYARD_E2E_REPORT) and one follow-up',
      '                                naming any other failing suite and the SHA',
      '  release follow-up ID          File the follow-up of a failed candidate whose filing failed',
      '  release holds                 Every release hold: its outcomes, attached cases and state',
      '  release fold OUTCOME --decision ID',
      '                                Fold an outcome\'s open hold into another\'s, as the applied fold',
      '                                decision ID on its hold item (another agent approved) names',
      '  release promote ID|latest     Deploy a UAT-passed candidate to production by its exact SHA;',
      '                                flaky required cases need applied evidence decisions at that SHA',
      '  release verify --url URL [--wait SECONDS]',
      '                                Check production serves a promoted candidate and name it',
    ],
    async run(context) {
      const { id, args, api, print, repositoryRoot } = context;
      // `release GY-N EPOCH` is the worker's lease release; every other word is a candidate step.
      if (id && !subcommands.has(id)) {
        const work = (await api('work')).find((item: any) => item.id === id || item.key === id);
        if (!work) throw new Error(`Unknown work item ${id}`);
        return releaseLeaseCommand.run(context, work);
      }
      const root = repositoryRoot(), git = gitIn(root);
      const options = flags(args);
      const base = options.one('base') ?? 'main', push = options.one('no-push') === undefined;
      const target = options.positional[0] ?? 'latest';
      if (id === 'contract') { const result = await checkRepositoryContract(root); print(result); if (!result.passed) process.exitCode = 1; return; }
      if (id === 'holds') { syncLedger(git, base); return print(foldHolds(readRecords<HoldRecord>(git, holdTagPrefix)).map(({ records: _records, ...hold }) => hold)); }
      if (id === 'fold') {
        const decision = options.one('decision'), outcome = options.positional[0];
        if (!decision || !outcome) throw new Error(usage);
        syncLedger(git, base);
        const holds = foldHolds(readRecords<HoldRecord>(git, holdTagPrefix));
        const item = holds.find(hold => hold.state === 'open' && hold.outcomes.includes(outcome))?.item;
        if (!item) throw new Error(`Outcome ${outcome} has no open release hold with a filed item`);
        const listed = (await api(`work/${encodeURIComponent(item)}/decisions`)).decisions.find((entry: any) => entry.id === decision);
        if (!listed) throw new Error(`Decision ${decision} is not recorded on hold item ${item}`);
        const record = foldRecord(holds, listed, new Date());
        writeRecord(git, holdTag(record), record.sha!, record, push);
        return print(record);
      }
      if (id === 'cut') {
        const trigger = (options.one('trigger') ?? 'manual') as CutTrigger;
        if (trigger !== 'schedule' && trigger !== 'manual') throw new Error('--trigger is schedule or manual');
        return print(cut(git, { base, trigger, now: new Date(), push }));
      }
      if (id === 'status' || !id) { syncLedger(git, base); return print(ledgerStatus(readLedger(git))); }
      if (id === 'uat') return print(deployToUat(git, target, base));
      if (id === 'promote') {
        syncLedger(git, base);
        const ledger = readLedger(git), candidate = findCandidate(ledger, target), uat = ledger.uat.find(record => record.id === candidate.id);
        // Only a candidate held by flaky cases alone reads the control plane's evidence decisions; an unreachable one leaves it held.
        const acceptances = uat && unacceptedFlaky(candidate, uat)?.length ? await acceptancesOf(api, git, candidate.id).catch(error => { console.error(`Could not read evidence decisions: ${error.message}`); return []; }) : [];
        const result = promote(git, target, { base, push, now: new Date(), acceptances });
        print(result); if (!result.promoted) process.exitCode = 1; return;
      }
      const url = options.one('url');
      const waitMs = Number(options.one('wait') ?? 900) * 1000;
      if (id === 'validate') {
        if (!url) throw new Error(usage);
        const suites: Suite[] = [endpointSuite(options.all('check').length ? options.all('check') : ['/healthz?strict', '/'])];
        if (options.one('api') !== undefined) {
          const token = process.env.GRAPHYARD_UAT_TOKEN;
          if (!token) throw new Error('--api needs GRAPHYARD_UAT_TOKEN, the token of a UAT principal, to drive the UAT API');
          suites.push(apiSuite(token));
        }
        for (const entry of options.all('suite')) {
          const [name, command] = entry.split(/=(.*)/s, 2);
          if (!name || !command) throw new Error(`--suite takes NAME=COMMAND, got ${entry}`);
          suites.push(commandSuite(name, command));
        }
        const file = async (item: object, requestId: string) => workKey(await api('work', item, requestId));
        // GY-1378: the e2e suite's report, written by its command, decides the release holds against the candidate checkout's contract.
        const reportFile = options.one('e2e-report') ?? process.env.GRAPHYARD_E2E_REPORT;
        const contract = existsSync(join(root, contractFile)) ? await loadContract(root).catch(error => { console.error(`No release holds: ${error.message}`); return null; }) : null;
        const holds = reportFile ? releaseHolds(git, { contract, push, file, report: async () => existsSync(reportFile) ? JSON.parse(await readFile(reportFile, 'utf8')) : null }) : undefined;
        const result = await validateAndRecord(git, target, url, suites, { base, push, timeoutMs: waitMs, file, holds });
        print(result); if (result.record.result !== 'passed') process.exitCode = 1; return;
      }
      if (id === 'follow-up') {
        syncLedger(git, base);
        const ledger = readLedger(git); const candidate = findCandidate(ledger, target);
        const record = ledger.uat.find(entry => entry.id === candidate.id);
        if (!record || record.result !== 'failed') throw new Error(`Candidate ${candidate.id} has no failed UAT record; only a failed candidate files a follow-up`);
        return print({ candidate: candidate.id, followUp: record.followUp ?? workKey(await api('work', followUpItem(candidate, record), followUpRequestId(candidate.id))) });
      }
      if (id === 'verify') {
        if (!url) throw new Error(usage);
        syncLedger(git, base);
        const ledger = readLedger(git);
        const promoted = ledger.production[0];
        const served = promoted ? await awaitServing(url, promoted.sha, { timeoutMs: waitMs }) : await readServed(url);
        const result = assessProductionServing(served, ledger.production);
        print(result); if (!result.verified || result.reason) process.exitCode = 1; return;
      }
      throw new Error(usage);
    },
  },
]);
