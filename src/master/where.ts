// Concern: GY-3277 — the loop-side half of 'Where things run': the one process that knows the
// whole install gathers its facts once per run, for the header its coordination reads carry
// (model/where-things-run.ts) and the Setup page shows.
import { readInstallRecord, installDirectory } from '../install/secrets.js';
import { deployUnitOf, readInstallUnits } from '../install/units.js';
import { localUnit } from '../install/local.js';
import { installIdFor } from '../install/types.js';
import type { WhereThingsRun } from '../model/where-things-run.js';

/** The container a Compose install runs one control-plane service under (its compose project is `graphyard-INSTALL`). */
export const composeContainer = (installId: string, service: 'server' | 'db') => `graphyard-${installId}-${service}-1`;

/**
 * The install's where-facts, as the loop runs them: the units its checkout records, the
 * containers its provider started (or the local provider's unit and embedded cluster), the URL it
 * talks to, its checkout, its install directory and its CLI release. Null when its own records do
 * not name them — a broken units record or install record, or a URL that does not parse — so the
 * panel says so rather than guess a name that may be another install's.
 */
export async function loopWhereReport(root: string, master: { repository: string; url: string; cliPath: string }, configHome?: string): Promise<WhereThingsRun | null> {
  let loopUnit: string;
  try { loopUnit = readInstallUnits(root).master; } catch { return null; }
  let url: URL;
  try { url = new URL(master.url); } catch { return null; }
  const installId = installIdFor(master.repository), directory = installDirectory(installId, configHome);
  let record;
  try { record = await readInstallRecord(directory); } catch { return null; }
  if (record === null) return null;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  return {
    loopUnit, deployUnit: deployUnitOf({ master: loopUnit }),
    server: record.provider === 'local' ? localUnit(installId) : composeContainer(installId, 'server'),
    database: record.provider === 'local' ? `embedded Postgres (${directory}/postgres)` : composeContainer(installId, 'db'),
    port, url: master.url, checkout: root, installDirectory: directory, cliPath: master.cliPath,
  };
}
