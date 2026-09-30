import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reportFiles } from '../src/runner-executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url);
const dockerfile = await readFile(new URL('docker/runner/Dockerfile', root), 'utf8');
const entrypoint = new URL('docker/runner/entrypoint.sh', root).pathname;

/**
 * The image is what turns `docker run REPOSITORY@sha256:... enumerate|execute` into an
 * inventory and a report. Building it needs a Docker daemon, which these tests do not
 * assume, so the phase contract is exercised directly: the entrypoint is a POSIX shell
 * script, and a stub `node` on PATH records the Playwright invocation it would make.
 */
async function phase(argv: string[], env: Record<string, string>, oracle: string) {
  const bin = await temporaryDirectory('image-bin');
  const log = join(bin, 'argv.json');
  await writeFile(join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`);
  await chmod(join(bin, 'node'), 0o755);
  try {
    const result = await exec('sh', [entrypoint, ...argv, oracle], { env: { PATH: `${bin}:${process.env.PATH}`, ...env } })
      .then(() => ({ code: 0, stderr: '' }), (error: any) => ({ code: error.code as number, stderr: String(error.stderr) }));
    const invoked = await readFile(log, 'utf8').then(text => text.trimEnd().split('\n'), () => null);
    return { ...result, invoked };
  } finally { await rm(bin, { recursive: true, force: true }); }
}

async function bundle(configName = 'playwright.config.ts') {
  const dir = await temporaryDirectory('image-oracle');
  await writeFile(join(dir, configName), 'export default { testDir: "." };');
  return dir;
}

test('the image entrypoint enumerates offline and executes against the approved target', async () => {
  const oracle = await bundle(), output = await temporaryDirectory('image-out');
  try {
    // Enumeration must not be able to see the target, so it is `--list` and carries no
    // target URL at all: the approved inventory cannot be shaped by the deployment.
    const listed = await phase(['enumerate'], { GRAPHYARD_REPORT_FILE: join(output, reportFiles.enumerate) }, oracle);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(listed.invoked?.slice(1), ['test', '--config', join(oracle, 'playwright.config.ts'),
      '--reporter', '/opt/graphyard-runner/reporter.ts', '--list']);

    // Execution runs the same approved suite with the same built-in reporter.
    const ran = await phase(['execute'], { GRAPHYARD_REPORT_FILE: join(output, reportFiles.execute), GRAPHYARD_TARGET_URL: 'https://preview.example.test/' }, oracle);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(ran.invoked?.slice(1), ['test', '--config', join(oracle, 'playwright.config.ts'),
      '--reporter', '/opt/graphyard-runner/reporter.ts']);

    // The reporter is the image's own file, never a path the bundle or the runner chooses.
    assert.ok(ran.invoked?.includes('/opt/graphyard-runner/reporter.ts'));
  } finally { await rm(oracle, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('the image entrypoint refuses a phase it cannot honestly complete', async () => {
  const oracle = await bundle(), output = await temporaryDirectory('image-out');
  const report = join(output, reportFiles.execute);
  try {
    const target = { GRAPHYARD_TARGET_URL: 'https://preview.example.test/' };
    // An unknown phase, a missing report destination and a bundle with no Playwright
    // configuration each refuse before starting a browser rather than writing something
    // the collector would have to interpret.
    for (const [argv, env, pattern] of [
      [['settle'], { GRAPHYARD_REPORT_FILE: report, ...target }, /Unknown attempt phase/],
      [['execute'], { ...target }, /GRAPHYARD_REPORT_FILE/],
      [['execute'], { GRAPHYARD_REPORT_FILE: report }, /GRAPHYARD_TARGET_URL/],
      [['enumerate', 'execute'], { GRAPHYARD_REPORT_FILE: report }, /usage/],
    ] as [string[], Record<string, string>, RegExp][]) {
      const refused = await phase(argv, env, oracle);
      assert.equal(refused.code, 64, JSON.stringify(argv));
      assert.match(refused.stderr, pattern);
      assert.equal(refused.invoked, null, 'a refused phase starts no Playwright run');
    }

    const empty = await temporaryDirectory('image-empty');
    const unconfigured = await phase(['execute'], { GRAPHYARD_REPORT_FILE: report, ...target }, empty);
    assert.equal(unconfigured.code, 64);
    assert.match(unconfigured.stderr, /Playwright configuration/);
    await rm(empty, { recursive: true, force: true });

    // Each phase writes its report once, into a boundary that was empty at preflight. A
    // second invocation must not be able to replace bytes the attestor is about to measure.
    await writeFile(report, '{}');
    const rerun = await phase(['execute'], { GRAPHYARD_REPORT_FILE: report, ...target }, oracle);
    assert.equal(rerun.code, 64);
    assert.match(rerun.stderr, /already holds this phase report/);
  } finally { await rm(oracle, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); }
});

test('the runner image pins the reviewed Playwright release and carries the approved reporter', async () => {
  const pinned = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).devDependencies['@playwright/test'].replace(/^[^0-9]*/, '');
  // The base image ships the browser builds one Playwright release expects, so the tag
  // and the installed package have to name the same version.
  assert.match(dockerfile, new RegExp(`ARG PLAYWRIGHT_VERSION=${pinned.replace(/\./g, '\\.')}\\b`),
    `docker/runner/Dockerfile must pin the ${pinned} Playwright release this repository reviewed`);
  assert.match(dockerfile, /FROM mcr\.microsoft\.com\/playwright:v\$\{PLAYWRIGHT_VERSION\}/);
  assert.match(dockerfile, /@playwright\/test@\$\{PLAYWRIGHT_VERSION\}/);
  // The reporter is built into the image, and module resolution for the mounted bundle is
  // provided by the image rather than by NODE_PATH, which the container boundary refuses.
  assert.match(dockerfile, /COPY src\/playwright-reporter\.ts \.\/reporter\.ts/);
  assert.match(dockerfile, /ln -s \/opt\/graphyard-runner\/node_modules \/node_modules/);
  // No USER: the attestor supplies `--user`, and the deployment's container account does
  // not exist in the image.
  assert.doesNotMatch(dockerfile, /^USER /m);
  // The container writes through the boundary group, so its report must not be private.
  assert.match(await readFile(entrypoint, 'utf8'), /^umask 027$/m);
});
