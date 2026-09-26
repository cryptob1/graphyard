import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import graphyard, { guardCommand, mktempDirectories, systemPromptSection, type ExtensionApi, type ToolDefinition } from '../integrations/pi/index.js';
import { autonomyContract } from '../src/autonomy.js';
import { decidePayloadSchema, evidencePayloadSchema } from '../src/runner/payloads.js';
import { piArgs, piRunner } from '../src/runner/pi.js';

// GY-169: the Graphyard Pi extension (integrations/pi). One test per proof it produces:
// unit:pi-graphyard-tools (AC-2), unit:pi-session-autonomous (AC-4), unit:pi-destructive-guard (AC-5).

const H = 'a'.repeat(40), B = 'b'.repeat(40);

/**
 * Load the extension the way Pi does, against an API that records what it registers. Every
 * handler is called with a context whose `ui` — Pi's only way to ask a person anything — fails the
 * test when it is touched, and every prompt-shaped call is recorded.
 */
function load(role?: string) {
  const previous = process.env.GRAPHYARD_PI_ROLE;
  if (role === undefined) delete process.env.GRAPHYARD_PI_ROLE; else process.env.GRAPHYARD_PI_ROLE = role;
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>(), prompted: string[] = [];
  const api: ExtensionApi = { registerTool: tool => { tools.set(tool.name, tool); }, on: (event, handler) => { handlers.set(event, [...handlers.get(event) ?? [], handler]); } };
  try { graphyard(api); } finally { if (previous === undefined) delete process.env.GRAPHYARD_PI_ROLE; else process.env.GRAPHYARD_PI_ROLE = previous; }
  const ui = new Proxy({}, { get: (_target, name) => { prompted.push(String(name)); return () => { throw new Error(`the extension asked the user through ui.${String(name)}`); }; } });
  const ctx = (cwd: string) => ({ cwd, hasUI: false, ui });
  const emit = async (event: string, payload: any, cwd = process.cwd()) => { let answer: unknown; for (const handler of handlers.get(event) ?? []) answer = await handler(payload, ctx(cwd)) ?? answer; return answer; };
  return { tools, handlers, prompted, emit };
}

const verdict = { decision: 'decision-1', approve: false, reason: 'the change does not meet AC-2' };
const evidence = { proof: 'unit:pi-graphyard-tools', sha: H, baseSha: B, policyRevision: 4, result: 'pass', executed: 3, skipped: 0,
  exercise: { criterion: 'AC-2', behaviour: 'schema validation in execute removed', result: 'fail', executed: 3 } };

test('unit:pi-graphyard-tools the extension registers typed Graphyard tools whose schemas accept a valid call and reject a malformed one', async () => {
  const { tools } = load();
  assert.deepEqual([...tools.keys()].sort(), ['graphyard_decide', 'graphyard_submit_evidence']);
  const decide = tools.get('graphyard_decide')!, submit = tools.get('graphyard_submit_evidence')!;
  assert.deepEqual(decide.parameters.required, ['decision', 'approve', 'reason']);
  assert.equal(decide.parameters.additionalProperties, false);
  assert.deepEqual(submit.parameters.required, ['proof', 'sha', 'baseSha', 'policyRevision', 'result', 'executed', 'skipped', 'exercise']);

  // A valid call passes: its details are the payload the runner hands back, and Graphyard's own
  // payload schema accepts exactly that.
  const decided = await decide.execute('call-1', verdict);
  assert.deepEqual(decided.details, verdict);
  assert.deepEqual(decidePayloadSchema.parse(decided.details), verdict);
  const submitted = await submit.execute('call-2', evidence);
  assert.deepEqual(evidencePayloadSchema.parse(submitted.details), evidence);

  // Malformed calls are rejected with every reason, so the agent can correct the call.
  const { tools: fresh } = load();
  const rejects = (tool: string, input: unknown, reason: RegExp) => assert.rejects(fresh.get(tool)!.execute('call-x', input), reason);
  await rejects('graphyard_decide', { decision: 'decision-1', reason: 'fine' }, /input\.approve is required/);
  await rejects('graphyard_decide', { decision: 'decision-1', approve: 'yes', reason: 'fine' }, /input\.approve must be a boolean/);
  await rejects('graphyard_decide', { ...verdict, reason: '   ' }, /input\.reason must not be empty/);
  await rejects('graphyard_decide', { ...verdict, merge: true }, /input\.merge is not a field of this tool/);
  await rejects('graphyard_submit_evidence', { ...evidence, sha: 'abc' }, /input\.sha must match/);
  await rejects('graphyard_submit_evidence', { ...evidence, result: 'passed' }, /input\.result must be one of pass, fail/);
  await rejects('graphyard_submit_evidence', { ...evidence, executed: 2.5 }, /input\.executed must be an integer/);
  await rejects('graphyard_submit_evidence', { ...evidence, skipped: -1 }, /input\.skipped must be at least 0/);
  await rejects('graphyard_submit_evidence', { ...evidence, exercise: { result: 'fail' } }, /input\.exercise\.behaviour is required/);
  const { exercise: _dropped, ...unexercised } = evidence;
  await rejects('graphyard_submit_evidence', unexercised, /input\.exercise is required/);
  // Graphyard's own schema refuses the same malformed payloads independently of the extension.
  assert.throws(() => decidePayloadSchema.parse({ decision: 'decision-1', approve: 'yes', reason: 'fine' }));
  assert.throws(() => evidencePayloadSchema.parse({ ...evidence, sha: 'abc' }));

  // One submission per subject: the first accepted call stands.
  await assert.rejects(decide.execute('call-3', { ...verdict, approve: true }), /already recorded decision decision-1/);

  // A role session gets only its own tool.
  assert.deepEqual([...load('approver').tools.keys()], ['graphyard_decide']);
  assert.deepEqual([...load('producer').tools.keys()], ['graphyard_submit_evidence']);
});

