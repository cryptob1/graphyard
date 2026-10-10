import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineCommands } from './registry.js';
import { cycleBudget } from './master-status.js';
import { masterInit } from './master-init.js';
import { masterSetupCommand } from './master-setup.js';
import { loadStoredMasterConfig, masterInstructions } from '../master.js';
import { sessionCommands } from './session-commands.js';
import { registryHelp } from './master-registry.js';
import { executorsHelp } from './master-executors.js';
import { closeHelp } from './master-close.js';
import { openMasterSession, unhandled } from './master/session.js';
import { intentCommand } from './master/intent.js';
import { fleetCommand } from './master/fleet.js';
import { confinedMaster, operationsCommand } from './master/operations.js';
import { loopCommand } from './master/loop.js';
import { mergerCommand } from './merger.js';

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
      '  master merger [github|control-plane --reason TEXT]',
      '                                Show the merger setting and history; set it (admin credential)',
      '  master setup [--apply] [--provider P --service NAME --link-dir DIR]',
      '                                Plan, or set, each deployment variable derived from credentials',
      '                                saved on this host that the deployment lacks (the revert approver',
      '                                from the reviewer App); secrets piped, audited by fingerprint',
      '  master protection [--apply]   Reconcile branch protection with every open review policy',
      '  master tip-cleanup [--apply]  Delete the speculative-tip refs the removed merge queue left',
      '  master browser FLOW [--dry-run]',
      "                                Perform GitHub administration through the operator's browser",
      '                                profile: app-permissions, installation-accept, or protection;',
      '                                recorded, API-verified, audited',
      '  master browser fixtures       List the redacted Confirm-access captures earlier flows saved,',
      '                                by flow and time, with the latest of each method',
      '  master harness [KIND] [--apply]  Generate the master\'s own harness permissions',
      '  master status                 Graphyard work truth joined with Herdr session health, the',
      '                                dispatch order, overlaps and merge conflicts',
      '  master dispatch GY-N PROFILE  Invite a worker to claim ready work in a visible tab;',
      '                                planned-file overlap never holds it (optimistic dispatch)',
      '  master settle-containment GY-N REASON',
      '                                Settle a containment quarantine whose supervisor this host',
      '                                verifies dead; unverifiable signals refuse',
      '  master checkout-restore REASON  Have the loop save every dirty path of the coordinator',
      '                                checkout under refs/graphyard/checkout-restore/, return them to',
      '                                HEAD and restart through graphyard-master.service',
      '  master merge                  Say that GitHub merges; Graphyard runs no merge of its own',
      '  master config FIELD=VALUE…   Tune owned run settings and profile accounts',
      '                                (accounts:PROFILE=a,b); autoMerge and credential paths stay operator-only',
      '  master verify-deployment GY-N Verify that the deployed release serves a delivery and emits',
      '                                the current instructions; records the exact release observed',
      '  master run [--once] [--interval SECONDS]',
      '                                The durable coordination loop: launches reviewers and producers',
      '                                for every submitted head and decides open scope requests',
      '  master autonomy [--admin-token-stdin --apply]  Provision the master and approver identities',
      '  master promote --admin-token-stdin  Promote a supervised install to autonomy once its reviewer',
      '                                App and profile are independent of you and every worker; audited',
      '  master create FILE|release GY-N|unblock GY-N|requirements GY-N FILE [--allow-broad-scope] REASON',
      '                                Own intent; a root-level directory scope needs the flag',
      ...closeHelp,
      '  master scope GY-N [--allow-broad-scope] [REASON]',
      '                                Apply a scope request the loop refused, widening plannedFiles',
      '                                while the attempt keeps its lease',
      '  master decide GY-N ACTION [JSON|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON',
      '                                Request a two-party decision, citing precedent and context',
      '                                A refused rework or recover recorded before refusals kept their',
      '                                candidate stands against every candidate: cite it by id',
      '  master context GY-N [TRIGGER] [--budget N]  The assembled escalation context a handler sees',
      '  master escalation GY-N [TRIGGER] [--budget N] [precedent|KIND]',
      '                                Spawn a fresh handler on that context alone: precedent follows',
      '                                the newest applied line, KIND launches a judging session',
      '  master withdraw GY-N DECISION REASON  Take back the master\'s own requested decision',
      '  master decisions GY-N | approver GY-N DECISION [KIND] | approve GY-N DECISION REASON',
      '  master refuse GY-N DECISION REASON  Record the approver session\'s considered refusal',
      '  master principals [--apply]   Preview or apply a roster rotation keeping live principals',
      '  master restart                Restart this host\'s master loop detached',
      '  master environments [--create KIND,…] [--apply]  Agent accounts, quota, profiles',
      '  master guide                  Print the complete master-agent operating guide',
      ...registryHelp,
      ...executorsHelp,
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
      // A confined master's `restart` and `executors` are operations' loop requests (GY-1658), not acts on the host's systemd and pids it cannot reach.
      const concerns = (id === 'restart' || id === 'executors') && confinedMaster() ? [operationsCommand] : [intentCommand, fleetCommand, operationsCommand, loopCommand, mergerCommand];
      for (const command of concerns) if (await command(session) !== unhandled) return;
      throw new Error(`There is no master ${id}; use master guide for the subcommands`);
    },
  },
  ...sessionCommands,
]);

export { cycleBudget };

// plannedFiles resolved against the base branch (GY-140) lives beside this module.
export { baseTree, derivedIntent } from './planned-files-intent.js';
