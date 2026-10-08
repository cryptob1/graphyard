// Concern: the local release ports of control-plane mode (GY-1526) — src/release-candidate.ts run from the coordinator checkout, pushes through the deploy key, the revert through the merge writer's steps.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master.js';
import type { Work } from '../model/work.js';
import { installIdFor } from '../install/types.js';
import { candidateSettings, mergeWriterSettings, shadowGateSettings } from '../master/merge-writer-settings.js';
import { parseVerificationMap, type VerificationMap } from '../model/verification-maps.js';
import { contractFile, parseContract } from '../e2e/case.js';
import { deployKeySshCommand, firstParentHolds, pushArgs, pushEnvironment, runMergeTrial, staleLeaseRejection } from '../merge-writer/executor.js';
import { trialAuthor } from '../merge-writer/trial.js';
import {
  awaitServing, cutAsync, deployToUatAsync, promoteAsync, readLedgerAsync, syncLedgerAsync, uatValidationWindowMs,
  type AsyncGit, type ReleaseCandidate, type UatRecord,
} from '../release-candidate.js';
import { revertCandidateItem, type CandidateItemDelta, type RevertContract, type RevertPorts, type RevertRecordEvent } from '../release-revert.js';
import type { CutCommit } from './candidate-cut.js';
import type { LocalCandidate, LocalReleasePorts, LocalValidation } from './promotion-local.js';

/** The variables the loop's environment names UAT and production by in control-plane mode; the workflow's `vars.UAT_URL` and `vars.PRODUCTION_URL`. */
export const localReleaseVariables = { uatUrl: 'GRAPHYARD_UAT_URL', uatToken: 'GRAPHYARD_UAT_TOKEN', productionUrl: 'GRAPHYARD_PRODUCTION_URL' } as const;
/** How long `validate` waits for UAT to serve the candidate, and `verify` for production: the workflow's `--wait 1200`. */
export const localServeWaitSeconds = 1200;
/**
 * The suites the loop runs against UAT: the workflow's uat job's, less the container and chart
 * jobs, which need a runner with Docker and kind. `release validate` composes them exactly as the
 * workflow does — endpoints, the api suite, the browser suite, every e2e case, the zero-touch
 * scenario — and files the holds and the follow-up itself.
 */
export const localValidateArguments = (id: string, url: string) => ['release', 'validate', id, '--url', url, '--wait', String(localServeWaitSeconds), '--api',
  '--suite', 'browser=node --import tsx --eval "import(\\"./src/release-candidate.ts\\").then(m => m.runBrowserSuite())"',
  '--suite', 'e2e=node --import tsx --eval "import(\\"./src/e2e/runner.ts\\").then(m => m.runE2eSuite())"',
  '--suite', 'zero-touch=node --import tsx --eval "import(\\"./src/release-candidate.ts\\").then(m => m.runZeroTouchSuite())"'];

const fullSha = /^[0-9a-f]{40}$/;
const toCandidate = (candidate: ReleaseCandidate): LocalCandidate => ({ id: candidate.id, sha: candidate.sha, cutAt: candidate.cutAt, items: candidate.items.map(item => ({ key: item.key, mergeSha: item.mergeSha, pr: item.pr })) });
/** The last JSON object a CLI command printed, as `release validate` prints its result after the suites' own output. */
export function lastJson(output: string): unknown {
  const lines = output.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(lines.slice(index).join('\n')); } catch { /* a line inside a suite's output */ }
  }
  throw new Error(`the command printed no JSON result: ${output.slice(-500)}`);
}

/**
 * The port set, or null when the loop's environment names no UAT (`GRAPHYARD_UAT_URL`): the
 * release functions run in the coordinator checkout `root` with `GIT_SSH_COMMAND` set to the
 * install's deploy key, so every tag and branch push goes through it as the merge writer's do; the
 * UAT validation runs `release validate` as a child of this checkout, so its suites, holds and
 * follow-up are composed exactly as the workflow composed them; the revert is built in a trial
 * checkout under `base` and landed through `revertCandidateItem`, recorded by `record`.
 */