test('unit:pi-session-autonomous the extension puts the autonomy contract in the system prompt, registers no tool that asks the user, and the runner launches Pi non-interactively', async () => {
  const { tools, handlers, prompted, emit } = load();
  // The system prompt: as a structured section when Pi offers one, appended otherwise.
  assert.ok(systemPromptSection.includes(autonomyContract), 'the section carries the contract verbatim');
  for (const phrase of ['act without asking', 'Never ask a human for review, approval or confirmation', 'record the blocker in Graphyard', 'Stop for a human only before an irreversible destructive action'])
    assert.ok(systemPromptSection.includes(phrase), phrase);
  const sections: Record<string, string> = {};
  await emit('before_agent_start', { prompt: 'p', systemPromptOptions: { sections } });
  assert.equal(sections.graphyard_autonomy, systemPromptSection);
  const replaced = await emit('before_agent_start', { prompt: 'p', systemPrompt: 'You are a coding agent.' }) as { systemPrompt: string };
  assert.ok(replaced.systemPrompt.startsWith('You are a coding agent.') && replaced.systemPrompt.includes(autonomyContract));

  // No registered tool asks the user: none is a question tool, and neither the tools nor any
  // handler touches the UI when exercised, whether a call is accepted or refused.
  for (const tool of tools.values()) {
    assert.doesNotMatch(`${tool.name} ${tool.description}`, /\b(ask|question|confirm|prompt the user|input from)\b/i, tool.name);
    await tool.execute('call-ok', tool.name === 'graphyard_decide' ? verdict : evidence);
    await assert.rejects(tool.execute('call-bad', {}));
  }
  await emit('tool_call', { toolName: 'bash', input: { command: 'rm -rf $HOME' } });
  await emit('tool_result', { toolName: 'bash', input: { command: 'mktemp -d' }, content: [{ type: 'text', text: '/nowhere' }] });
  assert.deepEqual([...handlers.keys()].sort(), ['before_agent_start', 'tool_call', 'tool_result']);
  assert.deepEqual(prompted, [], 'nothing asked the user');
  const source = await readFile(new URL('../integrations/pi/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''), /\.ui\b|\bconfirm\(|\bselect\(|\binput\(/, 'the extension source has no UI call');

  // The runner launches Pi in JSON mode (processes the prompt and exits), with no session to
  // resume, no discovered project resources, the prompt after `--`, and stdin closed.
  const args = piArgs('--resume the review', { model: 'zai/glm-5.3-flash', extension: '/ext.ts' });
  assert.deepEqual(args.slice(0, 2), ['--mode', 'json']);
  for (const flag of ['--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve']) assert.ok(args.includes(flag), flag);
  for (const flag of ['--continue', '-c', '--resume', '-r', '--mode=rpc']) assert.equal(args.slice(0, args.indexOf('--')).includes(flag), false, `${flag} is not a launch option`);
  assert.deepEqual(args.slice(-2), ['--', '--resume the review'], 'the prompt is a message, never an option');
  assert.equal(args[args.indexOf('--mode') + 1], 'json');
  let stdio: unknown;
  piRunner({ spawn: ((_command: string, _args: string[], options: { stdio: unknown }) => { stdio = options.stdio; throw new Error('not started'); }) as any })
    .start('p', { cwd: process.cwd(), tool: 'graphyard_decide', validate: value => value, timeoutMs: 1_000 }).cancel();
  assert.deepEqual(stdio, ['ignore', 'pipe', 'pipe'], 'stdin is closed: nothing can wait on a person');
});

test('unit:pi-destructive-guard the tool-call guard refuses rm on a statically unresolvable target with a reason, allows rm inside the session mktemp directory, and never prompts', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'graphyard-pi-guard-worktree-'));
  const session = await mkdtemp(join(tmpdir(), 'graphyard-pi-guard-session-'));
  try {
    const { emit, prompted } = load();
    const call = (command: string) => emit('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 'c', input: { command } }, worktree) as Promise<{ block: true; reason: string } | undefined>;

    // Statically unresolvable targets are refused, with the reason returned to the agent.
    for (const [command, reason] of [
      ['rm -rf "$TARGET"', /variable or expansion/], ['rm -rf $(git rev-parse --show-toplevel)', /variable or expansion/], ['rm -rf `pwd`/build', /variable or expansion/],
      ['rm -rf ./*', /glob/], ['rm -rf build/{a,b}', /glob/], ['mv *.log /var/log', /glob/], ['rm -rf ~other/data', /variable or expansion/],
      ['rm -rf /', /outside the worktree/], ['rm -rf ../sibling', /outside the worktree/], ['rm -rf ~', /outside the worktree/], [`rm -rf ${session}/x`, /outside the worktree/],
      ['cd "$DIR" && rm -rf build', /cannot be resolved/], ['find . -name x -exec rm {} +', /through find/], ['echo a | xargs rm', /through xargs/], ['bash -c "rm -rf build"', /through bash/],
      ['sudo rm -rf /etc', /outside the worktree/], ['X=1 rm -rf $X', /variable or expansion/],
      // rm inside loops, conditionals and groups: the reserved word is not the command.
      ['for d in *; do rm -rf "$d"; done', /variable or expansion/], ['if [ -d x ]; then rm -rf ../sibling; fi', /outside the worktree/],
      ['if true; then :; else rm -rf /; fi', /outside the worktree/], ['if false; then :; elif true; then rm -rf /; fi', /outside the worktree/],
      ['while true; do mv a /tmp/a; done', /outside the worktree/], ['{ rm -rf /; }', /outside the worktree/], ['! rm -rf ~', /outside the worktree/],
      // Wrappers with options and arguments.
      ['timeout 60 rm -rf /', /outside the worktree/], ['timeout -s KILL 5m rm -rf /', /outside the worktree/], ['sudo -u root rm -rf /etc', /outside the worktree/],
      ['env -i rm -rf "$X"', /variable or expansion/], ['nice -n 5 rm -rf ~', /outside the worktree/], ['/usr/bin/env FOO=1 rm -rf /', /outside the worktree/],
      ['stdbuf -oL rm -rf /', /outside the worktree/], ['ionice -c 3 nice rm -rf /', /outside the worktree/], ['flock /tmp/lock rm -rf /', /outside the worktree/],
      ['exec -a name rm -rf /', /outside the worktree/], ['timeout 5 bash -c "rm -rf /"', /through bash/], ['sudo --weird-option value rm -rf /', /behind sudo/],
      // Command substitutions run their own commands, quoted or not.
      ['echo "$(rm -rf ~)"', /outside the worktree/], ['echo "`rm -rf /`"', /outside the worktree/], ['echo $(echo "$(rm -rf "$X")")', /variable or expansion/],
    ] as const) {
      const verdict = await call(command);
      assert.equal(verdict?.block, true, `${command} is refused`);
      assert.match(verdict!.reason, reason, command);
      assert.match(verdict!.reason, /^Graphyard refused this command: .*Retry with each target spelled out as a literal path/, `${command}: the reason says how to retry`);
    }

    // Literal targets inside the worktree, and commands that are not rm or mv, run.
    for (const command of ['rm -rf build', `rm -f ${join(worktree, 'out.txt')}`, 'rm -rf -- node_modules/.cache', 'mv a.txt b.txt', 'git rm -q file.ts', 'ls -la *', 'rm build 2>/dev/null', 'cd src && rm old.ts',
      'for f in a b; do rm -f "build/a"; done', 'if [ -d build ]; then rm -rf build; fi', 'timeout 60 rm -rf build', 'sudo -u root rm -rf build', 'echo "$(git rev-parse HEAD)"', 'nice -n 5 git status'])
      assert.equal(await call(command), undefined, `${command} runs`);
    assert.equal(await emit('tool_call', { toolName: 'read', input: { path: '*' } }, worktree), undefined, 'other tools are not guarded');

    // Once the session has created a directory with mktemp, rm inside it runs.
    assert.equal((await call(`rm -rf ${session}/scratch`))?.block, true, 'before mktemp created it, the directory is outside');
    await emit('tool_result', { type: 'tool_result', toolName: 'bash', input: { command: 'mktemp -d' }, content: [{ type: 'text', text: `${session}\n` }], isError: false }, worktree);
    assert.equal(await call(`rm -rf ${session}/scratch`), undefined, 'rm inside the session mktemp directory runs');
    assert.equal(await call(`rm -rf ${session}`), undefined, 'removing the mktemp directory itself runs');
    assert.equal((await call(`rm -rf ${session}/*`))?.block, true, 'a glob stays refused even inside it');
    // A path printed by something other than mktemp is not a session directory.
    const other = await mkdtemp(join(tmpdir(), 'graphyard-pi-guard-other-'));
    await emit('tool_result', { toolName: 'bash', input: { command: `echo ${other}` }, content: [{ type: 'text', text: other }] }, worktree);
    assert.equal((await call(`rm -rf ${other}`))?.block, true);
    await rm(other, { recursive: true, force: true });
    // GY-391: only the mktemp invocation's own line counts. A command that merely mentions mktemp
    // and prints other existing directories beside it widens nothing.
    const listed = await mkdtemp(join(tmpdir(), 'graphyard-pi-guard-listed-'));
    try {
      for (const command of [`mktemp -d && ls -d ${listed}`, `mktemp -d; echo ${listed}`, `echo mktemp; ls -d ${listed}`, `ls -d ${listed} # mktemp`, `D=$(mktemp -d) && echo ${listed}`, 'mktemp', 'mktemp -u'])
        await emit('tool_result', { toolName: 'bash', input: { command }, content: [{ type: 'text', text: `${session}\n${listed}\n` }] }, worktree);
      await emit('tool_result', { toolName: 'bash', input: { command: 'mktemp -d && ls -d /tmp' }, content: [{ type: 'text', text: listed }] }, worktree);
      assert.equal((await call(`rm -rf ${listed}`))?.block, true, 'a directory another command printed is not a session directory');
      assert.deepEqual(mktempDirectories(`mktemp -d && ls -d ${listed}`, `${session}\n${listed}`), []);
      assert.deepEqual(mktempDirectories('mktemp -d', `${session}\n${listed}`), [], 'mktemp -d prints one line; more is not its output');
      for (const command of ['mktemp -d', 'mktemp -d -t x.XXXXXX', 'mktemp -dt x.XXXXXX', '/usr/bin/mktemp --directory', 'mktemp -qd'])
        assert.deepEqual(mktempDirectories(command, `${listed}\n`), [listed], command);
      assert.deepEqual(mktempDirectories('mktemp', `${listed}\n`), [], 'a file mktemp is not a directory the session created');
    } finally { await rm(listed, { recursive: true, force: true }); }

    // Symbolic links are followed as rm follows them: a trailing slash on a link to a directory outside deletes outside.
    const outside = await mkdtemp(join(tmpdir(), 'graphyard-pi-guard-outside-'));
    await symlink(outside, join(worktree, 'link'));
    assert.match((await call('rm -rf link/'))!.reason, /outside the worktree/, 'a link to outside with a trailing slash is refused');
    assert.equal(await call('rm link'), undefined, 'removing the link itself runs');
    assert.match((await call('rm -rf link/inner'))!.reason, /outside the worktree/, 'a path through a link to outside is refused');
    await rm(outside, { recursive: true, force: true });

    assert.deepEqual(prompted, [], 'the guard never prompts');
    // The same verdicts from the guard function itself.
    assert.deepEqual(guardCommand('rm -rf build', { cwd: worktree }), { allow: true });
    assert.equal(guardCommand('rm -rf "$1"', { cwd: worktree }).allow, false);
  } finally { await rm(worktree, { recursive: true, force: true }); await rm(session, { recursive: true, force: true }); }
});
