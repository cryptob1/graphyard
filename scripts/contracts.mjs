// Trusted contract registry. Each proof names one fixed case inventory that only protected
// source can execute; candidate code never selects, extends, or renames an inventory.
//
// Bootstrap ordering: a contract is available only from the protected checkout the trusted
// workflow runs, so a new contract must reach protected `main` before any work item may
// require its proof. `requireStagedContract` enforces that against the candidate's own base
// instead of trusting the dispatch, so the change that introduces a contract can never be the
// change its trusted proof certifies. Until it lands, the introducing pull request is covered
// by the unprivileged CI job, which runs the identical inventory but publishes no evidence.
import * as claimSafety from './acceptance-contract.mjs';
import * as herdrRecovery from './herdr-recovery-contract.mjs';
import * as mergeAuthorization from './merge-authorization-contract.mjs';

// `source` is the protected path a trusted run executes, and the path whose presence in the
// candidate's base proves the contract was staged before it was required. A contract that
// cannot drive a plain HTTP candidate exports `candidate`, describing the protected launcher
// the runner starts inside the container instead of the image's own entrypoint.
export const contracts = {
  'integration:claim-safety': { ...claimSafety, source: 'scripts/acceptance-contract.mjs' },
  'integration:herdr-recovery': { ...herdrRecovery, source: 'scripts/herdr-recovery-contract.mjs' },
  'integration:merge-authorization': { ...mergeAuthorization, source: 'scripts/merge-authorization-contract.mjs' },
};

export function contract(proof) {
  const selected = Object.hasOwn(contracts, proof) ? contracts[proof] : undefined;
  if (!selected) throw new Error(`Unknown trusted acceptance proof ${proof}. This protected checkout registers ${Object.keys(contracts).join(', ')}; merge a contract to main before requiring its proof.`);
  return selected;
}

// A trusted run may certify a proof only when the candidate's base already carries the
// contract, so an introducing pull request cannot obtain trusted evidence for its own harness.
// `staged` reports whether a path exists in that base commit.
export function requireStagedContract(proof, baseSha, staged) {
  const { source } = contract(proof);
  if (!staged(source)) throw new Error(`Contract ${proof} is not staged in candidate base ${baseSha}: ${source} must reach main before a candidate may be certified against it. The unprivileged CI job covers the change that introduces a contract.`);
  return source;
}
