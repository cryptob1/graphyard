// Trusted contract registry. Each proof names one fixed case inventory that only protected
// source can execute; candidate code never selects, extends, or renames an inventory.
import * as claimSafety from './acceptance-contract.mjs';
import * as herdrRecovery from './herdr-recovery-contract.mjs';

export const contracts = { 'integration:claim-safety': claimSafety, 'integration:herdr-recovery': herdrRecovery };

export function contract(proof) {
  const selected = Object.hasOwn(contracts, proof) ? contracts[proof] : undefined;
  if (!selected) throw new Error(`Unknown trusted acceptance proof ${proof}`);
  return selected;
}
