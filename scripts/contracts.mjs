// Trusted contract registry. Each proof names one fixed case inventory that only protected
// source can execute; candidate code never selects, extends, or renames an inventory.
//
// Bootstrap ordering: a contract is available only from the protected checkout the trusted
// workflow runs, so a new contract must reach protected `main` before any work item may
// require its proof. Until then the introducing pull request is covered by the unprivileged
// CI job, which runs the identical inventory against the candidate but publishes no evidence.
import * as claimSafety from './acceptance-contract.mjs';
import * as herdrRecovery from './herdr-recovery-contract.mjs';

export const contracts = { 'integration:claim-safety': claimSafety, 'integration:herdr-recovery': herdrRecovery };

export function contract(proof) {
  const selected = Object.hasOwn(contracts, proof) ? contracts[proof] : undefined;
  if (!selected) throw new Error(`Unknown trusted acceptance proof ${proof}. This protected checkout registers ${Object.keys(contracts).join(', ')}; merge a contract to main before requiring its proof.`);
  return selected;
}
