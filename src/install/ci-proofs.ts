import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ciProducerRuntime, ciProofFamilies } from '../model/ci-proofs.js';

export { ciProducerRuntime, ciProofFamilies };

/** The principal id every installer registers for the CI lane, and the secret and environment the workflow reads it from. */
export const ciProducerId = 'ci-proofs';
export const ciProducerSecret = 'GRAPHYARD_CI_PRODUCER_TOKEN';
export const ciReportingEnvironment = 'graphyard-reporting';
export const ciProducerGrants = ciProofFamilies.map(family => `${family}:*`);

export interface CiProducerPrincipal { id: string; role: 'producer'; runtime: string; proofs: string[]; token: string }

/**
 * The CI producer principal an installer deploys beside the others: a producer whose runtime is
 * GitHub Actions, granted the automatable proof families and nothing else. The token is kept
 * across re-runs so a re-run never silently invalidates the repository secret; `previous` is the
 * roster the installer read before this run.
 */
export function ciProducerPrincipal(previous: readonly { id: string; token?: string }[] = [], token = () => randomBytes(32).toString('base64url')): CiProducerPrincipal {
  const kept = previous.find(entry => entry.id === ciProducerId)?.token;
  return { id: ciProducerId, role: 'producer', runtime: ciProducerRuntime, proofs: [...ciProducerGrants], token: kept && kept.length >= 32 ? kept : token() };
}

/**
 * The roster with the CI producer merged in. An existing entry of that id is replaced by the
 * canonical shape (its token kept), so an operator-edited grant outside the families is
 * corrected rather than deployed; every other principal is left untouched.
 */
export function withCiProducer<T extends { id: string; token?: string }>(principals: readonly T[], previous: readonly { id: string; token?: string }[] = principals, token?: () => string): (T | CiProducerPrincipal)[] {
  const producer = ciProducerPrincipal([...principals, ...previous], token);
  return [...principals.filter(entry => entry.id !== ciProducerId), producer];
}

/** The commands that store the credential where only the protected workflow can read it. */
export function ciProducerProvisioningSteps(repository: string, url: string) {
  return [
    `Restrict the ${ciReportingEnvironment} environment to the default branch before storing any secret in it`,
    `gh secret set ${ciProducerSecret} --repo ${repository} --env ${ciReportingEnvironment}   # paste the ${ciProducerId} token; never commit it`,
    `gh variable set GRAPHYARD_URL --repo ${repository} --env ${ciReportingEnvironment} --body ${url}`,
    `Deploy the principals array including ${ciProducerId} as GRAPHYARD_PRINCIPALS; the CI lane is live once acceptance.yml runs on the next candidate push`,
  ];
}

/** The roster a registry file holds now, or nothing: read before `init --apply` rewrites it so the CI token survives. */
export async function readRoster(principalsFile: string): Promise<{ id: string; token?: string }[]> {
  try { return JSON.parse(await readFile(principalsFile, 'utf8')).principals ?? []; } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Registers the CI producer in the installer's principal registry (`.graphyard/principals.json`)
 * after `init --apply` wrote it. Apply rewrites the file from the reviewed proposal alone, so the
 * token is carried from the roster read before apply; the file keeps its 0600 mode.
 */
export async function registerCiProducer(principalsFile: string, previous: readonly { id: string; token?: string }[] = [], token?: () => string) {
  const info = await lstat(principalsFile);
  if (!info.isFile() || info.mode & 0o077) throw new Error('Saved principals must be a regular file with mode 0600');
  const document = JSON.parse(await readFile(principalsFile, 'utf8'));
  const before = JSON.stringify(document.principals);
  document.principals = withCiProducer(document.principals, previous, token);
  const changed = JSON.stringify(document.principals) !== before;
  if (changed) {
    const temporary = `${principalsFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    await rename(temporary, principalsFile);
  }
  return { principal: ciProducerId, runtime: ciProducerRuntime, grants: [...ciProducerGrants], changed };
}
