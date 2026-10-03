import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const reportUrl = new URL('../research/rooflow-lessons.md', import.meta.url);

test('unit:rooflow-lessons-report — research report exists, includes the five required sections, and contains ranked lessons citing RooFlow file paths', async () => {
  // 1. Assert the report file exists and is readable
  await assert.doesNotReject(
    () => access(reportUrl, constants.R_OK),
    'research/rooflow-lessons.md must exist and be readable'
  );

  const content = await readFile(reportUrl, 'utf8');

  // 2. Assert the report holds the five section headings
  const section1 = /##\s*1\.\s*What RooFlow Is/i;
  const section2 = /##\s*2\.\s*What (?:it|RooFlow) Does Well That Graphyard Does Not/i;
  const section3 = /##\s*3\.\s*What Graphyard Already Does Better/i;
  const section4 = /##\s*4\.\s*Ranked Lessons/i;
  const section5 = /##\s*5\.\s*Ready-to-File (?:Graphyard )?Work Items/i;

  assert.match(content, section1, 'Report must contain Section 1 heading (What RooFlow Is)');
  assert.match(content, section2, 'Report must contain Section 2 heading (What RooFlow Does Well That Graphyard Does Not)');
  assert.match(content, section3, 'Report must contain Section 3 heading (What Graphyard Already Does Better)');
  assert.match(content, section4, 'Report must contain Section 4 heading (Ranked Lessons)');
  assert.match(content, section5, 'Report must contain Section 5 heading (Ready-to-File Work Items)');

  // 3. Assert Section 4 contains at least three lessons citing a RooFlow file path
  const section4Start = content.search(section4);
  const section5Start = content.search(section5);
  assert.ok(section4Start !== -1, 'Section 4 start index must be found');
  assert.ok(section5Start > section4Start, 'Section 5 must follow Section 4');

  const section4Content = content.slice(section4Start, section5Start);

  // Split lessons in Section 4 by "### Lesson"
  const lessonBlocks = section4Content.split(/###\s*Lesson/i).slice(1);
  assert.ok(lessonBlocks.length >= 3, `Section 4 must contain at least 3 lessons (found ${lessonBlocks.length})`);
  assert.ok(lessonBlocks.length <= 8, `Section 4 must contain at most 8 lessons (found ${lessonBlocks.length})`);

  // Count lessons that cite a RooFlow file path (e.g. config/, modules/, README.md, memory-bank/)
  const rooflowPathRegex = /(?:config\/\S+|modules\/\S+|README\.md|CONTRIBUTING\.md|memory-bank\/\S+)/;
  const lessonsWithCitation = lessonBlocks.filter(block => rooflowPathRegex.test(block));

  assert.ok(
    lessonsWithCitation.length >= 3,
    `At least three lessons must cite a RooFlow file path (found ${lessonsWithCitation.length})`
  );

  // 4. Assert Section 5 contains 3 ready-to-file work items each with description and acceptance criteria
  const section5Content = content.slice(section5Start);
  const workItemBlocks = section5Content.split(/###\s*Work Item/i).slice(1);
  assert.equal(workItemBlocks.length, 3, `Section 5 must contain exactly 3 ready-to-file work items (found ${workItemBlocks.length})`);

  for (let i = 0; i < workItemBlocks.length; i++) {
    const item = workItemBlocks[i];
    assert.match(item, /Description/i, `Work Item ${i + 1} must include a description`);
    assert.match(item, /Acceptance Criteria/i, `Work Item ${i + 1} must include acceptance criteria`);
    assert.match(item, /AC-1/i, `Work Item ${i + 1} must define AC-1`);
    assert.match(item, /AC-2/i, `Work Item ${i + 1} must define AC-2`);
  }
});
