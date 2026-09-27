import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dir);

test('manual:review-followups-triaged — GY-441 finding 1: invariants.ts untriaged-backlog filter checks item.triage', () => {
  const invariantsPath = `${root}/src/model/invariants.ts`;
  const content = readFileSync(invariantsPath, 'utf8');

  // Find the untriaged-backlog section and verify item.triage is checked
  const untriagedSection = content.slice(content.indexOf('// 6. Machine-filed backlog items untriaged'), content.indexOf('// 7. No worker lease lost'));

  // Must have the item.triage check to properly identify untriaged vs refused items
  assert.ok(untriagedSection.includes('!item.triage') && untriagedSection.includes("item.triage.state === 'refused'"),
    'untriaged filter must check item.triage clause to distinguish refused items from untriaged ones');

  // Must use the clock correctly with ternary for refused items
  assert.ok(untriagedSection.includes("item.triage?.state === 'refused' ? item.triage.at : item.createdAt"),
    'triageSince clock must restart from refusal time for refused items');
});

test('manual:review-followups-triaged — GY-441 finding 2: soak.test.ts tests approver naming validation', () => {
  const soakPath = `${root}/tests/soak.test.ts`;
  const content = readFileSync(soakPath, 'utf8');

  // Verify imports checkInvariants and emptyInvariantRecord for testing
  assert.ok(content.includes('checkInvariants') && content.includes('emptyInvariantRecord'),
    'soak must import checkInvariants to test invariants');

  // Verify test case exists that validates approver session naming
  assert.ok(content.includes('an unwatched approver is known by the launcher'),
    'soak must have test validating approver naming validation');

  // Verify test uses approverSessionName with decision UUID
  assert.ok(content.includes('approverSessionName') && content.includes('decision'),
    'test must validate approver session name recognition');
});

test('manual:review-followups-triaged — GY-441 finding 3: invariants.ts has isApproverSessionName function', () => {
  const invariantsPath = `${root}/src/model/invariants.ts`;
  const content = readFileSync(invariantsPath, 'utf8');

  // Must have isApproverSessionName function (not just approverNameHeads)
  assert.ok(content.includes('function isApproverSessionName(key: string, name: string)'),
    'invariants must have isApproverSessionName function to validate complete approver session name');

  // Must NOT have the old approverNameHeads function
  assert.ok(!content.includes('const approverNameHeads ='),
    'old approverNameHeads must be replaced with isApproverSessionName');

  // Must handle both short keys with hex fragment and long keys with digest
  assert.ok(content.includes('hex(') && content.includes('sessionNameDistinguisher'),
    'approver name validation must verify hexadecimal decision fragment and handle long keys');
});

test('manual:review-followups-triaged — GY-441 finding 3b: isApproverSessionName used in lingering-sessions', () => {
  const invariantsPath = `${root}/src/model/invariants.ts`;
  const content = readFileSync(invariantsPath, 'utf8');

  // Verify lingering-sessions uses isApproverSessionName to identify unwatched approvers
  const lingeringSection = content.slice(content.indexOf('lingering-sessions'), content.indexOf("judge('lingering-sessions'"));

  assert.ok(lingeringSection.includes('isApproverSessionName(item.key'),
    'lingering-sessions must use isApproverSessionName to validate unwatched approver sessions');

  // Verify the old prefix-based approach is gone
  assert.ok(!lingeringSection.includes('approverNameHeads'),
    'old approverNameHeads prefix-based matching must be replaced with isApproverSessionName');

  // Verify it finds all items claiming the same name
  assert.ok(lingeringSection.includes('work.filter') && lingeringSection.includes('isApproverSessionName'),
    'must find all items that could claim an approver session name');
});
