import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { contract, requireStagedContract } from './contracts.mjs';
const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, GRAPHYARD_PR: prText, GRAPHYARD_WORK_ID: workId, GRAPHYARD_POLICY_REVISION: revisionText, GRAPHYARD_PROOF: proof } = process.env;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(prText ?? '') || !/^[0-9a-f-]{36}$/.test(workId ?? '') || !/^[1-9]\d*$/.test(revisionText ?? '')) throw new Error('Invalid acceptance input');
// Resolve the requested proof against this protected checkout before fetching candidate code, so a
// proof whose contract has not reached protected main fails here instead of part-way through a run.
contract(proof ?? '');
const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${prText}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Cannot read PR (${response.status})`);
const pr = await response.json();
if (pr.state !== 'open' || pr.base.ref !== 'main' || pr.head.repo?.full_name !== repository || pr.base.repo?.full_name !== repository) throw new Error('Expected an open same-repository PR into main');
// A candidate-push run binds to the head and base the control plane recorded for the item (see
// enumerate-ci-proofs.mjs): the base is the candidate's bound base, which for a queued candidate
// is its predicted base rather than wherever the base branch points now. A head that no longer
// matches the pull request means the candidate moved; the push that moved it starts its own run.
const { GRAPHYARD_HEAD: plannedHead, GRAPHYARD_BASE: plannedBase } = process.env;
if (plannedHead || plannedBase) {
  if (![plannedHead, plannedBase].every(s => /^[a-f0-9]{40}$/.test(s ?? ''))) throw new Error('Invalid planned candidate SHA');
  if (pr.head.sha !== plannedHead) throw new Error(`Pull request head ${pr.head.sha} is no longer the planned candidate ${plannedHead}`);
}
const head = pr.head.sha, base = plannedBase || pr.base.sha;
if (![head, base].every(s => /^[a-f0-9]{40}$/.test(s))) throw new Error('Invalid candidate SHA');
const directory = resolve('candidate'); await mkdir(directory, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q'); git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
// No credentials persist in the candidate build context. Bootstrap runner supports public repos.
// Fetch the protected base alone first: the contract must already be staged there, so the
// change that introduces a contract can never be the change its own trusted proof certifies.
git('fetch', '--no-tags', 'origin', base);
requireStagedContract(proof ?? '', base, path => {
  try { git('cat-file', '-e', `${base}:${path}`); return true; } catch { return false; }
});
git('fetch', '--no-tags', 'origin', head); git('checkout', '--detach', head);
git('-c', 'user.name=Graphyard acceptance', '-c', 'user.email=acceptance@localhost', 'merge', '--no-commit', '--no-ff', base);
await writeFile('candidate.json', JSON.stringify({ repository, pr: Number(prText), workId, sha: head, baseSha: base, policyRevision: Number(revisionText), testedTree: git('write-tree').toString().trim(), harnessCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }, null, 2));
console.log('Prepared exact PR head plus base for isolated acceptance.');
