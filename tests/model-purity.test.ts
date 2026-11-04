import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { evaluate } from '../src/model/gates.js';
import { currentEvidence } from '../src/model/evidence.js';
import { unexercisedFindings } from '../src/model/mechanical-proofs.js';
import type { Work, Evidence } from '../src/model.js';

const root = fileURLToPath(new URL('../src/model/', import.meta.url));

test('unit:model-purity — model runtime dependencies stay inside the model and clocks are explicit', async () => {
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const path = resolve(root, file), source = await readFile(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const checkImport = (specifier: string) => {
      // Schema validation and deterministic hashing are the model's library primitives.
      if (specifier === 'zod' || specifier === 'node:crypto') return;
      assert.ok(specifier.startsWith('.'), `${file}: unexpected runtime dependency ${specifier}`);
      const target = relative(root, resolve(dirname(path), specifier));
      assert.ok(!target.startsWith('..'), `${file}: runtime dependency leaves the model: ${specifier}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const onlyTypes = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(entry => entry.isTypeOnly));
        if (!onlyTypes) checkImport(node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(entry => !entry.isTypeOnly)) checkImport(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require') {
          assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), `${file}: runtime dependency must be statically known`);
          checkImport((node.arguments[0] as ts.StringLiteral).text);
        }
        assert.notEqual(node.expression.getText(ast), 'Date.now', `${file}: use the caller's clock`);
      }
      if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Date') assert.ok(node.arguments?.length, `${file}: use the caller's clock`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test('unit:model-purity — gates and unexercised findings judge evidence expiry at the supplied instant a day ahead', () => {
  const now = new Date(), tomorrow = new Date(now.getTime() + 86_400_000);
  const candidate = { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 1, branch: 'graphyard/test', author: 'worker' };
  const proof = 'unit:model-purity';
  const evidence = {
    id: 'evidence', proof, producer: 'independent-producer', trusted: true,
    sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1,
    result: 'fail', executed: 1, skipped: 0, at: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  } as Evidence;
  const work = {
    id: 'item', key: 'GY-1', type: 'chore', stage: 'build', ready: true,
    dependencies: [], workspaces: [{ epoch: 1 }], submission: { epoch: 1, pr: 1 },
    candidate, observation: { candidate, reviews: [], files: [] },
    policy: { review: false, checks: [] }, policyRevision: 1,
    criteria: [{ id: 'AC-1', text: 'Clock consistency', proofs: [proof] }],
    evidence: [evidence], scenarioRequirements: [], violations: [], implementers: [],
  } as unknown as Work;
  const build = (at: Date) => evaluate(work, [work], at).gates.find(gate => gate.name === 'build')!;
  assert.equal(build(now).passed, false, 'a current failing proof refuses the build');
  assert.match(build(now).reasons.join('; '), /unit:model-purity/);
  assert.equal(build(tomorrow).passed, true, 'an expired failure no longer refuses the build');
  assert.equal(currentEvidence(work, proof, tomorrow), undefined);

  work.evidence = [{ ...evidence, id: 'unexercised', unexercised: 'mutation survived' }, { ...evidence, id: 'pass', result: 'pass' }];
  assert.equal(unexercisedFindings(work, now).length, 0, 'a current pass answers the finding');
  assert.equal(unexercisedFindings(work, tomorrow).length, 1, 'an expired pass cannot hide the finding');
});
