import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { loadCases, scenarioDefinition } from '../src/e2e/case.js';
import { recordRuns, runCases, summarize } from '../src/e2e/runner.js';
import { openPreview } from '../src/merge-writer/preview.js';
import { applicationSchema } from '../src/model-boundary/project-applications.js';
import type { Application } from '../src/model/project-applications.js';
// @ts-expect-error the scripts are plain ESM without declarations
import { deliveryFixture } from '../scripts/e2e-delivery-fixture.mjs';

// GY-3223: an application declares the path it answers its served commit at (`versionPath`), and an
// e2e run against it reads the commit there before /healthz.

const sha = 'ab'.repeat(20), healthSha = 'cd'.repeat(20);
const answer = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
/** The commit a run with no cases reports, the target answering `version` at /api/meta/version and `health` at /healthz; `asked` lists the paths read, in order. */
async function served(version: unknown, health: unknown = {}, versionPath: string | null = '/api/meta/version') {
  const asked: string[] = [];
  const fetcher = (async (input: URL) => {
    asked.push(input.pathname);
    const body = input.pathname === '/healthz' ? health : version;
    if (body === undefined) throw new Error('unreachable');
    return answer(body);
  }) as unknown as typeof fetch;
  const report = await runCases([], { url: 'http://app.invalid:4000/some/page', token: 't', environment: 'uat', fetcher, versionPath: versionPath ?? undefined });
  return { sha: report.sha, asked, line: summarize(report).split('\n')[0] };
}

test('unit:tests/e2e-app-version-path.test.ts — a run reads the served commit from the declared path: each JSON field, or plain text', async () => {
  for (const field of ['commit', 'revision', 'sha', 'version']) {
    const read = await served({ [field]: sha.toUpperCase() }, { commit: healthSha });
    assert.equal(read.sha, sha, field);
    assert.deepEqual(read.asked, ['/api/meta/version'], 'the path is resolved against the origin, and /healthz is not asked');
    assert.match(read.line, new RegExp(`serving ${sha}\\)$`));
  }
  assert.equal((await served(`${sha}\n`)).sha, sha, 'plain text');
  assert.equal((await served('1'.repeat(40))).sha, '1'.repeat(40), 'plain text of digits only');
});

test('unit:tests/e2e-app-version-path.test.ts — a short, invalid or unreachable answer falls back to /healthz, then to an unreported commit', async () => {
  for (const version of [{ version: sha.slice(0, 12) }, sha.slice(0, 12), { version: 'v1.4.2' }, '<html>', undefined]) {
    const read = await served(version, { commit: healthSha });
    assert.equal(read.sha, healthSha, JSON.stringify(version));
    assert.deepEqual(read.asked, ['/api/meta/version', '/healthz']);
  }
  const none = await served({ version: sha.slice(0, 12) }, '<html>');
  assert.equal(none.sha, null);
  assert.match(none.line, /serving an unreported commit\)$/);
  // With no versionPath only /healthz is read, as before: `sha` and `version` are not commit fields there.
  const undeclared = await served({ version: sha }, { version: sha, sha }, null);
  assert.equal(undeclared.sha, null);
  assert.deepEqual(undeclared.asked, ['/healthz']);
});

test('unit:tests/e2e-app-version-path.test.ts — static, compose and node applications may declare a versionPath: a path from /, without a query', () => {
  const kinds = [{ id: 'site', kind: 'static', directory: 'public' }, { id: 'app', kind: 'compose', file: 'compose.yml', service: 'web', port: 8080 }, { id: 'web', kind: 'node', directory: 'web', start: 'node server.mjs' }];
  for (const application of kinds) {
    assert.equal(applicationSchema.parse({ ...application, versionPath: '/api/meta/version' }).versionPath, '/api/meta/version');
    assert.equal(applicationSchema.parse(application).versionPath, undefined);
    for (const versionPath of ['api/meta/version', 'https://app.example/version', '//other.example/version', '/version?full=1', '/ver sion', ''])
      assert.equal(applicationSchema.safeParse({ ...application, versionPath }).success, false, `${application.kind} ${JSON.stringify(versionPath)}`);
  }
});

test('e2e:e2e-app-version-path — a preview of the fixture\'s node application reports the commit its versionPath answers; without the declaration, an unreported commit', { timeout: 300_000 }, async () => {
  const directory = await realpath(await temporaryDirectory('app-version-path'));
  const { root } = await deliveryFixture(directory);
  const mergeSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const declared: Application = applicationSchema.parse(JSON.parse(readFileSync(join(root, 'graphyard.json'), 'utf8')).delivery.applications.find((application: Application) => application.id === 'web'));
  assert.equal(declared.versionPath, '/api/meta/version');
  const { versionPath: _, ...rest } = declared;
  const undeclared: Application = rest;
  const cases = (await loadCases(root)).filter(entry => entry.definition.id === 'fixture-node-home');
  const base = join(directory, 'previews');
  await mkdir(base);
  for (const [application, serving] of [[declared, mergeSha], [undeclared, null]] as const) {
    const opened = await openPreview({ root, base, mergeSha, application, timeoutMs: 240_000 },
      { keep: true, cases: ['fixture-node-home'], variables: { GRAPHYARD_PREVIEW_TITLE: 'Version path', GRAPHYARD_PREVIEW_SHA: mergeSha } });
    try {
      // The preview's own run of the bound case: its detail is what the item's preview shows.
      assert.equal(opened.verdict.result, 'pass', opened.verdict.detail);
      assert.match(opened.verdict.detail, new RegExp(`serving ${serving ?? 'an unreported commit'}$`));
      // The app's /healthz names no commit either way: only the declared path tells them apart.
      assert.equal((await fetch(new URL('/healthz', opened.url!))).headers.get('content-type'), 'text/html; charset=utf-8');
      // A run of the bound case against the served preview: its report line, and the run it records.
      const report = await runCases(cases, { url: opened.url!, token: 'preview', environment: 'local', root, withholdSecrets: true, versionPath: application.versionPath });
      assert.equal(report.passed, 1, summarize(report));
      assert.match(summarize(report).split('\n')[0], new RegExp(`serving ${serving ?? 'an unreported commit'}\\)$`));
      const recorded: { sha: string | null }[] = [];
      await recordRuns((async (path: string, body?: { sha: string | null }) => {
        if (path === 'scenarios') return [{ ...scenarioDefinition(cases[0]!), revision: 1 }];
        recorded.push(body!);
        return { id: 'run' };
      }) as never, cases, report);
      assert.deepEqual(recorded.map(run => run.sha), [serving]);
    } finally { await opened.close(); }
  }
});
