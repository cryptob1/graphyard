import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { headlessArgv } from '../src/headless-session.js';
import { opencodeAuthList, opencodeModels } from '../src/master/runtimes.js';

// GY-3425: since GY-3414 every opencode worker and reviewer ran `opencode run … --standalone`, and
// an opencode that rejects the flag (here: one given it twice, or one that lacks it) printed its
// usage and exited at once. The launch now asks the installed opencode's `run --help` which of its
// optional flags it takes and passes each of those exactly once.
const scratch = await temporaryDirectory('opencode-run-flags');

/** A stand-in opencode like the real one: it exits 1 with its usage on a flag it does not take, or on a repeated one. */
async function opencode(name: string, standalone: boolean) {
  const bin = join(scratch, name);
  await mkdir(bin);
  await writeFile(join(bin, 'opencode'), `#!/bin/sh
usage() { echo 'USAGE'; echo '  opencode run [flags] [<message...>]'; echo 'GLOBAL FLAGS'; ${standalone ? `echo '  --standalone    Run with a private server instead of the background service';` : ''} }
for a in "$@"; do [ "$a" = --help ] && { usage; exit 0; }; done
seen=''
for a in "$@"; do
  case "$a" in
    --standalone) ${standalone ? `[ -n "$seen" ] && { usage; echo 'ERROR'; echo '  Invalid value for flag --standalone: "2 occurrences"'; exit 1; }; seen=1;;` : `usage; echo 'ERROR'; echo '  Unknown flag --standalone'; exit 1;;`}
  esac
done
case "$1" in
  run) echo '{"type":"step_start"}';;
  auth) echo "standalone=$seen Z.AI Coding Plan  API key";;
  models) echo "standalone=$seen zai-coding-plan/glm-5.3";;
esac
`, { mode: 0o755 });
  return bin;
}
const withStandalone = await opencode('with', true), without = await opencode('without', false);
const path = process.env.PATH;
after(() => { process.env.PATH = path; });
const on = (bin: string) => ({ ...process.env, PATH: `${bin}:${path}` });
const run = async (argv: string[], env: NodeJS.ProcessEnv) => (await promisify(execFile)(argv[0]!, argv.slice(1), { env })).stdout;

test('integration:opencode-run-flags — the headless opencode launch passes --standalone only where run --help lists it, once, and starts either way', async () => {
  // A profile that already names --standalone (the duplicate GY-3420's four attempts died on) is passed it once.
  for (const args of [[], ['--standalone']]) {
    const argv = await headlessArgv({ kind: 'opencode', args }, 'REQUEST', on(withStandalone));
    assert.deepEqual(argv.slice(1), ['run', '--format', 'json', '--standalone', 'REQUEST']);
    assert.match(await run(argv, on(withStandalone)), /step_start/);
    const plain = await headlessArgv({ kind: 'opencode', args }, 'REQUEST', on(without));
    assert.deepEqual(plain.slice(1), ['run', '--format', 'json', 'REQUEST'], 'an opencode without --standalone is never given it');
    assert.match(await run(plain, on(without)), /step_start/, 'and still starts');
  }
});

test('integration:opencode-run-flags — auth list and models probes work with and without --standalone support', async () => {
  const home = await temporaryDirectory('home', scratch);
  process.env.PATH = `${withStandalone}:${path}`;
  assert.match(await opencodeAuthList(home), /^standalone=1 Z\.AI/);
  assert.match(await opencodeModels(home), /^standalone=1 zai-coding-plan\/glm-5\.3/);
  process.env.PATH = `${without}:${path}`;
  assert.match(await opencodeAuthList(home), /^standalone= Z\.AI/);
  assert.match(await opencodeModels(home), /^standalone= zai-coding-plan\/glm-5\.3/);
});
