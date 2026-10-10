import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import graphyardExtension, { doctorCommandVerdict, doctorReasonLimit, doctorRules, doctorSegmentAllowed } from '../integrations/pi/index.js';
import { doctorPrompt } from '../src/daemon/doctor.js';

// GY-1653: the doctor's allowlist judges a sanctioned master command by its grammar — program,
// CLI script, `master`, subcommand, item key, files and flags — and passes the free-text reason as
// prose. Each test is named for the proof it produces.

/** A stand-in Graphyard CLI that prints the arguments it was given, so a run shows what the shell passed. */
function stubCli() {
  const directory = mkdtempSync(join(tmpdir(), 'gy-1653-'));
  const cli = join(directory, 'graphyard.mjs');
  writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  return { cli, done: () => rmSync(directory, { recursive: true, force: true }) };
}

/** The extension's tool_call hook under the doctor role, with the CLI the loop names. */
function doctorHook(cli: string) {
  const hook: Record<string, (event: any, ctx: any) => unknown> = {};
  graphyardExtension({ registerTool: () => {}, on: (event, handler) => { hook[event] = handler as never; return handler; } });
  return (command: string) => {
    const saved = { role: process.env.GRAPHYARD_PI_ROLE, cli: process.env.GRAPHYARD_DOCTOR_CLI };
    try {
      Object.assign(process.env, { GRAPHYARD_PI_ROLE: 'doctor', GRAPHYARD_DOCTOR_CLI: cli });
      const input = { command };
      const verdict = hook.tool_call({ toolName: 'bash', input }, { cwd: process.cwd() }) as { block?: boolean; reason?: string } | undefined;
      return { verdict, command: input.command };
    } finally {
      for (const [name, value] of [['GRAPHYARD_PI_ROLE', saved.role], ['GRAPHYARD_DOCTOR_CLI', saved.cli]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
}

/** Run a line as the doctor's bash tool would, returning the stub CLI's arguments. */
const run = (command: string) => JSON.parse(execFileSync('bash', ['-c', command], { encoding: 'utf8' })) as string[];

// The reasons of the 2026-10-10 doctor run that were refused as commands, and the shapes that broke them.
const incident = [
  { quoted: `'GY-1652 was blocked 25 min; requirements revised at 14:40 (policy revision 2)'`, reason: 'GY-1652 was blocked 25 min; requirements revised at 14:40 (policy revision 2)' },
  { quoted: `'the item's last fail predates the fix; most recent attempt is green'`, reason: 'the item\'s last fail predates the fix; most recent attempt is green' },
  { quoted: `"the most recent attempt passed; last attempt's CI is green"`, reason: 'the most recent attempt passed; last attempt\'s CI is green' },
  { quoted: `"\`most recent\` attempt passed (policy revision 2); unblock costs \\$0"`, reason: '`most recent` attempt passed (policy revision 2); unblock costs $0' },
];

test('integration:doctor-unblock-prose-reason — a sanctioned master unblock whose reason holds ordinary bigrams runs on its first submission with the reason intact', () => {
  const { cli, done } = stubCli();
  try {
    const call = doctorHook(cli);
    for (const { quoted, reason } of incident) {
      for (const program of [`node ${cli}`]) {
        const { verdict, command } = call(`${program} master unblock GY-1652 ${quoted}`);
        assert.equal(verdict, undefined, `the unblock with reason ${quoted} is accepted on the first attempt: ${verdict?.reason}`);
        assert.deepEqual(run(command), ['master', 'unblock', 'GY-1652', reason], `the CLI receives ${quoted} as one prose argument`);
      }
    }
    // A reason that never broke the shell runs exactly as written: the guard rewrites nothing it need not.
    const plain = `node ${cli} master unblock GY-1652 "requirements revised; most recent attempt green"`;
    assert.equal(call(plain).command, plain, 'a well-quoted reason runs as written');
  } finally { done(); }
});

test('unit:allowlist-grammar-only-scanning — the allowlist judges the command grammar, never the reason prose; the grammar stays enforced', () => {
  const { cli, done } = stubCli();
  try {
    const context = { cwd: process.cwd(), cli, env: {} };
    // Prose naming refused programs and subcommands is still prose, for every sanctioned command.
    for (const prose of ['most recent', 'last attempt', 'requirements revised', 'policy revision', 'merge dispatch evidence claim', 'rm -rf src then git push']) {
      for (const name of ['unblock', 'scope', 'settle-containment', 'release']) {
        const verdict = doctorCommandVerdict(`node ${cli} master ${name} GY-1652 "${prose} (as of 14:47); see 'GY-1649'"`, context);
        assert.equal(verdict.allow, true, `master ${name} with reason "${prose}" is accepted`);
      }
      const words = ['graphyard', 'master', 'unblock', 'GY-1652', ...prose.split(' ')].map(value => ({ value, dynamic: false, glob: false }));
      assert.deepEqual(doctorSegmentAllowed(words, context), { allow: true }, `the unquoted words of "${prose}" after a sanctioned grammar are not read as commands`);
    }
    // The grammar is still the gate: an unsanctioned subcommand, the CLI through another script and
    // a command chained after a closed reason are refused, whatever the reason says.
    for (const line of [
      `node ${cli} master merge GY-1652 'it's the most recent attempt'`,
      `node ${cli} master dispatch GY-1652 "most recent attempt"`,
      `node scripts/other.mjs master unblock GY-1652 'it's the most recent attempt'`,
      `node ${cli} master unblock GY-1652 "most recent" && git push origin main`,
      `node ${cli} master unblock GY-1652 "most recent"; rm -rf src`,
      `NODE_OPTIONS=--require=/tmp/x.js node ${cli} master unblock GY-1652 'it's recent'`,
    ]) assert.equal(doctorCommandVerdict(line, context).allow, false, `${line} is refused`);
    // A reason running to the end of a line enclosed in quotes is prose all the way: nothing after the grammar runs.
    const swallowed = doctorCommandVerdict(`node ${cli} master unblock GY-1652 'it's done'; cat '/etc/passwd'`, context);
    assert.equal(swallowed.allow, true);
    assert.deepEqual(run(swallowed.command!), ['master', 'unblock', 'GY-1652', 'it\'s done\'; cat \'/etc/passwd'], 'the trailing text is the reason, never a command');
    // The reason's bounds: length and control characters.
    const long = doctorCommandVerdict(`node ${cli} master unblock GY-1652 'it's ${'x'.repeat(doctorReasonLimit)}'`, context);
    assert.equal(long.allow, false, 'a reason past the limit is refused');
    if (!long.allow) assert.match(long.reason, /reason-bounds rule/);
    const control = doctorCommandVerdict(`node ${cli} master unblock GY-1652 'it's \u0007 recent'`, context);
    assert.equal(control.allow, false, 'a reason carrying a control character is refused');
    if (!control.allow) assert.match(control.reason, /reason-bounds rule/);
    // The prompt tells the doctor where the reason goes.
    assert.match(doctorPrompt({ repository: 'owner/project', cliPath: cli }, { items: [], faults: [] }), /free-text reason last, enclosed in one pair of quotes/);
  } finally { done(); }
});

test('unit:allowlist-refusal-names-rule — every refusal names the rule that denied it and the word, segment and column it came from', () => {
  const { cli, done } = stubCli();
  try {
    const context = { cwd: process.cwd(), cli, env: {} };
    const cases: [string, keyof typeof doctorRules, RegExp][] = [
      // The incident's shape: prose after an unquoted `;` is named as a segment the `;` began, not an unsanctioned command.
      [`graphyard master unblock GY-1652 blocked; most recent attempt`, 'read-programs', /word 1 "most", column 43 of segment 2, which the ";" at column 41 began outside any quote \(if these words are a reason's prose, enclose the whole reason in one pair of quotes\)/],
      [`node ${cli} master merge GY-1652`, 'sanctioned-commands', /word 4 "merge", column \d+ of segment 1/],
      [`graphyard evidence GY-1652`, 'sanctioned-commands', /word 2 "evidence", column 11 of segment 1/],
      [`node ${cli} master merge GY-1652 'it's merged'`, 'closed-quotes', /column \d+, in word \d+ of segment 1/],
      [`cat README.md > out.txt`, 'no-redirection', /at column 15/],
      [`cat $GRAPHYARD_TOKEN_FILE`, 'no-expansion', /word 2 "\$GRAPHYARD_TOKEN_FILE", column 5 of segment 1/],
      [`env cat README.md`, 'program-first', /word 1 "env", column 1 of segment 1/],
      [`./cat README.md`, 'bare-program-name', /word 1 "\.\/cat"/],
      [`node -e 1`, 'node-runs-cli-only', /word 2 "-e"/],
      [`git status; grep -r token src`, 'no-recursive-read', /word 2 "-r", column 18 of segment 2/],
      [`cat .env`, 'no-secret-files', /word 2 "\.env"/],
      [`cat /etc/hostname`, 'inside-checkout', /word 2 "\/etc\/hostname"/],
      [`gh pr view 1 --repo other/x`, 'gh-this-repository', /word 5 "--repo"/],
      [`gh pr view 1 --web`, 'gh-headless', /word 5 "--web"/],
      [`npm install`, 'read-programs', /word 1 "npm", column 1 of segment 1/],
    ];
    for (const [line, rule, position] of cases) {
      const verdict = doctorCommandVerdict(line, context);
      assert.equal(verdict.allow, false, `${line} is refused`);
      if (verdict.allow) continue;
      assert.ok(verdict.reason.includes(`under its ${rule} rule (${doctorRules[rule]})`), `${line} names the ${rule} rule: ${verdict.reason}`);
      assert.match(verdict.reason, position, `${line} names where the refused word came from: ${verdict.reason}`);
      assert.match(verdict.reason, /was not run.*Record the refused command/, 'the refusal still says it was recorded, not run');
    }
  } finally { done(); }
});

test('integration:doctor-unblock-first-attempt — a stuck-gate unblock with an apostrophe in its prose reason completes in one submission, where the line as written would break the shell', () => {
  const { cli, done } = stubCli();
  try {
    const call = doctorHook(cli);
    // One apostrophe leaves a quote open, so bash cannot run the line; two pair up, so bash runs it
    // with the quotes dropped and the reason split. Either way the line as written fails the doctor.
    const reasons = [
      'GY-1652 is 25 min past the blocked bound; the item\'s requirements were revised (policy revision 2)',
      'GY-1652 is 25 min past the blocked bound; the item\'s requirements were revised and the most recent attempt\'s CI is green',
    ];
    for (const reason of reasons) {
      const written = `node ${cli} master unblock GY-1652 '${reason}'`;
      const raw = spawnSync('bash', ['-c', written], { encoding: 'utf8' });
      if (raw.status === 0) assert.notDeepEqual(JSON.parse(raw.stdout), ['master', 'unblock', 'GY-1652', reason], 'the line as written mangles the reason');
      else assert.notEqual(raw.status, 0, 'the line as written breaks the shell');
      // Through the doctor's guard it is one submission: not refused, and run once with the reason whole.
      let submissions = 0, ran: string[] | null = null;
      for (let attempt = 0; attempt < 3 && !ran; attempt++) {
        submissions++;
        const { verdict, command } = call(written);
        if (verdict?.block) continue;
        ran = run(command);
      }
      assert.equal(submissions, 1, 'the unblock completes on its first submission, with no reformulation loop');
      assert.deepEqual(ran, ['master', 'unblock', 'GY-1652', reason], 'the CLI receives the reason exactly as the doctor wrote it');
    }
    // The shell's own apostrophe idiom is already one argument, so it runs as written.
    const idiom = `node ${cli} master unblock GY-1652 'the item'\\''s most recent attempt'`;
    assert.equal(call(idiom).command, idiom);
    assert.deepEqual(run(idiom), ['master', 'unblock', 'GY-1652', 'the item\'s most recent attempt']);
  } finally { done(); }
});
