import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineCommands } from './registry.js';
import { masterInit } from './master-init.js';
import { masterSetupCommand } from './master-setup.js';
import { loadStoredMasterConfig, masterInstructions } from '../master.js';
import { sessionCommands } from './session-commands.js';
import { registryHelp } from './master-registry.js';
import { closeHelp } from './master-close.js';
import { openMasterSession, unhandled } from './master/session.js';
import { intentCommand } from './master/intent.js';
import { fleetCommand } from './master/fleet.js';
import { confinedMaster, operationsCommand } from './master/operations.js';
import { loopCommand } from './master/loop.js';

/** Every master subcommand authenticates with the coordinator credential the master keeps for itself, never the repository connection file. */
export const masterCommands = defineCommands([
  {
    name: 'master',
    readsConnection: () => false,
    help: [
      '  master init --token-stdin [--herdr-workspace ID] [--browser-profile PROFILE]',
      '              [--dispatch-interval SECONDS] [--reviewer-profile NAME] [--producer-timeout MINUTES]',
      '              [--replace-supervisor] Install the operating mode and, in the coordinator',
      "                                checkout, the loop's systemd unit; --replace-supervisor replaces",
      "                                another loop's. PROFILE: the operator's Chrome profile",
      '  master start AGENT_KIND       Launch the dedicated visible Herdr master session',
      '  master worker add FILE        Add an existing or launchable Herdr worker profile',
      '  master reviewer setup [--name NAME]     Register the separate reviewer GitHub App; NAME',
      "                                defaults to reviewer, within GitHub's 34-character limit",
      '  master reviewer bind FILE --key-stdin   Bind an existing reviewer App (IDs in FILE, PEM on stdin)',
      '  master reviewer add FILE | remove NAME   Add or remove a reviewer launch profile',
      '  master producer add FILE | replace FILE | remove NAME  Manage proof-producer profiles',
      '  master review GY-N [PROFILE]  Launch the bound reviewer on the exact current candidate as the',
      '                                open request\'s next attempt; master run does this on its own,',
      '                                so it is the recovery path for a request nothing else answers',
      '  master setup [--apply]',
      '                                Plan, or set, each deployment variable derived from credentials',
      '                                saved on this host that the deployment lacks (the revert approver',
      '                                from the reviewer App); secrets piped, audited by fingerprint',
      '  master browser FLOW [--dry-run]',
      "                                Perform GitHub administration through the operator's browser",
      '                                profile: app-permissions or installation-accept;',
      '                                recorded, API-verified, audited',
      '  master browser capture [--dry-run]',
      '                                Open the sudo-protected App permissions page and keep each',
      '                                Confirm-access view it shows as a redacted fixture; submits,',
      '                                types and sends nothing, so a worker needs no human recording',
      '  master browser fixtures       List the redacted Confirm-access captures earlier flows saved,',
      '                                by flow and time, with the latest of each method',
      '  master harness [KIND] [--apply]  Generate the master\'s own harness permissions',
      '  master status                 One page: the serving commit against main, open items, the',
      '                                merge writer, live sessions and free worker profiles',
      '  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab',
      '  master merge                  Say that GitHub merges; Graphyard runs no merge of its own',
      '  master config FIELD=VALUE…   Tune owned run settings and profile accounts',
      '                                (accounts:PROFILE=a,b); autoMerge and credential paths stay operator-only',
      '  master run [--once] [--interval SECONDS]',
      '                                The durable coordination loop: snapshot, close, dispatch,',
      '                                merge writer, persist',
      '  master autonomy [--admin-token-stdin --apply]  Provision the master identity',
      '  master promote --admin-token-stdin  Promote a supervised install to autonomy once its reviewer',
      '                                App and profile are independent of you and every worker; audited',
      '  master create FILE|release GY-N|unblock GY-N|requirements GY-N FILE|rework GY-N REASON',
      '                                Apply intent at once with the master\'s identity',
      '  master attest GY-N PROOF REASON  Attest a manual: proof on the exact current head',
      '  master defer GY-N NOT-BEFORE REASON  Hold an unleased post-deploy follow-up until NOT-BEFORE',
      '                                (ISO, at most 30 days away) and clear its blocker; no worker launch',
      ...closeHelp,
      '  master principals [--apply]   Preview or apply a roster rotation keeping live principals',
      '  master restart                Restart this host\'s master loop detached',
      '  master environments [--create KIND,…] [--apply]  Agent accounts, quota, profiles',
      '  master guide                  Print the complete master-agent operating guide',
      ...registryHelp,
    ],
    async run(context) {
      const { id } = context;
      const root = context.repositoryRoot();
      // The master's role instructions lead the guide; the guide file's first line is its docs-index entry, not guide body.
      if (id === 'guide') return console.log(`${masterInstructions}\n` + (await readFile(fileURLToPath(new URL('../../docs/master-agent.md', import.meta.url)), 'utf8')).replace(/^<!-- page:[^\n]*\n/, ''));
      if (id === 'init') return masterInit(context, root);
      if (id === 'setup') return masterSetupCommand(context, root, await loadStoredMasterConfig(root));
      const session = await openMasterSession(context, root);
      // Each concern under ./master/ answers its own subcommands; the first that knows the id handles it.
      // A confined master's `restart` is operations' loop request (GY-1658), not an act on the host's systemd it cannot reach.
      const concerns = id === 'restart' && confinedMaster() ? [operationsCommand] : [intentCommand, fleetCommand, operationsCommand, loopCommand];
      for (const command of concerns) if (await command(session) !== unhandled) return;
      throw new Error(`There is no master ${id}; use master guide for the subcommands`);
    },
  },
  ...sessionCommands,
]);

export { derivedIntent } from './master/intent.js';
