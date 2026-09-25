import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineCommands } from './registry.js';
import { cycleBudget } from './master-status.js';
import { masterInit } from './master-init.js';
import { sessionCommands } from './session-commands.js';
import { registryHelp } from './master-registry.js';
import { executorsHelp } from './master-executors.js';
import { closeHelp } from './master-close.js';
import { openMasterSession, unhandled } from './master/session.js';
import { intentCommand } from './master/intent.js';
import { fleetCommand } from './master/fleet.js';
import { operationsCommand } from './master/operations.js';
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
      '  master protection [--apply]   Reconcile branch protection with every open review policy',
      '  master browser FLOW [--dry-run]',
      "                                Perform GitHub administration through the operator's browser",
      '                                profile: app-permissions, installation-accept, or protection;',
      '                                recorded, API-verified, audited',
      '  master harness [KIND] [--apply]  Generate the master\'s own harness permissions',
      '  master status                 Graphyard work truth joined with Herdr session health, the',
      '                                dispatch order, overlaps and merge conflicts',
      '  master dispatch GY-N PROFILE [--allow-overlap]',
      '                                Invite a worker to claim ready work in a visible tab; an',
      '                                overlap holds it (bounded) unless --allow-overlap is passed',
      '  master settle-containment GY-N REASON',
      '                                Settle a containment quarantine whose supervisor this host',
      '                                verifies dead; unverifiable signals refuse',
      '  master merge GY-N|--all       Merge exact authorized candidates without bypasses',
      '  master config FIELD=VALUE…   Tune owned run settings and profile accounts',
      '                                (accounts:PROFILE=a,b); autoMerge and credential paths stay operator-only',
      '  master verify-deployment GY-N Verify that the deployed release serves a delivery and emits',
      '                                the current instructions; records the exact release observed',
      '  master run [--once] [--interval SECONDS]',
      '                                The durable coordination loop: launches reviewers and producers',
      '                                for every submitted head and decides open scope requests',
      '  master autonomy [--admin-token-stdin --apply]  Provision the master and approver identities',
      '  master create FILE|release GY-N|unblock GY-N|requirements GY-N FILE [--allow-broad-scope] REASON',
      '                                Own intent; a root-level directory scope needs the flag',
      ...closeHelp,
      '  master scope GY-N [--allow-broad-scope] [REASON]',
      '                                Apply a scope request the loop refused, widening plannedFiles',
      '                                while the attempt keeps its lease',
      '  master decide GY-N ACTION [JSON|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON',
      '                                Request a two-party decision, citing precedent and context',
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
      // The guide's first line is its docs-index entry, not guide body.
      if (id === 'guide') return console.log((await readFile(fileURLToPath(new URL('../../docs/master-agent.md', import.meta.url)), 'utf8')).replace(/^<!-- page:[^\n]*\n/, ''));
      if (id === 'init') return masterInit(context, root);
      const session = await openMasterSession(context, root);
      // Each concern under ./master/ answers its own subcommands; the first that knows the id handles it.
      for (const command of [intentCommand, fleetCommand, operationsCommand, loopCommand]) if (await command(session) !== unhandled) return;
      throw new Error(`There is no master ${id}; use master guide for the subcommands`);
    },
  },
  ...sessionCommands,
]);

export { cycleBudget };

// plannedFiles resolved against the base branch (GY-140) lives beside this module.
export { baseTree, derivedIntent } from './planned-files-intent.js';
