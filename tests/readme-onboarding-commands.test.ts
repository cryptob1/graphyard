import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const start = readme.split('## Quick start\n')[1]?.split('\n## ')[0] ?? '';
const cli = new URL('../src/cli.ts', import.meta.url);
const help = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli.pathname, ...args], { encoding: 'utf8' });

test('unit:readme-onboarding-commands — ordered onboarding uses commands and flags advertised by this CLI', () => {
  assert.deepEqual([...start.matchAll(/^(\d)\. /gm)].map(match => match[1]), ['1', '2', '3', '4', '5']);
  const up = help('up', '--help');
  const all = help('--help');
  const command = start.match(/graphyard up ([^\n`]+)/)?.[1];
  assert.ok(command, 'onboarding gives an explicit up command');
  assert.match(command, /--repo OWNER\/NAME/);
  for (const flag of start.matchAll(/--[a-z-]+/g)) {
    if (flag[0] === '--scopes') continue; // gh auth login, not Graphyard
    assert.ok(`${up}\n${all}`.includes(flag[0]), `help advertises ${flag[0]}`);
  }
  for (const command of ['master status', 'upgrade --plan', 'upgrade']) {
    assert.ok(start.includes(`graphyard ${command}`));
    assert.match(all, new RegExp(command === 'upgrade --plan' ? 'upgrade .*\\[--plan\\]' : command));
  }
  assert.match(start, /Setup link/);
  assert.match(start, /worker and reviewer/);
  assert.match(start, /New work item/);
  assert.match(start, /acceptance criteria and required proof names/);
});
