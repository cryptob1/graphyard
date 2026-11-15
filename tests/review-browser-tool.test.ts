import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

test('e2e:review-browser-tool — doctor names the missing review tool and its working install step', async () => {
  const root = await temporaryDirectory('review-browser-tool');
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Exercise the printed installation command without downloading a browser in the test.
  await writeFile(join(bin, 'npm'), `#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix="$2"; shift; done
mkdir -p "$prefix/node_modules/.bin"
printf '#!/bin/sh\\nexit 0\\n' > "$prefix/node_modules/.bin/agent-browser"
chmod 755 "$prefix/node_modules/.bin/agent-browser"
`, { mode: 0o755 });
  const env = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'),
    PATH: [bin, ...(process.env.PATH ?? '').split(delimiter).filter(path => path && !existsSync(join(path, 'agent-browser')))].join(delimiter) };
  for (const key of Object.keys(env)) if (key.startsWith('GRAPHYARD_')) delete env[key as keyof typeof env];
  Object.assign(env, { GRAPHYARD_URL: 'http://127.0.0.1:9' });
  await exec('git', ['init', '-q', '--initial-branch=main'], { cwd: root, env });
  await exec('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root, env });
  const doctor = async () => JSON.parse((await exec(process.execPath, [launcher, 'doctor'], { cwd: root, env })).stdout);
  const before = await doctor();
  const lines = before.setupFromZero.lines.filter((line: string) => /^(PASS|FAIL) agent-browser:/.test(line));
  assert.equal(lines.length, 1, 'doctor prints exactly one browser check');
  assert.match(lines[0], /^FAIL agent-browser:.*product review PATH.*fix: npm install/);
  assert.ok(lines[0].includes(before.browserTool.install), 'the FAIL line names the executable install step');
  await exec('sh', ['-c', before.browserTool.install], { cwd: root, env });
  const after = await doctor();
  assert.deepEqual(after.setupFromZero.lines.filter((line: string) => /^(PASS|FAIL) agent-browser:/.test(line)),
    [`PASS agent-browser: product reviews use ${join(env.XDG_DATA_HOME, 'graphyard/tools/node_modules/.bin/agent-browser')}`]);
  assert.equal(after.browserTool.present, true);
});
