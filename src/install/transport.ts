import { execFile } from 'node:child_process';
import { chown, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CommandResult { stdout: string; stderr: string; code: number }
export interface RunOptions { input?: string; cwd?: string; timeout?: number; allowFailure?: boolean }

/**
 * The server image runs `USER node` (uid 1000), and a bind mount keeps the host file's owner
 * and mode: a private key written `root:root 0600` over SSH, or by a local installer with
 * another uid, would be unreadable inside the container and the server would restart forever
 * on EACCES. Bundle files that must be readable by the container therefore carry the
 * `UID:GID` owner the transport applies after writing.
 */
export const SERVER_CONTAINER_UID = 1000;

const parseOwner = (owner: string): { uid: number; gid: number } => {
  const [uid, gid] = owner.split(':').map(Number);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0) throw new Error(`a file owner must be UID:GID, not "${owner}"`);
  return { uid, gid };
};

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
  putFile(path: string, content: string, mode: number, owner?: string): Promise<void>;
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
    async putFile(path, content, mode, owner) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, content, { mode });
      if (!owner) return;
      const { uid, gid } = parseOwner(owner);
      try { await chown(path, uid, gid); return; }
      catch { /* not the file's owner and not root: try the Docker daemon below */ }
      // The installing user is often the container user itself (a uid-1000 operator), in
      // which case the read that matters already succeeds.
      const status = await stat(path).catch(() => null);
      if (status && (status.uid === uid || (status.gid === gid && !!(status.mode & 0o040)) || !!(status.mode & 0o004))) return;
      // A Compose install needs the Docker daemon anyway, and the daemon runs as root: give
      // it the chown when the shell user cannot. Failing closed here beats deploying a
      // server that restarts forever on EACCES.
      const fixed = await local('docker', ['run', '--rm', '-v', `${dirname(path)}:/fix`, 'alpine:3', 'chown', `${uid}:${gid}`, `/fix/${path.split('/').pop()}`], { allowFailure: true, timeout: 300_000 }).catch(() => ({ stdout: '', stderr: 'docker is unavailable', code: 1 }));
      if (fixed.code === 0) return;
      throw new Error(`The server container runs as uid ${uid} and must be able to read ${path}, but it could not be given to ${owner} and the Docker daemon could not either: ${fixed.stderr.trim().slice(-300)}. Run the installer as root or as uid ${uid}, or chown ${owner} ${path} yourself, then rerun graphyard install --apply.`);
    },
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
    async putFile(path, content, mode, owner) {
      const steps = [`mkdir -p ${shellQuote(dirname(path))}`, 'umask 077', `cat > ${shellQuote(path)}`, `chmod ${mode.toString(8).padStart(4, '0')} ${shellQuote(path)}`];
      if (owner) steps.push(`chown ${shellQuote(owner)} ${shellQuote(path)}`);
      const run = () => base.exec('ssh', [...sshArgs, 'sh', '-c', shellQuote(steps.join(' && '))], { input: content });
      if (!owner) { await run(); return; }
      const failure = await run().then(
        result => result.code === 0 ? null : commandFailure('ssh', result).message,
        (error: Error) => error.message,
      );
      if (failure === null) return;
      // The remote shell is whatever --ssh-user names; a non-root user cannot chown to
      // uid 1000, and the failure must be loud here rather than a crash-looping server later.
      throw new Error(`${failure}. The server container runs as uid ${owner.split(':')[0]} and must be able to read ${path}: connect as a remote user that can chown (the default --ssh-user root), or chown ${owner} ${path} on ${host} yourself, then rerun graphyard install --apply.`);
    },
  };
}

export interface RecordedCommand { program: string; args: string[]; input?: string }
export interface BundleFileRecord { content: string; mode: number; owner?: string }
export interface FakeTransportOptions {
  /** First match wins; a response is stdout, a full result, or a thunk for stateful fakes. */
  responses?: { match: string; result: string | CommandResult | (() => string | CommandResult) }[];
  files?: Map<string, BundleFileRecord>;
}

/**
 * The CI transport. It records every command and file so adapter tests can assert exact
 * provisioning order, idempotency on a second run, and that no argument carries a secret.
 */
export function fakeTransport(options: FakeTransportOptions = {}) {
  const commands: RecordedCommand[] = [];
  const files = options.files ?? new Map<string, BundleFileRecord>();
  const responses = options.responses ?? [];
  const transport: Transport & { commands: RecordedCommand[]; files: Map<string, BundleFileRecord>; line(index: number): string } = {
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
    async putFile(path, content, mode, owner) { files.set(path, { content, mode, ...(owner ? { owner } : {}) }); },
  };
  return transport;
}
