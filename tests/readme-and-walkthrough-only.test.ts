import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// GY-3109: one short README and one walkthrough video replace the documentation pages.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const video = 'docs/diagrams/how-graphyard-works.mp4', gif = 'docs/diagrams/how-graphyard-works.gif';

/** The movie's length in seconds, from the MP4's mvhd box. */
function mp4Seconds(bytes: Buffer) {
  const at = bytes.indexOf('mvhd');
  assert.ok(at > 0, 'the MP4 has a movie header');
  const v1 = bytes[at + 4] === 1;
  const scale = bytes.readUInt32BE(at + (v1 ? 24 : 16));
  const duration = v1 ? Number(bytes.readBigUInt64BE(at + 28)) : bytes.readUInt32BE(at + 20);
  return duration / scale;
}

test('unit:readme-and-walkthrough-only — docs/ holds only the walkthrough media, its re-render steps and the where-things-run diagram, README is one short page embedding them with setup steps, and the video shows the current roles and delivery flow', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'docs'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  assert.deepEqual(tracked, [gif, video, 'docs/diagrams/where-things-run.svg', 'docs/walkthrough.md']);

  const readme = read('README.md');
  assert.ok(readme.split(/\s+/).length < 600, `README is short: ${readme.split(/\s+/).length} words`);
  assert.ok(readme.includes(`](${gif})](${video})`), 'README embeds the walkthrough GIF linking to the MP4');
  const setup = readme.split('\n## Quick start\n')[1]?.split('\n## ')[0] ?? '';
  assert.match(setup, /graphyard up --repo OWNER\/NAME/);
  for (const help of ['graphyard guide TOPIC', 'graphyard master guide']) assert.ok(readme.includes(help), `README points at ${help}`);
  assert.deepEqual([...readme.matchAll(/\]\((docs\/[^)]*\.md)/g)].map(match => match[1]), ['docs/walkthrough.md'], 'README links only the walkthrough re-render page');

  const seconds = mp4Seconds(readFileSync(new URL(video, root)));
  assert.ok(seconds >= 60 && seconds <= 100, `the video runs ${seconds} s`);
  assert.equal(readFileSync(new URL(gif, root)).subarray(0, 6).toString(), 'GIF89a');

  const html = read('scripts/walkthrough/how-graphyard-works.html');
  const max = Number(html.match(/id="scrub"[^>]*max="(\d+)"/)?.[1]);
  assert.ok(Math.abs(max - seconds) < 1, `the rendered video is the walkthrough's ${max} s`);
  const chapters = html.match(/const chapters = (\[.*\]);/)?.[1] ?? '';
  for (const scene of ['Roles', 'Decide', 'Loop', 'Ready', 'Build', 'Review', 'Merge trial', 'Deploy', 'Revert', 'Failures', 'Where things run']) assert.ok(chapters.includes(`'${scene}'`), `a scene shows ${scene}`);
  const captions = html.slice(html.indexOf('const captions'), html.indexOf('const capEl')).toLowerCase();
  for (const said of ['the human keeps three decisions', 'the master (ai) decides', 'the loop (plain code)', 'a worker builds', 'independent review', 'trials the head on the latest main', 'deploys main', 'reverts the merge automatically', 'any failure goes to the master']) assert.ok(captions.includes(said), `the captions say: ${said}`);
});
