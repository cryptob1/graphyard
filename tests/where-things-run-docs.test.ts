import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { guideText } from '../src/guide.js';
import { encodeLoopWhere, loopWhere, loopWhereRegistry, whereLogs, type WhereThingsRun } from '../src/model/where-things-run.js';
import { composeContainer, loopWhereReport } from '../src/master/where.js';
import { WhereThingsRunPanel } from '../web/pages/setup.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3277: the docs, the walkthrough video and the Setup page show where every part of Graphyard
// runs — one diagram embedded in the README and the dashboard Guide, one README section and guide
// topic `infra` carrying its every unit, container, port and log command, and the Setup page's
// panel naming this install's own values as its loop reports them.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Every unit, container, port and log command the diagram carries: what the README section and `guide infra` must each list. */
const diagramFacts = [
  'graphyard-master-OWNER-NAME.service',
  'journalctl --user -u graphyard-master-OWNER-NAME.service',
  'graphyard-deploy-OWNER-NAME.service',
  'journalctl --user -u graphyard-deploy-OWNER-NAME.service',
  'graphyard-OWNER-NAME-server-1',
  'docker logs graphyard-OWNER-NAME-server-1',
  'graphyard-OWNER-NAME-db-1',
  'docker logs graphyard-OWNER-NAME-db-1',
  '4310',
  'graphyard-trial-',
  '~/.config/graphyard/<install>/',
];

test('unit:tests/where-things-run-docs.test.ts — the README\'s Where things run section embeds the diagram and lists every unit, container, port and log command it carries', () => {
  const readme = read('README.md');
  const section = readme.split('\n## Where things run\n')[1]?.split('\n## ')[0] ?? '';
  assert.ok(section, 'README carries a Where things run section');
  assert.ok(section.includes('](docs/diagrams/where-things-run.svg)'), 'the section embeds the diagram');
  for (const fact of diagramFacts) assert.ok(section.includes(fact), `the README section lists ${fact}`);
});

test('unit:tests/where-things-run-docs.test.ts — guide infra prints the same facts as a table of part, runs-as, port and log commands', () => {
  const infra = guideText('infra');
  for (const word of ['| Part | Runs as | Where | Port | Logs |', 'OWNER-NAME', '--provider local', 'GitHub Actions']) assert.ok(infra.includes(word), `guide infra carries ${word}`);
  for (const fact of diagramFacts) assert.ok(infra.includes(fact), `guide infra lists ${fact}`);
  const printed = execFileSync('node', ['--import', 'tsx', 'src/cli.ts', 'guide', 'infra'], { cwd: root, encoding: 'utf8' });
  assert.equal(printed.trim(), infra.trim(), 'graphyard guide infra prints the topic');
});

test('unit:tests/where-things-run-docs.test.ts — the diagram SVG exists, names the same units and containers, and the dashboard Guide embeds it beside the README', () => {
  const svg = read('docs/diagrams/where-things-run.svg');
  assert.ok(svg.startsWith('<svg'), 'the diagram is an SVG');
  for (const fact of ['graphyard-master-OWNER-NAME.service', 'graphyard-deploy-OWNER-NAME.service', 'graphyard-OWNER-NAME-server-1', 'graphyard-OWNER-NAME-db-1', 'graphyard-trial-', '4310', 'YOUR HOST', 'DOCKER', 'GitHub', 'Agent providers', 'npm + GHCR', 'Your browser', 'Herdr'])
    assert.ok(svg.includes(fact), `the diagram names ${fact}`);
  const guidePage = read('web/pages/guide.tsx');
  assert.ok(guidePage.includes('docs/diagrams/where-things-run.svg'), 'the dashboard Guide bundles the diagram');
  assert.ok(guidePage.includes('guide-diagram'), 'the Guide renders the README\'s diagram through its bundled copy');
});

