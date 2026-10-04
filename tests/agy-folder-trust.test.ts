import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agyConfigFile, launchPlan, LaunchRefusedError, nonInteractiveLaunch, trustAgyFolder } from '../src/harness.js';
import { awaitRuntimeStart, SessionStartError, startAgentSession } from '../src/master.js';
import { detectConsentPrompt } from '../src/consent-prompt.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1152: Antigravity CLI (`agy`) asks "Do you trust the contents of this project?" in every
// folder its settings do not list, and --dangerously-skip-permissions does not skip it, so every
// fresh worktree stopped there holding its lease and slot. The recipe now records the worktree in
// agy's own trustedWorkspaces before the session starts, and a workspace-trust prompt that still
// shows fails the launch naming it. One case per proof: unit:agy-fresh-worktree-trusted,
// unit:trust-prompt-screen-fails-launch.

/** Antigravity's trust dialog as `pane read --source recent-unwrapped` returns it: an arrow-selected, unnumbered menu. */
const agyTrustDialog = [
  ' Antigravity CLI v1.2.4',
  '',
  ' Do you trust the contents of this project?',
  '',
  ' /home/vish/code/project/.graphyard/worktrees/GY-1152-1',
  '',
  ' Antigravity CLI requires permission to read, edit, and execute files here.',
  '',
  ' > Yes, I trust this folder',
  '   No, exit',
  '',
  ' ↑/↓ to select · enter to confirm',
].join('\n');

test('unit:agy-fresh-worktree-trusted — the built agy launch for a worktree it has never run in records that worktree in agy\'s trustedWorkspaces before the session starts', async () => {
  assert.equal(nonInteractiveLaunch.agy.trust, trustAgyFolder, 'the agy recipe carries a trust step, as the claude recipe does');
  assert.match(launchPlan('agy').prompts!, /workspace-trust prompt/);
  const home = await temporaryDirectory('agy-home'), worktree = await temporaryDirectory('agy-worktree'), directory = await temporaryDirectory('agy-launch');
  const settings = agyConfigFile({ HOME: home });
  assert.equal(settings, join(home, '.gemini', 'antigravity-cli', 'settings.json'));
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  await writeFile(settings, JSON.stringify({ theme: 'dark', trustedWorkspaces: ['/home/vish/code/project'] }));

  // The fresh worktree is not listed (an ancestor never counts for agy); the launch line reaches
  // the pane only after the folder is recorded, so the runtime never draws the dialog.
  const seen: unknown[] = [], typed: ReturnType<typeof expandTypedCommand>[] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'run') { seen.push(JSON.parse(readFileSync(settings, 'utf8')).trustedWorkspaces); typed.push(expandTypedCommand(args[3])); }
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  const plan = launchPlan('agy');
  const started = await startAgentSession('eng-agy', 'agy', 'pane-a', plan.args, 'Implement GY-1152', run, { directory, cwd: worktree, environment: { HOME: home } });
  const folder = realpathSync(worktree);
  assert.deepEqual(seen, [['/home/vish/code/project', folder]], 'the worktree was trusted before the launch line reached the pane');
  assert.deepEqual(started.trust, { file: settings, directory: folder, written: true });
  assert.equal(started.started.state, 'started');
  assert.equal(typed[0].kind, 'agy'); assert.ok(typed[0].args.includes('--dangerously-skip-permissions'));
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).theme, 'dark', 'the rest of agy\'s settings are kept');

  // A folder already trusted is left as it is; one without any settings yet gets them.
  assert.equal((await trustAgyFolder(worktree, { HOME: home })).written, false);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).trustedWorkspaces, ['/home/vish/code/project', folder]);
  const fresh = await temporaryDirectory('agy-fresh-home');
  assert.equal((await trustAgyFolder(worktree, { HOME: fresh })).written, true);
  assert.deepEqual(JSON.parse(await readFile(agyConfigFile({ HOME: fresh }), 'utf8')), { trustedWorkspaces: [folder] });

  // Sessions launched at once each keep their record: the writes are serialized under the lock.
  const folders = await Promise.all(Array.from({ length: 5 }, () => temporaryDirectory('agy-concurrent')));
  assert.ok((await Promise.all(folders.map(each => trustAgyFolder(each, { HOME: home })))).every(result => result.written));
  const listed = JSON.parse(await readFile(settings, 'utf8')).trustedWorkspaces;
  for (const each of [folder, ...folders.map(path => realpathSync(path))]) assert.ok(listed.includes(each), each);

  // Settings that cannot be read refuse the launch, naming the runtime, before anything reaches Herdr.
  await writeFile(settings, '{ not json');
  const refused: string[][] = [];
  await assert.rejects(startAgentSession('eng-agy', 'agy', 'pane-a', plan.args, 'Implement GY-1152', (_command, args) => { refused.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: {} }); }, { directory, cwd: await temporaryDirectory('agy-other'), environment: { HOME: home } }),
    (error: unknown) => error instanceof LaunchRefusedError && error.kind === 'agy' && /could not be read as JSON/.test(error.message) && /workspace-trust prompt/.test(error.message));
  assert.deepEqual(refused, []);
});

