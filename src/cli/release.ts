import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommands } from './registry.js';
import { resolveWork } from './context.js';
import { releaseLeaseCommand } from './lease.js';
import {
  apiSuite, assessProductionServing, awaitServing, commandSuite, cutAsync, deployToUatAsync, endpointSuite, findCandidate, followUpItem, followUpRequestId, gitIn,
  ledgerStatus, maxPrsFrom, promoteAsync, readLedger, readRecords, readServed, recordSoak, syncLedger, uatServedDigests, unacceptedFlaky, validateAndRecord, writeRecord,
  type AsyncGit, type CutTrigger, type FlakyAcceptance, type ReleaseCandidate, type SoakRecord, type Suite,
} from '../release-candidate.js';
import { commandDigestAdapter, shellRun, uatDigestSuite, verifyProductionDigests } from '../release-digests.js';
import { acceptancesFrom, foldHolds, foldRecord, holdItemsFor, holdTag, holdTagPrefix, releaseHolds, type HoldRecord } from '../release-holds.js';
import { pendingFromPlane, readPlane, servingStage } from '../release-pending.js';
import { handedImports, handedImportsVariable, promotionImports, sealAuthorityOutOfScope, sealAuthorityUnserved, sealCheckRecord, sealCheckTag, sealRoles, sealedImports, type SealAuthority } from '../validation-import.js';
import { checkRepositoryContract, contractFile, loadContract } from '../e2e/case.js';

