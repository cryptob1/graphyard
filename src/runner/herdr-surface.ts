import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess, spawn } from 'node:child_process';
import type { ChildRun } from '../child-runner.js';
import { createdHerdrTab, herdrJson } from '../master/herdr.js';
import { runLogFile } from '../session-tail.js';

/**
 * A headless role run inside a Herdr pane (GY-713, `run.<role>.surface = 'herdr'`). The run is the
 * same process with the same arguments, account and environment; only where it runs changes. Its
 * stdout is teed into the per-run log in the pane, its stderr and exit status written beside it,
 * and the runner reads the run back from those files, so a payload, a failure and the dashboard's
 * live tail are exactly what they are for a child of the loop. The pane is the operator's to watch;
 * nothing is ever typed into it after the one line that starts the run.
 */

/** Which pane each run started in, by run id: the loop's roster reads it for the attach command. */
const panes = new Map<string, string>();
export const surfacePane = (run: string) => panes.get(run) ?? null;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface HerdrSurfaceOptions {
  run: ChildRun;
  workspace?: string | null;
  label: string;
  /** How often the run's files are read back; 200 ms by default. */
  pollMs?: number;
  /** The checkout whose managed runs directory holds the log of a run given none; the loop's working directory by default. */
  root?: string;
}

/** A spawn for `PiRunnerOptions.surface`: it starts the command in a new Herdr tab and returns a child that mirrors it. */
export function herdrSurface(options: HerdrSurfaceOptions) {
  return ({ id, log }: { id: string; log: string | null }): typeof spawn => ((command: string, args: readonly string[], spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    // A run given no log still writes one, in the managed runs directory where retention removes it.
    const out = log ?? runLogFile(options.root ?? process.cwd(), `run-${id.slice(0, 8)}`), err = `${out}.stderr`, exit = `${out}.exit`, script = `${out}.sh`;
    // The sidecars carry the command (with its prompt) and the run's stderr and status: they go once the run has settled; the log stays.
    const removeSidecars = () => { for (const path of [err, exit, script]) rmSync(path, { force: true }); };
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin: null, pid: undefined, exitCode: null, signalCode: null });
    let pane: string | null = null, closed = false, timer: ReturnType<typeof setInterval> | null = null;
    const offsets = { out: 0, err: 0 };
    const drain = (path: string, stream: PassThrough, key: 'out' | 'err') => {
      if (!existsSync(path)) return;
      const fd = openSync(path, 'r');
      try {
        const size = fstatSync(fd).size;
        if (size <= offsets[key]) return;
        const buffer = Buffer.alloc(size - offsets[key]);
        readSync(fd, buffer, 0, buffer.length, offsets[key]);
        offsets[key] = size;
        stream.write(buffer);
      } finally { closeSync(fd); }
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try { drain(out, stdout, 'out'); drain(err, stderr, 'err'); } catch { /* the files are gone */ }
      try { removeSidecars(); } catch { /* removed already */ }
      Object.assign(child, { exitCode: code, signalCode: signal });
      stdout.end(); stderr.end();
      // The pane has shown the run through; the log keeps it.
      if (pane) void herdrJson(['pane', 'close', pane], options.run).catch(() => {});
      panes.delete(id);
      setImmediate(() => child.emit('close', code, signal));
    };
    child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => { if (!closed) finish(null, signal); return true; }) as ChildProcess['kill'];
    void (async () => {
      const env = spawnOptions.env ?? {};
      // Only what differs from the loop's own environment travels to the pane, on Herdr's command line
      // rather than typed into it; what the runner withholds (its Graphyard and Herdr identity) is unset.
      const set = Object.entries(env).filter(([name, value]) => value !== undefined && process.env[name] !== value).flatMap(([name, value]) => ['--env', `${name}=${value}`]);
      // The pane starts from Herdr's environment, not the loop's: every Graphyard and Herdr variable in
      // it is unset except those the run itself is given (`runEnvironment` withholds the rest).
      const keep = Object.keys(env).filter(name => /^(GRAPHYARD_|HERDR_)/.test(name)).join(' ');
      writeFileSync(out, '', { mode: 0o600, flag: 'a' });
      writeFileSync(script, ['#!/bin/sh',
        `for name in $(env | sed -n -e 's/^\\(GRAPHYARD_[A-Za-z0-9_]*\\)=.*/\\1/p' -e 's/^\\(HERDR_[A-Za-z0-9_]*\\)=.*/\\1/p'); do case ' ${keep} ' in *" $name "*) ;; *) unset "$name" ;; esac; done`,
        `{ ${[command, ...args].map(quote).join(' ')} 2>>${quote(err)} </dev/null; echo $? >${quote(exit)}; } | tee -a ${quote(out)}`, ''].join('\n'), { mode: 0o700 });
      const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(options.workspace ? ['--workspace', options.workspace] : []), '--cwd', spawnOptions.cwd ?? process.cwd(),
        '--label', options.label, ...set, '--no-focus'], options.run));
      // A run cancelled or timed out while its tab was being created never starts: the new pane is closed unused.
      if (closed) { void herdrJson(['pane', 'close', created.pane], options.run).catch(() => {}); return; }
      pane = created.pane;
      panes.set(id, pane);
      await herdrJson(['pane', 'run', pane, `sh ${quote(script)}`], options.run);
      if (closed) return;
      timer = setInterval(() => {
        try {
          drain(out, stdout, 'out'); drain(err, stderr, 'err');
          if (existsSync(exit)) {
            // The exit is written before tee has flushed the last lines; one more read settles them.
            const code = Number.parseInt(readFileSync(exit, 'utf8').trim(), 10);
            setTimeout(() => finish(Number.isFinite(code) ? code : 1, null), options.pollMs ?? 200);
            if (timer) clearInterval(timer);
          }
        } catch (error) { if (!closed) { closed = true; if (timer) clearInterval(timer); panes.delete(id); child.emit('error', error); } }
      }, options.pollMs ?? 200);
    })().catch(error => {
      if (pane) void herdrJson(['pane', 'close', pane], options.run).catch(() => {});
      panes.delete(id);
      try { removeSidecars(); } catch { /* removed already */ }
      if (!closed) { closed = true; child.emit('error', error instanceof Error ? error : new Error(String(error))); }
    });
    return child;
  }) as unknown as typeof spawn;
}