test('unit:trust-prompt-screen-fails-launch — an agy session whose screen shows Antigravity\'s workspace-trust prompt fails its launch naming the prompt, never started or held with a lease', async () => {
  const prompt = detectConsentPrompt(agyTrustDialog)!;
  assert.equal(prompt.kind, 'folder', 'the unnumbered arrow-selected menu is read as the workspace-trust dialog it is');
  assert.match(prompt.text, /^Do you trust the contents of this project\?/);
  assert.equal(prompt.keys, null, 'folder trust is never answered by the launcher');
  // The words alone, or a Yes/No list under unrelated output, are not that dialog.
  assert.equal(detectConsentPrompt('● Reading src/harness.ts\n> Yes, I trust this folder\n'), null);
  assert.equal(detectConsentPrompt(`${agyTrustDialog}\n● Trusted.\n● Reading src/harness.ts\n∙ Working… (esc to interrupt)\nx\n`), null);

  // Herdr reports the stopped runtime idle — what a started session looks like — and the pane shows the dialog.
  let now = Date.parse('2026-10-03T11:15:00.000Z');
  const keys: string[][] = [];
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'pane' && args[1] === 'read') return agyTrustDialog;
    if (args[0] === 'pane' && args[1] === 'send-keys') { keys.push(args.slice(3)); return ''; }
    if (args[0] === 'agent' && args[1] === 'get') return JSON.stringify({ result: { agent: { agent: 'agy', agent_status: 'idle', pane_id: args[2] } } });
    return JSON.stringify({ result: {} });
  };
  const bounds = { clock: () => now, wait: (ms: number) => { now += ms; } };
  const failsNamingIt = (error: unknown) => error instanceof SessionStartError && error.startCase === 'awaiting consent'
    && /the agy runtime stopped at a workspace-trust prompt in pane w1V:pA1/.test(error.message) && error.message.includes('"Do you trust the contents of this project?')
    && error.screen.startsWith('Do you trust the contents of this project?');
  // A worker, which is held for a human on any other prompt, is failed on this one rather than holding its lease.
  await assert.rejects(awaitRuntimeStart('w1V:pA1', 'agy', 'GY=/s; agy', run, { ...bounds, holdConsent: true }), failsNamingIt);
  await assert.rejects(awaitRuntimeStart('w1V:pA1', 'agy', 'GY=/s; agy', run, bounds), failsNamingIt);
  // The whole launch fails the same way, with nothing typed into the dialog.
  const directory = await temporaryDirectory('agy-fail'), home = await temporaryDirectory('agy-fail-home');
  await assert.rejects(startAgentSession('eng-agy', 'agy', 'w1V:pA1', launchPlan('agy').args, 'Implement GY-1152', run, { directory, cwd: directory, environment: { HOME: home }, holdConsent: true, ...bounds }), failsNamingIt);
  assert.deepEqual(keys, [], 'the trust prompt is never answered by the launcher');
});

test('GY-1183 — an agy account homed by AGY_CONFIG_DIR records trust in its own settings, and writes drop removed Graphyard worktrees only', async () => {
  const home = await temporaryDirectory('agy-launcher-home'), account = await temporaryDirectory('agy-account-home'), worktree = await temporaryDirectory('agy-account-worktree');
  const settings = agyConfigFile({ HOME: home, AGY_CONFIG_DIR: account });
  assert.equal(settings, join(account, 'settings.json'), 'the account\'s own settings, not the launcher\'s home');
  assert.deepEqual(await trustAgyFolder(worktree, { HOME: home, AGY_CONFIG_DIR: account }), { file: settings, directory: realpathSync(worktree), written: true });
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).trustedWorkspaces, [realpathSync(worktree)]);
  assert.equal(existsSync(agyConfigFile({ HOME: home })), false, 'nothing was written under the launcher\'s HOME');

  // A removed Graphyard worktree is pruned on the next write; a live one and the operator's own entries stay.
  const root = await temporaryDirectory('agy-prune'), worktrees = join(root, '.graphyard', 'worktrees');
  const live = join(worktrees, 'GY-1-1'), removed = join(worktrees, 'GY-2-1'), next = join(worktrees, 'GY-3-1');
  mkdirSync(live, { recursive: true }); mkdirSync(next, { recursive: true });
  const operator = join(root, 'gone-project');
  await writeFile(settings, JSON.stringify({ trustedWorkspaces: [operator, realpathSync(live), join(realpathSync(root), '.graphyard', 'worktrees', 'GY-2-1'), 7] }));
  assert.equal(existsSync(removed), false);
  assert.equal((await trustAgyFolder(next, { AGY_CONFIG_DIR: account })).written, true);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')).trustedWorkspaces, [operator, realpathSync(live), 7, realpathSync(next)]);
});
