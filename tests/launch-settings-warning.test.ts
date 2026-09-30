import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { awaitRuntimeStart, emptySourceStarts, sessionHarnessPlan, SessionStartError, startAgentSession, workerHarnessPlan } from '../src/master.js';
import { bashRuleMatches, claudeRuleProblem, harnessDecision, masterHarnessPlan } from '../src/harness.js';
import { detectConsentPrompt, settingsWarning } from '../src/consent-prompt.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// A worker dispatched into a fresh worktree stopped on Claude Code's "Settings Warning" dialog
// (Herdr: blocked; pane: "Enter to confirm · Esc to cancel") because the worker rules the launcher
// writes held `Bash(git push * :**)`, which Claude Code skips: ":*" must end a rule. The rules are
// now spelled so Claude Code takes every one, and a launch that still meets the dialog is refused
// naming the skipped rules — never answered, since "Continue" drops the deny rules it names.

/** The dialog as `herdr pane read --source recent-unwrapped` returned it for GY-159's dispatch. */
const warningScreen = [
  'fresh-wt4 HEAD ❯ GY=/w/.graphyard/launch/t; claude --permission-mode bypassPermissions --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"',
  '─────────────────────────────────────────────────────────────',
  '  Settings Warning',
  '',
  '  /home/vish/code/graphyard/.graphyard/worktrees/GY-159-4/.claude/settings.local.json',
  '  ├ permissions.deny: Invalid permission rule "Bash(git push * :**)" was skipped: The :* pattern must be at the end. Move :* to the end for prefix matching, or use * for wildcard',
  '    matching',
  '  └ permissions.deny: Invalid permission rule "Bash(git -* push * :**)" was skipped: The :* pattern must be at the end. Move :* to the end for prefix matching, or use * for wildcard',
  '    matching',
  '',
  '  The values listed above were skipped; the rest of the file is in effect.',
  '',
  '  ❯ 1. Continue',
  '    2. Fix with Claude',
  '    3. Exit and fix manually',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n');

/** A Herdr pane on a virtual clock whose runtime shows `screen` and reports `status`. */
function pane(screen: string, status: string) {
  let now = Date.parse('2026-09-24T04:06:00.000Z');
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'pane' && args[1] === 'read') return screen;
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: 'claude', agent_status: status, pane_id: args[2] } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({ agent: { agent: 'claude', name: args[3] } });
    return json({});
  };
  return { run, calls, bounds: { clock: () => now, wait: (ms: number) => { now += ms; } } };
}

test('unit:fresh-worktree-settings-warning — the launcher names Claude Code\'s settings warning and its skipped rules, never answers it, and never takes the session as started', async () => {
  assert.equal(detectConsentPrompt(warningScreen), null, 'a settings warning is not a consent prompt the allow-list could answer');
  assert.match(settingsWarning(warningScreen)!, /skipped 2 invalid permission rules \(Bash\(git push \* :\*\*\), Bash\(git -\* push \* :\*\*\)\)/);
  assert.match(settingsWarning(warningScreen)!, /GY-159-4\/\.claude\/settings\.local\.json/);
  assert.equal(settingsWarning('● Settings Warning was fixed earlier.\n❯ \n'), null, 'the words without the dialog are output');
  assert.equal(settingsWarning(`${warningScreen}\n● Continued.\n∙ Reading src/master.ts… (esc to interrupt)\n`), null, 'a dismissed dialog with the session at work below it');

  // Herdr reports the pane blocked (as on GY-159) or idle: either way the launch is refused with
  // the rules named, and no key is sent into the dialog.
  for (const status of ['blocked', 'idle']) {
    const blocked = pane(warningScreen, status);
    await assert.rejects(awaitRuntimeStart('w1V:p27J', 'claude', 'GY=/w/t; claude', blocked.run, { ...blocked.bounds, holdConsent: true }),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'blocked' && /settings warning/.test(error.message) && /Bash\(git push \* :\*\*\)/.test(error.message), status);
    assert.equal(blocked.calls.some(call => call[1] === 'send-keys'), false, status);
  }
  const directory = await temporaryDirectory('settings-warning');
  try {
    const launched = pane(warningScreen, 'blocked');
    await assert.rejects(startAgentSession('graphyard-claude-1', 'claude', 'w1V:p27J', ['--permission-mode', 'bypassPermissions'], 'Implement GY-159', launched.run, { directory, ...launched.bounds, holdConsent: true }),
      (error: unknown) => error instanceof SessionStartError && error.startCase === 'blocked');
    assert.equal(launched.calls.some(call => call[1] === 'send-keys'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unit:generated-rules-claude-accepts — every rule Graphyard writes for a Claude Code session is one Claude Code takes, and the empty-source refspec is still denied', () => {
  assert.match(claudeRuleProblem('Bash(git push * :**)')!, /must be at the end/);
  assert.match(claudeRuleProblem('Bash(:*)')!, /prefix cannot be empty/);
  assert.equal(claudeRuleProblem('Bash(git push:*)'), null);
  assert.equal(bashRuleMatches('Bash(git push * :**)', 'git push origin :foo'), false, 'a rule Claude Code skips matches nothing');

  const cliPath = '/repo/bin/graphyard.mjs', credentialHome = '/home/x/.config/graphyard';
  const branch = 'graphyard/gy-159-4';
  const worker = workerHarnessPlan({ cliPath, branch, baseBranch: 'main', credentialHome });
  const plans = [worker, masterHarnessPlan({ harness: 'claude', root: '/repo', cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome }),
    ...(['worker', 'reviewer', 'producer', 'approver', 'master'] as const).map(role => sessionHarnessPlan({ role, kind: 'claude', branch, cliPath, repository: 'owner/project', baseBranch: 'main', credentialHome, credentialDirectories: [credentialHome] } as Parameters<typeof sessionHarnessPlan>[0]))];
  for (const plan of plans) assert.deepEqual([...plan.allow, ...plan.deny].map(entry => claudeRuleProblem(entry.rule)).filter(Boolean), []);

  // The empty-source refspec in the spellings a ref name, a quote or an expansion starts with,
  // behind git's global options too, and the bare ":" that pushes every matching branch.
  for (const start of emptySourceStarts) for (const command of [`git push origin :${start}x`, `git -C . push origin :${start}x`]) assert.equal(harnessDecision(worker, command).decision, 'deny', command);
  for (const command of ['git push origin :graphyard/gy-7-1', 'git push origin :refs/tags/v1', 'git push origin :"x"', 'git push origin :$REF', 'git push origin :'])
    assert.equal(harnessDecision(worker, command).decision, 'deny', command);
  for (const command of [`git push origin ${branch}`, `git push -u origin ${branch}`, `git push origin HEAD:${branch}`]) assert.equal(harnessDecision(worker, command).decision, 'allow', command);
});