const switches = new Set(['no-push', 'api']);
const subcommands = new Set(['contract', 'cut', 'status', 'uat', 'validate', 'follow-up', 'holds', 'fold', 'promote', 'verify', 'soak', 'imports', 'seal-check']);
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
const usage = 'Use release contract | release cut [--trigger schedule|manual] [--max-prs N] | release status | release uat ID | release validate ID --url URL [--api] [--check PATH]... [--suite NAME=COMMAND]... [--e2e-report FILE] | release follow-up ID | release holds | release fold OUTCOME --decision ID | release seal-check [ID] | release imports ID | release promote ID | release verify --url URL | release soak ID --sha SHA --result success|failure|cancelled [--run URL] [--report NAME]';

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
      '  release cut [--trigger schedule|manual] [--max-prs N] [--base main] [--no-push]',
      "                                Record main as a release candidate (tag rc/ID) with the",
      '                                deliveries it carries; merges to main never pause. It takes at',
      '                                most N merges after the last candidate (GRAPHYARD_RC_MAX_PRS,',
      '                                default 10) and leaves the rest queued for the next cut',
      '                                GRAPHYARD_RELEASE_BUILD builds it once and records each digest',
      '  release status                Every candidate with its UAT verdict and production promotion',
      '  release uat ID|latest         Deploy the candidate to UAT: release/uat moves to its exact SHA,',
      '                                or GRAPHYARD_DEPLOY_DIGESTS deploys its recorded build digests',
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
      '  release seal-check [ID|latest]',
      '                                Whether this credential may seal imports (an admin or operator',
      '                                agent), sealing nothing; non-zero when it may not. Given a',
      '                                candidate, records the answer as rc-seal-check/ID.AT for master status',
      '  release imports ID|latest     The hold the candidate\'s imported external runs leave; a released',
      '                                hold is sealed, so no import binds to the candidate afterwards',
      '  release promote ID|latest     Deploy a UAT-passed candidate to production by its exact SHA, or',
      '                                by its recorded digests (never a rebuild) under GRAPHYARD_DEPLOY_DIGESTS;',
      '                                flaky required cases need applied evidence decisions at that SHA; a',
      '                                direct run seals the imported-run hold it reads (an admin or',
      '                                operator agent seals), or refuses when it cannot seal',
      '  release verify --url URL [--wait SECONDS]',
      '                                Check production serves a promoted candidate and name it; a digest',
      '                                promotion also needs every instance (GRAPHYARD_INSTANCE_DIGESTS) to run its digest',
      '  release soak ID --sha SHA --result success|failure|cancelled [--run URL] [--report NAME]',
      "                                Record the advisory soak's verdict for the candidate (tag",
      '                                rc-soak/ID on its exact SHA) with the soak run and its timing',
      '                                report; it never decides promotion',
    ],
    async run(context) {
      const { id, args, api, print, repositoryRoot } = context;
      // `release GY-N EPOCH` is the worker's lease release; every other word is a candidate step.
      if (id && !subcommands.has(id)) {
        return releaseLeaseCommand.run(context, await resolveWork(api, id));
      }
      const root = repositoryRoot(), git = gitIn(root), asyncGit: AsyncGit = async args => git(args);
      // GY-1844: the repository's digest adapter (GRAPHYARD_RELEASE_BUILD, GRAPHYARD_DEPLOY_DIGESTS, GRAPHYARD_INSTANCE_DIGESTS); unset ports keep sha promotion.
      const digests = commandDigestAdapter(process.env, shellRun(root));
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
        const record = foldRecord(holds, listed, new Date(), outcome);
        writeRecord(git, holdTag(record), record.sha!, record, push);
        return print(record);
      }
      if (id === 'cut') {
        const trigger = (options.one('trigger') ?? 'manual') as CutTrigger;
        if (trigger !== 'schedule' && trigger !== 'manual') throw new Error('--trigger is schedule or manual');
        const maxPrs = maxPrsFrom(options.one('max-prs') ?? process.env.GRAPHYARD_RC_MAX_PRS);
        // GY-1802: the outcomes whose plan is not delivered yet ride the candidate as pending. A credential that cannot read the plane (the workflow's release filing token) names none, and the loop's cut records them.
        let unread: string | null = null;
        const read = async <T>(path: string, pick: (answer: any) => T): Promise<T> => { try { return pick(await api(path)); } catch (error: any) { unread ??= error?.message ?? String(error); throw error; } };
        const plane = await readPlane({ goals: () => read('goals?open=1', answer => answer.goals), stage: key => read(`work/${encodeURIComponent(key)}`, servingStage) });
        if (!plane) console.error(`release cut: the plane could not be read (${unread ?? 'no answer'}); no outcome is recorded pending, so a required case bound to an undelivered outcome blocks this candidate`);
        const pendingOutcomes = (at: { sha: string; undelivered: ReadonlySet<string> }) => {
          let source: string | null = null;
          try { source = git(['show', `${at.sha}:${contractFile}`]); } catch { source = null; }
          return pendingFromPlane(plane, source, at);
        };
        return print(await cutAsync(asyncGit, { base, trigger, now: new Date(), push, maxPrs, pendingOutcomes, build: digests.build }));
      }
      if (id === 'status' || !id) { syncLedger(git, base); return print(ledgerStatus(readLedger(git))); }
      if (id === 'uat') return print(await deployToUatAsync(asyncGit, target, base, new Date(), digests.deploy));
      if (id === 'soak') {
        const sha = options.one('sha'), result = options.one('result');
        if (!sha || !result) throw new Error(usage);
        // The soak job's result as the workflow reports it: success, failure, cancelled (or skipped).
        const verdict: SoakRecord['result'] = result === 'success' || result === 'passed' ? 'passed' : result === 'cancelled' ? 'cancelled' : 'failed';
        return print(recordSoak(git, target, { sha, result: verdict, run: options.one('run') ?? null, report: options.one('report') ?? null, base, now: new Date(), push }));
      }
      if (id === 'seal-check') {
        // GY-1882: the read-only check the uat imports job runs first, before soak and UAT results are spent on a seal this credential cannot make.
        // A credential the plane does not accept at all (revoked, expired) may not seal either, and is recorded as such.
        const answer = await (api('validation/import/seal-authority') as Promise<SealAuthority | null>).catch((error: any) => {
          if (error?.status === 401) return { mayseal: false, role: 'unauthenticated', needed: [...sealRoles] } satisfies SealAuthority;
          // A valid operator-agent token for another repository never reaches the route; record the denial so master status names the uat secret.
          if (sealAuthorityOutOfScope(error)) return { mayseal: false, role: 'operator-agent (other repository)', needed: [...sealRoles] } satisfies SealAuthority;
          // A plane that predates the route (the release first carrying it is promoted by the plane before it) answers 404, or 403 to an operator agent; nothing is checked or recorded then.
          if (sealAuthorityUnserved(error)) return null;
          throw error;
        });
        if (!answer) { console.error('release seal-check: the control plane predates GET /api/validation/import/seal-authority, so the credential was not checked; the seal itself still decides'); print({ checked: false }); return; }
        if (options.positional[0]) {
          try {
            syncLedger(git, base);
            const record = sealCheckRecord(findCandidate(readLedger(git), target), answer, new Date());
            writeRecord(git, sealCheckTag(record), record.sha, record, push);
          } catch (error: any) { console.error(`release seal-check: the answer was not recorded on the candidate: ${error?.message ?? error}`); }
        }
        print(answer); if (answer.mayseal !== true) process.exitCode = 1; return;
      }
      if (id === 'imports') {
        syncLedger(git, base);
        const candidate = findCandidate(readLedger(git), target);
        // GY-1860: a released hold is sealed on the plane as it is read, so the production job it is handed to promotes on the plane's hold.
        return print({ candidate: candidate.id, sha: candidate.sha, imports: await sealedImports((path, data) => api(path, data), candidate) });
      }
      if (id === 'promote') {
        syncLedger(git, base);
        const ledger = readLedger(git), candidate = findCandidate(ledger, target), uat = ledger.uat.find(record => record.id === candidate.id);
        // Only a candidate held by flaky cases alone reads the control plane's evidence decisions; an unreachable one leaves it held.
        const acceptances = uat && unacceptedFlaky(candidate, uat)?.length ? await acceptancesOf(api, git, candidate.id).catch(error => { console.error(`Could not read evidence decisions: ${error.message}`); return []; }) : [];
        // GY-1860: the candidate's imported external runs hold it; a hold the plane cannot answer refuses promotion.
        // A production job, which holds no plane credential, is handed the hold `release imports` read and sealed in the job before it.
        const handed = process.env[handedImportsVariable];
        const imports = async (candidate: ReleaseCandidate) => handed !== undefined ? handedImports(handed, candidate) : promotionImports(path => api(path), candidate);
        // GY-1874: a direct promotion seals the hold it read before any deployer runs — an admin or operator agent seals —
        // so a required failure imported after the read is seen and refused; a handed hold was sealed by `release imports` already.
        const result = await promoteAsync(asyncGit, target, { base, push, now: new Date(), acceptances, deployDigests: digests.deploy, imports,
          seal: handed === undefined ? candidate => sealedImports((path, data) => api(path, data), candidate) : undefined });
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
        // GY-1844: UAT serving the candidate's recorded digests is checked instance by instance when the adapter reports instances.
        syncLedger(git, base);
        const ledger = readLedger(git), served = uatServedDigests(ledger, findCandidate(ledger, target));
        if (served && digests.instances) suites.push(uatDigestSuite(served, digests.instances));
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
        // GY-1844: a digest promotion verifies only when every promoted service's instances run the promoted digest.
        const result = { ...assessProductionServing(served, ledger.production), digests: await verifyProductionDigests(ledger, digests.instances) };
        print(result); if (!result.verified || result.reason || !result.digests.verified) process.exitCode = 1; return;
      }
      throw new Error(usage);
    },
  },
]);
