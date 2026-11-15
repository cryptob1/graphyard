import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterPrompt } from '../src/master/harness.js';
import { masterGuide } from '../src/master/guide.js';
import { guideText } from '../src/guide.js';
import type { MasterConfig } from '../src/master/profiles.js';

// GY-3274 AC-3: the master prompt and guide master say the master is responsible for the product
// succeeding — it learns the problem and the users first, writes and
// revises the product brief, ranks work by its success signals and re-checks them after each
// deploy, records lessons, and defers to the owner's stated mission and priorities, with money,
// accounts and credentials the owner's alone.
// GY-3307: the guidance names the master Master, never chief.

const config = {
  repository: 'owner/project', cliPath: '/bin/graphyard.mjs', url: 'https://graphyard.example', credentialFile: '/credentials/master.token',
  hostId: 'host', baseBranch: 'main', githubAppId: 1, masterAgentName: 'graphyard-master-project',
  workers: [], reviewers: [], producers: [], run: {},
} as unknown as MasterConfig;

/** Every text the founder guidance lives in: the launch role brief, the `guide master` topic and `master guide`. */
const texts = () => ({ prompt: masterPrompt(config), guideTopic: guideText('master'), masterGuide });

test('unit:tests/master-founder-guidance.test.ts — the master prompt and guide master name the master responsible for the product succeeding', () => {
  const { prompt, guideTopic } = texts();
  assert.match(prompt, /master agent for owner\/project, responsible for the product succeeding/);
  assert.match(guideTopic, /The master is responsible for the product succeeding/);
  // GY-3307: the guidance names the master Master, never chief.
  for (const text of Object.values(texts())) assert.doesNotMatch(text, /chief/i);
});

test('unit:tests/master-founder-guidance.test.ts — it first learns the problem and the users from the repository, docs, the running app, owner messages and item history', () => {
  const { prompt, guideTopic } = texts();
  assert.match(prompt, /learn the problem and users first \(repository, docs, the running app, owner messages, item history\)/);
  assert.match(guideTopic, /first learns the problem and the users — the repository, its docs, the running app, owner messages and the item history/);
});

test('unit:tests/master-founder-guidance.test.ts — it writes and revises the product brief, and the guide names the command and the brief\'s shape', () => {
  const { prompt, guideTopic } = texts();
  assert.match(prompt, /write and revise the product brief/);
  assert.match(guideTopic, /writes the product brief with `master brief set FILE REASON`/);
  assert.match(guideTopic, /at most 800 words, with the sections problem, users, what success looks like with measurable signals, current bets and open questions/);
  assert.match(guideTopic, /revises the brief/);
});

test('unit:tests/master-founder-guidance.test.ts — it turns the brief into goals and work items ranked by impact on the success signals and re-checks them after each deploy', () => {
  const { prompt, guideTopic } = texts();
  assert.match(prompt, /turn it into goals and work items ranked by impact on its success signals, re-check them after each deploy/);
  assert.match(guideTopic, /turns the brief into goals and work items ranked by impact on the success signals, checks after each deploy whether shipped work moved those signals/);
});

test('unit:tests/master-founder-guidance.test.ts — it records what it learned as lessons', () => {
  const { prompt, guideTopic } = texts();
  assert.match(prompt, /record lessons/);
  assert.match(guideTopic, /records what it learned as lessons \(`master lesson add`\)/);
});

test('unit:tests/master-founder-guidance.test.ts — the owner\'s stated mission and priorities override its ranking, and money, accounts and credentials stay with the owner', () => {
  const { prompt, guideTopic } = texts();
  for (const text of [prompt, guideTopic]) assert.match(text, /owner's stated mission and priorities override/);
  assert.match(prompt, /spending money or opening third-party accounts, and issuing credentials to people belong to the human/);
  assert.match(guideTopic, /spending money, opening third-party accounts and issuing credentials to people stay with the owner/);
});

test('unit:tests/master-founder-guidance.test.ts — the master guide, which `master guide` prints at launch, carries the same founder guidance', () => {
  const { masterGuide: guide } = texts();
  assert.match(guide, /The master is responsible for the product succeeding/);
  assert.match(guide, /learn the problem and the users first \(repository, docs, the running app, owner messages, item history\)/);
  assert.match(guide, /keep the product brief current/);
  assert.match(guide, /rank work by its impact on the brief's success signals and re-check those signals after each deploy/);
  assert.match(guide, /the owner's stated mission and priorities override that ranking/);
  assert.match(guide, /spending money, opening third-party accounts and issuing credentials for people stay with the owner/);
});
