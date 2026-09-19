import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CommandResult { stdout: string; stderr: string; code: number }
export interface RunOptions { input?: string; cwd?: string; timeout?: number; allowFailure?: boolean }

/**
 * A failed provider command names its cause. `railway exited with 1` alone sent a live install
 * to the provider's documentation; with the CLI's own diagnostic behind it (`--workspace
 * required in non-interactive mode`) the runbook's failure table can act on it. Only the tail
 * is kept, and the installer scrubs the message before it is shown, like every other line.
 */
export function commandFailure(program: string, result: CommandResult) {
  const diagnostic = (result.stderr.trim() || result.stdout.trim()).split('\n').filter(Boolean).slice(-8).join('\n').slice(-2000);
  return new Error(`${program} exited with ${result.code}${diagnostic ? `: ${diagnostic}` : ''}`);
}

/**
 * One command surface for every adapter. Provider CLIs, SSH hosts, and the CI fakes all
 * implement it, which is what makes `--apply` executable in tests without a real account.
 */
export interface Transport {
  readonly description: string;
  exec(program: string, args: string[], options?: RunOptions): Promise<CommandResult>;
  putFile(path: string, content: string, mode: number): Promise<void>;
}

function local(program: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((accept, reject) => {
    const child = execFile(program, args, { encoding: 'utf8', cwd: options.cwd, timeout: options.timeout ?? 600_000, maxBuffer: 8_000_000, windowsHide: true }, (error: any, stdout, stderr) => {
      if (!error) return accept({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      const result = { stdout: String(stdout ?? ''), stderr: String(stderr ?? error.message ?? ''), code: Number.isInteger(error.code) ? error.code : 1 };
      if (options.allowFailure) accept(result); else reject(commandFailure(program, result));
    });
    if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
  });
}

export function localTransport(): Transport {
  return {
    description: 'this machine',
    exec: local,
    async putFile(path, content, mode) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { mode }); },
  };
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Batch mode only: the installer never prompts for an SSH password inside an agent session. */
export function sshTransport(host: string, user = 'root', base: Transport = localTransport()): Transport {
  const target = `${user}@${host}`;
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', target, '--'];
  // ssh joins the remaining arguments into one remote shell command, so every word is
  // quoted here; otherwise a path or value containing a space would be re-split remotely.
  return {
    description: target,
    exec: (program, args, options = {}) => base.exec('ssh', [...sshArgs, ...[program, ...args].map(shellQuote)], options),
    async putFile(path, content, mode) {
      await base.exec('ssh', [...sshArgs, 'sh', '-c', shellQuote(`mkdir -p ${shellQuote(dirname(path))} && umask 077 && cat > ${shellQuote(path)} && chmod ${mode.toString(8).padStart(4, '0')} ${shellQuote(path)}`)], { input: content });
    },
  };
}

export interface RecordedCommand { program: string; args: string[]; input?: string }
export interface FakeTransportOptions {
  /** First match wins; a response is stdout, a full result, or a thunk for stateful fakes. */
  responses?: { match: string; result: string | CommandResult | (() => string | CommandResult) }[];
  files?: Map<string, { content: string; mode: number }>;
}

/**
 * The CI transport. It records every command and file so adapter tests can assert exact
 * provisioning order, idempotency on a second run, and that no argument carries a secret.
 */
export function fakeTransport(options: FakeTransportOptions = {}) {
  const commands: RecordedCommand[] = [];
  const files = options.files ?? new Map<string, { content: string; mode: number }>();
  const responses = options.responses ?? [];
  const transport: Transport & { commands: RecordedCommand[]; files: Map<string, { content: string; mode: number }>; line(index: number): string } = {
    description: 'recorded transport',
    commands, files,
    line: (index: number) => [commands[index].program, ...commands[index].args].join(' '),
    async exec(program, args, runOptions = {}) {
      commands.push({ program, args, ...(runOptions.input === undefined ? {} : { input: runOptions.input }) });
      const line = [program, ...args].join(' ');
      const response = responses.find(candidate => line.includes(candidate.match));
      if (!response) return { stdout: '', stderr: '', code: 0 };
      const produced = typeof response.result === 'function' ? response.result() : response.result;
      const result = typeof produced === 'string' ? { stdout: produced, stderr: '', code: 0 } : produced;
      if (result.code !== 0 && !runOptions.allowFailure) throw commandFailure(program, result);
      return result;
    },
    async putFile(path, content, mode) { files.set(path, { content, mode }); },
  };
  return transport;
}