export function localReleasePorts(config: Pick<MasterConfig, 'baseBranch' | 'run' | 'repository' | 'credentialFile'>, root: string, run: ChildRun,
  options: { base: string; record: (work: Pick<Work, 'id' | 'key'>, event: RevertRecordEvent) => Promise<unknown>; environment?: NodeJS.ProcessEnv; now?: () => number; trial?: RevertPorts['trial'] }): LocalReleasePorts | null {
  const environment = options.environment ?? process.env;
  const uatUrl = environment[localReleaseVariables.uatUrl], productionUrl = environment[localReleaseVariables.productionUrl];
  if (!uatUrl) return null;
  const settings = candidateSettings(config.run), writer = mergeWriterSettings(config.run, installIdFor(config.repository)), shadow = shadowGateSettings(config.run);
  const base = config.baseBranch, ref = `refs/remotes/origin/${base}`, now = options.now ?? Date.now;
  const env = { ...environment, GIT_SSH_COMMAND: deployKeySshCommand(writer.deployKeyFile) };
  const git: AsyncGit = async args => String(await run('git', args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024, timeoutMs: 4 * 3_600_000 }));
  const gitAsync = async (...args: string[]) => String(await run('git', ['-C', root, ...args], { env, maxBuffer: 64 * 1024 * 1024, timeoutMs: 4 * 3_600_000 }));
  const cli = async (args: string[], extra: Record<string, string>) => String(await run(process.execPath, ['bin/graphyard.mjs', ...args], {
    cwd: root, env: { ...env, ...extra }, maxBuffer: 64 * 1024 * 1024, timeoutMs: 4 * 3_600_000,
  }));
  const revertPorts: RevertPorts = {
    baseBranch: base, retrials: writer.retrials, now,
    fetch: async () => {
      await gitAsync('fetch', '--no-tags', 'origin', base);
      const sha = (await gitAsync('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim().toLowerCase();
      if (!fullSha.test(sha)) throw new Error(`The coordinator checkout holds no ${ref} to revert onto`);
      return sha;
    },
    holds: sha => firstParentHolds(args => gitAsync(...args), ref, sha),
    revert: async (mergeSha, baseTip) => {
      // The revert is built in a throwaway checkout of the tip under the managed worktree root, sharing this checkout's object store.
      const checkout = mkdtempSync(join(options.base, 'candidate-revert-'));
      const at = async (...args: string[]) => String(await run('git', ['-C', checkout, ...args], { env, maxBuffer: 64 * 1024 * 1024, timeoutMs: 4 * 3_600_000 }));
      try {
        await git(['worktree', 'add', '--detach', checkout, baseTip]);
        try { await at('-c', `user.name=${trialAuthor}`, '-c', `user.email=${trialAuthor}@graphyard.invalid`, 'revert', '-m', '1', '--no-edit', mergeSha); }
        catch {
          const conflict = (await at('diff', '--name-only', '--diff-filter=U')).split('\n').map(line => line.trim()).filter(Boolean);
          try { await at('revert', '--abort'); } catch { /* nothing to abort */ }
          return { conflict: conflict.length ? conflict : ['(the revert could not be built)'] };
        }
        const revertSha = (await at('rev-parse', 'HEAD')).trim().toLowerCase();
        return { revertSha, files: (await git(['diff', '--name-only', baseTip, revertSha])).split('\n').map(line => line.trim()).filter(Boolean) };
      } finally {
        try { await git(['worktree', 'remove', '--force', checkout]); } catch { rmSync(checkout, { recursive: true, force: true }); }
      }
    },
    trial: options.trial ?? (async (revertSha, files) => {
      const trial = await runMergeTrial({ root, base: options.base, mergeSha: revertSha, changedFiles: files, proofs: [], proofFiles: [], timeoutMs: shadow.timeoutMinutes * 60_000, key: 'candidate-revert', run, environment });
      return { build: trial.build, tests: trial.tests, durationMs: trial.durationMs };
    }),
    push: async (revertSha, baseTip) => {
      try { await run('git', ['-C', root, ...pushArgs(base, baseTip, revertSha)], { env: pushEnvironment(writer.deployKeyFile, environment) }); return 'pushed'; }
      catch (error) { const failed = error as { stdout?: unknown; stderr?: unknown; message?: string }; if (staleLeaseRejection(`${failed.stdout ?? ''}${failed.stderr ?? ''}` || String(failed.message))) return 'rejected'; throw error; }
    },
    record: options.record,
  };
  return {
    settings,
    cut: async due => {
      await syncLedgerAsync(git, base);
      const ledger = await readLedgerAsync(git), newest = ledger.candidates[0];
      // A candidate cut and never judged — a run that crashed between the cut and its record — is resumed, not cut past.
      if (newest && !ledger.uat.some(record => record.id === newest.id) && now() - Date.parse(newest.cutAt) < uatValidationWindowMs) return { cut: false, resume: toCandidate(newest) };
      // The cut rule (candidate-cut.ts) alone decides a cut: not due, nothing is tagged or pushed.
      if (!due) return { cut: false, reason: `the cut rule is not due (${settings.everyMerges} merges or ${settings.idleMinutes} idle minutes)` };
      const result = await cutAsync(git, { base, trigger: 'manual', now: new Date(now()), push: true, maxPrs: settings.everyMerges });
      return result.cut ? { cut: true, candidate: toCandidate(result.candidate) } : { cut: false, reason: result.reason };
    },
    uat: async id => { const deployed = await deployToUatAsync(git, id, base, new Date(now())); return { sha: deployed.sha }; },
    validate: async id => {
      const scratch = mkdtempSync(join(options.base, 'candidate-validate-'));
      try {
        const output = await cli(localValidateArguments(id, uatUrl), { GRAPHYARD_E2E_REPORT: join(scratch, 'e2e-report.json'), GRAPHYARD_CANDIDATE_ID: id, GRAPHYARD_TOKEN_FILE: config.credentialFile });
        const result = lastJson(output) as { record: UatRecord; followUp: string | null };
        if (!result || typeof result !== 'object' || !result.record) throw new Error(`release validate printed no record: ${output.slice(-500)}`);
        return { record: result.record, followUp: result.followUp ?? null } satisfies LocalValidation;
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
    promote: async id => {
      const result = await promoteAsync(git, id, { base, push: true, now: new Date(now()) });
      return result.promoted ? { promoted: true, sha: result.sha } : { promoted: false, refusals: result.refusals };
    },
    verify: async sha => {
      if (!productionUrl) return { served: null, verified: false };
      const served = await awaitServing(productionUrl, sha, { timeoutMs: localServeWaitSeconds * 1000 });
      return { served, verified: served === sha };
    },
    history: async () => {
      await gitAsync('fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:${ref}`, '+refs/tags/rc/*:refs/tags/rc/*');
      let since: string | null = null;
      try { const record = JSON.parse((await gitAsync('for-each-ref', '--sort=-refname', '--count=1', '--format=%(contents)', 'refs/tags/rc/')).trim()); since = typeof record?.sha === 'string' && fullSha.test(record.sha) ? record.sha : null; } catch { since = null; }
      const format = '--format=%H%x1f%cI%x1e';
      let log = '';
      if (since) { try { log = await gitAsync('log', '--first-parent', format, `${since}..${ref}`); } catch { since = null; } }
      if (!since) log = await gitAsync('log', '--first-parent', '--max-count=200', format, ref);
      return log.split('\x1e').flatMap((record): CutCommit[] => { const [sha = '', at = ''] = record.replace(/^\n/, '').split('\x1f'); return fullSha.test(sha.trim()) ? [{ sha: sha.trim().toLowerCase(), at: at.trim() }] : []; });
    },
    revertInputs: async candidate => {
      const items: CandidateItemDelta[] = [];
      for (const item of candidate.items) {
        try {
          const files = (await git(['diff', '--name-only', `${item.mergeSha}^1`, item.mergeSha])).split('\n').map(line => line.trim()).filter(Boolean);
          items.push({ key: item.key, mergeSha: item.mergeSha, files });
        } catch { items.push({ key: item.key, mergeSha: item.mergeSha, files: [] }); }
      }
      const maps = readVerificationMaps(root);
      const contract: RevertContract = existsSync(join(root, contractFile)) ? { ...parseContract(readFileSync(join(root, contractFile), 'utf8')), cases: readCaseTags(root) } : { outcomes: [], cases: readCaseTags(root) };
      return { items, maps, contract };
    },
    // The route finds the item by key as it does by id, so the revert names the key alone.
    revert: target => revertCandidateItem(revertPorts, { id: target.key, key: target.key }, target),
  };
}

/** Every well-formed map under `verification/` of the checkout. */
export function readVerificationMaps(root: string): VerificationMap[] {
  const directory = join(root, 'verification');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.md')).sort().flatMap(name => { const map = parseVerificationMap(`verification/${name}`, readFileSync(join(directory, name), 'utf8')); return map ? [map] : []; });
}
/** Each e2e case's id and tags, read from `e2e/cases/*.json`; a file that does not parse is skipped. */
export function readCaseTags(root: string): { id: string; tags: string[] }[] {
  const directory = join(root, 'e2e', 'cases');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort().flatMap(name => {
    try { const definition = JSON.parse(readFileSync(join(directory, name), 'utf8')); return typeof definition?.id === 'string' ? [{ id: definition.id, tags: Array.isArray(definition.tags) ? definition.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : [] }] : []; } catch { return []; }
  });
}