test('unit:tests/where-things-run-docs.test.ts — the loop reports its install\'s units, containers, port, directories and CLI, and the header carries them to the control plane', async () => {
  const home = await temporaryDirectory('where-things-run');
  const checkout = join(home, 'checkout');
  mkdirSync(join(checkout, '.graphyard'), { recursive: true });
  writeFileSync(join(checkout, '.graphyard', 'units.json'), JSON.stringify({ version: 1, slug: 'fixture-shop', master: 'graphyard-master-fixture-shop.service', executorTemplate: 'graphyard-executor-fixture-shop@.service', alias: false }));
  const configHome = join(home, 'config');
  const install = join(configHome, 'fixture-shop');
  mkdirSync(install, { recursive: true });
  const at = '2030-04-01T00:00:00.000Z';
  const master = { repository: 'fixture/shop', url: 'http://127.0.0.1:4310', cliPath: join(install, 'deploy/build/.graphyard/cli-releases/abc/bin/graphyard.mjs') };
  writeFileSync(join(install, 'install.json'), JSON.stringify({ version: 1, installId: 'fixture-shop', repository: 'fixture/shop', provider: 'compose', baseBranch: 'main', createdAt: at, updatedAt: at }));

  const where = await loopWhereReport(checkout, master, configHome);
  assert.deepEqual(where, {
    loopUnit: 'graphyard-master-fixture-shop.service', deployUnit: 'graphyard-deploy-fixture-shop.service',
    server: composeContainer('fixture-shop', 'server'), database: composeContainer('fixture-shop', 'db'),
    port: 4310, url: master.url, checkout, installDirectory: install, cliPath: master.cliPath,
  } satisfies WhereThingsRun);
  assert.equal(where!.server, 'graphyard-fixture-shop-server-1');
  assert.equal(where!.database, 'graphyard-fixture-shop-db-1');

  // The header round-trips exactly what the loop gathered, and refuses anything that is not one report.
  assert.deepEqual(loopWhere(encodeLoopWhere(where!)), where);
  for (const broken of ['off', '{}', encodeURIComponent(JSON.stringify({ ...where, loopUnit: '' })), 'not-json']) assert.equal(loopWhere(broken), null, `a read naming ${broken.slice(0, 20)} carries no report`);
  const registry = loopWhereRegistry({});
  registry.observe(loopWhere('off'));
  assert.equal(registry.latest, null);
  registry.observe(where);
  assert.deepEqual(registry.latest, where);

  // A local install runs its server under its own unit on an embedded cluster, in the same report.
  writeFileSync(join(install, 'install.json'), JSON.stringify({ version: 1, installId: 'fixture-shop', repository: 'fixture/shop', provider: 'local', baseBranch: 'main', createdAt: at, updatedAt: at }));
  const local = await loopWhereReport(checkout, master, configHome);
  assert.equal(local!.server, 'graphyard-local-fixture-shop.service');
  assert.match(local!.database, /^embedded Postgres \(/);
  // An install whose records do not name its parts reports nothing rather than guess.
  writeFileSync(join(install, 'install.json'), 'not json');
  assert.equal(await loopWhereReport(checkout, master, configHome), null);

  assert.equal(whereLogs('graphyard-master-fixture-shop.service'), 'journalctl --user -u graphyard-master-fixture-shop.service');
  assert.equal(whereLogs('graphyard-fixture-shop-server-1'), 'docker logs graphyard-fixture-shop-server-1');
});

test('unit:tests/where-things-run-docs.test.ts — the Setup panel names this install\'s units, containers, port, URL, directories and master pane, and says so while the loop has not reported', () => {
  const where: WhereThingsRun = {
    loopUnit: 'graphyard-master-fixture-shop.service', deployUnit: 'graphyard-deploy-fixture-shop.service',
    server: 'graphyard-fixture-shop-server-1', database: 'graphyard-fixture-shop-db-1',
    port: 4310, url: 'http://127.0.0.1:4310', checkout: '/home/op/fixture-shop', installDirectory: '/home/op/.config/graphyard/fixture-shop',
    cliPath: '/home/op/.config/graphyard/fixture-shop/deploy/build/.graphyard/cli-releases/abc/bin/graphyard.mjs',
  };
  const status = { setup: { where, panes: { configHome: '/home/op/.config/herdr', session: 'graphyard-master-fixture-shop', host: 'host-a', running: true, master: '3' } } };
  const html = renderToStaticMarkup(createElement(WhereThingsRunPanel, { where: status.setup.where, panes: status.setup.panes }));
  for (const shown of [
    'graphyard-master-fixture-shop.service', 'graphyard-deploy-fixture-shop.service',
    'graphyard-fixture-shop-server-1', 'docker logs graphyard-fixture-shop-server-1',
    'graphyard-fixture-shop-db-1', 'docker logs graphyard-fixture-shop-db-1',
    'http://127.0.0.1:4310', '4310', '/home/op/fixture-shop', '/home/op/.config/graphyard/fixture-shop',
    'graphyard-master-fixture-shop', 'master pane 3', 'journalctl --user -u graphyard-master-fixture-shop.service',
  ]) assert.ok(html.includes(shown), `the panel shows ${shown}`);
  const unknown = renderToStaticMarkup(createElement(WhereThingsRunPanel, { where: null, panes: null }));
  assert.match(unknown, /not known yet/, 'with no report the panel says so instead of guessing');
});
