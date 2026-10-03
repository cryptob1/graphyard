import { defineCommands } from './registry.js';
import { releaseLeaseCommand } from './lease.js';
import {
  apiSuite, assessProductionServing, awaitServing, candidateReport, commandSuite, cut, deployToUat, endpointSuite, findCandidate, followUpItem, followUpRequestId, gitIn,
  ledgerStatus, promote, readLedger, readServed, syncLedger, testProofSuite, validateAndRecord, type CutTrigger, type Git, type Ledger, type ReleaseCandidate, type Suite,
} from '../release-candidate.js';
import { candidateProofPlan } from '../model/release-train.js';
import type { Work } from '../model.js';

const switches = new Set(['no-push', 'api', 'no-proofs']);
const subcommands = new Set(['cut', 'status', 'uat', 'validate', 'follow-up', 'promote', 'verify', 'proofs', 'settle']);
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
const usage = 'Use release cut [--trigger schedule|manual] | release status | release uat ID | release proofs ID | release validate ID --url URL [--api] [--no-proofs] [--check PATH]... [--suite NAME=COMMAND]... | release follow-up ID | release promote ID | release settle ID|all | release verify --url URL';

/**
 * GY-1101: report one candidate's ledger state to the control plane, which moves every merged item
 * the candidate contains along the release train (Done once a promoted candidate carries it). A
 * failed report never undoes the ledger step; `release settle` sends it again.
 */
async function settle(api: (path: string, data?: unknown, requestId?: string) => Promise<any>, ledger: Ledger, candidate: ReleaseCandidate) {
  try { return { settled: await api('release-candidates', candidateReport(ledger, candidate), `release-candidate-settle:${candidate.id}:${ledger.uat.some(r => r.id === candidate.id) ? 'uat' : 'cut'}:${ledger.production.some(r => r.id === candidate.id) ? 'promoted' : 'open'}`), settleError: null }; }
  catch (error) { return { settled: null, settleError: error instanceof Error ? error.message : String(error) }; }
}
const reread = (git: Git, base: string) => { syncLedger(git, base); return readLedger(git); };

/** Release candidates: cut from main, validated on UAT, the exact SHA promoted to production. */
export const releaseCommands = defineCommands([
  {
    name: 'release',
    help: [
      ...releaseLeaseCommand.help,
      '  release cut [--trigger schedule|manual] [--base main] [--no-push]',
      "                                Record main's tip as a release candidate (tag rc/ID) with the",
      '                                deliveries it carries; merges to main never pause',
      '  release status                Every candidate with its UAT verdict and production promotion',
      '  release uat ID|latest         Deploy the candidate to UAT: release/uat moves to its exact SHA',
      '  release proofs ID|latest      The integration:/e2e: proofs the candidate owes for its merged items',
      '  release validate ID --url URL [--api] [--no-proofs] [--check PATH]... [--suite NAME=COMMAND]... [--wait SECONDS]',
      '                                Run the suites and the owed proofs against the candidate and record',
      '                                the verdict; --api drives the deployed API with GRAPHYARD_UAT_TOKEN;',
      '                                a failure files one fix-forward item naming proofs, suites and range',
      '  release follow-up ID          File the follow-up of a failed candidate whose filing failed',
      '  release promote ID|latest     Deploy a UAT-passed candidate to production by its exact SHA; its',
      '                                merged items are Done',
      '  release settle ID|latest|all  Report the ledger state again so merged items reach Done',
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
      const git = gitIn(repositoryRoot());
      const options = flags(args);
      const base = options.one('base') ?? 'main', push = options.one('no-push') === undefined;
      const target = options.positional[0] ?? 'latest';
      if (id === 'cut') {
        const trigger = (options.one('trigger') ?? 'manual') as CutTrigger;
        if (trigger !== 'schedule' && trigger !== 'manual') throw new Error('--trigger is schedule or manual');
        return print(cut(git, { base, trigger, now: new Date(), push }));
      }
      if (id === 'status' || !id) { syncLedger(git, base); return print(ledgerStatus(readLedger(git))); }
      if (id === 'uat') return print(deployToUat(git, target, base));
      if (id === 'promote') {
        const result = promote(git, target, { base, push, now: new Date() });
        if (!result.promoted) { print(result); process.exitCode = 1; return; }
        const ledger = reread(git, base);
        return print({ ...result, ...await settle(api, ledger, findCandidate(ledger, result.candidate)) });
      }
      if (id === 'proofs') {
        const ledger = reread(git, base);
        return print(candidateProofPlan(findCandidate(ledger, target), await api('work') as Work[]));
      }
      if (id === 'settle') {
        const ledger = reread(git, base);
        const candidates = target === 'all' ? [...ledger.candidates].reverse() : [findCandidate(ledger, target)];
        const results = [];
        for (const candidate of candidates) results.push({ candidate: candidate.id, ...await settle(api, ledger, candidate) });
        print(results); if (results.some(entry => entry.settleError)) process.exitCode = 1; return;
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
        // GY-1101: the integration:/e2e: proofs the candidate's merged items owe run against its own checkout.
        if (options.one('no-proofs') === undefined) {
          const ledger = reread(git, base);
          for (const entry of candidateProofPlan(findCandidate(ledger, target), await api('work') as Work[])) suites.push(testProofSuite(entry.proof, repositoryRoot()));
        }
        const result = await validateAndRecord(git, target, url, suites, { base, push, timeoutMs: waitMs,
          file: async (item, requestId) => workKey(await api('work', item, requestId)) });
        const ledger = reread(git, base);
        print({ ...result, ...await settle(api, ledger, findCandidate(ledger, result.record.id)) }); if (result.record.result !== 'passed') process.exitCode = 1; return;
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
