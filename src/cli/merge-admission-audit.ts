import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditInstalls, type AuditInstall } from '../merge-admission-audit.js';
import { readCredentialFile } from '../private-file.js';
import { defineCommands } from './registry.js';

export const admissionAuditCommands = defineCommands([{
  name: 'audit-merge-admission',
  help: ['  audit-merge-admission [installs.json]  Read-only merge proof/review audit with coverage gaps',
    '                                Defaults to this connection and installs named in the local Graphyard plugin config.',
    '                                Optional JSON array: {name,url,credentialFile}; use only your permitted agent credentials.',
    '                                Reports hwd GY-3/GY-4 explicitly. Missing history/access is an external blocker.',
    '                                After verified deployment, file remediation for unsafe merges and attach the report to',
    '                                manual:post-deploy/merge-admission-audit; live isolated-item checks still need execution.'],
  async run(context) {
    let configured: { name: string; url: string; credentialFile?: string }[];
    if (context.id) configured = JSON.parse(await readFile(context.id, 'utf8'));
    else {
      let installs: Record<string, { url: string }> = {};
      try { installs = JSON.parse(await readFile(join(homedir(), '.config/herdr/plugins/config/graphyard/config.json'), 'utf8')).installs ?? {}; } catch { /* The current connection remains available without a runtime plugin. */ }
      configured = Object.entries(installs).map(([name, install]) => ({ name, url: install.url }));
      if (!configured.some(i => i.url === context.base)) configured.unshift({ name: 'current', url: context.base });
    }
    const targets: AuditInstall[] = [];
    for (const install of configured) {
      if (install.url === context.base && !install.credentialFile) { targets.push({ ...install, read: context.api }); continue; }
      if (!install.credentialFile) { targets.push({ ...install, unavailable: 'No credential for this agent identity; other identities’ plugin tokens were not used' }); continue; }
      try {
        const token = await readCredentialFile(install.credentialFile);
        targets.push({ ...install, read: async path => {
          const response = await fetch(`${install.url.replace(/\/$/, '')}/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        } });
      } catch { targets.push({ ...install, unavailable: 'Agent credential file is inaccessible' }); }
    }
    context.print(await auditInstalls(targets));
  },
}]);
