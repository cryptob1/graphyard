import type { FleetRoleName, FleetRuntime } from './registry.js';

/**
 * The launch contracts setup proposes for the agent CLIs Graphyard knows how to start unattended.
 * They are proposals only: a registry stores its own copy, an operator edits it there, and a
 * runtime added later needs no entry here. Approval flags themselves stay with the harness
 * (src/harness.ts); `args` holds what a runtime needs beyond them.
 */
export const proposedRuntimes: readonly FleetRuntime[] = [
  { name: 'claude', description: 'Claude Code', launch: { kind: 'claude', args: [], environment: {}, homeVariable: 'CLAUDE_CONFIG_DIR', modelFlag: '--model', login: 'CLAUDE_CONFIG_DIR={home} claude, then /login', loginFile: '.credentials.json' } },
  { name: 'codex', description: 'OpenAI Codex CLI', launch: { kind: 'codex', args: [], environment: {}, homeVariable: 'CODEX_HOME', modelFlag: '--model', login: 'CODEX_HOME={home} codex login', loginFile: 'auth.json' } },
  { name: 'cursor', description: 'Cursor agent CLI', launch: { kind: 'cursor', args: [], environment: {}, homeVariable: 'CURSOR_CONFIG_DIR', modelFlag: '--model', login: 'CURSOR_CONFIG_DIR={home} cursor-agent login', loginFile: 'cli-config.json' } },
  { name: 'opencode', description: 'OpenCode', launch: { kind: 'opencode', args: [], environment: {}, homeVariable: 'XDG_DATA_HOME', modelFlag: '--model', login: 'XDG_DATA_HOME={home} opencode auth login', loginFile: 'opencode/auth.json' } },
  { name: 'muse', description: 'Muse', launch: { kind: 'muse', args: ['--approval-mode', 'never', '--trust-workspace'], environment: {}, homeVariable: null, modelFlag: null, login: 'muse login', loginFile: null } },
];

/** Default concurrency a proposal gives each role; an operator changes it in the registry. */
export const proposedConcurrency: Record<FleetRoleName, number> = { worker: 4, reviewer: 2, producer: 3, approver: 1, 'escalation-handler': 1 };
