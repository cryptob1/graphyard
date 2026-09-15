import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult, TestStep } from '@playwright/test/reporter';

const identifier = (test: TestCase) => createHash('sha256').update(test.id).digest('hex');
/** Built into the independently approved oracle image, never loaded from candidate code. */
export default class GraphyardReporter implements Reporter {
  private declared: { id: string; expected: TestCase['expectedStatus'] }[] = [];
  private executions: { id: string; status: TestResult['status']; retry: number }[] = [];
  private steps: { test: string; sequence: number; durationMs: number; failed: boolean }[] = [];
  private errors = 0;
  private overflow = false;
  printsToStdio() { return true; }
  onBegin(_config: FullConfig, suite: Suite) {
    this.declared = suite.allTests().map(test => ({ id: identifier(test), expected: test.expectedStatus })).sort((a,b) => a.id.localeCompare(b.id));
    if (this.declared.length > 10_000) { this.declared = this.declared.slice(0, 10_000); this.overflow = true; }
  }
  onTestEnd(test: TestCase, result: TestResult) {
    if (this.executions.length >= 10_000) { this.overflow = true; return; }
    this.executions.push({ id: identifier(test), status: result.status, retry: result.retry });
  }
  onStepEnd(test: TestCase, _result: TestResult, step: TestStep) {
    if (this.steps.length >= 10_000) { this.overflow = true; return; }
    // Do not capture titles, arguments, URLs, bodies, error text, attachments or stdio.
    // Playwright step titles can include secrets from the application under test.
    this.steps.push({ test: identifier(test), sequence: this.steps.length + 1, durationMs: step.duration, failed: !!step.error });
  }
  onError() { this.errors++; }
  onEnd(result: FullResult) {
    const path = process.env.GRAPHYARD_REPORT_FILE;
    if (!path) throw new Error('Graphyard reporter output was not configured');
    writeFileSync(path, JSON.stringify({ format: 'graphyard-playwright-v1', declared: this.declared, executions: this.executions, steps: this.steps, errors: this.errors, overflow: this.overflow, status: result.status }), { flag: 'wx', mode: 0o600 });
  }
}
